import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchApp } from './helpers'

/**
 * UI-M3A-01 协作计划最小前端真实 Electron 场景：
 * WORK 建稿并批准、刷新后审批恢复、CODING 只读任务、DESIGN reserved、
 * 切换会话不串投影、取消 Flow。
 * 会话 fixture 与 canonical scope 建立方式复用 m1-canonical-scope.spec.ts 的做法。
 */

type PiDesktopWindow = Window & {
  piDesktop: { invoke(channel: string, request?: unknown): Promise<unknown> }
}

async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  return page.evaluate(
    async ({ ipcChannel, ipcRequest }) => (window as PiDesktopWindow).piDesktop.invoke(ipcChannel, ipcRequest) as Promise<T>,
    { ipcChannel: channel, ipcRequest: request },
  )
}

function writeSessionFixture(sessionDir: string, workspace: string, id: string, title: string, minute: number) {
  const timestamp = new Date(Date.UTC(2026, 7, 16, 12, minute, 0)).toISOString()
  const file = join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd: workspace },
    {
      type: 'message',
      id: id.slice(0, 8),
      parentId: null,
      timestamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: title }],
        timestamp: Date.parse(timestamp),
      },
    },
  ]
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return { id, file, title }
}

async function openSessionAndPanel(page: Page, title: string) {
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click()
  await page.getByRole('button', { name: '协作计划', exact: true }).click()
  await expect(page.getByTestId('collaboration-hub-panel')).toBeVisible()
  const activeTab = page.getByRole('tab', { name: '协作', exact: true })
  await expect(activeTab).toHaveAttribute('aria-selected', 'true')
  await expect(activeTab).toBeInViewport()
}

test.describe('协作计划 M2A 真实 Electron 场景', () => {
  test('WORK 建稿/刷新后审批/取消，CODING 只读，DESIGN reserved，切换不串投影', async ({}, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-m3a-electron-'))
    const userDataDir = join(root, 'user-data')
    const agentDir = join(root, 'agent')
    const workspace = join(root, '协作项目')
    const encodedWorkspace = `--${workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    const sessionDir = join(agentDir, 'sessions', encodedWorkspace)
    for (const dir of [userDataDir, agentDir, sessionDir, workspace]) mkdirSync(dir, { recursive: true })

    const work = writeSessionFixture(sessionDir, workspace, 'aaaaaaaa-1111-4111-8111-111111111111', 'WORK 协作会话', 1)
    const coding = writeSessionFixture(sessionDir, workspace, 'bbbbbbbb-2222-4222-8222-222222222222', 'CODING 协作会话', 2)
    const design = writeSessionFixture(sessionDir, workspace, 'cccccccc-3333-4333-8333-333333333333', 'DESIGN 协作会话', 3)

    const app = await launchApp({ PI_CODING_AGENT_DIR: agentDir }, [`--user-data-dir=${userDataDir}`])

    try {
      const page = await app.firstWindow({ timeout: 45_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 45_000 })

      await invoke(page, 'ipc:workspace.open', {
        path: workspace,
        awaitWorker: false,
      })
      await invoke(page, 'ipc:xiaogui.scope.set', {
        kind: 'session',
        key: work.file,
        mode: 'WORK',
      })
      await invoke(page, 'ipc:xiaogui.scope.set', {
        kind: 'session',
        key: coding.file,
        mode: 'CODING',
      })
      await invoke(page, 'ipc:xiaogui.scope.set', {
        kind: 'session',
        key: design.file,
        mode: 'DESIGN',
      })
      await invoke(page, 'ipc:settings.set', {
        key: 'recentProjects',
        value: [workspace],
      })
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('pi-desktop:settings-changed', {
            detail: { key: 'recentProjects' },
          }),
        ),
      )
      const projectButton = page.locator('.sidebar-project-hit').filter({ hasText: '协作项目' })
      await expect(projectButton).toHaveCount(1)
      await projectButton.click()

      // ── 1. WORK 建稿 ──────────────────────────────────────────────
      await openSessionAndPanel(page, work.title)
      await page.getByLabel('协作计划目标').fill('完成季度总结')
      await page.getByLabel('任务 1 标识').fill('collect')
      await page.getByLabel('任务 1 标题').fill('收集数据')
      await page.getByRole('button', { name: '+ 添加任务' }).click()
      await page.getByLabel('任务 2 标识').fill('write')
      await page.getByLabel('任务 2 标题').fill('撰写报告')
      await page.getByLabel('任务 2 依赖').fill('collect')
      await page.getByRole('button', { name: '建立草稿' }).click()
      const awaiting = page.getByTestId('hub-awaiting-approval')
      await expect(awaiting).toBeVisible()
      await expect(awaiting).toContainText('完成季度总结')
      await expect(awaiting).toContainText('收集数据')

      // ── 2. 刷新后审批恢复（重载窗口后从 M2A 投影继续） ────────────
      await page.reload()
      await page.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      // 重载后应用回到项目首页；通过已持久化的 recentProjects 重新进入同一项目。
      const projectAfterReload = page.locator('.sidebar-project-hit').filter({ hasText: '协作项目' })
      await expect(projectAfterReload).toHaveCount(1)
      await projectAfterReload.click()
      await openSessionAndPanel(page, work.title)
      const awaitingAfterReload = page.getByTestId('hub-awaiting-approval')
      await expect(awaitingAfterReload).toBeVisible({ timeout: 30_000 })
      await expect(awaitingAfterReload).toContainText('撰写报告')
      await page.getByRole('button', { name: '批准计划' }).click()
      const active = page.getByTestId('hub-active-plan')
      await expect(active).toBeVisible()
      await expect(active).toContainText('PENDING_DISABLED')
      await expect(active).toContainText('执行能力将在后续 CODING Adapter 接入')

      // ── 3. 切换会话不串投影：CODING 会话无活动 Flow ──────────────
      await openSessionAndPanel(page, coding.title)
      await expect(page.getByTestId('hub-draft-form')).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByTestId('hub-active-plan')).toHaveCount(0)
      await expect(page.getByTestId('hub-awaiting-approval')).toHaveCount(0)

      // ── 4. CODING 建稿并批准 → 只读任务视图 ──────────────────────
      await page.getByLabel('协作计划目标').fill('修复登录缺陷')
      await page.getByLabel('任务 1 标识').fill('fix')
      await page.getByLabel('任务 1 标题').fill('定位并修复')
      await page.getByRole('button', { name: '建立草稿' }).click()
      await page.getByRole('button', { name: '批准计划' }).click()
      const codingActive = page.getByTestId('hub-active-plan')
      await expect(codingActive).toBeVisible()
      await expect(codingActive).toContainText('定位并修复')
      await expect(codingActive).toContainText('PENDING_DISABLED')
      await expect(codingActive).not.toContainText('运行中')
      await expect(codingActive).not.toContainText('已完成')

      // ── 5. DESIGN reserved：无任何动作按钮 ───────────────────────
      await openSessionAndPanel(page, design.title)
      await expect(page.getByTestId('hub-design-reserved')).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByRole('button', { name: '建立草稿' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '批准计划' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '取消协作计划' })).toHaveCount(0)

      // ── 6. 回到 WORK 会话取消 Flow ───────────────────────────────
      await openSessionAndPanel(page, work.title)
      await expect(page.getByTestId('hub-active-plan')).toBeVisible({
        timeout: 30_000,
      })
      await page.getByRole('button', { name: '取消协作计划' }).click()
      await page.getByLabel('取消原因').fill('需求变更，暂停协作')
      await page.getByRole('button', { name: '确认取消' }).click()
      await expect(page.getByTestId('hub-draft-form')).toBeVisible()
      await expect(page.getByText('已取消').first()).toBeVisible()

      const evidenceDir = process.env.M3A_E2E_EVIDENCE_DIR || testInfo.outputDir
      mkdirSync(evidenceDir, { recursive: true })
      await page.screenshot({
        path: join(evidenceDir, 'ui-m3a-collaboration.png'),
        fullPage: true,
      })
    } finally {
      await app.close()
    }
  })
})
