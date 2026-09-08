import { randomUUID } from 'node:crypto'

import {
  canonicalizeC2ArtifactReleaseForSignatureV1,
  type C2ArtifactReceiptV1,
  type C2ArtifactReleaseRefV1,
  type C2InstallClaimV1,
  type C2InstallIntentPreviewV1,
  type C2InstallPublicPreviewV1,
  type C2InstallPublicStateV1,
  type XiaoguiModeV1,
} from '@shared/xiaogui-c2-artifact'
import type { C2ArchiveInstallResultV1, C2ArchiveInstallerV1 } from './archive-installer'
import type { C2InstallDeepLinkV1 } from './deep-link-dispatcher'
import type { C2ArtifactReceiptOutboxV1 } from './receipt-outbox'

export interface C2ArtifactGatewayV1 {
  preview(link: C2InstallDeepLinkV1): Promise<C2InstallIntentPreviewV1>
  claim(link: C2InstallDeepLinkV1): Promise<C2InstallClaimV1>
  download(ticket: string): Promise<Buffer>
  cancel(installIntentId: string): Promise<void>
  submitReceipt(receipt: C2ArtifactReceiptV1): Promise<unknown>
}

interface C2ReceiptOutboxPortV1 {
  enqueue(value: C2ArtifactReceiptV1): Promise<void>
  list(): Promise<C2ArtifactReceiptV1[]>
  acknowledge(submittedEventId: string, envelope: unknown): Promise<boolean>
}

interface C2ArchiveInstallerPortV1 {
  verifyAndInstall(input: Parameters<C2ArchiveInstallerV1['verifyAndInstall']>[0]): Promise<C2ArchiveInstallResultV1>
}

export interface C2InstallCoordinatorOptionsV1 {
  gateway: C2ArtifactGatewayV1
  installer: C2ArchiveInstallerPortV1
  outbox: C2ReceiptOutboxPortV1 | C2ArtifactReceiptOutboxV1
  resolveTarget(release: C2ArtifactReleaseRefV1): string
  reloadPiResources(): Promise<void>
  currentMode(): XiaoguiModeV1
  now?: () => Date
  eventId?: () => string
  onState?: (state: C2InstallPublicStateV1) => void
}

interface PendingInstallV1 {
  link: C2InstallDeepLinkV1
  preview: C2InstallIntentPreviewV1
}

/** Main-process C2 state machine. The nonce and tickets never enter public state. */
export class C2InstallCoordinatorV1 {
  private state: C2InstallPublicStateV1 = { phase: 'IDLE' }
  private pending: PendingInstallV1 | null = null
  private operation: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date
  private readonly eventId: () => string

  constructor(private readonly options: C2InstallCoordinatorOptionsV1) {
    this.now = options.now ?? (() => new Date())
    this.eventId = options.eventId ?? randomUUID
  }

  status(): C2InstallPublicStateV1 {
    return cloneState(this.state)
  }

  preview(link: C2InstallDeepLinkV1): Promise<C2InstallPublicStateV1> {
    return this.serial(async () => {
      this.publish({ phase: 'PREVIEWING' })
      try {
        const preview = await this.options.gateway.preview(link)
        if (preview.installIntentId !== link.installIntentId || preview.state !== 'CREATED') {
          throw new Error('C2 preview binding mismatch')
        }
        if (Date.parse(preview.expiresAt) <= this.now().getTime()) throw new Error('C2 preview expired')
        this.pending = { link: { ...link }, preview }
        return this.publish({ phase: 'AWAITING_CONFIRMATION', preview: toPublicPreview(preview) })
      } catch (error) {
        this.pending = null
        const code = error && typeof error === 'object' && 'code' in error && error.code === 'CREDENTIALS_UNAVAILABLE'
          ? 'CREDENTIALS_UNAVAILABLE' as const
          : 'PREVIEW_FAILED' as const
        return this.publish({ phase: 'FAILED', code })
      }
    })
  }

  confirm(installIntentId: string): Promise<C2InstallPublicStateV1> {
    return this.serial(async () => {
      const pending = this.pending
      if (!pending || pending.preview.installIntentId !== installIntentId) {
        return this.publish({ phase: 'FAILED', code: 'INSTALL_FAILED' })
      }
      this.publish({ phase: 'INSTALLING', preview: toPublicPreview(pending.preview) })
      let claim: C2InstallClaimV1
      let installed: C2ArchiveInstallResultV1
      try {
        claim = await this.options.gateway.claim(pending.link)
        assertClaimMatchesPreview(claim, pending.preview)
        const archiveBytes = await this.options.gateway.download(claim.downloadTicket)
        installed = await this.options.installer.verifyAndInstall({
          release: claim.release,
          archiveBytes,
          targetDirectory: this.options.resolveTarget(claim.release),
        })
      } catch (error) {
        await this.queueInstallReceipt(pending.preview, 'INSTALL_FAILED', errorCategoryOf(error)).catch(() => undefined)
        await this.flushReceipts().catch(() => undefined)
        this.pending = null
        return this.publish({ phase: 'FAILED', code: 'INSTALL_FAILED' })
      }
      // The filesystem install is already committed. A worker reload or an
      // offline/malformed receipt ACK must not relabel that durable result as
      // INSTALL_FAILED; the success receipt remains queued for later replay.
      if (installed.kind === 'SKILL') await this.options.reloadPiResources().catch(() => undefined)
      await this.queueInstallReceipt(pending.preview, 'INSTALL_SUCCEEDED').catch(() => undefined)
      await this.flushReceipts().catch(() => undefined)
      this.pending = null
      return this.publish({
        phase: 'INSTALLED',
        installed: {
          artifactId: claim.release.artifactId,
          releaseId: claim.release.releaseId,
          kind: claim.release.kind,
          name: claim.release.name,
          version: claim.release.version,
        },
      })
    })
  }

  cancel(installIntentId: string): Promise<C2InstallPublicStateV1> {
    return this.serial(async () => {
      if (!this.pending || this.pending.preview.installIntentId !== installIntentId) {
        return this.publish({ phase: 'FAILED', code: 'CANCEL_FAILED' })
      }
      try {
        await this.options.gateway.cancel(installIntentId)
        this.pending = null
        return this.publish({ phase: 'CANCELLED' })
      } catch {
        return this.publish({ phase: 'FAILED', code: 'CANCEL_FAILED' })
      }
    })
  }

  flushReceipts(): Promise<void> {
    return this.flushReceiptsUnlocked()
  }

  private async flushReceiptsUnlocked(): Promise<void> {
    while (true) {
      const head = (await this.options.outbox.list())[0]
      if (!head) return
      const envelope = await this.options.gateway.submitReceipt(head)
      const acknowledged = await this.options.outbox.acknowledge(head.eventId, envelope)
      if (!acknowledged) throw new Error('C2 receipt ACK did not match queue head')
    }
  }

  private async queueInstallReceipt(
    preview: C2InstallIntentPreviewV1,
    eventType: 'INSTALL_SUCCEEDED' | 'INSTALL_FAILED',
    errorCategory?: C2ArtifactReceiptV1['errorCategory'],
  ): Promise<void> {
    await this.options.outbox.enqueue({
      eventId: this.eventId(),
      installIntentId: preview.installIntentId,
      releaseId: preview.release.releaseId,
      eventType,
      occurredAt: this.now().toISOString(),
      mode: this.options.currentMode(),
      ...(errorCategory ? { errorCategory } : {}),
    })
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.operation.then(action, action)
    this.operation = run.then(() => undefined, () => undefined)
    return run
  }

  private publish(state: C2InstallPublicStateV1): C2InstallPublicStateV1 {
    this.state = cloneState(state)
    this.options.onState?.(cloneState(state))
    return cloneState(state)
  }
}

function assertClaimMatchesPreview(claim: C2InstallClaimV1, preview: C2InstallIntentPreviewV1): void {
  if (
    claim.installIntentId !== preview.installIntentId ||
    canonicalizeC2ArtifactReleaseForSignatureV1(claim.release) !== canonicalizeC2ArtifactReleaseForSignatureV1(preview.release) ||
    claim.release.signature !== preview.release.signature ||
    claim.release.signatureKeyId !== preview.release.signatureKeyId
  ) {
    throw new Error('C2 claim does not match locally confirmed preview')
  }
}

function toPublicPreview(value: C2InstallIntentPreviewV1): C2InstallPublicPreviewV1 {
  return {
    installIntentId: value.installIntentId,
    expiresAt: value.expiresAt,
    release: {
      artifactId: value.release.artifactId,
      releaseId: value.release.releaseId,
      kind: value.release.kind,
      name: value.release.name,
      summary: value.release.summary,
      version: value.release.version,
      compatibility: {
        minXiaoguiVersion: value.release.compatibility.minXiaoguiVersion,
        supportedModes: [...value.release.compatibility.supportedModes],
      },
      permissions: [...value.release.permissions],
    },
  }
}

function cloneState(value: C2InstallPublicStateV1): C2InstallPublicStateV1 {
  return JSON.parse(JSON.stringify(value)) as C2InstallPublicStateV1
}

function errorCategoryOf(error: unknown): NonNullable<C2ArtifactReceiptV1['errorCategory']> {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED'
  if (message.toLocaleLowerCase('en-US').includes('compatible')) return 'INCOMPATIBLE'
  if (code === 'REQUEST_FAILED' || code === 'CREDENTIALS_UNAVAILABLE') return 'RUNTIME_FAILED'
  return 'VERIFY_FAILED'
}
