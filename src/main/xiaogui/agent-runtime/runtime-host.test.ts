import { describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
  RuntimeCapabilityV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimePermissionDecisionV1,
  RuntimeProductionPolicyV1,
} from '@shared/xiaogui-agent-runtime'
import { createAgentRuntimeHostV1 } from './runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from './scripted-adapter'

const selection = {
  adapterId: 'kimi-acp',
  runtimeKind: 'KIMI',
  protocol: 'ACP',
  capabilityDigest: 'sha256:capability-approved',
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  diagnosticOnly: false,
  stream: 'PUSH',
  interrupt: 'ACKED',
  inspect: 'RECONCILE',
} satisfies RuntimeAdapterSelectionV1

const capability = {
  ...selection,
  health: 'AVAILABLE',
  canCreateSession: true,
  canResumeSession: true,
  interactivePermission: 'HOST_MEDIATED',
} satisfies RuntimeCapabilityV1

const policy = {
  rejectDiagnosticOnly: true,
  allowedSelections: [selection],
} satisfies RuntimeProductionPolicyV1

function request(overrides: Partial<RuntimeCreateOrResumeRequestV1> = {}): RuntimeCreateOrResumeRequestV1 {
  return {
    requestId: 'req-create',
    scope: {
      projectId: 'xgp1_project',
      sessionKey: 'xgs1_session',
      sessionMode: 'CODING',
      flowId: 'flow-1',
      taskRunId: 'run-1',
      attemptId: 'attempt-1',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace-receipt-1',
      workspaceReceiptDigest: 'sha256:workspace-receipt',
    },
    workspace: {
      attemptWorktreeId: 'worktree-1',
      worktreeRootDigest: 'sha256:worktree-root',
      baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:target-root',
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection,
    productionPolicy: policy,
    promptEnvelopeRef: {
      refId: 'prompt-ref-1',
      digest: 'sha256:prompt',
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
    ...overrides,
  }
}

async function collect(iterable: AsyncIterable<RuntimeEventV1>) {
  const events: RuntimeEventV1[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('AgentRuntimeHostV1', () => {
  it('discovers capabilities but fails closed for unapproved production selections', async () => {
    const host = createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [capability] }))

    await expect(host.discover()).resolves.toEqual([capability])
    await expect(host.createOrResume(request({ selection: { ...selection, capabilityDigest: 'sha256:unapproved' } }))).resolves.toEqual({
      state: 'FAILED',
      runtimeSessionId: 'runtime-unbound',
      receiptDigest: 'sha256:runtime-selection-rejected',
      reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED',
    })
  })

  it('fails closed when adapter capability or create outcome leaks public DTO data', async () => {
    const host = createAgentRuntimeHostV1(
      new ScriptedAgentRuntimeAdapterV1({
        capabilities: [{ ...capability, reasonCode: 'C:\\Users\\90662\\runtime' }],
        createOutcome: { state: 'SUCCEEDED', runtimeSessionId: 'runtime-1', receiptDigest: 'sha256:receipt', candidateDigest: 'file:///secret.patch' },
      }),
    )

    await expect(host.discover()).resolves.toEqual([
      expect.objectContaining({ adapterId: 'runtime-public-dto-leak', health: 'UNAVAILABLE', reasonCode: 'PUBLIC_DTO_LEAK' }),
    ])
    await expect(host.health(selection.adapterId)).resolves.toMatchObject({ health: 'UNAVAILABLE', reasonCode: 'PUBLIC_DTO_LEAK' })
    await expect(host.createOrResume(request())).resolves.toEqual({
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: 'runtime-1',
      inspectHandleDigest: 'sha256:public-dto-leak',
      reasonCode: 'PUBLIC_DTO_LEAK',
    })

    const unsafeSessionHost = createAgentRuntimeHostV1(
      new ScriptedAgentRuntimeAdapterV1({
        capabilities: [capability],
        createRuntimeSessionId: 'runtime session with spaces',
      }),
    )
    await expect(unsafeSessionHost.createOrResume(request())).resolves.toEqual({
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: 'runtime-unbound',
      inspectHandleDigest: 'sha256:public-dto-leak',
      reasonCode: 'PUBLIC_DTO_LEAK',
    })
  })

  it('replays identical createOrResume requests and rejects same-key payload drift', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({ capabilities: [capability], createRuntimeSessionId: 'runtime-1' })
    const host = createAgentRuntimeHostV1(adapter)
    const firstRequest = request()

    const first = await host.createOrResume(firstRequest)
    await expect(host.createOrResume(firstRequest)).resolves.toEqual(first)
    await expect(
      host.createOrResume(
        request({
          workspace: { ...firstRequest.workspace, baseRevisionDigest: 'sha256:changed-base' },
        }),
      ),
    ).resolves.toEqual({
      state: 'FAILED',
      runtimeSessionId: 'runtime-unbound',
      receiptDigest: 'sha256:idempotency-conflict',
      reasonCode: 'IDEMPOTENCY_CONFLICT',
    })
  })

  it('rejects adapter reuse across attempt or worktree bindings', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({ capabilities: [capability], createRuntimeSessionId: 'runtime-1' })
    const host = createAgentRuntimeHostV1(adapter)

    await expect(host.createOrResume(request())).resolves.toMatchObject({ state: 'READY', runtimeSessionId: 'runtime-1' })
    await expect(
      host.createOrResume(
        request({
          requestId: 'req-create-2',
          scope: { ...request().scope, attemptId: 'attempt-2' },
        }),
      ),
    ).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'RUNTIME_SESSION_SCOPE_MISMATCH' })
    await expect(
      host.createOrResume(
        request({
          requestId: 'req-create-3',
          workspace: { ...request().workspace, attemptWorktreeId: 'worktree-2' },
        }),
      ),
    ).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'RUNTIME_SESSION_SCOPE_MISMATCH' })
  })

  it('streams only monotonic events and converts sequence gaps or leaking packets to OUTCOME_UNKNOWN', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [capability],
      createRuntimeSessionId: 'runtime-1',
      createOutcomesByRequestId: {
        'req-gap': { state: 'READY', runtimeSessionId: 'gap' },
        'req-leak': { state: 'READY', runtimeSessionId: 'leak' },
      },
      eventsBySession: {
        'runtime-1': [
          { type: 'SESSION_READY', runtimeSessionId: 'runtime-1', sequence: 1 },
          { type: 'TEXT_DELTA', runtimeSessionId: 'runtime-1', sequence: 2, textDigest: 'sha256:text' },
        ],
        gap: [{ type: 'TEXT_DELTA', runtimeSessionId: 'gap', sequence: 3, textDigest: 'sha256:text' }],
        leak: [{ type: 'TOOL_EVENT', runtimeSessionId: 'leak', sequence: 1, toolName: 'C:\\Users\\90662\\tool.exe', eventDigest: 'sha256:event' }],
      },
    })
    const host = createAgentRuntimeHostV1(adapter)
    await host.createOrResume(request())
    await host.createOrResume(request({ requestId: 'req-gap' }))
    await host.createOrResume(request({ requestId: 'req-leak' }))

    await expect(collect(host.stream('runtime-1', 1))).resolves.toEqual([
      { type: 'TEXT_DELTA', runtimeSessionId: 'runtime-1', sequence: 2, textDigest: 'sha256:text' },
    ])
    await expect(collect(host.stream('gap', 0))).resolves.toEqual([
      { type: 'OUTCOME_UNKNOWN', runtimeSessionId: 'gap', sequence: 1, reasonCode: 'EVENT_SEQUENCE_GAP' },
    ])
    await expect(collect(host.stream('leak', 0))).resolves.toEqual([
      { type: 'OUTCOME_UNKNOWN', runtimeSessionId: 'leak', sequence: 1, reasonCode: 'PUBLIC_DTO_LEAK' },
    ])
  })

  it('rejects unbound streams, runtimeSessionId mismatches, and duplicate event packets', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [capability],
      createRuntimeSessionId: 'runtime-1',
      createOutcomesByRequestId: {
        'req-mismatch': { state: 'READY', runtimeSessionId: 'mismatch' },
      },
      eventsBySession: {
        'runtime-1': [
          { type: 'SESSION_READY', runtimeSessionId: 'runtime-1', sequence: 1 },
          { type: 'TEXT_DELTA', runtimeSessionId: 'runtime-1', sequence: 1, textDigest: 'sha256:duplicate' },
        ],
        mismatch: [{ type: 'SESSION_READY', runtimeSessionId: 'other-runtime', sequence: 1 }],
      },
    })
    const host = createAgentRuntimeHostV1(adapter)
    await host.createOrResume(request())
    await host.createOrResume(request({ requestId: 'req-mismatch' }))

    await expect(collect(host.stream('missing', 0))).resolves.toEqual([
      { type: 'OUTCOME_UNKNOWN', runtimeSessionId: 'missing', sequence: 1, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' },
    ])
    await expect(collect(host.stream('mismatch', 0))).resolves.toEqual([
      { type: 'OUTCOME_UNKNOWN', runtimeSessionId: 'mismatch', sequence: 1, reasonCode: 'RUNTIME_EVENT_SESSION_MISMATCH' },
    ])
    await expect(collect(host.stream('runtime-1', 0))).resolves.toEqual([
      { type: 'SESSION_READY', runtimeSessionId: 'runtime-1', sequence: 1 },
      { type: 'OUTCOME_UNKNOWN', runtimeSessionId: 'runtime-1', sequence: 2, reasonCode: 'EVENT_SEQUENCE_GAP' },
    ])
  })

  it('binds ALLOW_ONCE permission proof to challenge, scope, runtime session, and one decision request', async () => {
    const host = createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [capability],
      createRuntimeSessionId: 'runtime-1',
      eventsBySession: {
        'runtime-1': [{
          type: 'PERMISSION_REQUESTED',
          permissionRequestId: 'perm-1',
          runtimeSessionId: 'runtime-1',
          scope: request().scope,
          sequence: 1,
          challengeDigest: 'sha256:challenge',
          decisionRequired: 'ALLOW_ONCE_OR_DENY',
        }],
      },
    }))
    await host.createOrResume(request())
    await expect(collect(host.stream('runtime-1', 0))).resolves.toMatchObject([{ type: 'PERMISSION_REQUESTED', permissionRequestId: 'perm-1' }])
    const decision = {
      type: 'ALLOW_ONCE',
      permissionRequestId: 'perm-1',
      challengeDigest: 'sha256:challenge',
      decisionRequestId: 'decision-1',
      scope: request().scope,
      runtimeSessionId: 'runtime-1',
      proofId: 'proof-1',
      proofDigest: 'sha256:proof',
    } satisfies RuntimePermissionDecisionV1

    await expect(host.permission(decision)).resolves.toEqual({ accepted: true })
    await expect(host.permission(decision)).resolves.toEqual({ accepted: true })
    await expect(host.permission({ ...decision, decisionRequestId: 'decision-2' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_REQUEST_CONSUMED',
    })
    await expect(host.permission({ ...decision, decisionRequestId: 'decision-3', challengeDigest: 'sha256:other' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_SCOPE_MISMATCH',
    })
    await expect(host.permission({ ...decision, permissionRequestId: 'perm-never-seen', decisionRequestId: 'decision-4' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_SCOPE_MISMATCH',
    })
    await expect(host.permission({ ...decision, decisionRequestId: 'decision-1', proofId: 'proof-drift' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_DECISION_CONFLICT',
    })
    await expect(host.permission({ ...decision, decisionRequestId: 'decision-5', proofId: 'proof-2', proofDigest: 'sha256:proof-2' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_REQUEST_CONSUMED',
    })
    await expect(host.permission({ ...decision, decisionRequestId: 'decision-6', runtimeSessionId: 'C:\\Users\\90662\\runtime' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PUBLIC_DTO_LEAK',
    })
  })

  it('keeps interrupt, inspect, and reconcile outcomes explicit without creating M2 domain effects', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [capability],
      createRuntimeSessionId: 'runtime-1',
      createOutcomesByRequestId: {
        'req-failed': { state: 'READY', runtimeSessionId: 'failed' },
        'req-interrupted': { state: 'READY', runtimeSessionId: 'interrupted' },
        'req-running': { state: 'READY', runtimeSessionId: 'running' },
        'req-unknown': { state: 'READY', runtimeSessionId: 'unknown' },
        'req-mismatch': { state: 'READY', runtimeSessionId: 'mismatch' },
      },
      outcomesBySession: {
        'runtime-1': { state: 'SUCCEEDED', runtimeSessionId: 'runtime-1', receiptDigest: 'sha256:receipt', candidateDigest: 'sha256:candidate' },
        failed: { state: 'FAILED', runtimeSessionId: 'failed', receiptDigest: 'sha256:receipt', reasonCode: 'TEST_FAILED' },
        interrupted: { state: 'INTERRUPTED', runtimeSessionId: 'interrupted', receiptDigest: 'sha256:receipt', reasonCode: 'USER_INTERRUPTED' },
        running: { state: 'OUTCOME_UNKNOWN', runtimeSessionId: 'running', inspectHandleDigest: 'sha256:running', reasonCode: 'RUNTIME_STILL_RUNNING' },
        unknown: { state: 'OUTCOME_UNKNOWN', runtimeSessionId: 'unknown', inspectHandleDigest: 'sha256:inspect', reasonCode: 'PROCESS_DISCONNECTED' },
        mismatch: { state: 'SUCCEEDED', runtimeSessionId: 'other-runtime', receiptDigest: 'sha256:receipt', candidateDigest: 'sha256:candidate' },
      },
    })
    const host = createAgentRuntimeHostV1(adapter)
    await host.createOrResume(request())
    await host.createOrResume(request({ requestId: 'req-failed' }))
    await host.createOrResume(request({ requestId: 'req-interrupted' }))
    await host.createOrResume(request({ requestId: 'req-running' }))
    await host.createOrResume(request({ requestId: 'req-unknown' }))
    await host.createOrResume(request({ requestId: 'req-mismatch' }))

    await expect(host.interrupt({ requestId: 'interrupt-missing', runtimeSessionId: 'missing', reason: 'user_cancelled' })).resolves.toEqual({
      requested: false,
      reasonCode: 'RUNTIME_SESSION_NOT_FOUND',
    })
    await expect(host.interrupt({ requestId: 'interrupt-1', runtimeSessionId: 'runtime-1', reason: 'user_cancelled' })).resolves.toEqual({
      requested: false,
      reasonCode: 'RUNTIME_ALREADY_SETTLED',
    })
    await expect(host.interrupt({ requestId: 'interrupt-running', runtimeSessionId: 'running', reason: 'user_cancelled' })).resolves.toEqual({
      requested: true,
    })
    await expect(host.inspect('runtime-1')).resolves.toMatchObject({ state: 'SUCCEEDED' })
    await expect(host.inspect('missing')).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_SESSION_NOT_FOUND' })
    await expect(host.inspect('failed')).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'TEST_FAILED' })
    await expect(host.inspect('interrupted')).resolves.toMatchObject({ state: 'INTERRUPTED', reasonCode: 'USER_INTERRUPTED' })
    await expect(host.inspect('mismatch')).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_OUTCOME_SESSION_MISMATCH' })
    await expect(host.reconcile('unknown')).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'PROCESS_DISCONNECTED' })
    await expect(host.reconcile('missing')).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_SESSION_NOT_FOUND' })
    expect(Object.keys(host).sort()).toEqual([
      'createOrResume',
      'discover',
      'health',
      'inspect',
      'interrupt',
      'permission',
      'reconcile',
      'send',
      'stream',
    ])
  })
})
