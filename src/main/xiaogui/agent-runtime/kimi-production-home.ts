import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import {
  KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1,
  validateKimiAcpConfigContentV1,
} from './acp/kimi-tool-policy'

export const KIMI_PRODUCTION_CONFIG_CONTENT_V1 =
  '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n'

export type KimiProductionHomeReasonCodeV1 =
  | 'KIMI_PRODUCTION_HOME_PATH_INVALID'
  | 'KIMI_PRODUCTION_HOME_POLICY_DRIFT'
  | 'KIMI_PRODUCTION_HOME_PREPARE_FAILED'

export class KimiProductionHomeError extends Error {
  constructor(readonly reasonCode: KimiProductionHomeReasonCodeV1) {
    super(reasonCode)
    this.name = 'KimiProductionHomeError'
  }
}

export type KimiProductionHomePreparationV1 =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly kimiCodeHome: string }

export function prepareKimiProductionHomeV1(input: {
  readonly enabled: boolean
  readonly userDataDir: string
}): KimiProductionHomePreparationV1 {
  if (!input.enabled) return { enabled: false }

  const userDataDir = resolveUserDataDir(input.userDataDir)
  const xiaoguiDir = join(userDataDir, 'xiaogui')
  const runtimeDir = join(xiaoguiDir, 'agent-runtime')
  const kimiCodeHome = join(runtimeDir, 'kimi-v1')
  const agentsDir = join(kimiCodeHome, 'agents')

  try {
    ensureManagedDirectory(xiaoguiDir)
    ensureManagedDirectory(runtimeDir)
    ensureManagedDirectory(kimiCodeHome)
    ensureManagedDirectory(agentsDir)
    ensureManagedKimiConfig(join(kimiCodeHome, 'config.toml'))
    ensureManagedFile(
      join(agentsDir, 'agent.md'),
      KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1,
    )
    return { enabled: true, kimiCodeHome }
  } catch (error) {
    if (error instanceof KimiProductionHomeError) throw error
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_PREPARE_FAILED')
  }
}

function resolveUserDataDir(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !isAbsolute(value)) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_PATH_INVALID')
  }
  const lexical = resolve(value)
  let real: string
  try {
    real = realpathSync.native(lexical)
  } catch {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_PATH_INVALID')
  }
  if (pathKey(lexical) !== pathKey(real)) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_PATH_INVALID')
  }
  return real
}

function ensureManagedDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) throw error
  }
  assertManagedDirectory(path)
}

function assertManagedDirectory(path: string): void {
  const info = lstatSync(path, { bigint: true })
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_POLICY_DRIFT')
  }
  if (pathKey(realpathSync.native(path)) !== pathKey(path)) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_POLICY_DRIFT')
  }
}

function ensureManagedFile(path: string, expectedContent: string): void {
  try {
    writeFileSync(path, expectedContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) throw error
  }

  if (readManagedFile(path) !== expectedContent) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_POLICY_DRIFT')
  }
}

/** Kimi owns the login/model sections; Xiaogui owns and validates the tool boundary. */
function ensureManagedKimiConfig(path: string): void {
  try {
    writeFileSync(path, KIMI_PRODUCTION_CONFIG_CONTENT_V1, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    return
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) throw error
  }

  try {
    validateKimiAcpConfigContentV1(readManagedFile(path))
  } catch {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_POLICY_DRIFT')
  }
}

function readManagedFile(path: string): string {
  const info = lstatSync(path, { bigint: true })
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_POLICY_DRIFT')
  }
  if (pathKey(realpathSync.native(path)) !== pathKey(path)) {
    throw new KimiProductionHomeError('KIMI_PRODUCTION_HOME_POLICY_DRIFT')
  }
  return readFileSync(path, 'utf8')
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
