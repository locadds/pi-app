import {
  clearEncryptedSecret,
  getEncryptedSecret,
  setEncryptedSecret,
} from '../../secret-store'
import type {
  HubTaskWorkerCredentialBundleV1,
  HubTaskWorkerCredentialsV1,
} from './worker-service'

const HUB_TASK_WORKER_SECRET_KEY = 'xiaoguiHubTaskWorkerCredentialsEnc'
const SCHEMA_VERSION = 1

export interface HubTaskWorkerEncryptedRecordStoreV1 {
  read(): string | null
  write(value: string): boolean
  clear(): void
}

/**
 * Stores the complete Hub credential bundle in one safeStorage-encrypted
 * record. No credential component is ever written to electron-store JSON.
 */
export function createHubTaskWorkerCredentialsV1(
  encryptedStore: HubTaskWorkerEncryptedRecordStoreV1 = defaultEncryptedStore(),
): HubTaskWorkerCredentialsV1 {
  return {
    read(): HubTaskWorkerCredentialBundleV1 | null {
      const raw = encryptedStore.read()
      if (!raw) return null
      try {
        return parseBundle(JSON.parse(raw), true)
      } catch {
        return null
      }
    },
    write(value: HubTaskWorkerCredentialBundleV1): boolean {
      const normalized = parseBundle(value, false)
      if (!normalized) return false
      return encryptedStore.write(JSON.stringify({ version: SCHEMA_VERSION, ...normalized }))
    },
    clear(): void {
      encryptedStore.clear()
    },
  }
}

function defaultEncryptedStore(): HubTaskWorkerEncryptedRecordStoreV1 {
  return {
    read: () => getEncryptedSecret(HUB_TASK_WORKER_SECRET_KEY),
    write: (value) => setEncryptedSecret(HUB_TASK_WORKER_SECRET_KEY, value),
    clear: () => clearEncryptedSecret(HUB_TASK_WORKER_SECRET_KEY),
  }
}

function parseBundle(value: unknown, requireVersion: boolean): HubTaskWorkerCredentialBundleV1 | null {
  if (!isRecord(value) || (requireVersion && value.version !== SCHEMA_VERSION) || !isRecord(value.node)) return null
  if (
    !isEndpoint(value.endpoint) ||
    !isText(value.accessToken, 20, 16_384) ||
    !isOpaqueId(value.node.subjectId) ||
    !isOpaqueId(value.node.nodeId) ||
    !isOpaqueId(value.node.keyId) ||
    !isText(value.node.deviceToken, 10, 16_384) ||
    !isText(value.node.privateKeyPem, 32, 65_536)
  ) {
    return null
  }
  return {
    endpoint: value.endpoint.trim(),
    accessToken: value.accessToken.trim(),
    node: {
      subjectId: value.node.subjectId,
      nodeId: value.node.nodeId,
      keyId: value.node.keyId,
      deviceToken: value.node.deviceToken.trim(),
      privateKeyPem: value.node.privateKeyPem,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max
}
