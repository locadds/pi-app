import {
  parseXiaoguiPromptContextV1,
  type XiaoguiPromptContextV1,
} from '@shared/xiaogui-prompt-contract'

export type XiaoguiPromptContextTransitionV1 =
  | { readonly kind: 'BIND'; readonly context: XiaoguiPromptContextV1 }
  | { readonly kind: 'REUSE'; readonly context: XiaoguiPromptContextV1 }
  | { readonly kind: 'REBUILD'; readonly context: XiaoguiPromptContextV1 }
  | { readonly kind: 'SWITCH'; readonly context: XiaoguiPromptContextV1 }

function comparable(context: XiaoguiPromptContextV1): string {
  return JSON.stringify({
    ...context,
    enabledCapabilities: [...context.enabledCapabilities].sort(),
    availableToolNames: [...context.availableToolNames].sort(),
  })
}

export function freezeXiaoguiPromptContextV1(value: unknown): XiaoguiPromptContextV1 {
  const parsed = parseXiaoguiPromptContextV1(value)
  Object.freeze(parsed.enabledCapabilities)
  Object.freeze(parsed.availableToolNames)
  return Object.freeze(parsed)
}

export function decideXiaoguiPromptContextTransitionV1(input: {
  readonly current: XiaoguiPromptContextV1 | null
  readonly next: XiaoguiPromptContextV1
  readonly sameSession: boolean
  readonly busy: boolean
}): XiaoguiPromptContextTransitionV1 {
  const next = freezeXiaoguiPromptContextV1(input.next)
  if (!input.current) return { kind: 'BIND', context: next }
  const current = freezeXiaoguiPromptContextV1(input.current)
  const currentKey = current.sessionKey
  const nextKey = next.sessionKey
  if (
    (input.sameSession && currentKey && nextKey && currentKey !== nextKey) ||
    (!input.sameSession && currentKey && nextKey && currentKey === nextKey)
  ) {
    throw new Error('XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH')
  }
  if (input.sameSession) {
    if (comparable(current) === comparable(next)) return { kind: 'REUSE', context: current }
    if (input.busy) throw new Error('XIAOGUI_PROMPT_CONTEXT_TURN_ACTIVE')
    return { kind: 'REBUILD', context: next }
  }
  if (input.busy) throw new Error('WORKER_AGENT_BUSY')
  return { kind: 'SWITCH', context: next }
}
