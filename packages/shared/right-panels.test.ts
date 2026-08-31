import { describe, expect, it } from 'vitest'
import {
  CORE_RIGHT_PANEL_CATALOG,
  defaultCoreRightPanelPrefs,
  firstEnabledPanel,
  normalizeRightPanelPrefs,
} from './right-panels'

describe('defaultCoreRightPanelPrefs', () => {
  it('enables files, run, collaboration and template library by default', () => {
    const prefs = defaultCoreRightPanelPrefs()
    expect(prefs.files).toBe(true)
    expect(prefs.run).toBe(true)
    expect(prefs.review).toBe(false)
    expect(prefs.context).toBe(false)
    expect(prefs.tree).toBe(false)
    expect(prefs.collaboration).toBe(true)
    expect(prefs['template-library']).toBe(true)
  })
})

describe('CORE_RIGHT_PANEL_CATALOG core icons', () => {
  it('uses the expected icons for tree, review and template library', () => {
    const tree = CORE_RIGHT_PANEL_CATALOG.find((item) => item.id === 'tree')
    const review = CORE_RIGHT_PANEL_CATALOG.find((item) => item.id === 'review')
    const templateLibrary = CORE_RIGHT_PANEL_CATALOG.find((item) => item.id === 'template-library')
    expect(tree?.icon).toBe('ListTree')
    expect(review?.icon).toBe('GitBranch')
    expect(templateLibrary).toMatchObject({
      fallbackLabel: '模板库',
      icon: 'BookOpen',
      source: 'core',
    })
  })
})

describe('normalizeRightPanelPrefs', () => {
  it('falls back to files+run when all panels disabled', () => {
    const prefs = normalizeRightPanelPrefs(
      {
        review: false,
        run: false,
        context: false,
        tree: false,
        files: false,
        collaboration: false,
        'template-library': false,
      },
      CORE_RIGHT_PANEL_CATALOG,
    )
    expect(prefs.files).toBe(true)
    expect(prefs.run).toBe(true)
  })

  it('migrates existing preferences without a collaboration key to the new default', () => {
    const prefs = normalizeRightPanelPrefs(
      { review: false, run: true, context: false, tree: false, files: true },
      CORE_RIGHT_PANEL_CATALOG,
    )
    expect(prefs.collaboration).toBe(true)
  })

  it('firstEnabledPanel prefers enabled core panels', () => {
    const prefs = defaultCoreRightPanelPrefs()
    expect(firstEnabledPanel(prefs, CORE_RIGHT_PANEL_CATALOG)).toBe('run')
  })
})
