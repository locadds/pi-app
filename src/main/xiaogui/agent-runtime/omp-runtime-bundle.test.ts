import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpTransportV1 } from './acp/types'
import { AcpProcessTransportFactoryV1 } from './acp/process-transport'
import { OMP_ACP_APPROVED_VERSION_V1 } from './omp-acp-adapter'
import { OmpTrustedAcpLaunchProviderV1 } from './omp-acp-production'
import {
  OMP_RUNTIME_BUNDLE_MANIFEST_V1,
  OmpActivatedRuntimeBundleModuleV1,
  OmpRuntimeBundleActivationInspectorV1,
  OmpRuntimeBundleActivationTransactionV1,
  OmpRuntimeBundleAssemblerV1,
  OmpRuntimeBundleVerifierV1,
  resolveOmpRuntimeBundleStorageLayoutV1,
  type OmpRuntimeBundleManifestV1,
  type OmpRuntimeBundleMeasurementV1,
  type OmpRuntimeBundleVerificationPortV1,
} from './omp-runtime-bundle'

const roots: string[] = []
const realP1dIt = process.env.XIAOGUI_OMP_P1D_REAL_BUNDLE === '1' ? it : it.skip
const FIXTURE_NATIVE_PATH = 'node_modules/@oh-my-pi/pi-natives-win32-x64/pi_natives.win32-x64-baseline.node'
const FIXTURE_EXECUTABLE_PATH = 'node_modules/example-runtime/index.js'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OMP full runtime bundle P1D-A', () => {
  it('pins one path-free full dependency closure manifest', () => {
    expect(OMP_RUNTIME_BUNDLE_MANIFEST_V1).toMatchObject({
      schemaVersion: 1,
      version: '18.1.2',
      sourceRevision: '86bf72f52947f62ecaf9bd28e35572812e725a92',
      treeDigest: 'sha256:b1e7aacadfc4791ab7cd092e17b96bfb15781f7b220bfc7eabb7a6d430f98591',
      fileCount: 24_230,
      directoryCount: 2_144,
      byteLength: 802_081_247,
    })
    expect(OMP_RUNTIME_BUNDLE_MANIFEST_V1.criticalFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'node_modules/@oh-my-pi/pi-natives-win32-x64/pi_natives.win32-x64-baseline.node',
        byteLength: 175_602_176,
      }),
    ]))
    expect(JSON.stringify(OMP_RUNTIME_BUNDLE_MANIFEST_V1)).not.toMatch(/[A-Z]:\\/i)
  })

  it('rejects a directory that only resembles the package but lacks the fixed dependency closure', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-fake-')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'xiaogui-omp-runtime-18-1-2',
      private: true,
      dependencies: { '@oh-my-pi/pi-coding-agent': '18.1.2' },
    }))
    await expect(new OmpRuntimeBundleVerifierV1().verify(root)).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID',
    })
  })

  it('keeps the previous activation usable when a critical native dependency is tampered', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-atomic-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await mkdir(join(source, 'node_modules', '@oh-my-pi', 'pi-coding-agent'), { recursive: true })
    const fixtureNative = join(source, ...FIXTURE_NATIVE_PATH.split('/'))
    await mkdir(join(source, 'node_modules', '@oh-my-pi', 'pi-natives-win32-x64'), { recursive: true })
    await writeFile(fixtureNative, 'safe')
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement)
    const timestamps = [
      '2026-09-03T10:00:00.000Z',
      '2026-09-03T10:00:01.000Z',
    ]
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => timestamps.shift() ?? '2026-09-03T10:00:02.000Z',
    })

    await expect(transaction.installFrom(source)).resolves.toMatchObject({
      ok: true,
      status: 'ACTIVATED',
      retainedPreviousActivation: false,
    })
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    const pointerBefore = await readFile(layout.activePointerPath, 'utf8')
    await writeFile(fixtureNative, 'tampered')

    await expect(transaction.installFrom(source, { forceReinstall: true })).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID',
    })
    expect(await readFile(layout.activePointerPath, 'utf8')).toBe(pointerBefore)
    await expect(new OmpRuntimeBundleActivationInspectorV1({
      layout,
      privateStateDir: state,
      manifest,
      verifier,
    }).inspect({ fresh: true })).resolves.toMatchObject({ ok: true })
    expect(pointerBefore).not.toContain(root)

    await writeFile(fixtureNative, 'safe')
    await expect(transaction.installFrom(source, { forceReinstall: true })).resolves.toMatchObject({
      ok: true,
      status: 'ACTIVATED',
      retainedPreviousActivation: true,
    })
    const pointerAfter = await readFile(layout.activePointerPath, 'utf8')
    expect(pointerAfter).not.toBe(pointerBefore)

    const inspector = new OmpRuntimeBundleActivationInspectorV1({
      layout,
      privateStateDir: state,
      manifest,
      verifier,
    })
    await expect(inspector.inspect()).resolves.toMatchObject({ ok: true })
    const activeDirectory = (JSON.parse(pointerAfter) as { runtimeDirectoryName: string }).runtimeDirectoryName
    const activeNative = join(layout.versionsDir, activeDirectory, ...FIXTURE_NATIVE_PATH.split('/'))
    await writeFile(activeNative, 'tampered')
    await expect(inspector.inspect()).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID',
    })
    await writeFile(activeNative, 'safe')
    await expect(inspector.inspect({ fresh: true })).resolves.toMatchObject({ ok: true })
  })

  it('does not delete an existing active version when a deterministic activation name conflicts', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-version-conflict-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await createFixtureSource(source)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement)
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })

    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: true, status: 'ACTIVATED' })
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    const pointerBefore = await readFile(layout.activePointerPath, 'utf8')
    const activeDirectory = (JSON.parse(pointerBefore) as { runtimeDirectoryName: string }).runtimeDirectoryName
    const activeNative = join(layout.versionsDir, activeDirectory, ...FIXTURE_NATIVE_PATH.split('/'))

    await expect(transaction.installFrom(source, { forceReinstall: true })).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_VERSION_CONFLICT',
    })
    await expect(readFile(activeNative, 'utf8')).resolves.toBe('safe')
    expect(await readFile(layout.activePointerPath, 'utf8')).toBe(pointerBefore)
    await expect(new OmpRuntimeBundleActivationInspectorV1({
      layout,
      privateStateDir: state,
      manifest,
      verifier,
    }).inspect({ fresh: true })).resolves.toMatchObject({ ok: true })
  })

  it('cleans only its newly published native cache when pointer commit fails', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-late-failure-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await createFixtureSource(source)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    const fixtureVerifier = new FixtureVerifier(measurement)
    let verificationCount = 0
    const verifier: OmpRuntimeBundleVerificationPortV1 = {
      async verify(runtimeRoot) {
        const result = await fixtureVerifier.verify(runtimeRoot)
        verificationCount += 1
        if (verificationCount === 2) await mkdir(layout.activePointerPath, { recursive: true })
        return result
      },
    }
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })

    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: false })
    await expect(readdir(layout.nativeCacheDir)).resolves.toEqual([])
    await expect(readdir(layout.versionsDir)).resolves.toEqual([])
    await rm(layout.activePointerPath, { recursive: true, force: true })
    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: true, status: 'ACTIVATED' })
  })

  it('serializes assembly transactions for one storage root', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-install-lock-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    const secondState = join(root, 'state-two')
    await createFixtureSource(source)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const fixtureVerifier = new FixtureVerifier(measurement)
    let releaseFirstVerification: (() => void) | undefined
    const firstVerificationBlocked = new Promise<void>((resolveBlocked) => {
      releaseFirstVerification = resolveBlocked
    })
    let firstVerifierEntered: (() => void) | undefined
    const firstVerifierStarted = new Promise<void>((resolveStarted) => {
      firstVerifierEntered = resolveStarted
    })
    let firstCall = true
    const firstVerifier: OmpRuntimeBundleVerificationPortV1 = {
      async verify(runtimeRoot) {
        if (firstCall) {
          firstCall = false
          firstVerifierEntered?.()
          await firstVerificationBlocked
        }
        return fixtureVerifier.verify(runtimeRoot)
      },
    }
    const secondVerifier = { verify: vi.fn((runtimeRoot: string) => fixtureVerifier.verify(runtimeRoot)) }
    const first = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier: firstVerifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })
    const second = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: secondState,
      manifest,
      verifier: secondVerifier,
      now: () => '2026-09-03T10:00:01.000Z',
    })

    const firstInstall = first.installFrom(source)
    await firstVerifierStarted
    await expect(second.installFrom(source)).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_INSTALL_IN_PROGRESS',
    })
    expect(secondVerifier.verify).not.toHaveBeenCalled()
    releaseFirstVerification?.()
    await expect(firstInstall).resolves.toMatchObject({ ok: true, status: 'ACTIVATED' })
  })

  it('uses a storage-root SQLite lock that becomes available when the owning connection closes', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-sqlite-lock-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await createFixtureSource(source)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement)
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })

    await expect(transaction.installFrom(source)).resolves.toMatchObject({
      ok: true,
      status: 'ACTIVATED',
    })
    const lockDatabase = (await readdir(layout.rootDir)).find((entry) =>
      entry === '.omp-runtime-install-lock-v1.sqlite',
    )
    if (!lockDatabase) throw new Error('OMP_RUNTIME_TEST_LOCK_DATABASE_MISSING')
    const blockingConnection = new DatabaseSync(join(layout.rootDir, lockDatabase))
    blockingConnection.exec('BEGIN EXCLUSIVE')
    await expect(transaction.installFrom(source)).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_INSTALL_IN_PROGRESS',
    })
    blockingConnection.close()
    await expect(transaction.installFrom(source)).resolves.toMatchObject({
      ok: true,
      status: 'ALREADY_ACTIVE',
    })
  })

  it('rejects a pre-positioned storage lock junction before SQLite can write through it', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-lock-junction-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    const escaped = join(root, 'escaped-lock-target')
    await createFixtureSource(source)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement)
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })
    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: true })
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    const lockDatabase = (await readdir(layout.rootDir)).find((entry) =>
      entry === '.omp-runtime-install-lock-v1.sqlite',
    )
    if (!lockDatabase) throw new Error('OMP_RUNTIME_TEST_LOCK_DATABASE_MISSING')
    const lockPath = join(layout.rootDir, lockDatabase)
    await rm(lockPath, { force: true })
    await mkdir(escaped, { recursive: true })
    await symlink(escaped, lockPath, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(transaction.installFrom(source, { forceReinstall: true })).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_INSTALL_LOCK_INVALID',
    })
    await expect(readdir(escaped)).resolves.toEqual([])
  })

  it('re-runs full-tree verification so cached inspection cannot hide executable dependency drift', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-executable-drift-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await createFixtureSource(source, true)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement, FIXTURE_EXECUTABLE_PATH)
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })
    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: true })
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    const pointer = JSON.parse(await readFile(layout.activePointerPath, 'utf8')) as { runtimeDirectoryName: string }
    const activeExecutable = join(layout.versionsDir, pointer.runtimeDirectoryName, ...FIXTURE_EXECUTABLE_PATH.split('/'))
    const inspector = new OmpRuntimeBundleActivationInspectorV1({
      layout,
      privateStateDir: state,
      manifest,
      verifier,
    })
    const inspected = await inspector.inspect()
    expect(inspected).toMatchObject({ ok: true })
    if (!inspected.ok) throw new Error(inspected.reasonCode)

    await writeFile(activeExecutable, 'tampered-js')
    await expect(inspected.nativeRuntime.verifyBeforeSpawn())
      .rejects.toThrow('OMP_RUNTIME_BUNDLE_CONTENT_UNAPPROVED')
    await expect(inspector.inspect()).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_CONTENT_UNAPPROVED',
    })
  })

  it('rejects a receipt-bound native cache that changes after inspection and before spawn', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-native-cache-drift-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await createFixtureSource(source)
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement)
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })
    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: true })
    const inspector = new OmpRuntimeBundleActivationInspectorV1({
      layout: resolveOmpRuntimeBundleStorageLayoutV1(storage),
      privateStateDir: state,
      manifest,
      verifier,
    })
    const inspected = await inspector.inspect()
    expect(inspected).toMatchObject({ ok: true })
    if (!inspected.ok) throw new Error(inspected.reasonCode)

    await writeFile(inspected.nativeRuntime.addonPath, 'evil')
    await expect(inspected.nativeRuntime.verifyBeforeSpawn()).rejects.toThrow('OMP_RUNTIME_NATIVE_CACHE_INVALID')
    await expect(inspector.inspect()).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_NATIVE_CACHE_INVALID',
    })
  })

  it('rejects a controlled process directory that becomes a junction after inspection', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-native-layout-drift-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    const escaped = join(root, 'escaped-temp')
    await createFixtureSource(source)
    await mkdir(escaped, { recursive: true })
    const measurement = fixtureMeasurement()
    const manifest = fixtureManifest(measurement)
    const verifier = new FixtureVerifier(measurement)
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest,
      verifier,
      now: () => '2026-09-03T10:00:00.000Z',
    })
    await expect(transaction.installFrom(source)).resolves.toMatchObject({ ok: true })
    const inspector = new OmpRuntimeBundleActivationInspectorV1({
      layout: resolveOmpRuntimeBundleStorageLayoutV1(storage),
      privateStateDir: state,
      manifest,
      verifier,
    })
    const inspected = await inspector.inspect()
    expect(inspected).toMatchObject({ ok: true })
    if (!inspected.ok) throw new Error(inspected.reasonCode)
    const tempDirectory = inspected.nativeRuntime.environment.TEMP
    if (!tempDirectory) throw new Error('OMP_RUNTIME_TEST_TEMP_MISSING')

    await rm(tempDirectory, { recursive: true, force: true })
    await symlink(escaped, tempDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(inspected.nativeRuntime.verifyBeforeSpawn())
      .rejects.toThrow('OMP_RUNTIME_NATIVE_CACHE_INVALID')
  })

  it('rejects a storage junction whose physical target overlaps the source before verification or copy', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-junction-overlap-')
    const source = join(root, 'source')
    const storageJunction = join(root, 'storage-junction')
    const state = join(root, 'state')
    await createFixtureSource(source)
    await symlink(source, storageJunction, process.platform === 'win32' ? 'junction' : 'dir')
    const verifier = {
      verify: vi.fn(async () => {
        throw new Error('OMP_RUNTIME_BUNDLE_VERIFIER_MUST_NOT_RUN')
      }),
    }
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storageJunction,
      privateStateDir: state,
      manifest: fixtureManifest(fixtureMeasurement()),
      verifier,
    })

    await expect(transaction.installFrom(source)).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_BUNDLE_ROOT_OVERLAP',
    })
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  it('rejects a non-overlapping storage junction before writing into its physical target', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-junction-write-gate-')
    const source = join(root, 'source')
    const physicalTarget = join(root, 'external-storage-target')
    const storageJunction = join(root, 'storage-junction')
    const state = join(root, 'state')
    await createFixtureSource(source)
    await mkdir(physicalTarget, { recursive: true })
    await symlink(physicalTarget, storageJunction, process.platform === 'win32' ? 'junction' : 'dir')
    const verifier = {
      verify: vi.fn(async () => {
        throw new Error('OMP_RUNTIME_BUNDLE_VERIFIER_MUST_NOT_RUN')
      }),
    }
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storageJunction,
      privateStateDir: state,
      manifest: fixtureManifest(fixtureMeasurement()),
      verifier,
    })

    await expect(transaction.installFrom(source)).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_STORAGE_LAYOUT_INVALID',
    })
    expect(verifier.verify).not.toHaveBeenCalled()
    await expect(readdir(physicalTarget)).resolves.toEqual([])
  })

  it('rejects an internal versions junction whose physical target overlaps the source', async () => {
    const root = await temporaryRoot('xiaogui-omp-p1d-versions-junction-')
    const source = join(root, 'source')
    const storage = join(root, 'storage')
    const state = join(root, 'state')
    await createFixtureSource(source)
    const layout = resolveOmpRuntimeBundleStorageLayoutV1(storage)
    await mkdir(layout.rootDir, { recursive: true })
    await symlink(source, layout.versionsDir, process.platform === 'win32' ? 'junction' : 'dir')
    const verifier = {
      verify: vi.fn(async () => {
        throw new Error('OMP_RUNTIME_BUNDLE_VERIFIER_MUST_NOT_RUN')
      }),
    }
    const transaction = new OmpRuntimeBundleActivationTransactionV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
      manifest: fixtureManifest(fixtureMeasurement()),
      verifier,
    })

    await expect(transaction.installFrom(source)).resolves.toEqual({
      ok: false,
      reasonCode: 'OMP_RUNTIME_STORAGE_LAYOUT_INVALID',
    })
    expect(verifier.verify).not.toHaveBeenCalled()
  })

  realP1dIt('installs the fixed D-drive bundle and completes an ACP initialize without a model prompt', async () => {
    const source = requiredAbsoluteEnv('XIAOGUI_OMP_P1D_REAL_BUNDLE_ROOT')
    const storage = requiredAbsoluteEnv('XIAOGUI_OMP_P1D_STORAGE_DIRECTORY')
    const state = requiredAbsoluteEnv('XIAOGUI_OMP_P1D_STATE_DIRECTORY')
    const assembler = new OmpRuntimeBundleAssemblerV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
    })
    const assembled = await assembler.installFrom(source)
    expect(assembled).toMatchObject({
      ok: true,
      manifestDigest: OMP_RUNTIME_BUNDLE_MANIFEST_V1.manifestDigest,
      bundleByteLength: 802_081_247,
      nativeCacheByteLength: 175_602_176,
    })

    const installation = new OmpActivatedRuntimeBundleModuleV1({
      selectedStorageDirectory: storage,
      privateStateDir: state,
    })
    const provider = new OmpTrustedAcpLaunchProviderV1({ installation })
    const launch = await provider.inspectLaunch()
    expect(launch).toMatchObject({
      available: true,
      version: OMP_ACP_APPROVED_VERSION_V1,
      installationReceiptDigest: assembled.ok ? assembled.activationReceiptDigest : undefined,
    })
    if (!launch.available) throw new Error(launch.reasonCode)
    let transport: AcpTransportV1 | undefined
    try {
      transport = new AcpProcessTransportFactoryV1().create(launch.command, launch.args, process.cwd(), {
        env: { ...launch.environment, PI_CODING_AGENT_DIR: state },
        inheritParentEnvironment: false,
        preSpawn: launch.verifyBeforeSpawn,
      })
      const initialized = await transport.start({
        cwd: process.cwd(),
        initialize: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            elicitation: { form: {} },
          },
          clientInfo: { name: 'xiaogui-omp-p1d-a-smoke', version: '0.1.0' },
        },
        requestHandlers: new Map(),
        onSessionUpdate: () => undefined,
        onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
        onDisconnect: () => undefined,
      })
      expect(initialized).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'oh-my-pi', version: OMP_ACP_APPROVED_VERSION_V1 },
      })
      const childPid = (transport as unknown as { child?: { pid?: number } }).child?.pid
      if (!childPid) throw new Error('OMP_P1D_REAL_CHILD_PID_MISSING')
      const loadedNativeModules = loadedProcessModulePaths(childPid)
      const loadedNative = loadedNativeModules.find((path) => /pi_natives\..+\.node$/i.test(path))
      expect(loadedNative).toBeDefined()
      expect(resolve(loadedNative!).toLowerCase()).toBe(resolve(launch.nativeAddonPath).toLowerCase())
      const inheritedGlobalNative = process.env.USERPROFILE
        ? join(
            process.env.USERPROFILE,
            '.omp',
            'natives',
            OMP_ACP_APPROVED_VERSION_V1,
            OMP_RUNTIME_BUNDLE_MANIFEST_V1.nativeAddon.fileName,
          )
        : undefined
      if (inheritedGlobalNative) {
        expect(resolve(loadedNative!).toLowerCase()).not.toBe(resolve(inheritedGlobalNative).toLowerCase())
      }
      console.info(JSON.stringify({
        event: 'omp-p1d-a-real-bundle',
        status: assembled.ok ? assembled.status : 'failed',
        fileCount: OMP_RUNTIME_BUNDLE_MANIFEST_V1.fileCount,
        byteLength: OMP_RUNTIME_BUNDLE_MANIFEST_V1.byteLength,
        protocolVersion: initialized.protocolVersion,
        agentInfo: initialized.agentInfo,
        loadedFromReceiptBoundNativeCache: true,
        inheritedGlobalNativeCacheBypassed: true,
      }))
    } finally {
      await transport?.dispose()
    }

    const inspected = await installation.inspect()
    if (!inspected.ok) throw new Error(inspected.reasonCode)
    const sourceNative = join(
      inspected.runtimeRoot,
      ...OMP_RUNTIME_BUNDLE_MANIFEST_V1.nativeAddon.relativePath.split('/'),
    )
    let tampered = false
    try {
      const handle = await open(launch.nativeAddonPath, 'r+')
      try {
        const firstByte = Buffer.alloc(1)
        await handle.read(firstByte, 0, 1, 0)
        firstByte[0] = firstByte[0]! ^ 0xff
        await handle.write(firstByte, 0, 1, 0)
        tampered = true
      } finally {
        await handle.close()
      }
      await expect(provider.inspectLaunch()).resolves.toEqual({
        available: false,
        reasonCode: 'OMP_RUNTIME_NATIVE_CACHE_INVALID',
      })
    } finally {
      if (tampered) await copyFile(sourceNative, launch.nativeAddonPath)
    }
    await expect(provider.inspectLaunch()).resolves.toMatchObject({ available: true })
  }, 900_000)
})

class FixtureVerifier implements OmpRuntimeBundleVerificationPortV1 {
  constructor(
    private readonly measurement: OmpRuntimeBundleMeasurementV1,
    private readonly executablePath?: string,
  ) {}

  async verify(root: string) {
    const native = await readFile(join(root, ...FIXTURE_NATIVE_PATH.split('/')), 'utf8').catch(() => '')
    if (native !== 'safe') {
      return { ok: false as const, reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID' }
    }
    if (this.executablePath) {
      const executable = await readFile(join(root, ...this.executablePath.split('/')), 'utf8').catch(() => '')
      if (executable !== 'safe-js') {
        return { ok: false as const, reasonCode: 'OMP_RUNTIME_BUNDLE_CONTENT_UNAPPROVED' }
      }
    }
    return { ok: true as const, measurement: this.measurement }
  }
}

async function createFixtureSource(root: string, includeExecutable = false): Promise<void> {
  await mkdir(join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@oh-my-pi', 'pi-natives-win32-x64'), { recursive: true })
  await writeFile(join(root, ...FIXTURE_NATIVE_PATH.split('/')), 'safe')
  if (includeExecutable) {
    const executable = join(root, ...FIXTURE_EXECUTABLE_PATH.split('/'))
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'safe-js')
  }
}

function fixtureMeasurement(): OmpRuntimeBundleMeasurementV1 {
  return Object.freeze({
    rootPackageJsonDigest: `sha256:${'1'.repeat(64)}`,
    dependencyLockDigest: `sha256:${'2'.repeat(64)}`,
    treeDigest: `sha256:${'3'.repeat(64)}`,
    fileCount: 1,
    directoryCount: 5,
    byteLength: 4,
    criticalFiles: Object.freeze([Object.freeze({
      relativePath: FIXTURE_NATIVE_PATH,
      byteLength: 4,
      digest: `sha256:${createHash('sha256').update('safe', 'utf8').digest('hex')}`,
    })]),
  })
}

function fixtureManifest(measurement: OmpRuntimeBundleMeasurementV1): OmpRuntimeBundleManifestV1 {
  return Object.freeze({
    ...OMP_RUNTIME_BUNDLE_MANIFEST_V1,
    ...measurement,
    manifestDigest: `sha256:${'4'.repeat(64)}`,
  })
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function requiredAbsoluteEnv(name: string): string {
  const value = process.env[name]
  if (!value || !/^[A-Za-z]:[\\/]/.test(value)) throw new Error(`${name}_REQUIRED`)
  return value
}

function loadedProcessModulePaths(pid: number): string[] {
  if (process.platform !== 'win32') throw new Error('OMP_P1D_PROCESS_MODULE_PROBE_UNSUPPORTED')
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).Modules | ForEach-Object { $_.FileName }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}
