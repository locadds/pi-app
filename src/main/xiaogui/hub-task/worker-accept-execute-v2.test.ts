import { describe, expect, it, vi } from 'vitest'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import {
  createHubTaskWorkerServiceV1,
  createInMemoryHubTaskWorkerCredentialsV1,
  type HubTaskAcceptAndExecuteTrustedPortV2,
} from './worker-service'
import {
  createHubTaskWorkerStateStoreV1,
  createInMemoryHubTaskWorkerStateStoreV1,
  type HubTaskWorkerStateV1,
} from './worker-state'

const PACKAGE = `sha256:${'c'.repeat(64)}`
const BASELINE = `sha256:${'d'.repeat(64)}`
const ADDRESS = { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as HubAddressV1
const IDENTITY = { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1' }

describe('Hub Task acceptAndExecute V2 Main seam', () => {
  it('persists trusted binding before ACCEPT and replays a completed request without repeating side effects', async () => {
    const state = openedState('PENDING')
    const credentials = credentialStore()
    const submitDecision = vi.fn(async () => {
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2).toMatchObject({
        phase: 'BOUND', requestId: 'accept-1', targetProjectIdentity: 'project-main-1',
      })
      return detail('ACCEPTED')
    })
    const execute = vi.fn(async () => ({
      ok: true as const, flowId: 'flow-1', revisionId: 'revision-1', executionState: 'PREPARED' as const,
    }))
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('PENDING')), submitDecision }) as never,
      acceptAndExecuteV2: trustedPort(execute),
      signReceipt: (receipt) => ({ ...receipt, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    })

    const request = requestV2()
    await expect(service.acceptAndExecuteV2(request)).resolves.toEqual({
      ok: true, value: { flowId: 'flow-1', revisionId: 'revision-1', executionState: 'PREPARED' },
    })
    await expect(service.acceptAndExecuteV2(request)).resolves.toEqual({
      ok: true, value: { flowId: 'flow-1', revisionId: 'revision-1', executionState: 'PREPARED' },
    })
    expect(submitDecision).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(state.requireAssignment('assignment-1').acceptAndExecuteV2).toMatchObject({
      phase: 'EXECUTION_REQUESTED', flowId: 'flow-1', revisionId: 'revision-1', draftDigest: expect.stringMatching(/^sha256:/),
    })
    expect(service.listExecutionBindings()).toEqual([{ address: ADDRESS, flowId: 'flow-1' }])
    expect(state.requireAssignment('assignment-1').localPlanDraft).toMatchObject({ flowId: 'flow-1', revisionId: 'revision-1' })
  })

  it('single-flights an identical request and rejects a concurrent request with another digest', async () => {
    const state = openedState('ACCEPTED')
    const credentials = credentialStore()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const execute = vi.fn(async () => {
      await blocked
      return { ok: true as const, flowId: 'flow-1', revisionId: 'revision-1', executionState: 'STARTED' as const }
    })
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('ACCEPTED')) }) as never,
      acceptAndExecuteV2: trustedPort(execute),
    })
    const first = service.acceptAndExecuteV2(requestV2())
    const duplicate = service.acceptAndExecuteV2(requestV2())
    await expect(service.acceptAndExecuteV2({ ...requestV2(), requestId: 'accept-other' })).resolves.toEqual({
      ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT',
    })
    release()
    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(duplicate).resolves.toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects body drift, changed identity, terminal state, and unknown request fields before dispatch', async () => {
    const state = openedState('ACCEPTED')
    const credentials = credentialStore()
    const execute = vi.fn(async () => ({
      ok: true as const, flowId: 'flow-1', revisionId: 'revision-1', executionState: 'PREPARED' as const,
    }))
    const port = trustedPort(execute)
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('ACCEPTED')) }) as never,
      acceptAndExecuteV2: port,
    })
    await expect(service.acceptAndExecuteV2(requestV2())).resolves.toMatchObject({ ok: true })

    const drifted = detail('ACCEPTED')
    drifted.offer.taskContent = 'changed body'
    const restarted = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => drifted) }) as never,
      acceptAndExecuteV2: port,
    })
    await expect(restarted.acceptAndExecuteV2(requestV2())).resolves.toEqual({ ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT' })
    await expect(restarted.acceptAndExecuteV2({ ...requestV2(), extra: true } as never)).resolves.toEqual({ ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT' })

    credentials.write({ ...credentials.snapshot()!, node: { ...credentials.snapshot()!.node, nodeId: 'node-2' } })
    await expect(restarted.acceptAndExecuteV2(requestV2())).resolves.toEqual({ ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' })

    const terminalState = openedState('ACCEPTED', 'OUTCOME_UNKNOWN')
    const terminal = createHubTaskWorkerServiceV1({
      state: terminalState, credentials: credentialStore(), application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('ACCEPTED', 'OUTCOME_UNKNOWN')) }) as never,
      acceptAndExecuteV2: port,
    })
    await expect(terminal.acceptAndExecuteV2(requestV2())).resolves.toEqual({ ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects a downloaded body that differs from the opened package before binding or ACCEPT', async () => {
    const state = openedState('PENDING')
    const downloaded = detail('PENDING')
    downloaded.offer.taskContent = 'same package, different body'
    const submitDecision = vi.fn()
    const resolveTarget = vi.fn()
    const service = createHubTaskWorkerServiceV1({
      state, credentials: credentialStore(), application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => downloaded), submitDecision }) as never,
      acceptAndExecuteV2: { resolveTarget, execute: vi.fn() },
    })

    await expect(service.acceptAndExecuteV2(requestV2())).resolves.toEqual({
      ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT',
    })
    expect(state.requireAssignment('assignment-1').acceptAndExecuteV2).toBeUndefined()
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(submitDecision).not.toHaveBeenCalled()
  })

  it('reloads a pre-ACCEPT binding and confirms Hub acceptance without submitting ACCEPT again', async () => {
    let serialized: HubTaskWorkerStateV1 | undefined
    const persistence = {
      read: () => serialized ? JSON.parse(JSON.stringify(serialized)) as HubTaskWorkerStateV1 : undefined,
      write: (value: HubTaskWorkerStateV1) => { serialized = JSON.parse(JSON.stringify(value)) as HubTaskWorkerStateV1 },
    }
    const firstState = createHubTaskWorkerStateStoreV1(persistence)
    firstState.upsertAssignment(detail('PENDING'), IDENTITY)
    firstState.markOpened('assignment-1', '2026-09-15T00:00:00.000Z')
    const credentials = credentialStore()
    let hubAccepted = false
    const submitDecision = vi.fn(async () => {
      hubAccepted = true
      throw new Error('response lost after Hub commit')
    })
    const firstExecute = vi.fn()
    const first = createHubTaskWorkerServiceV1({
      state: firstState, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({
        downloadAssignment: vi.fn(async () => detail(hubAccepted ? 'ACCEPTED' : 'PENDING')),
        submitDecision,
      }) as never,
      acceptAndExecuteV2: trustedPort(firstExecute),
    })
    await expect(first.acceptAndExecuteV2(requestV2())).resolves.toMatchObject({ ok: false })
    expect(firstState.requireAssignment('assignment-1').acceptAndExecuteV2).toMatchObject({ phase: 'BOUND' })

    const execute = vi.fn(async () => ({
      ok: true as const, flowId: 'flow-recovered', revisionId: 'revision-recovered', executionState: 'PREPARED' as const,
    }))
    const reloadedState = createHubTaskWorkerStateStoreV1(persistence)
    const restarted = createHubTaskWorkerServiceV1({
      state: reloadedState, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('ACCEPTED')), submitDecision }) as never,
      acceptAndExecuteV2: trustedPort(execute),
    })
    await expect(restarted.acceptAndExecuteV2(requestV2())).resolves.toMatchObject({
      ok: true, value: { flowId: 'flow-recovered', executionState: 'PREPARED' },
    })
    expect(submitDecision).toHaveBeenCalledOnce()
    expect(firstExecute).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(createHubTaskWorkerStateStoreV1(persistence).requireAssignment('assignment-1').acceptAndExecuteV2)
      .toMatchObject({ phase: 'EXECUTION_REQUESTED', flowId: 'flow-recovered' })
  })

  it('maps an execution-port throw to UNKNOWN while retaining the accepted binding', async () => {
    const state = openedState('ACCEPTED')
    const service = createHubTaskWorkerServiceV1({
      state, credentials: credentialStore(), application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('ACCEPTED')) }) as never,
      acceptAndExecuteV2: trustedPort(vi.fn(async () => { throw new Error('transport outcome unknown') })),
    })
    await expect(service.acceptAndExecuteV2(requestV2())).resolves.toEqual({
      ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN',
    })
    expect(state.requireAssignment('assignment-1').acceptAndExecuteV2).toMatchObject({ phase: 'HUB_ACCEPTED' })
  })

  it('retains a completed result but refuses to attribute it to replacement credentials', async () => {
    const state = openedState('ACCEPTED')
    const credentials = credentialStore()
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('ACCEPTED')) }) as never,
      acceptAndExecuteV2: trustedPort(vi.fn(async () => ({
        ok: true as const, flowId: 'flow-owned', revisionId: 'revision-owned', executionState: 'PREPARED' as const,
      }))),
    })
    await expect(service.acceptAndExecuteV2(requestV2())).resolves.toMatchObject({ ok: true })
    const authoritative = state.requireAssignment('assignment-1').acceptAndExecuteV2

    credentials.write({ ...credentials.snapshot()!, node: { ...credentials.snapshot()!.node, nodeId: 'replacement-node' } })
    await expect(service.acceptAndExecuteV2(requestV2())).resolves.toEqual({ ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' })
    expect(state.requireAssignment('assignment-1').acceptAndExecuteV2).toEqual(authoritative)
  })

  it('rejects an existing different local plan before target resolution or ACCEPT', async () => {
    const state = openedState('PENDING')
    state.bindPlanDraft('assignment-1', {
      ...ADDRESS, flowId: 'other-flow', revisionId: 'other-revision', createdAt: '2026-09-15T00:00:00.000Z',
    })
    const submitDecision = vi.fn()
    const port = trustedPort(vi.fn())
    const service = createHubTaskWorkerServiceV1({
      state, credentials: credentialStore(), application: { perform: vi.fn() } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => detail('PENDING')), submitDecision }) as never,
      acceptAndExecuteV2: port,
    })
    await expect(service.acceptAndExecuteV2(requestV2())).resolves.toEqual({
      ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT',
    })
    expect(port.resolveTarget).not.toHaveBeenCalled()
    expect(submitDecision).not.toHaveBeenCalled()
    expect(state.requireAssignment('assignment-1').localPlanDraft).toMatchObject({ flowId: 'other-flow' })
  })
})

function trustedPort(execute: HubTaskAcceptAndExecuteTrustedPortV2['execute']): HubTaskAcceptAndExecuteTrustedPortV2 {
  return {
    resolveTarget: vi.fn(async () => ({ ok: true as const, targetProjectIdentity: 'project-main-1', baselineSourceDigest: BASELINE })),
    execute,
  }
}

function credentialStore() {
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  credentials.write({
    endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20),
    node: { ...IDENTITY, deviceToken: 'device-token-1', privateKeyPem: 'private-key-1' },
  })
  return credentials
}

function openedState(decisionState: 'PENDING' | 'ACCEPTED', executionState: 'NOT_STARTED' | 'OUTCOME_UNKNOWN' = 'NOT_STARTED') {
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  state.upsertAssignment(detail(decisionState, executionState), IDENTITY)
  state.markOpened('assignment-1', '2026-09-15T00:00:00.000Z')
  return state
}

function detail(decisionState: 'PENDING' | 'ACCEPTED', executionState: 'NOT_STARTED' | 'OUTCOME_UNKNOWN' = 'NOT_STARTED') {
  return {
    assignment: {
      assignmentId: 'assignment-1', taskId: 'task-1', decisionState, deliveryState: 'OPENED' as const,
      executionState, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    },
    offer: {
      taskId: 'task-1', mode: 'DIRECT' as const, title: 'task', taskContent: 'trusted body',
      constraints: ['constraint'], acceptanceRequirements: ['acceptance'], attachmentRefs: [], packageSha256: PACKAGE,
    },
  }
}

function requestV2() {
  return {
    contractVersion: 'hub.accept-execute.v2' as const,
    assignmentId: 'assignment-1', address: ADDRESS, observedPackageSha256: PACKAGE, requestId: 'accept-1',
  }
}
