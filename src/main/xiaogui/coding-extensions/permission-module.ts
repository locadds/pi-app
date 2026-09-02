import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, posix } from 'node:path'

import type {
  CodingPermissionIntentV1,
  CodingPermissionPolicyEvaluationV1,
  CodingPermissionPromptV1,
  CodingPermissionUserChoiceV1,
} from '@shared/xiaogui-coding-extension-pack'
import { safeCodingPermissionDisplayMetadata } from './safe-display-metadata'

const DEFAULT_TIMEOUT_MS = 60_000
const FIXED_CHOICES = Object.freeze([
  'ALLOW_ONCE',
  'ALLOW_TASK_RULE',
  'DENY',
] as const)

export interface CodingPermissionUIPortV1 {
  request(prompt: CodingPermissionPromptV1): Promise<CodingPermissionUserChoiceV1>
}

export interface CodingPermissionPolicyPortV1 {
  /** TaskHub-owned policy; Renderer and Runtime must not implement this port. */
  evaluate(intent: CodingPermissionIntentV1): Promise<CodingPermissionPolicyEvaluationV1>
}

export interface CodingPermissionModuleOptionsV1 {
  readonly dbPath: string
  readonly ui: CodingPermissionUIPortV1
  readonly policy?: CodingPermissionPolicyPortV1
  readonly timeoutMs?: number
  readonly now?: () => string
}

/** TaskHub-owned permission Module. Renderer is only an interaction Adapter. */
export class CodingPermissionModuleV1 {
  private readonly db: DatabaseSync
  private readonly timeoutMs: number
  private readonly now: () => string

  constructor(private readonly options: CodingPermissionModuleOptionsV1) {
    this.timeoutMs = positiveTimeout(options.timeoutMs) ? options.timeoutMs! : DEFAULT_TIMEOUT_MS
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      create table if not exists xiaogui_coding_permission_rules_v1 (
        attempt_id text not null,
        rule_digest text not null,
        created_at text not null,
        primary key (attempt_id, rule_digest)
      );
      create table if not exists xiaogui_coding_permission_audit_v1 (
        request_digest text primary key,
        attempt_id text not null,
        rule_digest text not null,
        decision text not null,
        created_at text not null
      );
    `)
  }

  async decide(rawIntent: CodingPermissionIntentV1): Promise<'ALLOW_ONCE' | 'DENY'> {
    const intent = canonicalIntent(rawIntent)
    if (!intent) return 'DENY'
    const ruleDigest = permissionRuleDigest(intent)
    const policyEffect = await this.evaluatePolicy(intent)
    if (policyEffect === 'DENY') {
      this.audit(intent, ruleDigest, 'MODE_POLICY_DENIED')
      return 'DENY'
    }
    if (policyEffect === 'ALLOW_ONCE') {
      this.audit(intent, ruleDigest, 'MODE_POLICY_AUTO_ALLOWED')
      return 'ALLOW_ONCE'
    }
    if (this.hasTaskRule(intent.attemptId, ruleDigest)) {
      this.audit(intent, ruleDigest, 'ALLOW_TASK_RULE_REUSED')
      return 'ALLOW_ONCE'
    }

    const prompt: CodingPermissionPromptV1 = {
      schemaVersion: 1,
      operation: intent.operation,
      relativePaths: intent.relativePaths,
      dataEgress: intent.dataEgress,
      ...(intent.commandSummary ? { commandSummary: intent.commandSummary } : {}),
      ...(intent.egressDestination ? { egressDestination: intent.egressDestination } : {}),
      summary: permissionSummary(intent),
      choices: FIXED_CHOICES,
    }
    let choice: CodingPermissionUserChoiceV1
    try {
      choice = await withTimeout(this.options.ui.request(prompt), this.timeoutMs)
    } catch {
      choice = 'DENY'
    }
    if (!FIXED_CHOICES.includes(choice)) choice = 'DENY'
    if (choice === 'ALLOW_TASK_RULE') {
      this.db.prepare(`
        insert or ignore into xiaogui_coding_permission_rules_v1
          (attempt_id, rule_digest, created_at) values (?, ?, ?)
      `).run(intent.attemptId, ruleDigest, this.now())
    }
    this.audit(intent, ruleDigest, choice)
    return choice === 'DENY' ? 'DENY' : 'ALLOW_ONCE'
  }

  close(): void {
    this.db.close()
  }

  private hasTaskRule(attemptId: string, ruleDigest: string): boolean {
    const row = this.db.prepare(`
      select 1 as found from xiaogui_coding_permission_rules_v1
      where attempt_id = ? and rule_digest = ? limit 1
    `).get(attemptId, ruleDigest) as { found?: number } | undefined
    return row?.found === 1
  }

  private audit(
    intent: CodingPermissionIntentV1,
    ruleDigest: string,
    decision:
      | CodingPermissionUserChoiceV1
      | 'ALLOW_TASK_RULE_REUSED'
      | 'MODE_POLICY_AUTO_ALLOWED'
      | 'MODE_POLICY_DENIED',
  ): void {
    this.db.prepare(`
      insert or replace into xiaogui_coding_permission_audit_v1
        (request_digest, attempt_id, rule_digest, decision, created_at)
      values (?, ?, ?, ?, ?)
    `).run(intent.requestDigest, intent.attemptId, ruleDigest, decision, this.now())
  }

  private async evaluatePolicy(
    intent: CodingPermissionIntentV1,
  ): Promise<'ASK_USER' | 'ALLOW_ONCE' | 'DENY'> {
    if (!this.options.policy) return 'ASK_USER'
    let evaluation: CodingPermissionPolicyEvaluationV1
    try {
      evaluation = await withTimeout(this.options.policy.evaluate(intent), this.timeoutMs)
    } catch {
      return 'DENY'
    }
    if (
      evaluation.schemaVersion !== 1 ||
      evaluation.requestDigest !== intent.requestDigest ||
      !['CONFIRM_EACH', 'AUTO_APPROVE', 'FULL_AUTONOMY'].includes(evaluation.mode) ||
      !validPolicyEffectReason(evaluation)
    ) return 'DENY'
    return evaluation.effect
  }
}

function validPolicyEffectReason(evaluation: CodingPermissionPolicyEvaluationV1): boolean {
  if (evaluation.effect === 'ASK_USER') return evaluation.reasonCode === 'MODE_REQUIRES_USER_CONFIRMATION'
  if (evaluation.effect === 'ALLOW_ONCE') return evaluation.reasonCode === 'MODE_AUTO_APPROVED_VERIFIED_OPERATION'
  return evaluation.effect === 'DENY' && (
    evaluation.reasonCode === 'TASKHUB_BOUNDARY_UNVERIFIED' ||
    evaluation.reasonCode === 'TASKHUB_BOUNDARY_DENIED'
  )
}

function canonicalIntent(intent: CodingPermissionIntentV1): CodingPermissionIntentV1 | null {
  if (
    intent.schemaVersion !== 1 ||
    !safeId(intent.attemptId) ||
    !safeDigest(intent.requestDigest) ||
    !['READ', 'WRITE', 'COMMAND', 'DATA_EGRESS'].includes(intent.operation) ||
    !['NONE', 'REQUESTED'].includes(intent.dataEgress) ||
    intent.relativePaths.length > 256
  ) return null
  const relativePaths: string[] = []
  for (const raw of intent.relativePaths) {
    if (typeof raw !== 'string' || isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null
    const normalized = posix.normalize(raw.replace(/\\/g, '/'))
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
    relativePaths.push(normalized)
  }
  const commandSummary = safeCodingPermissionDisplayMetadata(intent.commandSummary)
  const egressDestination = safeCodingPermissionDisplayMetadata(intent.egressDestination)
  const actionDigest = safeActionDigest(intent.actionDigest)
  if (
    (intent.operation === 'READ' || intent.operation === 'WRITE') &&
    (relativePaths.length === 0 || intent.dataEgress !== 'NONE' || actionDigest || commandSummary || egressDestination)
  ) return null
  if (
    intent.operation === 'COMMAND' &&
    (relativePaths.length === 0 || !actionDigest || !commandSummary || intent.dataEgress !== 'NONE' || egressDestination)
  ) return null
  if (
    intent.operation === 'DATA_EGRESS' &&
    (relativePaths.length === 0 || !actionDigest || intent.dataEgress !== 'REQUESTED' || !egressDestination || commandSummary)
  ) return null
  const {
    actionDigest: _actionDigest,
    commandSummary: _commandSummary,
    egressDestination: _egressDestination,
    ...base
  } = intent
  return {
    ...base,
    relativePaths: Object.freeze([...new Set(relativePaths)].sort()),
    ...(actionDigest ? { actionDigest } : {}),
    ...(commandSummary ? { commandSummary } : {}),
    ...(egressDestination ? { egressDestination } : {}),
  }
}

function permissionRuleDigest(intent: CodingPermissionIntentV1): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    operation: intent.operation,
    relativePaths: intent.relativePaths,
    dataEgress: intent.dataEgress,
    actionDigest: intent.actionDigest,
    commandSummary: intent.commandSummary,
    egressDestination: intent.egressDestination,
  })).digest('hex')}`
}

function permissionSummary(intent: CodingPermissionIntentV1): string {
  if (intent.operation === 'DATA_EGRESS' || intent.dataEgress === 'REQUESTED') {
    return 'Agent 请求将本任务数据发送到外部服务。'
  }
  if (intent.operation === 'COMMAND') return 'Agent 请求在当前任务工作树中运行命令。'
  if (intent.operation === 'WRITE') return 'Agent 请求修改本任务已批准范围内的文件。'
  return 'Agent 请求读取本任务已批准范围内的文件。'
}

function safeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
}

function safeDigest(value: string): boolean {
  return /^sha256:[a-f0-9-]{8,128}$/i.test(value)
}


function safeActionDigest(value: string | undefined): string | undefined {
  return value && /^sha256:[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

function positiveTimeout(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CODING_PERMISSION_UI_TIMEOUT')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
