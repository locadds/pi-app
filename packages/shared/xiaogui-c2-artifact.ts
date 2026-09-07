export const C2_CONTRACT_VERSION = 'xiaogui.community-c2.c0-contract.v1' as const

export const C2_LAN_PILOT_TRUST_ROOT = Object.freeze({
  algorithm: 'Ed25519' as const,
  keyId: 'c2-ed25519:34ca5b60a2ba75e18f13bf473dd86e29',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAftqwRjYv3WL0QYAzVJM2iW3byT79laWCE9s2X7jDsM4=\n-----END PUBLIC KEY-----',
  publicKeyFingerprint: 'sha256:34ca5b60a2ba75e18f13bf473dd86e2981b352e7b62df1cfe2f6a23d26167ee9',
})

export const C2_PACKAGE_LIMITS = Object.freeze({
  maxPackageBytes: 50 * 1024 * 1024,
  maxEntryCount: 2_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
})

export type XiaoguiModeV1 = 'WORK' | 'DESIGN' | 'CODING'
export type C2ArtifactKindV1 = 'SKILL' | 'APP'
export type C2ArtifactReceiptEventV1 =
  | 'INSTALL_SUCCEEDED'
  | 'INSTALL_FAILED'
  | 'LAUNCH_SUCCEEDED'
  | 'USE_COMPLETED'
  | 'UNINSTALLED'
export type C2ArtifactErrorCategoryV1 =
  | 'INCOMPATIBLE'
  | 'PERMISSION_DENIED'
  | 'VERIFY_FAILED'
  | 'RUNTIME_FAILED'

export interface C2ArtifactReleaseRefV1 {
  artifactId: string
  releaseId: string
  kind: C2ArtifactKindV1
  name: string
  summary: string
  version: string
  manifestSchemaVersion: string
  entrypoint: string
  registryRef: string
  packageSha256: string
  signature: string
  signatureKeyId: string
  publicKeyPem?: string
  compatibility: { minXiaoguiVersion: string; supportedModes: XiaoguiModeV1[] }
  permissions: string[]
  reviewState: 'PUBLISHED'
}

export interface C2InstallIntentPreviewV1 {
  installIntentId: string
  release: C2ArtifactReleaseRefV1
  expiresAt: string
  state: 'CREATED'
}

export interface C2InstallClaimV1 {
  installIntentId: string
  release: C2ArtifactReleaseRefV1
  downloadTicket: string
}

export interface C2ArtifactReceiptV1 {
  eventId: string
  installIntentId?: string
  releaseId: string
  eventType: C2ArtifactReceiptEventV1
  occurredAt: string
  mode?: XiaoguiModeV1
  errorCategory?: C2ArtifactErrorCategoryV1
}

export interface C2ArtifactReceiptAckV1 {
  schemaVersion: 'xiaogui.artifact-receipt-ack.v1'
  ok: true
  eventId: string
  duplicate: boolean
  receivedAt: string
}

export interface C2InstallPublicReleaseV1 {
  artifactId: string
  releaseId: string
  kind: C2ArtifactKindV1
  name: string
  summary: string
  version: string
  compatibility: C2ArtifactReleaseRefV1['compatibility']
  permissions: string[]
}

export interface C2InstallPublicPreviewV1 {
  installIntentId: string
  expiresAt: string
  release: C2InstallPublicReleaseV1
}

export type C2InstallPublicStateV1 =
  | { phase: 'IDLE' }
  | { phase: 'PREVIEWING' }
  | { phase: 'AWAITING_CONFIRMATION'; preview: C2InstallPublicPreviewV1 }
  | { phase: 'INSTALLING'; preview: C2InstallPublicPreviewV1 }
  | { phase: 'INSTALLED'; installed: Pick<C2InstallPublicReleaseV1, 'artifactId' | 'releaseId' | 'kind' | 'name' | 'version'> }
  | { phase: 'CANCELLED' }
  | { phase: 'FAILED'; code: 'CREDENTIALS_UNAVAILABLE' | 'PREVIEW_FAILED' | 'INSTALL_FAILED' | 'CANCEL_FAILED' }

type UnknownRecord = Record<string, unknown>

function recordOf(value: unknown, name: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as UnknownRecord
}

function exactFields(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown field: ${key}`)
  for (const key of required) if (!(key in value)) throw new TypeError(`${key} is required`)
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`)
}

function safeIdentifier(value: unknown, name: string): asserts value is string {
  nonEmpty(value, name)
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new TypeError(`${name} contains unsafe characters`)
}

function utc(value: unknown, name: string): asserts value is string {
  nonEmpty(value, name)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO UTC timestamp`)
  }
}

function stringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`${name} must be a string array`)
  }
}

function parseCompatibility(value: unknown): C2ArtifactReleaseRefV1['compatibility'] {
  const compatibility = recordOf(value, 'compatibility')
  exactFields(compatibility, ['minXiaoguiVersion', 'supportedModes'])
  nonEmpty(compatibility.minXiaoguiVersion, 'compatibility.minXiaoguiVersion')
  if (
    !Array.isArray(compatibility.supportedModes) ||
    compatibility.supportedModes.length === 0 ||
    compatibility.supportedModes.some((mode) => !['WORK', 'DESIGN', 'CODING'].includes(String(mode)))
  ) {
    throw new TypeError('compatibility.supportedModes is invalid')
  }
  return {
    minXiaoguiVersion: compatibility.minXiaoguiVersion,
    supportedModes: [...compatibility.supportedModes] as XiaoguiModeV1[],
  }
}

export function parseC2ArtifactReleaseRefV1(value: unknown): C2ArtifactReleaseRefV1 {
  const release = recordOf(value, 'C2ArtifactReleaseRefV1')
  exactFields(release, [
    'artifactId', 'releaseId', 'kind', 'name', 'summary', 'version', 'manifestSchemaVersion',
    'entrypoint', 'registryRef', 'packageSha256', 'signature', 'signatureKeyId',
    'compatibility', 'permissions', 'reviewState',
  ], ['publicKeyPem'])
  safeIdentifier(release.artifactId, 'artifactId')
  nonEmpty(release.releaseId, 'releaseId')
  if (release.kind !== 'SKILL' && release.kind !== 'APP') throw new TypeError('kind is invalid')
  nonEmpty(release.name, 'name')
  if (typeof release.summary !== 'string') throw new TypeError('summary must be a string')
  safeIdentifier(release.version, 'version')
  if (release.manifestSchemaVersion !== '1') throw new TypeError('manifestSchemaVersion must be 1')
  nonEmpty(release.entrypoint, 'entrypoint')
  nonEmpty(release.registryRef, 'registryRef')
  if (typeof release.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.packageSha256)) {
    throw new TypeError('packageSha256 is invalid')
  }
  nonEmpty(release.signature, 'signature')
  nonEmpty(release.signatureKeyId, 'signatureKeyId')
  stringArray(release.permissions, 'permissions')
  if (release.reviewState !== 'PUBLISHED') throw new TypeError('release must be PUBLISHED')
  if (release.publicKeyPem !== undefined) nonEmpty(release.publicKeyPem, 'publicKeyPem')
  return {
    artifactId: release.artifactId,
    releaseId: release.releaseId,
    kind: release.kind,
    name: release.name,
    summary: release.summary,
    version: release.version,
    manifestSchemaVersion: '1',
    entrypoint: release.entrypoint,
    registryRef: release.registryRef,
    packageSha256: release.packageSha256,
    signature: release.signature,
    signatureKeyId: release.signatureKeyId,
    compatibility: parseCompatibility(release.compatibility),
    permissions: [...release.permissions],
    reviewState: 'PUBLISHED',
    ...(release.publicKeyPem !== undefined ? { publicKeyPem: release.publicKeyPem } : {}),
  }
}

export function canonicalizeC2ArtifactReleaseForSignatureV1(value: C2ArtifactReleaseRefV1): string {
  const release = parseC2ArtifactReleaseRefV1(value)
  return JSON.stringify({
    artifactId: release.artifactId,
    releaseId: release.releaseId,
    kind: release.kind,
    name: release.name,
    summary: release.summary,
    version: release.version,
    manifestSchemaVersion: release.manifestSchemaVersion,
    entrypoint: release.entrypoint,
    registryRef: release.registryRef,
    packageSha256: release.packageSha256,
    compatibility: release.compatibility,
    permissions: release.permissions,
  })
}

export function parseC2InstallIntentPreviewV1(value: unknown): C2InstallIntentPreviewV1 {
  const envelope = recordOf(value, 'InstallIntentPreviewEnvelopeV1')
  exactFields(envelope, ['data'])
  const preview = recordOf(envelope.data, 'InstallIntentPreviewV1')
  exactFields(preview, ['installIntentId', 'release', 'expiresAt', 'state'])
  nonEmpty(preview.installIntentId, 'installIntentId')
  utc(preview.expiresAt, 'expiresAt')
  if (preview.state !== 'CREATED') throw new TypeError('preview state must be CREATED')
  return {
    installIntentId: preview.installIntentId,
    release: parseC2ArtifactReleaseRefV1(preview.release),
    expiresAt: preview.expiresAt,
    state: 'CREATED',
  }
}

export function parseC2InstallClaimV1(value: unknown): C2InstallClaimV1 {
  const envelope = recordOf(value, 'InstallClaimEnvelopeV1')
  exactFields(envelope, ['data'])
  const claim = recordOf(envelope.data, 'InstallClaimV1')
  exactFields(claim, ['installIntentId', 'release', 'downloadTicket'])
  nonEmpty(claim.installIntentId, 'installIntentId')
  nonEmpty(claim.downloadTicket, 'downloadTicket')
  return {
    installIntentId: claim.installIntentId,
    release: parseC2ArtifactReleaseRefV1(claim.release),
    downloadTicket: claim.downloadTicket,
  }
}

export function parseC2ArtifactReceiptV1(value: unknown): C2ArtifactReceiptV1 {
  const receipt = recordOf(value, 'C2ArtifactReceiptV1')
  exactFields(receipt, ['eventId', 'releaseId', 'eventType', 'occurredAt'], ['installIntentId', 'mode', 'errorCategory'])
  nonEmpty(receipt.eventId, 'eventId')
  nonEmpty(receipt.releaseId, 'releaseId')
  if (!['INSTALL_SUCCEEDED', 'INSTALL_FAILED', 'LAUNCH_SUCCEEDED', 'USE_COMPLETED', 'UNINSTALLED'].includes(String(receipt.eventType))) {
    throw new TypeError('eventType is invalid')
  }
  utc(receipt.occurredAt, 'occurredAt')
  if (receipt.installIntentId !== undefined) nonEmpty(receipt.installIntentId, 'installIntentId')
  if (receipt.mode !== undefined && !['WORK', 'DESIGN', 'CODING'].includes(String(receipt.mode))) throw new TypeError('mode is invalid')
  if (receipt.errorCategory !== undefined && !['INCOMPATIBLE', 'PERMISSION_DENIED', 'VERIFY_FAILED', 'RUNTIME_FAILED'].includes(String(receipt.errorCategory))) {
    throw new TypeError('errorCategory is invalid')
  }
  return receipt as unknown as C2ArtifactReceiptV1
}

export function parseC2ArtifactReceiptAckV1(value: unknown): C2ArtifactReceiptAckV1 {
  const envelope = recordOf(value, 'ArtifactReceiptAckEnvelopeV1')
  exactFields(envelope, ['data'])
  const ack = recordOf(envelope.data, 'ArtifactReceiptAckV1')
  exactFields(ack, ['schemaVersion', 'ok', 'eventId', 'duplicate', 'receivedAt'])
  if (ack.schemaVersion !== 'xiaogui.artifact-receipt-ack.v1' || ack.ok !== true) throw new TypeError('receipt ACK is invalid')
  nonEmpty(ack.eventId, 'eventId')
  if (typeof ack.duplicate !== 'boolean') throw new TypeError('duplicate must be boolean')
  utc(ack.receivedAt, 'receivedAt')
  return ack as unknown as C2ArtifactReceiptAckV1
}
