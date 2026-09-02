import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  EventBus,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent'
import type { AppEvent } from '@shared/app-events'
import type {
  XiaoguiCapabilityId,
  XiaoguiEffectivePromptDiagnosticsV1,
  XiaoguiPromptContextV1,
} from '@shared/xiaogui-prompt-contract'
import type { CodingContextAgentPayloadV1 } from '@shared/xiaogui-coding-extension-pack'
import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'
import {
  activeToolNamesForPromptContextV1,
  selectXiaoguiTurnCapabilitiesV1,
  workerPromptContextToolNamesForModeV1,
  xiaoguiPromptStickyCandidateForToolActionV1,
  xiaoguiPromptStickyCapabilityFromToolResultV1,
} from '@shared/xiaogui-prompt-capabilities'
import { formatSessionModelKey, type SessionModelRef } from '@shared/worker-model'
import { createDesktopUIBridge, type DesktopUIBridge } from './desktop-ui-bridge.js'
import { createDesktopWidgetHost } from './desktop-widget-host.js'
import { applySkillsOverride } from './skill-override.js'
import { decorateQuestionnaireTools } from './questionnaire-tool-decorator.js'
import { addXiaoguiWorkerToolsV1 } from './xiaogui-worker-tools.js'
import { assertXiaoguiModelToolSchemasCompatible } from './xiaogui-model-tool-schema-compatibility.js'
import {
  handleSessionEvent as dispatchSessionEvent,
  resetCompletionTurnTracking,
  resetSessionEventTracking,
} from './worker-session-events.js'
import { errorMessage } from '@shared/error-message'
import { sendToMain } from './worker-transport.js'
import { translateEventPaths } from './worker-path-bridge.js'
import {
  buildXiaoguiPromptSessionStateV1,
  createXiaoguiPromptSessionExtensionV1,
  type XiaoguiEffectivePromptSessionStateV1,
} from './xiaogui-prompt/session-extension.js'
import { freezeXiaoguiPromptContextV1 } from './xiaogui-prompt/session-binding.js'
import { createXiaoguiCodingContextExtensionV1 } from './xiaogui-coding-extensions/context-extension.js'
import { createXiaoguiCodingRoleGuardExtensionV1 } from './xiaogui-coding-extensions/role-guard-extension.js'
import { CodingRoleRuntimeBindingV1 } from './xiaogui-coding-extensions/role-runtime-binding.js'

export type WorkerModelRuntime = Pick<
  ModelRuntime,
  'getModel' | 'getModels' | 'getAvailable' | 'refresh' | 'getProviderAuthStatus' | 'listCredentials'
>

export type WorkerMutableState = {
  sdk: typeof import('@earendil-works/pi-coding-agent') | null
  activeSdkPath: string | null
  sharedEventBus: EventBus | null
  /** Canonical model/auth runtime owned by the current AgentSessionRuntime services. */
  modelRuntime: WorkerModelRuntime | null
  /** Live AgentSession (always mirrors runtime.session when runtime is set). */
  session: AgentSession | null
  /** Owns session replacement: new / switch / fork / clone. */
  runtime: AgentSessionRuntime | null
  uiBridge: DesktopUIBridge | null
  widgetHost: ReturnType<typeof createDesktopWidgetHost> | null
  seq: number
  currentCwd: string
  currentSessionId: string
  currentRunId: string
  currentTurnId: string
  unsubscribe: (() => void) | null
  agentTurnActive: boolean
  promptPreflightActive: boolean
  promptSent: boolean
  /** Main-provided, immutable Session selection facts. */
  promptContext: XiaoguiPromptContextV1 | null
  /** Main candidate retained separately from Worker-resolved effective facts. */
  promptContextCandidate: XiaoguiPromptContextV1 | null
  /** Frozen local selection for the currently dispatching user turn. */
  promptTurnContext: XiaoguiPromptContextV1 | null
  /** Confirmation-gated Capability available to exactly the next user turn. */
  promptStickyCapabilities: readonly XiaoguiCapabilityId[]
  /** Capabilities proven by successful PREPARE/START tool results in this turn. */
  promptTurnStickyCapabilities: readonly XiaoguiCapabilityId[]
  /** Preparation calls awaiting their real tool end result in this turn. */
  promptTurnStickyToolCalls: Map<string, {
    readonly toolName: string
    readonly action: string
    readonly capabilityId: XiaoguiCapabilityId
  }>
  /** Set only while Pi Runtime is replacing an AgentSession. */
  pendingPromptContext: XiaoguiPromptContextV1 | null
  /** Safe hashes/ids returned by default diagnostics. */
  promptDiagnostics: XiaoguiEffectivePromptDiagnosticsV1 | null
  /** Worker-memory-only product Layers; Pi System/project text is never retained here. */
  effectivePrompt: string | null
  promptPreflight: (() => XiaoguiEffectivePromptSessionStateV1) | null
  promptAssemblyStatus: 'IDLE' | 'PENDING' | 'CONFIRMED' | 'FAILED'
  promptAssemblyError: string | null
  /** Main-validated, one-turn context consumed only by the inline Pi extension. */
  promptCodingContext: CodingContextAgentPayloadV1 | null
  /** Installation-bundled directories delegated to Pi's native Skill loader. */
  bundledSkillPaths: readonly string[]
}

export const st: WorkerMutableState = {
  sdk: null,
  activeSdkPath: null,
  sharedEventBus: null,
  modelRuntime: null,
  session: null,
  runtime: null,
  uiBridge: null,
  widgetHost: null,
  seq: 0,
  currentCwd: '',
  currentSessionId: '',
  currentRunId: '',
  currentTurnId: '',
  unsubscribe: null,
  agentTurnActive: false,
  promptPreflightActive: false,
  promptSent: false,
  promptContext: null,
  promptContextCandidate: null,
  promptTurnContext: null,
  promptStickyCapabilities: [],
  promptTurnStickyCapabilities: [],
  promptTurnStickyToolCalls: new Map(),
  pendingPromptContext: null,
  promptDiagnostics: null,
  effectivePrompt: null,
  promptPreflight: null,
  promptAssemblyStatus: 'IDLE',
  promptAssemblyError: null,
  promptCodingContext: null,
  bundledSkillPaths: [],
}

const codingRoleRuntimeBindingV1 = new CodingRoleRuntimeBindingV1()

function nextSeq(): number {
  return ++st.seq
}

export function beginRunIdentity(): void {
  st.currentRunId = `run-${nextSeq()}`
  st.currentTurnId = `turn-${nextSeq()}`
}

export function emit(event: AppEvent): void {
  sendToMain({ type: 'app-event', event: translateEventPaths(event) })
}

function now(): number {
  return Date.now()
}

export function currentSessionModelKey(): string | undefined {
  return st.session ? formatSessionModelKey(st.session.model as SessionModelRef) : undefined
}

/** Main-to-Worker private role support check. No prompt body is projected back. */
export function inspectCodingRoleRuntimeV1(value: unknown): CodingRoleAgentSnapshotV1 {
  if (!st.session) throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_UNAVAILABLE')
  if (st.promptContextCandidate?.mode !== 'CODING') {
    throw new Error('XIAOGUI_CODING_ROLE_CODING_SESSION_REQUIRED')
  }
  const snapshot = codingRoleRuntimeBindingV1.assertBindable(value)
  if (snapshot.snapshot.runtimePolicyId !== 'approved.default') {
    throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_POLICY_UNSUPPORTED')
  }
  if (snapshot.snapshot.modelSelector === 'inherit') {
    if (!currentSessionModelKey()) throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
    return snapshot
  }
  const separator = snapshot.snapshot.modelSelector.indexOf('/')
  if (separator <= 0 || separator === snapshot.snapshot.modelSelector.length - 1) {
    throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
  }
  const provider = snapshot.snapshot.modelSelector.slice(0, separator)
  const modelId = snapshot.snapshot.modelSelector.slice(separator + 1)
  if (!st.modelRuntime?.getModel(provider, modelId)) {
    throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
  }
  return snapshot
}

/** Bind once for the live Attempt; an explicit model selector is confirmed before commit. */
export async function bindCodingRoleRuntimeV1(value: unknown): Promise<CodingRoleAgentSnapshotV1> {
  const snapshot = inspectCodingRoleRuntimeV1(value)
  const selector = snapshot.snapshot.modelSelector
  if (selector !== 'inherit' && currentSessionModelKey() !== selector) {
    const separator = selector.indexOf('/')
    const provider = selector.slice(0, separator)
    const modelId = selector.slice(separator + 1)
    const model = st.modelRuntime?.getModel(provider, modelId)
    if (!model) throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
    try {
      await st.session!.setModel(model as Parameters<NonNullable<typeof st.session>['setModel']>[0])
    } catch {
      throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
    }
    if (currentSessionModelKey() !== selector) {
      throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
    }
  }
  return codingRoleRuntimeBindingV1.bind(snapshot)
}

export function readCodingRoleRuntimeV1(): CodingRoleAgentSnapshotV1 | null {
  return codingRoleRuntimeBindingV1.read()
}

export function releaseCodingRoleRuntimeV1(expectedAttemptId?: string): void {
  codingRoleRuntimeBindingV1.release(expectedAttemptId)
}

export function baseEvent() {
  return {
    seq: nextSeq(),
    workspaceId: st.currentCwd,
    sessionId: st.currentSessionId,
    sessionFile: st.session?.sessionFile,
    runId: st.currentRunId,
    turnId: st.currentTurnId,
    timestamp: now(),
  }
}

export function isSessionBusy(): boolean {
  return !!(st.agentTurnActive || st.session?.isStreaming)
}

function selectTurnContext(
  baseContext: XiaoguiPromptContextV1,
  userInput: string,
  oneTurnStickyCapabilityIds: readonly XiaoguiCapabilityId[] = [],
): {
  readonly context: XiaoguiPromptContextV1
} {
  const selection = selectXiaoguiTurnCapabilitiesV1(baseContext, userInput, {
    oneTurnStickyCapabilityIds,
  })
  return {
    context: freezeXiaoguiPromptContextV1({
      ...baseContext,
      enabledCapabilities: selection.capabilityIds,
      availableToolNames: [],
    }),
  }
}

/**
 * Freeze the turn Capability selection and apply the Provider-facing Host Tool
 * Policy before Prompt preflight. The Context cannot change again until this
 * turn settles.
 */
export function prepareXiaoguiPromptTurnV1(userInput: string): XiaoguiPromptContextV1 {
  const session = st.session
  const baseContext = st.promptContextCandidate
  if (!session || !baseContext) throw new Error('XIAOGUI_PROMPT_CONTEXT_REQUIRED')
  if (isSessionBusy()) throw new Error('XIAOGUI_PROMPT_CONTEXT_TURN_ACTIVE')

  const selectedTurn = selectTurnContext(
    baseContext,
    userInput,
    st.promptStickyCapabilities,
  )
  // Sticky state is single-use. A new clear intent either replaces it with a
  // tool-confirmed candidate after successful completion or clears it immediately.
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.promptTurnStickyToolCalls.clear()
  const selected = selectedTurn.context
  const registered = session.getAllTools().map((tool) => tool.name)
  const active = codingRoleRuntimeBindingV1.activeToolNames(
    activeToolNamesForPromptContextV1(selected, registered),
  )
  session.setActiveToolsByName([...active])
  const actual = session.getActiveToolNames()
  const turnContext = freezeXiaoguiPromptContextV1({
    ...selected,
    availableToolNames: actual,
  })
  st.promptTurnContext = turnContext
  return turnContext
}

export function clearXiaoguiPromptTurnV1(): void {
  st.promptTurnContext = null
  st.promptTurnStickyCapabilities = []
  st.promptTurnStickyToolCalls.clear()
}

export function completeXiaoguiPromptTurnV1(): void {
  st.promptStickyCapabilities = [...st.promptTurnStickyCapabilities]
  clearXiaoguiPromptTurnV1()
}

function toolResultKind(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const kind = (details as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

/** Observe only real Pi tool lifecycle events; an inferred user intent alone never commits sticky state. */
function observeXiaoguiPromptStickyToolEventV1(event: AgentSessionEvent): void {
  const turnContext = st.promptTurnContext
  if (!turnContext) return

  if (event.type === 'tool_execution_start') {
    const action = typeof event.args?.action === 'string' ? event.args.action : ''
    const capabilityId = xiaoguiPromptStickyCandidateForToolActionV1(event.toolName, action)
    if (!capabilityId || !turnContext.enabledCapabilities.includes(capabilityId)) return
    st.promptTurnStickyToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      action,
      capabilityId,
    })
    return
  }

  if (event.type !== 'tool_execution_end') return
  const pending = st.promptTurnStickyToolCalls.get(event.toolCallId)
  if (!pending) return
  st.promptTurnStickyToolCalls.delete(event.toolCallId)
  const resultIsError = !!(
    event.result &&
    typeof event.result === 'object' &&
    (event.result as { isError?: unknown }).isError === true
  )
  const capabilityId = xiaoguiPromptStickyCapabilityFromToolResultV1({
    toolName: pending.toolName,
    action: pending.action,
    resultKind: toolResultKind(event.result),
    isError: event.isError || resultIsError,
  })
  if (!capabilityId || capabilityId !== pending.capabilityId) {
    st.promptTurnStickyCapabilities = st.promptTurnStickyCapabilities
      .filter((id) => id !== pending.capabilityId)
    return
  }
  st.promptTurnStickyCapabilities = [...new Set([
    ...st.promptTurnStickyCapabilities,
    capabilityId,
  ])]
}

/** Synchronous hard gate before any call into AgentSession.prompt(). */
export function runXiaoguiPromptPreflightV1(): XiaoguiEffectivePromptSessionStateV1 {
  if (!st.promptContextCandidate || !st.promptPreflight) {
    throw new Error('XIAOGUI_PROMPT_PREFLIGHT_UNAVAILABLE')
  }
  const state = st.promptPreflight()
  const candidate = st.promptContextCandidate
  if (
    state.context.schemaVersion !== candidate.schemaVersion ||
    state.context.mode !== candidate.mode ||
    state.context.phase !== candidate.phase ||
    state.context.workspaceAvailable !== candidate.workspaceAvailable ||
    state.context.sessionKey !== candidate.sessionKey ||
    state.context.projectId !== candidate.projectId
  ) {
    throw new Error('XIAOGUI_PROMPT_CONTEXT_PREFLIGHT_MISMATCH')
  }
  st.promptContext = state.context
  st.promptDiagnostics = state.diagnostics
  st.effectivePrompt = state.productPrompt
  return state
}

function confirmXiaoguiPromptAssemblyV1(): void {
  if (st.promptAssemblyStatus === 'PENDING') st.promptAssemblyStatus = 'CONFIRMED'
}

function failXiaoguiPromptAssemblyV1(error: unknown): void {
  if (st.promptAssemblyStatus !== 'PENDING') return
  st.promptAssemblyStatus = 'FAILED'
  st.promptAssemblyError = errorMessage(error)
}

export function resetXiaoguiPromptAssemblyGateV1(): void {
  st.promptAssemblyStatus = 'IDLE'
  st.promptAssemblyError = null
}

/**
 * Pi invokes preflightResult(true) after before_agent_start and immediately
 * before _runAgentPrompt. Throwing here is outside Pi's swallowed extension
 * error loop, so an unconfirmed/failed final assembly cannot reach Provider.
 */
export function createXiaoguiPromptAssemblyGateV1(
  requireFinalAssembly: boolean,
): (passed: boolean) => void {
  if (st.promptAssemblyStatus !== 'IDLE') {
    throw new Error('XIAOGUI_PROMPT_ASSEMBLY_GATE_ACTIVE')
  }
  st.promptAssemblyStatus = 'PENDING'
  st.promptAssemblyError = null
  return (passed) => {
    const status = st.promptAssemblyStatus
    const failure = st.promptAssemblyError
    resetXiaoguiPromptAssemblyGateV1()
    if (!passed) return
    if (status === 'FAILED') {
      throw new Error(`XIAOGUI_PROMPT_FINAL_ASSEMBLY_FAILED: ${failure || 'unknown'}`)
    }
    if (requireFinalAssembly && status !== 'CONFIRMED') {
      throw new Error('XIAOGUI_PROMPT_FINAL_ASSEMBLY_NOT_CONFIRMED')
    }
  }
}

function detachSessionSubscription(): void {
  if (st.unsubscribe) {
    st.unsubscribe()
    st.unsubscribe = null
  }
}

/** After Runtime replaces the AgentSession: resubscribe + rebind desktop extensions. */
export async function rebindAfterRuntimeReplace(session: AgentSession): Promise<void> {
  detachSessionSubscription()
  resetSessionEventTracking()
  resetCompletionTurnTracking()
  st.widgetHost?.dispose()
  st.widgetHost = null
  st.session = session
  st.modelRuntime = st.runtime?.services.modelRuntime ?? session.modelRuntime ?? null
  st.currentSessionId = session.sessionId
  st.currentRunId = ''
  st.currentTurnId = ''
  st.agentTurnActive = false
  st.promptPreflightActive = false
  st.promptTurnContext = null
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.promptTurnStickyToolCalls.clear()
  try {
    const cwd = session.sessionManager?.getCwd?.()
    if (typeof cwd === 'string' && cwd.length > 0) st.currentCwd = cwd
  } catch {
    /* ignore */
  }
  await bindDesktopExtensions(session)
  st.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    handleSessionEvent(event)
  })
  emitSessionModelState()
}

/** Push current session model to renderer; optionally include SDK model restore fallback. */
export function emitSessionModelState(opts?: { modelFallbackMessage?: string | null }): void {
  if (!st.session) return
  const modelStr = currentSessionModelKey()
  const fallback = String(opts?.modelFallbackMessage || '').trim()
  emit({
    ...baseEvent(),
    type: 'run',
    phase: 'state',
    model: modelStr,
    thinkingLevel: st.session.thinkingLevel,
    ...(fallback ? { modelFallbackMessage: fallback } : {}),
  })
}

function noteModelFallbackFromRuntime(): void {
  const fallback = String(st.runtime?.modelFallbackMessage || '').trim()
  if (!fallback) return
  console.warn('[Worker] Model fallback:', fallback)
  emitSessionModelState({ modelFallbackMessage: fallback })
}

function buildRuntimeFactory(): CreateAgentSessionRuntimeFactory {
  const sdk = st.sdk!
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const promptContext = st.pendingPromptContext
    if (!promptContext) throw new Error('XIAOGUI_PROMPT_CONTEXT_REQUIRED')
    const initialContext = selectTurnContext(promptContext, '').context
    // SDK 的 tools 选项同时充当注册表白名单（allowedToolNames）与初始激活集：
    // 只传首轮默认工具会把后续轮次按 Host Tool Policy 选中的能力工具永久踢出
    // 注册表，setActiveToolsByName 对未注册名字静默忽略。注册表必须覆盖本模式
    // 全部候选工具；初始激活集在会话创建后再按首轮策略收窄。
    const sessionToolUniverse = workerPromptContextToolNamesForModeV1(promptContext.mode)
    const initialToolNames = codingRoleRuntimeBindingV1.activeToolNames(
      activeToolNamesForPromptContextV1(initialContext, sessionToolUniverse),
    )
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        eventBus: st.sharedEventBus!,
        additionalSkillPaths: [...st.bundledSkillPaths],
        extensionFactories: [
          ...(promptContext.mode === 'CODING'
            ? [createXiaoguiCodingRoleGuardExtensionV1(
                () => codingRoleRuntimeBindingV1.read(),
              ).factory]
            : []),
          createXiaoguiPromptSessionExtensionV1(
            () => st.promptTurnContext ?? initialContext,
            (state) => {
              if (st.promptContextCandidate === promptContext) {
                st.promptContext = state.context
                st.promptDiagnostics = state.diagnostics
                st.effectivePrompt = state.productPrompt
                confirmXiaoguiPromptAssemblyV1()
              }
            },
            (error) => {
              if (st.promptContextCandidate === promptContext) {
                failXiaoguiPromptAssemblyV1(error)
              }
            },
          ),
          ...(promptContext.mode === 'CODING'
            ? [createXiaoguiCodingContextExtensionV1(() => st.promptCodingContext).factory]
            : []),
        ],
        extensionsOverride: (result) => {
          const collaborationToolOptions = {
            getSourceSessionId: () => st.currentSessionId || undefined,
            getSourceTurnId: () => st.currentTurnId || undefined,
          }
          const sessionToolOptions = {
            getSourceSessionId: collaborationToolOptions.getSourceSessionId,
            getSourceRunId: () => st.currentRunId || undefined,
          }
          const loaded = addXiaoguiWorkerToolsV1(
            decorateQuestionnaireTools(result, cwd),
            promptContext,
            { collaboration: collaborationToolOptions, session: sessionToolOptions },
          )
          return assertXiaoguiModelToolSchemasCompatible(loaded)
        },
        skillsOverride: applySkillsOverride as never,
      },
    })
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: [...sessionToolUniverse],
    })
    // tools 传全集只是为了保住注册表；初始激活仍按首轮策略（空输入）收窄。
    created.session.setActiveToolsByName([...initialToolNames])
    const initialState = buildXiaoguiPromptSessionStateV1(
      created.session,
      services,
      initialContext,
    )
    st.promptContextCandidate = promptContext
    st.promptContext = initialState.context
    st.promptDiagnostics = initialState.diagnostics
    st.effectivePrompt = initialState.productPrompt
    st.promptPreflight = () => buildXiaoguiPromptSessionStateV1(
      created.session,
      services,
      st.promptTurnContext ?? initialContext,
    )
    return {
      ...created,
      services,
      diagnostics: services.diagnostics ?? [],
    }
  }
}

async function withPendingPromptContext<T>(
  rawContext: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  if (st.pendingPromptContext) throw new Error('XIAOGUI_PROMPT_CONTEXT_TRANSITION_ACTIVE')
  const context = freezeXiaoguiPromptContextV1(rawContext)
  const previousContext = st.promptContext
  const previousCandidate = st.promptContextCandidate
  const previousTurnContext = st.promptTurnContext
  const previousStickyCapabilities = st.promptStickyCapabilities
  const previousTurnStickyCapabilities = st.promptTurnStickyCapabilities
  const previousTurnStickyToolCalls = new Map(st.promptTurnStickyToolCalls)
  const previousDiagnostics = st.promptDiagnostics
  const previousEffectivePrompt = st.effectivePrompt
  const previousPreflight = st.promptPreflight
  st.pendingPromptContext = context
  st.promptTurnContext = null
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.promptTurnStickyToolCalls.clear()
  try {
    return await operation()
  } catch (error) {
    st.promptContext = previousContext
    st.promptContextCandidate = previousCandidate
    st.promptTurnContext = previousTurnContext
    st.promptStickyCapabilities = previousStickyCapabilities
    st.promptTurnStickyCapabilities = previousTurnStickyCapabilities
    st.promptTurnStickyToolCalls = previousTurnStickyToolCalls
    st.promptDiagnostics = previousDiagnostics
    st.effectivePrompt = previousEffectivePrompt
    st.promptPreflight = previousPreflight
    throw error
  } finally {
    st.pendingPromptContext = null
  }
}

function wireRuntimeCallbacks(runtime: AgentSessionRuntime): void {
  runtime.setBeforeSessionInvalidate(() => {
    codingRoleRuntimeBindingV1.release()
    detachSessionSubscription()
    st.session = null
    st.modelRuntime = null
    st.agentTurnActive = false
    st.promptPreflightActive = false
    st.promptTurnContext = null
    st.promptStickyCapabilities = []
    st.promptTurnStickyCapabilities = []
    st.promptTurnStickyToolCalls.clear()
    st.promptDiagnostics = null
    st.effectivePrompt = null
  })
  runtime.setRebindSession(async (session) => {
    await rebindAfterRuntimeReplace(session)
  })
}

async function disposeRuntimeOrSession(): Promise<void> {
  codingRoleRuntimeBindingV1.release()
  detachSessionSubscription()
  st.agentTurnActive = false
  st.promptPreflightActive = false
  if (st.runtime) {
    try {
      st.runtime.setRebindSession(undefined)
      st.runtime.setBeforeSessionInvalidate(undefined)
      await st.runtime.dispose()
    } catch (e) {
      console.warn('[Worker] runtime.dispose failed:', errorMessage(e))
      try {
        st.session?.dispose()
      } catch {
        /* ignore */
      }
    }
    st.runtime = null
    st.modelRuntime = null
    st.session = null
    st.promptContext = null
    st.promptContextCandidate = null
    st.promptTurnContext = null
    st.promptStickyCapabilities = []
    st.promptTurnStickyCapabilities = []
    st.promptTurnStickyToolCalls.clear()
    st.promptDiagnostics = null
    st.effectivePrompt = null
    st.promptPreflight = null
    resetXiaoguiPromptAssemblyGateV1()
    return
  }
  if (st.session) {
    try {
      st.session.dispose()
    } catch {
      /* ignore */
    }
    st.session = null
  }
  st.modelRuntime = null
  st.promptContext = null
  st.promptContextCandidate = null
  st.promptTurnContext = null
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.promptTurnStickyToolCalls.clear()
  st.promptDiagnostics = null
  st.effectivePrompt = null
  st.promptPreflight = null
  resetXiaoguiPromptAssemblyGateV1()
}

export async function initSession(
  cwd: string,
  promptContext: unknown,
  bundledSkillPaths?: readonly string[],
): Promise<void> {
  st.promptSent = false
  if (bundledSkillPaths) {
    st.bundledSkillPaths = [...new Set(
      bundledSkillPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    )]
  }
  await disposeRuntimeOrSession()

  st.currentCwd = cwd
  const sdk = st.sdk!
  const agentDir = sdk.getAgentDir()
  const createRuntime = buildRuntimeFactory()
  const runtime = await withPendingPromptContext(promptContext, () =>
    sdk.createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: sdk.SessionManager.create(cwd),
    }),
  )
  st.runtime = runtime
  wireRuntimeCallbacks(runtime)
  await rebindAfterRuntimeReplace(runtime.session)
  noteModelFallbackFromRuntime()
}

/**
 * Switch live runtime to an existing session file (or apply leaf tip if already bound).
 */
export async function switchOrLoadSession(
  sessionFile: string,
  promptContext: unknown,
  leafOverride?: string | null,
  forceRebuild = false,
): Promise<void> {
  const sdk = st.sdk!
  if (!st.runtime || forceRebuild) {
    // Cold path: build runtime opened on this file
    await disposeRuntimeOrSession()
    const agentDir = sdk.getAgentDir()
    const sm = sdk.SessionManager.open(sessionFile)
    if (leafOverride === null) sm.resetLeaf?.()
    else if (typeof leafOverride === 'string' && leafOverride.length > 0) {
      try {
        sm.branch(leafOverride)
      } catch (e) {
        console.warn('[Worker] loadSession branch override failed:', e)
      }
    }
    const createRuntime = buildRuntimeFactory()
    const runtime = await withPendingPromptContext(promptContext, () =>
      sdk.createAgentSessionRuntime(createRuntime, {
        cwd: sm.getCwd?.() || st.currentCwd || process.cwd(),
        agentDir,
        sessionManager: sm,
      }),
    )
    st.runtime = runtime
    wireRuntimeCallbacks(runtime)
    await rebindAfterRuntimeReplace(runtime.session)
    noteModelFallbackFromRuntime()
    return
  }

  const result = await withPendingPromptContext(promptContext, () =>
    st.runtime!.switchSession(sessionFile),
  )
  if (result.cancelled) {
    throw new Error('SESSION_SWITCH_CANCELLED')
  }
  // rebindSession already ran; apply leaf tip if requested
  if (leafOverride !== undefined && st.session) {
    try {
      const sm = st.session.sessionManager
      if (leafOverride === null) sm.resetLeaf?.()
      else if (leafOverride.length > 0) sm.branch(leafOverride)
      const ctx = sm.buildSessionContext?.()
      if (ctx?.messages && st.session.agent?.state) {
        st.session.agent.state.messages = ctx.messages
      }
    } catch (e) {
      console.warn('[Worker] leaf override after switchSession failed:', e)
    }
  }
  noteModelFallbackFromRuntime()
}

export async function runtimeNewSession(promptContext: unknown): Promise<{ cancelled: boolean }> {
  if (!st.runtime) {
    await initSession(st.currentCwd || process.cwd(), promptContext)
    return { cancelled: false }
  }
  const result = await withPendingPromptContext(promptContext, () => st.runtime!.newSession())
  return { cancelled: result.cancelled }
}

/**
 * TUI /fork: position defaults to "before" (user message text → selectedText).
 * TUI /clone: fork(leafId, { position: "at" }) with empty editor.
 */
export async function runtimeFork(
  entryId: string,
  options?: { position?: 'before' | 'at' },
): Promise<{ cancelled: boolean; selectedText?: string }> {
  if (!st.runtime) throw new Error('No runtime')
  const candidate = st.promptContextCandidate ?? st.promptContext
  if (!candidate) throw new Error('XIAOGUI_PROMPT_CONTEXT_REQUIRED')
  const { sessionKey: _sourceSessionKey, ...inherited } = candidate
  return withPendingPromptContext(inherited, () =>
    st.runtime!.fork(entryId, { position: options?.position ?? 'before' }),
  )
}

function buildCommandContextActions(sess: AgentSession) {
  return {
    waitForIdle: () => sess.waitForIdle(),
    // Extension session replacement deferred (PRD: extension parity out of scope).
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async (
      targetId: string,
      options?: {
        summarize?: boolean
        customInstructions?: string
        replaceInstructions?: boolean
        label?: string
      },
    ) => {
      const result = await sess.navigateTree(targetId, {
        summarize: options?.summarize ?? false,
        customInstructions: options?.customInstructions,
        replaceInstructions: options?.replaceInstructions,
        label: options?.label,
      })
      return { cancelled: result.cancelled }
    },
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {
      await sess.reload()
    },
  }
}

function workerTraceOn(): boolean {
  return (
    process.env.PI_AUDIO_TRACE === '1' ||
    process.env.PI_AUDIO_TRACE === 'true' ||
    process.env.PI_ALERT_TRACE === '1'
  )
}

function traceWorkerUi(
  req: import('./desktop-ui-bridge.js').ExtensionUIRequest,
  forwarded: boolean,
): void {
  if (!workerTraceOn()) return
  const detail =
    req.method === 'notify'
      ? { method: 'notify', notifyType: req.notifyType, msg: String(req.message || '').slice(0, 100) }
      : { method: req.method, kind: (req as { kind?: string }).kind }
  console.log('[audio-trace] worker.postExtensionUi', {
    forwarded,
    agentTurnActive: st.agentTurnActive,
    ...detail,
  })
}

function postExtensionUiToDesktop(req: import('./desktop-ui-bridge.js').ExtensionUIRequest): void {
  if (req.method === 'notify') {
    if (!st.agentTurnActive) {
      if (req.notifyType === 'error') {
        traceWorkerUi(req, true)
        sendToMain({ type: 'extension-ui-request', request: req })
      } else {
        traceWorkerUi(req, false)
      }
      return
    }
  }
  traceWorkerUi(req, true)
  sendToMain({ type: 'extension-ui-request', request: req })
}

function postExtensionUiDismiss(id: string, reason: 'timeout' | 'abort'): void {
  sendToMain({ type: 'extension-ui-dismiss', id, reason })
}

export async function bindDesktopExtensions(sess: AgentSession): Promise<void> {
  if (!st.uiBridge) {
    st.uiBridge = createDesktopUIBridge(
      st.sharedEventBus!,
      postExtensionUiToDesktop,
      postExtensionUiDismiss,
    )
  }
  await sess.bindExtensions({
    uiContext: st.uiBridge.uiContext as never,
    mode: 'rpc',
    commandContextActions: buildCommandContextActions(sess),
  })
  st.widgetHost?.dispose()
  st.widgetHost = createDesktopWidgetHost({
    emit,
    baseEvent,
    projectDir: st.currentCwd,
    theme: (st.uiBridge.uiContext as { theme?: unknown }).theme ?? {},
  })
  st.uiBridge.attachWidgetHost(st.widgetHost)
  try {
    const entries = sess.sessionManager?.getBranch?.() ?? sess.messages ?? []
    st.widgetHost.reconstructFromBranch(Array.isArray(entries) ? entries : [])
  } catch {
    /* history reconstruction is best-effort */
  }
}

function sessionEventDeps() {
  return {
    baseEvent,
    emit,
    getSession: () => st.session,
    getSessionModelKey: currentSessionModelKey,
    getUiBridge: () => st.uiBridge,
    captureAdapterTool: (toolName: string, payload: unknown) => st.widgetHost?.captureTool(toolName, payload),
    isAgentTurnActive: () => st.agentTurnActive,
    setAgentTurnActive: (v: boolean) => {
      st.agentTurnActive = v
    },
    setPromptPreflightActive: (value: boolean) => {
      st.promptPreflightActive = value
    },
    setCurrentRunId: (id: string) => {
      st.currentRunId = id
    },
    setCurrentTurnId: (id: string) => {
      st.currentTurnId = id
    },
    nextSeq,
  }
}

export function handleSessionEvent(event: AgentSessionEvent): void {
  observeXiaoguiPromptStickyToolEventV1(event)
  dispatchSessionEvent(event, sessionEventDeps())
}

export async function listSessions(cwd: string): Promise<unknown[]> {
  if (!st.sdk) return []
  try {
    return await st.sdk.SessionManager.list(cwd)
  } catch (e) {
    console.error('[Worker] listSessions failed:', e)
    return []
  }
}
