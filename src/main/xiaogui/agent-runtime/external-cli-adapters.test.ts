import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
  RuntimeCreateOrResumeRequestV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'
import {
  codexHeadlessSelectionV1,
  createCodexHeadlessRuntimeAdapterV1,
  type CodexHeadlessDriverSessionV1,
} from './codex-headless-adapter'
import { CodexCliProcessDriverV1 } from './codex-headless-process'
import { createQoderDiagnosticAdapterV1, selectExternalAgentProtocolV1 } from './external-cli-adapters'
import { createAgentRuntimeRegistryV1 } from './runtime-registry'

describe('external runtime admission gate', () => {
  it('uses the fixed ACP, SDK, recoverable headless, diagnostic order', () => {
    expect(selectExternalAgentProtocolV1({ stableAcp: true, stableSdk: true, headlessRecoverable: true, headlessInterruptible: true, headlessInspectable: true })).toMatchObject({ protocol: 'ACP', productionEligible: true })
    expect(selectExternalAgentProtocolV1({ stableAcp: false, stableSdk: true, headlessRecoverable: true, headlessInterruptible: true, headlessInspectable: true })).toMatchObject({ protocol: 'SDK', productionEligible: true })
    expect(selectExternalAgentProtocolV1({ stableAcp: false, stableSdk: false, headlessRecoverable: true, headlessInterruptible: true, headlessInspectable: true })).toMatchObject({ protocol: 'HEADLESS', productionEligible: true })
    expect(selectExternalAgentProtocolV1({ stableAcp: false, stableSdk: false, headlessRecoverable: true, headlessInterruptible: false, headlessInspectable: true })).toMatchObject({ protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC', productionEligible: false })
  })

  it('keeps Qoder diagnostic-only while its installed CLI lacks a recoverable headless protocol', async () => {
    const adapter = createQoderDiagnosticAdapterV1({
      probe: { stableAcp: false, stableSdk: false, headlessRecoverable: false, headlessInterruptible: false, headlessInspectable: false },
    })
    await expect(adapter.discover()).resolves.toMatchObject([{
      adapterId: 'qoder-adapter',
      runtimeKind: 'QODER',
      diagnosticOnly: true,
      approvalStatus: 'DISCOVERED',
      canCreateSession: false,
    }])
  })

  it('does not production-enable Codex without an exact explicit gate', async () => {
    const adapter = createCodexHeadlessRuntimeAdapterV1({
      payloadResolver: payloadResolver('task'),
      workspaceResolver: workspaceResolver(),
      probe: { findExecutable: async () => ({ available: true, version: '1.2.3' }) },
      driver: driver(),
    })
    await expect(adapter.discover()).resolves.toMatchObject([{
      adapterId: 'codex-headless',
      approvalStatus: 'APPROVED_FOR_TEST',
      protocol: 'HEADLESS',
    }])
  })

  it('does not production-enable Codex without a durable private thread binding store', async () => {
    const version = '1.2.3'
    const selection = codexHeadlessSelectionV1(version)
    const adapter = createCodexHeadlessRuntimeAdapterV1({
      payloadResolver: payloadResolver('task'),
      workspaceResolver: workspaceResolver(),
      probe: { findExecutable: async () => ({ available: true, version }) },
      driver: driver(),
      productionGate: { enabled: true, approvedVersion: version, selection },
    })
    await expect(adapter.discover()).resolves.toMatchObject([{
      approvalStatus: 'APPROVED_FOR_TEST',
      canResumeSession: false,
      supportsResume: false,
    }])
    await expect(adapter.createOrResume(request(selection, 'task'))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'CODEX_DURABLE_BINDING_UNAVAILABLE',
    })
  })

  it('does not production-route the official CLI driver shape when restored results cannot be reconciled', async () => {
    const version = '1.2.3'
    const selection = codexHeadlessSelectionV1(version)
    const adapter = createCodexHeadlessRuntimeAdapterV1({
      payloadResolver: payloadResolver('task'),
      workspaceResolver: workspaceResolver(),
      probe: { findExecutable: async () => ({ available: true, version }) },
      driver: new CodexCliProcessDriverV1(),
      bindingStore: privateBindingStore(),
      productionGate: { enabled: true, approvedVersion: version, selection },
    })
    await expect(adapter.discover()).resolves.toMatchObject([{
      approvalStatus: 'APPROVED_FOR_TEST',
      inspect: 'SNAPSHOT',
      supportsResume: true,
      supportsResultReconcile: false,
      reasonCode: 'CODEX_CROSS_PROCESS_RESULT_RECONCILE_UNAVAILABLE',
    }])
    await expect(adapter.createOrResume(request(selection, 'task'))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'CODEX_CROSS_PROCESS_RESULT_RECONCILE_UNAVAILABLE',
    })
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(adapter)
    await expect(registry.resolve({
      mode: 'CODING',
      requiredCapabilities: ['CODING.GIT.CHANGESET'],
      requiredOperations: ['RESUME', 'RESULT_RECONCILE'],
      dataEgressPolicy: 'EXTERNAL_ALLOWED',
      priorityAdapterIds: ['codex-headless'],
      requireProductionApproval: true,
    })).resolves.toMatchObject({ ok: false, reasonCode: 'NO_APPROVED_RUNTIME' })
  })

  it('starts through a gated driver and publishes only digests and a surrogate session id', async () => {
    const version = '1.2.3'
    const selection = codexHeadlessSelectionV1(version)
    const adapter = createCodexHeadlessRuntimeAdapterV1({
      payloadResolver: payloadResolver('make a safe change'),
      workspaceResolver: workspaceResolver(),
      probe: { findExecutable: async () => ({ available: true, version }) },
      driver: driver(),
      bindingStore: privateBindingStore(),
      productionGate: { enabled: true, approvedVersion: version, selection },
    })
    const created = await adapter.createOrResume(request(selection, 'make a safe change'))
    expect(created).toMatchObject({ state: 'READY' })
    if (created.state !== 'READY') throw new Error('create failed')
    expect(created.runtimeSessionId).toMatch(/^codex_[a-f0-9]{32}$/)
    expect(created.runtimeSessionId).not.toContain('vendor-thread-public')
    const events = []
    for await (const event of adapter.stream(created.runtimeSessionId, 0)) events.push(event)
    expect(events).toMatchObject([
      { type: 'SESSION_READY' },
      { type: 'TEXT_DELTA', textDigest: expect.stringMatching(/^sha256:/) },
      { type: 'TOOL_EVENT', toolName: 'command_execution' },
      { type: 'RUNTIME_SETTLED', outcome: 'SUCCEEDED' },
    ])
    expect(JSON.stringify(events)).not.toContain('make a safe change')
    expect(JSON.stringify(events)).not.toContain('E:\\')
    await expect(adapter.reconcile(created.runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  })

  it('restores after an application restart and resumes by official thread id without persisting prompt or path', async () => {
    const version = '1.2.3'
    const selection = codexHeadlessSelectionV1(version)
    const restored: Array<{ rootPath: string; vendorSessionId: string }> = []
    const starts: Array<{ rootPath: string; prompt: string; resumeSessionId?: string }> = []
    const bindings = privateBindingStore()
    const first = createCodexHeadlessRuntimeAdapterV1({
      payloadResolver: payloadResolver('initial task', 'continue safely'),
      workspaceResolver: workspaceResolver(),
      probe: { findExecutable: async () => ({ available: true, version }) },
      driver: driver(),
      bindingStore: bindings,
      productionGate: { enabled: true, approvedVersion: version, selection },
    })
    const created = await first.createOrResume(request(selection, 'initial task'))
    if (created.state !== 'READY') throw new Error('create failed')
    await (first as typeof first & { close(): Promise<void> }).close()

    const second = createCodexHeadlessRuntimeAdapterV1({
      payloadResolver: payloadResolver('unused', 'continue safely'),
      workspaceResolver: workspaceResolver(),
      probe: { findExecutable: async () => ({ available: true, version }) },
      driver: {
        supportsCrossProcessResultReconcile: true,
        start: async (input) => { starts.push(input); return driverSession(input.resumeSessionId ?? 'new-thread') },
        restore: async (input) => { restored.push(input); return restoredDriverSession(input.vendorSessionId, 'SUCCEEDED') },
      },
      bindingStore: bindings,
      productionGate: { enabled: true, approvedVersion: version, selection },
    })
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(second)
    await registry.discover()
    await expect(registry.restoreBinding(created.runtimeSessionId, selection)).resolves.toEqual({ ok: true })
    await expect(registry.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
    await expect(registry.send({
      requestId: 'follow-up',
      runtimeSessionId: created.runtimeSessionId,
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: {
        refId: 'message-ref',
        digest: `sha256:${createHash('sha256').update('continue safely').digest('hex')}`,
        mediaType: 'application/vnd.xiaogui.runtime-message+json',
      },
    })).resolves.toEqual({ accepted: true, requestId: 'follow-up' })
    expect(restored).toEqual([{ rootPath: 'E:\\isolated-worktree', vendorSessionId: 'vendor-thread-public' }])
    expect(starts).toEqual([{ rootPath: 'E:\\isolated-worktree', prompt: 'continue safely', resumeSessionId: 'vendor-thread-public' }])
    expect(JSON.stringify({ created })).not.toContain('vendor-thread-public')
    expect(JSON.stringify(bindings.records())).not.toContain('initial task')
    expect(JSON.stringify(bindings.records())).not.toContain('isolated-worktree')
  })
})

function driverSession(vendorSessionId = 'vendor-thread-public'): CodexHeadlessDriverSessionV1 {
  return {
    vendorSessionId,
    events: () => [
      { type: 'TEXT', text: 'private model output' },
      { type: 'TOOL', toolName: 'command_execution' },
      { type: 'SETTLED', outcome: 'SUCCEEDED' },
    ],
    interrupt: async () => true,
    outcome: async () => 'SUCCEEDED',
    candidateDigest: async () => 'sha256:actual-worktree-change',
    close: async () => undefined,
  }
}

function restoredDriverSession(
  vendorSessionId: string,
  outcome: 'UNKNOWN' | 'SUCCEEDED' = 'UNKNOWN',
): CodexHeadlessDriverSessionV1 {
  return {
    vendorSessionId,
    events: () => [],
    interrupt: async () => false,
    outcome: async () => outcome,
    candidateDigest: async () => outcome === 'SUCCEEDED' ? 'sha256:restored-candidate' : null,
    close: async () => undefined,
  }
}

function driver() {
  return {
    supportsCrossProcessResultReconcile: true,
    start: async () => driverSession(),
    restore: async (input: { vendorSessionId: string }) => restoredDriverSession(input.vendorSessionId),
  }
}

function workspaceResolver() {
  return {
    resolve: async () => ({ rootPath: 'E:\\isolated-worktree' }),
    restore: async () => ({ rootPath: 'E:\\isolated-worktree' }),
  }
}

function privateBindingStore() {
  const bindings = new Map<string, string>()
  return {
    durable: true as const,
    write: async (binding: { publicSessionId: string; vendorSessionId: string }) => {
      bindings.set(binding.publicSessionId, binding.vendorSessionId)
    },
    read: async (publicSessionId: string) => {
      const vendorSessionId = bindings.get(publicSessionId)
      return vendorSessionId ? { vendorSessionId } : null
    },
    records: () => [...bindings.entries()],
  }
}

function payloadResolver(prompt: string, message = ''): TrustedRuntimePayloadResolverV1 {
  const bytes = Buffer.from(prompt)
  const messageBytes = Buffer.from(message)
  return {
    resolvePrompt: async (ref) => ({ promptEnvelopeRef: ref, redactedPreviewDigest: 'sha256:redacted', payloadBytes: bytes }),
    resolveMessage: async (ref) => ({ messageEnvelopeRef: ref, redactedPreviewDigest: 'sha256:redacted-message', payloadBytes: messageBytes }),
    resolveTextStream: async function* () { yield new Uint8Array() },
    resolveCandidateFile: async () => { throw new Error('unused') },
    toM2ChangeSetCandidate: async () => ({ changeSetCandidateId: 'candidate', digest: 'sha256:candidate' }),
  }
}

function request(selection: RuntimeAdapterSelectionV1, prompt: string): RuntimeCreateOrResumeRequestV1 {
  return {
    requestId: 'codex-create',
    scope: {
      projectId: 'project', sessionKey: 'session', sessionMode: 'CODING', flowId: 'flow', taskRunId: 'run',
      attemptId: 'attempt', attemptDigest: 'sha256:attempt', workspaceReceiptId: 'workspace', workspaceReceiptDigest: 'sha256:workspace',
    },
    workspace: {
      attemptWorktreeId: 'worktree', worktreeRootDigest: 'sha256:worktree', baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:target', writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection,
    productionPolicy: { allowedSelections: [selection], rejectDiagnosticOnly: true },
    promptEnvelopeRef: {
      refId: 'prompt-ref', digest: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
  }
}
