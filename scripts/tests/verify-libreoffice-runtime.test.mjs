import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  assertDDriveCacheRoot,
  verifyLibreOfficeRuntime,
} from '../verify-libreoffice-runtime.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

describe('verify LibreOffice packaging gate', () => {
  it('accepts only a complete runtime, installer, manifest, and legal payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-lo-verify-'))
    const runtimeRoot = join(root, 'resources', 'libreoffice-runtime', 'runtime')
    const cacheRoot = join(root, 'cache')
    const installer = Buffer.from('fixed installer fixture')
    const contract = {
      version: '26.2.5',
      fileName: 'LibreOffice_26.2.5_Win_x86-64.msi',
      downloadUrl: 'https://example.invalid/stable/26.2.5/LibreOffice_26.2.5_Win_x86-64.msi',
      sourceUrl: 'https://example.invalid/src/26.2.5/',
      installerSha256: digest(installer),
      installerBytes: installer.length,
      executable: 'program/soffice.exe',
    }
    try {
      await mkdir(join(runtimeRoot, 'program'), { recursive: true })
      await mkdir(cacheRoot, { recursive: true })
      await mkdir(join(root, 'resources', 'legal'), { recursive: true })
      await writeFile(join(runtimeRoot, 'program', 'soffice.exe'), 'fixture')
      await writeFile(join(cacheRoot, contract.fileName), installer)
      await writeFile(join(runtimeRoot, 'xiaogui-runtime-manifest.json'), JSON.stringify({
        version: contract.version,
        sourceUrl: contract.downloadUrl,
        sourceCodeUrl: contract.sourceUrl,
        installerSha256: contract.installerSha256,
        installerBytes: contract.installerBytes,
        executable: contract.executable,
      }))
      await writeFile(
        join(root, 'THIRD_PARTY_NOTICES.md'),
        `LibreOffice ${contract.version}\n${contract.installerSha256}\n${contract.sourceUrl}`,
      )
      await writeFile(join(root, 'sbom.cdx.json'), JSON.stringify({
        components: [{
          name: 'LibreOffice Windows x64 private runtime',
          version: contract.version,
          hashes: [{ alg: 'SHA-256', content: contract.installerSha256 }],
        }],
      }))
      await writeFile(join(root, 'resources', 'legal', 'MPL-2.0.txt'), 'MPL 2.0')
      await writeFile(join(root, 'resources', 'legal', 'Apache-2.0.txt'), 'Apache 2.0')
      await writeFile(
        join(root, 'resources', 'legal', 'LIBREOFFICE_SOURCE.md'),
        contract.sourceUrl,
      )
      await writeFile(
        join(root, 'resources', 'libreoffice-runtime', 'README.md'),
        `LibreOffice ${contract.version}\n${contract.sourceUrl}`,
      )

      const result = await verifyLibreOfficeRuntime({ rootDir: root, cacheRoot, contract })
      assert.equal(result.version, contract.version)
      assert.equal(result.installerSha256, contract.installerSha256)

      await rm(join(root, 'resources', 'legal', 'Apache-2.0.txt'))
      await assert.rejects(
        verifyLibreOfficeRuntime({ rootDir: root, cacheRoot, contract }),
        /PACKAGING_REQUIRED_FILE_MISSING:apache/,
      )
      await writeFile(join(root, 'resources', 'legal', 'Apache-2.0.txt'), 'Apache 2.0')

      await writeFile(join(runtimeRoot, 'xiaogui-runtime-manifest.json'), JSON.stringify({
        version: '26.2.4',
        sourceUrl: contract.downloadUrl,
        sourceCodeUrl: contract.sourceUrl,
        installerSha256: contract.installerSha256,
        installerBytes: contract.installerBytes,
        executable: contract.executable,
      }))
      await assert.rejects(
        verifyLibreOfficeRuntime({ rootDir: root, cacheRoot, contract }),
        /LIBREOFFICE_RUNTIME_MANIFEST_MISMATCH:version/,
      )

      await writeFile(join(runtimeRoot, 'xiaogui-runtime-manifest.json'), JSON.stringify({
        version: contract.version,
        sourceUrl: contract.downloadUrl,
        sourceCodeUrl: contract.sourceUrl,
        installerSha256: contract.installerSha256,
        installerBytes: contract.installerBytes,
        executable: contract.executable,
      }))
      await writeFile(join(cacheRoot, contract.fileName), 'tampered installer')
      await assert.rejects(
        verifyLibreOfficeRuntime({ rootDir: root, cacheRoot, contract }),
        /LIBREOFFICE_INSTALLER_(?:SIZE|CHECKSUM)_MISMATCH/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a C-drive build cache root', () => {
    assert.throws(() => assertDDriveCacheRoot('C:\\temp\\xiaogui'), /BUILD_CACHE_MUST_BE_ON_D_DRIVE/)
    assert.doesNotThrow(() => assertDDriveCacheRoot('D:\\temp\\xiaogui'))
  })
})
