import { test, expect } from '@playwright/test'
import { launchApp, expectXiaoguiTitle } from './helpers'

test.describe('composer', () => {
  test('input area is focusable when present', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      const textarea = window.locator('textarea, [contenteditable="true"]').first()
      const count = await textarea.count()
      if (count > 0) {
        await textarea.focus()
        expect(await textarea.evaluate((el) => document.activeElement === el)).toBeTruthy()
      } else {
        expect(await window.title()).toBeTruthy()
      }
    } finally {
      await app.close()
    }
  })

  test('window title shows 小规 Agent brand', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await expectXiaoguiTitle(window)
    } finally {
      await app.close()
    }
  })

  test('body element exists in renderer', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      expect(await window.locator('body').count()).toBe(1)
    } finally {
      await app.close()
    }
  })
})
