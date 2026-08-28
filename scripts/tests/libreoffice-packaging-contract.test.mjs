import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(join(root, path), 'utf8')

describe('P3C-E0 LibreOffice packaging contract', () => {
  it('routes every formal Windows packaging entry through the fail-closed wrapper', () => {
    const pkg = JSON.parse(read('package.json'))
    const workflow = read('.github/workflows/release.yml')
    const desktopWrapper = read('scripts/package-desktop.mjs')
    const windowsWrapper = read('scripts/package-windows.mjs')

    assert.equal(pkg.scripts.package, 'node scripts/package-desktop.mjs')
    assert.equal(pkg.scripts['package:win'], 'node scripts/package-windows.mjs')
    assert.equal(
      pkg.scripts['package:win:prebuilt'],
      'node scripts/package-windows.mjs --prebuilt',
    )
    assert.match(desktopWrapper, /process\.platform === 'win32'/)
    assert.match(desktopWrapper, /package-windows\.mjs/)
    assert.match(windowsWrapper, /verify-libreoffice-runtime\.mjs/)
    assert.match(windowsWrapper, /generate-release-sbom\.mjs/)
    assert.match(workflow, /npm run package:win:prebuilt/)
    assert.doesNotMatch(workflow, /npx electron-builder --win/)
  })

  it('forces Windows build caches onto D and rejects C-drive overrides', () => {
    const wrapper = read('scripts/package-windows.mjs')
    const workflow = read('.github/workflows/release.yml')
    for (const variable of [
      'npm_config_cache',
      'ELECTRON_CACHE',
      'ELECTRON_BUILDER_CACHE',
      'TEMP',
      'TMP',
    ]) {
      assert.match(wrapper, new RegExp(variable))
    }
    assert.match(wrapper, /assertDDriveCacheRoot/)
    assert.match(workflow, /XIAOGUI_BUILD_CACHE_ROOT:\s*D:\\xiaogui-build-cache/)
    assert.match(workflow, /XIAOGUI_LIBREOFFICE_CACHE_ROOT:\s*D:\\xiaogui-libreoffice-cache/)
    assert.match(workflow, /npm_config_cache:\s*D:\\xiaogui-build-cache\\npm/)
  })

  it('packages LibreOffice only for Windows and includes every legal artifact', () => {
    const builder = read('electron-builder.yml')
    const winStart = builder.indexOf('\nwin:')
    const nsisStart = builder.indexOf('\nnsis:', winStart)
    assert.ok(winStart > 0 && nsisStart > winStart, 'win YAML section must be explicit')
    const rootConfiguration = builder.slice(0, winStart)
    const windowsConfiguration = builder.slice(winStart, nsisStart)
    assert.doesNotMatch(rootConfiguration, /from:\s*resources\/libreoffice-runtime\/runtime/)
    assert.match(
      windowsConfiguration,
      /from:\s*resources\/libreoffice-runtime\/runtime[\s\S]*?to:\s*libreoffice/,
    )
    for (const [from, to] of [
      ['THIRD_PARTY_NOTICES.md', 'legal/THIRD_PARTY_NOTICES.md'],
      ['sbom.cdx.json', 'legal/sbom.cdx.json'],
      ['resources/legal', 'legal'],
    ]) {
      assert.match(
        rootConfiguration,
        new RegExp(`from:\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?to:\\s*${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      )
    }
    assert.match(
      windowsConfiguration,
      /from:\s*resources\/libreoffice-runtime\/README\.md[\s\S]*?to:\s*libreoffice\/README\.md/,
    )
    for (const path of [
      'THIRD_PARTY_NOTICES.md',
      'sbom.cdx.json',
      'resources/legal/MPL-2.0.txt',
      'resources/legal/Apache-2.0.txt',
      'resources/legal/LIBREOFFICE_SOURCE.md',
      'resources/libreoffice-runtime/README.md',
    ]) {
      assert.ok(existsSync(join(root, path)), `${path} must be tracked and packageable`)
    }
  })

  it('pins one renderer-compatible pdfjs-dist 6.1.200 dependency', () => {
    const pkg = JSON.parse(read('package.json'))
    const lock = JSON.parse(read('package-lock.json'))
    assert.equal(pkg.dependencies['pdfjs-dist'], '6.1.200')
    assert.equal(lock.packages[''].dependencies['pdfjs-dist'], '6.1.200')
    const pdfjsEntries = Object.entries(lock.packages)
      .filter(([path]) => path === 'node_modules/pdfjs-dist' || path.endsWith('/node_modules/pdfjs-dist'))
    assert.deepEqual(pdfjsEntries.map(([path, entry]) => [path, entry.version]), [
      ['node_modules/pdfjs-dist', '6.1.200'],
    ])
    assert.ok(
      existsSync(join(root, 'node_modules', 'officeparser', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'))
        || existsSync(join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')),
      'the approved pdfjs-dist package must expose the renderer legacy ESM entry',
    )
  })

  it('uses a source URL fixed to the approved LibreOffice version', () => {
    const fixedSource = 'https://download.documentfoundation.org/libreoffice/src/26.2.5/'
    for (const path of [
      'scripts/verify-libreoffice-runtime.mjs',
      'THIRD_PARTY_NOTICES.md',
      'resources/legal/LIBREOFFICE_SOURCE.md',
      'resources/libreoffice-runtime/README.md',
    ]) {
      assert.match(read(path), new RegExp(fixedSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    const prepare = read('scripts/prepare-libreoffice-runtime.mjs')
    assert.match(prepare, /LIBREOFFICE_CONTRACT/)
    assert.match(prepare, /SOURCE_URL\s*=\s*LIBREOFFICE_CONTRACT\.sourceUrl/)
  })

  it('finds the prepared private runtime in an unpackaged development checkout', () => {
    const composition = read(
      'src/main/xiaogui/work-document-review-renderer-composition.ts',
    )
    assert.match(
      composition,
      /join\(\s*app\.getAppPath\(\),\s*'resources',\s*'libreoffice-runtime',\s*'runtime',\s*'program',\s*executable,?\s*\)/,
    )
  })
})
