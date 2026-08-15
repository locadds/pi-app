import { test, expect } from '@playwright/test'
import { launchApp, expectXiaoguiTitle } from './helpers'

test.describe('小规 Agent smoke', () => {
  test('launches built app and shows window', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await expectXiaoguiTitle(window)
    } finally {
      await app.close()
    }
  })

  test('window has document root after load', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      const root = await window.evaluate(() => !!document.documentElement)
      expect(root).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('launches with sandbox disabled via PI_RENDERER_SANDBOX=0', async () => {
    const app = await launchApp({ PI_RENDERER_SANDBOX: '0' })
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      expect(await window.title()).toBeTruthy()
    } finally {
      await app.close()
    }
  })
})
