import { isAbsolute, posix } from 'path'
import { isWslWindowsPath, wslPathToWindows, wslWindowsPathDistro } from '@shared/wsl-path'
import { configStore } from './config-store'
import {
  findSandboxWorkspaceForSessionFile,
  isSandboxWorkspacePath,
  sandboxOwnsSessionFile,
} from './sandbox-workspaces'
import { readSessionMetaFromFile } from './session-file-meta'
import { workerManager } from './worker-manager'
import { getAgentRuntimeConfig } from './wsl/runtime-config'
import {
  trustedProjectRegistrationV1,
  type TrustedProjectRegistrationSourceV1,
} from './trusted-project-registration'

/** Active workspace root for capability-bound IPC (git mutations, image preview). */
export function getTrustedWorkspaceRoot(): string | null {
  for (const raw of [workerManager.cwd, configStore.get('currentProject')]) {
    const authorized = trustedProjectRegistrationV1.authorize(
      typeof raw === 'string' ? raw : undefined,
    )
    if (authorized.ok) return authorized.cwd
  }
  return null
}

/** Main-owned native-picker or managed-sandbox registration. */
export function registerTrustedProjectRoot(
  path: string,
  source: TrustedProjectRegistrationSourceV1,
): { ok: true; cwd: string } | { ok: false; error: string } {
  return trustedProjectRegistrationV1.register(path, source)
}

export function revokeTrustedProjectRoot(path: string): void {
  trustedProjectRegistrationV1.revoke(path)
}

export function authorizeTrustedCwd(reqCwd: string | undefined): { ok: true; cwd: string } | { ok: false; error: string } {
  const requested = String(reqCwd || '').trim()
  if (requested) return trustedProjectRegistrationV1.authorize(requested)
  const trusted = getTrustedWorkspaceRoot()
  return trusted
    ? { ok: true, cwd: trusted }
    : { ok: false, error: 'no_trusted_workspace' }
}

type TrustedSessionFileResult =
  | { ok: true; cwd: string; sessionFile: string }
  | { ok: false; error: string }

function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || isWslWindowsPath(value)
}

function comparableWorkspacePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/'))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function workspacePathsEqual(a: string, b: string): boolean {
  const left = comparableWorkspacePath(a)
  const right = comparableWorkspacePath(b)
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(a) || /^[a-zA-Z]:[\\/]/.test(b)
  return windowsPath ? left.toLowerCase() === right.toLowerCase() : left === right
}

function resolveTrustedSessionCwd(reqCwd: string | undefined): { ok: true; cwd: string } | { ok: false; error: string } {
  const target = String(reqCwd || '').trim()
  if (!target) return authorizeTrustedCwd(reqCwd)
  return trustedProjectRegistrationV1.authorize(target)
}

/** Main-owned project grant: a native-picker or managed-sandbox registration. */
export function authorizeTrustedProjectRoot(
  reqCwd: string | undefined,
): { ok: true; cwd: string } | { ok: false; error: string } {
  return resolveTrustedSessionCwd(reqCwd)
}

/** Authorize a renderer-provided session path before opening it in the main process. */
export function authorizeTrustedSessionFile(
  reqCwd: string | undefined,
  requestedSessionFile: string | undefined,
): TrustedSessionFileResult {
  const sessionFile = String(requestedSessionFile || '').trim()
  if (!sessionFile || !isPortableAbsolutePath(sessionFile)) {
    return { ok: false, error: 'invalid_session_path' }
  }

  // Managed sandboxes persist the exact Session file in private metadata. Use
  // that stronger identity when a legacy JSONL header still names the project
  // from which the sandbox was first created.
  const boundSandbox = findSandboxWorkspaceForSessionFile(sessionFile)
  const authorizedCwd = resolveTrustedSessionCwd(boundSandbox ?? reqCwd)
  if (!authorizedCwd.ok) return authorizedCwd

  const meta = readSessionMetaFromFile(sessionFile)
  if (!meta?.cwd) return { ok: false, error: 'invalid_session' }
  const fileDistro = wslWindowsPathDistro(sessionFile)
  const sessionCwd = fileDistro
    ? wslPathToWindows(fileDistro, meta.cwd)
    : meta.cwd
  const managedSandboxBinding =
    (boundSandbox !== null && workspacePathsEqual(boundSandbox, authorizedCwd.cwd)) ||
    (isSandboxWorkspacePath(authorizedCwd.cwd) &&
      sandboxOwnsSessionFile(authorizedCwd.cwd, sessionFile))
  if (!workspacePathsEqual(sessionCwd, authorizedCwd.cwd) && !managedSandboxBinding) {
    return { ok: false, error: 'session_workspace_mismatch' }
  }

  const workspaceDistro = wslWindowsPathDistro(authorizedCwd.cwd)
  const activeDistro = getAgentRuntimeConfig().distro
  const expectedDistro = workspaceDistro || activeDistro
  if (fileDistro && expectedDistro && fileDistro.toLowerCase() !== expectedDistro.toLowerCase()) {
    return { ok: false, error: 'session_workspace_mismatch' }
  }

  return { ok: true, cwd: authorizedCwd.cwd, sessionFile }
}
