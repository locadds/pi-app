import { describe, expect, it, vi } from 'vitest'

import type {
  C2ArtifactReceiptV1,
  C2ArtifactReleaseRefV1,
} from '@shared/xiaogui-c2-artifact'
import { C2InstallCoordinatorV1 } from './install-coordinator'

const release: C2ArtifactReleaseRefV1 = {
  artifactId: 'demo-skill',
  releaseId: 'release-1',
  kind: 'SKILL',
  name: '演示 Skill',
  summary: '只读能力',
  version: '1.0.0',
  manifestSchemaVersion: '1',
  entrypoint: 'SKILL.md',
  registryRef: 'c2:opaque',
  packageSha256: 'a'.repeat(64),
  signature: Buffer.alloc(64).toString('base64'),
  signatureKeyId: 'c2-ed25519:34ca5b60a2ba75e18f13bf473dd86e29',
  compatibility: { minXiaoguiVersion: '0.3.0', supportedModes: ['WORK'] },
  permissions: ['skill:read-local-selection'],
  reviewState: 'PUBLISHED',
}

describe('C2InstallCoordinatorV1', () => {
  it('previews without claiming, then installs only after explicit local confirmation', async () => {
    const calls: string[] = []
    const receipts: C2ArtifactReceiptV1[] = []
    const gateway = {
      preview: vi.fn(async () => {
        calls.push('preview')
        return { installIntentId: '123e4567-e89b-12d3-a456-426614174000', release, expiresAt: '2026-09-07T03:00:00.000Z', state: 'CREATED' as const }
      }),
      claim: vi.fn(async () => {
        calls.push('claim')
        return { installIntentId: '123e4567-e89b-12d3-a456-426614174000', release, downloadTicket: 'one-use-ticket' }
      }),
      download: vi.fn(async () => {
        calls.push('download')
        return Buffer.from('zip')
      }),
      cancel: vi.fn(async () => { calls.push('cancel') }),
      submitReceipt: vi.fn(async (receipt: C2ArtifactReceiptV1) => {
        calls.push('receipt')
        return { data: { schemaVersion: 'xiaogui.artifact-receipt-ack.v1', ok: true, eventId: receipt.eventId, duplicate: false, receivedAt: '2026-09-07T02:00:01.000Z' } }
      }),
    }
    const outbox = {
      enqueue: vi.fn(async (receipt: C2ArtifactReceiptV1) => { receipts.push(receipt) }),
      list: vi.fn(async () => [...receipts]),
      acknowledge: vi.fn(async (eventId: string) => {
        if (receipts[0]?.eventId !== eventId) return false
        receipts.shift()
        return true
      }),
    }
    const installer = {
      verifyAndInstall: vi.fn(async () => {
        calls.push('install')
        return { artifactId: 'demo-skill', kind: 'SKILL' as const, targetDirectory: 'C:\\pi\\skills\\demo-skill', entrypointPath: 'C:\\pi\\skills\\demo-skill\\SKILL.md' }
      }),
    }
    const coordinator = new C2InstallCoordinatorV1({
      gateway,
      installer,
      outbox,
      resolveTarget: () => 'C:\\pi\\skills\\demo-skill',
      reloadPiResources: async () => { calls.push('reload') },
      currentMode: () => 'WORK',
      now: () => new Date('2026-09-07T02:00:00.000Z'),
      eventId: () => 'event-install-1',
    })

    const preview = await coordinator.preview({
      installIntentId: '123e4567-e89b-12d3-a456-426614174000',
      nonce: 'one-time',
    })
    expect(preview.phase).toBe('AWAITING_CONFIRMATION')
    if (preview.phase !== 'AWAITING_CONFIRMATION') throw new Error('expected preview state')
    expect(preview.preview?.release).toMatchObject({ name: '演示 Skill', permissions: ['skill:read-local-selection'] })
    expect(calls).toEqual(['preview'])

    const installed = await coordinator.confirm('123e4567-e89b-12d3-a456-426614174000')
    expect(installed).toMatchObject({ phase: 'INSTALLED', installed: { artifactId: 'demo-skill', kind: 'SKILL' } })
    expect(calls).toEqual(['preview', 'claim', 'download', 'install', 'reload', 'receipt'])
    expect(gateway.claim).toHaveBeenCalledWith({ installIntentId: '123e4567-e89b-12d3-a456-426614174000', nonce: 'one-time' })
    expect(outbox.acknowledge).toHaveBeenCalledWith('event-install-1', expect.anything())
  })

  it('cancels the preview locally and remotely without claim or download', async () => {
    const gateway = {
      preview: vi.fn(async () => ({ installIntentId: '123e4567-e89b-12d3-a456-426614174000', release, expiresAt: '2026-09-07T03:00:00.000Z', state: 'CREATED' as const })),
      claim: vi.fn(),
      download: vi.fn(),
      cancel: vi.fn(async () => undefined),
      submitReceipt: vi.fn(),
    }
    const coordinator = new C2InstallCoordinatorV1({
      gateway,
      installer: { verifyAndInstall: vi.fn() },
      outbox: { enqueue: vi.fn(), list: vi.fn(async () => []), acknowledge: vi.fn() },
      resolveTarget: () => 'unused',
      reloadPiResources: vi.fn(),
      currentMode: () => 'WORK',
      now: () => new Date('2026-09-07T02:00:00.000Z'),
    })
    await coordinator.preview({ installIntentId: '123e4567-e89b-12d3-a456-426614174000', nonce: 'one-time' })
    await expect(coordinator.cancel('123e4567-e89b-12d3-a456-426614174000')).resolves.toMatchObject({ phase: 'CANCELLED' })
    expect(gateway.cancel).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000')
    expect(gateway.claim).not.toHaveBeenCalled()
    expect(gateway.download).not.toHaveBeenCalled()
  })
})
