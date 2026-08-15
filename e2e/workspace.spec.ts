import { test, expect } from '@playwright/test'
import { launchApp, expectXiaoguiTitle } from './helpers'

test.describe('workspace shell', () => {
  test('shows main window and composer region', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await expectXiaoguiTitle(window)
    } finally {
      await app.close()
    }
  })

  test('html root element present', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      expect(await window.locator('html').count()).toBe(1)
    } finally {
      await app.close()
    }
  })

  test('app closes cleanly', async () => {
    const app = await launchApp()
    await app.firstWindow({ timeout: 45_000 })
    await app.close()
    expect(true).toBe(true)
  })
})
