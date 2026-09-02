import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

type PiDesktopWindow = Window & {
  piDesktop: { invoke(channel: string, request?: unknown): Promise<unknown> }
}

interface TaskRunView {
  taskRunId: string
  taskKey: string
  status: string
  attemptId?: string
}

interface AttemptView {
  attemptId: string
  taskRunId: string
  status: string
  verificationSummary?: { state: string; taskChangeSetId?: string }
}

interface HubProjectionView {
  activeFlow?: { flowId: string }
  taskRuns: TaskRunView[]
  attempts: AttemptView[]
  executionReadiness?: {
    readyTaskRunIds: string[]
    dependencyStates: Array<{ taskRunId: string; state: string; dependencyTaskRunIds: string[] }>
  }
  activeDelivery?: {
    batchId: string
    state: string
    selectedTaskRunIds: string[]
    taskChangeSetIds: string[]
    fileChangeSummaries?: Array<{ relativePath: string; operation: string }>
    gate?: {
      gateId: string
      state: string
      subject: { deliveryChangeSetId: string; version: 1; digest: string }
    }
  }
}

interface PiE2eEvent {
  event: string
  details: Record<string, unknown>
}

const TEMP_ROOT = 'D:\\CodexTemp\\xiaogui-hub-m4g-real-journey-v1'
const RUNS_ROOT = join(TEMP_ROOT, 'runs')
const EVIDENCE_ROOT = join(TEMP_ROOT, 'evidence')
const A_PATH = 'README.md'
const B_PATH = 'src/b.ts'
const C_PATH = 'tsconfig.web.json'
const README_CONTENT = '# Disposable three-task project\n'
const A_CONTENT = '研究角色已形成只读证据。\n'
const B_CONTENT = 'export const beta = "B-verified";\n'
const C_CONTENT = '审阅角色已形成只读证据。\n'
const SESSION_ID = '77777777-7777-4777-8777-777777777777'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron') as string

function focusedElectronEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {
    PI_E2E: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    ...extra,
  }
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  return environment
}

async function launchFocusedApp(extraEnv: Record<string, string>, extraArgs: readonly string[]): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronExecutable,
    args: [join(process.cwd(), 'out', 'main', 'index.js'), ...extraArgs],
    env: focusedElectronEnvironment(extraEnv),
    timeout: 60_000,
  })
}

async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  return page.evaluate(
    async ({ ipcChannel, ipcRequest }) =>
      (window as PiDesktopWindow).piDesktop.invoke(ipcChannel, ipcRequest) as Promise<T>,
    { ipcChannel: channel, ipcRequest: request },
  )
}

function encodedSessionDirectory(agentDir: string, workspace: string): string {
  const resolvedWorkspace = resolve(workspace)
  return join(agentDir, 'sessions', `--${resolvedWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
}

function writeSessionFixture(sessionDir: string, workspace: string) {
  const id = SESSION_ID
  const timestamp = '2026-08-28T02:00:00.000Z'
  const file = join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd: workspace },
    {
      type: 'message',
      id: 'journey-user',
      parentId: null,
      timestamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '三任务真实交付旅程' }],
        timestamp: Date.parse(timestamp),
      },
    },
    {
      type: 'message',
      id: 'journey-assistant',
      parentId: 'journey-user',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'fixture ready' }],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.parse(timestamp),
      },
    },
    { type: 'session_info', id: 'journey-info', parentId: 'journey-assistant', timestamp, name: '三任务真实交付旅程' },
  ]
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return { file, title: '三任务真实交付旅程' }
}

function writeAgentModelFixture(agentDir: string): void {
  writeFileSync(join(agentDir, 'models.json'), `${JSON.stringify({
    providers: {
      fixture: {
        name: 'Local E2E fixture',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'not-a-secret-e2e-fixture',
        models: [{
          id: 'fixture-model',
          name: 'Fixture model',
          contextWindow: 8192,
          maxTokens: 2048,
        }],
      },
    },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(agentDir, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'fixture-model',
  }, null, 2)}\n`, 'utf8')
}

function attemptWorktreeRoot(userDataDir: string, attemptId: string): string {
  const db = new DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-workspaces.sqlite'), {
    readOnly: true,
  })
  try {
    const row = db.prepare(
      'select lease_json from attempt_workspace_leases where attempt_id = ? limit 1',
    ).get(attemptId) as { lease_json: string } | undefined
    if (!row) throw new Error('missing Attempt worktree lease')
    const lease = JSON.parse(row.lease_json) as { worktreeRoot?: unknown }
    if (typeof lease.worktreeRoot !== 'string' || !lease.worktreeRoot) {
      throw new Error('invalid Attempt worktree lease')
    }
    return lease.worktreeRoot
  } finally {
    db.close()
  }
}

async function git(cwd: string, args: readonly string[], allowFailure = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolvePromise((stdout ?? '').trim())
    })
  })
}

async function initProjectRepository(projectRoot: string): Promise<{ baseRevision: string; baselineTree: string }> {
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  symlinkSync(realpathSync(join(process.cwd(), 'node_modules')), join(projectRoot, 'node_modules'), 'junction')
  await writeFile(join(projectRoot, 'README.md'), README_CONTENT, 'utf8')
  await writeFile(join(projectRoot, 'src', '.gitkeep'), '', 'utf8')
  await writeFile(join(projectRoot, 'src', 'baseline.ts'), 'export const baseline = true\n', 'utf8')
  await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n', 'utf8')
  await writeFile(join(projectRoot, 'tsconfig.web.json'), `${JSON.stringify(minimalTsconfig(), null, 2)}\n`, 'utf8')
  await writeFile(join(projectRoot, 'tsconfig.node.json'), `${JSON.stringify(minimalTsconfig(), null, 2)}\n`, 'utf8')
  await git(projectRoot, ['init'])
  await git(projectRoot, ['config', 'user.email', 'xiaogui-e2e@example.invalid'])
  await git(projectRoot, ['config', 'user.name', 'Xiaogui E2E'])
  await git(projectRoot, ['config', 'core.autocrlf', 'false'])
  await git(projectRoot, ['add', 'README.md', 'src/.gitkeep', 'src/baseline.ts', '.gitignore', 'tsconfig.web.json', 'tsconfig.node.json'])
  await git(projectRoot, ['commit', '-m', 'disposable baseline'])
  return {
    baseRevision: await git(projectRoot, ['rev-parse', '--verify', 'HEAD']),
    baselineTree: await git(projectRoot, ['rev-parse', '--verify', 'HEAD^{tree}']),
  }
}

function minimalTsconfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  }
}

function writeRuntimeScenario(evidenceDir: string): { scenarioPath: string; eventLogPath: string } {
  const scenarioPath = join(evidenceDir, 'scripted-runtime-scenario.json')
  const eventLogPath = join(evidenceDir, 'journey-events.jsonl')
  const scenario = {
    version: 1,
    eventLog: 'journey-events.jsonl',
    tasks: [
      { label: 'A', role: 'RESEARCH', allowedPath: A_PATH, releaseFile: 'control/release-a', content: A_CONTENT },
      {
        label: 'B',
        role: 'IMPLEMENT',
        allowedPath: B_PATH,
        releaseFile: 'control/release-b',
        content: B_CONTENT,
        requires: [{ relativePath: A_PATH, content: README_CONTENT }],
      },
      {
        label: 'C',
        role: 'REVIEW',
        allowedPath: C_PATH,
        releaseFile: 'control/release-c',
        content: C_CONTENT,
        requires: [{ relativePath: B_PATH, content: B_CONTENT }],
      },
    ],
  }
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8')
  return { scenarioPath, eventLogPath }
}

async function openSessionAndHub(page: Page, workspaceName: string, title: string): Promise<void> {
  const projectButton = page.locator('.sidebar-project-hit').filter({ hasText: workspaceName })
  await expect(projectButton).toHaveCount(1)
  await projectButton.click()
  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  await page.getByRole('button', { name: '协作计划', exact: true }).click()
  await expect(page.getByTestId('collaboration-hub-panel')).toBeVisible()
}

async function observe(page: Page, address: HubAddressV1): Promise<HubProjectionView> {
  const outcome = await invoke<{ ok: boolean; value?: HubProjectionView }>(page, 'ipc:xiaogui.hub.observe', {
    contractVersion: 'm2b.v1',
    address,
  })
  if (!outcome.ok || !outcome.value) throw new Error('hub observe failed')
  return outcome.value
}

async function refreshHubUi(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '刷新协作计划', exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toBeEnabled()
}

async function approveAwaitingAttemptPlans(page: Page, expectedCount: number): Promise<void> {
  const buttons = page.getByRole('button', { name: '批准并开始执行', exact: true })
  await expect(buttons).toHaveCount(expectedCount, { timeout: 45_000 })
  for (let remaining = expectedCount; remaining > 0; remaining -= 1) {
    await buttons.first().click()
    await expect(buttons).toHaveCount(remaining - 1, { timeout: 45_000 })
  }
}

async function bindRole(
  page: Page,
  taskKey: string,
  profileId: 'xiaogui.role.research.default' | 'xiaogui.role.implement.default' | 'xiaogui.role.review.default',
  roleText: '研究' | '实现' | '审阅',
): Promise<void> {
  const taskCard = page.getByTestId(`hub-taskrun-status-${taskKey}`).locator('xpath=ancestor::li[1]')
  const roleCard = taskCard.getByLabel('执行角色')
  await roleCard.getByLabel('选择角色').selectOption(profileId)
  await roleCard.getByRole('button', { name: '使用此角色', exact: true }).click()
  await expect(roleCard.getByText(`当前角色：${roleText}`, { exact: true })).toBeVisible()
}

async function waitForTaskBadges(
  page: Page,
  expected: Record<string, string>,
  timeout = 30_000,
): Promise<void> {
  const refresh = page.getByRole('button', { name: '刷新协作计划', exact: true })
  await expect.poll(async () => {
    if (await refresh.isEnabled()) await refresh.click()
    return Object.fromEntries(await Promise.all(Object.keys(expected).map(async (taskKey) => [
      taskKey,
      (await page.getByTestId(`hub-taskrun-status-${taskKey}`).textContent())?.trim(),
    ])))
  }, { timeout }).toEqual(expected)
}

async function waitForProjection(
  page: Page,
  address: HubAddressV1,
  predicate: (projection: HubProjectionView) => boolean,
  timeoutMs = 75_000,
): Promise<HubProjectionView> {
  const deadline = Date.now() + timeoutMs
  let last: HubProjectionView | undefined
  while (Date.now() < deadline) {
    last = await observe(page, address)
    if (predicate(last)) {
      await refreshHubUi(page)
      return last
    }
    await page.waitForTimeout(300)
  }
  throw new Error(`projection timeout: ${JSON.stringify(last)}`)
}

async function configureExecutionTask(
  page: Page,
  taskRunId: string,
  title: string,
  relativePath: string,
  operation: 'MODIFY' | 'CREATE',
): Promise<void> {
  const card = page.getByTestId(`hub-execution-task-${taskRunId}`)
  await card.locator('input[type="checkbox"]').check()
  await page.getByLabel(`任务说明：${title}`).fill(`受控 Scripted Runtime 完成 ${title}`)
  const label = operation === 'MODIFY' ? `允许修改的已有文件：${title}` : `允许新建的文件：${title}`
  await page.getByLabel(label).fill(relativePath)
}

function readEvents(eventLogPath: string): PiE2eEvent[] {
  if (!existsSync(eventLogPath)) return []
  return writeSafeLines(readFileSyncUtf8(eventLogPath)).map((line) => JSON.parse(line) as PiE2eEvent)
}

async function waitForEvents(
  eventLogPath: string,
  predicate: (events: PiE2eEvent[]) => boolean,
  timeoutMs = 45_000,
): Promise<PiE2eEvent[]> {
  const deadline = Date.now() + timeoutMs
  let events: PiE2eEvent[] = []
  while (Date.now() < deadline) {
    events = readEvents(eventLogPath)
    if (predicate(events)) return events
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  throw new Error(`event timeout: ${JSON.stringify(events)}`)
}

function readFileSyncUtf8(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function writeSafeLines(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean)
}

async function projectFingerprint(projectRoot: string): Promise<string> {
  const tracked = await git(projectRoot, ['ls-files'])
  const status = await git(projectRoot, ['status', '--short', '--untracked-files=all'])
  const hash = createHash('sha256')
  for (const path of writeSafeLines(tracked).sort()) {
    hash.update(path)
    hash.update(await readFile(join(projectRoot, ...path.split('/'))))
  }
  hash.update(status)
  return hash.digest('hex')
}

function taskRunsByKey(projection: HubProjectionView): Map<string, TaskRunView> {
  return new Map(projection.taskRuns.map((run) => [run.taskKey, run]))
}

function readJourneyRows(userDataDir: string, projection: HubProjectionView) {
  const hubDb = new DatabaseSync(join(userDataDir, 'xiaogui-task-hub-m2a.sqlite'))
  const workspaceDb = new DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-workspaces.sqlite'))
  const roleDb = new DatabaseSync(join(userDataDir, 'xiaogui', 'coding-roles', 'role-profiles-v1.sqlite'))
  try {
    const attempts = hubDb.prepare('select attempt_id, task_run_id, status from attempts order by rowid').all() as Array<{
      attempt_id: string; task_run_id: string; status: string
    }>
    const manifests = workspaceDb.prepare('select attempt_id, manifest_json from attempt_file_manifests order by attempt_id').all() as Array<{
      attempt_id: string; manifest_json: string
    }>
    const leases = workspaceDb.prepare('select attempt_id, lease_json from attempt_workspace_leases order by attempt_id').all() as Array<{
      attempt_id: string; lease_json: string
    }>
    const deliveries = hubDb.prepare('select batch_id, state from delivery_batches order by rowid').all()
    const deliverySelections = hubDb.prepare(
      'select batch_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json from delivery_selection_drafts order by rowid',
    ).all()
    const applyAttempts = hubDb.prepare(
      'select apply_attempt_id, batch_id, state, changed_relative_paths_json from delivery_apply_attempts order by rowid',
    ).all()
    const applyOutboxes = hubDb.prepare(
      'select apply_attempt_id, status from delivery_apply_outbox order by rowid',
    ).all()
    const roleBindings = roleDb.prepare(
      'select attempt_id, profile_id, snapshot_digest, bound_at from xiaogui_coding_attempt_role_bindings_v1 order by attempt_id',
    ).all()
    return {
      projection,
      attempts,
      manifests,
      leases,
      deliveries,
      deliverySelections,
      applyAttempts,
      applyOutboxes,
      roleBindings,
    }
  } finally {
    hubDb.close()
    workspaceDb.close()
    roleDb.close()
  }
}

function publicJourneyEvidence(
  baseline: { baseRevision: string; baselineTree: string },
  rows: ReturnType<typeof readJourneyRows>,
  application: {
    initialFingerprint: string
    appliedFingerprint: string
    replayFingerprint: string
    files: readonly { relativePath: string; contentDigest: string }[]
  },
) {
  return {
    baseline,
    application: {
      initialFilesAbsent: [B_PATH],
      ...application,
    },
    projection: {
      taskRuns: rows.projection.taskRuns.map(({ taskRunId, taskKey, status }) => ({ taskRunId, taskKey, status })),
      attempts: rows.projection.attempts.map(({ taskRunId, status, verificationSummary }) => ({
        taskRunId,
        status,
        ...(verificationSummary
          ? { verification: { state: verificationSummary.state, taskChangeSetId: verificationSummary.taskChangeSetId } }
          : {}),
      })),
      executionReadiness: rows.projection.executionReadiness,
      activeDelivery: rows.projection.activeDelivery
        ? {
            state: rows.projection.activeDelivery.state,
            selectedTaskRunIds: rows.projection.activeDelivery.selectedTaskRunIds,
            taskChangeSetIds: rows.projection.activeDelivery.taskChangeSetIds,
            fileChangeSummaries: rows.projection.activeDelivery.fileChangeSummaries,
          }
        : null,
    },
    attempts: rows.attempts,
    manifests: rows.manifests.map((row) => {
      const manifest = JSON.parse(row.manifest_json) as { grants: unknown }
      return { attempt_id: row.attempt_id, grants: manifest.grants }
    }),
    leases: rows.leases.map((row) => {
      const lease = JSON.parse(row.lease_json) as { baseRevision: string; baselineTreeHash: string }
      return { attempt_id: row.attempt_id, baseRevision: lease.baseRevision, baselineTreeHash: lease.baselineTreeHash }
    }),
    deliveries: rows.deliveries,
    deliverySelections: rows.deliverySelections,
    applyAttempts: rows.applyAttempts,
    applyOutboxes: rows.applyOutboxes,
    roleBindings: rows.roleBindings,
  }
}

async function readApplyDiagnostic(userDataDir: string, projectRoot: string) {
  const hubDb = new DatabaseSync(join(userDataDir, 'xiaogui-task-hub-m2a.sqlite'), { readOnly: true })
  const applyRegistryPath = join(userDataDir, 'xiaogui', 'task-hub', 'delivery-apply-attempts.sqlite')
  const registryDb = existsSync(applyRegistryPath) ? new DatabaseSync(applyRegistryPath, { readOnly: true }) : undefined
  try {
    return {
      deliveries: hubDb.prepare('select state from delivery_batches order by rowid').all(),
      gates: hubDb.prepare('select state from delivery_human_gates order by rowid').all(),
      applyAttempts: hubDb.prepare('select state, changed_relative_paths_json from delivery_apply_attempts order by rowid').all(),
      applyOutboxes: hubDb.prepare('select status from delivery_apply_outbox order by rowid').all(),
      applyRegistry: registryDb
        ? registryDb.prepare('select status, written_relative_paths_json from delivery_apply_attempts order by rowid').all()
        : [],
      projectStatus: writeSafeLines(await git(projectRoot, ['status', '--short', '--untracked-files=all'])),
      files: [A_PATH, B_PATH, C_PATH].map((relativePath) => {
        const realPath = join(projectRoot, ...relativePath.split('/'))
        const present = existsSync(realPath)
        return {
          relativePath,
          present,
          ...(present ? { contentDigest: sha256(readFileSync(realPath)) } : {}),
        }
      }),
    }
  } finally {
    registryDb?.close()
    hubDb.close()
  }
}

async function removeManagedWorktrees(projectRoot: string, runRoot: string): Promise<string[]> {
  const output = await git(projectRoot, ['worktree', 'list', '--porcelain'])
  const paths = writeSafeLines(output)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))
  const removed: string[] = []
  for (const worktree of paths) {
    if (worktree === resolve(projectRoot)) continue
    const rel = relative(resolve(runRoot), worktree)
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
      throw new Error(`refusing to remove worktree outside disposable run root: ${worktree}`)
    }
    await git(projectRoot, ['worktree', 'remove', '--force', worktree])
    removed.push(worktree)
  }
  await git(projectRoot, ['worktree', 'prune'])
  const remaining = await git(projectRoot, ['worktree', 'list', '--porcelain'])
  expect(writeSafeLines(remaining).filter((line) => line.startsWith('worktree '))).toEqual([
    `worktree ${resolve(projectRoot).replace(/\\/g, '/')}`,
  ])
  return removed
}

test.describe('真实三角色 CODING Electron 旅程', () => {
  test.skip(process.platform !== 'win32', '真实工作树与受控证据根仅在 Windows 桌面封版门运行')

  test('研究→实现→审阅三角色串行，含检查点恢复、真实 Diff 与受控交付', async ({}, testInfo) => {
    test.setTimeout(240_000)
    mkdirSync(RUNS_ROOT, { recursive: true })
    mkdirSync(EVIDENCE_ROOT, { recursive: true })
    const runId = `run-${Date.now()}`
    const runRoot = join(RUNS_ROOT, runId)
    const evidenceDir = join(EVIDENCE_ROOT, runId)
    const userDataDir = join(runRoot, 'user-data')
    const agentDir = join(runRoot, 'agent')
    const workspace = join(runRoot, '一次性Git项目')
    const sessionDir = encodedSessionDirectory(agentDir, workspace)
    const controlDir = join(evidenceDir, 'control')
    for (const dir of [runRoot, evidenceDir, userDataDir, agentDir, workspace, sessionDir, controlDir]) {
      mkdirSync(dir, { recursive: true })
    }
    const session = writeSessionFixture(sessionDir, workspace)
    writeAgentModelFixture(agentDir)
    const baseline = await initProjectRepository(workspace)
    const baselineFingerprint = await projectFingerprint(workspace)
    const { scenarioPath, eventLogPath } = writeRuntimeScenario(evidenceDir)
    const scriptedRuntimeLaunchToken = randomBytes(32).toString('hex')
    const screenshots = {
      batchConfirm: join(evidenceDir, '01-batch-confirm.png'),
      plansAwaitingApproval: join(evidenceDir, '02-attempt-plans-awaiting-approval.png'),
      roleRequired: join(evidenceDir, '02a-role-required.png'),
      roleBound: join(evidenceDir, '02a-role-bound.png'),
      checkpointRestorePreview: join(evidenceDir, '02b-checkpoint-restore-preview.png'),
      checkpointRestored: join(evidenceDir, '02c-checkpoint-restored.png'),
      researchRunning: join(evidenceDir, '03-research-running.png'),
      implementationRunning: join(evidenceDir, '04-implementation-running.png'),
      review: join(evidenceDir, '04-real-diff-and-verification.png'),
      deliveryPending: join(evidenceDir, '05-three-task-delivery-pending.png'),
      applied: join(evidenceDir, '06-apply-succeeded.png'),
    }
    const consoleMessages: string[] = []
    let app: ElectronApplication | undefined
    let page: Page | undefined
    try {
      app = await launchFocusedApp(
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_E2E_EVENT_LOG: eventLogPath,
          PI_E2E_SCRIPTED_RUNTIME_SCENARIO: scenarioPath,
          PI_E2E_SCRIPTED_RUNTIME_TOKEN: scriptedRuntimeLaunchToken,
          TEMP: TEMP_ROOT,
          TMP: TEMP_ROOT,
        },
        [
          `--user-data-dir=${userDataDir}`,
          `--pi-e2e-scripted-runtime-token=${scriptedRuntimeLaunchToken}`,
        ],
      )
      page = await app.firstWindow({ timeout: 45_000 })
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push(message.text())
      })
      await page.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await page.setViewportSize({ width: 1440, height: 1100 })

      await invoke(page, 'ipc:workspace.open', { path: workspace, awaitWorker: false })
      await invoke(page, 'ipc:xiaogui.scope.set', { kind: 'session', key: session.file, mode: 'CODING' })
      await invoke(page, 'ipc:settings.set', { key: 'currentProject', value: workspace })
      await invoke(page, 'ipc:settings.set', { key: 'recentProjects', value: [workspace] })
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('pi-desktop:settings-changed', {
            detail: { key: 'recentProjects' },
          }),
        ),
      )
      const listed = await invoke<{
        sessions: Array<{ sessionFile: string; canonicalScope?: HubAddressV1 }>
      }>(page, 'ipc:session.list', { workspaceId: workspace, refresh: true })
      const canonicalScope = listed.sessions.find((candidate) => candidate.sessionFile === session.file)?.canonicalScope
      if (!canonicalScope) throw new Error('missing canonical scope')
      const address: HubAddressV1 = {
        projectId: canonicalScope.projectId,
        sessionKey: canonicalScope.sessionKey,
      }
      await openSessionAndHub(page, '一次性Git项目', session.title)

      const seeded = await invoke<{ ok: boolean; error?: unknown }>(page, 'ipc:xiaogui.hub.perform', {
        contractVersion: 'm2a.v1',
        address,
        request: {
          requestId: 'real-three-task-draft',
          expectedSessionVersion: 0,
          intent: {
            type: 'flow.start.with_draft',
            draft: {
              objective: '真实执行研究、实现、审阅三角色，然后统一交付',
              tasks: [
                { taskKey: 'a', title: '研究任务' },
                { taskKey: 'b', title: '实现任务', dependsOn: ['a'] },
                { taskKey: 'c', title: '审阅任务', dependsOn: ['b'] },
              ],
            },
          },
        },
      })
      if (!seeded.ok) throw new Error(`draft seed failed: ${JSON.stringify(seeded.error)}`)
      await refreshHubUi(page)
      await expect(page.getByTestId('hub-awaiting-approval')).toContainText('审阅任务')
      await page.getByRole('button', { name: '批准计划', exact: true }).click()

      const approved = await waitForProjection(page, address, (projection) =>
        projection.taskRuns.length === 3 && projection.executionReadiness?.readyTaskRunIds.length === 1)
      const runs = taskRunsByKey(approved)
      const runA = runs.get('a')
      const runB = runs.get('b')
      const runC = runs.get('c')
      if (!runA || !runB || !runC) throw new Error('missing task runs')
      await configureExecutionTask(page, runA.taskRunId, '研究任务', A_PATH, 'MODIFY')
      await page.getByRole('button', { name: '核对本批执行范围', exact: true }).click()
      await expect(page.getByTestId('hub-task-execution-review')).toContainText('本批 1 个任务')
      await page.getByTestId('hub-task-execution-review').screenshot({ path: screenshots.batchConfirm })

      expect(await projectFingerprint(workspace)).toBe(baselineFingerprint)
      await page.getByRole('button', { name: '确认并执行本批', exact: true }).click()
      const firstAttemptProjection = await waitForProjection(page, address, (projection) => (
        projection.attempts.length === 1 && projection.attempts[0]?.status !== 'WORKSPACE_PREPARING'
      ))
      if (firstAttemptProjection.attempts[0]?.status !== 'READY') {
        throw new Error(`research Attempt did not reach READY: ${JSON.stringify(firstAttemptProjection.attempts)}`)
      }
      await expect(page.getByTestId('hub-task-group-awaiting-plan')).toBeVisible({ timeout: 45_000 })
      await page.getByTestId('hub-task-group-awaiting-plan').screenshot({ path: screenshots.plansAwaitingApproval })
      expect(readEvents(eventLogPath).some((event) => event.event === 'runtime.execution.entered')).toBe(false)

      const awaitingPlans = await waitForProjection(page, address, (projection) => (
        projection.attempts.filter((attempt) => attempt.status === 'READY').length === 1
      ))
      const attemptA = awaitingPlans.attempts.find((attempt) => attempt.taskRunId === runA.taskRunId)
      if (!attemptA) throw new Error('missing READY research Attempt')
      const taskACard = page.getByTestId('hub-taskrun-status-a').locator('xpath=ancestor::li[1]')
      const roleCard = taskACard.getByLabel('执行角色')
      const roleSelect = roleCard.getByLabel('选择角色')
      await expect(roleSelect.locator('option')).toHaveText([
        '研究（研究）',
        '实现（实现）',
        '审阅（审阅）',
      ])
      await taskACard.getByRole('button', { name: '批准并开始执行', exact: true }).click()
      await expect(taskACard.getByText('请先在上方选择并绑定执行角色。', { exact: true })).toBeVisible()
      await taskACard.screenshot({ path: screenshots.roleRequired })
      await bindRole(page, 'a', 'xiaogui.role.research.default', '研究')
      await roleCard.screenshot({ path: screenshots.roleBound })

      await approveAwaitingAttemptPlans(page, 1)
      let events = await waitForEvents(eventLogPath, (items) =>
        items.some((event) => event.event === 'runtime.execution.entered' && event.details.label === 'A'))
      expect(events.some((event) => event.event === 'runtime.execution.succeeded')).toBe(false)
      const researchRunning = await observe(page, address)
      expect(researchRunning.executionReadiness?.dependencyStates).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskRunId: runA.taskRunId, state: 'IN_FLIGHT' }),
        expect.objectContaining({ taskRunId: runB.taskRunId, state: 'WAITING_FOR_DEPENDENCIES' }),
        expect.objectContaining({ taskRunId: runC.taskRunId, state: 'WAITING_FOR_DEPENDENCIES' }),
      ]))
      await page.getByTestId('hub-active-plan').screenshot({ path: screenshots.researchRunning })
      expect(await projectFingerprint(workspace)).toBe(baselineFingerprint)
      expect(await readFile(join(workspace, A_PATH), 'utf8')).toBe(README_CONTENT)
      expect(existsSync(join(workspace, ...B_PATH.split('/')))).toBe(false)

      await writeFile(join(controlDir, 'release-a'), 'release\n', 'utf8')
      const researchVerified = await waitForProjection(page, address, (projection) => {
        const byKey = taskRunsByKey(projection)
        return byKey.get('a')?.status === 'VERIFIED' &&
          projection.executionReadiness?.readyTaskRunIds.includes(runB.taskRunId) === true
      })
      expect(researchVerified.executionReadiness?.dependencyStates).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskRunId: runB.taskRunId, state: 'READY', dependencyTaskRunIds: [runA.taskRunId] }),
      ]))
      events = readEvents(eventLogPath)
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'runtime.execution.succeeded',
          details: expect.objectContaining({ label: 'A', role: 'RESEARCH', changedRelativePaths: [] }),
        }),
      ]))

      await configureExecutionTask(page, runB.taskRunId, '实现任务', B_PATH, 'CREATE')
      await page.getByRole('button', { name: '核对本批执行范围', exact: true }).click()
      await page.getByRole('button', { name: '确认并执行本批', exact: true }).click()
      await expect(page.getByTestId('hub-task-group-awaiting-plan')).toBeVisible({ timeout: 45_000 })
      const implementationReady = await waitForProjection(page, address, (projection) =>
        projection.attempts.some((attempt) => attempt.taskRunId === runB.taskRunId && attempt.status === 'READY'))
      const attemptB = implementationReady.attempts.find((attempt) => attempt.taskRunId === runB.taskRunId)
      if (!attemptB) throw new Error('missing READY implementation Attempt')
      await bindRole(page, 'b', 'xiaogui.role.implement.default', '实现')

      const taskBCard = page.getByTestId('hub-taskrun-status-b').locator('xpath=ancestor::li[1]')
      const checkpointCard = taskBCard.getByLabel('Git 检查点与恢复')
      await checkpointCard.getByRole('button', { name: '创建检查点', exact: true }).click()
      await expect(checkpointCard.getByText('检查点已创建。', { exact: true })).toBeVisible()
      const scratchPath = join(attemptWorktreeRoot(userDataDir, attemptB.attemptId), 'p3-restore-scratch.txt')
      await writeFile(scratchPath, 'temporary checkpoint change\n', 'utf8')
      await checkpointCard.getByRole('button', { name: '预览恢复影响', exact: true }).click()
      await expect(checkpointCard.getByText('p3-restore-scratch.txt', { exact: true })).toBeVisible()
      await expect(checkpointCard.getByRole('button', { name: '确认恢复到此检查点', exact: true })).toBeDisabled()
      await checkpointCard.screenshot({ path: screenshots.checkpointRestorePreview })
      await checkpointCard.getByRole('checkbox', { name: '我已了解上述影响', exact: true }).check()
      await checkpointCard.getByRole('button', { name: '确认恢复到此检查点', exact: true }).click()
      await expect(checkpointCard.getByText('已恢复到检查点。', { exact: true })).toBeVisible()
      expect(existsSync(scratchPath)).toBe(false)
      expect((await observe(page, address)).attempts.find((attempt) => attempt.attemptId === attemptB.attemptId)?.status)
        .toBe('READY')
      await checkpointCard.screenshot({ path: screenshots.checkpointRestored })

      await approveAwaitingAttemptPlans(page, 1)
      events = await waitForEvents(eventLogPath, (items) =>
        items.some((event) => event.event === 'runtime.execution.entered' && event.details.label === 'B'))
      const implementationRunning = await observe(page, address)
      expect(implementationRunning.executionReadiness?.dependencyStates).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskRunId: runB.taskRunId, state: 'IN_FLIGHT' }),
        expect.objectContaining({ taskRunId: runC.taskRunId, state: 'WAITING_FOR_DEPENDENCIES' }),
      ]))
      await page.getByTestId('hub-active-plan').screenshot({ path: screenshots.implementationRunning })
      await writeFile(join(controlDir, 'release-b'), 'release\n', 'utf8')
      const implementationVerified = await waitForProjection(page, address, (projection) => {
        const byKey = taskRunsByKey(projection)
        return byKey.get('b')?.status === 'VERIFIED' &&
          projection.executionReadiness?.readyTaskRunIds.includes(runC.taskRunId) === true
      })
      expect(implementationVerified.executionReadiness?.dependencyStates).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskRunId: runC.taskRunId, state: 'READY', dependencyTaskRunIds: [runB.taskRunId] }),
      ]))
      const realReviewButtons = page.getByRole('button', { name: '查看真实修改', exact: true })
      await expect(realReviewButtons).toHaveCount(2, { timeout: 30_000 })
      await realReviewButtons.last().click()
      await expect(page.getByText(B_PATH, { exact: true })).toBeVisible()
      await expect(page.getByText('通过', { exact: true }).first()).toBeVisible()
      await page.getByText('查看 Diff', { exact: true }).first().click()
      await expect(page.locator('pre').filter({ hasText: 'B-verified' })).toBeVisible()
      await page.getByLabel('修改与验证').filter({ hasText: '变更文件' }).first().screenshot({ path: screenshots.review })

      await configureExecutionTask(page, runC.taskRunId, '审阅任务', C_PATH, 'MODIFY')
      await page.getByRole('button', { name: '核对本批执行范围', exact: true }).click()
      await page.getByRole('button', { name: '确认并执行本批', exact: true }).click()
      await expect(page.getByTestId('hub-task-group-awaiting-plan')).toBeVisible({ timeout: 45_000 })
      const reviewReady = await waitForProjection(page, address, (projection) =>
        projection.attempts.some((attempt) => attempt.taskRunId === runC.taskRunId && attempt.status === 'READY'))
      const attemptC = reviewReady.attempts.find((attempt) => attempt.taskRunId === runC.taskRunId)
      if (!attemptC) throw new Error('missing READY review Attempt')
      await bindRole(page, 'c', 'xiaogui.role.review.default', '审阅')
      await approveAwaitingAttemptPlans(page, 1)
      await waitForEvents(eventLogPath, (items) =>
        items.some((event) => event.event === 'runtime.execution.entered' && event.details.label === 'C'))
      await writeFile(join(controlDir, 'release-c'), 'release\n', 'utf8')
      const allVerified = await waitForProjection(page, address, (projection) =>
        [...taskRunsByKey(projection).values()].every((run) => run.status === 'VERIFIED'))
      expect(allVerified.taskRuns).toHaveLength(3)

      events = readEvents(eventLogPath)
      expect(events.filter((event) => event.event === 'renderer.ipc.startBatch')).toHaveLength(3)
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'runtime.execution.succeeded',
          details: expect.objectContaining({ label: 'B', role: 'IMPLEMENT', changedRelativePaths: [B_PATH] }),
        }),
        expect.objectContaining({
          event: 'runtime.execution.succeeded',
          details: expect.objectContaining({ label: 'C', role: 'REVIEW', changedRelativePaths: [] }),
        }),
      ]))
      const bDependencyEvent = events.find((event) =>
        event.event === 'runtime.dependency.baseline.checked' && event.details.label === 'B')
      expect(bDependencyEvent?.details).toMatchObject({
        required: [{ relativePath: A_PATH, contentDigest: sha256(README_CONTENT) }],
      })
      const cDependencyEvent = events.find((event) =>
        event.event === 'runtime.dependency.baseline.checked' && event.details.label === 'C')
      expect(cDependencyEvent?.details).toMatchObject({
        required: [{ relativePath: B_PATH, contentDigest: sha256(B_CONTENT) }],
      })
      expect(await projectFingerprint(workspace)).toBe(baselineFingerprint)
      expect(await readFile(join(workspace, A_PATH), 'utf8')).toBe(README_CONTENT)
      expect(existsSync(join(workspace, ...B_PATH.split('/')))).toBe(false)
      expect(await readFile(join(workspace, C_PATH), 'utf8')).toBe(`${JSON.stringify(minimalTsconfig(), null, 2)}\n`)

      const deliverySelection = page.getByTestId('hub-delivery-selection')
      await expect(deliverySelection).toBeVisible()
      for (const title of ['研究任务', '实现任务', '审阅任务']) {
        await deliverySelection.getByText(title, { exact: true }).locator('..').locator('input[type="checkbox"]').check()
      }
      await deliverySelection.getByRole('button', { name: '创建交付', exact: true }).click()
      await expect(page.getByTestId('hub-delivery-review')).toContainText('待审阅', { timeout: 75_000 })
      const pendingDelivery = await observe(page, address)
      const delivery = pendingDelivery.activeDelivery
      if (!delivery?.gate) throw new Error('missing delivery gate')
      expect(delivery.selectedTaskRunIds).toEqual([runA.taskRunId, runB.taskRunId, runC.taskRunId])
      expect(delivery.fileChangeSummaries?.map((file) => file.relativePath).sort()).toEqual([B_PATH])
      const changeSetByRun = new Map(pendingDelivery.attempts.map((attempt) => [attempt.taskRunId, attempt.verificationSummary?.taskChangeSetId]))
      const aChangeSetIndex = delivery.taskChangeSetIds.indexOf(changeSetByRun.get(runA.taskRunId) ?? '')
      const bChangeSetIndex = delivery.taskChangeSetIds.indexOf(changeSetByRun.get(runB.taskRunId) ?? '')
      const cChangeSetIndex = delivery.taskChangeSetIds.indexOf(changeSetByRun.get(runC.taskRunId) ?? '')
      expect(aChangeSetIndex).toBeGreaterThanOrEqual(0)
      expect(bChangeSetIndex).toBeGreaterThan(aChangeSetIndex)
      expect(cChangeSetIndex).toBeGreaterThan(bChangeSetIndex)
      await page.getByTestId('hub-delivery-review').screenshot({ path: screenshots.deliveryPending })
      expect(await projectFingerprint(workspace)).toBe(baselineFingerprint)

      await page.getByRole('button', { name: '审阅', exact: true }).click()
      await page.getByRole('button', { name: '确认应用', exact: true }).click()
      try {
        await waitForProjection(page, address, (projection) =>
          projection.taskRuns.length === 3 && projection.taskRuns.every((run) => run.status === 'DONE'), 45_000)
        await waitForTaskBadges(page, { a: '已完成', b: '已完成', c: '已完成' }, 45_000)
        await expect(page.getByTestId('hub-delivery-review')).toHaveCount(0)
      } catch (error) {
        const diagnostic = await readApplyDiagnostic(userDataDir, workspace)
        const diagnosticPath = join(evidenceDir, 'apply-timeout-diagnostic.json')
        writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8')
        throw new Error(`delivery apply did not converge: ${JSON.stringify(diagnostic)}`, { cause: error })
      }
      expect(await readFile(join(workspace, ...A_PATH.split('/')), 'utf8')).toBe(README_CONTENT)
      expect(await readFile(join(workspace, ...B_PATH.split('/')), 'utf8')).toBe(B_CONTENT)
      expect(await readFile(join(workspace, ...C_PATH.split('/')), 'utf8')).toBe(`${JSON.stringify(minimalTsconfig(), null, 2)}\n`)
      const appliedFingerprint = await projectFingerprint(workspace)
      expect(appliedFingerprint).not.toBe(baselineFingerprint)

      events = await waitForEvents(eventLogPath, (items) =>
        items.some((event) => event.event === 'renderer.ipc.delivery.approve'))
      const approvalEvent = events.find((event) => event.event === 'renderer.ipc.delivery.approve')
      if (!approvalEvent) throw new Error('missing approval event')
      const replay = await invoke<{ ok: boolean; value?: { state: string } }>(page, 'ipc:xiaogui.delivery.gate.approve', {
        contractVersion: 'm4d.v1',
        address,
        request: {
          requestId: approvalEvent.details.requestId,
          gateId: delivery.gate.gateId,
          subject: delivery.gate.subject,
        },
      })
      expect(replay.ok).toBe(true)
      expect(await projectFingerprint(workspace)).toBe(appliedFingerprint)
      await page.getByTestId('hub-active-plan').screenshot({ path: screenshots.applied })

      const rows = readJourneyRows(userDataDir, await observe(page, address))
      const attemptByRun = new Map(rows.attempts.map((attempt) => [attempt.task_run_id, attempt]))
      expect(rows.roleBindings).toHaveLength(3)
      expect(rows.roleBindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ attempt_id: attemptA.attemptId, profile_id: 'xiaogui.role.research.default' }),
        expect.objectContaining({ attempt_id: attemptB.attemptId, profile_id: 'xiaogui.role.implement.default' }),
        expect.objectContaining({ attempt_id: attemptC.attemptId, profile_id: 'xiaogui.role.review.default' }),
      ]))
      expect(rows.roleBindings.every((binding) => (
        typeof (binding as { bound_at?: unknown }).bound_at === 'string'
        && typeof (binding as { snapshot_digest?: unknown }).snapshot_digest === 'string'
        && String((binding as { snapshot_digest: string }).snapshot_digest).startsWith('sha256:')
      ))).toBe(true)
      expect(rows.applyAttempts).toEqual([
        expect.objectContaining({ batch_id: delivery.batchId, state: 'SUCCEEDED' }),
      ])
      expect(rows.applyOutboxes).toEqual([
        expect.objectContaining({ status: 'DONE' }),
      ])
      const manifestByAttempt = new Map(rows.manifests.map((manifest) => [manifest.attempt_id, JSON.parse(manifest.manifest_json)]))
      expect(manifestByAttempt.get(attemptByRun.get(runA.taskRunId)?.attempt_id)?.grants).toEqual([
        expect.objectContaining({ operation: 'MODIFY', relativePath: A_PATH }),
      ])
      expect(manifestByAttempt.get(attemptByRun.get(runB.taskRunId)?.attempt_id)?.grants).toEqual([
        expect.objectContaining({ operation: 'CREATE', relativePath: B_PATH }),
      ])
      expect(manifestByAttempt.get(attemptByRun.get(runC.taskRunId)?.attempt_id)?.grants).toEqual([
        expect.objectContaining({ operation: 'MODIFY', relativePath: C_PATH }),
      ])
      const leaseByAttempt = new Map(rows.leases.map((lease) => [lease.attempt_id, JSON.parse(lease.lease_json)]))
      const leaseA = leaseByAttempt.get(attemptByRun.get(runA.taskRunId)?.attempt_id)
      const leaseB = leaseByAttempt.get(attemptByRun.get(runB.taskRunId)?.attempt_id)
      const leaseC = leaseByAttempt.get(attemptByRun.get(runC.taskRunId)?.attempt_id)
      expect(leaseA?.baseRevision).toBe(baseline.baseRevision)
      expect(leaseB?.baseRevision).not.toBe(baseline.baseRevision)
      expect(leaseC?.baseRevision).not.toBe(baseline.baseRevision)
      expect(await git(workspace, ['show', `${leaseB.baseRevision}:${A_PATH}`])).toBe(README_CONTENT.trim())
      expect(await git(workspace, ['show', `${leaseB.baseRevision}:${B_PATH}`], true)).toBe('')
      expect(await git(workspace, ['show', `${leaseC.baseRevision}:${B_PATH}`])).toBe(B_CONTENT.trim())

      const publicSurface = `${await page.locator('body').innerText()}\n${readFileSyncUtf8(eventLogPath)}\n${consoleMessages.join('\n')}`
      expect(publicSurface).not.toContain(workspace)
      expect(publicSurface).not.toContain(userDataDir)
      expect(publicSurface).not.toContain('pi-e2e-runtime-')
      expect(publicSurface).not.toContain('受控 Scripted Runtime 完成')

      const rowsPath = join(evidenceDir, 'journey-rows.json')
      writeFileSync(rowsPath, `${JSON.stringify(publicJourneyEvidence(baseline, rows, {
        initialFingerprint: baselineFingerprint,
        appliedFingerprint,
        replayFingerprint: await projectFingerprint(workspace),
        files: [
          { relativePath: A_PATH, contentDigest: sha256(readFileSync(join(workspace, ...A_PATH.split('/')))) },
          { relativePath: B_PATH, contentDigest: sha256(readFileSync(join(workspace, ...B_PATH.split('/')))) },
          { relativePath: C_PATH, contentDigest: sha256(readFileSync(join(workspace, ...C_PATH.split('/')))) },
        ],
      }), null, 2)}\n`, 'utf8')
      for (const [name, path] of Object.entries(screenshots)) {
        await testInfo.attach(name, { path, contentType: 'image/png' })
      }
      await testInfo.attach('journey-events', { path: eventLogPath, contentType: 'application/jsonl' })
      await testInfo.attach('journey-rows', { path: rowsPath, contentType: 'application/json' })
    } finally {
      if (app) await app.close()
      if (existsSync(join(workspace, '.git'))) {
        const removed = await removeManagedWorktrees(workspace, runRoot)
        appendFileSync(eventLogPath, `${JSON.stringify({
          event: 'cleanup.worktrees.removed',
          details: { count: removed.length },
        })}\n`, 'utf8')
      }
      const resolvedRunRoot = resolve(runRoot)
      const resolvedRunsRoot = resolve(RUNS_ROOT)
      if (!resolvedRunRoot.startsWith(`${resolvedRunsRoot}${sep}`)) {
        throw new Error(`refusing to remove journey directory outside temp runs root: ${resolvedRunRoot}`)
      }
      await rm(resolvedRunRoot, { recursive: true, force: true })
    }
  })
})

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
