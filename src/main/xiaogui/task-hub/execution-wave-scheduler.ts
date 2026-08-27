import type {
  AttemptId,
  ExecutionWaveId,
  ExecutionWaveV1,
  FlowId,
  TaskDependencyStateV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'

export const DEFAULT_PROJECT_PARALLELISM_V1 = 2

export const ACTIVE_ATTEMPT_STATUSES_V1 = new Set([
  'CREATED',
  'WORKSPACE_PREPARING',
  'READY',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'INTERRUPT_REQUESTED',
  'OUTCOME_UNKNOWN',
])

const VERIFIED_TASK_STATUSES = new Set(['VERIFIED', 'DELIVERY_PENDING', 'APPLYING', 'DONE'])
const FAILED_TASK_STATUSES = new Set(['FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'])

export interface SchedulerTaskV1 {
  readonly taskRunId: TaskRunId
  readonly taskKey: string
  readonly status: string
  readonly dependsOn: readonly string[]
  readonly taskChangeSetId?: string
}

export interface SchedulerAttemptV1 {
  readonly attemptId: AttemptId
  readonly taskRunId: TaskRunId
  readonly status: string
  readonly authorizationPathTokens: readonly string[]
}

export interface PlanExecutionWaveInputV1 {
  readonly waveId: ExecutionWaveId
  readonly flowId: FlowId
  readonly tasks: readonly SchedulerTaskV1[]
  readonly attempts: readonly SchedulerAttemptV1[]
  readonly requestedAuthorizationPathTokens: readonly string[]
  readonly requestedTaskRunId?: TaskRunId
  readonly maxParallelism?: number
  readonly now: string
}

export interface PlannedExecutionWaveV1 {
  readonly wave: ExecutionWaveV1
  readonly selectedTaskRunId?: TaskRunId
}

export interface ProjectExecutionReadinessV1 {
  readonly maxParallelism: number
  readonly activeAttemptCount: number
  readonly availableSlots: number
  readonly dependencyStates: readonly TaskDependencyStateV1[]
  readonly readyTaskRunIds: readonly TaskRunId[]
}

export function projectExecutionReadinessV1(input: {
  readonly tasks: readonly SchedulerTaskV1[]
  readonly attempts: readonly SchedulerAttemptV1[]
  readonly maxParallelism?: number
}): ProjectExecutionReadinessV1 {
  const current = currentExecutionState(input)
  return {
    maxParallelism: current.maxParallelism,
    activeAttemptCount: current.activeAttempts.length,
    availableSlots: Math.max(0, current.maxParallelism - current.activeAttempts.length),
    dependencyStates: current.dependencyStates,
    readyTaskRunIds: current.dependencyStates
      .filter((state) => state.state === 'READY')
      .map((state) => state.taskRunId),
  }
}

/**
 * Pure deterministic scheduler. Persistence and runtime/worktree side effects
 * remain behind the application/store seam.
 */
export function planExecutionWaveV1(input: PlanExecutionWaveInputV1): PlannedExecutionWaveV1 {
  const { maxParallelism, activeAttempts, dependencyStates } = currentExecutionState(input)
  const statesByTaskRunId = new Map(dependencyStates.map((state) => [state.taskRunId, state] as const))
  const requestedTokens = new Set(input.requestedAuthorizationPathTokens)
  const scopeConflicts = activeAttempts.some((attempt) =>
    attempt.authorizationPathTokens.some((token) => requestedTokens.has(token)),
  )
  const selectedTask = activeAttempts.length < maxParallelism && !scopeConflicts
    ? input.tasks.find((task) =>
        (!input.requestedTaskRunId || task.taskRunId === input.requestedTaskRunId) &&
        statesByTaskRunId.get(task.taskRunId)?.state === 'READY',
      )
    : undefined
  const scheduled = selectedTask
    ? [{ taskRunId: selectedTask.taskRunId, attemptId: '' as AttemptId }]
    : []
  return {
    wave: {
      version: 1,
      waveId: input.waveId,
      flowId: input.flowId,
      maxParallelism,
      activeAttemptIds: activeAttempts.map((attempt) => attempt.attemptId),
      scheduled,
      dependencyStates,
      createdAt: input.now,
    },
    ...(selectedTask ? { selectedTaskRunId: selectedTask.taskRunId } : {}),
  }
}

function currentExecutionState(input: {
  readonly tasks: readonly SchedulerTaskV1[]
  readonly attempts: readonly SchedulerAttemptV1[]
  readonly maxParallelism?: number
}) {
  const maxParallelism = Math.max(1, input.maxParallelism ?? DEFAULT_PROJECT_PARALLELISM_V1)
  const taskByKey = new Map(input.tasks.map((task) => [task.taskKey, task] as const))
  const activeAttempts = input.attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES_V1.has(attempt.status))
  const activeTaskRunIds = new Set(activeAttempts.map((attempt) => attempt.taskRunId))
  return {
    maxParallelism,
    activeAttempts,
    dependencyStates: input.tasks.map((task) => dependencyState(task, taskByKey, activeTaskRunIds)),
  }
}

export function bindExecutionWaveAttemptV1(
  planned: ExecutionWaveV1,
  taskRunId: TaskRunId,
  attemptId: AttemptId,
): ExecutionWaveV1 {
  return {
    ...planned,
    scheduled: [{ taskRunId, attemptId }],
  }
}

function dependencyState(
  task: SchedulerTaskV1,
  taskByKey: ReadonlyMap<string, SchedulerTaskV1>,
  activeTaskRunIds: ReadonlySet<TaskRunId>,
): TaskDependencyStateV1 {
  const dependencyTasks = task.dependsOn.map((key) => taskByKey.get(key)).filter(isPresent)
  const dependencyTaskRunIds = dependencyTasks.map((dependency) => dependency.taskRunId)
  const verifiedAncestorTaskChangeSetIds = collectVerifiedAncestorChangeSets(task, taskByKey)
  if (activeTaskRunIds.has(task.taskRunId)) {
    return state(task, 'IN_FLIGHT', dependencyTaskRunIds, [], verifiedAncestorTaskChangeSetIds)
  }
  if (isTerminalTask(task.status)) {
    return state(task, 'TERMINAL', dependencyTaskRunIds, [], verifiedAncestorTaskChangeSetIds)
  }
  const failed = dependencyTasks.filter((dependency) => hasFailedAncestor(dependency, taskByKey))
  if (failed.length > 0) {
    return state(
      task,
      'BLOCKED_BY_FAILED_DEPENDENCY',
      dependencyTaskRunIds,
      failed.map((dependency) => dependency.taskRunId),
      verifiedAncestorTaskChangeSetIds,
    )
  }
  const waiting = dependencyTasks.filter((dependency) => !isVerifiedTask(dependency))
  if (
    dependencyTasks.length !== task.dependsOn.length ||
    waiting.length > 0 ||
    dependencyTasks.some((dependency) => !dependency.taskChangeSetId)
  ) {
    return state(
      task,
      'WAITING_FOR_DEPENDENCIES',
      dependencyTaskRunIds,
      waiting.length > 0 ? waiting.map((dependency) => dependency.taskRunId) : dependencyTaskRunIds,
      verifiedAncestorTaskChangeSetIds,
    )
  }
  return state(task, 'READY', dependencyTaskRunIds, [], verifiedAncestorTaskChangeSetIds)
}

function state(
  task: SchedulerTaskV1,
  stateCode: TaskDependencyStateV1['state'],
  dependencyTaskRunIds: readonly TaskRunId[],
  blockingTaskRunIds: readonly TaskRunId[],
  verifiedAncestorTaskChangeSetIds: readonly string[],
): TaskDependencyStateV1 {
  return {
    version: 1,
    taskRunId: task.taskRunId,
    state: stateCode,
    dependencyTaskRunIds,
    blockingTaskRunIds,
    verifiedAncestorTaskChangeSetIds,
  }
}

function collectVerifiedAncestorChangeSets(
  task: SchedulerTaskV1,
  taskByKey: ReadonlyMap<string, SchedulerTaskV1>,
): string[] {
  const visited = new Set<string>()
  const result: string[] = []
  const visit = (key: string): void => {
    if (visited.has(key)) return
    visited.add(key)
    const dependency = taskByKey.get(key)
    if (!dependency) return
    dependency.dependsOn.forEach(visit)
    if (isVerifiedTask(dependency) && dependency.taskChangeSetId) result.push(dependency.taskChangeSetId)
  }
  task.dependsOn.forEach(visit)
  return result
}

function hasFailedAncestor(task: SchedulerTaskV1, taskByKey: ReadonlyMap<string, SchedulerTaskV1>): boolean {
  if (FAILED_TASK_STATUSES.has(task.status)) return true
  return task.dependsOn.some((key) => {
    const dependency = taskByKey.get(key)
    return dependency ? hasFailedAncestor(dependency, taskByKey) : false
  })
}

function isVerifiedTask(task: SchedulerTaskV1): boolean {
  return VERIFIED_TASK_STATUSES.has(task.status) && Boolean(task.taskChangeSetId)
}

function isTerminalTask(status: string): boolean {
  return VERIFIED_TASK_STATUSES.has(status) || FAILED_TASK_STATUSES.has(status)
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}
