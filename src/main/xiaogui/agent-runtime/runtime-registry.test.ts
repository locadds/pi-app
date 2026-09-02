import { describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
  RuntimeCapabilityV2,
  RuntimeCreateOrResumeRequestV1,
  RuntimeRoutingPolicyV1,
} from '@shared/xiaogui-agent-runtime'
import { ScriptedAgentRuntimeAdapterV1 } from './scripted-adapter'
import { createAgentRuntimeRegistryV1 } from './runtime-registry'

const kimiCapability = capability({
  adapterId: 'kimi-acp',
  runtimeKind: 'KIMI',
  protocol: 'ACP',
  capabilityDigest: 'sha256:kimi',
  executionLocation: 'EXTERNAL',
  requiresDataEgress: true,
})

const scriptedCapability = capability({
  adapterId: 'scripted-local',
  runtimeKind: 'OTHER',
  protocol: 'HEADLESS',
  capabilityDigest: 'sha256:scripted',
  executionLocation: 'LOCAL',
  requiresDataEgress: false,
  taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'],
})

describe('AgentRuntimeRegistryV1', () => {
  it('discovers multiple adapters and routes deterministically by fixed priority', async () => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [kimiCapability], createRuntimeSessionId: 'kimi-session' }))
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [scriptedCapability], createRuntimeSessionId: 'scripted-session' }))

    await expect(registry.discover()).resolves.toEqual([kimiCapability, scriptedCapability])
    await expect(registry.resolve(policy({ priorityAdapterIds: ['scripted-local', 'kimi-acp'] }))).resolves.toMatchObject({
      ok: true,
      value: { adapterId: 'scripted-local', selection: selectionFor(scriptedCapability) },
    })
  })

  it('honors an explicit approved preference and fails instead of silently falling back', async () => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [scriptedCapability] }))
    await registry.register(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [{ ...kimiCapability, health: 'UNAVAILABLE', reasonCode: 'KIMI_OFFLINE' }],
    }))

    await expect(registry.resolve(policy({ preferredAdapterId: 'kimi-acp', priorityAdapterIds: ['scripted-local'] }))).resolves.toEqual({
      ok: false,
      reasonCode: 'RUNTIME_PREFERRED_NOT_AVAILABLE',
      rejectedAdapterIds: ['kimi-acp'],
    })
  })

  it('keeps local-only tasks away from data egress runtimes', async () => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [kimiCapability] }))
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [scriptedCapability] }))

    await expect(registry.resolve(policy({
      dataEgressPolicy: 'LOCAL_ONLY',
      requiredCapabilities: ['CODING.GIT.CHANGESET', 'EXECUTION.LOCAL_ONLY'],
      priorityAdapterIds: ['kimi-acp', 'scripted-local'],
    }))).resolves.toMatchObject({
      ok: true,
      value: { adapterId: 'scripted-local' },
    })
  })

  it('rejects unapproved or unhealthy runtimes and keeps a started session on its original adapter', async () => {
    const registry = createAgentRuntimeRegistryV1()
    const first = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [scriptedCapability],
      createRuntimeSessionId: 'runtime-first',
      sendResult: { accepted: true, requestId: 'from-first' },
    })
    const second = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [{ ...scriptedCapability, adapterId: 'scripted-second', capabilityDigest: 'sha256:second' }],
      createRuntimeSessionId: 'runtime-second',
      sendResult: { accepted: true, requestId: 'from-second' },
    })
    await registry.register(first)
    await registry.register(second)
    const resolved = await registry.resolve(policy({ priorityAdapterIds: ['scripted-local', 'scripted-second'] }))
    if (!resolved.ok) throw new Error('route failed')

    await expect(registry.createOrResume(request(resolved.value.selection))).resolves.toEqual({
      state: 'READY',
      runtimeSessionId: 'runtime-first',
    })
    await expect(registry.send({
      requestId: 'send-1',
      runtimeSessionId: 'runtime-first',
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: {
        refId: 'message-1',
        digest: 'sha256:message',
        mediaType: 'application/vnd.xiaogui.runtime-message+json',
      },
    })).resolves.toEqual({ accepted: true, requestId: 'from-first' })
  })

  it('restores a persisted runtime session binding to the original adapter after restart', async () => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [scriptedCapability],
      sendResult: { accepted: true, requestId: 'restored-first' },
      outcomesBySession: {
        'runtime-from-database': {
          state: 'OUTCOME_UNKNOWN',
          runtimeSessionId: 'runtime-from-database',
          inspectHandleDigest: 'sha256:still-running',
          reasonCode: 'RUNTIME_STILL_RUNNING',
        },
      },
    }))
    await registry.register(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [{ ...scriptedCapability, adapterId: 'scripted-second', capabilityDigest: 'sha256:second' }],
      sendResult: { accepted: true, requestId: 'wrong-adapter' },
    }))

    await expect(registry.restoreBinding('runtime-from-database', selectionFor(scriptedCapability))).resolves.toEqual({ ok: true })
    await expect(registry.inspect('runtime-from-database')).resolves.toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      reasonCode: 'RUNTIME_STILL_RUNNING',
    })
    await expect(registry.send({
      requestId: 'send-after-restore',
      runtimeSessionId: 'runtime-from-database',
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: {
        refId: 'message-after-restore',
        digest: 'sha256:message-after-restore',
        mediaType: 'application/vnd.xiaogui.runtime-message+json',
      },
    })).resolves.toEqual({ accepted: true, requestId: 'restored-first' })
  })

  it.each([
    ['RESUME', 'supportsResume'],
    ['EVENT_STREAM', 'supportsEventStream'],
    ['INTERRUPT', 'supportsInterrupt'],
    ['RESULT_RECONCILE', 'supportsResultReconcile'],
  ] as const)('rejects a V2 runtime whose %s declaration contradicts its legacy fields', async (operation, field) => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [capability({
        ...scriptedCapability,
        adapterId: `missing-${operation.toLowerCase()}`,
        capabilityDigest: `sha256:missing-${operation.toLowerCase()}`,
        [field]: false,
      })],
    }))

    await expect(registry.resolve(policy({
      requiredOperations: [operation],
      priorityAdapterIds: [`missing-${operation.toLowerCase()}`],
    }))).resolves.toMatchObject({
      ok: false,
      reasonCode: 'NO_APPROVED_RUNTIME',
      rejectedAdapterIds: [`missing-${operation.toLowerCase()}`],
    })
  })

  it('explains the operational requirements used by a successful route', async () => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [scriptedCapability] }))
    await expect(registry.resolve(policy({
      requiredOperations: ['RESUME', 'RESULT_RECONCILE'],
      priorityAdapterIds: ['scripted-local'],
    }))).resolves.toMatchObject({
      ok: true,
      value: { reasons: expect.arrayContaining(['operations:RESUME,EVENT_STREAM,INTERRUPT,RESULT_RECONCILE']) },
    })
  })

  it('rejects recovery when an adapter id now resolves to a different protocol or capability digest', async () => {
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [scriptedCapability] }))
    await expect(registry.restoreBinding('runtime-from-database', {
      ...selectionFor(scriptedCapability),
      capabilityDigest: 'sha256:replaced-runtime',
    })).resolves.toEqual({ ok: false, reasonCode: 'RUNTIME_PREFERRED_NOT_AVAILABLE' })
    await expect(registry.inspect('runtime-from-database')).resolves.toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      reasonCode: 'RUNTIME_SESSION_NOT_FOUND',
    })
  })

  it('stops new routing after unregister while preserving an in-flight session binding', async () => {
    const registry = createAgentRuntimeRegistryV1()
    const adapter = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [scriptedCapability],
      createRuntimeSessionId: 'runtime-before-unregister',
      outcomesBySession: {
        'runtime-before-unregister': {
          state: 'SUCCEEDED',
          runtimeSessionId: 'runtime-before-unregister',
          receiptDigest: 'sha256:fixed-adapter-result',
          candidateDigest: 'sha256:fixed-adapter-candidate',
        },
      },
    })
    await registry.register(adapter)
    const resolved = await registry.resolve(policy({ priorityAdapterIds: ['scripted-local'] }))
    if (!resolved.ok) throw new Error('route failed')
    await registry.createOrResume(request(resolved.value.selection))

    await expect(registry.unregister('scripted-local')).resolves.toEqual({ ok: true })
    await expect(registry.resolve(policy({ priorityAdapterIds: ['scripted-local'] }))).resolves.toMatchObject({
      ok: false,
      reasonCode: 'NO_APPROVED_RUNTIME',
    })
    await expect(registry.reconcile('runtime-before-unregister')).resolves.toMatchObject({
      state: 'SUCCEEDED',
      receiptDigest: 'sha256:fixed-adapter-result',
    })
  })
})

function capability(overrides: Partial<RuntimeCapabilityV2>): RuntimeCapabilityV2 {
  return {
    adapterId: 'runtime',
    runtimeKind: 'OTHER',
    protocol: 'HEADLESS',
    capabilityDigest: 'sha256:runtime',
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    health: 'AVAILABLE',
    canCreateSession: true,
    canResumeSession: true,
    stream: 'POLL',
    interrupt: 'BEST_EFFORT',
    inspect: 'RECONCILE',
    interactivePermission: 'HOST_MEDIATED',
    diagnosticOnly: false,
    version: 2,
    runtimeVersion: '1.0.0-test',
    capabilitySummary: '测试运行时',
    workModes: ['CODING'],
    taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'],
    executionLocation: 'EXTERNAL',
    requiresDataEgress: true,
    supportsResume: true,
    supportsEventStream: true,
    supportsInterrupt: true,
    supportsResultReconcile: true,
    ...overrides,
  }
}

function selectionFor(capability: RuntimeCapabilityV2): RuntimeAdapterSelectionV1 {
  if (capability.stream === 'NONE' || capability.interrupt === 'NONE' || capability.inspect === 'NONE') {
    throw new Error('selection capability is not production routable')
  }
  return {
    adapterId: capability.adapterId,
    runtimeKind: capability.runtimeKind,
    protocol: capability.protocol,
    capabilityDigest: capability.capabilityDigest,
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    diagnosticOnly: false,
    stream: capability.stream,
    interrupt: capability.interrupt,
    inspect: capability.inspect,
  }
}

function policy(overrides: Partial<RuntimeRoutingPolicyV1> = {}): RuntimeRoutingPolicyV1 {
  return {
    mode: 'CODING',
    requiredCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT'],
    dataEgressPolicy: 'EXTERNAL_ALLOWED',
    priorityAdapterIds: ['kimi-acp', 'scripted-local'],
    requireProductionApproval: true,
    ...overrides,
  }
}

function request(selection: RuntimeAdapterSelectionV1): RuntimeCreateOrResumeRequestV1 {
  return {
    requestId: 'create-1',
    scope: {
      projectId: 'project',
      sessionKey: 'session',
      sessionMode: 'CODING',
      flowId: 'flow',
      taskRunId: 'task-run',
      attemptId: 'attempt',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace',
      workspaceReceiptDigest: 'sha256:workspace',
    },
    workspace: {
      attemptWorktreeId: 'worktree',
      worktreeRootDigest: 'sha256:worktree',
      baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:target',
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection,
    productionPolicy: { rejectDiagnosticOnly: true, allowedSelections: [selection] },
    promptEnvelopeRef: {
      refId: 'prompt',
      digest: 'sha256:prompt',
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
  }
}
