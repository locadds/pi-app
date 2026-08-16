import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { launchApp } from './helpers'

type PiDesktopWindow = Window & {
  piDesktop: {
    invoke(channel: string, request?: unknown): Promise<unknown>
  }
}

type SessionFixture = {
  id: string
  entryId: string
  title: string
  mode: 'WORK' | 'DESIGN' | 'CODING'
  file: string
}

async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  return page.evaluate(
    async ({ ipcChannel, ipcRequest }) =>
      (window as PiDesktopWindow).piDesktop.invoke(ipcChannel, ipcRequest) as Promise<T>,
    { ipcChannel: channel, ipcRequest: request },
  )
}

function writeSessionFixture(
  sessionDir: string,
  workspace: string,
  fixture: Omit<SessionFixture, 'file'>,
  minute: number,
): SessionFixture {
  const timestamp = new Date(Date.UTC(2026, 7, 16, 12, minute, 0)).toISOString()
  const messageTimestamp = Date.parse(timestamp)
  const file = join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${fixture.id}.jsonl`)
  const entries = [
    {
      type: 'session',
      version: 3,
      id: fixture.id,
      timestamp,
      cwd: workspace,
    },
    {
      type: 'message',
      id: fixture.entryId,
      parentId: null,
      timestamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: fixture.title }],
        timestamp: messageTimestamp,
      },
    },
    {
      type: 'message',
      id: `${fixture.entryId.slice(0, 7)}a`,
      parentId: fixture.entryId,
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'fixture ready' }],
        api: 'openai-responses',
        provider: 'fixture',
        model: 'fixture',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: messageTimestamp,
      },
    },
    {
      type: 'session_info',
      id: `${fixture.entryId.slice(0, 7)}f`,
      parentId: `${fixture.entryId.slice(0, 7)}a`,
      timestamp,
      name: fixture.title,
    },
  ]
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return { ...fixture, file }
}

async function replaceScopeLookup(
  app: ElectronApplication,
  result: { kind: 'NOT_FOUND' | 'PROJECT_MISMATCH' },
): Promise<void> {
  await app.evaluate(({ ipcMain }, lookupResult) => {
    ipcMain.removeHandler('ipc:xiaogui.scope.lookup')
    ipcMain.handle('ipc:xiaogui.scope.lookup', async () => lookupResult)
  }, result)
}

test.describe('M1 规范会话作用域真实 Electron 门禁', () => {
  test('项目只显示一次，三模式分组，跨模式打开且 lookup 失败保持原状态', async ({}, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-m1-electron-'))
    const userDataDir = join(root, 'user-data')
    const agentDir = join(root, 'agent')
    const workspace = join(root, '共享项目')
    const resolvedWorkspace = resolve(workspace)
    const encodedWorkspace = `--${resolvedWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    const sessionDir = join(agentDir, 'sessions', encodedWorkspace)
    for (const dir of [userDataDir, agentDir, sessionDir, workspace]) mkdirSync(dir, { recursive: true })

    const fixtures = [
      writeSessionFixture(
        sessionDir,
        workspace,
        {
          id: '11111111-1111-4111-8111-111111111111',
          entryId: '11111111',
          title: 'WORK 工作会话',
          mode: 'WORK',
        },
        1,
      ),
      writeSessionFixture(
        sessionDir,
        workspace,
        {
          id: '22222222-2222-4222-8222-222222222222',
          entryId: '22222222',
          title: 'DESIGN 规划设计会话',
          mode: 'DESIGN',
        },
        2,
      ),
      writeSessionFixture(
        sessionDir,
        workspace,
        {
          id: '33333333-3333-4333-8333-333333333333',
          entryId: '33333333',
          title: 'CODING 编程会话',
          mode: 'CODING',
        },
        3,
      ),
    ] satisfies SessionFixture[]

    const app = await launchApp(
      {
        PI_CODING_AGENT_DIR: agentDir,
      },
      [`--user-data-dir=${userDataDir}`],
    )

    try {
      const page = await app.firstWindow({ timeout: 45_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 45_000 })

      await invoke(page, 'ipc:workspace.open', {
        path: workspace,
        awaitWorker: false,
      })
      for (const fixture of fixtures) {
        await invoke(page, 'ipc:xiaogui.scope.set', {
          kind: 'session',
          key: fixture.file,
          mode: fixture.mode,
        })
      }

      const listed = await invoke<{
        sessions: Array<{
          sessionId: string
          sessionFile: string
          canonicalScope: {
            projectId: string
            sessionKey: string
            sessionMode: string
          }
        }>
      }>(page, 'ipc:session.list', { workspaceId: workspace, refresh: true })
      expect(listed.sessions).toHaveLength(3)
      expect(listed.sessions.map((session) => session.canonicalScope.sessionMode).sort()).toEqual([
        'CODING',
        'DESIGN',
        'WORK',
      ])

      const alternateDriveCase = `${workspace[0]?.toLowerCase()}${workspace.slice(1)}`
      await invoke(page, 'ipc:settings.set', {
        key: 'recentProjects',
        value: [workspace, alternateDriveCase],
      })
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('pi-desktop:settings-changed', {
            detail: { key: 'recentProjects' },
          }),
        ),
      )

      const projectName = basename(workspace)
      const projectButton = page.locator('.sidebar-project-hit').filter({ hasText: projectName })
      await expect(projectButton).toHaveCount(1)
      await projectButton.click()

      for (const label of ['工作', '规划设计', '编程']) {
        await expect(page.locator('.sidebar-session-tree').getByText(label, { exact: true })).toHaveCount(1)
      }
      for (const fixture of fixtures) {
        await expect(page.getByRole('button', { name: new RegExp(fixture.title) })).toHaveCount(1)
      }

      const modeTabs = page.getByRole('tablist', { name: '一级工作模式' })
      await expect(modeTabs.getByRole('tab', { name: /WORK 工作/ })).toHaveAttribute('aria-selected', 'true')

      await page.getByRole('button', { name: /DESIGN 规划设计会话/ }).click()
      await expect(modeTabs.getByRole('tab', { name: /DESIGN 规划设计/ })).toHaveAttribute('aria-selected', 'true')

      await page.getByRole('button', { name: /CODING 编程会话/ }).click()
      await expect(modeTabs.getByRole('tab', { name: /CODING 编程/ })).toHaveAttribute('aria-selected', 'true')

      const designSession = listed.sessions.find((session) => session.canonicalScope.sessionMode === 'DESIGN')
      expect(designSession).toBeDefined()
      const clone = await invoke<{
        error?: string
        session: {
          sessionFile?: string
          canonicalScope?: {
            projectId: string
            sessionKey: string
            sessionMode: string
          }
        }
      }>(page, 'ipc:session.clone', {
        sessionId: designSession!.sessionId,
        sessionFile: designSession!.sessionFile,
        workspaceId: workspace,
        title: 'DESIGN 克隆会话',
      })
      expect(clone.error).toBeUndefined()
      expect(clone.session.canonicalScope?.sessionMode).toBe('DESIGN')
      expect(clone.session.canonicalScope?.sessionKey).not.toBe(designSession!.canonicalScope.sessionKey)

      const designFixture = fixtures.find((fixture) => fixture.mode === 'DESIGN')!
      const fork = await invoke<{
        error?: string
        session: {
          sessionFile?: string
          canonicalScope?: {
            projectId: string
            sessionKey: string
            sessionMode: string
          }
        }
      }>(page, 'ipc:session.fork', {
        sessionId: designSession!.sessionId,
        sessionFile: designSession!.sessionFile,
        entryId: designFixture.entryId,
        position: 'at',
        workspaceId: workspace,
        title: 'DESIGN 派生会话',
      })
      expect(fork.error).toBeUndefined()
      expect(fork.session.canonicalScope?.sessionMode).toBe('DESIGN')
      expect(fork.session.canonicalScope?.sessionKey).not.toBe(designSession!.canonicalScope.sessionKey)

      await modeTabs.getByRole('tab', { name: /WORK 工作/ }).click()
      await expect(modeTabs.getByRole('tab', { name: /WORK 工作/ })).toHaveAttribute('aria-selected', 'true')

      const failureLogs: string[] = []
      page.on('console', (message) => failureLogs.push(message.text()))

      await replaceScopeLookup(app, { kind: 'NOT_FOUND' })
      await page
        .getByRole('button', { name: /DESIGN 规划设计会话/ })
        .first()
        .click()
      await expect(modeTabs.getByRole('tab', { name: /WORK 工作/ })).toHaveAttribute('aria-selected', 'true')
      await expect
        .poll(() => failureLogs.some((message) => message.includes('canonical_session_scope_not_found')))
        .toBe(true)

      await replaceScopeLookup(app, { kind: 'PROJECT_MISMATCH' })
      await page.getByRole('button', { name: /CODING 编程会话/ }).click()
      await expect(modeTabs.getByRole('tab', { name: /WORK 工作/ })).toHaveAttribute('aria-selected', 'true')
      await expect
        .poll(() => failureLogs.some((message) => message.includes('canonical_session_scope_project_mismatch')))
        .toBe(true)

      expect(failureLogs.join('\n')).not.toContain(workspace)
      expect(failureLogs.join('\n')).not.toContain(sessionDir)

      const evidenceDir = process.env.M1_E2E_EVIDENCE_DIR || testInfo.outputDir
      mkdirSync(evidenceDir, { recursive: true })
      await page.screenshot({
        path: join(evidenceDir, 'm1-canonical-scope.png'),
        fullPage: true,
      })
    } finally {
      await app.close()
    }
  })
})
