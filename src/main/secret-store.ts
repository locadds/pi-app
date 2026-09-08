import { safeStorage, BrowserWindow } from 'electron'

const STORE_KEY = 'codexAccessTokenEnc'

let backing: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; delete?: (k: string) => void } | null =
  null

export function bindSecretStoreBacking(store: {
  get: (k: string) => unknown
  set: (k: string, v: unknown) => void
  delete?: (k: string) => void
}): void {
  backing = store
}

export function isCodexTokenEncryptionAvailable(): boolean {
  return isEncryptedSecretStorageAvailable()
}

export function isEncryptedSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setCodexAccessToken(token: string | null | undefined): void {
  if (!backing) return
  const t = token?.trim()
  if (!t || t.length < 20) {
    clearEncryptedSecret(STORE_KEY)
    return
  }
  if (!setEncryptedSecret(STORE_KEY, t)) {
    console.warn('[secret-store] safeStorage unavailable; codex token not persisted')
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('ipc:events', {
        type: 'warning',
        message: '系统加密不可用，Codex Token 未持久化。重启后需重新输入。',
      })
    }
  }
}

export function getCodexAccessToken(): string | null {
  const plain = getEncryptedSecret(STORE_KEY)
  return plain && plain.length >= 20 ? plain : null
}

export function setEncryptedSecret(key: string, value: string): boolean {
  if (!backing || !isSecretKey(key) || !value || !isEncryptedSecretStorageAvailable()) return false
  try {
    backing.set(key, safeStorage.encryptString(value).toString('base64'))
    return true
  } catch {
    return false
  }
}

export function getEncryptedSecret(key: string): string | null {
  if (!backing || !isSecretKey(key) || !isEncryptedSecretStorageAvailable()) return null
  const raw = backing.get(key)
  if (raw == null || raw === '') return null
  try {
    return safeStorage.decryptString(Buffer.from(String(raw), 'base64')) || null
  } catch {
    return null
  }
}

export function clearEncryptedSecret(key: string): void {
  if (!backing || !isSecretKey(key)) return
  if (backing.delete) backing.delete(key)
  else backing.set(key, undefined)
}

function isSecretKey(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)
}
