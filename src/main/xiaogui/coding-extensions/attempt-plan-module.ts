import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type {
  CodingPlanBindAttemptCommandV1,
  CodingPlanBodyV1,
  CodingPlanCommandOutcomeV1,
  CodingPlanDraftV1,
  CodingPlanLifecycleStateV1,
  CodingPlanPendingDraftReceiptV1,
  CodingPlanPendingDraftV1,
  CodingPlanProjectionV1,
  CodingPlanReviseCommandV1,
  CodingPlanSourceV1,
  CodingPlanTodoCommandV1,
  CodingPlanTodoStatusV1,
  CodingPlanVersionCommandV1,
} from '@shared/xiaogui-coding-extension-pack'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

const FALLBACK_CONSTRAINT = '此计划由任务目标生成，执行前必须人工确认。'

export interface CodingAttemptPlanModuleOptionsV1 {
  readonly dbPath: string
  readonly idFactory?: () => string
  readonly now?: () => string
}

interface AttemptPlanRowV1 {
  readonly attempt_id: string
  readonly project_id: string
  readonly session_key: string
  readonly source: CodingPlanSourceV1
  readonly lifecycle_state: CodingPlanLifecycleStateV1
  readonly revision: number
  readonly plan_json: string
  readonly plan_digest: string
}

interface PendingPlanRowV1 {
  readonly body_json: string
  readonly draft_digest: string
}

/**
 * TaskHub-owned deep Module for one Attempt's execution plan.
 *
 * Pi contributes only a pending draft. Once bound, TaskHub owns revision,
 * approval, execution locking and Todo state. No Flow DAG tables are touched.
 */
export class CodingAttemptPlanModuleV1 {
  private readonly db: DatabaseSync
  private readonly idFactory: () => string
  private readonly now: () => string

  constructor(options: CodingAttemptPlanModuleOptionsV1) {
    this.idFactory = options.idFactory ?? (() => `plan_${randomUUID()}`)
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      create table if not exists xiaogui_coding_pending_plan_v1 (
        project_id text not null,
        session_key text not null,
        body_json text not null,
        draft_digest text not null,
        updated_at text not null,
        primary key (project_id, session_key)
      );
      create table if not exists xiaogui_coding_attempt_plan_v1 (
        attempt_id text primary key,
        project_id text not null,
        session_key text not null,
        source text not null,
        lifecycle_state text not null,
        revision integer not null,
        plan_json text not null,
        plan_digest text not null,
        updated_at text not null
      );
    `)
  }

  savePendingDraft(input: CodingPlanPendingDraftV1): CodingPlanPendingDraftReceiptV1 {
    const address = canonicalAddress(input.address)
    const body = canonicalBody(input.body)
    if (input.schemaVersion !== 1 || !address || !body) {
      return { ok: false, error: 'INVALID_COMMAND' }
    }
    const bodyJson = JSON.stringify(body)
    const draftDigest = digestJson(body)
    this.db.prepare(`
      insert into xiaogui_coding_pending_plan_v1
        (project_id, session_key, body_json, draft_digest, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(project_id, session_key) do update set
        body_json = excluded.body_json,
        draft_digest = excluded.draft_digest,
        updated_at = excluded.updated_at
    `).run(address.projectId, address.sessionKey, bodyJson, draftDigest, this.now())
    return { ok: true, draftDigest }
  }

  publishPendingDraft(input: CodingPlanPendingDraftV1): CodingPlanPendingDraftReceiptV1 {
    return this.savePendingDraft(input)
  }

  /** Structural implementation of TaskExecutionAttemptPlanGateV1. */
  async ensureAttemptPlan(input: {
    readonly address: SessionAddressV1
    readonly attemptId: string
    readonly objective: string
    readonly taskTitle?: string
    readonly taskSummary?: string
  }): Promise<void> {
    const taskObjective = input.taskTitle
      ? `${input.taskTitle}${input.taskSummary ? `：${input.taskSummary}` : ''}`
      : input.objective
    const outcome = this.bindAttempt({
      schemaVersion: 1,
      address: input.address,
      attemptId: input.attemptId,
      taskObjective,
    })
    if (!outcome.ok) throw new Error(`CODING_PLAN_${outcome.error}`)
  }

  async isAttemptPlanApproved(attemptId: string): Promise<boolean> {
    const state = this.getProjection(attemptId)?.state
    return state === 'APPROVED' || state === 'EXECUTING'
  }

  async markAttemptExecutionStarted(attemptId: string): Promise<void> {
    const projection = this.getProjection(attemptId)
    if (!projection) throw new Error('CODING_PLAN_PLAN_NOT_FOUND')
    if (projection.state === 'EXECUTING') return
    const outcome = this.startExecution({
      schemaVersion: 1,
      attemptId,
      expectedRevision: projection.plan.revision,
      expectedPlanDigest: projection.planDigest,
    })
    if (!outcome.ok) throw new Error(`CODING_PLAN_${outcome.error}`)
  }

  bindAttempt(command: CodingPlanBindAttemptCommandV1): CodingPlanCommandOutcomeV1 {
    const address = canonicalAddress(command.address)
    const taskObjective = canonicalText(command.taskObjective, 8_000)
    if (command.schemaVersion !== 1 || !address || !safeId(command.attemptId) || !taskObjective) {
      return { ok: false, error: 'INVALID_COMMAND' }
    }

    const existing = this.readRow(command.attemptId)
    if (existing) {
      if (existing.project_id !== address.projectId || existing.session_key !== address.sessionKey) {
        return { ok: false, error: 'INVALID_COMMAND' }
      }
      return { ok: true, projection: projectionFromRow(existing) }
    }

    this.db.exec('begin immediate')
    try {
      const pending = this.db.prepare(`
        select body_json, draft_digest
        from xiaogui_coding_pending_plan_v1
        where project_id = ? and session_key = ?
      `).get(address.projectId, address.sessionKey) as PendingPlanRowV1 | undefined
      const pendingBody = pending ? parseBody(pending.body_json) : null
      const source: CodingPlanSourceV1 = pendingBody ? 'PI_DRAFT' : 'TASK_OBJECTIVE_FALLBACK'
      const body = pendingBody ?? fallbackBody(taskObjective)
      const plan = createPlan(this.idFactory(), command.attemptId, body)
      if (!safeId(plan.planId)) throw new Error('INVALID_PLAN_ID')
      const planJson = JSON.stringify(plan)
      const planDigest = digestJson(plan)
      this.db.prepare(`
        insert into xiaogui_coding_attempt_plan_v1
          (attempt_id, project_id, session_key, source, lifecycle_state,
           revision, plan_json, plan_digest, updated_at)
        values (?, ?, ?, ?, 'AWAITING_APPROVAL', ?, ?, ?, ?)
      `).run(
        command.attemptId,
        address.projectId,
        address.sessionKey,
        source,
        plan.revision,
        planJson,
        planDigest,
        this.now(),
      )
      if (source === 'PI_DRAFT') {
        this.db.prepare(`
          delete from xiaogui_coding_pending_plan_v1
          where project_id = ? and session_key = ? and draft_digest = ?
        `).run(address.projectId, address.sessionKey, pending!.draft_digest)
      }
      this.db.exec('commit')
      return {
        ok: true,
        projection: {
          schemaVersion: 1,
          attemptId: command.attemptId,
          source,
          state: 'AWAITING_APPROVAL',
          plan,
          planDigest,
        },
      }
    } catch {
      rollbackQuietly(this.db)
      const raced = this.readRow(command.attemptId)
      return raced && raced.project_id === address.projectId && raced.session_key === address.sessionKey
        ? { ok: true, projection: projectionFromRow(raced) }
        : { ok: false, error: 'INVALID_COMMAND' }
    }
  }

  getProjection(attemptId: string): CodingPlanProjectionV1 | null {
    if (!safeId(attemptId)) return null
    const row = this.readRow(attemptId)
    return row ? projectionFromRow(row) : null
  }

  observe(address: SessionAddressV1): readonly CodingPlanProjectionV1[] {
    const canonical = canonicalAddress(address)
    if (!canonical) return []
    const rows = this.db.prepare(`
      select attempt_id, project_id, session_key, source, lifecycle_state,
             revision, plan_json, plan_digest
      from xiaogui_coding_attempt_plan_v1
      where project_id = ? and session_key = ?
      order by attempt_id asc
    `).all(canonical.projectId, canonical.sessionKey) as unknown as AttemptPlanRowV1[]
    return rows.map(projectionFromRow)
  }

  revise(command: CodingPlanReviseCommandV1): CodingPlanCommandOutcomeV1 {
    const body = canonicalBody(command.body)
    if (command.schemaVersion !== 1 || !safeId(command.attemptId) || !body) {
      return { ok: false, error: 'INVALID_COMMAND' }
    }
    const row = this.readRow(command.attemptId)
    if (!row) return { ok: false, error: 'PLAN_NOT_FOUND' }
    if (row.lifecycle_state === 'EXECUTING') return { ok: false, error: 'PLAN_BODY_LOCKED' }
    const versionError = checkVersion(row, command)
    if (versionError) return versionError
    const current = parsePlan(row.plan_json)
    if (!current) return { ok: false, error: 'INVALID_COMMAND' }
    const next: CodingPlanDraftV1 = {
      schemaVersion: 1,
      planId: current.planId,
      attemptId: current.attemptId,
      objective: body.objective,
      steps: body.steps.map((step) => ({ ...step, status: 'PENDING' as const })),
      constraints: body.constraints,
      revision: current.revision + 1,
    }
    return this.writeMutation(row, next, 'AWAITING_APPROVAL')
  }

  approve(command: CodingPlanVersionCommandV1): CodingPlanCommandOutcomeV1 {
    const rowOrError = this.versionedRow(command)
    if ('ok' in rowOrError) return rowOrError
    const row = rowOrError
    if (row.lifecycle_state === 'EXECUTING') return { ok: false, error: 'PLAN_BODY_LOCKED' }
    if (row.lifecycle_state === 'APPROVED') return { ok: true, projection: projectionFromRow(row) }
    return this.advanceState(row, 'APPROVED')
  }

  startExecution(command: CodingPlanVersionCommandV1): CodingPlanCommandOutcomeV1 {
    const rowOrError = this.versionedRow(command)
    if ('ok' in rowOrError) return rowOrError
    const row = rowOrError
    if (row.lifecycle_state === 'EXECUTING') return { ok: true, projection: projectionFromRow(row) }
    if (row.lifecycle_state !== 'APPROVED') return { ok: false, error: 'PLAN_NOT_APPROVED' }
    return this.advanceState(row, 'EXECUTING')
  }

  transitionTodo(command: CodingPlanTodoCommandV1): CodingPlanCommandOutcomeV1 {
    if (
      command.schemaVersion !== 1 ||
      !safeId(command.attemptId) ||
      !safeId(command.stepId) ||
      !isTodoStatus(command.nextStatus)
    ) return { ok: false, error: 'INVALID_COMMAND' }
    const row = this.readRow(command.attemptId)
    if (!row) return { ok: false, error: 'PLAN_NOT_FOUND' }
    const versionError = checkVersion(row, command)
    if (versionError) return versionError
    if (row.lifecycle_state !== 'EXECUTING') return { ok: false, error: 'PLAN_NOT_APPROVED' }
    const plan = parsePlan(row.plan_json)
    if (!plan) return { ok: false, error: 'INVALID_COMMAND' }
    const index = plan.steps.findIndex((step) => step.stepId === command.stepId)
    if (index < 0) return { ok: false, error: 'TODO_NOT_FOUND' }
    const currentStatus = plan.steps[index]!.status
    if (currentStatus === command.nextStatus) return { ok: true, projection: projectionFromRow(row) }
    if (!isAllowedTodoTransition(currentStatus, command.nextStatus)) {
      return { ok: false, error: 'INVALID_TODO_TRANSITION' }
    }
    const steps = plan.steps.map((step, stepIndex) => stepIndex === index
      ? { ...step, status: command.nextStatus }
      : step)
    const next: CodingPlanDraftV1 = { ...plan, steps, revision: plan.revision + 1 }
    return this.writeMutation(row, next, row.lifecycle_state)
  }

  close(): void {
    this.db.close()
  }

  private versionedRow(
    command: CodingPlanVersionCommandV1,
  ): AttemptPlanRowV1 | Extract<CodingPlanCommandOutcomeV1, { ok: false }> {
    if (command.schemaVersion !== 1 || !safeId(command.attemptId)) {
      return { ok: false, error: 'INVALID_COMMAND' }
    }
    const row = this.readRow(command.attemptId)
    if (!row) return { ok: false, error: 'PLAN_NOT_FOUND' }
    return checkVersion(row, command) ?? row
  }

  private advanceState(
    row: AttemptPlanRowV1,
    state: CodingPlanLifecycleStateV1,
  ): CodingPlanCommandOutcomeV1 {
    const plan = parsePlan(row.plan_json)
    if (!plan) return { ok: false, error: 'INVALID_COMMAND' }
    return this.writeMutation(row, { ...plan, revision: plan.revision + 1 }, state)
  }

  private writeMutation(
    row: AttemptPlanRowV1,
    plan: CodingPlanDraftV1,
    state: CodingPlanLifecycleStateV1,
  ): CodingPlanCommandOutcomeV1 {
    const planJson = JSON.stringify(plan)
    const planDigest = digestJson(plan)
    const result = this.db.prepare(`
      update xiaogui_coding_attempt_plan_v1
      set lifecycle_state = ?, revision = ?, plan_json = ?, plan_digest = ?, updated_at = ?
      where attempt_id = ? and revision = ? and plan_digest = ?
    `).run(
      state,
      plan.revision,
      planJson,
      planDigest,
      this.now(),
      row.attempt_id,
      row.revision,
      row.plan_digest,
    )
    if (result.changes !== 1) return { ok: false, error: 'VERSION_CONFLICT' }
    return {
      ok: true,
      projection: {
        schemaVersion: 1,
        attemptId: row.attempt_id,
        source: row.source,
        state,
        plan,
        planDigest,
      },
    }
  }

  private readRow(attemptId: string): AttemptPlanRowV1 | undefined {
    return this.db.prepare(`
      select attempt_id, project_id, session_key, source, lifecycle_state,
             revision, plan_json, plan_digest
      from xiaogui_coding_attempt_plan_v1 where attempt_id = ?
    `).get(attemptId) as AttemptPlanRowV1 | undefined
  }
}

function canonicalAddress(address: SessionAddressV1): SessionAddressV1 | null {
  if (
    !address ||
    !/^xgp1_[a-f0-9]{64}$/i.test(address.projectId) ||
    !/^xgs1_[a-f0-9]{64}$/i.test(address.sessionKey)
  ) return null
  return { projectId: address.projectId, sessionKey: address.sessionKey }
}

function canonicalBody(body: CodingPlanBodyV1): CodingPlanBodyV1 | null {
  if (!body || !Array.isArray(body.steps) || !Array.isArray(body.constraints)) return null
  const objective = canonicalText(body.objective, 8_000)
  if (!objective || body.steps.length === 0 || body.steps.length > 128 || body.constraints.length > 128) {
    return null
  }
  const steps: CodingPlanBodyV1['steps'][number][] = []
  const stepIds = new Set<string>()
  for (const step of body.steps) {
    const title = canonicalText(step?.title, 1_000)
    const validation = canonicalText(step?.validation, 2_000)
    if (!safeId(step?.stepId) || stepIds.has(step.stepId) || !title || !validation) return null
    stepIds.add(step.stepId)
    steps.push({ stepId: step.stepId, title, validation })
  }
  const constraints: string[] = []
  for (const raw of body.constraints) {
    const constraint = canonicalText(raw, 2_000)
    if (!constraint) return null
    constraints.push(constraint)
  }
  return { objective, steps, constraints }
}

function fallbackBody(taskObjective: string): CodingPlanBodyV1 {
  return {
    objective: taskObjective,
    steps: [{
      stepId: 'fallback_execute',
      title: '完成任务目标',
      validation: '按任务验收要求检查真实结果',
    }],
    constraints: [FALLBACK_CONSTRAINT],
  }
}

function createPlan(planId: string, attemptId: string, body: CodingPlanBodyV1): CodingPlanDraftV1 {
  return {
    schemaVersion: 1,
    planId,
    attemptId,
    objective: body.objective,
    steps: body.steps.map((step) => ({ ...step, status: 'PENDING' as const })),
    constraints: body.constraints,
    revision: 1,
  }
}

function projectionFromRow(row: AttemptPlanRowV1): CodingPlanProjectionV1 {
  const plan = parsePlan(row.plan_json)
  if (!plan || plan.revision !== row.revision || digestJson(plan) !== row.plan_digest) {
    throw new Error('CODING_PLAN_STORAGE_CORRUPT')
  }
  return {
    schemaVersion: 1,
    attemptId: row.attempt_id,
    source: row.source,
    state: row.lifecycle_state,
    plan,
    planDigest: row.plan_digest,
  }
}

function parseBody(json: string): CodingPlanBodyV1 | null {
  try {
    return canonicalBody(JSON.parse(json) as CodingPlanBodyV1)
  } catch {
    return null
  }
}

function parsePlan(json: string): CodingPlanDraftV1 | null {
  try {
    const value = JSON.parse(json) as CodingPlanDraftV1
    const body = canonicalBody(value)
    if (
      value.schemaVersion !== 1 ||
      !safeId(value.planId) ||
      !safeId(value.attemptId) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !body ||
      value.steps.some((step) => !isTodoStatus(step.status))
    ) return null
    return {
      schemaVersion: 1,
      planId: value.planId,
      attemptId: value.attemptId,
      objective: body.objective,
      steps: value.steps.map((step) => ({
        stepId: step.stepId,
        title: canonicalText(step.title, 1_000)!,
        validation: canonicalText(step.validation, 2_000)!,
        status: step.status,
      })),
      constraints: body.constraints,
      revision: value.revision,
    }
  } catch {
    return null
  }
}

function checkVersion(
  row: AttemptPlanRowV1,
  command: CodingPlanVersionCommandV1,
): Extract<CodingPlanCommandOutcomeV1, { ok: false }> | null {
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(command.expectedPlanDigest)
  ) return { ok: false, error: 'INVALID_COMMAND' }
  return row.revision === command.expectedRevision && row.plan_digest === command.expectedPlanDigest
    ? null
    : { ok: false, error: 'VERSION_CONFLICT' }
}

function isAllowedTodoTransition(
  current: CodingPlanTodoStatusV1,
  next: CodingPlanTodoStatusV1,
): boolean {
  if (current === 'PENDING') return next === 'IN_PROGRESS' || next === 'BLOCKED'
  if (current === 'IN_PROGRESS') return next === 'COMPLETED' || next === 'BLOCKED'
  if (current === 'BLOCKED') return next === 'PENDING' || next === 'IN_PROGRESS'
  return false
}

function isTodoStatus(value: unknown): value is CodingPlanTodoStatusV1 {
  return value === 'PENDING' || value === 'IN_PROGRESS' || value === 'COMPLETED' || value === 'BLOCKED'
}

function canonicalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return null
  }
  return text
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // No active transaction.
  }
}
