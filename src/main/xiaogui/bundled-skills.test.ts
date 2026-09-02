import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveBundledPiSkillsPath } from './bundled-skills'

describe('bundled Pi Skills', () => {
  it('resolves the source resource directory in development, including out/main app paths', () => {
    const appRoot = join('D:', 'repo', 'pi-app')

    expect(resolveBundledPiSkillsPath({
      appPath: appRoot,
      resourcesPath: join('D:', 'electron', 'resources'),
      isPackaged: false,
    })).toBe(join(appRoot, 'resources', 'pi-skills'))

    expect(resolveBundledPiSkillsPath({
      appPath: join(appRoot, 'out', 'main'),
      resourcesPath: join('D:', 'electron', 'resources'),
      isPackaged: false,
    })).toBe(join(appRoot, 'resources', 'pi-skills'))
  })

  it('resolves the electron-builder extraResource directory after packaging', () => {
    const resourcesPath = join('C:', 'Program Files', '小规 Agent', 'resources')
    expect(resolveBundledPiSkillsPath({
      appPath: join(resourcesPath, 'app.asar'),
      resourcesPath,
      isPackaged: true,
    })).toBe(join(resourcesPath, 'pi-skills'))
  })

  it('packages the curated Skill directory as an Electron extraResource', () => {
    const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(builder).toContain('from: resources/pi-skills')
    expect(builder).toContain('to: pi-skills')
  })
})
