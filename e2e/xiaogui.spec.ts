import { test, expect } from '@playwright/test'
import { launchApp, expectXiaoguiTitle } from './helpers'

/**
 * 小规真实窗口门禁（UI-M0-02）：
 * - 品牌标题为“小规 Agent”；
 * - 一级模式入口 WORK 工作 / DESIGN 规划设计 / CODING 编程 在真实渲染窗口中可见；
 * - 执行方式（ASK/PLAN/EXECUTE）控件不出现在主界面。
 *
 * 断言全部基于 Electron 渲染窗口的可访问角色/名称，不读取源码字符串；
 * 执行方式断言限定 role=tablist/tab 的控件语义边界，避免误判聊天正文词汇。
 */
test.describe('小规 Agent 真实窗口门禁', () => {
  test('窗口标题为小规 Agent 品牌', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await expectXiaoguiTitle(window)
    } finally {
      await app.close()
    }
  })

  test('一级模式 tablist 呈现 WORK/DESIGN/CODING 三入口', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })

      const tablist = window.getByRole('tablist', { name: '一级工作模式' })
      await expect(tablist).toBeVisible()

      for (const name of [/WORK 工作/, /DESIGN 规划设计/, /CODING 编程/]) {
        const tab = tablist.getByRole('tab', { name })
        await expect(tab).toHaveCount(1)
        await expect(tab).toBeVisible()
      }
    } finally {
      await app.close()
    }
  })

  test('执行方式控件（ASK/PLAN/EXECUTE）不出现在主界面', async () => {
    const app = await launchApp()
    try {
      const window = await app.firstWindow({ timeout: 45_000 })
      await window.waitForLoadState('domcontentloaded', { timeout: 45_000 })

      // 等一级模式 tablist 出现，确保主界面已渲染完成再做“不存在”断言
      await expect(window.getByRole('tablist', { name: '一级工作模式' })).toBeVisible()

      await expect(window.getByRole('tablist', { name: '执行方式' })).toHaveCount(0)
      await expect(
        window.getByRole('tab', { name: /ASK 问答|PLAN 规划|EXECUTE 工作/ })
      ).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})
