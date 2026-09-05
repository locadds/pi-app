import { createHash } from 'node:crypto'

import type { CodingPermissionIntentV1 } from '@shared/xiaogui-coding-extension-pack'
import type { CodingPermissionModeV1 } from '@shared/xiaogui-coding-permission'
import {
  XIAOGUI_DIRECT_CODING_SUBJECT_V2,
  XIAOGUI_TASKHUB_CODING_SUBJECT_V2,
  type DirectCodingAuthorizationSubjectV2,
  type DirectCodingOperationV2,
  type DirectCodingPermissionOriginV3,
  type DirectCodingPermissionPromptV3,
  type TaskHubCodingAuthorizationSubjectV2,
} from '@shared/xiaogui-direct-coding'

import type { CodingPermissionModuleV1 } from './permission-module'
import type { DirectCodingPermissionUIPortV3 } from './direct-permission-ui-adapter'

export interface DirectCodingAuthorizationRequestV2 {
  readonly subject: DirectCodingAuthorizationSubjectV2
  readonly requestDigest: string
  readonly operation: DirectCodingOperationV2
  readonly mode: CodingPermissionModeV1
  readonly existingFile: boolean
  readonly relativePath?: string
  readonly commandText?: string
  readonly origin: DirectCodingPermissionOriginV3
}

export interface DirectCodingAuthorizationDecisionV2 {
  readonly decision: 'ALLOW_ONCE' | 'DENY'
  readonly reasonCode: 'MODE_POLICY_AUTO_ALLOWED' | 'USER_ALLOWED_ONCE' | 'USER_OR_POLICY_DENIED'
}

export interface DirectCodingAuthorizationPortV2 {
  decideDirect(input: DirectCodingAuthorizationRequestV2): Promise<DirectCodingAuthorizationDecisionV2>
}

export interface TaskHubCodingAuthorizationPortV2 {
  decideTaskHub(input: {
    readonly subject: TaskHubCodingAuthorizationSubjectV2
    readonly intent: CodingPermissionIntentV1
  }): Promise<'ALLOW_ONCE' | 'DENY'>
}

/**
 * One authorization Module, two subject Adapters. Direct sessions get a
 * deterministic V2 policy and a two-choice UI; TaskHub delegates to its frozen
 * V1 Attempt policy, rule store and three-choice UI without semantic changes.
 */
export class CodingAuthorizationModuleV2
  implements DirectCodingAuthorizationPortV2, TaskHubCodingAuthorizationPortV2 {
  constructor(private readonly options: {
    readonly directUi: DirectCodingPermissionUIPortV3
    readonly taskHub: Pick<CodingPermissionModuleV1, 'decide'>
  }) {}

  async decideDirect(
    input: DirectCodingAuthorizationRequestV2,
  ): Promise<DirectCodingAuthorizationDecisionV2> {
    if (
      input.subject.schemaVersion !== 2 ||
      input.subject.kind !== XIAOGUI_DIRECT_CODING_SUBJECT_V2
    ) return { decision: 'DENY', reasonCode: 'USER_OR_POLICY_DENIED' }

    if (directPermissionEffectV2(input.mode, input.operation, input.existingFile) === 'ALLOW') {
      return { decision: 'ALLOW_ONCE', reasonCode: 'MODE_POLICY_AUTO_ALLOWED' }
    }
    const originDigest = digestOrigin(input)
    const prompt: DirectCodingPermissionPromptV3 = Object.freeze({
      schemaVersion: 3,
      subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
      requestDigest: input.requestDigest,
      originDigest,
      projectLabel: input.origin.projectLabel,
      sessionLabel: input.origin.sessionLabel,
      operation: input.operation,
      mode: input.mode,
      ...(input.relativePath ? { relativePath: input.relativePath } : {}),
      ...(input.commandText !== undefined
        ? { commandText: input.commandText }
        : {}),
      ...(input.operation === 'BASH'
        ? { warning: '命令可能访问项目外路径、网络或子进程，且不能自动撤销。' }
        : input.operation === 'DATA_EGRESS'
          ? { warning: '该工具会向当前模型提供方之外的第三方目的地发送数据。' }
          : {}),
      choices: Object.freeze(['ALLOW_ONCE', 'DENY'] as const),
    })
    try {
      if (await this.options.directUi.request(prompt, input.origin) === 'ALLOW_ONCE') {
        return { decision: 'ALLOW_ONCE', reasonCode: 'USER_ALLOWED_ONCE' }
      }
    } catch {
      // UI failure and timeout are denied by default.
    }
    return { decision: 'DENY', reasonCode: 'USER_OR_POLICY_DENIED' }
  }

  decideTaskHub(input: {
    readonly subject: TaskHubCodingAuthorizationSubjectV2
    readonly intent: CodingPermissionIntentV1
  }): Promise<'ALLOW_ONCE' | 'DENY'> {
    if (
      input.subject.schemaVersion !== 2 ||
      input.subject.kind !== XIAOGUI_TASKHUB_CODING_SUBJECT_V2 ||
      input.subject.attemptId !== input.intent.attemptId
    ) return Promise.resolve('DENY')
    return this.options.taskHub.decide(input.intent)
  }
}

export function directPermissionEffectV2(
  mode: CodingPermissionModeV1,
  operation: DirectCodingOperationV2,
  existingFile: boolean,
): 'ALLOW' | 'ASK' {
  if (operation === 'BASH' || operation === 'DATA_EGRESS') return 'ASK'
  if (mode === 'CONFIRM_EACH') return 'ASK'
  if (operation === 'READ' || operation === 'EDIT') return 'ALLOW'
  if (operation === 'WRITE' && existingFile) return 'ALLOW'
  return mode === 'FULL_AUTONOMY' ? 'ALLOW' : 'ASK'
}

function digestOrigin(input: DirectCodingAuthorizationRequestV2): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    domain: 'xiaogui.direct-coding.permission-origin.v3',
    projectId: input.subject.address.projectId,
    sessionKey: input.subject.address.sessionKey,
    sourceSessionId: input.origin.sourceSessionId,
    fromPoolKey: input.origin.fromPoolKey,
  })).digest('hex')}`
}
