import { describe, expect, it } from 'vitest'

import type { AttemptId, ExecutionWaveId, FlowId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import { planExecutionWaveV1 } from './execution-wave-scheduler'

const FLOW_ID = 'xhbf_flow' as FlowId

describe('ExecutionWaveV1 scheduler', () => {
  it('selects two independent tasks across calls up to the project default of two', () => {
    const tasks = [task('a'), task('b')]
    const first = planExecutionWaveV1(input(tasks))
    expect(first.selectedTaskRunId).toBe('run-a')
    expect(first.wave.maxParallelism).toBe(2)

    const second = planExecutionWaveV1(input(tasks, [attempt('a', ['sha256:path-a'])], ['sha256:path-b']))
    expect(second.selectedTaskRunId).toBe('run-b')
    const full = planExecutionWaveV1(input(tasks, [attempt('a', []), attempt('b', [])]))
    expect(full.selectedTaskRunId).toBeUndefined()
  })

  it('serializes overlapping authorization scopes but allows disjoint scopes', () => {
    const tasks = [task('a'), task('b')]
    const active = [attempt('a', ['sha256:same'])]
    expect(planExecutionWaveV1(input(tasks, active, ['sha256:same'])).selectedTaskRunId).toBeUndefined()
    expect(planExecutionWaveV1(input(tasks, active, ['sha256:other'])).selectedTaskRunId).toBe('run-b')
  })

  it('unlocks a downstream task only from verified TaskChangeSets', () => {
    const tasks = [
      task('base', [], 'VERIFIED', 'xhtcs_base'),
      task('child', ['base']),
    ]
    const plan = planExecutionWaveV1(input(tasks))
    expect(plan.selectedTaskRunId).toBe('run-child')
    expect(plan.wave.dependencyStates.find((state) => state.taskRunId === 'run-child')).toMatchObject({
      state: 'READY',
      verifiedAncestorTaskChangeSetIds: ['xhtcs_base'],
    })
  })

  it('blocks only failed successors and never redispatches OUTCOME_UNKNOWN', () => {
    const tasks = [
      task('failed', [], 'FAILED'),
      task('child', ['failed']),
      task('independent'),
      task('unknown'),
    ]
    const plan = planExecutionWaveV1(input(tasks, [attempt('unknown', [], 'OUTCOME_UNKNOWN')]))
    expect(plan.selectedTaskRunId).toBe('run-independent')
    expect(plan.wave.dependencyStates.find((state) => state.taskRunId === 'run-child')?.state).toBe('BLOCKED_BY_FAILED_DEPENDENCY')
    expect(plan.wave.dependencyStates.find((state) => state.taskRunId === 'run-unknown')?.state).toBe('IN_FLIGHT')
  })

  it('fails closed when a dependency key is absent from the scheduler snapshot', () => {
    const plan = planExecutionWaveV1(input([task('child', ['missing'])]))
    expect(plan.selectedTaskRunId).toBeUndefined()
    expect(plan.wave.dependencyStates[0]).toMatchObject({ state: 'WAITING_FOR_DEPENDENCIES' })
  })
})

function input(
  tasks: ReturnType<typeof task>[],
  attempts: ReturnType<typeof attempt>[] = [],
  requestedAuthorizationPathTokens: string[] = [],
) {
  return {
    waveId: 'xhbwave_1' as ExecutionWaveId,
    flowId: FLOW_ID,
    tasks,
    attempts,
    requestedAuthorizationPathTokens,
    now: '2026-08-27T00:00:00.000Z',
  }
}

function task(taskKey: string, dependsOn: string[] = [], status = 'PENDING_DISABLED', taskChangeSetId?: string) {
  return {
    taskRunId: `run-${taskKey}` as TaskRunId,
    taskKey,
    status,
    dependsOn,
    ...(taskChangeSetId ? { taskChangeSetId } : {}),
  }
}

function attempt(taskKey: string, authorizationPathTokens: string[], status = 'RUNNING') {
  return {
    attemptId: `attempt-${taskKey}` as AttemptId,
    taskRunId: `run-${taskKey}` as TaskRunId,
    status,
    authorizationPathTokens,
  }
}
