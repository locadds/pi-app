import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubCommandRequestV1,
  InitialPlanDraftInputV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import {
  taskCandidateDigestV1,
  taskChangeSetDigestV1,
  taskEvidenceBundleDigestV1,
  taskQaResultDigestV1,
  verificationReceiptDigestV1,
  verificationRequestDigestV1,
} from '@shared/xiaogui-task-verification'
import type {
  ArtifactId,
  ChangeSetCandidateV1,
  EvidenceBundleId,
  IsoDateTime,
  QaResultId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskChangeSetId,
  TaskChangeSetV1,
  TaskEvidenceBundleV1,
  TaskPassedQaResultV1,
  TaskVerificationPassedReceiptV1,
  TaskVerificationReceiptV1,
  TaskVerificationRequestV1,
  VerificationAttemptId,
  VerificationAttemptV1,
} from '@shared/xiaogui-task-verification'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { createCollaborationHubApplicationV1 } from './application'
import {
  CollaborationHubSqliteStoreV1,
  type BeginTaskVerificationRecordV1,
  type CompleteTaskVerificationRecordV1,
  type ScheduleRecordM2BV1,
  type TaskArtifactWriteV1,
} from './sqlite-store'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2b-store-'))
  roots.push(root)
  return join(root, name)
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    }),
  }
}

function draft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证 SQLite v2 迁移',
    tasks: [
      { taskKey: 'a', title: '无依赖任务' },
      { taskKey: 'b', title: '依赖任务', dependsOn: ['a'] },
    ],
  }
}

async function activePlan(dbPath: string) {
  let id = 0
  const app = createCollaborationHubApplicationV1({
    lookup: lookup('CODING'),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    now: () => '2026-08-17T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}_${++id}`,
  })
  const start = await app.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'req-start',
    intent: { type: 'flow.start.with_draft', draft: draft() },
  })
  if (!start.ok || !start.value.flowId || !start.value.revisionId) throw new Error('start failed')
  const before = await app.observe(ADDRESS)
  if (!before.ok || !before.value.activeRevision) throw new Error('missing draft')
  const approve: HubCommandRequestV1 = {
    contractVersion: 'm2a.v1',
    address: ADDRESS as HubAddressV1,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'req-approve',
    expectedSessionVersion: before.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: start.value.flowId,
      baseRevisionId: start.value.revisionId,
      draft: before.value.activeRevision.draft,
    },
  }
  const approved = await app.execute(approve)
  if (!approved.ok) throw new Error('approve failed')
  return { app, flowId: start.value.flowId }
}

function baselineRecord(suffix: string) {
  const baselineId = `baseline-${suffix}`
  const baseRevision = `${suffix.repeat(40).slice(0, 40)}`
  const baselineTreeHash = `sha256:baseline-tree-${suffix}`
  const initialTargetFingerprint = `sha256:initial-target-${suffix}`
  const baselineDigest = `sha256:baseline-digest-${suffix}`
  const baselineBindingDigest = `sha256:baseline-binding-${suffix}`
  return { baselineId, baseRevision, baselineTreeHash, initialTargetFingerprint, baselineDigest, baselineBindingDigest }
}

function flowBaselineRow(dbPath: string, flowId: FlowId) {
  const db = new DatabaseSync(dbPath)
  try {
    return db
      .prepare('select flow_id, baseline_id, base_revision, baseline_tree_hash, initial_target_fingerprint, baseline_digest, baseline_binding_digest, created_at from flow_execution_baselines where flow_id = ?')
      .get(flowId) as Record<string, unknown> | undefined
  } finally {
    db.close()
  }
}

function privateM2B2Tables() {
  return [
    'attempt_workspace_prepared',
    'attempt_workspace_leases',
    'attempt_file_manifests',
    'scope_expansion_requests',
    'create_batches',
    'private_runtime_payloads',
  ]
}

function scheduleRecord(input: {
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  suffix: string
  projection: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['readProjection']>>
}): ScheduleRecordM2BV1 {
  const baseline = baselineRecord(input.suffix)
  return {
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    attemptDigest: `sha256:${input.suffix}-attempt`,
    compositionDigest: `sha256:${input.suffix}-composition`,
    ...baseline,
    workspacePrepareRequestDigest: `sha256:${input.suffix}-workspace-prepare`,
    projection: input.projection,
    receipt: {
      requestId: `sys-schedule-${input.suffix}`,
      intentType: 'system.schedule' as const,
      sessionVersion: 0,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
    },
    now: '2026-08-17T00:00:00.000Z',
  }
}

function asDigest(value: string): Sha256Digest {
  return value as Sha256Digest
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function setAttemptRunning(dbPath: string, attemptId: AttemptId, taskRunId: TaskRunId, runtimeSessionId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare("update attempts set status = 'RUNNING', runtime_session_id = ? where attempt_id = ?").run(
      runtimeSessionId,
      attemptId,
    )
    db.prepare("update task_runs set status = 'RUNNING' where task_run_id = ?").run(taskRunId)
  } finally {
    db.close()
  }
}

function setAttemptOutcomeUnknown(
  dbPath: string,
  attemptId: AttemptId,
  taskRunId: TaskRunId,
  runtimeSessionId: string,
  receiptDigest: string,
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare("update attempts set status = 'OUTCOME_UNKNOWN', runtime_session_id = ?, outcome_receipt_digest = ? where attempt_id = ?").run(
      runtimeSessionId,
      receiptDigest,
      attemptId,
    )
    db.prepare("update task_runs set status = 'OUTCOME_UNKNOWN' where task_run_id = ?").run(taskRunId)
  } finally {
    db.close()
  }
}

async function startedTaskVerification(dbPath: string, suffix: string) {
  const { app, flowId } = await activePlan(dbPath)
  app.close()
  const store = new CollaborationHubSqliteStoreV1(dbPath)
  const projection = store.readProjection(ADDRESS)
  const taskRun = store.taskRuns(flowId as FlowId)[0]
  const activeFlow = store.activeFlow(ADDRESS)
  if (!projection || !taskRun || !activeFlow?.active_revision_id) throw new Error('missing active plan')
  const attemptId = `xhba_${suffix}` as AttemptId
  store.writeSchedule(
    ADDRESS,
    { requestId: `sys-schedule-${suffix}`, commandType: 'system.schedule', payloadHash: `sha256:schedule-${suffix}` },
    scheduleRecord({
      flowId: flowId as FlowId,
      taskRunId: taskRun.task_run_id,
      attemptId,
      suffix,
      projection,
    }),
  )
  const runtimeSessionId = `runtime-${suffix}`
  setAttemptRunning(dbPath, attemptId, taskRun.task_run_id, runtimeSessionId)

  const patchContent = Buffer.from(`patch-${suffix}`)
  const patchArtifact: TaskArtifactWriteV1 = {
    artifactId: `xhbart_patch_${suffix}` as ArtifactId,
    contentDigest: contentDigest(patchContent),
    kind: 'PATCH',
    mediaType: 'application/vnd.xiaogui.task-patch+json',
    content: patchContent,
  }
  const candidateWithoutDigest = {
    kind: 'TASK_CANDIDATE' as const,
    candidateId: `xhbcandidate_${suffix}` as TaskChangeSetCandidateId,
    flowId: flowId as FlowId,
    taskRunId: taskRun.task_run_id,
    attemptId,
    inputTreeHash: asDigest(`sha256:input-${suffix}`),
    resultTreeHash: asDigest(`sha256:result-${suffix}`),
    patchArtifactId: patchArtifact.artifactId,
    proposedChangeSetDigest: taskChangeSetDigestV1({
      inputTreeHash: asDigest(`sha256:input-${suffix}`),
      resultTreeHash: asDigest(`sha256:result-${suffix}`),
      ancestorTaskChangeSetIds: [] as readonly TaskChangeSetId[],
      patchArtifactId: patchArtifact.artifactId,
    }),
    createdAt: '2026-08-17T00:00:02.000Z' as IsoDateTime,
  }
  const candidate: ChangeSetCandidateV1 = {
    ...candidateWithoutDigest,
    candidateDigest: taskCandidateDigestV1(candidateWithoutDigest),
  }
  const verificationAttemptId = `xhbverify_${suffix}` as VerificationAttemptId
  const requestWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId,
    verificationRequestId: `verify-request-${suffix}`,
    flowId: flowId as FlowId,
    taskRunId: taskRun.task_run_id,
    attemptId,
    candidateId: candidate.candidateId,
    changeSetDigest: candidate.proposedChangeSetDigest,
    preparedTreeHash: candidate.resultTreeHash,
    qaConfigVersion: 'task-typescript-v1',
    acceptanceCriteria: ['类型检查通过'] as readonly string[],
  }
  const verificationRequest: TaskVerificationRequestV1 = {
    ...requestWithoutDigest,
    requestDigest: verificationRequestDigestV1(requestWithoutDigest),
  }
  const verificationAttempt: Extract<VerificationAttemptV1, { state: 'STARTED' }> = {
    scope: 'TASK',
    verificationAttemptId,
    verificationRequestId: verificationRequest.verificationRequestId,
    flowId: flowId as FlowId,
    taskRunId: taskRun.task_run_id,
    attemptId,
    candidateId: candidate.candidateId,
    requestDigest: verificationRequest.requestDigest,
    state: 'STARTED',
    startedAt: '2026-08-17T00:00:02.000Z' as IsoDateTime,
  }
  const beginRecord: BeginTaskVerificationRecordV1 = {
    patchArtifact,
    candidate,
    ancestorTaskChangeSetIds: [],
    succeededAudit: {
      runtimeSessionId,
      attemptId,
      receiptDigest: `sha256:runtime-succeeded-${suffix}`,
      candidateDigest: `sha256:runtime-candidate-${suffix}`,
    },
    verificationAttempt,
    verificationRequestJson: JSON.stringify(verificationRequest),
    now: '2026-08-17T00:00:02.000Z',
  }
  return {
    store,
    flowId: flowId as FlowId,
    planRevisionId: activeFlow.active_revision_id,
    taskRunId: taskRun.task_run_id,
    attemptId,
    candidate,
    verificationRequest,
    beginRecord,
  }
}

function passedCompletion(input: Awaited<ReturnType<typeof startedTaskVerification>>): CompleteTaskVerificationRecordV1 {
  const suffix = input.attemptId.replace('xhba_', '')
  const evidenceContent = Buffer.from(`evidence-${suffix}`)
  const evidenceArtifact: TaskArtifactWriteV1 = {
    artifactId: `xhbart_evidence_${suffix}` as ArtifactId,
    contentDigest: contentDigest(evidenceContent),
    kind: 'VERIFICATION_EVIDENCE',
    mediaType: 'application/vnd.xiaogui.qa-evidence+json',
    content: evidenceContent,
  }
  const checks = [
    {
      checkId: 'typecheck',
      summary: '固定类型检查通过',
      artifactIds: [evidenceArtifact.artifactId] as readonly ArtifactId[],
      verdict: 'PASS' as const,
    },
  ] as const
  const receiptWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    verificationRequestId: input.verificationRequest.verificationRequestId,
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    candidateId: input.candidate.candidateId,
    requestDigest: input.verificationRequest.requestDigest,
    changeSetDigest: input.candidate.proposedChangeSetDigest,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    diagnosticArtifactIds: [] as readonly ArtifactId[],
    verdict: 'PASS' as const,
    checks,
    evidenceArtifactIds: [evidenceArtifact.artifactId] as readonly ArtifactId[],
  }
  const receipt: TaskVerificationPassedReceiptV1 = {
    ...receiptWithoutDigest,
    receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
  }
  const evidenceWithoutDigest = {
    scope: 'TASK' as const,
    evidenceBundleId: `xhbevidence_${suffix}` as EvidenceBundleId,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    changeSetDigest: input.candidate.proposedChangeSetDigest,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    artifactIds: [evidenceArtifact.artifactId] as readonly ArtifactId[],
  }
  const evidenceBundle: TaskEvidenceBundleV1 = {
    ...evidenceWithoutDigest,
    bundleDigest: taskEvidenceBundleDigestV1(evidenceWithoutDigest),
  }
  const qaWithoutDigest = {
    scope: 'TASK' as const,
    qaResultId: `xhbqa_${suffix}` as QaResultId,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    candidateId: input.candidate.candidateId,
    changeSetDigest: input.candidate.proposedChangeSetDigest,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    verdict: 'PASS' as const,
    checks,
  }
  const qaResult: TaskPassedQaResultV1 = {
    ...qaWithoutDigest,
    resultDigest: taskQaResultDigestV1(qaWithoutDigest),
  }
  const taskChangeSet: TaskChangeSetV1 = {
    kind: 'TASK',
    taskChangeSetId: `xhbchangeset_${suffix}` as TaskChangeSetId,
    version: 1,
    flowId: input.flowId,
    planRevisionId: input.planRevisionId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    candidateId: input.candidate.candidateId,
    inputTreeHash: input.candidate.inputTreeHash,
    resultTreeHash: input.candidate.resultTreeHash,
    ancestorTaskChangeSetIds: [],
    patchArtifactId: input.candidate.patchArtifactId,
    evidenceBundleId: evidenceBundle.evidenceBundleId,
    qaResultId: qaResult.qaResultId,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    digest: input.candidate.proposedChangeSetDigest,
    createdAt: '2026-08-17T00:00:03.000Z' as IsoDateTime,
  }
  return {
    receipt,
    evidenceBundle,
    qaResult,
    taskChangeSet,
    evidenceArtifacts: [evidenceArtifact],
    now: '2026-08-17T00:00:03.000Z',
  }
}

describe('M2B sqlite store migration', () => {
  it('creates v1 and v2 migrations idempotently with additive execution tables', async () => {
    const dbPath = await tempDb()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toEqual({
      journal_events: 0,
      idempotency_keys: 0,
      session_projection: 0,
      flows: 0,
      plan_revisions: 0,
      task_specs: 0,
      task_runs: 0,
      attempts: 0,
      flow_execution_baselines: 0,
      composition_attempts: 0,
      workspace_prepare_outbox: 0,
      workspace_receipts: 0,
      agent_dispatch_outbox: 0,
      runtime_session_bindings: 0,
      agent_failures: 0,
      agent_succeeded_audits: 0,
      agent_reconcile_results: 0,
      artifacts: 0,
      change_set_candidates: 0,
      verification_attempts: 0,
      verification_outbox: 0,
      verification_receipts: 0,
      task_evidence_bundles: 0,
      task_qa_results: 0,
      task_change_sets: 0,
      attempt_workspace_prepared: 0,
      attempt_workspace_leases: 0,
      attempt_file_manifests: 0,
      scope_expansion_requests: 0,
      create_batches: 0,
      private_runtime_payloads: 0,
    })
    store.close()

    const reopened = new CollaborationHubSqliteStoreV1(dbPath)
    reopened.close()

    const db = new DatabaseSync(dbPath)
    expect(db.prepare('select version from schema_migrations order by version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }])
    expect(db.prepare("select name from sqlite_master where type = 'table' and name in ('attempts', 'flow_execution_baselines', 'composition_attempts', 'workspace_prepare_outbox', 'workspace_receipts', 'agent_dispatch_outbox', 'runtime_session_bindings', 'agent_failures', 'agent_succeeded_audits', 'agent_reconcile_results', 'attempt_workspace_prepared', 'attempt_workspace_leases', 'attempt_file_manifests', 'scope_expansion_requests', 'create_batches', 'private_runtime_payloads', 'artifacts', 'change_set_candidates', 'verification_attempts', 'verification_outbox', 'verification_receipts', 'task_evidence_bundles', 'task_qa_results', 'task_change_sets') order by name").all()).toEqual([
      { name: 'agent_dispatch_outbox' },
      { name: 'agent_failures' },
      { name: 'agent_reconcile_results' },
      { name: 'agent_succeeded_audits' },
      { name: 'artifacts' },
      { name: 'attempt_file_manifests' },
      { name: 'attempt_workspace_leases' },
      { name: 'attempt_workspace_prepared' },
      { name: 'attempts' },
      { name: 'change_set_candidates' },
      { name: 'composition_attempts' },
      { name: 'create_batches' },
      { name: 'flow_execution_baselines' },
      { name: 'private_runtime_payloads' },
      { name: 'runtime_session_bindings' },
      { name: 'scope_expansion_requests' },
      { name: 'task_change_sets' },
      { name: 'task_evidence_bundles' },
      { name: 'task_qa_results' },
      { name: 'verification_attempts' },
      { name: 'verification_outbox' },
      { name: 'verification_receipts' },
      { name: 'workspace_prepare_outbox' },
      { name: 'workspace_receipts' },
    ])
    db.close()
  })

  it('does not silently turn legacy PENDING_DISABLED task runs into attempts', async () => {
    const dbPath = await tempDb()
    const { app } = await activePlan(dbPath)
    const m2a = await app.observe(ADDRESS)
    const m2b = await app.observeM2B(ADDRESS)

    expect(m2a).toMatchObject({
      ok: true,
      value: { taskRuns: expect.arrayContaining([expect.objectContaining({ status: 'PENDING_DISABLED' })]) },
    })
    expect(m2b).toMatchObject({
      ok: true,
      value: {
        taskRuns: expect.arrayContaining([expect.objectContaining({ status: 'BLOCKED' })]),
        attempts: [],
      },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({
      attempts: 0,
      flow_execution_baselines: 0,
      composition_attempts: 0,
      workspace_prepare_outbox: 0,
      workspace_receipts: 0,
      agent_dispatch_outbox: 0,
      runtime_session_bindings: 0,
      agent_failures: 0,
      agent_succeeded_audits: 0,
      agent_reconcile_results: 0,
      artifacts: 0,
      change_set_candidates: 0,
      verification_attempts: 0,
      verification_outbox: 0,
      verification_receipts: 0,
      task_evidence_bundles: 0,
      task_qa_results: 0,
      task_change_sets: 0,
      attempt_workspace_prepared: 0,
      attempt_workspace_leases: 0,
      attempt_file_manifests: 0,
      scope_expansion_requests: 0,
      create_batches: 0,
      private_runtime_payloads: 0,
    })
    store.close()
    app.close()
  })

  it('allows a new flow after CANCELLED while a running flow remains unique', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    await expect(
      app.execute({
        contractVersion: 'm2a.v1',
        address: ADDRESS,
        trustedActor: { kind: 'main-process-user' },
        requestId: 'req-second',
        intent: { type: 'flow.start.with_draft', draft: draft() },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ACTIVE_FLOW_EXISTS' } })
    const beforeCancel = await app.observe(ADDRESS)
    await app.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-cancel',
      expectedSessionVersion: beforeCancel.ok ? beforeCancel.value.sessionVersion : 0,
      intent: { type: 'flow.cancel', flowId: flowId as FlowId, reason: 'test' },
    })
    await expect(
      app.execute({
        contractVersion: 'm2a.v1',
        address: ADDRESS,
        trustedActor: { kind: 'main-process-user' },
        requestId: 'req-third',
        intent: { type: 'flow.start.with_draft', draft: draft() },
      }),
    ).resolves.toMatchObject({ ok: true })
    app.close()
    expect(existsSync(dbPath)).toBe(true)
  })

  it('rejects direct writeSchedule baseline drift at the SQLite write boundary without overwriting the existing row', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const projection = store.readProjection(ADDRESS)
    const taskRun = store.taskRuns(flowId as FlowId)[0]
    if (!projection || !taskRun) throw new Error('missing active plan')
    const firstBaseline = baselineRecord('1')
    store.writeSchedule(
      ADDRESS,
      { requestId: 'sys-schedule-first', commandType: 'system.schedule', payloadHash: 'sha256:first-payload' },
      {
        flowId: flowId as FlowId,
        taskRunId: taskRun.task_run_id,
        attemptId: 'xhba_first' as AttemptId,
        attemptDigest: 'sha256:first-attempt',
        compositionDigest: 'sha256:first-composition',
        ...firstBaseline,
        workspacePrepareRequestDigest: 'sha256:first-workspace-prepare',
        projection,
        receipt: {
          requestId: 'sys-schedule-first',
          intentType: 'system.schedule',
          sessionVersion: 0,
          flowId: flowId as FlowId,
          taskRunId: taskRun.task_run_id,
          attemptId: 'xhba_first' as AttemptId,
        },
        now: '2026-08-17T00:00:00.000Z',
      },
    )
    const oldRow = flowBaselineRow(dbPath, flowId as FlowId)
    const beforeCounts = store.tableCounts()
    expect(() =>
      store.writeSchedule(
        ADDRESS,
        { requestId: 'sys-schedule-drift', commandType: 'system.schedule', payloadHash: 'sha256:drift-payload' },
        {
          flowId: flowId as FlowId,
          taskRunId: taskRun.task_run_id as TaskRunId,
          attemptId: 'xhba_drift' as AttemptId,
          attemptDigest: 'sha256:drift-attempt',
          compositionDigest: 'sha256:drift-composition',
          ...baselineRecord('2'),
          workspacePrepareRequestDigest: 'sha256:drift-workspace-prepare',
          projection,
          receipt: {
            requestId: 'sys-schedule-drift',
            intentType: 'system.schedule',
            sessionVersion: 0,
            flowId: flowId as FlowId,
            taskRunId: taskRun.task_run_id,
            attemptId: 'xhba_drift' as AttemptId,
          },
          now: '2026-08-17T00:00:01.000Z',
        },
      ),
    ).toThrow('BASELINE_CONFLICT')
    expect(store.tableCounts()).toEqual(beforeCounts)
    store.close()
    expect(flowBaselineRow(dbPath, flowId as FlowId)).toEqual(oldRow)
  })

  it('upgrades legacy v2 tables to schema v3 with private M2B2 tables and claim columns', async () => {
    const dbPath = await tempDb()
    const db = new DatabaseSync(dbPath)
    db.exec(`
      create table schema_migrations (version integer primary key, applied_at text not null);
      insert into schema_migrations (version, applied_at) values (1, 'legacy'), (2, 'legacy');
      create table flow_execution_baselines (
        flow_id text primary key,
        baseline_id text not null,
        baseline_tree_hash text not null,
        initial_target_fingerprint text not null,
        baseline_digest text not null,
        baseline_binding_digest text not null,
        created_at text not null
      );
      create table workspace_prepare_outbox (
        outbox_id text primary key,
        attempt_id text not null,
        request_digest text not null,
        status text not null,
        created_at text not null,
        completed_at text,
        unique(attempt_id)
      );
    `)
    db.close()

    const store = new CollaborationHubSqliteStoreV1(dbPath)
    store.close()

    const migrated = new DatabaseSync(dbPath)
    try {
      expect(migrated.prepare('select version from schema_migrations order by version').all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ])
      expect(migrated.prepare('pragma table_info(flow_execution_baselines)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'base_revision' })]),
      )
      expect(migrated.prepare('pragma table_info(workspace_prepare_outbox)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'claim_owner_id' }),
          expect.objectContaining({ name: 'claim_digest' }),
          expect.objectContaining({ name: 'claimed_at' }),
        ]),
      )
      expect(
        migrated
          .prepare(`select name from sqlite_master where type = 'table' and name in (${privateM2B2Tables().map(() => '?').join(',')}) order by name`)
          .all(...privateM2B2Tables()),
      ).toEqual([
        { name: 'attempt_file_manifests' },
        { name: 'attempt_workspace_leases' },
        { name: 'attempt_workspace_prepared' },
        { name: 'create_batches' },
        { name: 'private_runtime_payloads' },
        { name: 'scope_expansion_requests' },
      ])
      expect(migrated.prepare("select name from sqlite_master where type = 'index' and name = 'attempt_workspace_leases_conflict_digest'").get()).toEqual({
        name: 'attempt_workspace_leases_conflict_digest',
      })
    } finally {
      migrated.close()
    }
  })

  it('roundtrips baseRevision and claims workspace prepare outbox by SQLite CAS', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const projection = store.readProjection(ADDRESS)
    const taskRun = store.taskRuns(flowId as FlowId)[0]
    if (!projection || !taskRun) throw new Error('missing active plan')

    const record = scheduleRecord({
      flowId: flowId as FlowId,
      taskRunId: taskRun.task_run_id,
      attemptId: 'xhba_claim' as AttemptId,
      suffix: 'a',
      projection,
    })
    store.writeSchedule(
      ADDRESS,
      { requestId: 'sys-schedule-claim', commandType: 'system.schedule', payloadHash: 'sha256:claim-payload' },
      record,
    )
    expect(store.flowExecutionBaseline(flowId as FlowId)).toMatchObject({
      base_revision: record.baseRevision,
      baseline_tree_hash: record.baselineTreeHash,
    })

    const firstClaim = store.claimWorkspacePrepareOutbox({
      attemptId: 'xhba_claim' as AttemptId,
      ownerId: 'owner-a',
      claimDigest: 'sha256:claim-a',
      now: '2026-08-17T00:00:01.000Z',
    })
    expect(firstClaim).toMatchObject({
      attemptId: 'xhba_claim',
      status: 'CLAIMED',
      claimOwnerId: 'owner-a',
      claimDigest: 'sha256:claim-a',
      claimedAt: '2026-08-17T00:00:01.000Z',
    })
    expect(
      store.claimWorkspacePrepareOutbox({
        attemptId: 'xhba_claim' as AttemptId,
        ownerId: 'owner-a',
        claimDigest: 'sha256:claim-a',
        now: '2026-08-17T00:00:02.000Z',
      }),
    ).toEqual(firstClaim)
    expect(
      store.claimWorkspacePrepareOutbox({
        attemptId: 'xhba_claim' as AttemptId,
        ownerId: 'owner-b',
        claimDigest: 'sha256:claim-b',
        now: '2026-08-17T00:00:03.000Z',
      }),
    ).toBeNull()
    store.close()
  })

  it('does not claim DONE or FAILED workspace prepare rows', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const projection = store.readProjection(ADDRESS)
    const taskRun = store.taskRuns(flowId as FlowId)[0]
    if (!projection || !taskRun) throw new Error('missing active plan')
    store.writeSchedule(
      ADDRESS,
      { requestId: 'sys-schedule-done', commandType: 'system.schedule', payloadHash: 'sha256:done-payload' },
      scheduleRecord({
        flowId: flowId as FlowId,
        taskRunId: taskRun.task_run_id,
        attemptId: 'xhba_done' as AttemptId,
        suffix: 'd',
        projection,
      }),
    )
    store.writeWorkspacePrepared(
      ADDRESS,
      { requestId: 'sys-workspace-done', commandType: 'system.workspace.prepare.result.record', payloadHash: 'sha256:done-receipt' },
      {
        flowId: flowId as FlowId,
        taskRunId: taskRun.task_run_id,
        attemptId: 'xhba_done' as AttemptId,
        receipt: {
          requestId: 'sys-workspace-done',
          intentType: 'system.workspace.prepare.result.record',
          sessionVersion: 0,
          flowId: flowId as FlowId,
          taskRunId: taskRun.task_run_id,
          attemptId: 'xhba_done' as AttemptId,
        },
        workspaceReceipt: {
          status: 'PREPARED',
          workspaceReceiptId: 'xhbw_done' as never,
          receiptDigest: 'sha256:done-workspace-receipt',
          compositionAttemptId: 'xhbc_xhba_done',
          attemptId: 'xhba_done' as AttemptId,
          requestDigest: 'sha256:d-workspace-prepare',
          baselineBindingDigest: 'sha256:baseline-binding-d',
          compositionDigest: 'sha256:d-composition',
        },
        now: '2026-08-17T00:00:01.000Z',
      },
    )
    expect(store.workspacePrepareOutboxStatus('xhba_done' as AttemptId)).toBe('DONE')
    expect(
      store.claimWorkspacePrepareOutbox({
        attemptId: 'xhba_done' as AttemptId,
        ownerId: 'owner-late',
        claimDigest: 'sha256:late',
        now: '2026-08-17T00:00:02.000Z',
      }),
    ).toBeNull()
    store.close()
  })
})

describe('M4C task verification persistence', () => {
  it('begins idempotently, claims by CAS, and atomically seals a passed TASK verification', async () => {
    const dbPath = await tempDb('verification-pass.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'pass')
    const first = fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
    expect(first).toEqual({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      outboxId: `xhbvo_${fixture.verificationRequest.verificationAttemptId}`,
      replayed: false,
    })
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('VERIFYING')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFYING')
    expect(fixture.store.readProjectionM2B(ADDRESS)?.attempts[0]?.verificationSummary).toMatchObject({
      state: 'STARTED',
      candidateId: fixture.candidate.candidateId,
      changeSetDigest: fixture.candidate.proposedChangeSetDigest,
    })
    expect(fixture.store.tableCounts()).toMatchObject({
      artifacts: 1,
      change_set_candidates: 1,
      agent_succeeded_audits: 1,
      verification_attempts: 1,
      verification_outbox: 1,
      verification_receipts: 0,
      task_evidence_bundles: 0,
      task_qa_results: 0,
      task_change_sets: 0,
    })
    const beforeReplayVersion = fixture.store.currentVersion(ADDRESS)
    expect(fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)).toMatchObject({ replayed: true })
    expect(fixture.store.currentVersion(ADDRESS)).toBe(beforeReplayVersion)

    const claimed = fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-worker-1',
      claimDigest: 'sha256:verification-claim-pass',
      now: '2026-08-17T00:00:02.500Z',
    })
    expect(claimed).toMatchObject({
      status: 'CLAIMED',
      claimOwnerId: 'verification-worker-1',
      claimDigest: 'sha256:verification-claim-pass',
    })
    expect(
      fixture.store.claimVerificationOutbox({
        verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
        ownerId: 'verification-worker-2',
        claimDigest: 'sha256:verification-claim-conflict',
        now: '2026-08-17T00:00:02.600Z',
      }),
    ).toBeNull()

    const completion = passedCompletion(fixture)
    expect(fixture.store.completeTaskVerification(ADDRESS, completion)).toEqual({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      verdict: 'PASS',
      replayed: false,
    })
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('SUCCEEDED')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFIED')
    expect(fixture.store.readProjectionM2B(ADDRESS)?.attempts[0]?.verificationSummary).toMatchObject({
      state: 'SUCCEEDED',
      verdict: 'PASS',
      taskChangeSetId: completion.taskChangeSet?.taskChangeSetId,
      checks: [{ checkId: 'typecheck', verdict: 'PASS', summary: '固定类型检查通过' }],
      evidenceArtifacts: [
        expect.objectContaining({ kind: 'QA_EVIDENCE', artifactId: completion.evidenceArtifacts?.[0]?.artifactId }),
      ],
    })
    expect(fixture.store.readVerificationOutbox(fixture.verificationRequest.verificationAttemptId)).toMatchObject({
      status: 'DONE',
      completedAt: completion.now,
    })
    expect(fixture.store.tableCounts()).toMatchObject({
      artifacts: 2,
      change_set_candidates: 1,
      verification_attempts: 1,
      verification_outbox: 1,
      verification_receipts: 1,
      task_evidence_bundles: 1,
      task_qa_results: 1,
      task_change_sets: 1,
    })
    const sealedCounts = fixture.store.tableCounts()
    const sealedVersion = fixture.store.currentVersion(ADDRESS)
    expect(
      fixture.store.completeTaskVerification(ADDRESS, {
        receipt: completion.receipt,
        now: '2026-08-17T00:00:04.000Z',
      }),
    ).toMatchObject({ replayed: true })
    expect(fixture.store.tableCounts()).toEqual(sealedCounts)
    expect(fixture.store.currentVersion(ADDRESS)).toBe(sealedVersion)
    fixture.store.close()
  })

  it('atomically starts verification from a reconciled SUCCEEDED runtime outcome', async () => {
    const dbPath = await tempDb('verification-reconcile.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'reconcile')
    setAttemptOutcomeUnknown(
      dbPath,
      fixture.attemptId,
      fixture.taskRunId,
      'runtime-reconcile',
      'sha256:unknown-before-reconcile',
    )
    const record: BeginTaskVerificationRecordV1 = {
      ...fixture.beginRecord,
      reconcileStart: {
        idempotency: {
          requestId: 'sys-agent-reconcile-success',
          commandType: 'system.agent.reconcile',
          payloadHash: 'sha256:reconcile-payload',
        },
        receipt: {
          requestId: 'sys-agent-reconcile-success',
          intentType: 'system.agent.reconcile',
          sessionVersion: 0,
          attemptId: fixture.attemptId,
        },
        runtimeSessionId: 'runtime-reconcile',
        expectedReceiptDigest: 'sha256:unknown-before-reconcile',
        receiptDigest: fixture.beginRecord.succeededAudit.receiptDigest,
      },
    }

    const result = fixture.store.beginTaskVerification(ADDRESS, record)
    expect(result).toMatchObject({ replayed: false })
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('VERIFYING')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFYING')
    expect(fixture.store.idempotency(ADDRESS, 'sys-agent-reconcile-success')).toMatchObject({
      command_type: 'system.agent.reconcile',
      payload_hash: 'sha256:reconcile-payload',
    })
    expect(fixture.store.tableCounts()).toMatchObject({
      agent_reconcile_results: 1,
      agent_succeeded_audits: 1,
      change_set_candidates: 1,
      verification_attempts: 1,
      verification_outbox: 1,
    })
    const version = fixture.store.currentVersion(ADDRESS)
    const counts = fixture.store.tableCounts()
    expect(fixture.store.beginTaskVerification(ADDRESS, record)).toMatchObject({ replayed: true })
    expect(fixture.store.currentVersion(ADDRESS)).toBe(version)
    expect(fixture.store.tableCounts()).toEqual(counts)
    expect(() =>
      fixture.store.beginTaskVerification(ADDRESS, {
        ...record,
        reconcileStart: {
          ...record.reconcileStart!,
          idempotency: {
            ...record.reconcileStart!.idempotency,
            payloadHash: 'sha256:different-reconcile-payload',
          },
        },
      }),
    ).toThrow('TASK_VERIFICATION_IDEMPOTENCY_CONFLICT')
    expect(fixture.store.currentVersion(ADDRESS)).toBe(version)
    expect(fixture.store.tableCounts()).toEqual(counts)
    fixture.store.close()
  })

  it('lists only READY or CLAIMED STARTED verification outboxes for restart recovery', async () => {
    const dbPath = await tempDb('verification-pending.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'pending')
    fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)

    expect(fixture.store.pendingTaskVerifications()).toEqual([
      {
        address: ADDRESS,
        outbox: expect.objectContaining({
          verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
          status: 'READY',
        }),
      },
    ])

    fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-recovery-worker',
      claimDigest: 'sha256:verification-recovery-claim',
      now: '2026-08-17T00:00:02.500Z',
    })
    expect(fixture.store.pendingTaskVerifications()).toEqual([
      {
        address: ADDRESS,
        outbox: expect.objectContaining({
          verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
          status: 'CLAIMED',
          claimOwnerId: 'verification-recovery-worker',
        }),
      },
    ])

    const receiptWithoutDigest = {
      scope: 'TASK' as const,
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      verificationRequestId: fixture.verificationRequest.verificationRequestId,
      flowId: fixture.flowId,
      taskRunId: fixture.taskRunId,
      attemptId: fixture.attemptId,
      candidateId: fixture.candidate.candidateId,
      requestDigest: fixture.verificationRequest.requestDigest,
      changeSetDigest: fixture.candidate.proposedChangeSetDigest,
      qaConfigVersion: fixture.verificationRequest.qaConfigVersion,
      diagnosticArtifactIds: [] as readonly ArtifactId[],
      verdict: 'OUTCOME_UNKNOWN' as const,
      reason: '重启后无法证明固定验证进程结果',
    }
    fixture.store.completeTaskVerification(ADDRESS, {
      receipt: {
        ...receiptWithoutDigest,
        receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
      },
      now: '2026-08-17T00:00:03.000Z',
    })
    expect(fixture.store.pendingTaskVerifications()).toEqual([])
    fixture.store.close()
  })

  it('exposes the same authoritative ancestor order used by verification begin', async () => {
    const dbPath = await tempDb('verification-lineage.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'lineage')
    expect(
      fixture.store.taskChangeSetAncestorIds(ADDRESS, fixture.flowId, fixture.taskRunId),
    ).toEqual([])

    fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
    fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-lineage-worker',
      claimDigest: 'sha256:verification-lineage-claim',
      now: '2026-08-17T00:00:02.500Z',
    })
    const completion = passedCompletion(fixture)
    fixture.store.completeTaskVerification(ADDRESS, completion)

    const successor = fixture.store.taskRuns(fixture.flowId).find((taskRun) => taskRun.task_key === 'b')
    if (!successor || !completion.taskChangeSet) throw new Error('missing successor lineage')
    expect(
      fixture.store.taskChangeSetAncestorIds(ADDRESS, fixture.flowId, successor.task_run_id),
    ).toEqual([completion.taskChangeSet.taskChangeSetId])
    expect(() =>
      fixture.store.taskChangeSetAncestorIds(
        { ...ADDRESS, sessionKey: `xgs1_${'9'.repeat(64)}` } as HubAddressV1,
        fixture.flowId,
        successor.task_run_id,
      ),
    ).toThrow('TASK_VERIFICATION_SCOPE_MISMATCH')
    fixture.store.close()
  })

  it('rolls back every seal write when a receipt binding drifts', async () => {
    const dbPath = await tempDb('verification-mismatch.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'mismatch')
    fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
    fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-worker-mismatch',
      claimDigest: 'sha256:verification-claim-mismatch',
      now: '2026-08-17T00:00:02.500Z',
    })
    const completion = passedCompletion(fixture)
    const receiptWithoutDigest = {
      ...completion.receipt,
      qaConfigVersion: 'drifted-qa-config',
    }
    const { receiptDigest: _ignored, ...canonicalReceipt } = receiptWithoutDigest
    const drifted: CompleteTaskVerificationRecordV1 = {
      ...completion,
      receipt: {
        ...canonicalReceipt,
        receiptDigest: verificationReceiptDigestV1(canonicalReceipt),
      } as TaskVerificationReceiptV1,
    }
    const beforeCounts = fixture.store.tableCounts()
    const beforeVersion = fixture.store.currentVersion(ADDRESS)
    expect(() => fixture.store.completeTaskVerification(ADDRESS, drifted)).toThrow('TASK_VERIFICATION_BINDING_MISMATCH')
    expect(fixture.store.tableCounts()).toEqual(beforeCounts)
    expect(fixture.store.currentVersion(ADDRESS)).toBe(beforeVersion)
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('VERIFYING')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFYING')
    fixture.store.close()
  })

  it.each(['FAIL', 'OUTCOME_UNKNOWN'] as const)(
    'persists %s diagnostics without sealing evidence, QA, or a TASK ChangeSet',
    async (verdict) => {
      const dbPath = await tempDb(`verification-${verdict.toLowerCase()}.sqlite`)
      const fixture = await startedTaskVerification(dbPath, verdict.toLowerCase())
      fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
      fixture.store.claimVerificationOutbox({
        verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
        ownerId: `verification-worker-${verdict.toLowerCase()}`,
        claimDigest: `sha256:verification-claim-${verdict.toLowerCase()}`,
        now: '2026-08-17T00:00:02.500Z',
      })
      const receiptWithoutDigest =
        verdict === 'FAIL'
          ? {
              scope: 'TASK' as const,
              verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
              verificationRequestId: fixture.verificationRequest.verificationRequestId,
              flowId: fixture.flowId,
              taskRunId: fixture.taskRunId,
              attemptId: fixture.attemptId,
              candidateId: fixture.candidate.candidateId,
              requestDigest: fixture.verificationRequest.requestDigest,
              changeSetDigest: fixture.candidate.proposedChangeSetDigest,
              qaConfigVersion: fixture.verificationRequest.qaConfigVersion,
              diagnosticArtifactIds: [] as readonly ArtifactId[],
              verdict: 'FAIL' as const,
              checks: [
                {
                  checkId: 'typecheck',
                  summary: '固定类型检查失败',
                  artifactIds: [] as readonly ArtifactId[],
                  verdict: 'FAIL' as const,
                },
              ] as const,
              evidenceArtifactIds: [] as readonly ArtifactId[],
              failure: {
                source: 'QA_CHECKS_FAILED' as const,
                failureClass: 'TEST_FAILURE' as const,
                disposition: 'REQUIRE_HUMAN_GATE' as const,
                retryOrdinal: 0 as const,
                safeCode: 'QA_CHECK_FAILED' as const,
              },
              reason: '固定检查未通过',
            }
          : {
              scope: 'TASK' as const,
              verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
              verificationRequestId: fixture.verificationRequest.verificationRequestId,
              flowId: fixture.flowId,
              taskRunId: fixture.taskRunId,
              attemptId: fixture.attemptId,
              candidateId: fixture.candidate.candidateId,
              requestDigest: fixture.verificationRequest.requestDigest,
              changeSetDigest: fixture.candidate.proposedChangeSetDigest,
              qaConfigVersion: fixture.verificationRequest.qaConfigVersion,
              diagnosticArtifactIds: [] as readonly ArtifactId[],
              verdict: 'OUTCOME_UNKNOWN' as const,
              reason: '验证进程结果不可证明',
            }
      const receipt = {
        ...receiptWithoutDigest,
        receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
      } as TaskVerificationReceiptV1
      fixture.store.completeTaskVerification(ADDRESS, {
        receipt,
        now: '2026-08-17T00:00:03.000Z',
      })
      const expectedState = verdict === 'FAIL' ? 'FAILED' : 'OUTCOME_UNKNOWN'
      expect(fixture.store.attempt(fixture.attemptId)?.status).toBe(expectedState)
      expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe(expectedState)
      expect(fixture.store.tableCounts()).toMatchObject({
        verification_receipts: 1,
        task_evidence_bundles: 0,
        task_qa_results: 0,
        task_change_sets: 0,
      })
      fixture.store.close()
    },
  )
})
