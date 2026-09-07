import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => join('D:', 'workspace', 'pi-app')) },
}))

import { resolveMainWindowPreload, resolveMainWindowRenderer, resolveUtilityEntry } from '../utility-entry-path'

describe('resolveUtilityEntry', () => {
  it('resolves the production renderer independently of main chunk locations', () => {
    const appPath = join('D:', 'workspace', 'pi-app')
    for (const root of [appPath, join(appPath, 'out', 'main')]) {
      expect(resolveMainWindowRenderer(root)).toBe(join(appPath, 'out', 'renderer', 'index.html'))
    }
    const asar = join('D:', 'installed', 'resources', 'app.asar')
    expect(resolveMainWindowRenderer(asar)).toBe(join(asar, 'out', 'renderer', 'index.html'))
  })
  it('should_not_duplicate_out_main_when_electron_returns_the_built_main_directory', () => {
    const builtMain = join('D:', 'workspace', 'pi-app', 'out', 'main')

    expect(resolveUtilityEntry('worker.mjs', builtMain)).toBe(join(builtMain, 'worker.mjs'))
    expect(resolveUtilityEntry('worker.mjs', builtMain)).not.toContain(
      join('out', 'main', 'out', 'main'),
    )
  })

  it('should_resolve_worker_and_preview_from_the_app_root_when_callers_are_split_into_chunks', () => {
    const appPath = join('D:', 'workspace', 'pi-app')

    expect(resolveUtilityEntry('worker.mjs', appPath)).toBe(
      join(appPath, 'out', 'main', 'worker.mjs'),
    )
    expect(resolveUtilityEntry('preview.mjs', appPath)).toBe(
      join(appPath, 'out', 'main', 'preview.mjs'),
    )
    expect(resolveUtilityEntry('preview-wsl.mjs', appPath)).toBe(
      join(appPath, 'out', 'main', 'preview-wsl.mjs'),
    )
    expect(resolveUtilityEntry('worker.mjs', appPath)).not.toContain(
      join('out', 'main', 'chunks', 'worker.mjs'),
    )
  })

  it('should_resolve_the_main_window_preload_from_the_app_root_instead_of_a_split_chunk', () => {
    const appPath = join('D:', 'workspace', 'pi-app')
    const builtMain = join(appPath, 'out', 'main')

    expect(resolveMainWindowPreload(appPath)).toBe(
      join(appPath, 'out', 'preload', 'index.cjs'),
    )
    expect(resolveMainWindowPreload(builtMain)).toBe(
      join(appPath, 'out', 'preload', 'index.cjs'),
    )
    expect(resolveMainWindowPreload(appPath)).not.toContain(
      join('out', 'main', 'preload', 'index.cjs'),
    )
  })
})
