import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { lstat, readFile, realpath, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, dirname, join } from 'node:path'
import type { AppEvent } from '@shared/app-events'
import type {
  AgentRuntimeAdapterV1, RuntimeAdapterSelectionV1, RuntimeCapabilityV2,
  RuntimeCreateOrResumeRequestV1, RuntimeEventV1, RuntimeOutcomeV1,
  RuntimePermissionDecisionV1, RuntimeSendRequestV1, RuntimeInterruptRequestV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'
import type { WorkerHostToolOutcomeV1 } from '@shared/worker-host-tools'
import type { WorkerHostToolRequestForward } from '../../worker-manager-types'
import { readProjectRootIdentityV2 } from '../../project-root-identity'
import type { AttemptWorkspacePortV1 } from '../task-hub/attempt-workspace'
import { createPiAttemptWorkerPortV1, type PiAttemptWorkerPortV1 } from './pi-worker-port'
import { renderWorkReportArtifactV1 } from '../work-report-docx-service'
import { resolveTaskHubDesignRuntimeV1 } from '../design-runtime-source'
import { createXiaoguiIntegration } from '../sidecar-bridge'
import type { FrozenTaskVerificationRequestV1, TaskVerificationExecutionContextV1, ModeTaskVerificationResolutionV1 } from '../task-hub/verification-port'
import { modeForVerificationConfigV1 } from '../task-hub/mode-verification-policy'

const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const bytesDigest = (value: Uint8Array): string => `sha256:${createHash('sha256').update(value).digest('hex')}`
export const PI_PRODUCTION_SELECTION_V1: RuntimeAdapterSelectionV1 = Object.freeze({
  adapterId: 'xiaogui.pi-sdk.v1', runtimeKind: 'OTHER', protocol: 'SDK',
  capabilityDigest: digest({ adapter: 'pi-sdk-attempt-v1', sdk: '0.84.1',
    tools: { CODING: ['read', 'edit', 'write'], WORK: ['read', 'xiaogui_work_report_docx'], DESIGN: ['read', 'design_project:inspect', 'design_project:open'] },
    verification: 'mode-artifact-v1', recovery: 'settled-reconcile-or-unknown-no-replay' }),
  approvalStatus: 'APPROVED_FOR_PRODUCTION', diagnosticOnly: false,
  stream: 'POLL', interrupt: 'ACKED', inspect: 'RECONCILE',
})

interface RecordV1 {
  version: 1
  id: string
  request: RuntimeCreateOrResumeRequestV1
  requestDigest: string
  rootIdentityDigest: string
  sessionId: string
  sessionFile: string
  model: string
  started: boolean
  cancelled: boolean
  outcome: RuntimeOutcomeV1 | null
  events: RuntimeEventV1[]
  calls: Record<string, { state: 'PENDING' | 'EXECUTING' | 'SETTLED'; path: string }>
  artifacts?: Array<{ path: string; sha256: string; kind: 'WORK_REPORT_DOCX' | 'DESIGN_PROJECT_RESULT' }>
}
interface LiveV1 {
  row: RecordV1
  root: string
  worker: PiAttemptWorkerPortV1
  permissions: Map<string, { event: Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }>; resolve: (allowed: boolean) => void }>
  finishing?: Promise<void>
  outcomePersisted?: boolean
  closing?: Promise<void>
}
export interface PiRuntimeOptionsV1 {
  /** Existing Attempt input database; these are private adapter records, not another session framework. */
  dbPath: string
  workspace: AttemptWorkspacePortV1
  payloads: TrustedRuntimePayloadResolverV1
  workerFactory?: typeof createPiAttemptWorkerPortV1
  designRuntime?: typeof resolveTaskHubDesignRuntimeV1
}

/** The TaskHub Adapter owns lifecycle translation; Pi still owns prompt/tool execution. */
export class PiRuntimeAdapterV1 implements AgentRuntimeAdapterV1 {
  private readonly db: DatabaseSync
  private readonly live = new Map<string, LiveV1>()
  private closed = false
  private creating: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  constructor(private readonly options: PiRuntimeOptionsV1) {
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pi_attempt_runtime_v1 (id TEXT PRIMARY KEY, create_id TEXT UNIQUE NOT NULL, request_digest TEXT NOT NULL, data_json TEXT NOT NULL)')
  }
  async discover(): Promise<readonly RuntimeCapabilityV2[]> { return [await this.health()] }
  async health(): Promise<RuntimeCapabilityV2> {
    return { ...PI_PRODUCTION_SELECTION_V1, version: 2, health: this.closed ? 'UNAVAILABLE' : 'AVAILABLE',
      runtimeVersion: '0.84.1', capabilitySummary: '小规 Pi：受控代码修改、标准 DOCX 报告和项目概览',
      canCreateSession: !this.closed, canResumeSession: true, interactivePermission: 'HOST_MEDIATED',
      workModes: ['WORK', 'DESIGN', 'CODING'], taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT'],
      executionLocation: 'LOCAL', requiresDataEgress: true,
      supportsResume: true, supportsEventStream: true, supportsInterrupt: true, supportsResultReconcile: true }
  }
  createOrResume(request: RuntimeCreateOrResumeRequestV1) {
    const task = this.creating.then(() => this.create(request))
    this.creating = task.catch(() => undefined)
    return task
  }
  private async create(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeOutcomeV1 | { state: 'READY'; runtimeSessionId: string }> {
    const requestDigest = digest(request)
    const previous = this.db.prepare('SELECT id,request_digest FROM pi_attempt_runtime_v1 WHERE create_id=?').get(request.requestId) as { id: string; request_digest: string } | undefined
    if (previous) {
      if (previous.request_digest !== requestDigest) return unknown(previous.id, 'PI_REQUEST_CONFLICT')
      if (this.live.has(previous.id)) return this.live.get(previous.id)!.row.outcome ?? { state: 'READY', runtimeSessionId: previous.id }
      return this.inspect(previous.id)
    }
    const id = `xhbrs_pi_${randomUUID().replaceAll('-', '')}`
    if (this.closed || digest(request.selection) !== digest(PI_PRODUCTION_SELECTION_V1)
      || !request.productionPolicy.allowedSelections.some(s => digest(s) === digest(PI_PRODUCTION_SELECTION_V1))) return unknown(id, 'PI_SELECTION_REJECTED')
    let live: LiveV1 | undefined
    try {
      const access = await this.options.workspace.runtimeAccess(request.scope.attemptId)
      if (!access || digest(access.workspace) !== digest(request.workspace)) throw new Error('PI_ATTEMPT_WORKSPACE_MISMATCH')
      const payload = await this.options.payloads.resolvePrompt(request.promptEnvelopeRef)
      if (bytesDigest(payload.payloadBytes) !== request.promptEnvelopeRef.digest) throw new Error('PI_PROMPT_DIGEST_MISMATCH')
      const row: RecordV1 = { version: 1, id, request, requestDigest,
        rootIdentityDigest: readProjectRootIdentityV2(access.rootPath).digest,
        sessionId: '', sessionFile: '', model: '', started: false, cancelled: false, outcome: null, events: [], calls: {} }
      const worker = (this.options.workerFactory ?? createPiAttemptWorkerPortV1)({
        rootPath: access.rootPath, scope: request.scope,
        ...(request.scope.sessionMode === 'DESIGN'
          ? { designExtensionPath: (this.options.designRuntime ?? resolveTaskHubDesignRuntimeV1)().extensionPath }
          : {}),
        onTool: input => live ? this.tool(live, input) : Promise.resolve(denied()),
        onEvent: event => { if (live) this.workerEvent(live, event) },
        onExit: () => { if (live && !live.row.outcome) void this.settle(live, unknown(id, 'PI_WORKER_EXITED')) },
      })
      live = { row, root: access.rootPath, worker, permissions: new Map() }
      this.live.set(id, live)
      this.save(row)
      const ready = await worker.start()
      if (this.closed || row.outcome) throw new Error('PI_WORKER_START_INTERRUPTED')
      Object.assign(row, ready)
      if (request.codingRole && request.codingRole.modelSelector !== 'inherit') {
        const selector = request.codingRole.modelSelector
        const slash = selector.indexOf('/')
        if (slash <= 0) throw new Error('PI_MODEL_SELECTION_INVALID')
        row.model = await worker.setModel(selector.slice(0, slash), selector.slice(slash + 1))
        if (row.model !== selector) throw new Error('PI_MODEL_SELECTION_MISMATCH')
      }
      if (!row.model) throw new Error('PI_MODEL_NOT_CONFIGURED')
      row.started = true
      this.event(row, { type: 'SESSION_READY', runtimeSessionId: id, sequence: 0 })
      this.save(row) // dispatch intent is durable before prompt; a crash cannot replay it
      void worker.prompt(Buffer.from(payload.payloadBytes).toString('utf8')).catch(() => {
        if (live && !row.outcome) void this.settle(live, failed(id, 'PI_PROMPT_FAILED'))
      })
      return { state: 'READY', runtimeSessionId: id }
    } catch {
      if (live) await this.settle(live, failed(id, 'PI_START_FAILED'))
      return live?.row.outcome ?? failed(id, 'PI_START_FAILED')
    }
  }
  async send(_request: RuntimeSendRequestV1): Promise<{ accepted: false; reasonCode: string }> {
    // One approved prompt per Attempt. Guidance cannot silently broaden frozen inputs.
    return { accepted: false, reasonCode: 'PI_ATTEMPT_INPUT_FROZEN' }
  }
  async *stream(id: string, afterSequence: number): AsyncIterable<RuntimeEventV1> {
    for (const event of this.read(id)?.events ?? []) if (event.sequence > afterSequence) yield event
  }
  async permission(decision: RuntimePermissionDecisionV1) {
    const live = this.live.get(decision.runtimeSessionId)
    const pending = live?.permissions.get(decision.permissionRequestId)
    if (!live || !pending || live.row.outcome || live.row.cancelled
      || digest(decision.scope) !== digest(live.row.request.scope)
      || decision.challengeDigest !== pending.event.challengeDigest) return { accepted: false, reasonCode: 'PI_PERMISSION_STALE' }
    live.permissions.delete(decision.permissionRequestId)
    pending.resolve(decision.type === 'ALLOW_ONCE')
    return { accepted: true }
  }
  async interrupt(request: RuntimeInterruptRequestV1) {
    const live = this.live.get(request.runtimeSessionId)
    if (!live || live.row.outcome) return { requested: false as const, reasonCode: 'PI_NOT_RUNNING' }
    live.row.cancelled = true
    this.save(live.row)
    for (const pending of live.permissions.values()) pending.resolve(false)
    live.permissions.clear()
    await live.worker.abort()
    return { requested: true as const }
  }
  async inspect(id: string): Promise<RuntimeOutcomeV1> {
    const row = this.read(id)
    if (!row) return unknown(id, 'PI_SESSION_MISSING')
    if (row.outcome?.state === 'SUCCEEDED') {
      try {
        const access = await this.options.workspace.runtimeAccess(row.request.scope.attemptId)
        if (!access || readProjectRootIdentityV2(access.rootPath).digest !== row.rootIdentityDigest) return unknown(id, 'PI_WORKSPACE_CHANGED')
        const patch = await this.options.workspace.captureTaskPatch(row.request.scope.attemptId, { allowNoApprovedChanges: true })
        if (patch.resultTreeHash !== row.outcome.candidateDigest) return unknown(id, 'PI_CANDIDATE_CHANGED')
      } catch { return unknown(id, 'PI_RECONCILE_FAILED') }
    }
    return row.outcome ?? unknown(id, this.live.has(id) ? 'RUNTIME_STILL_RUNNING' : 'PI_RESTART_OUTCOME_UNKNOWN')
  }
  async reconcile(id: string, expected?: string) {
    const outcome = await this.inspect(id)
    return expected && 'receiptDigest' in outcome && outcome.receiptDigest !== expected ? unknown(id, 'PI_RECEIPT_MISMATCH') : outcome
  }
  async restoreRuntimeSession(id: string) {
    return this.read(id) ? { ok: true as const } : { ok: false as const, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' as const }
  }
  async verificationContext(request: FrozenTaskVerificationRequestV1, context: Readonly<TaskVerificationExecutionContextV1>): Promise<ModeTaskVerificationResolutionV1 | null> {
    const mode = modeForVerificationConfigV1(request.qaConfigVersion)
    if (!mode) return null
    const stored = this.db.prepare("SELECT id FROM pi_attempt_runtime_v1 WHERE json_extract(data_json,'$.request.scope.flowId')=?")
      .all(request.flowId) as Array<{ id: string }>
    const rows = stored.map(record => this.read(record.id)!).filter(Boolean)
    if (rows.some(row => row.request.scope.sessionMode !== mode)) return null
    // Legacy CODING receipts retain their existing verifier. New non-CODING
    // tasks can never use that fallback when their Pi evidence is missing.
    if (mode === 'CODING') return { mode, artifacts: [], requireAll: true }
    const selected = context.verificationScope === 'DELIVERY'
      ? selectDeliveryRuntimeRows(rows, context.artifactSourceAttemptIds)
      : rows.filter(row => row.request.scope.attemptId === request.attemptId)
    if (!selected) return null
    if (!selected.length || !context.artifactPaths?.length) return null
    const artifacts = selected.filter(row => row.outcome?.state === 'SUCCEEDED').flatMap(row => row.artifacts ?? [])
    const approved = context.artifactPaths.map(path => artifacts.filter(artifact => artifact.path === path))
    if (approved.some(matches => matches.length !== 1)) return null
    return { mode, artifacts: approved.map(matches => matches[0]), requireAll: true }
  }

  async close() {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.closeLiveAttempts()
    return this.closing
  }
  private async closeLiveAttempts() {
    const lives = [...this.live.values()]
    await Promise.all(lives.map(async live => {
      await this.settle(live, unknown(live.row.id, 'PI_SHUTDOWN_UNKNOWN'))
      await live.finishing?.catch(() => undefined)
      await live.closing?.catch(() => undefined)
    }))
    await this.creating.catch(() => undefined)
    this.db.close()
  }
  private read(id: string): RecordV1 | undefined {
    if (this.live.has(id)) return this.live.get(id)!.row
    const stored = this.db.prepare('SELECT data_json FROM pi_attempt_runtime_v1 WHERE id=?').get(id) as { data_json: string } | undefined
    if (!stored) return undefined
    const row = JSON.parse(stored.data_json) as RecordV1
    if (row.version !== 1 || row.id !== id || digest(row.request) !== row.requestDigest) throw new Error('PI_RECORD_INVALID')
    return row
  }
  private save(row: RecordV1) {
    this.db.prepare('INSERT INTO pi_attempt_runtime_v1 VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json')
      .run(row.id, row.request.requestId, row.requestDigest, JSON.stringify(row))
  }
  private event(row: RecordV1, event: RuntimeEventV1) { row.events.push({ ...event, sequence: row.events.length + 1 }) }
  private settle(live: LiveV1, outcome: RuntimeOutcomeV1): Promise<void> {
    if (live.closing) return live.closing
    if (!live.outcomePersisted) {
      const requested = live.row.outcome ?? outcome
      live.row.outcome = requested
      try {
        this.save(live.row)
        live.outcomePersisted = true
      } catch {
        live.row.outcome = unknown(live.row.id, 'PI_OUTCOME_PERSIST_FAILED')
        try {
          this.save(live.row)
          live.outcomePersisted = true
        } catch { /* Keep the in-memory UNKNOWN and still release the worker. */ }
      }
    }
    for (const pending of live.permissions.values()) pending.resolve(false)
    live.permissions.clear()
    live.closing = Promise.resolve()
      .then(() => live.worker.close())
      .catch(() => {
        try { process.stderr.write('[PiRuntime] Pi worker close failed after terminal settlement\n') } catch { /* ignore */ }
      })
      .finally(() => {
        if (this.live.get(live.row.id) === live) this.live.delete(live.row.id)
      })
    return live.closing
  }
  private workerEvent(live: LiveV1, event: AppEvent) {
    if (event.type !== 'run' || !event.settled || live.row.outcome || live.finishing) return
    live.finishing = (async () => {
      if (live.row.cancelled || event.phase === 'cancelled') {
        await this.settle(live, { ...failed(live.row.id, 'PI_CANCELLED'), state: 'INTERRUPTED' }); return
      }
      if (event.phase !== 'idle' || Object.values(live.row.calls).some(call => call.state !== 'SETTLED')) {
        await this.settle(live, failed(live.row.id, 'PI_RUN_FAILED')); return
      }
      if (live.row.request.scope.sessionMode !== 'CODING' && !live.row.artifacts?.length) {
        await this.settle(live, failed(live.row.id, 'PI_MODE_ARTIFACT_MISSING')); return
      }
      try {
        const patch = await this.options.workspace.captureTaskPatch(live.row.request.scope.attemptId, { allowNoApprovedChanges: true })
        await this.settle(live, { state: 'SUCCEEDED', runtimeSessionId: live.row.id,
          candidateDigest: patch.resultTreeHash, receiptDigest: digest({ attempt: live.row.request.scope.attemptId, result: patch.resultTreeHash, model: live.row.model }) })
      } catch { await this.settle(live, failed(live.row.id, 'PI_RESULT_AUDIT_FAILED')) }
    })()
  }
  private async tool(live: LiveV1, input: WorkerHostToolRequestForward, artifactWrite = false): Promise<WorkerHostToolOutcomeV1> {
    try {
      const request = input.request
      if (request.method === 'xiaogui.work.report-docx.v1') return this.workReport(live, input)
      if (request.method === 'xiaogui.taskhub.design-project') return this.designProject(live, input)
      if (!['xiaogui.taskhub.pi.tool.begin', 'xiaogui.taskhub.pi.tool.settle'].includes(request.method)) return denied()
      if (request.method !== 'xiaogui.taskhub.pi.tool.begin' && request.method !== 'xiaogui.taskhub.pi.tool.settle') return denied()
      const payload = request.payload
      if (live.row.outcome || live.row.cancelled || input.signal?.aborted
        || payload.attemptId !== live.row.request.scope.attemptId || payload.sourceSessionId !== live.row.sessionId
        || input.fromSessionId !== live.row.sessionId || resolve(input.fromCwd) !== resolve(live.root)
        || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(payload.toolCallId)) return denied()
      if (request.method === 'xiaogui.taskhub.pi.tool.settle') {
        const call = live.row.calls[payload.toolCallId]
        if (!call || call.state !== 'EXECUTING') return denied()
        call.state = 'SETTLED'
        this.save(live.row)
        return { ok: true, value: { kind: 'PI_ATTEMPT_TOOL_SETTLED', toolCallId: payload.toolCallId } }
      }
      if (live.row.calls[payload.toolCallId]) return denied()
      const { toolName, input: parameters } = request.payload
      if (live.row.request.scope.sessionMode !== 'CODING' && toolName !== 'read' && !artifactWrite) return denied()
      const role = live.row.request.codingRole
      if (!['read', 'edit', 'write'].includes(toolName)
        || (role && (!role.effectiveToolAllowlist.includes(toolName) || (role.role !== 'IMPLEMENT' && toolName !== 'read')))) return denied()
      const rawPath = (parameters as { path?: unknown } | null)?.path
      if (typeof rawPath !== 'string') return denied()
      const path = relative(live.root, resolve(live.root, rawPath)).split(sep).join('/')
      if (!path || isAbsolute(path) || path.split('/').some(part => !part || part === '..' || part.toLowerCase() === '.git')) return denied()
      const grant = this.options.workspace.manifest(live.row.request.scope.attemptId)?.grants.find(item => item.relativePath === path)
      if (!grant || grant.operation === 'DELETE') return denied()
      // Reserve the call before the first await. A concurrent/replayed begin
      // cannot create another permission request or execute the tool twice.
      live.row.calls[payload.toolCallId] = { state: 'PENDING', path }
      this.save(live.row)
      const before = await this.targetSnapshot(live, path, toolName === 'read')
      const permissionRequestId = `xhbrperm_${randomUUID().replaceAll('-', '')}`
      const event: Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> = {
        type: 'PERMISSION_REQUESTED', runtimeSessionId: live.row.id, sequence: live.row.events.length + 1,
        permissionRequestId, scope: live.row.request.scope, decisionRequired: 'ALLOW_ONCE_OR_DENY',
        challengeDigest: digest({ call: payload.toolCallId, parameters, before }),
        permissionPurpose: toolName === 'read' ? 'FILE_READ' : 'FILE_WRITE', requestedRelativePaths: [path],
      }
      const allowed = new Promise<boolean>(resolvePermission => {
        const timer = setTimeout(() => { live.permissions.delete(permissionRequestId); resolvePermission(false) }, 55000)
        live.permissions.set(permissionRequestId, { event, resolve: value => { clearTimeout(timer); resolvePermission(value) } })
      })
      this.event(live.row, event)
      this.save(live.row)
      if (!await allowed || live.row.cancelled || input.signal?.aborted) {
        live.row.calls[payload.toolCallId].state = 'SETTLED'
        this.save(live.row)
        return denied()
      }
      if (before !== await this.targetSnapshot(live, path, toolName === 'read')) return denied()
      live.row.calls[payload.toolCallId] = { state: 'EXECUTING', path }
      this.save(live.row)
      return { ok: true, value: { kind: 'PI_ATTEMPT_TOOL_ALLOWED', toolCallId: payload.toolCallId, authorizedRelativePath: path } }
    } catch { return denied() }
  }
  private async workReport(live: LiveV1, input: WorkerHostToolRequestForward): Promise<WorkerHostToolOutcomeV1> {
    const request = input.request
    if (request.method !== 'xiaogui.work.report-docx.v1' || live.row.request.scope.sessionMode !== 'WORK') return denied()
    const payload = request.payload
    if (payload.action !== 'PREPARE' || !payload.draft || payload.sourceSessionId !== live.row.sessionId
      || input.fromSessionId !== live.row.sessionId || resolve(input.fromCwd) !== resolve(live.root)) return denied()
    const targets = this.options.workspace.manifest(live.row.request.scope.attemptId)?.grants
      .filter(grant => grant.operation === 'CREATE' && grant.relativePath.toLowerCase().endsWith('.docx')) ?? []
    if (targets.length !== 1 || live.row.calls[payload.toolCallId]) return denied()
    const artifact = await renderWorkReportArtifactV1(payload.draft)
    const path = targets[0].relativePath
    if (!await this.writeArtifact(live, input, payload.toolCallId, payload.sourceSessionId, path, artifact.content, 'WORK_REPORT_DOCX')) return denied()
    return { ok: true, value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_ATTEMPT_ARTIFACT', relativePath: path, sha256: bytesDigest(artifact.content) } }
  }
  private async writeArtifact(live: LiveV1, input: WorkerHostToolRequestForward, toolCallId: string,
    sourceSessionId: string, path: string, content: Buffer, kind: 'WORK_REPORT_DOCX' | 'DESIGN_PROJECT_RESULT'): Promise<boolean> {
    const allowed = await this.tool(live, { ...input, request: {
      type: 'host-tool-request', requestId: input.request.requestId,
      method: 'xiaogui.taskhub.pi.tool.begin', payload: {
        attemptId: live.row.request.scope.attemptId, sourceSessionId,
        toolCallId, toolName: 'write', input: { path, artifactDigest: bytesDigest(content) },
      },
    } }, true)
    if (!allowed.ok || allowed.value.kind !== 'PI_ATTEMPT_TOOL_ALLOWED') return false
    try {
      if (live.row.cancelled || input.signal?.aborted) return false
      const before = await this.targetSnapshot(live, path, false)
      if (before !== 'MISSING' && before !== bytesDigest(Buffer.alloc(0))) return false
      await mkdir(dirname(resolve(live.root, path)), { recursive: true })
      if (before !== await this.targetSnapshot(live, path, false)) return false
      // CREATE grants are materialized by Main as an owned empty placeholder;
      // replace that placeholder only after its identity/content re-check.
      await writeFile(resolve(live.root, path), content, { flag: before === 'MISSING' ? 'wx' : 'w' })
      live.row.artifacts ??= []
      live.row.artifacts.push({ path, sha256: bytesDigest(content), kind })
      live.row.calls[toolCallId].state = 'SETTLED'
      this.save(live.row)
      return true
    } catch { return false }
  }
  private async designProject(live: LiveV1, input: WorkerHostToolRequestForward): Promise<WorkerHostToolOutcomeV1> {
    const request = input.request
    if (request.method !== 'xiaogui.taskhub.design-project' || live.row.request.scope.sessionMode !== 'DESIGN') return denied()
    const payload = request.payload
    if (!['inspect', 'open'].includes(payload.action) || payload.attemptId !== live.row.request.scope.attemptId
      || payload.sourceSessionId !== live.row.sessionId || input.fromSessionId !== live.row.sessionId
      || resolve(input.fromCwd) !== resolve(live.root) || live.row.cancelled || live.row.outcome) return denied()
    const grants = this.options.workspace.manifest(payload.attemptId)?.grants ?? []
    const targets = grants.filter(grant => grant.operation === 'CREATE' && grant.relativePath.endsWith('.json'))
    const sources = grants.filter(grant => grant.operation === 'MODIFY')
    if (targets.length !== 1 || !sources.length || live.row.calls[payload.toolCallId]) return denied()
    // A private read projection prevents the existing project scanner from
    // reading files outside the approved manifest. It is not another worktree.
    const runtime = (this.options.designRuntime ?? resolveTaskHubDesignRuntimeV1)()
    const tempRoot = join(dirname(this.options.dbPath), 'design-inputs')
    await mkdir(tempRoot, { recursive: true })
    const snapshot = await mkdtemp(join(tempRoot, 'input-'))
    const bridge = createXiaoguiIntegration({ mode: 'DESIGN', config: { ...runtime.config, allowedRoots: [snapshot] } })
    const sourceFacts: Array<{ path: string; sha256: string }> = []
    const onAbort = () => { void bridge.shutdown() }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (const [index, source] of sources.entries()) {
        const callId = `${payload.toolCallId}:source:${index}`
        const allowed = await this.tool(live, { ...input, request: {
          type: 'host-tool-request', requestId: request.requestId,
          method: 'xiaogui.taskhub.pi.tool.begin', payload: { attemptId: payload.attemptId,
            sourceSessionId: payload.sourceSessionId, toolCallId: callId, toolName: 'read', input: { path: source.relativePath } },
        } })
        if (!allowed.ok || allowed.value.kind !== 'PI_ATTEMPT_TOOL_ALLOWED') return denied()
        const sourcePath = resolve(live.root, source.relativePath)
        if ((await lstat(sourcePath)).size > 16 * 1024 * 1024) return denied()
        const bytes = await readFile(sourcePath)
        const copyPath = resolve(snapshot, source.relativePath)
        await mkdir(dirname(copyPath), { recursive: true })
        await writeFile(copyPath, bytes, { flag: 'wx' })
        sourceFacts.push({ path: source.relativePath, sha256: bytesDigest(bytes) })
        live.row.calls[callId].state = 'SETTLED'
        this.save(live.row)
      }
      if (input.signal?.aborted || live.row.cancelled) return denied()
      const result = await bridge.invokeTool({ tool: 'design.project', action: payload.action, params: { path: snapshot } }, { projectRoot: snapshot })
      if (result.status !== 'ok' || result.warnings.length || !result.source_version || !result.trace_id || !result.evidence.length) return denied()
      for (const source of sourceFacts) {
        await this.targetSnapshot(live, source.path, true)
        if (bytesDigest(await readFile(resolve(live.root, source.path))) !== source.sha256) return denied()
      }
      // Explicit safe projection: never publish raw ToolResult/root/source_path.
      const artifact = { kind: 'DESIGN_PROJECT_OVERVIEW_V1', status: 'ok',
        source_version: result.source_version, trace_id: result.trace_id, generated_at: result.generated_at,
        action: payload.action, sources: sourceFacts,
        summary: { file_count: typeof result.data.file_count === 'number' ? result.data.file_count : 0,
          professional_files_present: result.data.has_professional_files === true },
      }
      const bytes = Buffer.from(JSON.stringify(artifact))
      const target = targets[0].relativePath
      if (!await this.writeArtifact(live, input, payload.toolCallId, payload.sourceSessionId, target, bytes, 'DESIGN_PROJECT_RESULT')) return denied()
      return { ok: true, value: { kind: 'PI_DESIGN_PROJECT_ARTIFACT', relativePath: target,
        sha256: bytesDigest(bytes), summary: `已生成受控项目概览 ${target}，来源 ${sourceFacts.length} 项；等待验证与交付审阅。` } }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      await bridge.shutdown()
      await rm(snapshot, { recursive: true, force: true })
    }
  }
  private async targetSnapshot(live: LiveV1, path: string, readOnly: boolean): Promise<string> {
    if (readProjectRootIdentityV2(live.root).digest !== live.row.rootIdentityDigest) throw new Error('PI_ROOT_CHANGED')
    const access = await this.options.workspace.runtimeAccess(live.row.request.scope.attemptId)
    if (!access || digest(access.workspace) !== digest(live.row.request.workspace)) throw new Error('PI_WORKSPACE_CHANGED')
    let target = live.root
    const parts = path.split('/')
    for (const [index, part] of parts.entries()) {
      target = resolve(target, part)
      let stat
      try { stat = await lstat(target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'MISSING'
        throw error
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('PI_LINK_REJECTED')
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('PI_PARENT_INVALID')
      if (index === parts.length - 1) {
        if (!stat.isFile()) throw new Error('PI_TARGET_INVALID')
        if (!readOnly && stat.size > 16 * 1024 * 1024) throw new Error('PI_FILE_LIMIT')
        if (resolve(await realpath(target)) !== resolve(target)) throw new Error('PI_TARGET_CHANGED')
        return readOnly ? digest({ ino: stat.ino, size: stat.size, mtime: stat.mtimeMs }) : bytesDigest(await readFile(target))
      }
    }
    throw new Error('PI_TARGET_INVALID')
  }
}

function selectDeliveryRuntimeRows(
  rows: readonly RecordV1[],
  attemptIds: readonly string[] | undefined,
): RecordV1[] | null {
  if (!Array.isArray(attemptIds) || attemptIds.length === 0 ||
    attemptIds.some((attemptId) => typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) ||
    new Set(attemptIds).size !== attemptIds.length) return null
  const selected = attemptIds.map((attemptId) => {
    const matches = rows.filter((row) => row.request.scope.attemptId === attemptId)
    return matches.length === 1 ? matches[0] : null
  })
  return selected.every((row): row is RecordV1 => row !== null) ? selected : null
}

function denied(): WorkerHostToolOutcomeV1 { return { ok: false, error: { code: 'HOST_TOOL_FAILED', message: 'TaskHub 文件操作未获授权或来源已失效' } } }
function unknown(id: string, reasonCode: string): RuntimeOutcomeV1 { return { state: 'OUTCOME_UNKNOWN', runtimeSessionId: id, inspectHandleDigest: digest({ id, reasonCode }), reasonCode } }
function failed(id: string, reasonCode: string): Extract<RuntimeOutcomeV1, { state: 'FAILED' }> { return { state: 'FAILED', runtimeSessionId: id, receiptDigest: digest({ id, reasonCode }), reasonCode } }
