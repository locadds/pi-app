import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OmpTrustedInstallationModuleV1 } from './omp-trusted-installation'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OmpTrustedInstallationModuleV1', () => {
  it('refuses to sign a caller-supplied directory that only matches package metadata', async () => {
    const paths = await fixture()
    const module = new OmpTrustedInstallationModuleV1({
      ...paths,
      now: () => '2026-09-02T00:00:00.000Z',
    })
    expect(() => module.recordVerifiedInstallation()).toThrow('OMP_PACKAGE_CONTENT_UNAPPROVED')
    expect(() => module.recordVerifiedInstallation()).toThrow('OMP_PACKAGE_CONTENT_UNAPPROVED')
  })

  it('rejects an unapproved package manifest before measuring a trust root', async () => {
    const paths = await fixture()
    await writeFile(join(paths.packageRoot, 'package.json'), JSON.stringify({
      name: '@oh-my-pi/pi-coding-agent',
      version: '18.1.3',
      license: 'MIT',
      bin: { omp: 'dist/cli.js' },
    }))
    const module = new OmpTrustedInstallationModuleV1(paths)
    expect(() => module.recordVerifiedInstallation()).toThrow('OMP_PACKAGE_MANIFEST_UNAPPROVED')
  })

  it('rejects an invalid receipt before treating package metadata as trusted', async () => {
    const paths = await fixture()
    await mkdir(join(paths.receiptPath, '..'), { recursive: true })
    await writeFile(paths.receiptPath, '{"schemaVersion":1,"version":"18.1.2"}')
    const module = new OmpTrustedInstallationModuleV1(paths)
    expect(module.inspect()).toEqual({ ok: false, reasonCode: 'OMP_INSTALLATION_RECEIPT_INVALID' })
    expect(() => module.recordVerifiedInstallation()).toThrow('OMP_INSTALLATION_RECEIPT_CONFLICT')
  })

  const livePackageRoot = process.env.XIAOGUI_OMP_TRUSTED_PACKAGE_ROOT
  const liveTest = livePackageRoot ? it : it.skip
  liveTest('measures a fixed package root only when it matches the pinned official tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-omp-live-install-'))
    roots.push(root)
    const module = new OmpTrustedInstallationModuleV1({
      packageRoot: livePackageRoot!,
      privateStateDir: join(root, 'state'),
      receiptPath: join(root, 'receipt-v1.json'),
      now: () => '2026-09-02T00:00:00.000Z',
    })
    const receipt = module.recordVerifiedInstallation()
    expect(receipt).toMatchObject({
      packageName: '@oh-my-pi/pi-coding-agent',
      version: '18.1.2',
      packageFileCount: 3_136,
      packageByteLength: 48_326_575,
      treeDigest: 'sha256:159d43dce438cc5a26fde64639d755612f5c97eb8067e8650487542495a685da',
    })
    expect(JSON.stringify(receipt)).not.toContain(livePackageRoot)
    expect(JSON.stringify(receipt)).not.toContain(root)
    expect(module.inspect()).toMatchObject({ ok: true })
    await rm(join(root, 'state'), { recursive: true, force: true })
    expect(module.inspect()).toEqual({ ok: false, reasonCode: 'OMP_PRIVATE_STATE_DIR_INVALID' })
  }, 30_000)
})

async function fixture(): Promise<{
  packageRoot: string
  privateStateDir: string
  receiptPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-omp-install-'))
  roots.push(root)
  const packageRoot = join(root, 'package')
  const privateStateDir = join(root, 'private-state')
  const receiptPath = join(root, 'receipts', 'omp-v18.1.2.json')
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@oh-my-pi/pi-coding-agent',
    version: '18.1.2',
    license: 'MIT',
    bin: { omp: 'dist/cli.js' },
  }))
  await writeFile(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env bun\nconsole.log("omp")\n')
  await writeFile(join(packageRoot, 'LICENSE'), 'MIT\n')
  return { packageRoot, privateStateDir, receiptPath }
}
