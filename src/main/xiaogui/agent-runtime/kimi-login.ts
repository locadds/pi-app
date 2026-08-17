import { spawn } from 'node:child_process'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, resolve, win32 } from 'node:path'

import {
  type XiaoguiKimiRuntimeReasonCodeV1,
  type XiaoguiKimiRuntimeStatusSnapshotV1,
  type XiaoguiKimiRuntimeStatusV1,
} from '@shared/xiaogui-kimi-runtime'

import { KimiAcpCliProbeV1, type KimiAcpProbeV1 } from './kimi-adapter'
import { KIMI_ACP_APPROVED_VERSION_V1 } from './acp/kimi-tool-policy'
import { prepareKimiProductionHomeV1 } from './kimi-production-home'

export type KimiLoginLaunchResultV1 =
  | { readonly started: true; readonly completion: Promise<void> }
  | {
      readonly started: false
      readonly reasonCode: 'PLATFORM_UNSUPPORTED' | 'KIMI_LOGIN_LAUNCH_FAILED'
    }

export interface KimiLoginLauncherV1 {
  launch(input: {
    readonly command: string
    readonly kimiCodeHome: string
  }): Promise<KimiLoginLaunchResultV1>
}

export interface KimiLoginCoordinatorOptionsV1 {
  readonly effectiveEnabled: boolean
  readonly userDataDir: string
  readonly probe?: KimiAcpProbeV1
  readonly launcher?: KimiLoginLauncherV1
}

interface InspectedKimiRuntimeV1 {
  readonly snapshot: XiaoguiKimiRuntimeStatusSnapshotV1
  readonly command?: string
  readonly kimiCodeHome?: string
}

/**
 * Main-process-only deep Module for Kimi login. Its public Interface exposes
 * status evidence, never paths, credentials, commands, environment or raw CLI output.
 */
export class KimiLoginCoordinatorV1 {
  private readonly probe: KimiAcpProbeV1
  private readonly launcher: KimiLoginLauncherV1
  private launchStarting = false
  private loginCompletion: Promise<void> | undefined
  private loginOperationId: object | undefined
  private inProgressDiscoveredVersion: string | undefined
  private closed = false

  constructor(private readonly options: KimiLoginCoordinatorOptionsV1) {
    this.probe = options.probe ?? new KimiAcpCliProbeV1()
    this.launcher = options.launcher ?? new WindowsKimiLoginLauncherV1()
  }

  async inspect(): Promise<XiaoguiKimiRuntimeStatusSnapshotV1> {
    if (this.closed) return snapshot('STATUS_UNAVAILABLE', 'KIMI_COORDINATOR_CLOSED')
    if (!this.options.effectiveEnabled) return snapshot('DISABLED', 'PRODUCTION_DISABLED')
    if (this.launchStarting || this.loginCompletion) return this.inProgressSnapshot()
    const inspected = await this.inspectIdle()
    return this.closed
      ? snapshot('STATUS_UNAVAILABLE', 'KIMI_COORDINATOR_CLOSED')
      : inspected.snapshot
  }

  async startLogin(): Promise<XiaoguiKimiRuntimeStatusSnapshotV1> {
    if (this.closed) return snapshot('STATUS_UNAVAILABLE', 'KIMI_COORDINATOR_CLOSED')
    if (!this.options.effectiveEnabled) return snapshot('DISABLED', 'PRODUCTION_DISABLED')
    if (this.launchStarting || this.loginCompletion) return this.inProgressSnapshot()

    this.launchStarting = true
    let keepInProgress = false
    try {
      const inspected = await this.inspectIdle()
      if (
        inspected.snapshot.status !== 'LOGIN_REQUIRED' &&
        inspected.snapshot.status !== 'CREDENTIAL_PRESENT_UNVERIFIED'
      ) {
        return inspected.snapshot
      }
      if (this.closed) return snapshot('STATUS_UNAVAILABLE', 'KIMI_COORDINATOR_CLOSED')
      if (!inspected.command || !inspected.kimiCodeHome) {
        return snapshot('STATUS_UNAVAILABLE', 'KIMI_LOGIN_LAUNCH_FAILED')
      }

      const launch = await this.launcher.launch({
        command: inspected.command,
        kimiCodeHome: inspected.kimiCodeHome,
      })
      if (!launch.started) return snapshot('STATUS_UNAVAILABLE', launch.reasonCode)
      if (this.closed) {
        void launch.completion.catch(() => undefined)
        return snapshot('STATUS_UNAVAILABLE', 'KIMI_COORDINATOR_CLOSED')
      }

      keepInProgress = true
      this.inProgressDiscoveredVersion = inspected.snapshot.discoveredVersion
      const operationId = {}
      this.loginOperationId = operationId
      const completion = launch.completion
        .then(
          () => this.inspectAfterLoginCompletion(),
          () => this.inspectAfterLoginCompletion(),
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          if (this.loginOperationId === operationId) {
            this.loginCompletion = undefined
            this.loginOperationId = undefined
            this.inProgressDiscoveredVersion = undefined
          }
        })
      this.loginCompletion = completion
      return this.inProgressSnapshot()
    } catch {
      return snapshot('STATUS_UNAVAILABLE', 'KIMI_LOGIN_LAUNCH_FAILED')
    } finally {
      this.launchStarting = false
      if (!keepInProgress) this.inProgressDiscoveredVersion = undefined
    }
  }

  /** Detaches this coordinator; it intentionally does not terminate a visible login window. */
  close(): void {
    this.closed = true
    this.loginCompletion = undefined
    this.loginOperationId = undefined
    this.inProgressDiscoveredVersion = undefined
  }

  private async inspectIdle(): Promise<InspectedKimiRuntimeV1> {
    let kimiCodeHome: string
    try {
      const home = prepareKimiProductionHomeV1({
        enabled: true,
        userDataDir: this.options.userDataDir,
      })
      if (!home.enabled) throw new Error('KIMI_PRODUCTION_HOME_DISABLED')
      kimiCodeHome = home.kimiCodeHome
    } catch {
      return {
        snapshot: snapshot('STATUS_UNAVAILABLE', 'KIMI_PRODUCTION_HOME_UNAVAILABLE'),
      }
    }

    let probe: Awaited<ReturnType<KimiAcpProbeV1['findExecutable']>>
    try {
      probe = await this.probe.findExecutable()
    } catch {
      return { snapshot: snapshot('STATUS_UNAVAILABLE', 'KIMI_PROBE_UNAVAILABLE') }
    }
    if (!probe.available) {
      return { snapshot: snapshot('CLI_NOT_FOUND', 'KIMI_CLI_NOT_FOUND') }
    }

    const discoveredVersion = safeSemver(probe.version)
    if (discoveredVersion !== KIMI_ACP_APPROVED_VERSION_V1) {
      return {
        snapshot: snapshot(
          'VERSION_UNAPPROVED',
          'KIMI_VERSION_UNAPPROVED',
          discoveredVersion,
        ),
      }
    }

    try {
      const credentialPresent = await hasPrivateCredentialJson(kimiCodeHome)
      return {
        snapshot: credentialPresent
          ? snapshot(
              'CREDENTIAL_PRESENT_UNVERIFIED',
              'KIMI_CREDENTIAL_PRESENT_UNVERIFIED',
              discoveredVersion,
            )
          : snapshot('LOGIN_REQUIRED', 'KIMI_CREDENTIAL_MISSING', discoveredVersion),
        command: probe.command,
        kimiCodeHome,
      }
    } catch {
      return {
        snapshot: snapshot(
          'STATUS_UNAVAILABLE',
          'KIMI_CREDENTIAL_STATUS_UNAVAILABLE',
          discoveredVersion,
        ),
      }
    }
  }

  private async inspectAfterLoginCompletion(): Promise<void> {
    if (this.closed) return
    await this.inspectIdle()
  }

  private inProgressSnapshot(): XiaoguiKimiRuntimeStatusSnapshotV1 {
    return snapshot(
      'LOGIN_IN_PROGRESS',
      'KIMI_LOGIN_IN_PROGRESS',
      this.inProgressDiscoveredVersion,
    )
  }
}

/** Production Adapter: hidden PowerShell starts a separate, visible Kimi login window. */
export class WindowsKimiLoginLauncherV1 implements KimiLoginLauncherV1 {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async launch(input: {
    readonly command: string
    readonly kimiCodeHome: string
  }): Promise<KimiLoginLaunchResultV1> {
    if (this.platform !== 'win32') {
      return { started: false, reasonCode: 'PLATFORM_UNSUPPORTED' }
    }
    const executableName = win32.basename(input.command).toLowerCase()
    if (
      !win32.isAbsolute(input.command) ||
      !WINDOWS_KIMI_EXECUTABLE_NAMES.has(executableName) ||
      !win32.isAbsolute(input.kimiCodeHome)
    ) {
      return { started: false, reasonCode: 'KIMI_LOGIN_LAUNCH_FAILED' }
    }

    const script = [
      `$env:KIMI_CODE_HOME = '${quotePowerShellSingle(input.kimiCodeHome)}'`,
      `$login = Start-Process -FilePath '${quotePowerShellSingle(input.command)}' -ArgumentList @('login') -WorkingDirectory '${quotePowerShellSingle(input.kimiCodeHome)}' -WindowStyle Normal -PassThru`,
      '$login.WaitForExit()',
      'exit $login.ExitCode',
    ].join('; ')
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')

    try {
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        { windowsHide: true, stdio: 'ignore' },
      )
      const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
        child.once('error', rejectCompletion)
        child.once('close', (code) => {
          if (code === 0) resolveCompletion()
          else rejectCompletion(new Error('KIMI_LOGIN_PROCESS_FAILED'))
        })
      })
      return { started: true, completion }
    } catch {
      return { started: false, reasonCode: 'KIMI_LOGIN_LAUNCH_FAILED' }
    }
  }
}

const WINDOWS_KIMI_EXECUTABLE_NAMES = new Set(['kimi.exe', 'kimi.cmd', 'kimi.bat'])

async function hasPrivateCredentialJson(kimiCodeHome: string): Promise<boolean> {
  const credentialsDir = join(kimiCodeHome, 'credentials')
  let directoryInfo
  try {
    directoryInfo = await lstat(credentialsDir, { bigint: true })
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return false
    throw error
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error('KIMI_CREDENTIAL_DIRECTORY_UNSAFE')
  }
  if (pathKey(await realpath(credentialsDir)) !== pathKey(resolve(credentialsDir))) {
    throw new Error('KIMI_CREDENTIAL_DIRECTORY_ALIAS')
  }

  const entries = await readdir(credentialsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    const credentialPath = join(credentialsDir, entry.name)
    const info = await lstat(credentialPath, { bigint: true })
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
      throw new Error('KIMI_CREDENTIAL_FILE_UNSAFE')
    }
    if (pathKey(await realpath(credentialPath)) !== pathKey(resolve(credentialPath))) {
      throw new Error('KIMI_CREDENTIAL_FILE_ALIAS')
    }
    return true
  }
  return false
}

function snapshot(
  status: XiaoguiKimiRuntimeStatusV1,
  reasonCode: XiaoguiKimiRuntimeReasonCodeV1,
  discoveredVersion?: string,
): XiaoguiKimiRuntimeStatusSnapshotV1 {
  return {
    status,
    reasonCode,
    approvedVersion: KIMI_ACP_APPROVED_VERSION_V1,
    ...(discoveredVersion ? { discoveredVersion } : {}),
  }
}

function safeSemver(value: string | undefined): string | undefined {
  if (!value || value.length > 128) return undefined
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  )
    ? value
    : undefined
}

function quotePowerShellSingle(value: string): string {
  return value.replace(/'/g, "''")
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
