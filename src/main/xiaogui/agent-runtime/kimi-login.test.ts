import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  KimiLoginCoordinatorV1,
  WindowsKimiLoginLauncherV1,
  type KimiLoginLauncherV1,
} from './kimi-login'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawnMock = vi.fn()
  const defaultExport = (actual as unknown as { default: Record<string, unknown> }).default
  return {
    ...actual,
    default: { ...defaultExport, spawn: spawnMock },
    spawn: spawnMock,
  }
})

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-kimi-login-'))
  roots.push(root)
  return root
}

function probe(result: Awaited<ReturnType<import('./kimi-adapter').KimiAcpProbeV1['findExecutable']>>) {
  return { findExecutable: vi.fn(async () => result) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('KimiLoginCoordinatorV1', () => {
  it('has zero home, probe and launcher side effects while disabled', async () => {
    const root = await userData()
    const privateRuntime = join(root, 'xiaogui', 'agent-runtime')
    const cliProbe = probe({ available: true, command: 'C:/Kimi/kimi.exe', version: '0.34.0' })
    const launcher = { launch: vi.fn() }
    const coordinator = new KimiLoginCoordinatorV1({
      effectiveEnabled: false,
      userDataDir: root,
      probe: cliProbe,
      launcher,
    })

    await expect(coordinator.inspect()).resolves.toMatchObject({
      status: 'DISABLED',
      reasonCode: 'PRODUCTION_DISABLED',
      approvedVersion: '0.34.0',
    })
    await expect(coordinator.startLogin()).resolves.toMatchObject({ status: 'DISABLED' })
    expect(existsSync(privateRuntime)).toBe(false)
    expect(cliProbe.findExecutable).not.toHaveBeenCalled()
    expect(launcher.launch).not.toHaveBeenCalled()
  })

  it('reports missing and unapproved CLIs without leaking non-semver output', async () => {
    const root = await userData()
    const missing = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: probe({ available: false, reasonCode: 'D:/private/path' }),
    })
    await expect(missing.inspect()).resolves.toEqual({
      status: 'CLI_NOT_FOUND',
      reasonCode: 'KIMI_CLI_NOT_FOUND',
      approvedVersion: '0.34.0',
    })

    const unapproved = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: probe({ available: true, command: 'C:/Kimi/kimi.exe', version: 'D:/private/path' }),
    })
    await expect(unapproved.inspect()).resolves.toEqual({
      status: 'VERSION_UNAPPROVED',
      reasonCode: 'KIMI_VERSION_UNAPPROVED',
      approvedVersion: '0.34.0',
    })
  })

  it('distinguishes missing credentials from a safe private json credential without reading it', async () => {
    const root = await userData()
    const coordinator = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: probe({ available: true, command: 'C:/Kimi/kimi.exe', version: '0.34.0' }),
    })

    await expect(coordinator.inspect()).resolves.toMatchObject({ status: 'LOGIN_REQUIRED' })

    const credentials = join(root, 'xiaogui', 'agent-runtime', 'kimi-v1', 'credentials')
    await mkdir(credentials)
    await writeFile(join(credentials, 'account.json'), '{ deliberately-not-parsed')
    await expect(coordinator.inspect()).resolves.toMatchObject({
      status: 'CREDENTIAL_PRESENT_UNVERIFIED',
      reasonCode: 'KIMI_CREDENTIAL_PRESENT_UNVERIFIED',
    })
  })

  it('coalesces repeated login clicks and re-inspects private credentials after completion', async () => {
    const root = await userData()
    const finished = deferred()
    const launcher: KimiLoginLauncherV1 = {
      launch: vi.fn(async () => ({ started: true as const, completion: finished.promise })),
    }
    const cliProbe = probe({ available: true, command: 'C:/Kimi/kimi.exe', version: '0.34.0' })
    const coordinator = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: cliProbe,
      launcher,
    })

    await expect(coordinator.startLogin()).resolves.toMatchObject({ status: 'LOGIN_IN_PROGRESS' })
    await expect(coordinator.startLogin()).resolves.toMatchObject({ status: 'LOGIN_IN_PROGRESS' })
    expect(launcher.launch).toHaveBeenCalledOnce()

    const credentials = join(root, 'xiaogui', 'agent-runtime', 'kimi-v1', 'credentials')
    await mkdir(credentials)
    await writeFile(join(credentials, 'account.json'), '{}')
    finished.resolve()
    await vi.waitFor(() => expect(cliProbe.findExecutable).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => {
      await expect(coordinator.inspect()).resolves.toMatchObject({
        status: 'CREDENTIAL_PRESENT_UNVERIFIED',
      })
    })
  })

  it('does not scan again when a detached login window completes after coordinator close', async () => {
    const root = await userData()
    const finished = deferred()
    const cliProbe = probe({ available: true, command: 'C:/Kimi/kimi.exe', version: '0.34.0' })
    const coordinator = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: cliProbe,
      launcher: {
        launch: vi.fn(async () => ({ started: true as const, completion: finished.promise })),
      },
    })

    await expect(coordinator.startLogin()).resolves.toMatchObject({ status: 'LOGIN_IN_PROGRESS' })
    coordinator.close()
    finished.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(cliProbe.findExecutable).toHaveBeenCalledOnce()
  })

  it('fails closed when inspect or login preflight finishes after coordinator close', async () => {
    const root = await userData()
    const probeResults: Array<(
      result: { available: true; command: string; version: string },
    ) => void> = []
    const delayedProbe = {
      findExecutable: vi.fn(
        () =>
          new Promise<{ available: true; command: string; version: string }>((resolve) => {
            probeResults.push(resolve)
          }),
      ),
    }
    const launcher = { launch: vi.fn() }
    const inspectionCoordinator = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: delayedProbe,
      launcher,
    })
    const loginCoordinator = new KimiLoginCoordinatorV1({
      effectiveEnabled: true,
      userDataDir: root,
      probe: delayedProbe,
      launcher,
    })

    const inspection = inspectionCoordinator.inspect()
    const login = loginCoordinator.startLogin()
    inspectionCoordinator.close()
    loginCoordinator.close()
    await vi.waitFor(() => expect(probeResults).toHaveLength(2))
    for (const resolveProbe of probeResults) {
      resolveProbe({ available: true, command: 'C:/Kimi/kimi.exe', version: '0.34.0' })
    }

    await expect(inspection).resolves.toMatchObject({
      status: 'STATUS_UNAVAILABLE',
      reasonCode: 'KIMI_COORDINATOR_CLOSED',
    })
    await expect(login).resolves.toMatchObject({
      status: 'STATUS_UNAVAILABLE',
      reasonCode: 'KIMI_COORDINATOR_CLOSED',
    })
    expect(launcher.launch).not.toHaveBeenCalled()
  })
})

describe('WindowsKimiLoginLauncherV1', () => {
  it('uses an encoded hidden PowerShell wrapper for a visible approved kimi.exe login', async () => {
    const child = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
    const launcher = new WindowsKimiLoginLauncherV1('win32')

    const launch = await launcher.launch({
      command: "C:\\Program Files\\Kimi O'Brien\\kimi.exe",
      kimiCodeHome: "C:\\Users\\O'Brien\\private-kimi",
    })

    expect(launch.started).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!
    expect(file).toBe('powershell.exe')
    expect(options).toMatchObject({ windowsHide: true, stdio: 'ignore' })
    expect(args).not.toContain("C:\\Program Files\\Kimi O'Brien\\kimi.exe")
    const encoded = args[args.indexOf('-EncodedCommand') + 1]!
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain("$env:KIMI_CODE_HOME = 'C:\\Users\\O''Brien\\private-kimi'")
    expect(script).toContain("Start-Process -FilePath 'C:\\Program Files\\Kimi O''Brien\\kimi.exe'")
    expect(script).toContain("-ArgumentList @('login') -WorkingDirectory 'C:\\Users\\O''Brien\\private-kimi' -WindowStyle Normal")

    if (launch.started) {
      child.emit('close', 0)
      await expect(launch.completion).resolves.toBeUndefined()
    }
  })

  it('launches an absolute PATH kimi.cmd shim with the fixed login argument', async () => {
    const child = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
    const launcher = new WindowsKimiLoginLauncherV1('win32')

    const launch = await launcher.launch({
      command: 'C:\\Tools\\Kimi\\kimi.cmd',
      kimiCodeHome: 'C:\\Xiaogui\\private-kimi',
    })

    expect(launch.started).toBe(true)
    const args = vi.mocked(spawn).mock.calls[0]![1]
    const encoded = args[args.indexOf('-EncodedCommand') + 1]!
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain("Start-Process -FilePath 'C:\\Tools\\Kimi\\kimi.cmd'")
    expect(script).toContain("-ArgumentList @('login')")
    expect(script).toContain("-WorkingDirectory 'C:\\Xiaogui\\private-kimi'")

    if (launch.started) {
      child.emit('close', 0)
      await expect(launch.completion).resolves.toBeUndefined()
    }
  })

  it('rejects an absolute executable whose basename is not an approved Kimi candidate', async () => {
    const launcher = new WindowsKimiLoginLauncherV1('win32')

    await expect(
      launcher.launch({
        command: 'C:\\Windows\\System32\\powershell.exe',
        kimiCodeHome: 'C:\\Xiaogui\\private-kimi',
      }),
    ).resolves.toEqual({ started: false, reasonCode: 'KIMI_LOGIN_LAUNCH_FAILED' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
