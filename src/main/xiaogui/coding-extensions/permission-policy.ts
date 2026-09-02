import type {
  CodingPermissionBoundaryStateV1,
  CodingPermissionIntentV1,
  CodingPermissionModeV1,
  CodingPermissionPolicyEvaluationV1,
} from '@shared/xiaogui-coding-extension-pack'
import {
  CODING_PERMISSION_MODES_V1,
  XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1,
} from '@shared/xiaogui-coding-extension-pack'

export interface CodingPermissionPolicyInputV1 {
  readonly mode: CodingPermissionModeV1
  readonly intent: CodingPermissionIntentV1
  /** Only TaskHub may attest this state. Renderer and Runtime values are not authoritative. */
  readonly boundaryState: CodingPermissionBoundaryStateV1
}

/**
 * Pure P1 policy seam. It never validates paths or commands itself: TaskHub must
 * first verify the Attempt workspace, file manifest, command policy and egress
 * policy, then pass VERIFIED. Anything else fails closed in every UI mode.
 */
export function evaluateCodingPermissionPolicyV1(
  input: CodingPermissionPolicyInputV1,
): CodingPermissionPolicyEvaluationV1 {
  const mode = CODING_PERMISSION_MODES_V1.includes(input.mode) ? input.mode : 'CONFIRM_EACH'
  if (input.boundaryState !== 'VERIFIED') {
    return {
      schemaVersion: 1,
      requestDigest: input.intent.requestDigest,
      mode,
      effect: 'DENY',
      reasonCode: input.boundaryState === 'DENIED'
        ? 'TASKHUB_BOUNDARY_DENIED'
        : 'TASKHUB_BOUNDARY_UNVERIFIED',
    }
  }

  const option = XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1.find((candidate) => candidate.mode === mode)
  const effect = option?.verifiedEffects[input.intent.operation] ?? 'ASK_USER'
  return {
    schemaVersion: 1,
    requestDigest: input.intent.requestDigest,
    mode,
    effect,
    reasonCode: effect === 'ALLOW_ONCE'
      ? 'MODE_AUTO_APPROVED_VERIFIED_OPERATION'
      : 'MODE_REQUIRES_USER_CONFIRMATION',
  }
}
