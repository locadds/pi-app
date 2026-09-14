import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppEvent } from '@shared/app-events'
import type {
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'
import type { AttemptId, FlowId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import type { ArtifactId, Sha256Digest, TaskChangeSetCandidateId, VerificationAttemptId } from '@shared/xiaogui-task-verification'
import type { AttemptWorkspacePortV1 } from '../task-hub/attempt-workspace'
import type { FrozenTaskVerificationRequestV1, TaskVerificationExecutionContextV1 } from '../task-hub/verification-port'
vi.mock('./pi-worker-port', () => ({ createPiAttemptWorkerPortV1: vi.fn() }))
vi.mock('../sidecar-bridge', () => ({ createXiaoguiIntegration: vi.fn() }))
import { PI_PRODUCTION_SELECTION_V1, PiRuntimeAdapterV1, type PiRuntimeOptionsV1 } from './pi-adapter'

const roots: string[] = []
const adapters = new Set<PiRuntimeAdapterV1>()
afterEach(async () => {
  for (const adapter of adapters) await adapter.close()
  adapters.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
const jsonSha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

async function fixture() {
  const root = mkdtempSync('E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/pi-lifecycle-')
  roots.push(root)
  writeFileSync(join(root, 'a.txt'), 'original')
  const request: RuntimeCreateOrResumeRequestV1 = {
    requestId: 'create-1',
    scope: { projectId: 'xgp_project', sessionKey: 'xgs_session', sessionMode: 'CODING', flowId: 'flow-1',
      taskRunId: 'task-1', attemptId: 'attempt-1', attemptDigest: sha('attempt'),
      workspaceReceiptId: 'receipt-1', workspaceReceiptDigest: sha('receipt') },
    workspace: { attemptWorktreeId: 'worktree-1', worktreeRootDigest: sha(root), baseRevisionDigest: sha('base'),
      targetProjectRootDigest: sha('target'), writePolicy: 'ATTEMPT_WORKTREE_ONLY' },
    selection: PI_PRODUCTION_SELECTION_V1,
    productionPolicy: { rejectDiagnosticOnly: true,
      allowedSelections: [PI_PRODUCTION_SELECTION_V1] },
    promptEnvelopeRef: { refId: 'prompt-1', digest: sha('approved task'), mediaType: 'application/vnd.xiaogui.runtime-prompt+json' },
  }
  let onTool!: Parameters<NonNullable<PiRuntimeOptionsV1['workerFactory']>>[0]['onTool']
  let onEvent!: (event: AppEvent) => void
  let tree = sha('result')
  const prompt = vi.fn(async () => {})
  const abort = vi.fn(async () => {})
  const factory: NonNullable<PiRuntimeOptionsV1['workerFactory']> = vi.fn(input => {
    onTool = input.onTool
    onEvent = input.onEvent
    return { start: async () => ({ sessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'), model: 'fixture/model' }),
      setModel: async () => 'fixture/model', prompt, abort, close: async () => {} }
  })
  const options: PiRuntimeOptionsV1 = {
    dbPath: join(root, 'runtime.sqlite'), workerFactory: factory,
    payloads: {
      resolvePrompt: async () => ({ promptEnvelopeRef: request.promptEnvelopeRef,
        payloadBytes: Buffer.from('approved task'), redactedPreviewDigest: sha('preview') }),
      resolveMessage: async () => { throw new Error('PI_FIXTURE_MESSAGE_UNSUPPORTED') },
      async *resolveTextStream() { throw new Error('PI_FIXTURE_TEXT_STREAM_UNSUPPORTED') },
      resolveCandidateFile: async () => { throw new Error('PI_FIXTURE_CANDIDATE_FILE_UNSUPPORTED') },
      toM2ChangeSetCandidate: async () => { throw new Error('PI_FIXTURE_CHANGESET_CANDIDATE_UNSUPPORTED') },
    } satisfies TrustedRuntimePayloadResolverV1,
    workspace: { runtimeAccess: async () => ({ workspace: request.workspace, rootPath: root, allowedFiles: [] }),
      manifest: () => ({ grants: [{ relativePath: 'a.txt', operation: 'MODIFY' }] }),
      captureTaskPatch: async () => ({ resultTreeHash: tree }),
    } as unknown as AttemptWorkspacePortV1,
  }
  const adapter = new PiRuntimeAdapterV1(options)
  adapters.add(adapter)
  const ready = await adapter.createOrResume(request)
  if (ready.state !== 'READY') throw new Error('fixture did not start')
  return { root, request, adapter, options, factory, prompt, abort, id: ready.runtimeSessionId,
    drift: () => { tree = sha('changed') },
    finish: () => onEvent({ type: 'run', phase: 'idle', settled: true } as AppEvent),
    begin: () => onTool({ fromCwd: root, fromPoolKey: root, fromSessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'),
      request: { type: 'host-tool-request', requestId: 'tool-1', method: 'xiaogui.taskhub.pi.tool.begin',
        payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', toolCallId: 'read-1', toolName: 'read', input: { path: 'a.txt' } } } }),
  }
}

async function permission(adapter: PiRuntimeAdapterV1, id: string) {
  let pending: Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> | undefined
  await vi.waitFor(async () => {
    for await (const event of adapter.stream(id, 0)) if (event.type === 'PERMISSION_REQUESTED') pending = event
    expect(pending).toBeDefined()
  })
  return pending!
}

function runtimeRequestForSource(
  base: RuntimeCreateOrResumeRequestV1,
  requestId: string,
  attemptId: string,
  taskRunId: string,
): RuntimeCreateOrResumeRequestV1 {
  return {
    ...base,
    requestId,
    scope: {
      ...base.scope,
      sessionMode: 'WORK',
      flowId: 'flow-delivery',
      taskRunId,
      attemptId,
      attemptDigest: sha(`${attemptId}-attempt`),
    },
  }
}

it('reserves a tool call before awaiting permission, and rejects a duplicate without another prompt', async () => {
  const f = await fixture()
  const first = f.begin()
  const event = await permission(f.adapter, f.id)
  await expect(f.begin()).resolves.toMatchObject({ ok: false })
  await expect(f.adapter.permission({ type: 'ALLOW_ONCE', runtimeSessionId: f.id,
    decisionRequestId: 'wrong-mode', proofId: 'proof-1', proofDigest: sha('proof'),
    permissionRequestId: event.permissionRequestId, challengeDigest: event.challengeDigest,
    scope: { ...f.request.scope, sessionMode: 'WORK' } })).resolves.toMatchObject({ accepted: false })
  await f.adapter.permission({ type: 'DENY', runtimeSessionId: f.id,
    decisionRequestId: 'deny-1', reasonCode: 'USER_DENIED',
    permissionRequestId: event.permissionRequestId, challengeDigest: event.challengeDigest, scope: f.request.scope })
  await expect(first).resolves.toMatchObject({ ok: false })
  await expect(f.begin()).resolves.toMatchObject({ ok: false })
  const events: RuntimeEventV1[] = []
  for await (const event of f.adapter.stream(f.id, 0)) events.push(event)
  expect(events.filter(event => event.type === 'PERMISSION_REQUESTED')).toHaveLength(1)
})

it('recovers unknown work without dispatching a second prompt or creating another Worker', async () => {
  const f = await fixture()
  await f.adapter.close()
  adapters.delete(f.adapter)
  const restored = new PiRuntimeAdapterV1(f.options)
  adapters.add(restored)
  await expect(restored.createOrResume(f.request)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN' })
  expect(f.factory).toHaveBeenCalledTimes(1)
  expect(f.prompt).toHaveBeenCalledTimes(1)
})

it('reconciles a settled result and refuses a changed result tree on recovery', async () => {
  const f = await fixture()
  f.finish()
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({ state: 'SUCCEEDED' }))
  await f.adapter.close()
  adapters.delete(f.adapter)
  const restored = new PiRuntimeAdapterV1(f.options)
  adapters.add(restored)
  await expect(restored.createOrResume(f.request)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  f.drift()
  await expect(restored.inspect(f.id)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'PI_CANDIDATE_CHANGED' })
  expect(f.prompt).toHaveBeenCalledTimes(1)
})

it('selects Delivery artifacts by exact source Attempt and fails closed for a missing source', async () => {
  const f = await fixture()
  await f.adapter.close()
  adapters.delete(f.adapter)

  const firstRequest = runtimeRequestForSource(f.request, 'create-work-a', 'attempt-a', 'task-a')
  const secondRequest = runtimeRequestForSource(f.request, 'create-work-b', 'attempt-b', 'task-b')
  const db = new DatabaseSync(f.options.dbPath)
  try {
    const insert = db.prepare('INSERT INTO pi_attempt_runtime_v1 VALUES (?,?,?,?)')
    for (const [id, request, summary] of [
      ['runtime-a', firstRequest, 'first-summary'],
      ['runtime-b', secondRequest, 'second-summary'],
    ] as const) {
      const row = {
        version: 1,
        id,
        request,
        requestDigest: jsonSha(request),
        rootIdentityDigest: sha('root'),
        sessionId: `${id}-session`,
        sessionFile: `${id}.jsonl`,
        model: 'fixture/model',
        started: true,
        cancelled: false,
        outcome: {
          state: 'SUCCEEDED' as const,
          runtimeSessionId: id,
          receiptDigest: sha(`${id}-receipt`),
          candidateDigest: sha(`${id}-candidate`),
        },
        events: [],
        calls: {},
        artifacts: [{ path: 'reports/result.docx', sha256: sha(summary), kind: 'WORK_REPORT_DOCX' as const }],
      }
      insert.run(id, request.requestId, row.requestDigest, JSON.stringify(row))
    }
  } finally {
    db.close()
  }

  const adapter = new PiRuntimeAdapterV1(f.options)
  adapters.add(adapter)
  const request: FrozenTaskVerificationRequestV1 = Object.freeze({
    scope: 'TASK',
    verificationAttemptId: 'verification-delivery' as VerificationAttemptId,
    verificationRequestId: 'verification-delivery',
    flowId: 'flow-delivery' as FlowId,
    taskRunId: 'delivery-task' as TaskRunId,
    attemptId: 'attempt-b' as AttemptId,
    candidateId: 'delivery-candidate' as TaskChangeSetCandidateId,
    requestDigest: sha('delivery-request'),
    changeSetDigest: sha('delivery-change-set'),
    preparedTreeHash: sha('delivery-tree'),
    qaConfigVersion: 'xiaogui.work.report.delivery.v1',
    acceptanceCriteria: ['work.report-docx'],
  })
  const context: Readonly<TaskVerificationExecutionContextV1> = Object.freeze({
    worktreeRoot: f.root,
    trustedToolchainRoot: f.root,
    scopeEvidenceArtifactId: 'scope' as ArtifactId,
    inspectionArtifactId: 'inspection' as ArtifactId,
    verificationScope: 'DELIVERY',
    artifactPaths: ['reports/result.docx'],
    artifactSourceAttemptIds: ['attempt-b' as AttemptId],
  })

  await expect(adapter.verificationContext(request, context)).resolves.toMatchObject({
    mode: 'WORK',
    requireAll: true,
    artifacts: [{ path: 'reports/result.docx', sha256: sha('second-summary'), kind: 'WORK_REPORT_DOCX' }],
  })
  await expect(adapter.verificationContext(request, {
    ...context,
    artifactSourceAttemptIds: ['missing-attempt' as AttemptId],
  })).resolves.toBeNull()
})

it('cancels a pending permission, aborts Pi, and cannot settle that run as success', async () => {
  const f = await fixture()
  const pending = f.begin()
  await permission(f.adapter, f.id)
  await f.adapter.interrupt({ runtimeSessionId: f.id, requestId: 'cancel-1', reason: 'USER_CANCEL' })
  await expect(pending).resolves.toMatchObject({ ok: false })
  expect(f.abort).toHaveBeenCalledTimes(1)
  f.finish()
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({ state: 'INTERRUPTED' }))
})
