import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

describe('Windows tray icon packaging contract', () => {
  it('generates the icon before every package path and ships the runtime ICO location', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const exporterPath = join(root, 'scripts', 'export-app-icon.mjs')
    const desktopPackager = readFileSync(join(root, 'scripts', 'package-desktop.mjs'), 'utf8')
    const windowsPackager = readFileSync(join(root, 'scripts', 'package-windows.mjs'), 'utf8')

    assert.ok(existsSync(join(root, 'resources', 'icon.svg')), 'icon source SVG must be committed')
    assert.ok(existsSync(exporterPath), 'icon exporter script must be committed')

    const exporter = readFileSync(exporterPath, 'utf8')
    assert.match(
      exporter,
      /const\s+outIco\s*=\s*join\(outDir,\s*['"]icon\.ico['"]\)/,
      'exporter must target build/icon.ico',
    )
    assert.match(
      exporter,
      /const\s+icoSizes\s*=\s*\[16,\s*20,\s*24,\s*32,\s*48,\s*64,\s*128,\s*256\]/,
      'exporter must preserve the approved multi-size Windows icon set',
    )
    assert.match(
      exporter,
      /size\s*>=\s*128[\s\S]*c3Dir[\s\S]*coreDir/,
      'exporter must use the core icon through 64px and C3 only at 128px or larger',
    )
    assert.match(
      exporter,
      /writeFile\(outIco,\s*encodePngIco\(entries\)\)/,
      'exporter must write the generated multi-size ICO bytes',
    )
    assert.match(
      pkg.scripts['icon:export'],
      /node scripts\/export-app-icon\.mjs/,
      'icon:export must run the exporter',
    )
    assert.match(pkg.scripts.package, /node scripts\/package-desktop\.mjs/)
    assert.match(pkg.scripts['package:win'], /node scripts\/package-windows\.mjs/)
    assert.match(
      desktopPackager,
      /export-app-icon\.mjs[\s\S]*electron-builder\/cli\.js/,
      'generic package wrapper must generate app icons before electron-builder',
    )
    assert.match(
      windowsPackager,
      /export-app-icon\.mjs[\s\S]*electron-builder\/cli\.js/,
      'Windows package wrapper must generate app icons before electron-builder',
    )
    assert.match(builder, /from:\s*build\/icon\.ico[\s\S]*to:\s*resources\/build\/icon\.ico/)
  })
})
