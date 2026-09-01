import { errorMessage } from '@shared/error-message'

import type { WorkerReply } from '../worker-handler-types.js'
import type { WorkerIncomingMessage } from '../worker-port-types.js'
import {
  bindCodingRoleRuntimeV1,
  currentSessionModelKey,
  inspectCodingRoleRuntimeV1,
  isSessionBusy,
  readCodingRoleRuntimeV1,
  releaseCodingRoleRuntimeV1,
} from '../worker-runtime.js'

/** Main-only control RPC. Its success projection never includes the private prompt body. */
export async function handleCodingRoleBinding(
  msg: WorkerIncomingMessage,
  reply: WorkerReply,
): Promise<void> {
  try {
    if (isSessionBusy()) throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_BUSY')
    const action = msg.action
    if (action === 'CHECK') {
      const binding = inspectCodingRoleRuntimeV1(msg.codingRole)
      reply(safeReply('CHECK', binding))
      return
    }
    if (action === 'BIND') {
      const binding = await bindCodingRoleRuntimeV1(msg.codingRole)
      reply(safeReply('BIND', binding))
      return
    }
    if (action === 'RELEASE') {
      const expectedAttemptId = typeof msg.expectedAttemptId === 'string'
        ? msg.expectedAttemptId
        : undefined
      if (!expectedAttemptId) throw new Error('XIAOGUI_CODING_ROLE_ATTEMPT_REQUIRED')
      releaseCodingRoleRuntimeV1(expectedAttemptId)
      reply({
        type: 'codingRoleBinding-done',
        action: 'RELEASE',
        attemptId: expectedAttemptId,
        released: readCodingRoleRuntimeV1() === null,
      })
      return
    }
    throw new Error('XIAOGUI_CODING_ROLE_ACTION_INVALID')
  } catch (error) {
    const code = safeErrorCode(errorMessage(error))
    reply({ type: 'error', error: code })
  }
}

function safeReply(
  action: 'CHECK' | 'BIND',
  binding: NonNullable<ReturnType<typeof readCodingRoleRuntimeV1>>,
) {
  return {
    type: 'codingRoleBinding-done',
    action,
    attemptId: binding.attemptId,
    profileId: binding.snapshot.profileId,
    role: binding.snapshot.role,
    snapshotDigest: binding.snapshotDigest,
    model: currentSessionModelKey(),
  }
}

function safeErrorCode(message: string): string {
  const allowed = new Set([
    'XIAOGUI_CODING_ROLE_ACTION_INVALID',
    'XIAOGUI_CODING_ROLE_ATTEMPT_REQUIRED',
    'XIAOGUI_CODING_ROLE_CODING_SESSION_REQUIRED',
    'XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE',
    'XIAOGUI_CODING_ROLE_RUNTIME_ALREADY_BOUND',
    'XIAOGUI_CODING_ROLE_RUNTIME_ATTEMPT_MISMATCH',
    'XIAOGUI_CODING_ROLE_RUNTIME_BUSY',
    'XIAOGUI_CODING_ROLE_RUNTIME_POLICY_UNSUPPORTED',
    'XIAOGUI_CODING_ROLE_RUNTIME_UNAVAILABLE',
    'XIAOGUI_CODING_ROLE_SNAPSHOT_INVALID',
  ])
  return allowed.has(message) ? message : 'XIAOGUI_CODING_ROLE_RUNTIME_UNAVAILABLE'
}
