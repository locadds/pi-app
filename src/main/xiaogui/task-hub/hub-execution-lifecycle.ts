import type {
  AttemptProjectionM2BV1,
  HubAddressV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunProjectionM2BV1,
} from '@shared/xiaogui-collaboration-hub'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'

import type { HubTaskExecutionBindingV1, HubTaskExecutionTerminalOutcomeV1 } from '../hub-task/worker-service'
import type { CollaborationHubApplicationV1 } from './application'
import type { XiaoguiDeliveryWorkflowV1 } from './delivery-workflow'
import type { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'

export interface HubTaskExecutionEvidencePortV1 {
  listExecutionBindings(): readonly HubTaskExecutionBindingV1[]
  recordExecutionStarted(address: HubAddressV1, flowId: string): Promise<void>
  reportDeliveryOutcome(address: HubAddressV1, delivery: DeliveryBatchProjectionV1): Promise<void>
  reportExecutionOutcome(address: HubAddressV1, flowId: string, outcome: HubTaskExecutionTerminalOutcomeV1): Promise<void>
}

export interface HubTaskExecutionLifecycleTriggerV1 extends HubTaskExecutionBindingV1 {
  taskRunId?: string
  attemptId?: string
}

export interface HubTaskExecutionLifecycleReconcilerV1 {
  reconcile(trigger: HubTaskExecutionLifecycleTriggerV1): Promise<void>
  recover(): Promise<void>
}

export function createHubTaskExecutionLifecycleCoordinatorV1(options: {
  application: Pick<CollaborationHubApplicationV1, 'observeM2B'>
  taskExecution: Pick<XiaoguiTaskExecutionOrchestratorV1, 'recover'>
  delivery: Pick<XiaoguiDeliveryWorkflowV1, 'recover' | 'readLatestDelivery'>
  evidence: HubTaskExecutionEvidencePortV1
}): HubTaskExecutionLifecycleReconcilerV1 {
  return new HubTaskExecutionLifecycleCoordinatorImpl(options)
}

class HubTaskExecutionLifecycleCoordinatorImpl implements HubTaskExecutionLifecycleReconcilerV1 {
  private tail: Promise<void> = Promise.resolve()
  private recovery: Promise<void> | null = null
  private recovering = false

  constructor(private readonly options: Parameters<typeof createHubTaskExecutionLifecycleCoordinatorV1>[0]) {}

  reconcile(trigger: HubTaskExecutionLifecycleTriggerV1): Promise<void> {
    return this.recovering && this.recovery
      ? this.recovery.then(() => this.enqueue(trigger)).catch(() => undefined)
      : this.enqueue(trigger)
  }

  recover(): Promise<void> {
    if (!this.recovery) this.recovery = this.recoverOnce()
    return this.recovery
  }

  private async recoverOnce(): Promise<void> {
    this.recovering = true
    const initial = this.bindings()
    try {
      for (const binding of initial) {
        if (await this.resolveAuthority(binding)) {
          await this.safe(() => this.options.evidence.recordExecutionStarted(binding.address, binding.flowId))
        }
      }
      await this.safe(() => this.options.taskExecution.recover())
      await this.safe(() => this.options.delivery.recover())
      const targets = new Map<string, HubTaskExecutionLifecycleTriggerV1>()
      for (const binding of [...initial, ...this.bindings()]) targets.set(triggerKey(binding), binding)
      for (const trigger of targets.values()) await this.enqueue(trigger)
    } finally {
      this.recovering = false
    }
  }

  private enqueue(trigger: HubTaskExecutionLifecycleTriggerV1): Promise<void> {
    const run = this.tail.then(() => this.reconcileOnce(trigger)).catch(() => undefined)
    this.tail = run
    return run
  }

  private async reconcileOnce(trigger: HubTaskExecutionLifecycleTriggerV1): Promise<void> {
    const authority = await this.resolveAuthority(trigger)
    if (!authority) return
    await this.options.evidence.recordExecutionStarted(trigger.address, trigger.flowId)
    const delivery = this.options.delivery.readLatestDelivery(trigger.address, trigger.flowId as never)
    if (delivery && isTerminalDelivery(delivery)) {
      await this.options.evidence.reportDeliveryOutcome(trigger.address, delivery)
      return
    }
    const verificationState = executionTerminalState(authority)
    if (verificationState) {
      await this.options.evidence.reportExecutionOutcome(trigger.address, trigger.flowId, { verificationState })
    }
  }

  private async resolveAuthority(trigger: HubTaskExecutionLifecycleTriggerV1): Promise<{
    taskRun: TaskRunProjectionM2BV1
    attempt: AttemptProjectionM2BV1
  } | null> {
    try {
      const observed = await this.options.application.observeM2B(trigger.address)
      if (!observed.ok) return null
      const projection = observed.value as SessionCollaborationProjectionM2BV1
      if (projection.activeFlow?.flowId !== trigger.flowId) return null
      const taskRun = trigger.taskRunId
        ? projection.taskRuns.find((candidate) => candidate.taskRunId === trigger.taskRunId) ?? null
        : projection.taskRuns.length === 1 ? projection.taskRuns[0]! : null
      if (!taskRun) return null
      const expectedAttemptId = trigger.attemptId ?? taskRun.attemptId
      const attempt = expectedAttemptId
        ? projection.attempts.find((candidate) => candidate.attemptId === expectedAttemptId) ?? null
        : projection.attempts.filter((candidate) => candidate.taskRunId === taskRun.taskRunId).length === 1
          ? projection.attempts.find((candidate) => candidate.taskRunId === taskRun.taskRunId) ?? null
          : null
      return attempt?.taskRunId === taskRun.taskRunId ? { taskRun, attempt } : null
    } catch {
      return null
    }
  }

  private bindings(): readonly HubTaskExecutionBindingV1[] {
    try { return this.options.evidence.listExecutionBindings() } catch { return [] }
  }

  private async safe(operation: () => Promise<void>): Promise<void> {
    try { await operation() } catch { /* evidence stays durable and retryable */ }
  }
}

function executionTerminalState(authority: { taskRun: TaskRunProjectionM2BV1; attempt: AttemptProjectionM2BV1 }): HubTaskExecutionTerminalOutcomeV1['verificationState'] | null {
  const { taskRun, attempt } = authority
  if (taskRun.status === 'OUTCOME_UNKNOWN' || attempt.status === 'OUTCOME_UNKNOWN' || attempt.verificationSummary?.state === 'OUTCOME_UNKNOWN') return 'UNKNOWN'
  const failed = ['FAILED', 'CANCELLED', 'INVALIDATED', 'SUPERSEDED'].includes(taskRun.status)
    || ['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(attempt.status)
  return failed ? attempt.verificationSummary?.state === 'FAILED' ? 'FAIL' : 'NOT_RUN' : null
}

function isTerminalDelivery(delivery: DeliveryBatchProjectionV1): boolean {
  return ['READY_FOR_REVIEW', 'APPROVED', 'APPLYING', 'APPLIED', 'REJECTED', 'OUTCOME_UNKNOWN'].includes(delivery.state)
}

function triggerKey(trigger: HubTaskExecutionLifecycleTriggerV1): string {
  return [trigger.address.projectId, trigger.address.sessionKey, trigger.flowId, trigger.taskRunId ?? '', trigger.attemptId ?? ''].join('\u0000')
}
