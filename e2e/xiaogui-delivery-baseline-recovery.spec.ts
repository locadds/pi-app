import { expect, test, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { FlowId, HubAddressV1, InitialPlanDraftInputV1, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryChangeSetDigestV1,
  deliverySelectionDigestV1,
  deliveryTargetFingerprintV1,
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliveryChangeSetV1,
  type DeliveryGateId,
  type DeliverySelectionDraftId,
  type DeliverySelectionDraftV1,
} from '@shared/xiaogui-delivery'
import type { ArtifactId, Sha256Digest, TaskChangeSetId } from '@shared/xiaogui-task-verification'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import { createCollaborationHubApplicationV1 } from '../src/main/xiaogui/task-hub/application'
import { CollaborationHubSqliteStoreV1 } from '../src/main/xiaogui/task-hub/sqlite-store'
import { launchApp } from './helpers'

type PiDesktopWindow = Window & {
  piDesktop: { invoke(channel: string, request?: unknown): Promise<unknown> }
}

const TEMP_ROOT = 'E:\\CodexTemp\\m4f-electron-journey'
const EVIDENCE_ROOT = 'E:\\Codex\\evidence\\coding-m4f\\electron-journey'
const DELIVERY_FILE = 'generated-by-xiaogui.ts'
const DELIVERY_CONTENT = 'export const recoveredDelivery = "from recovered batch";\n'

async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  return page.evaluate(
    async ({ ipcChannel, ipcRequest }) =>
      (window as PiDesktopWindow).piDesktop.invoke(ipcChannel, ipcRequest) as Promise<T>,
    { ipcChannel: channel, ipcRequest: request },
  )
}

function writeSessionFixture(sessionDir: string, workspace: string) {
  const id = '44444444-4444-4444-8444-444444444444'
  const timestamp = new Date(Date.UTC(2026, 7, 24, 0, 0, 0)).toISOString()
  const file = join(sessionDir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd: workspace },
    {
      type: 'message',
      id: 'seed-user',
      parentId: null,
      timestamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'M4F 基线恢复会话' }],
        timestamp: Date.parse(timestamp),
      },
    },
    {
      type: 'session_info',
      id: 'seed-info',
      parentId: 'seed-user',
      timestamp,
      name: 'M4F 基线恢复会话',
    },
  ]
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return { file, title: 'M4F 基线恢复会话' }
}

function encodedSessionDirectory(agentDir: string, workspace: string): string {
  const resolvedWorkspace = resolve(workspace)
  return join(agentDir, 'sessions', `--${resolvedWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
}

async function openSessionAndHub(page: Page, workspaceName: string, title: string) {
  const projectButton = page.locator('.sidebar-project-hit').filter({ hasText: workspaceName })
  await expect(projectButton).toHaveCount(1)
  await projectButton.click()
  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  await page.getByRole('button', { name: '协作计划', exact: true }).click()
  await expect(page.getByTestId('collaboration-hub-panel')).toBeVisible()
}

async function bootstrapAddress(input: { agentDir: string; userDataDir: string; workspace: string; sessionFile: string }) {
  const app = await launchApp(
    {
      PI_CODING_AGENT_DIR: input.agentDir,
      TEMP: TEMP_ROOT,
      TMP: TEMP_ROOT,
    },
    [`--user-data-dir=${input.userDataDir}`],
  )
  try {
    const page = await app.firstWindow({ timeout: 45_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 45_000 })
    await invoke(page, 'ipc:workspace.open', { path: input.workspace, awaitWorker: false })
    await invoke(page, 'ipc:xiaogui.scope.set', {
      kind: 'session',
      key: input.sessionFile,
      mode: 'CODING',
    })
    await invoke(page, 'ipc:settings.set', { key: 'currentProject', value: input.workspace })
    await invoke(page, 'ipc:settings.set', { key: 'recentProjects', value: [input.workspace] })
    const listed = await invoke<{
      sessions: Array<{ sessionFile: string; canonicalScope?: HubAddressV1 & { sessionMode: string } }>
    }>(page, 'ipc:session.list', { workspaceId: input.workspace, refresh: true })
    const session = listed.sessions.find((candidate) => candidate.sessionFile === input.sessionFile)
    if (!session?.canonicalScope) throw new Error('missing canonical scope')
    return {
      projectId: session.canonicalScope.projectId,
      sessionKey: session.canonicalScope.sessionKey,
    } as HubAddressV1
  } finally {
    await app.close()
  }
}

async function createActiveCodingPlan(dbPath: string, address: HubAddressV1) {
  let id = 0
  const lookup: SessionScopeLookupV1 = {
    lookup: async (candidate: SessionAddressV1) => ({
      kind: 'FOUND',
      scope: { ...candidate, sessionMode: 'CODING' as SessionMode },
    }),
  }
  const app = createCollaborationHubApplicationV1({
    lookup,
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    now: () => '2026-08-24T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}_${++id}`,
  })
  const draft: InitialPlanDraftInputV1 = {
    objective: '验证旧交付基线漂移后可重新准备',
    tasks: [{ taskKey: 'delivery', title: '生成恢复交付文件' }],
  }
  const started = await app.execute({
    contractVersion: 'm2a.v1',
    address,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'm4f-start',
    intent: { type: 'flow.start.with_draft', draft },
  })
  if (!started.ok || !started.value.flowId || !started.value.revisionId) throw new Error('start failed')
  const beforeApprove = await app.observe(address)
  if (!beforeApprove.ok || !beforeApprove.value.activeRevision) throw new Error('missing draft projection')
  const approved = await app.execute({
    contractVersion: 'm2a.v1',
    address,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'm4f-approve-plan',
    expectedSessionVersion: beforeApprove.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: started.value.flowId,
      baseRevisionId: started.value.revisionId,
      draft: beforeApprove.value.activeRevision.draft,
    },
  })
  if (!approved.ok) throw new Error('approve failed')
  app.close()

  const store = new CollaborationHubSqliteStoreV1(dbPath)
  try {
    const run = store.taskRuns(started.value.flowId as FlowId)[0]
    if (!run) throw new Error('missing seeded task run')
    return { flowId: started.value.flowId as FlowId, taskRunId: run.task_run_id }
  } finally {
    store.close()
  }
}

async function seedReadyDelivery(input: {
  dbPath: string
  address: HubAddressV1
  flowId: FlowId
  taskRunId: TaskRunId
  baseRevision: string
  baselineTreeHash: string
}) {
  const now = '2026-08-24T00:00:01.000Z'
  const batchId = 'xhbd_m4f_source' as DeliveryBatchId
  const draftId = 'xhbd_draft_m4f_source' as DeliverySelectionDraftId
  const changeSetId = 'xhbdcs_m4f_source' as DeliveryChangeSetId
  const gateId = 'xhbdg_m4f_source' as DeliveryGateId
  const targetBase = {
    projectId: input.address.projectId,
    baseRevision: input.baseRevision,
    baselineTreeHash: input.baselineTreeHash,
  }
  const targetFingerprint = deliveryTargetFingerprintV1(targetBase)
  const draftBase: Omit<DeliverySelectionDraftV1, 'digest'> = {
    kind: 'DELIVERY_SELECTION_DRAFT',
    version: 1,
    draftId,
    batchId,
    flowId: input.flowId,
    selectedTaskRunIds: [input.taskRunId],
    resolvedTaskChangeSets: [],
    dependencyTaskRunIds: [input.taskRunId],
    targetFingerprint,
    createdAt: now as never,
  }
  const draft = { ...draftBase, digest: deliverySelectionDigestV1(draftBase) }
  const content = Buffer.from(DELIVERY_CONTENT, 'utf8')
  const artifactId = 'xhbdart_m4f_source_file' as ArtifactId
  const changeSetBase: Omit<DeliveryChangeSetV1, 'digest'> = {
    kind: 'DELIVERY_CHANGESET',
    version: 1,
    deliveryChangeSetId: changeSetId,
    batchId,
    selectionDraftId: draftId,
    flowId: input.flowId,
    selectionDigest: draft.digest,
    taskChangeSetIds: [] as readonly TaskChangeSetId[],
    taskChangeSets: [],
    dependencyOrder: [] as readonly TaskChangeSetId[],
    fileChanges: [{
      operation: 'CREATE',
      relativePath: DELIVERY_FILE,
      baselineDigest: null,
      contentDigest: digestBytes(content),
      contentArtifactId: artifactId,
      sourceTaskChangeSetIds: [] as readonly TaskChangeSetId[],
    }],
    target: {
      ...targetBase,
      initialTargetFingerprint: targetFingerprint,
    },
    integrationTreeHash: digestJson({ kind: 'M4F_SOURCE_TREE', file: DELIVERY_FILE, contentDigest: digestBytes(content) }),
    evidenceArtifactIds: [] as readonly ArtifactId[],
    qaConfigVersion: 'xiaogui.coding.delivery.v1',
    createdAt: now as never,
  }
  const changeSet = { ...changeSetBase, digest: deliveryChangeSetDigestV1(changeSetBase) }
  const gate = {
    gateId,
    batchId,
    subject: { deliveryChangeSetId: changeSetId, version: 1 as const, digest: changeSet.digest },
    state: 'OPEN' as const,
    createdAt: now as never,
  }

  const db = new DatabaseSync(input.dbPath)
  try {
    db.exec('pragma foreign_keys = on; begin immediate')
    db.prepare("update task_runs set status = 'DELIVERY_PENDING' where task_run_id = ?").run(input.taskRunId)
    db.prepare(
      'insert into artifacts (artifact_id, kind, media_type, content_digest, content, created_at) values (?, ?, ?, ?, ?, ?)',
    ).run(artifactId, 'DELIVERY_FILE_CONTENT', 'application/vnd.xiaogui.delivery-file-content', digestBytes(content), content, now)
    db.prepare(
      'insert into delivery_batches (batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, input.address.projectId, input.address.sessionKey, input.flowId, draftId, 'READY_FOR_REVIEW', draft.digest, targetFingerprint, now, now)
    db.prepare(
      'insert into delivery_selection_drafts (draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(draftId, batchId, input.flowId, JSON.stringify(draft.selectedTaskRunIds), '[]', JSON.stringify(draft.dependencyTaskRunIds), draft.digest, JSON.stringify(draft), now)
    db.prepare(
      'insert into delivery_change_sets (delivery_change_set_id, batch_id, flow_id, version, selection_digest, task_change_set_ids_json, evidence_artifact_ids_json, qa_config_version, digest, change_set_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(changeSetId, batchId, input.flowId, 1, draft.digest, '[]', JSON.stringify(changeSet.evidenceArtifactIds), changeSet.qaConfigVersion, changeSet.digest, JSON.stringify(changeSet), now)
    db.prepare(
      'insert into delivery_human_gates (gate_id, batch_id, delivery_change_set_id, subject_version, subject_digest, state, decision_digest, decided_at, gate_json, created_at) values (?, ?, ?, ?, ?, ?, null, null, ?, ?)',
    ).run(gateId, batchId, changeSetId, 1, changeSet.digest, 'OPEN', JSON.stringify(gate), now)
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  } finally {
    db.close()
  }
  return { batchId, gateId, changeSetId, expectedContent: DELIVERY_CONTENT }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolvePromise((stdout ?? '').trim())
    })
  })
}

async function initProjectRepository(projectRoot: string) {
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  symlinkSync(realpathSync(join(process.cwd(), 'node_modules')), join(projectRoot, 'node_modules'), 'junction')
  await writeFile(join(projectRoot, 'README.md'), '# M4F delivery recovery fixture\n', 'utf8')
  await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n', 'utf8')
  await writeFile(join(projectRoot, 'tsconfig.web.json'), JSON.stringify(minimalTsconfig(), null, 2), 'utf8')
  await writeFile(join(projectRoot, 'tsconfig.node.json'), JSON.stringify(minimalTsconfig(), null, 2), 'utf8')
  await git(projectRoot, ['init'])
  await git(projectRoot, ['config', 'user.email', 'xiaogui-e2e@example.invalid'])
  await git(projectRoot, ['config', 'user.name', 'Xiaogui E2E'])
  await git(projectRoot, ['add', 'README.md', '.gitignore', 'tsconfig.web.json', 'tsconfig.node.json'])
  await git(projectRoot, ['commit', '-m', 'baseline A'])
  const baseRevision = await git(projectRoot, ['rev-parse', '--verify', 'HEAD'])
  const baselineTreeHash = await git(projectRoot, ['rev-parse', '--verify', 'HEAD^{tree}'])
  await writeFile(join(projectRoot, 'README.md'), '# M4F delivery recovery fixture\n\nCurrent commit B.\n', 'utf8')
  await git(projectRoot, ['add', 'README.md'])
  await git(projectRoot, ['commit', '-m', 'current B'])
  return { baseRevision, baselineTreeHash }
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Sha256Digest
}

function digestJson(value: unknown): Sha256Digest {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
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
    include: ['*.ts', 'src/**/*.ts'],
  }
}

function readDeliveryRows(dbPath: string) {
  const db = new DatabaseSync(dbPath)
  try {
    return {
      batches: db.prepare('select batch_id, state, recovery_source_batch_id from delivery_batches order by rowid').all(),
      attempts: db.prepare('select apply_attempt_id, batch_id, state, safe_code, changed_relative_paths_json from delivery_apply_attempts order by rowid').all(),
      applyOutbox: db.prepare('select outbox_id, apply_attempt_id, status, claim_owner_id, completed_at from delivery_apply_outbox order by rowid').all(),
      taskRuns: db.prepare('select task_run_id, status from task_runs order by rowid').all(),
      changeSets: db.prepare('select delivery_change_set_id, batch_id, digest, evidence_artifact_ids_json, change_set_json from delivery_change_sets order by rowid').all(),
      receipts: db.prepare('select apply_attempt_id, receipt_digest, receipt_json from delivery_apply_attempts order by rowid').all(),
      artifactCount: db.prepare('select count(*) as count from artifacts').get(),
    }
  } finally {
    db.close()
  }
}

test.describe('M4F 旧基线交付恢复真实 Electron 旅程', () => {
  test('旧批次基线漂移零写入失败，按当前代码重新准备后新批次可应用', async ({}, testInfo) => {
    test.setTimeout(180_000)
    mkdirSync(TEMP_ROOT, { recursive: true })
    mkdirSync(EVIDENCE_ROOT, { recursive: true })
    const root = join(TEMP_ROOT, `run-${Date.now()}`)
    const userDataDir = join(root, 'user-data')
    const agentDir = join(root, 'agent')
    const workspace = join(root, '项目空间')
    const sessionDir = encodedSessionDirectory(agentDir, workspace)
    for (const dir of [userDataDir, agentDir, workspace, sessionDir]) mkdirSync(dir, { recursive: true })

    const session = writeSessionFixture(sessionDir, workspace)
    const baseline = await initProjectRepository(workspace)
    const address = await bootstrapAddress({ agentDir, userDataDir, workspace, sessionFile: session.file })
    const dbPath = join(userDataDir, 'xiaogui-task-hub-m2a.sqlite')
    const active = await createActiveCodingPlan(dbPath, address)
    const seeded = await seedReadyDelivery({ dbPath, address, ...active, ...baseline })

    const app = await launchApp(
      {
        PI_CODING_AGENT_DIR: agentDir,
        TEMP: TEMP_ROOT,
        TMP: TEMP_ROOT,
      },
      [`--user-data-dir=${userDataDir}`],
    )

    const screenshotPath = join(EVIDENCE_ROOT, 'm4f-delivery-recovery-final.png')
    const rowsPath = join(EVIDENCE_ROOT, 'm4f-delivery-recovery-rows.json')
    try {
      const page = await app.firstWindow({ timeout: 45_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 45_000 })
      await invoke(page, 'ipc:workspace.open', { path: workspace, awaitWorker: false })
      await invoke(page, 'ipc:xiaogui.scope.set', {
        kind: 'session',
        key: session.file,
        mode: 'CODING',
      })
      await invoke(page, 'ipc:settings.set', { key: 'currentProject', value: workspace })
      await invoke(page, 'ipc:settings.set', { key: 'recentProjects', value: [workspace] })
      await openSessionAndHub(page, '项目空间', session.title)

      await expect(page.getByTestId('hub-delivery-review')).toContainText('待审阅', { timeout: 30_000 })
      await page.getByRole('button', { name: '审阅', exact: true }).click()
      await page.getByRole('button', { name: '确认应用', exact: true }).click()

      await expect(page.getByTestId('hub-delivery-integrity-note')).toContainText('项目代码已变化', { timeout: 30_000 })
      await expect(readFile(join(workspace, DELIVERY_FILE), 'utf8')).rejects.toThrow()
      expect(readDeliveryRows(dbPath).attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          batch_id: seeded.batchId,
          state: 'FAILED',
          safe_code: 'TARGET_BASELINE_DRIFT',
          changed_relative_paths_json: '[]',
        }),
      ]))

      await page.getByRole('button', { name: '按当前代码重新准备交付', exact: true }).click()
      try {
        await expect(page.getByTestId('hub-delivery-review')).toContainText('待审阅', { timeout: 60_000 })
      } catch (error) {
        const rowsBeforeDiagnostic = readDeliveryRows(dbPath)
        writeFileSync(
          join(EVIDENCE_ROOT, 'm4f-delivery-recovery-debug-after-prepare.json'),
          `${JSON.stringify({
            reviewText: await page.getByTestId('hub-delivery-review').innerText(),
            rows: rowsBeforeDiagnostic,
          }, null, 2)}\n`,
          'utf8',
        )
        throw error
      }
      await expect(page.getByTestId('hub-delivery-review')).not.toContainText(seeded.batchId)

      await page.getByRole('button', { name: '审阅', exact: true }).click()
      await page.getByRole('button', { name: '确认应用', exact: true }).click()
      await expect(page.getByTestId('hub-taskrun-status-delivery')).toContainText('已完成', { timeout: 60_000 })

      expect(await readFile(join(workspace, DELIVERY_FILE), 'utf8')).toBe(seeded.expectedContent)
      const rows = readDeliveryRows(dbPath)
      writeFileSync(rowsPath, `${JSON.stringify({ address, seeded, rows }, null, 2)}\n`, 'utf8')
      expect(rows.batches).toEqual(expect.arrayContaining([
        expect.objectContaining({ batch_id: seeded.batchId, state: 'SUPERSEDED' }),
        expect.objectContaining({ state: 'APPLIED', recovery_source_batch_id: seeded.batchId }),
      ]))
      expect(rows.attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          batch_id: seeded.batchId,
          state: 'FAILED',
          safe_code: 'TARGET_BASELINE_DRIFT',
          changed_relative_paths_json: '[]',
        }),
        expect.objectContaining({ state: 'SUCCEEDED' }),
      ]))
      expect(rows.taskRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({ task_run_id: active.taskRunId, status: 'DONE' }),
      ]))
      await page.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('m4f-delivery-recovery-final', { path: screenshotPath, contentType: 'image/png' })
      await testInfo.attach('m4f-delivery-recovery-rows', { path: rowsPath, contentType: 'application/json' })
    } finally {
      await app.close()
      const resolvedRoot = resolve(root)
      const resolvedTempRoot = resolve(TEMP_ROOT)
      if (!resolvedRoot.startsWith(`${resolvedTempRoot}${sep}`)) {
        throw new Error(`refusing to remove journey directory outside E-drive temp root: ${resolvedRoot}`)
      }
      await rm(resolvedRoot, { recursive: true, force: true })
    }
  })
})
