import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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
import { ModeTaskVerificationPortV1, type FrozenTaskVerificationRequestV1, type TaskVerificationExecutionContextV1 } from '../task-hub/verification-port'
vi.mock('./pi-worker-port', () => ({ createPiAttemptWorkerPortV1: vi.fn() }))
vi.mock('../sidecar-bridge', () => ({ createXiaoguiIntegration: vi.fn() }))
import { PI_PRODUCTION_SELECTION_V1, PiRuntimeAdapterV1, type PiRuntimeOptionsV1 } from './pi-adapter'
import { createXiaoguiIntegration } from '../sidecar-bridge'

const roots: string[] = []
const adapters = new Set<PiRuntimeAdapterV1>()
afterEach(async () => {
  for (const adapter of adapters) await adapter.close()
  adapters.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
const jsonSha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

async function fixture(worktreeAuthorized = false, mode: 'WORK' | 'DESIGN' | 'CODING' = 'CODING',
  unsettledVerification?: PiRuntimeOptionsV1['unsettledVerification']) {
  const root = worktreeAuthorized
    ? mkdtempSync(join(tmpdir(), 'xiaogui-pi-v2-lifecycle-'))
    : mkdtempSync('E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/pi-lifecycle-')
  roots.push(root)
  writeFileSync(join(root, 'a.txt'), 'original')
  const request: RuntimeCreateOrResumeRequestV1 = {
    requestId: 'create-1',
    scope: { projectId: 'xgp_project', sessionKey: 'xgs_session', sessionMode: mode, flowId: 'flow-1',
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
  let tree = sha('result')
  const prompt = vi.fn(async () => {})
  const abort = vi.fn(async () => {})
  const closes: Array<ReturnType<typeof vi.fn>> = []
  const workerEvents: Array<(event: AppEvent) => void> = []
  const workerExits: Array<() => void> = []
  const factory: NonNullable<PiRuntimeOptionsV1['workerFactory']> = vi.fn(input => {
    onTool = input.onTool
    workerEvents.push(input.onEvent)
    workerExits.push(input.onExit)
    const close = vi.fn(async () => {})
    closes.push(close)
    return { start: async () => ({ sessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'), model: 'fixture/model' }),
      setModel: async () => 'fixture/model', prompt, abort, close }
  })
  const options: PiRuntimeOptionsV1 = {
    dbPath: join(root, 'runtime.sqlite'), workerFactory: factory,
    ...(mode === 'DESIGN' ? { designRuntime: (() => ({ extensionPath: 'fixture-design', config: {} })) as never } : {}),
    payloads: {
      resolvePrompt: async () => ({ promptEnvelopeRef: request.promptEnvelopeRef,
        payloadBytes: Buffer.from('approved task'), redactedPreviewDigest: sha('preview') }),
      resolveMessage: async () => { throw new Error('PI_FIXTURE_MESSAGE_UNSUPPORTED') },
      async *resolveTextStream() { throw new Error('PI_FIXTURE_TEXT_STREAM_UNSUPPORTED') },
      resolveCandidateFile: async () => { throw new Error('PI_FIXTURE_CANDIDATE_FILE_UNSUPPORTED') },
      toM2ChangeSetCandidate: async () => { throw new Error('PI_FIXTURE_CHANGESET_CANDIDATE_UNSUPPORTED') },
    } satisfies TrustedRuntimePayloadResolverV1,
    ...(unsettledVerification ? { unsettledVerification } : {}),
    workspace: { runtimeAccess: async () => ({ workspace: request.workspace, rootPath: root, allowedFiles: [],
        ...(worktreeAuthorized ? { worktreeAuthorization: { version: 2 as const, mode: 'ATTEMPT_WORKTREE' as const,
          authorizationDigest: sha('authorization'), sourceBindingDigest: sha('source'), ledgerDigest: sha('ledger'),
          targetProjectIdentity: sha('target-project'), bindingDigest: sha('binding') },
          baselineLedger: { version: 2 as const, sourceBindingDigest: sha('source'), ledgerDigest: sha('ledger'),
            entries: [{ relativePath: 'a.txt', gitMode: '100644' as const, contentDigest: sha('original'), byteLength: 8 }] } } : {}) }),
      manifest: () => worktreeAuthorized ? undefined : ({ grants: [{ relativePath: 'a.txt', operation: 'MODIFY' }] }),
      captureTaskPatch: async () => ({ resultTreeHash: tree }),
      captureTaskPatchV2: async () => ({ resultTreeHash: tree }),
    } as unknown as AttemptWorkspacePortV1,
  }
  const adapter = new PiRuntimeAdapterV1(options)
  adapters.add(adapter)
  const ready = await adapter.createOrResume(request)
  if (ready.state !== 'READY') throw new Error('fixture did not start')
  let finishOrdinal = 0
  return { root, request, adapter, options, factory, prompt, abort, id: ready.runtimeSessionId,
    close: closes[0], closes, workerEvents, workerExits,
    drift: () => { tree = sha('changed') },
    finish: (runId = `run-${++finishOrdinal}`) => workerEvents[0]({ type: 'run', phase: 'idle', settled: true, runId } as AppEvent),
    begin: () => onTool({ fromCwd: root, fromPoolKey: root, fromSessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'),
      request: { type: 'host-tool-request', requestId: 'tool-1', method: 'xiaogui.taskhub.pi.tool.begin',
        payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', toolCallId: 'read-1', toolName: 'read', input: { path: 'a.txt' } } } }),
    call: (toolCallId: string, toolName: string, input: unknown) => onTool({ fromCwd: root, fromPoolKey: root,
      fromSessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'), request: { type: 'host-tool-request', requestId: toolCallId,
        method: 'xiaogui.taskhub.pi.tool.begin', payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', toolCallId, toolName, input } } }),
    settle: (toolCallId: string, isError = false) => onTool({ fromCwd: root, fromPoolKey: root,
      fromSessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'), request: { type: 'host-tool-request', requestId: `${toolCallId}-settle`,
        method: 'xiaogui.taskhub.pi.tool.settle', payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', toolCallId, isError } } }),
    host: (request: Parameters<typeof onTool>[0]['request']) => onTool({ fromCwd: root, fromPoolKey: root,
      fromSessionId: 'pi-1', sessionFile: join(root, 'session.jsonl'), request }),
  }
}

it('keeps the V2 worker unsettled for two persisted correction prompts and settles only after PASS', async () => {
  const verify = vi.fn()
    .mockResolvedValueOnce({ verdict: 'FAIL', candidateDigest: sha('result'), receiptDigest: sha('receipt-1'), receiptJson: '{"verdict":"FAIL"}', diagnostic: 'typecheck failed' })
    .mockResolvedValueOnce({ verdict: 'FAIL', candidateDigest: sha('result'), receiptDigest: sha('receipt-2'), receiptJson: '{"verdict":"FAIL"}', diagnostic: 'lint failed' })
    .mockResolvedValueOnce({ verdict: 'PASS', candidateDigest: sha('result'), receiptDigest: sha('receipt-3'), receiptJson: '{"verdict":"PASS"}' })
  const f = await fixture(true, 'CODING', { verify })

  f.finish('run-initial')
  await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(2))
  f.finish('run-initial')
  await Promise.resolve()
  expect(f.prompt).toHaveBeenCalledTimes(2)
  expect(await f.adapter.inspect(f.id)).toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_STILL_RUNNING' })
  f.finish('run-correction-1')
  await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(3))
  f.finish('run-correction-2')
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({ state: 'SUCCEEDED', candidateDigest: sha('result') }))
  expect(verify).toHaveBeenCalledTimes(3)
  expect(f.close).toHaveBeenCalledTimes(1)
})

it('fails closed when V2 unsettled verification is unavailable', async () => {
  const f = await fixture(true)
  f.finish()
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({
    state: 'OUTCOME_UNKNOWN', reasonCode: 'PI_UNSETTLED_VERIFIER_UNAVAILABLE',
  }))
  expect(f.prompt).toHaveBeenCalledTimes(1)
})

it('invalidates an unsettled receipt when the candidate changes during verification', async () => {
  const holder: { f?: Awaited<ReturnType<typeof fixture>> } = {}
  const verify = vi.fn(async () => {
    holder.f!.drift()
    return { verdict: 'PASS' as const, candidateDigest: sha('result'), receiptDigest: sha('receipt'), receiptJson: '{"verdict":"PASS"}' }
  })
  const f = await fixture(true, 'CODING', { verify })
  holder.f = f
  f.finish()
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({
    state: 'OUTCOME_UNKNOWN', reasonCode: 'PI_CANDIDATE_CHANGED_DURING_VERIFICATION',
  }))
  expect(f.prompt).toHaveBeenCalledTimes(1)
})

it('stops after two V2 correction prompts when verification still fails', async () => {
  const verify = vi.fn(async () => ({ verdict: 'FAIL' as const, candidateDigest: sha('result'),
    receiptDigest: sha('failed'), receiptJson: '{"verdict":"FAIL"}', diagnostic: 'still failing' }))
  const f = await fixture(true, 'CODING', { verify })
  for (let cycle = 0; cycle < 3; cycle += 1) {
    f.finish()
    if (cycle < 2) await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(cycle + 2))
  }
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({
    state: 'FAILED', reasonCode: 'PI_VERIFICATION_CORRECTION_EXHAUSTED',
  }))
  expect(f.prompt).toHaveBeenCalledTimes(3)
  expect(verify).toHaveBeenCalledTimes(3)
})

it('invalidates a deferred PASS and releases the worker when cancelled during verification', async () => {
  let resolveVerification!: (value: { verdict: 'PASS'; candidateDigest: string; receiptDigest: string; receiptJson: string }) => void
  const verify = vi.fn(() => new Promise<Parameters<typeof resolveVerification>[0]>(resolve => { resolveVerification = resolve }))
  const f = await fixture(true, 'CODING', { verify })
  f.finish()
  await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
  await expect(f.adapter.interrupt({ runtimeSessionId: f.id, requestId: 'cancel-verify', reason: 'user' }))
    .resolves.toMatchObject({ requested: true })
  resolveVerification({ verdict: 'PASS', candidateDigest: sha('result'), receiptDigest: sha('late'), receiptJson: '{"verdict":"PASS"}' })
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({ state: 'INTERRUPTED' }))
  expect(f.prompt).toHaveBeenCalledTimes(1)
  expect(f.close).toHaveBeenCalledTimes(1)
})

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

it('uses the frozen V2 worktree authorization for canonical CODING file lifecycle without per-file permission', async () => {
  const f = await fixture(true)
  expect(f.factory).toHaveBeenCalledWith(expect.objectContaining({ worktreeAuthorized: true }))
  await expect(f.call('read-v2', 'read', { path: 'a.txt' })).resolves.toMatchObject({ ok: true, value: {
    authorizedRelativePath: 'a.txt',
  } })
  await expect(f.settle('read-v2')).resolves.toMatchObject({ ok: true })

  await expect(f.call('delete-v2', 'delete', { path: 'a.txt' })).resolves.toMatchObject({ ok: true, value: {
    authorizedRelativePath: 'a.txt',
  } })
  rmSync(join(f.root, 'a.txt'))
  await expect(f.settle('delete-v2')).resolves.toMatchObject({ ok: true })

  writeFileSync(join(f.root, 'source.txt'), 'source')
  mkdirSync(join(f.root, 'nested'))
  await expect(f.call('rename-v2', 'rename', { sourcePath: 'source.txt', targetPath: 'nested/target.txt' }))
    .resolves.toMatchObject({ ok: true, value: { authorizedRelativePath: 'source.txt', authorizedTargetRelativePath: 'nested/target.txt' } })
  renameSync(join(f.root, 'source.txt'), join(f.root, 'nested', 'target.txt'))
  await expect(f.settle('rename-v2')).resolves.toMatchObject({ ok: true })
  expect([...await collectEvents(f.adapter, f.id)].some(event => event.type === 'PERMISSION_REQUESTED')).toBe(false)
})

it.each([
  ['delete', { path: '.git/config' }],
  ['write', { path: 'file.txt:stream' }],
  ['write', { path: 'CON.txt' }],
  ['rename', { sourcePath: 'a.txt', targetPath: 'A.TXT' }],
])('rejects unsafe V2 %s targets before native execution', async (toolName, input) => {
  const f = await fixture(true)
  await expect(f.call(`unsafe-${toolName}`, toolName, input)).resolves.toMatchObject({ ok: false })
})

it('keeps one V2 write active through settle and preserves UNKNOWN after a failed delete postcondition', async () => {
  const f = await fixture(true)
  await expect(f.call('write-first', 'write', { path: 'first.txt' })).resolves.toMatchObject({ ok: true })
  await expect(f.call('write-concurrent', 'write', { path: 'second.txt' })).resolves.toMatchObject({ ok: false })
  await expect(f.settle('write-first')).resolves.toMatchObject({ ok: true })
  await expect(f.call('delete-unknown', 'delete', { path: 'a.txt' })).resolves.toMatchObject({ ok: true })
  await expect(f.settle('delete-unknown')).resolves.toMatchObject({ ok: false })
  await expect(f.call('write-after-unknown', 'write', { path: 'after.txt' })).resolves.toMatchObject({ ok: false })
})

it('writes a WORK artifact to the V2 target selected in the professional tool request', async () => {
  const f = await fixture(true, 'WORK')
  const result = await f.host({ type: 'host-tool-request', requestId: 'work-report', method: 'xiaogui.work.report-docx.v1',
    payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', sourceRunId: 'run-1', toolCallId: 'work-report-1',
      action: 'PREPARE', targetPath: 'reports/final.docx', draft: { title: '报告', sections: [{ heading: '结论', paragraphs: ['正文'], bullets: [] }] } } } as never)
  expect(result).toMatchObject({ ok: true, value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_ATTEMPT_ARTIFACT',
    relativePath: 'reports/final.docx' } })
  const corrected = await f.host({ type: 'host-tool-request', requestId: 'work-report-corrected', method: 'xiaogui.work.report-docx.v1',
    payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', sourceRunId: 'run-1', toolCallId: 'work-report-2',
      action: 'PREPARE', targetPath: 'reports/final.docx', draft: { title: '报告', sections: [{ heading: '结论', paragraphs: ['修正文'], bullets: [] }] } } } as never)
  expect(corrected).toMatchObject({ ok: true, value: { relativePath: 'reports/final.docx' } })
  const db = new DatabaseSync(f.options.dbPath, { readOnly: true })
  const stored = db.prepare('select data_json from pi_attempt_runtime_v1 where id = ?').get(f.id) as { data_json: string }
  db.close()
  expect((JSON.parse(stored.data_json) as { artifacts: unknown[] }).artifacts).toHaveLength(1)
})

it('reads only V2 ledger sources and writes the DESIGN artifact to the selected target', async () => {
  vi.mocked(createXiaoguiIntegration).mockReturnValue({
    invokeTool: vi.fn(async () => ({ status: 'ok', warnings: [], source_version: 'fixture-v1', trace_id: 'trace-1',
      generated_at: '2026-09-15T00:00:00.000Z', evidence: [{}], data: { file_count: 1, has_professional_files: true } })),
    shutdown: vi.fn(async () => {}),
  } as never)
  const f = await fixture(true, 'DESIGN')
  const result = await f.host({ type: 'host-tool-request', requestId: 'design-project', method: 'xiaogui.taskhub.design-project',
    payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', toolCallId: 'design-1', action: 'inspect',
      sourcePaths: ['a.txt'], targetPath: 'design/result.json' } })
  expect(result).toMatchObject({ ok: true, value: { kind: 'PI_DESIGN_PROJECT_ARTIFACT', relativePath: 'design/result.json' } })
})

it.each(['WORK', 'DESIGN'] as const)('verifies a live unsettled %s artifact through the real mode verifier', async (mode) => {
  if (mode === 'DESIGN') vi.mocked(createXiaoguiIntegration).mockReturnValue({
    invokeTool: vi.fn(async () => ({ status: 'ok', warnings: [], source_version: 'fixture-v1', trace_id: 'trace-1',
      generated_at: '2026-09-15T00:00:00.000Z', evidence: [{}], data: { file_count: 1, has_professional_files: true } })),
    shutdown: vi.fn(async () => {}),
  } as never)
  const holder: { f?: Awaited<ReturnType<typeof fixture>> } = {}
  const verify = vi.fn(async (input: Parameters<NonNullable<PiRuntimeOptionsV1['unsettledVerification']>['verify']>[0]) => {
    const current = holder.f!
    expect(await current.adapter.inspect(current.id)).toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_STILL_RUNNING' })
    const request = Object.freeze({ scope: 'TASK', verificationAttemptId: 'live-verify' as VerificationAttemptId,
      verificationRequestId: 'live-request', flowId: input.flowId as FlowId, taskRunId: input.taskRunId as TaskRunId,
      attemptId: input.attemptId as AttemptId, candidateId: 'live-candidate' as TaskChangeSetCandidateId,
      requestDigest: sha('live-request'), changeSetDigest: sha('live-change'), preparedTreeHash: input.candidateDigest as Sha256Digest,
      qaConfigVersion: mode === 'WORK' ? 'xiaogui.work.report.task.v1' : 'xiaogui.design.project.task.v1',
      acceptanceCriteria: [mode === 'WORK' ? 'work.report-docx' : 'design.project'] } satisfies FrozenTaskVerificationRequestV1)
    const context = Object.freeze({ verificationScope: 'TASK' as const, artifactPaths: [mode === 'WORK' ? 'reports/live.docx' : 'design/live.json'],
      worktreeRoot: current.root, trustedToolchainRoot: current.root, scopeEvidenceArtifactId: 'scope-live' as ArtifactId,
      inspectionArtifactId: 'inspection-live' as ArtifactId, worktreeAuthorizationDigest: sha('authorization') })
    const port = new ModeTaskVerificationPortV1({ verify: async () => { throw new Error('CODING_PORT_FORBIDDEN') } },
      (candidate, privateContext) => current.adapter.verificationContext(candidate, privateContext))
    await expect(port.verify(Object.freeze({ ...request, preparedTreeHash: sha('wrong') }) as FrozenTaskVerificationRequestV1, context))
      .resolves.toMatchObject({ receipt: { verdict: 'OUTCOME_UNKNOWN' } })
    await expect(port.verify(request, Object.freeze({ ...context, worktreeRoot: join(current.root, 'wrong') })))
      .resolves.toMatchObject({ receipt: { verdict: 'OUTCOME_UNKNOWN' } })
    const result = await port.verify(request, context)
    expect(result.receipt.verdict).toBe('PASS')
    return { verdict: 'PASS' as const, candidateDigest: input.candidateDigest, receiptDigest: result.receipt.receiptDigest,
      receiptJson: JSON.stringify(result.receipt) }
  })
  const f = await fixture(true, mode, { verify })
  holder.f = f
  if (mode === 'WORK') await f.host({ type: 'host-tool-request', requestId: 'live-work', method: 'xiaogui.work.report-docx.v1',
    payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', sourceRunId: 'run-1', toolCallId: 'live-work', action: 'PREPARE',
      targetPath: 'reports/live.docx', draft: { title: '报告', sections: [{ heading: '结论', paragraphs: ['正文'], bullets: [] }] } } } as never)
  else await f.host({ type: 'host-tool-request', requestId: 'live-design', method: 'xiaogui.taskhub.design-project',
    payload: { attemptId: 'attempt-1', sourceSessionId: 'pi-1', toolCallId: 'live-design', action: 'inspect',
      sourcePaths: ['a.txt'], targetPath: 'design/live.json' } })
  f.finish()
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({ state: 'SUCCEEDED' }))
  expect(verify).toHaveBeenCalledOnce()
  expect(f.close).toHaveBeenCalledOnce()
})

async function collectEvents(adapter: PiRuntimeAdapterV1, id: string): Promise<RuntimeEventV1[]> {
  const events: RuntimeEventV1[] = []
  for await (const event of adapter.stream(id, 0)) events.push(event)
  return events
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

it.each([
  ['root absolute', (root: string) => join(root, 'a.txt')],
  ['dot relative', () => './a.txt'],
])('normalizes a legacy V1 %s path before the unchanged manifest and permission gates', async (_label, pathOf) => {
  const f = await fixture()
  const callId = `v1-${_label.replaceAll(' ', '-')}`
  const call = f.call(callId, 'read', { path: pathOf(f.root) })
  const event = await permission(f.adapter, f.id)
  await f.adapter.permission({ type: 'ALLOW_ONCE', runtimeSessionId: f.id, decisionRequestId: `allow-${_label}`,
    proofId: 'proof', proofDigest: sha('proof'), permissionRequestId: event.permissionRequestId,
    challengeDigest: event.challengeDigest, scope: f.request.scope })
  await expect(call).resolves.toMatchObject({ ok: true, value: { authorizedRelativePath: 'a.txt' } })
  await expect(f.settle(callId)).resolves.toMatchObject({ ok: true })
})

it.each([
  ['outside absolute', (root: string) => resolve(root, '..', 'outside.txt')],
  ['git metadata', (root: string) => join(root, '.git', 'config')],
  ['alternate data stream', (root: string) => join(root, 'a.txt:stream')],
  ['unapproved file', (root: string) => join(root, 'other.txt')],
])('keeps the legacy V1 boundary after normalizing a %s path', async (_label, pathOf) => {
  const f = await fixture()
  await expect(f.call(`v1-reject-${_label.replaceAll(' ', '-')}`, 'read', { path: pathOf(f.root) })).resolves.toMatchObject({ ok: false })
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

it('persists a terminal result before releasing the worker, and ignores duplicate terminal events', async () => {
  const f = await fixture()
  let persistedBeforeClose = false
  f.close.mockImplementationOnce(async () => {
    const db = new DatabaseSync(f.options.dbPath)
    try {
      const stored = db.prepare('SELECT data_json FROM pi_attempt_runtime_v1 WHERE id=?').get(f.id) as { data_json: string }
      persistedBeforeClose = JSON.parse(stored.data_json).outcome?.state === 'SUCCEEDED'
    } finally {
      db.close()
    }
    f.workerExits[0]()
  })
  f.finish()
  f.finish()

  await vi.waitFor(async () => {
    await expect(f.adapter.inspect(f.id)).resolves.toMatchObject({ state: 'SUCCEEDED' })
    expect(f.close).toHaveBeenCalledTimes(1)
  })
  expect(persistedBeforeClose).toBe(true)
  const db = new DatabaseSync(f.options.dbPath)
  try {
    const stored = db.prepare('SELECT data_json FROM pi_attempt_runtime_v1 WHERE id=?').get(f.id) as { data_json: string }
    expect(JSON.parse(stored.data_json)).toMatchObject({ id: f.id, outcome: { state: 'SUCCEEDED' } })
  } finally {
    db.close()
  }
  await f.adapter.close()
  adapters.delete(f.adapter)
  const restored = new PiRuntimeAdapterV1(f.options)
  adapters.add(restored)
  await expect(restored.createOrResume(f.request)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  expect(f.factory).toHaveBeenCalledTimes(1)
  expect(f.prompt).toHaveBeenCalledTimes(1)
})

it('downgrades a terminal persist failure to UNKNOWN before releasing the worker', async () => {
  const f = await fixture()
  const db = new DatabaseSync(f.options.dbPath)
  try {
    db.exec(`CREATE TRIGGER reject_success_persist BEFORE UPDATE OF data_json ON pi_attempt_runtime_v1
      WHEN json_extract(NEW.data_json, '$.outcome.state') = 'SUCCEEDED'
      BEGIN SELECT RAISE(ABORT, 'fixture persist failure'); END`)
  } finally {
    db.close()
  }

  f.finish()
  await vi.waitFor(async () => expect(await f.adapter.inspect(f.id)).toMatchObject({
    state: 'OUTCOME_UNKNOWN', reasonCode: 'PI_OUTCOME_PERSIST_FAILED',
  }))
  expect(f.close).toHaveBeenCalledTimes(1)
  await expect(f.adapter.createOrResume(f.request)).resolves.toMatchObject({
    state: 'OUTCOME_UNKNOWN', reasonCode: 'PI_OUTCOME_PERSIST_FAILED',
  })
  expect(f.factory).toHaveBeenCalledTimes(1)
  expect(f.prompt).toHaveBeenCalledTimes(1)
})

it('releases only the worker for the Attempt that reached a terminal state', async () => {
  const f = await fixture()
  const secondRequest = runtimeRequestForSource(f.request, 'create-2', 'attempt-2', 'task-2')
  const second = await f.adapter.createOrResume(secondRequest)
  if (second.state !== 'READY') throw new Error('second fixture did not start')
  expect(f.factory).toHaveBeenCalledTimes(2)

  f.finish()
  await vi.waitFor(() => expect(f.closes[0]).toHaveBeenCalledTimes(1))
  expect(f.closes[1]).not.toHaveBeenCalled()

  f.workerEvents[1]({ type: 'run', phase: 'failed', settled: true } as AppEvent)
  await vi.waitFor(async () => expect(await f.adapter.inspect(second.runtimeSessionId)).toMatchObject({ state: 'FAILED' }))
  expect(f.closes[0]).toHaveBeenCalledTimes(1)
  expect(f.closes[1]).toHaveBeenCalledTimes(1)
})

it('waits for an in-flight finish during shutdown and retains the persisted UNKNOWN after close failure', async () => {
  const f = await fixture()
  let releasePatch!: () => void
  vi.spyOn(f.options.workspace, 'captureTaskPatch').mockImplementation(async () => {
    await new Promise<void>(resolve => { releasePatch = resolve })
    return { resultTreeHash: sha('result') } as never
  })
  f.finish()
  await vi.waitFor(() => expect(f.options.workspace.captureTaskPatch).toHaveBeenCalledTimes(1))
  f.close.mockRejectedValueOnce(new Error('fixture close failure'))

  let shutdownFinished = false
  const shutdown = f.adapter.close().then(() => { shutdownFinished = true })
  await Promise.resolve()
  expect(shutdownFinished).toBe(false)
  releasePatch()
  await shutdown
  expect(f.close).toHaveBeenCalledTimes(1)

  const db = new DatabaseSync(f.options.dbPath)
  try {
    const stored = db.prepare('SELECT data_json FROM pi_attempt_runtime_v1 WHERE id=?').get(f.id) as { data_json: string }
    expect(JSON.parse(stored.data_json)).toMatchObject({ outcome: { state: 'OUTCOME_UNKNOWN', reasonCode: 'PI_SHUTDOWN_UNKNOWN' } })
  } finally {
    db.close()
  }
})
