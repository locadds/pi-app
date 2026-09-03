import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
        env: { PI_CODING_AGENT_DIR: state },
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
      console.info(JSON.stringify({
        event: 'omp-p1d-a-real-bundle',
        status: assembled.ok ? assembled.status : 'failed',
        fileCount: OMP_RUNTIME_BUNDLE_MANIFEST_V1.fileCount,
        byteLength: OMP_RUNTIME_BUNDLE_MANIFEST_V1.byteLength,
        protocolVersion: initialized.protocolVersion,
        agentInfo: initialized.agentInfo,
      }))
    } finally {
      await transport?.dispose()
    }
  }, 900_000)
})

class FixtureVerifier implements OmpRuntimeBundleVerificationPortV1 {
  constructor(private readonly measurement: OmpRuntimeBundleMeasurementV1) {}

  async verify(root: string) {
    const native = await readFile(join(root, ...FIXTURE_NATIVE_PATH.split('/')), 'utf8').catch(() => '')
    if (native !== 'safe') {
      return { ok: false as const, reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID' }
    }
    return { ok: true as const, measurement: this.measurement }
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
