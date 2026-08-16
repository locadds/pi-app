import { describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
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
    const host = createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [selection] }))

    await expect(host.discover()).resolves.toEqual([selection])
    await expect(host.createOrResume(request({ selection: { ...selection, capabilityDigest: 'sha256:unapproved' } }))).resolves.toEqual({
      state: 'FAILED',
      runtimeSessionId: '',
      receiptDigest: 'sha256:runtime-selection-rejected',
      reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED',
    })
  })

  it('replays identical createOrResume requests and rejects same-key payload drift', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({ capabilities: [selection], createRuntimeSessionId: 'runtime-1' })
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
      runtimeSessionId: '',
      receiptDigest: 'sha256:idempotency-conflict',
      reasonCode: 'IDEMPOTENCY_CONFLICT',
    })
  })

  it('rejects adapter reuse across attempt or worktree bindings', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({ capabilities: [selection], createRuntimeSessionId: 'runtime-1' })
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
      capabilities: [selection],
      createRuntimeSessionId: 'runtime-1',
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

  it('binds ALLOW_ONCE permission proof to challenge, scope, runtime session, and one decision request', async () => {
    const host = createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [selection],
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
      reasonCode: 'PERMISSION_PROOF_REPLAYED',
    })
    await expect(host.permission({ ...decision, decisionRequestId: 'decision-3', challengeDigest: 'sha256:other' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_SCOPE_MISMATCH',
    })
    await expect(host.permission({ ...decision, permissionRequestId: 'perm-never-seen', decisionRequestId: 'decision-4' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_SCOPE_MISMATCH',
    })
  })

  it('keeps interrupt, inspect, and reconcile outcomes explicit without creating M2 domain effects', async () => {
    const adapter = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [selection],
      createRuntimeSessionId: 'runtime-1',
      outcomesBySession: {
        'runtime-1': { state: 'SUCCEEDED', runtimeSessionId: 'runtime-1', receiptDigest: 'sha256:receipt', candidateDigest: 'sha256:candidate' },
        unknown: { state: 'OUTCOME_UNKNOWN', runtimeSessionId: 'unknown', inspectHandleDigest: 'sha256:inspect', reasonCode: 'PROCESS_DISCONNECTED' },
      },
    })
    const host = createAgentRuntimeHostV1(adapter)
    await host.createOrResume(request())

    await expect(host.interrupt({ requestId: 'interrupt-1', runtimeSessionId: 'runtime-1', reason: 'user_cancelled' })).resolves.toEqual({
      requested: false,
      reasonCode: 'RUNTIME_ALREADY_SETTLED',
    })
    await expect(host.inspect('runtime-1')).resolves.toMatchObject({ state: 'SUCCEEDED' })
    await expect(host.reconcile('unknown')).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'PROCESS_DISCONNECTED' })
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
