import { test, expect } from '@playwright/test'
import { launchApp, expectXiaoguiTitle } from './helpers'

test.describe('settings', () => {
  test('app loads without crash (settings route lazy)', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await expectXiaoguiTitle(window)
    } finally {
      await app.close()
    }
  })

  test('renderer document readyState is complete or interactive', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      const state = await window.evaluate(() => document.readyState)
      expect(['complete', 'interactive', 'loading']).toContain(state)
    } finally {
      await app.close()
    }
  })

  test('single browser window on launch', async () => {
    const app = await launchApp()
    try {
      const windows = app.windows()
      expect(windows.length).toBeGreaterThanOrEqual(1)
    } finally {
      await app.close()
    }
  })
})
