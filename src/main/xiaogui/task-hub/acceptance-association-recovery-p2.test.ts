import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron-store', () => ({ default: class { get() {} set() {} delete() {} } }))

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { RuntimeAdapterSelectionV1, RuntimeCapabilityV1 } from '@shared/xiaogui-agent-runtime'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import { createHubTaskWorkerServiceV1, createInMemoryHubTaskWorkerCredentialsV1 } from '../hub-task/worker-service'
import { createHubTaskWorkerStateStoreV1, type HubTaskWorkerStateV1 } from '../hub-task/worker-state'
import { createCollaborationHubApplicationV1 } from './application'
import { AttemptExecutionInputStoreV1 } from './attempt-execution-input'
import { GitAttemptWorkspaceServiceV1, SqliteAttemptWorkspaceRegistryV1 } from './attempt-workspace'
import { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'
import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { createHubTaskAcceptAndExecuteTrustedPortV2, createMainAttemptWorkspaceBaselineSourceResolverV1 } from './runtime-composition'
import { CollaborationHubSqliteStoreV1, hasHubAcceptanceRecoverySchemaV1 } from './sqlite-store'

const roots: string[] = []
const ADDRESS = { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as HubAddressV1
const PACKAGE = `sha256:${'c'.repeat(64)}`
const NOW = '2026-09-15T00:00:00.000Z'
const SELECTION: RuntimeAdapterSelectionV1 = { adapterId: 'acceptance-recovery-scripted', runtimeKind: 'OTHER', protocol: 'HEADLESS',
  capabilityDigest: 'sha256:acceptance-recovery-scripted', approvalStatus: 'APPROVED_FOR_PRODUCTION', diagnosticOnly: false,
  stream: 'POLL', interrupt: 'BEST_EFFORT', inspect: 'SNAPSHOT' }
const CAPABILITY: RuntimeCapabilityV1 = { ...SELECTION, health: 'AVAILABLE', canCreateSession: true, canResumeSession: true,
  interactivePermission: 'HOST_MEDIATED' }

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('acceptance association recovery P2', () => {
  it('recovers the exact terminal association after the final worker-state save fails without redispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-accept-recovery-p2-'))
    roots.push(root)
    const projectRoot = join(root, 'project')
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(join(projectRoot, 'seed.txt'), 'seed')
    git(projectRoot, ['init']); git(projectRoot, ['config', 'user.email', 'test@example.test'])
    git(projectRoot, ['config', 'user.name', 'Test']); git(projectRoot, ['add', '.']); git(projectRoot, ['commit', '-m', 'baseline'])
    const userData = join(root, 'user-data'); mkdirSync(userData, { recursive: true })
    const hubDbPath = join(userData, 'hub.sqlite')
    const projectResolver = { resolveProjectRoot: async () => projectRoot }
    const registry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: join(userData, 'workspaces.sqlite') })
    const inputRef: { current?: AttemptExecutionInputStoreV1 } = {}
    const workspaces = new GitAttemptWorkspaceServiceV1(registry, projectResolver, { managedRoot: join(userData, 'attempts'),
      baselineSourceResolver: createMainAttemptWorkspaceBaselineSourceResolverV1(hubDbPath, () => inputRef.current) })
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath: join(userData, 'payloads.sqlite') })
    const inputs = new AttemptExecutionInputStoreV1({ dbPath: join(userData, 'inputs.sqlite'), payloadVault: vault, workspace: workspaces })
    inputRef.current = inputs
    const scripted = new ScriptedAgentRuntimeAdapterV1({ capabilities: [CAPABILITY], createRuntimeSessionId: 'recovery-runtime' })
    const createOrResume = vi.spyOn(scripted, 'createOrResume')
    const application = createCollaborationHubApplicationV1({
      lookup: { lookup: async (address) => ({ kind: 'FOUND', scope: { ...address, sessionMode: 'CODING' } }) },
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath), agentRuntime: createAgentRuntimeHostV1(scripted),
      agentSelection: SELECTION, baselineProvider: new GitExecutionBaselineProviderV1(projectResolver),
      workspaceBridge: inputs.bridge, runtimePromptVault: inputs,
    })
    new CollaborationHubSqliteStoreV1(hubDbPath).close()
    const createExecution = () => new XiaoguiTaskExecutionOrchestratorV1({ dbPath: hubDbPath, application,
      recoveryDatabaseWasAuthoritative: hasHubAcceptanceRecoverySchemaV1(hubDbPath),
      recoveryDatabaseIdentity: databaseIdentity(hubDbPath),
      inputStage: { stageAttemptInput: (value) => inputs.stage(value), stageAttemptWorktreeInput: (value) => inputs.stageWorktree(value) },
      fileScopeResolver: workspaces })
    let execution = createExecution()
    const statePath = join(userData, 'worker-state.json')
    let failFinalSave = true
    const persistence = {
      read: () => JSON.parse(readFileSync(statePath, 'utf8')) as HubTaskWorkerStateV1,
      write: (value: HubTaskWorkerStateV1) => {
        if (failFinalSave && value.assignments['assignment-1']?.acceptAndExecuteV2?.phase === 'EXECUTION_REQUESTED') {
          failFinalSave = false
          throw new Error('injected final association save failure')
        }
        writeFileSync(statePath, JSON.stringify(value))
      },
    }
    writeFileSync(statePath, JSON.stringify({ version: 1, assignments: {}, receipts: {}, results: {}, lastReceiptSequence: 0, cursor: null }))
    const identity = { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1' }
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write({ endpoint: 'http://hub.test', accessToken: 'a'.repeat(20), node: { ...identity, deviceToken: 'device', privateKeyPem: 'private' } })
    const state = createHubTaskWorkerStateStoreV1(persistence)
    state.upsertAssignment(assignment('PENDING'), identity); state.markOpened('assignment-1', NOW)
    const submitDecision = vi.fn(async () => assignment('ACCEPTED'))
    const port = () => createHubTaskAcceptAndExecuteTrustedPortV2({ application, taskExecution: execution, projectResolver,
      authorityDatabaseIdentity: () => databaseIdentity(hubDbPath) })
    let worker = createHubTaskWorkerServiceV1({ state, credentials, application,
      createPort: () => ({ downloadAssignment: async () => assignment('ACCEPTED'), submitDecision }) as never,
      acceptAndExecuteV2: port() })
    try {
    const request = { contractVersion: 'hub.accept-execute.v2' as const, assignmentId: 'assignment-1', address: ADDRESS,
      observedPackageSha256: PACKAGE, requestId: 'accept-request-1' }
    await expect(worker.acceptAndExecuteV2(request)).resolves.toEqual({ ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT' })
    const callsAfterDispatch = createOrResume.mock.calls.length
    expect(callsAfterDispatch).toBe(1)
    const beforeDb = new DatabaseSync(hubDbPath, { readOnly: true })
    const before = beforeDb.prepare(`select s.flow_id as flowId, s.attempt_id as attemptId, r.revision_id as revisionId,
      (select count(*) from flows) as flowCount, (select count(*) from attempts) as attemptCount,
      (select count(*) from task_execution_sagas) as sagaCount
      from task_execution_sagas s join flows f on f.flow_id = s.flow_id
      join plan_revisions r on r.flow_id = f.flow_id limit 1`).get() as Record<string, string | number>
    beforeDb.close()
    const persistedBeforeRecovery = createHubTaskWorkerStateStoreV1(persistence).requireAssignment('assignment-1')
    expect(persistedBeforeRecovery.acceptAndExecuteV2?.phase).toBe('HUB_ACCEPTED')
    worker.close(); await execution.close()

    execution = createExecution()
    const reloaded = createHubTaskWorkerStateStoreV1(persistence)
    worker = createHubTaskWorkerServiceV1({ state: reloaded, credentials, application,
      createPort: () => ({ downloadAssignment: async () => assignment('ACCEPTED'), submitDecision }) as never,
      acceptAndExecuteV2: port() })
    const recovered = await worker.acceptAndExecuteV2(request)
    expect(recovered).toMatchObject({ ok: true, value: { executionState: 'ASSOCIATION_RECOVERED' } })
    expect(recovered).toMatchObject({ value: { flowId: before.flowId, revisionId: before.revisionId, attemptId: before.attemptId } })
    expect(createOrResume).toHaveBeenCalledTimes(callsAfterDispatch)
    expect(submitDecision).not.toHaveBeenCalled()
    expect(reloaded.requireAssignment('assignment-1').acceptAndExecuteV2).toMatchObject({ phase: 'ASSOCIATED' })
    expect(worker.listExecutionBindings()).toEqual([{ address: ADDRESS, flowId: (recovered as { value: { flowId: string } }).value.flowId }])
    const afterDb = new DatabaseSync(hubDbPath, { readOnly: true })
    const after = afterDb.prepare(`select (select count(*) from flows) as flowCount, (select count(*) from attempts) as attemptCount,
      (select count(*) from task_execution_sagas) as sagaCount`).get()
    afterDb.close()
    expect(after).toEqual({ flowCount: before.flowCount, attemptCount: before.attemptCount, sagaCount: before.sagaCount })
    const callsAfterScheduledReplay = createOrResume.mock.calls.length
    const terminalCases = [
      { name: 'DISPATCHING', saga: 'DISPATCHING', attempt: 'READY', hub: 'RUNNING', outcome: 'ASSOCIATION_RECOVERED' },
      { name: 'RUNNING', saga: 'RUNTIME_ACTIVE', attempt: 'RUNNING', hub: 'RUNNING', outcome: 'ASSOCIATION_RECOVERED' },
      { name: 'SUCCEEDED', saga: 'SETTLED', attempt: 'SUCCEEDED', hub: 'COMPLETED', outcome: 'ASSOCIATION_RECOVERED' },
      { name: 'FAILED', saga: 'FAILED', attempt: 'FAILED', hub: 'FAILED', outcome: 'ASSOCIATION_RECOVERED' },
      { name: 'CANCELLED', saga: 'FAILED', attempt: 'CANCELLED', hub: 'FAILED', outcome: 'ASSOCIATION_RECOVERED' },
      { name: 'UNKNOWN', saga: 'OUTCOME_UNKNOWN', attempt: 'OUTCOME_UNKNOWN', hub: 'OUTCOME_UNKNOWN', outcome: 'HUB_EXECUTION_OUTCOME_UNKNOWN' },
    ] as const
    const submitResult = vi.fn(async () => { throw new Error('synthetic offline result transport') })
    for (const terminalCase of terminalCases) {
      worker.close(); await execution.close()
      const mutate = new DatabaseSync(hubDbPath)
      mutate.prepare('update task_execution_sagas set phase = ?, last_safe_code = ? where attempt_id = ?')
        .run(terminalCase.saga, terminalCase.name === 'DISPATCHING' ? null : terminalCase.attempt, before.attemptId)
      mutate.prepare('update attempts set status = ? where attempt_id = ?').run(terminalCase.attempt, before.attemptId)
      if (terminalCase.name === 'DISPATCHING') {
        mutate.prepare('delete from agent_dispatch_outbox where attempt_id = ?').run(before.attemptId)
        mutate.prepare('delete from runtime_session_bindings where attempt_id = ?').run(before.attemptId)
      }
      mutate.close()
      const reset = JSON.parse(readFileSync(statePath, 'utf8')) as HubTaskWorkerStateV1
      const binding = reset.assignments['assignment-1']!.acceptAndExecuteV2!
      if (terminalCase.name === 'SUCCEEDED') {
        reset.assignments['assignment-1']!.acceptAndExecuteV2 = { ...binding, phase: 'EXECUTION_REQUESTED',
          flowId: before.flowId as string, revisionId: before.revisionId as string,
          attemptId: before.attemptId as string, executionState: 'STARTED' }
        reset.assignments['assignment-1']!.localPlanDraft = { ...ADDRESS, flowId: before.flowId as string,
          revisionId: before.revisionId as string, createdAt: NOW }
      } else {
        reset.assignments['assignment-1']!.acceptAndExecuteV2 = { ...binding, phase: 'HUB_ACCEPTED',
          flowId: undefined, revisionId: undefined, attemptId: undefined, executionState: undefined }
        reset.assignments['assignment-1']!.localPlanDraft = null
      }
      writeFileSync(statePath, JSON.stringify(reset))
      execution = createExecution()
      const terminalState = createHubTaskWorkerStateStoreV1(persistence)
      worker = createHubTaskWorkerServiceV1({ state: terminalState, credentials, application,
        createPort: () => ({ downloadAssignment: async () => assignment('ACCEPTED', terminalCase.hub), submitDecision, submitResult }) as never,
        acceptAndExecuteV2: port(),
        signReceipt: (receipt) => ({ ...receipt, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
      })
      const terminalResult = await worker.acceptAndExecuteV2(request)
      if (terminalCase.outcome === 'HUB_EXECUTION_OUTCOME_UNKNOWN') {
        expect(terminalResult, terminalCase.name).toEqual({ ok: false, code: terminalCase.outcome })
      } else {
        expect(terminalResult, terminalCase.name).toMatchObject({ ok: true, value: {
          flowId: before.flowId, revisionId: before.revisionId, attemptId: before.attemptId,
          actualAttemptStatus: terminalCase.attempt, executionState: terminalCase.outcome,
        } })
      }
      expect(terminalState.requireAssignment('assignment-1').acceptAndExecuteV2, terminalCase.name).toMatchObject({
        phase: 'ASSOCIATED', flowId: before.flowId, revisionId: before.revisionId, attemptId: before.attemptId,
      })
      if (terminalCase.name === 'SUCCEEDED') {
        expect(terminalState.requireAssignment('assignment-1').acceptAndExecuteV2?.executionState).toBeUndefined()
        expect(worker.listExecutionBindings()).toEqual([{ address: ADDRESS, flowId: before.flowId }])
      }
      if (terminalCase.name === 'RUNNING') {
        terminalState.upsertAssignment(assignment('ACCEPTED', 'RUNNING'), credentials.snapshot()!.node)
        await worker.reportExecutionOutcome(ADDRESS, before.flowId as string, { verificationState: 'FAIL' })
        const firstResult = terminalState.pendingEvidence().filter((item) => item.kind === 'RESULT')
        expect(firstResult).toHaveLength(1)
        expect(firstResult[0]).toMatchObject({ kind: 'RESULT', submission: { result: {
          assignmentId: 'assignment-1', taskId: 'task-1', outcome: 'EXECUTION_FAILED',
        } } })
        await worker.reportExecutionOutcome(ADDRESS, before.flowId as string, { verificationState: 'FAIL' })
        expect(terminalState.pendingEvidence().filter((item) => item.kind === 'RESULT')).toHaveLength(1)
      }
      expect(createOrResume, terminalCase.name).toHaveBeenCalledTimes(callsAfterScheduledReplay)
      const unchanged = new DatabaseSync(hubDbPath, { readOnly: true })
      const counts = unchanged.prepare(`select (select count(*) from flows) as flowCount,
        (select count(*) from attempts) as attemptCount, (select count(*) from task_execution_sagas) as sagaCount,
        (select status from attempts where attempt_id = ?) as attemptStatus`).get(before.attemptId)
      unchanged.close()
      expect(counts, terminalCase.name).toEqual({ flowCount: before.flowCount, attemptCount: before.attemptCount,
        sagaCount: before.sagaCount, attemptStatus: terminalCase.attempt })
    }
    } finally {
      worker.close()
      await execution.close()
      application.close(); inputs.close(); vault.close(); registry.close()
    }
  }, 30_000)

  it('continues the exact scheduled Attempt when schedule committed before Saga advance', async () => {
    const fixture = createRecoveryFixture('scheduled-prefix')
    try {
      const interruptedApplication = new Proxy(fixture.application, {
        get(target, property) {
          if (property === 'executeSystem') return async (command: Parameters<typeof target.executeSystem>[0]) => {
            const result = await target.executeSystem(command)
            if (command.intent.type === 'system.schedule') throw new Error('injected after schedule commit')
            return result
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      let execution = fixture.createExecution(interruptedApplication)
      let state = fixture.createOpenedState('ACCEPTED')
      let worker = fixture.createWorker(state, execution, interruptedApplication)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({
        ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN',
      })
      expect(fixture.createOrResume).not.toHaveBeenCalled()
      const before = fixture.exactCounts()
      expect(before).toMatchObject({ sagaPhase: 'ACCEPTED', sagaAttemptId: null, attemptCount: 1 })
      worker.close(); await execution.close()

      execution = fixture.createExecution()
      state = fixture.reloadState()
      const bindSpy = vi.spyOn(state, 'bindAcceptAndExecuteV2')
      worker = fixture.createWorker(state, execution)
      const replay = await worker.acceptAndExecuteV2(fixture.request)
      if (!replay.ok) throw new Error(`${replay.code}:${JSON.stringify(bindSpy.mock.calls.at(-1)?.[1])}`)
      expect(replay).toMatchObject({ ok: true, value: { flowId: before.flowId, revisionId: before.revisionId,
        attemptId: before.attemptId } })
      expect(fixture.createOrResume).toHaveBeenCalledOnce()
      const after = fixture.exactCounts()
      expect(after.flowCount).toBe(before.flowCount)
      expect(after.attemptCount).toBe(before.attemptCount)
      expect(after.sagaCount).toBe(before.sagaCount)
      expect(after.attemptId).toBe(before.attemptId)
    } finally {
      await fixture.close()
    }
    await verifyDispatchRace()
  }, 30_000)

  it('continues a persisted BOUND acceptance on an intact empty authority database without repeating ACCEPT', async () => {
    const fixture = createRecoveryFixture('bound-prefix')
    try {
      const bootstrap = fixture.createExecution()
      await bootstrap.close()
      const execution = fixture.createExecution()
      const state = fixture.createOpenedState('ACCEPTED')
      const trusted = fixture.createTrusted(execution)
      const target = await trusted.resolveTarget({ address: ADDRESS, assignmentId: 'assignment-1', taskId: 'task-1', packageSha256: PACKAGE })
      if (!target.ok) throw new Error(target.code)
      state.bindAcceptAndExecuteV2('assignment-1', {
        contractVersion: 'hub.accept-execute.v2', assignmentId: 'assignment-1', taskId: 'task-1', packageSha256: PACKAGE,
        requestId: fixture.request.requestId, ...fixture.identity, ...ADDRESS,
        targetProjectIdentity: target.targetProjectIdentity, baselineSourceDigest: target.baselineSourceDigest,
        ...(target.authorityDatabaseIdentity ? { authorityDatabaseIdentity: target.authorityDatabaseIdentity } : {}),
        draftDigest: sha256Json(workerDraft()), phase: 'BOUND', createdAt: NOW, updatedAt: NOW,
      })
      const beforeDb = new DatabaseSync(fixture.hubDbPath, { readOnly: true })
      expect(beforeDb.prepare('select count(*) as count from flows').get()).toEqual({ count: 0 })
      expect(beforeDb.prepare('select count(*) as count from attempts').get()).toEqual({ count: 0 })
      beforeDb.close()
      const worker = fixture.createWorker(state, execution)
      const result = await worker.acceptAndExecuteV2(fixture.request)
      expect(result).toMatchObject({ ok: true, value: { attemptId: expect.any(String) } })
      expect(fixture.submitDecision).not.toHaveBeenCalled()
      expect(fixture.createOrResume).toHaveBeenCalledOnce()
      const after = fixture.exactCounts()
      expect(after).toMatchObject({ flowCount: 1, attemptCount: 1, sagaCount: 1 })
    } finally {
      await fixture.close()
    }
  }, 30_000)

  it('fails closed for conflicting evidence, a second association save failure, and rebuilt authority storage', async () => {
    const fixture = createRecoveryFixture('fail-closed')
    try {
      let execution = fixture.createExecution()
      let state = fixture.createOpenedState('ACCEPTED')
      let worker = fixture.createWorker(state, execution)
      const first = await worker.acceptAndExecuteV2(fixture.request)
      if (!first.ok) throw new Error(first.code)
      const workerCalls = fixture.createOrResume.mock.calls.length
      const originalDisk = JSON.parse(readFileSync(fixture.statePath, 'utf8')) as HubTaskWorkerStateV1
      const originalBinding = originalDisk.assignments['assignment-1']!.acceptAndExecuteV2!
      const resetToAccepted = () => {
        const reset = structuredClone(originalDisk)
        reset.assignments['assignment-1']!.acceptAndExecuteV2 = { ...originalBinding, phase: 'HUB_ACCEPTED',
          flowId: undefined, revisionId: undefined, attemptId: undefined, executionState: undefined }
        reset.assignments['assignment-1']!.localPlanDraft = null
        writeFileSync(fixture.statePath, JSON.stringify(reset))
        return reset
      }
      worker.close(); await execution.close()

      const inconsistent = structuredClone(originalDisk)
      inconsistent.assignments['assignment-1']!.acceptAndExecuteV2 = {
        ...inconsistent.assignments['assignment-1']!.acceptAndExecuteV2!,
        attemptId: 'different-attempt',
      }
      writeFileSync(fixture.statePath, JSON.stringify(inconsistent))
      execution = fixture.createExecution()
      state = fixture.reloadState()
      worker = fixture.createWorker(state, execution)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({
        ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT',
      })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2?.attemptId).toBe('different-attempt')
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      worker.close(); await execution.close()

      const legacy = resetToAccepted()
      delete legacy.assignments['assignment-1']!.acceptAndExecuteV2!.authorityDatabaseIdentity
      writeFileSync(fixture.statePath, JSON.stringify(legacy))
      execution = fixture.createExecution()
      state = fixture.reloadState()
      worker = fixture.createWorker(state, execution)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toMatchObject({ ok: true, value: {
        flowId: first.value.flowId, revisionId: first.value.revisionId, executionState: 'ASSOCIATION_RECOVERED',
      } })
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      worker.close(); await execution.close()

      const beforeSecondSave = resetToAccepted()
      const diskBeforeSecondSave = readFileSync(fixture.statePath, 'utf8')
      const rejectingPersistence = {
        read: fixture.persistence.read,
        write(value: HubTaskWorkerStateV1) {
          if (value.assignments['assignment-1']?.acceptAndExecuteV2?.phase === 'ASSOCIATED') {
            throw new Error('injected recovered association save failure')
          }
          fixture.persistence.write(value)
        },
      }
      execution = fixture.createExecution()
      state = createHubTaskWorkerStateStoreV1(rejectingPersistence)
      worker = fixture.createWorker(state, execution)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({ ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT' })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2).toEqual(beforeSecondSave.assignments['assignment-1']!.acceptAndExecuteV2)
      expect(readFileSync(fixture.statePath, 'utf8')).toBe(diskBeforeSecondSave)
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      worker.close(); await execution.close()

      resetToAccepted()
      execution = fixture.createExecution()
      state = fixture.reloadState()
      const drift = assignment('ACCEPTED'); drift.offer.taskContent = 'conflicting body'
      worker = fixture.createWorker(state, execution, fixture.application, drift)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({ ok: false, code: 'HUB_ACCEPT_AND_EXECUTE_CONFLICT' })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2?.phase).toBe('HUB_ACCEPTED')
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      worker.close(); await execution.close()

      resetToAccepted()
      const savedCredentials = fixture.credentials.snapshot()!
      fixture.credentials.write({ ...savedCredentials, node: { ...savedCredentials.node, nodeId: 'replacement-node' } })
      execution = fixture.createExecution()
      state = fixture.reloadState()
      worker = fixture.createWorker(state, execution)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({ ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2?.phase).toBe('HUB_ACCEPTED')
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      fixture.credentials.write(savedCredentials)
      worker.close(); await execution.close()

      resetToAccepted()
      const conflictDb = new DatabaseSync(fixture.hubDbPath)
      const saga = conflictDb.prepare('select operation_id, authorization_json from task_execution_sagas').get() as {
        operation_id: string; authorization_json: string
      }
      const authorization = JSON.parse(saga.authorization_json) as { acceptance: { taskId: string } }
      const originalAuthorizationJson = saga.authorization_json
      authorization.acceptance.taskId = 'conflicting-task'
      conflictDb.prepare('update task_execution_sagas set authorization_json = ? where operation_id = ?')
        .run(JSON.stringify(authorization), saga.operation_id)
      conflictDb.close()
      execution = fixture.createExecution()
      state = fixture.reloadState()
      worker = fixture.createWorker(state, execution)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({ ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN' })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2?.phase).toBe('HUB_ACCEPTED')
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      worker.close(); await execution.close()

      resetToAccepted()
      const restoreAuthorization = new DatabaseSync(fixture.hubDbPath)
      restoreAuthorization.prepare('update task_execution_sagas set authorization_json = ? where operation_id = ?')
        .run(originalAuthorizationJson, saga.operation_id)
      restoreAuthorization.close()
      fixture.application.close()
      const damaged = new DatabaseSync(fixture.hubDbPath)
      damaged.exec('drop table journal_events')
      damaged.close()
      expect(hasHubAcceptanceRecoverySchemaV1(fixture.hubDbPath)).toBe(false)
      const rebuiltAfterMissingTable = fixture.createApplication()
      execution = fixture.createExecution(rebuiltAfterMissingTable)
      state = fixture.reloadState()
      worker = fixture.createWorker(state, execution, rebuiltAfterMissingTable)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({ ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN' })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2?.phase).toBe('HUB_ACCEPTED')
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
      worker.close(); await execution.close()
      rebuiltAfterMissingTable.close()

      for (const suffix of ['', '-wal', '-shm']) rmSync(`${fixture.hubDbPath}${suffix}`, { force: true })
      expect(hasHubAcceptanceRecoverySchemaV1(fixture.hubDbPath)).toBe(false)
      const rebuiltAfterMissingDb = fixture.createApplication()
      execution = fixture.createExecution(rebuiltAfterMissingDb)
      state = fixture.reloadState()
      worker = fixture.createWorker(state, execution, rebuiltAfterMissingDb)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({ ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN' })
      expect(state.requireAssignment('assignment-1').acceptAndExecuteV2?.phase).toBe('HUB_ACCEPTED')
      expect(fixture.createOrResume).toHaveBeenCalledTimes(workerCalls)
    } finally {
      await fixture.close()
    }
  }, 30_000)

  async function verifyDispatchRace(): Promise<void> {
    const fixture = createRecoveryFixture('dispatch-race')
    let worker: ReturnType<typeof createHubTaskWorkerServiceV1> | undefined
    try {
      const interruptedApplication = new Proxy(fixture.application, {
        get(target, property) {
          if (property === 'executeSystem') return async (command: Parameters<typeof target.executeSystem>[0]) => {
            const result = await target.executeSystem(command)
            if (command.intent.type === 'system.schedule') throw new Error('injected after schedule commit')
            return result
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      let execution = fixture.createExecution(interruptedApplication)
      let state = fixture.createOpenedState('ACCEPTED')
      worker = fixture.createWorker(state, execution, interruptedApplication)
      await expect(worker.acceptAndExecuteV2(fixture.request)).resolves.toEqual({
        ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN',
      })
      worker.close(); await execution.close()
      const before = fixture.exactCounts()
      expect(before).toMatchObject({ sagaPhase: 'ACCEPTED', attemptCount: 1 })

      execution = fixture.createExecution()
      state = fixture.reloadState()
      const baseTrusted = fixture.createTrusted(execution)
      const racingTrusted = {
        resolveTarget: baseTrusted.resolveTarget,
        recoverAssociation: baseTrusted.recoverAssociation,
        async execute(request: Parameters<typeof baseTrusted.execute>[0]) {
          const db = new DatabaseSync(fixture.hubDbPath)
          db.prepare("update task_execution_sagas set phase = 'DISPATCHING', attempt_id = ?, task_run_id = (select task_run_id from attempts where attempt_id = ?)")
            .run(before.attemptId, before.attemptId)
          db.close()
          return baseTrusted.execute(request)
        },
      }
      worker = createHubTaskWorkerServiceV1({ state, credentials: fixture.credentials, application: fixture.application,
        createPort: () => ({ downloadAssignment: async () => assignment('ACCEPTED'), submitDecision: fixture.submitDecision }) as never,
        acceptAndExecuteV2: racingTrusted })
      const result = await worker.acceptAndExecuteV2(fixture.request)
      expect(result).toMatchObject({ ok: true, value: { flowId: before.flowId, revisionId: before.revisionId,
        attemptId: before.attemptId, actualAttemptStatus: 'WORKSPACE_PREPARING', executionState: 'ASSOCIATION_RECOVERED' } })
      expect(fixture.createOrResume).not.toHaveBeenCalled()
      const after = fixture.exactCounts()
      expect(after).toMatchObject({ flowCount: before.flowCount, attemptCount: before.attemptCount,
        sagaCount: before.sagaCount, sagaPhase: 'DISPATCHING', attemptId: before.attemptId })
    } finally {
      worker?.close()
      await fixture.close()
    }
  }
})

function assignment(
  decisionState: 'PENDING' | 'ACCEPTED',
  executionState: 'NOT_STARTED' | 'RUNNING' | 'RESULT_READY' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN' = 'NOT_STARTED',
) {
  return { assignment: { assignmentId: 'assignment-1', taskId: 'task-1', decisionState, deliveryState: 'OPENED' as const,
    executionState, createdAt: NOW, updatedAt: NOW }, offer: { taskId: 'task-1', mode: 'DIRECT' as const,
    title: 'task', taskContent: 'trusted body', constraints: [], acceptanceRequirements: ['done'], attachmentRefs: [], packageSha256: PACKAGE } }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function databaseIdentity(dbPath: string): string {
  const stat = statSync(dbPath, { bigint: true })
  return `xhdb_${createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest('hex')}`
}

function databaseIdentityOrNull(dbPath: string): string | null {
  try { return databaseIdentity(dbPath) } catch { return null }
}

function createRecoveryFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `xiaogui-accept-recovery-p2-${name}-`))
  roots.push(root)
  const projectRoot = join(root, 'project')
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'seed.txt'), 'seed')
  git(projectRoot, ['init']); git(projectRoot, ['config', 'user.email', 'test@example.test'])
  git(projectRoot, ['config', 'user.name', 'Test']); git(projectRoot, ['add', '.']); git(projectRoot, ['commit', '-m', 'baseline'])
  const userData = join(root, 'user-data'); mkdirSync(userData, { recursive: true })
  const hubDbPath = join(userData, 'hub.sqlite')
  const statePath = join(userData, 'worker-state.json')
  writeFileSync(statePath, JSON.stringify({ version: 1, assignments: {}, receipts: {}, results: {}, lastReceiptSequence: 0, cursor: null }))
  const projectResolver = { resolveProjectRoot: async () => projectRoot }
  const registry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: join(userData, 'workspaces.sqlite') })
  const inputRef: { current?: AttemptExecutionInputStoreV1 } = {}
  const workspaces = new GitAttemptWorkspaceServiceV1(registry, projectResolver, { managedRoot: join(userData, 'attempts'),
    baselineSourceResolver: createMainAttemptWorkspaceBaselineSourceResolverV1(hubDbPath, () => inputRef.current) })
  const vault = new PrivateRuntimePayloadVaultV1({ dbPath: join(userData, 'payloads.sqlite') })
  const inputs = new AttemptExecutionInputStoreV1({ dbPath: join(userData, 'inputs.sqlite'), payloadVault: vault, workspace: workspaces })
  inputRef.current = inputs
  const scripted = new ScriptedAgentRuntimeAdapterV1({ capabilities: [CAPABILITY], createRuntimeSessionId: `runtime-${name}` })
  const createOrResume = vi.spyOn(scripted, 'createOrResume')
  const applications: Array<ReturnType<typeof createCollaborationHubApplicationV1>> = []
  const createApplication = () => {
    const app = createCollaborationHubApplicationV1({
      lookup: { lookup: async (address) => ({ kind: 'FOUND', scope: { ...address, sessionMode: 'CODING' } }) },
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath), agentRuntime: createAgentRuntimeHostV1(scripted),
      agentSelection: SELECTION, baselineProvider: new GitExecutionBaselineProviderV1(projectResolver),
      workspaceBridge: inputs.bridge, runtimePromptVault: inputs,
    })
    applications.push(app)
    return app
  }
  const application = createApplication()
  new CollaborationHubSqliteStoreV1(hubDbPath).close()
  const executions: XiaoguiTaskExecutionOrchestratorV1[] = []
  const workers: Array<ReturnType<typeof createHubTaskWorkerServiceV1>> = []
  const submitDecision = vi.fn(async () => assignment('ACCEPTED'))
  const persistence = {
    read: () => JSON.parse(readFileSync(statePath, 'utf8')) as HubTaskWorkerStateV1,
    write: (value: HubTaskWorkerStateV1) => writeFileSync(statePath, JSON.stringify(value)),
  }
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  const identity = { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1' }
  credentials.write({ endpoint: 'http://hub.test', accessToken: 'a'.repeat(20), node: {
    ...identity, deviceToken: 'device', privateKeyPem: 'private',
  } })
  const createExecution = (app = application) => {
    const execution = new XiaoguiTaskExecutionOrchestratorV1({ dbPath: hubDbPath, application: app,
      recoveryDatabaseWasAuthoritative: hasHubAcceptanceRecoverySchemaV1(hubDbPath),
      recoveryDatabaseIdentity: databaseIdentityOrNull(hubDbPath),
      inputStage: { stageAttemptInput: (value) => inputs.stage(value), stageAttemptWorktreeInput: (value) => inputs.stageWorktree(value) },
      fileScopeResolver: workspaces })
    executions.push(execution)
    return execution
  }
  const createOpenedState = (decision: 'PENDING' | 'ACCEPTED') => {
    const state = createHubTaskWorkerStateStoreV1(persistence)
    state.upsertAssignment(assignment(decision), identity); state.markOpened('assignment-1', NOW)
    return state
  }
  const createTrusted = (execution: XiaoguiTaskExecutionOrchestratorV1, app = application) =>
    createHubTaskAcceptAndExecuteTrustedPortV2({ application: app, taskExecution: execution, projectResolver,
      authorityDatabaseIdentity: () => databaseIdentity(hubDbPath) })
  const createWorker = (state: ReturnType<typeof createHubTaskWorkerStateStoreV1>, execution: XiaoguiTaskExecutionOrchestratorV1,
    app = application, downloaded = assignment('ACCEPTED')) => {
    const trusted = createTrusted(execution, app)
    const worker = createHubTaskWorkerServiceV1({ state, credentials, application: app,
      createPort: () => ({ downloadAssignment: async () => downloaded, submitDecision }) as never,
      acceptAndExecuteV2: trusted })
    workers.push(worker)
    return worker
  }
  const exactCounts = () => {
    const db = new DatabaseSync(hubDbPath, { readOnly: true })
    try {
      return db.prepare(`select s.flow_id as flowId, s.phase as sagaPhase, s.attempt_id as sagaAttemptId,
        a.attempt_id as attemptId, r.revision_id as revisionId,
        (select count(*) from flows) as flowCount, (select count(*) from attempts) as attemptCount,
        (select count(*) from task_execution_sagas) as sagaCount
        from task_execution_sagas s join flows f on f.flow_id = s.flow_id
        join plan_revisions r on r.flow_id = f.flow_id
        left join attempts a on a.flow_id = s.flow_id limit 1`).get() as Record<string, string | number | null>
    } finally { db.close() }
  }
  return {
    root, hubDbPath, statePath, application, createApplication, createOrResume, submitDecision, persistence, credentials, identity,
    request: { contractVersion: 'hub.accept-execute.v2' as const, assignmentId: 'assignment-1', address: ADDRESS,
      observedPackageSha256: PACKAGE, requestId: `accept-${name}` },
    createExecution, createOpenedState, reloadState: () => createHubTaskWorkerStateStoreV1(persistence), createTrusted, createWorker, exactCounts,
    async close() {
      workers.forEach((worker) => worker.close())
      await Promise.allSettled(executions.map((execution) => execution.close()))
      applications.forEach((app) => app.close()); inputs.close(); vault.close(); registry.close()
    },
  }
}

function workerDraft() {
  return { objective: 'task', tasks: [{ taskKey: 'hub_assignment-1', title: 'task', summary: 'trusted body\n\n验收要求：\n- done' }] }
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`
}
