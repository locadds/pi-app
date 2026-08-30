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
  XiaoguiEffectivePromptDiagnosticsV1,
  XiaoguiPromptContextV1,
} from '@shared/xiaogui-prompt-contract'
import { formatSessionModelKey, type SessionModelRef } from '@shared/worker-model'
import { createDesktopUIBridge, type DesktopUIBridge } from './desktop-ui-bridge.js'
import { createDesktopWidgetHost } from './desktop-widget-host.js'
import { applySkillsOverride } from './skill-override.js'
import { decorateQuestionnaireTools } from './questionnaire-tool-decorator.js'
import { addXiaoguiCollaborationTool } from './xiaogui-collaboration-tool.js'
import { addXiaoguiWorkDocxTemplateDataTool } from './xiaogui-work-docx-template-data-tool.js'
import { addXiaoguiWorkDocxTemplateIntakeTool } from './xiaogui-work-docx-template-intake-tool.js'
import { addXiaoguiWorkDocxTemplateMaterializeTool } from './xiaogui-work-docx-template-materialize-tool.js'
import { addXiaoguiWorkDocxAdvancedGenerationTool } from './xiaogui-work-docx-advanced-generation-tool.js'
import { addXiaoguiWorkReportDocxTool } from './xiaogui-work-report-docx-tool.js'
import { addXiaoguiWorkDocumentSnapshotTool } from './xiaogui-work-document-snapshot-tool.js'
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
  /** Set only while Pi Runtime is replacing an AgentSession. */
  pendingPromptContext: XiaoguiPromptContextV1 | null
  /** Safe hashes/ids only. Prompt bodies never cross Worker IPC. */
  promptDiagnostics: XiaoguiEffectivePromptDiagnosticsV1 | null
  promptPreflight: (() => XiaoguiEffectivePromptSessionStateV1) | null
  promptAssemblyStatus: 'IDLE' | 'PENDING' | 'CONFIRMED' | 'FAILED'
  promptAssemblyError: string | null
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
  pendingPromptContext: null,
  promptDiagnostics: null,
  promptPreflight: null,
  promptAssemblyStatus: 'IDLE',
  promptAssemblyError: null,
}

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
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        eventBus: st.sharedEventBus!,
        extensionFactories: [
          createXiaoguiPromptSessionExtensionV1(
            promptContext,
            (state) => {
              if (st.promptContextCandidate === promptContext) {
                st.promptContext = state.context
                st.promptDiagnostics = state.diagnostics
                confirmXiaoguiPromptAssemblyV1()
              }
            },
            (error) => {
              if (st.promptContextCandidate === promptContext) {
                failXiaoguiPromptAssemblyV1(error)
              }
            },
          ),
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
          let loaded = decorateQuestionnaireTools(result, cwd)
          loaded = addXiaoguiCollaborationTool(loaded, collaborationToolOptions)
          loaded = addXiaoguiWorkDocxTemplateDataTool(loaded, sessionToolOptions)
          loaded = addXiaoguiWorkDocxTemplateIntakeTool(loaded, sessionToolOptions)
          loaded = addXiaoguiWorkDocxTemplateMaterializeTool(loaded, sessionToolOptions)
          loaded = addXiaoguiWorkDocumentSnapshotTool(loaded, sessionToolOptions)
          loaded = addXiaoguiWorkDocxAdvancedGenerationTool(loaded, sessionToolOptions)
          loaded = addXiaoguiWorkReportDocxTool(loaded, sessionToolOptions)
          return assertXiaoguiModelToolSchemasCompatible(loaded)
        },
        skillsOverride: applySkillsOverride as never,
      },
    })
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })
    const initialState = buildXiaoguiPromptSessionStateV1(
      created.session,
      services,
      promptContext,
    )
    st.promptContextCandidate = promptContext
    st.promptContext = initialState.context
    st.promptDiagnostics = initialState.diagnostics
    st.promptPreflight = () => buildXiaoguiPromptSessionStateV1(
      created.session,
      services,
      promptContext,
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
  const previousDiagnostics = st.promptDiagnostics
  const previousPreflight = st.promptPreflight
  st.pendingPromptContext = context
  try {
    return await operation()
  } catch (error) {
    st.promptContext = previousContext
    st.promptContextCandidate = previousCandidate
    st.promptDiagnostics = previousDiagnostics
    st.promptPreflight = previousPreflight
    throw error
  } finally {
    st.pendingPromptContext = null
  }
}

function wireRuntimeCallbacks(runtime: AgentSessionRuntime): void {
  runtime.setBeforeSessionInvalidate(() => {
    detachSessionSubscription()
    st.session = null
    st.modelRuntime = null
    st.agentTurnActive = false
    st.promptPreflightActive = false
  })
  runtime.setRebindSession(async (session) => {
    await rebindAfterRuntimeReplace(session)
  })
}

async function disposeRuntimeOrSession(): Promise<void> {
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
  st.promptDiagnostics = null
  st.promptPreflight = null
  resetXiaoguiPromptAssemblyGateV1()
}

export async function initSession(cwd: string, promptContext: unknown): Promise<void> {
  st.promptSent = false
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
