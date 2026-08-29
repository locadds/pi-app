import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateSbom } from '../generate-release-sbom.mjs'

describe('generate-release-sbom (F-10)', () => {
  it('uses the root dependency version and includes the fixed external runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-sbom-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 't',
          version: '1.0.0',
          dependencies: { 'docx-preview': '0.4.0', zod: '^3.0.0' },
          devDependencies: { officeparser: '7.8.0' },
          xiaoguiBuild: {
            productName: 'Small Rules',
            bundledRuntimeDependencies: ['officeparser', 'docx-preview'],
            bundledExternalRuntimes: [{
              type: 'application',
              name: 'LibreOffice Windows x64 private runtime',
              version: '26.2.5',
              bomRef: 'pkg:generic/libreoffice@26.2.5?arch=x86_64&os=windows',
              sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              license: 'MPL-2.0',
              distributionUrl: 'https://example.invalid/libreoffice-26.2.5.msi',
              sourceUrl: 'https://example.invalid/libreoffice/src/26.2.5/',
            }],
          },
        }),
      )
      await writeFile(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          name: 't',
          version: '1.0.0',
          packages: {
            '': { name: 't', version: '1.0.0' },
            'node_modules/officeparser/node_modules/pdfjs-dist': { version: '6.2.108' },
            'node_modules/zod': { version: '3.24.1' },
            'node_modules/officeparser': { version: '7.8.0', dev: true },
            'node_modules/docx-preview': { version: '0.4.0' },
          },
        }),
      )
      const out = join(dir, 'sbom.cdx.json')
      const r = await generateSbom(dir, out)
      const bom = JSON.parse(await readFile(out, 'utf8'))
      assert.equal(bom.bomFormat, 'CycloneDX')
      assert.deepEqual(bom.metadata.component, {
        type: 'application',
        name: 'Small Rules',
        version: '1.0.0',
      })
      assert.ok(r.componentCount >= 1)
      assert.ok(bom.components.some((c) => c.name === 'zod'))
      assert.ok(bom.components.some((c) => c.name === 'officeparser'))
      assert.equal(bom.components.find((c) => c.name === 'docx-preview')?.version, '0.4.0')
      assert.equal(bom.components.find((c) => c.name === 'pdfjs-dist')?.version, undefined)
      assert.deepEqual(
        bom.components.find((c) => c.name === 'LibreOffice Windows x64 private runtime'),
        {
          type: 'application',
          name: 'LibreOffice Windows x64 private runtime',
          version: '26.2.5',
          'bom-ref': 'pkg:generic/libreoffice@26.2.5?arch=x86_64&os=windows',
          hashes: [{ alg: 'SHA-256', content: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
          licenses: [{ license: { id: 'MPL-2.0' } }],
          externalReferences: [
            { type: 'distribution', url: 'https://example.invalid/libreoffice-26.2.5.msi' },
            { type: 'website', url: 'https://example.invalid/libreoffice/src/26.2.5/' },
          ],
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
