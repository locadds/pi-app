// Worker Manager - multi-session utility process pool (sessionKey + workspace keys)

import { type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AppEvent } from '@shared/app-events'
import type {
  XiaoguiAdvancedPromptDiagnosticsV1,
  XiaoguiEffectivePromptDiagnosticsV1,
  XiaoguiMode,
} from '@shared/xiaogui-prompt-contract'
import type {
  WorkerCommandInfo,
  WorkerCompletionItem,
  WorkerContextPreview,
  WorkerMessagesPage,
  WorkerModelRow,
  WorkerPromptTemplate,
  WorkerRequestPayload,
  WorkerResponsePayload,
  WorkerSessionOnDisk,
  WorkerSessionTreeNode,
  WorkerSkillInfo,
  WorkerState,
} from '@shared/worker-rpc-types'
import type { CodingContextAgentPayloadV1 } from '@shared/xiaogui-coding-extension-pack'
import type { CodingRoleKindV1 } from '@shared/xiaogui-coding-extension-pack'
import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import {
  attachWorkerHandlers,
  canAcquireNewWorker,
  disposeWorkerSlot,
  evictIdleWorkers,
  extensionUiDialogSource,
  forkWorkerForCwd,
  getBackgroundWorkerState,
  pruneIdleWorkersByTimeout,
  remapSessionWorkerSlot,
  slotRequest,
} from './worker-manager-pool'
import type {
  WorkerHostToolRequestHandler,
  WorkerHostToolRequestForward,
  WorkerInitResult,
  WorkerSlot,
} from './worker-manager-types'
import { normalizeSessionKey, workspacePoolKey } from './worker-session-key'
import { getAgentRuntimeConfig } from './wsl/runtime-config'
import { readMaxSessionWorkers } from './worker-pool-config'
import { createNewSessionInPool } from './worker-manager-new-session'
import {
  applySettledRunToSessionLeafOverride,
  clearSessionLeafOverride,
  getSessionLeafOverride,
  setSessionLeafOverride,
} from './session-leaf-override'
import { observeAppEventForCompletion, observeWorkerExitForCompletion } from './completion-notification-events'
import type { XiaoguiPromptContextResolverV1 } from './xiaogui/prompt-context'
import {
  canonicalWorkerProjectRootV1,
  readCurrentWorkerExecutionIdentityDigestV1,
} from './worker-execution-identity'
import { cancelDirectExtensionUIForSource } from './direct-extension-ui'
import {
  trustedWorkerCapabilityAuthorityV1,
  type TrustedProjectBindingHandleV1,
  type TrustedSessionBindingHandleV1,
  type TrustedWorkerCapabilityAuthorityV1,
} from './trusted-worker-capability'
import { createWorkerSessionCreationOperationV1 } from './worker-session-creation-operation'

interface InitResult extends WorkerInitResult {}

export interface CodingRoleWorkerProjectionV1 {
  readonly attemptId: string
  readonly profileId: string
  readonly role: CodingRoleKindV1
  readonly snapshotDigest: string
  readonly model: string
}

export class WorkerManager {
  private mainWindow: BrowserWindow | null = null
  /** Key: session abs path or `ws:${cwd}` */
  private pool = new Map<string, WorkerSlot>()
  private foregroundPoolKey: string | null = null
  private lifecycleChain: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private hostToolRequestHandler: WorkerHostToolRequestHandler | null = null
  /** Main-owned session capabilities. Paths/digests alone can never populate this registry. */
  private sessionBindings = new Map<string, TrustedSessionBindingHandleV1>()

  constructor(
    private promptContextResolver?: XiaoguiPromptContextResolverV1,
    private readonly capabilityAuthority: TrustedWorkerCapabilityAuthorityV1 =
      trustedWorkerCapabilityAuthorityV1,
  ) {}

  private async getPromptContextResolver(): Promise<XiaoguiPromptContextResolverV1> {
    if (!this.promptContextResolver) {
      this.promptContextResolver = (
        await import('./xiaogui/prompt-context-runtime')
      ).xiaoguiPromptContextResolverV1
    }
    return this.promptContextResolver
  }

  private async workspacePromptContext(cwd: string, mode?: XiaoguiMode) {
    return (await this.getPromptContextResolver()).forWorkspace(cwd, mode)
  }

  private async sessionPromptContext(cwd: string, sessionFile: string) {
    return (await this.getPromptContextResolver()).forSession(cwd, sessionFile)
  }

  /** 小规等可信主进程模块通过此窄接口接管 Pi 内建工具请求。 */
  setHostToolRequestHandler(handler: WorkerHostToolRequestHandler | null): void {
    this.hostToolRequestHandler = handler
  }

  private async forwardHostToolRequest(payload: WorkerHostToolRequestForward) {
    if (!this.hostToolRequestHandler) {
      return {
        ok: false as const,
        error: { code: 'HOST_TOOL_UNAVAILABLE' as const, message: '小规主进程能力尚未就绪' },
      }
    }
    return this.hostToolRequestHandler(payload)
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
    this.ensureIdleTimer()
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      try {
        pruneIdleWorkersByTimeout(this.pool, this.foregroundPoolKey, Date.now(), this.mainWindow)
      } catch {
        /* ignore */
      }
    }, 60_000)
    if (typeof this.idleTimer === 'object' && this.idleTimer && 'unref' in this.idleTimer) {
      ;(this.idleTimer as NodeJS.Timeout).unref?.()
    }
  }

  async start(projectBinding: TrustedProjectBindingHandleV1): Promise<InitResult> {
    const run = this.lifecycleChain.then(() => this.startWorkspaceUnlocked(projectBinding))
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Acquire or create a worker bound to a Main-authored session binding without changing UI foreground. */
  async ensureSessionWorker(
    binding: TrustedSessionBindingHandleV1,
    opts?: { readonly force?: boolean; readonly leafId?: string | null },
  ): Promise<InitResult> {
    this.rememberSessionBinding(binding)
    const run = this.lifecycleChain.then(() => this.ensureSessionWorkerUnlocked(binding, opts))
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Bind a session worker and make it the UI foreground authority. */
  async focusSessionWorker(
    binding: TrustedSessionBindingHandleV1,
    opts?: { readonly force?: boolean; readonly leafId?: string | null },
  ): Promise<InitResult> {
    const snapshot = this.capabilityAuthority.inspectSession(binding)
    this.rememberSessionBinding(binding)
    const run = this.lifecycleChain.then(async () => {
      const result = await this.ensureSessionWorkerUnlocked(binding, opts)
      const slot = this.pool.get(normalizeSessionKey(snapshot.canonicalSessionFile))
      if (slot && !slot.stopping) this.setForeground(slot)
      return result
    })
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private foregroundSlot(): WorkerSlot | null {
    if (!this.foregroundPoolKey) return null
    return this.pool.get(this.foregroundPoolKey) ?? null
  }

  private setForeground(slot: WorkerSlot): void {
    this.foregroundPoolKey = slot.poolKey
    slot.lastForegroundAt = Date.now()
  }

  private slotMatchesCurrentRuntime(slot: WorkerSlot, expectedCwd = slot.cwd): boolean {
    try {
      const runtime = getAgentRuntimeConfig()
      return (
        slot.runtime.mode === runtime.mode &&
        slot.runtime.distro === runtime.distro &&
        slot.executionIdentityDigest ===
          readCurrentWorkerExecutionIdentityDigestV1(expectedCwd, runtime)
      )
    } catch {
      return false
    }
  }

  /** Resolve the app window for an exact live Worker/session source, foreground or background. */
  resolveHostToolRequestWindow(source: {
    readonly fromCwd: string
    readonly fromPoolKey: string
    readonly sessionFile: string
    readonly sourceSessionId: string
  }): BrowserWindow | undefined {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return undefined
    const slot = this.pool.get(source.fromPoolKey)
    if (!slot || slot.stopping) return undefined
    if (canonicalWorkerProjectRootV1(slot.cwd) !== canonicalWorkerProjectRootV1(source.fromCwd)) {
      return undefined
    }
    if (normalizeSessionKey(slot.sessionFile ?? '') !== normalizeSessionKey(source.sessionFile)) {
      return undefined
    }
    if (slot.sessionId !== source.sourceSessionId) return undefined
    if (!this.slotMatchesCurrentRuntime(slot, source.fromCwd)) return undefined
    return win
  }

  private async disposePoolSlot(slot: WorkerSlot): Promise<void> {
    cancelDirectExtensionUIForSource(slot.poolKey, slot.sessionId)
    for (const [key, candidate] of this.pool) {
      if (candidate !== slot) continue
      this.pool.delete(key)
      if (this.foregroundPoolKey === key) this.foregroundPoolKey = null
    }
    if (!slot.stopping) await disposeWorkerSlot(slot, this.mainWindow)
  }

  /** Resource settings are captured by ResourceLoader at init; stale slots cannot be rebound. */
  private async disposeStaleSlotsForCwd(cwd: string): Promise<void> {
    const projectRoot = canonicalWorkerProjectRootV1(cwd)
    const stale = new Set<WorkerSlot>()
    for (const slot of this.pool.values()) {
      if (canonicalWorkerProjectRootV1(slot.cwd) !== projectRoot) continue
      if (!this.slotMatchesCurrentRuntime(slot, cwd)) stale.add(slot)
    }
    for (const slot of stale) await this.disposePoolSlot(slot)
  }

  /** Update view/extension UI authority without creating or binding a worker. */
  focusExistingSession(sessionFile: string): boolean {
    const sk = normalizeSessionKey(sessionFile)
    if (!sk) return false
    const slot = this.pool.get(sk)
    if (slot?.stopping) return false
    this.foregroundPoolKey = sk
    if (slot) slot.lastForegroundAt = Date.now()
    return slot != null
  }

  /** The renderer is showing no session; revoke UI-bound authority without stopping workers. */
  clearForegroundSession(): void {
    this.foregroundPoolKey = null
  }

  private async startWorkspaceUnlocked(projectBinding: TrustedProjectBindingHandleV1): Promise<InitResult> {
    const project = this.capabilityAuthority.inspectProject(projectBinding)
    const cwd = project.authorizedRoot
    const promptContext = await this.workspacePromptContext(cwd)
    const key = workspacePoolKey(cwd)
    const existing = this.pool.get(key)
    if (existing && !existing.stopping && this.slotMatchesCurrentRuntime(existing, cwd)) {
      if (existing.projectIdentityDigest !== project.projectIdentityDigest) {
        throw new Error('PROJECT_IDENTITY_CHANGED')
      }
      existing.projectBinding = projectBinding
      this.setForeground(existing)
      evictIdleWorkers(this.pool, {
        foregroundKey: key,
        maxWorkers: readMaxSessionWorkers(),
        mainWindow: this.mainWindow,
      })
      if (existing.initPromise) return existing.initPromise
      const live = await this.requestOnSlot(existing, 'getState').catch(() => null)
      return {
        sessionId: String((live?.state as WorkerState)?.sessionId ?? ''),
        model: (live?.state as WorkerState)?.model as string | undefined,
        thinkingLevel: (live?.state as WorkerState)?.thinkingLevel as string | undefined,
      }
    }

    if (existing) await this.disposePoolSlot(existing)
    await this.disposeStaleSlotsForCwd(cwd)

    // Prefer reusing any session slot already on this cwd as workspace foreground
    for (const slot of this.pool.values()) {
      if (slot.cwd === cwd && !slot.stopping && this.slotMatchesCurrentRuntime(slot, cwd)) {
        this.setForeground(slot)
        return this.initResultFromSlot(slot)
      }
    }

    const maxWorkers = readMaxSessionWorkers()
    if (this.pool.size >= maxWorkers) {
      await evictIdleWorkers(this.pool, {
        foregroundKey: this.foregroundPoolKey,
        maxWorkers: maxWorkers - 1,
        mainWindow: this.mainWindow,
      })
    }
    const cap = canAcquireNewWorker(this.pool)
    if (!cap.ok) throw new Error(cap.reason)

    const { slot, init } = await forkWorkerForCwd(cwd, {
      projectBinding,
      projectIdentityDigest: project.projectIdentityDigest,
      poolKey: key,
      sessionFile: null,
      promptContext,
    })
    this.pool.set(key, slot)
    this.setForeground(slot)

    attachWorkerHandlers(slot, slot.worker, {
      mainWindow: this.mainWindow,
      getForegroundPoolKey: () => this.foregroundPoolKey,
      onAppEvent: (p) => this.forwardAppEvent(p),
      onHostToolRequest: (p) => this.forwardHostToolRequest(p),
      onSlotExit: (s, code) => this.handleSlotExit(s, code),
    })

    evictIdleWorkers(this.pool, {
      foregroundKey: key,
      maxWorkers: readMaxSessionWorkers(),
      mainWindow: this.mainWindow,
    })

    return init
  }

  /**
   * Find a pool slot to reuse for `sessionFile` on `cwd`. Prefers the
   * workspace slot, then any idle (non-running) slot already bound to the same
   * cwd — re-keying an idle worker to the new session avoids forking a fresh
   * WSL worker on every session switch (WSL forks are seconds: wsl.exe spawn +
   * SDK import). Never steals a slot mid-turn: a running session keeps its
   * worker so its agent can finish in the background.
   */
  private findReusableSlotForSession(sessionFile: string, cwd: string): WorkerSlot | null {
    const sk = normalizeSessionKey(sessionFile)
    const wsKey = workspacePoolKey(cwd)
    const wsSlot = this.pool.get(wsKey)
    if (
      wsSlot &&
      !wsSlot.stopping &&
      this.slotMatchesCurrentRuntime(wsSlot, cwd) &&
      (!wsSlot.sessionFile || wsSlot.sessionFile === sk)
    ) {
      return wsSlot
    }
    for (const slot of this.pool.values()) {
      if (slot === wsSlot || slot.stopping || slot.agentTurnActive) continue
      if (!this.slotMatchesCurrentRuntime(slot, cwd)) continue
      if (slot.cwd !== cwd) continue
      return slot
    }
    return null
  }

  private async ensureSessionWorkerUnlocked(
    binding: TrustedSessionBindingHandleV1,
    opts?: { readonly force?: boolean; readonly leafId?: string | null },
  ): Promise<InitResult> {
    const session = this.capabilityAuthority.inspectSession(binding)
    const sessionFile = session.canonicalSessionFile
    const cwd = session.authorizedRoot
    const sk = normalizeSessionKey(sessionFile)
    if (!sk) throw new Error('sessionFile required')
    if (this.resolveRegisteredSessionBinding(sessionFile) !== binding) {
      throw new Error('TRUSTED_SESSION_BINDING_REQUIRED')
    }
    const promptContext = await this.sessionPromptContext(cwd, sk)

    const existing = this.pool.get(sk)
    if (existing && !existing.stopping && this.slotMatchesCurrentRuntime(existing, cwd)) {
      existing.sessionFile = sk
      evictIdleWorkers(this.pool, {
        foregroundKey: this.foregroundPoolKey,
        maxWorkers: readMaxSessionWorkers(),
        mainWindow: this.mainWindow,
      })
      if (existing.initPromise) await existing.initPromise
      await this.loadSessionOnSlot(existing, binding, { promptContext, ...opts })
      existing.sessionBinding = binding
      existing.promptContext = promptContext
      return this.initResultFromSlot(existing)
    }

    if (existing) await this.disposePoolSlot(existing)
    await this.disposeStaleSlotsForCwd(cwd)

    // Reuse an idle same-cwd worker (workspace slot or any non-running session
    // slot) instead of forking — session switches then share a single worker.
    const reusable = this.findReusableSlotForSession(sessionFile, cwd)
    if (reusable) {
      const oldKey = reusable.poolKey
      const wasForeground = this.foregroundPoolKey === oldKey
      if (reusable.initPromise) await reusable.initPromise
      await this.loadSessionOnSlot(reusable, binding, { promptContext, ...opts })
      if (this.pool.get(oldKey) === reusable) this.pool.delete(oldKey)
      reusable.poolKey = sk
      reusable.sessionFile = sk
      reusable.sessionBinding = binding
      this.pool.set(sk, reusable)
      if (wasForeground) this.foregroundPoolKey = sk
      reusable.promptContext = promptContext
      return this.initResultFromSlot(reusable)
    }

    const maxWorkers = readMaxSessionWorkers()
    if (this.pool.size >= maxWorkers) {
      await evictIdleWorkers(this.pool, {
        foregroundKey: this.foregroundPoolKey,
        maxWorkers: maxWorkers - 1,
        mainWindow: this.mainWindow,
      })
    }
    const cap = canAcquireNewWorker(this.pool)
    if (!cap.ok) throw new Error(cap.reason)

    // A cold Worker starts by creating a temporary in-memory/new Pi Session.
    // Do not attach the target Session identity to that bootstrap Session: the
    // first loadSession would otherwise observe the same opaque sessionKey on
    // two different Session files and correctly reject the transition.
    const bootstrapPromptContext = await this.workspacePromptContext(cwd, promptContext.mode)
    const { slot, init } = await forkWorkerForCwd(cwd, {
      projectBinding: this.capabilityAuthority.projectForSession(binding),
      projectIdentityDigest: session.projectIdentityDigest,
      poolKey: sk,
      sessionFile: sk,
      promptContext: bootstrapPromptContext,
    })
    this.pool.set(sk, slot)

    attachWorkerHandlers(slot, slot.worker, {
      mainWindow: this.mainWindow,
      getForegroundPoolKey: () => this.foregroundPoolKey,
      onAppEvent: (p) => this.forwardAppEvent(p),
      onHostToolRequest: (p) => this.forwardHostToolRequest(p),
      onSlotExit: (s, code) => this.handleSlotExit(s, code),
    })

    await init
    this.capabilityAuthority.inspectSession(binding)
    await this.loadSessionOnSlot(slot, binding, { promptContext, ...opts })
    slot.sessionBinding = binding
    slot.promptContext = promptContext

    evictIdleWorkers(this.pool, {
      foregroundKey: this.foregroundPoolKey,
      maxWorkers: readMaxSessionWorkers(),
      mainWindow: this.mainWindow,
    })

    return this.initResultFromSlot(slot)
  }

  private async initResultFromSlot(slot: WorkerSlot): Promise<InitResult> {
    if (slot.initPromise) {
      try {
        return await slot.initPromise
      } catch {
        /* fall through */
      }
    }
    const live = await this.requestOnSlot(slot, 'getState').catch(() => null)
    return {
      sessionId: String((live?.state as WorkerState)?.sessionId ?? ''),
      model: (live?.state as WorkerState)?.model as string | undefined,
      thinkingLevel: (live?.state as WorkerState)?.thinkingLevel as string | undefined,
    }
  }

  private forwardAppEvent(payload: {
    event: AppEvent
    fromCwd: string
    fromPoolKey: string
    sessionFile: string | null
    agentTurnActive: boolean
  }): void {
    const { event, fromCwd, sessionFile, agentTurnActive } = payload
    let enriched = event
    if (event && typeof event === 'object') {
      const base = { ...(event as object) } as Record<string, unknown>
      if ('workspaceId' in event) {
        base.workspaceId = (event as { workspaceId?: string }).workspaceId || fromCwd
      }
      if (sessionFile && !base.sessionFile) base.sessionFile = sessionFile
      enriched = base as unknown as AppEvent
    }
    applySettledRunToSessionLeafOverride(enriched)
    observeAppEventForCompletion(enriched)
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('ipc:events', enriched)
    void agentTurnActive
  }

  private handleSlotExit(slot: WorkerSlot, code: number): void {
    const key = slot.poolKey
    cancelDirectExtensionUIForSource(key, slot.sessionId)
    if (this.pool.get(key) === slot) this.pool.delete(key)
    if (this.foregroundPoolKey === key) this.foregroundPoolKey = null
    slot.initPromise = null
    if (slot.initRejecter) {
      slot.initRejecter(new Error(`Worker exited during init with code ${code}`))
      slot.initResolver = null
      slot.initRejecter = null
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('ipc:worker-exit', {
        code,
        cwd: slot.cwd,
        sessionFile: slot.sessionFile,
        poolKey: key,
      })
    }
    if (code !== 0 && !slot.stopping) {
      observeWorkerExitForCompletion({ cwd: slot.cwd, sessionFile: slot.sessionFile })
    }

    if (slot.stopping || code === 0 || !slot.autoRestartEnabled) return

    try {
      process.stderr.write(
        '[WorkerManager] Worker crashed; auto-restart is disabled — not spawning another worker\n',
      )
    } catch {
      /* ignore */
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('ipc:worker-fatal', {
        code,
        cwd: slot.cwd,
        sessionFile: slot.sessionFile,
        message: 'Worker 已退出。请重新打开工作区；若界面空白请先结束任务管理器里多余的小规 Agent 进程。',
      })
    }
  }

  async stop(): Promise<void> {
    const run = this.lifecycleChain.then(() => this.stopUnlocked())
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async stopUnlocked(): Promise<void> {
    const slots = [...this.pool.values()]
    this.pool.clear()
    this.foregroundPoolKey = null
    await Promise.all(slots.map((s) => disposeWorkerSlot(s, this.mainWindow)))
  }

  private requestOnSlot(
    slot: WorkerSlot,
    type: string,
    data?: WorkerRequestPayload,
  ): Promise<WorkerResponsePayload> {
    if (type === 'loadSession') {
      throw new Error('TRUSTED_SESSION_EXECUTION_LEASE_REQUIRED')
    }
    return slotRequest(slot, type, data as Record<string, unknown> | undefined)
  }

  private async loadSessionOnSlot(
    slot: WorkerSlot,
    binding: TrustedSessionBindingHandleV1,
    data: {
      readonly promptContext: Awaited<ReturnType<WorkerManager['sessionPromptContext']>>
      readonly force?: boolean
      readonly leafId?: string | null
    },
  ): Promise<WorkerResponsePayload> {
    const session = this.capabilityAuthority.inspectSession(binding)
    const projectBinding = this.capabilityAuthority.projectForSession(binding)
    const project = this.capabilityAuthority.inspectProject(projectBinding)
    if (
      project.projectIdentityDigest !== slot.projectIdentityDigest
      || canonicalWorkerProjectRootV1(project.authorizedRoot) !== canonicalWorkerProjectRootV1(slot.cwd)
      || canonicalWorkerProjectRootV1(session.authorizedRoot) !== canonicalWorkerProjectRootV1(slot.cwd)
    ) {
      throw new Error('SESSION_SCOPE_MISMATCH')
    }

    const response = await slotRequest(slot, 'loadSession', {
      promptContext: data.promptContext,
      force: data.force === true,
      ...(data.leafId !== undefined ? { leafId: data.leafId } : {}),
      sessionExecutionLease: {
        schemaVersion: 1,
        sessionFile: session.canonicalSessionFile,
        authorizedCwd: session.authorizedRoot,
        projectIdentityDigest: project.projectIdentityDigest,
        slotBindingDigest: slot.slotBindingDigest,
        operationNonce: randomUUID(),
      },
    })
    if (response.type === 'error') {
      throw new Error(String(response.error || 'loadSession failed'))
    }
    const responseSessionFile = normalizeSessionKey(String(response.sessionFile || ''))
    const authorizedSessionFile = normalizeSessionKey(session.canonicalSessionFile)
    if (responseSessionFile !== authorizedSessionFile) {
      throw new Error('SESSION_SCOPE_MISMATCH')
    }
    this.capabilityAuthority.inspectProject(projectBinding)
    slot.sessionFile = authorizedSessionFile
    if (typeof response.sessionId === 'string' && response.sessionId.trim()) {
      slot.sessionId = response.sessionId.trim()
    }
    if (response.promptDiagnostics && typeof response.promptDiagnostics === 'object') {
      slot.promptDiagnostics = response.promptDiagnostics as XiaoguiEffectivePromptDiagnosticsV1
    }
    slot.projectBinding = projectBinding
    slot.sessionBinding = binding
    return response
  }

  rememberSessionBinding(binding: TrustedSessionBindingHandleV1): void {
    const snapshot = this.capabilityAuthority.inspectSession(binding)
    const key = normalizeSessionKey(snapshot.canonicalSessionFile)
    if (!key) throw new Error('TRUSTED_SESSION_BINDING_REQUIRED')
    const live = this.pool.get(key)
    if (
      live
      && canonicalWorkerProjectRootV1(live.cwd)
        !== canonicalWorkerProjectRootV1(snapshot.authorizedRoot)
    ) {
      throw new Error('SESSION_WORKSPACE_REBIND_REJECTED')
    }
    if (live) {
      if (live.projectIdentityDigest !== snapshot.projectIdentityDigest) {
        throw new Error('PROJECT_IDENTITY_CHANGED')
      }
      // A trusted Open/recovery issues a fresh in-memory handle. Replace only
      // the Main-side authority for the exact same root/session; the Worker is
      // still rebound separately through a one-shot execution lease.
      live.projectBinding = this.capabilityAuthority.projectForSession(binding)
      live.sessionBinding = binding
    }
    const existing = this.sessionBindings.get(key)
    if (existing && existing !== binding) {
      const previous = this.capabilityAuthority.inspectSession(existing)
      if (
        canonicalWorkerProjectRootV1(previous.authorizedRoot)
          !== canonicalWorkerProjectRootV1(snapshot.authorizedRoot)
      ) {
        throw new Error('SESSION_WORKSPACE_REBIND_REJECTED')
      }
    }
    this.sessionBindings.set(key, binding)
  }

  forgetSessionBinding(sessionFile: string): void {
    const key = normalizeSessionKey(sessionFile)
    if (key) this.sessionBindings.delete(key)
  }

  resolveRegisteredSessionBinding(sessionFile: string): TrustedSessionBindingHandleV1 | null {
    const key = normalizeSessionKey(sessionFile)
    if (!key) return null
    const live = this.pool.get(key)
    if (live && !live.stopping && live.sessionBinding) return live.sessionBinding
    return this.sessionBindings.get(key) ?? null
  }

  /** Exact live Worker proof used by steer/followUp authorization. */
  readLiveSessionBinding(
    binding: TrustedSessionBindingHandleV1,
  ): { readonly sessionId: string; readonly agentTurnActive: boolean } | null {
    const snapshot = this.capabilityAuthority.inspectSession(binding)
    const key = normalizeSessionKey(snapshot.canonicalSessionFile)
    const slot = key ? this.pool.get(key) : null
    if (
      !slot ||
      slot.stopping ||
      !slot.sessionId ||
      slot.sessionBinding !== binding ||
      normalizeSessionKey(slot.sessionFile ?? '') !== key ||
      canonicalWorkerProjectRootV1(slot.cwd) !== canonicalWorkerProjectRootV1(snapshot.authorizedRoot) ||
      !this.slotMatchesCurrentRuntime(slot, snapshot.authorizedRoot)
    ) return null
    return { sessionId: slot.sessionId, agentTurnActive: slot.agentTurnActive }
  }

  private async resolveSlotForRpc(sessionFile?: string | null): Promise<WorkerSlot> {
    if (sessionFile) {
      const sk = normalizeSessionKey(sessionFile)
      const bySession = this.pool.get(sk)
      if (
        bySession &&
        !bySession.stopping &&
        this.slotMatchesCurrentRuntime(bySession, bySession.cwd)
      ) {
        return bySession
      }
      const binding = this.resolveRegisteredSessionBinding(sessionFile)
      if (!binding) throw new Error('Worker not started for session')
      await this.ensureSessionWorkerUnlocked(binding)
      const slot = this.pool.get(sk)
      if (!slot) throw new Error('Worker not started for session')
      return slot
    }
    const slot = this.foregroundSlot()
    if (!slot) throw new Error('Worker not started')
    if (this.slotMatchesCurrentRuntime(slot, slot.cwd)) return slot
    const { sessionFile: foregroundSessionFile } = slot
    if (foregroundSessionFile) {
      const binding = slot.sessionBinding ?? this.resolveRegisteredSessionBinding(foregroundSessionFile)
      if (!binding) throw new Error('TRUSTED_SESSION_BINDING_REQUIRED')
      await this.ensureSessionWorkerUnlocked(binding)
      const refreshed = this.pool.get(normalizeSessionKey(foregroundSessionFile))
      if (!refreshed) throw new Error('Worker not started for session')
      this.setForeground(refreshed)
      return refreshed
    }
    await this.startWorkspaceUnlocked(slot.projectBinding)
    const refreshed = this.foregroundSlot()
    if (!refreshed) throw new Error('Worker not started')
    return refreshed
  }

  private request(type: string, data?: WorkerRequestPayload): Promise<WorkerResponsePayload> {
    const sessionFile =
      data && typeof data === 'object' && 'sessionFile' in data
        ? (data as { sessionFile?: string }).sessionFile
        : undefined
    return this.resolveSlotForRpc(sessionFile).then((slot) => this.requestOnSlot(slot, type, data))
  }

  async getBackgroundRuntimeState(poolKeyOrCwd: string): Promise<WorkerState | null> {
    // Accept session key or legacy cwd
    let key = poolKeyOrCwd
    if (!this.pool.has(key) && !key.startsWith('ws:')) {
      key = workspacePoolKey(poolKeyOrCwd)
    }
    const row = await getBackgroundWorkerState(this.pool, key)
    if (!row) return null
    return (row.state as WorkerState) || null
  }

  /** Snapshot of running flags for renderer sessionRuntime */
  listSessionRuntime(): Array<{ sessionFile: string; running: boolean; cwd: string }> {
    const out: Array<{ sessionFile: string; running: boolean; cwd: string }> = []
    for (const slot of this.pool.values()) {
      if (!slot.sessionFile) continue
      out.push({
        sessionFile: slot.sessionFile,
        running: slot.agentTurnActive,
        cwd: slot.cwd,
      })
    }
    return out
  }

  async sendPrompt(
    text: string,
    sessionFile?: string,
    codingContext?: CodingContextAgentPayloadV1,
  ): Promise<void> {
    await this.request('prompt', { text, sessionFile, codingContext })
  }

  /** Main-only role preflight. The private prompt body crosses only this Worker RPC. */
  async inspectCodingRoleSupport(
    address: SessionAddressV1,
    codingRole: CodingRoleAgentSnapshotV1,
  ): Promise<CodingRoleWorkerProjectionV1> {
    const slot = this.codingRoleSlot(address)
    const response = await this.requestOnSlot(slot, 'codingRoleBinding', {
      action: 'CHECK',
      codingRole,
    })
    return projectCodingRoleWorkerResponse(response, codingRole)
  }

  /** Bind an immutable Attempt role to the already-active CODING Worker session. */
  async bindCodingAttemptRole(
    address: SessionAddressV1,
    codingRole: CodingRoleAgentSnapshotV1,
  ): Promise<CodingRoleWorkerProjectionV1> {
    const slot = this.codingRoleSlot(address)
    const response = await this.requestOnSlot(slot, 'codingRoleBinding', {
      action: 'BIND',
      codingRole,
    })
    return projectCodingRoleWorkerResponse(response, codingRole)
  }

  /** Release requires the currently bound Attempt id; another Attempt cannot clear it. */
  async releaseCodingAttemptRole(
    address: SessionAddressV1,
    expectedAttemptId: string,
  ): Promise<{ readonly attemptId: string; readonly released: boolean }> {
    const slot = this.codingRoleSlot(address)
    const response = await this.requestOnSlot(slot, 'codingRoleBinding', {
      action: 'RELEASE',
      expectedAttemptId,
    })
    if (
      response.action !== 'RELEASE' ||
      response.attemptId !== expectedAttemptId ||
      response.released !== true
    ) throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_RESPONSE_MISMATCH')
    return { attemptId: expectedAttemptId, released: true }
  }

  private codingRoleSlot(address: SessionAddressV1): WorkerSlot {
    const matches = [...this.pool.values()].filter((slot) => (
      !slot.stopping &&
      slot.promptContext?.mode === 'CODING' &&
      slot.promptContext.projectId === address.projectId &&
      slot.promptContext.sessionKey === address.sessionKey
    ))
    if (matches.length !== 1) throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_UNAVAILABLE')
    return matches[0]
  }
  /**
   * Abort agent turn on the session's existing worker only.
   * Never ensure/create a worker just to abort (would race F1 / wrong cwd).
   */
  async abort(sessionFile: string): Promise<void> {
    const sk = normalizeSessionKey(sessionFile)
    const slot = this.pool.get(sk)
    if (!slot || slot.stopping) {
      // No live worker for this session — already idle from UI's perspective.
      return
    }
    await this.requestOnSlot(slot, 'abort', { sessionFile: sk })
  }
  async steer(text: string, sessionFile?: string): Promise<void> {
    await this.request('steer', { text, sessionFile })
  }
  async followUp(text: string, sessionFile?: string): Promise<void> {
    await this.request('followUp', { text, sessionFile })
  }
  async clearPromptQueue(sessionFile?: string): Promise<{ steering: string[]; followUp: string[] }> {
    const r = await this.request('clearQueue', sessionFile ? { sessionFile } : {})
    return { steering: (r.steering as string[]) || [], followUp: (r.followUp as string[]) || [] }
  }
  async setModel(provider: string, modelId: string, sessionFile?: string): Promise<string> {
    const response = await this.request('setModel', { provider, modelId, sessionFile })
    if (sessionFile && response.leafId !== undefined) {
      setSessionLeafOverride(sessionFile, response.leafId as string | null)
    }
    return String(response.modelId || '')
  }
  async setThinkingLevel(level: string, sessionFile?: string): Promise<void> {
    const response = await this.request('setThinkingLevel', { level, sessionFile })
    if (sessionFile && response.leafId !== undefined) {
      setSessionLeafOverride(sessionFile, response.leafId as string | null)
    }
  }
  async newSession(
    projectBinding: TrustedProjectBindingHandleV1,
    options: {
      beforeActivate?: (result: { sessionId: string; sessionFile: string }) => Promise<void>
      issueRuntimeSession: (sessionFile: string) => TrustedSessionBindingHandleV1
      mode?: XiaoguiMode
    },
  ): Promise<{ sessionId: string; sessionFile?: string; binding?: TrustedSessionBindingHandleV1 }> {
    const run = this.lifecycleChain.then(async () => {
      const project = this.capabilityAuthority.inspectProject(projectBinding)
      const cwd = project.authorizedRoot
      await this.disposeStaleSlotsForCwd(cwd)
      const promptContext = await this.workspacePromptContext(cwd, options.mode)
      const result = await createNewSessionInPool({
        cwd,
        projectBinding,
        projectIdentityDigest: project.projectIdentityDigest,
        pool: this.pool,
        mainWindow: this.mainWindow,
        foregroundPoolKey: () => this.foregroundPoolKey,
        slotMatchesCurrentRuntime: (slot) => this.slotMatchesCurrentRuntime(slot, cwd),
        setForeground: (slot) => this.setForeground(slot),
        onAppEvent: (payload) => this.forwardAppEvent(payload),
        onHostToolRequest: (payload) => this.forwardHostToolRequest(payload),
        onSlotExit: (slot, code) => this.handleSlotExit(slot, code),
        beforeActivate: options.beforeActivate,
        issueRuntimeSession: options.issueRuntimeSession,
        activateSession: async (slot, binding, promptContext) => {
          await this.loadSessionOnSlot(slot, binding, { promptContext })
        },
        promptContext,
        finalizePromptContext: (sessionFile) =>
          this.sessionPromptContext(cwd, sessionFile),
      })
      if (result.binding) this.rememberSessionBinding(result.binding)
      return result
    })
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * After Runtime creates a new session file (new/fork/clone), re-key the
   * foreground pool slot so subsequent RPCs hit the correct worker identity.
   */
  private async remapForegroundSlotToSessionFile(sessionFile: string): Promise<void> {
    const sourceKey = this.foregroundPoolKey
    if (!sourceKey) return
    this.foregroundPoolKey = await remapSessionWorkerSlot(this.pool, sourceKey, sessionFile)
  }

  async forkSession(opts: {
    sourceBinding: TrustedSessionBindingHandleV1
    entryId: string
    position?: 'before' | 'at'
    beforeActivate?: (result: { sessionId?: string; sessionFile: string }) => Promise<void>
    issueRuntimeSession: (
      projectBinding: TrustedProjectBindingHandleV1,
      sessionFile: string,
    ) => TrustedSessionBindingHandleV1
  }): Promise<{
    cancelled?: boolean
    error?: string
    sessionId?: string
    sessionFile?: string
    editorText?: string
    model?: string
    thinkingLevel?: string
    binding?: TrustedSessionBindingHandleV1
  }> {
    const source = this.capabilityAuthority.inspectSession(opts.sourceBinding)
    const projectBinding = this.capabilityAuthority.projectForSession(opts.sourceBinding)
    await this.focusSessionWorker(opts.sourceBinding)
    const slot = this.pool.get(normalizeSessionKey(source.canonicalSessionFile))
    if (!slot) return { error: 'worker_not_ready' }
    const creation = createWorkerSessionCreationOperationV1({ slot, pool: this.pool })
    const r = await this.requestOnSlot(slot, 'fork', {
      entryId: opts.entryId,
      position: opts.position,
      creationOperationNonce: creation.nonce,
    })
    if (r.type === 'error') {
      return { error: String((r as { error?: string }).error || 'fork failed') }
    }
    if (r.cancelled) {
      creation.acceptCancellation(r)
      return { cancelled: true, sessionId: String(r.sessionId || '') }
    }
    const sessionFile = creation.acceptTarget(r)
    if (sessionFile) {
      try {
        await opts.beforeActivate?.({
          sessionId: r.sessionId ? String(r.sessionId) : undefined,
          sessionFile,
        })
        const binding = opts.issueRuntimeSession(projectBinding, sessionFile)
        const promptContext = await this.sessionPromptContext(source.authorizedRoot, sessionFile)
        await this.loadSessionOnSlot(slot, binding, { promptContext })
        slot.promptContext = promptContext
        await this.remapForegroundSlotToSessionFile(sessionFile)
        this.rememberSessionBinding(binding)
        return {
          cancelled: false,
          sessionId: r.sessionId ? String(r.sessionId) : undefined,
          sessionFile,
          editorText: r.editorText as string | undefined,
          model: r.model as string | undefined,
          thinkingLevel: r.thinkingLevel as string | undefined,
          binding,
        }
      } catch (error) {
        const key = slot.poolKey
        if (this.pool.get(key) === slot) this.pool.delete(key)
        if (this.foregroundPoolKey === key) this.foregroundPoolKey = null
        await disposeWorkerSlot(slot, this.mainWindow)
        throw error
      }
    }
    return { error: 'SESSION_CREATION_RECEIPT_INVALID' }
  }

  async cloneSession(opts: {
    sourceBinding: TrustedSessionBindingHandleV1
    beforeActivate?: (result: { sessionId?: string; sessionFile: string }) => Promise<void>
    issueRuntimeSession: (
      projectBinding: TrustedProjectBindingHandleV1,
      sessionFile: string,
    ) => TrustedSessionBindingHandleV1
  }): Promise<{
    cancelled?: boolean
    error?: string
    sessionId?: string
    sessionFile?: string
    model?: string
    thinkingLevel?: string
    binding?: TrustedSessionBindingHandleV1
  }> {
    const source = this.capabilityAuthority.inspectSession(opts.sourceBinding)
    const projectBinding = this.capabilityAuthority.projectForSession(opts.sourceBinding)
    await this.focusSessionWorker(opts.sourceBinding)
    const slot = this.pool.get(normalizeSessionKey(source.canonicalSessionFile))
    if (!slot) return { error: 'worker_not_ready' }
    const creation = createWorkerSessionCreationOperationV1({ slot, pool: this.pool })
    const r = await this.requestOnSlot(slot, 'clone', { creationOperationNonce: creation.nonce })
    if (r.type === 'error') {
      return { error: String((r as { error?: string }).error || 'clone failed') }
    }
    if (r.cancelled) {
      creation.acceptCancellation(r)
      return { cancelled: true, sessionId: String(r.sessionId || '') }
    }
    const sessionFile = creation.acceptTarget(r)
    if (sessionFile) {
      try {
        await opts.beforeActivate?.({
          sessionId: r.sessionId ? String(r.sessionId) : undefined,
          sessionFile,
        })
        const binding = opts.issueRuntimeSession(projectBinding, sessionFile)
        const promptContext = await this.sessionPromptContext(source.authorizedRoot, sessionFile)
        await this.loadSessionOnSlot(slot, binding, { promptContext })
        slot.promptContext = promptContext
        await this.remapForegroundSlotToSessionFile(sessionFile)
        this.rememberSessionBinding(binding)
        return {
          cancelled: false,
          sessionId: r.sessionId ? String(r.sessionId) : undefined,
          sessionFile,
          model: r.model as string | undefined,
          thinkingLevel: r.thinkingLevel as string | undefined,
          binding,
        }
      } catch (error) {
        const key = slot.poolKey
        if (this.pool.get(key) === slot) this.pool.delete(key)
        if (this.foregroundPoolKey === key) this.foregroundPoolKey = null
        await disposeWorkerSlot(slot, this.mainWindow)
        throw error
      }
    }
    return { error: 'SESSION_CREATION_RECEIPT_INVALID' }
  }

  async getForkMessages(sessionFile?: string): Promise<Array<{ entryId: string; text: string }>> {
    const r = await this.request('getForkMessages', sessionFile ? { sessionFile } : {})
    if (r.type === 'error') return []
    return (r.messages as Array<{ entryId: string; text: string }>) || []
  }

  async listSessions(projectBinding: TrustedProjectBindingHandleV1): Promise<WorkerSessionOnDisk[]> {
    const project = this.capabilityAuthority.inspectProject(projectBinding)
    const slot = this.findExistingListSlotForProject(project.authorizedRoot)
    if (!slot) return []
    const r = await this.requestOnSlot(slot, 'listSessions')
    return (r.sessions as WorkerSessionOnDisk[]) || []
  }

  /**
   * Reuse a live Worker for list-only RPCs. List/Preview is display authority,
   * never an execution-binding or Worker-creation seam. The production session
   * list uses SessionPreviewProcess when no compatible Worker already exists.
   */
  private findExistingListSlotForProject(cwd: string): WorkerSlot | null {
    const target = (cwd || '').trim()
    if (target) {
      const wsKey = workspacePoolKey(target)
      const byWs = this.pool.get(wsKey)
      if (byWs && !byWs.stopping && this.slotMatchesCurrentRuntime(byWs)) return byWs
      for (const slot of this.pool.values()) {
        if (!slot.stopping && slot.cwd === target && this.slotMatchesCurrentRuntime(slot)) return slot
      }
    }
    return null
  }

  /**
   * Read-only runtime snapshot.
   * When sessionFile is set: ONLY query an existing pool slot for that session.
   * Never fall back to another session's foreground worker (would mis-report isStreaming),
   * and never ensure/create a worker just for a status poll.
   */
  async getState(sessionFile?: string): Promise<WorkerState> {
    if (sessionFile) {
      const sk = normalizeSessionKey(sessionFile)
      const slot = this.pool.get(sk)
      if (!slot || slot.stopping) {
        return {
          sessionFile: sk || sessionFile,
          isStreaming: false,
          bound: false,
        } as WorkerState
      }
      try {
        const r = await this.requestOnSlot(slot, 'getState')
        const state = ((r.state as WorkerState) || {}) as WorkerState
        // Always stamp the pool identity so renderer cannot mis-attribute streaming.
        return {
          ...state,
          sessionFile: slot.sessionFile || sk,
          isStreaming: !!(state as { isStreaming?: boolean }).isStreaming || slot.agentTurnActive,
          bound: true,
        }
      } catch {
        return {
          sessionFile: slot.sessionFile || sk,
          isStreaming: slot.agentTurnActive,
          bound: true,
        } as WorkerState
      }
    }
    return ((await this.request('getState', {})).state as WorkerState) || {}
  }
  async getCommands(): Promise<{ commands: WorkerCommandInfo[]; hasSession: boolean }> {
    const r = await this.request('getCommands')
    return { commands: (r.commands as WorkerCommandInfo[]) || [], hasSession: !!r.hasSession }
  }
  async getSessionContextPreview(sessionFile: string): Promise<WorkerContextPreview> {
    const sk = normalizeSessionKey(sessionFile)
    if (!sk) return null
    const slot = this.pool.get(sk)
    if (!slot || slot.stopping) return null
    const r = await this.requestOnSlot(slot, 'getSessionContextPreview', { sessionFile: sk })
    const preview = (r.preview as WorkerContextPreview) || null
    if (!preview) return null
    return { ...preview, sessionFile: slot.sessionFile || sk }
  }
  async getSkillsList(): Promise<WorkerSkillInfo> {
    const r = await this.request('getSkillsList')
    return (r.catalog as WorkerSkillInfo) || {
      complete: false,
      projectTrusted: false,
      effectiveSkills: [],
      candidates: [],
    }
  }
  async applySkillOverrides(changes: Array<{ key: string; enabled: boolean }>): Promise<number> {
    const r = await this.request('applySkillOverrides', { changes })
    return Number(r.count || 0)
  }
  async writeSkillDescription(key: string, description: string): Promise<string> {
    const r = await this.request('writeSkillDescription', { key, description })
    return String(r.description || '')
  }
  async transferSkill(
    key: string,
    target: 'user' | 'project',
    mode: 'copy' | 'move',
  ): Promise<{ ok: boolean; target?: string; name?: string }> {
    const r = await this.request('transferSkill', { key, target, mode })
    return { ok: r.ok === true, target: r.target as string | undefined, name: r.name as string | undefined }
  }
  async getPromptTemplatesList(): Promise<WorkerPromptTemplate[]> {
    const r = await this.request('getPromptTemplatesList')
    return (r.prompts as WorkerPromptTemplate[]) || []
  }
  async getContextPrompts(): Promise<WorkerResponsePayload> {
    return this.request('getContextPrompts')
  }
  async reloadResources(): Promise<void> {
    const run = this.lifecycleChain.then(async () => {
      const slots = [...new Set(this.pool.values())]
      const stale = slots.filter(
        (slot) => !slot.stopping && !this.slotMatchesCurrentRuntime(slot, slot.cwd),
      )
      if (stale.length === 0) {
        await Promise.all(
          slots
            .filter((slot) => !slot.stopping)
            .map((slot) => this.requestOnSlot(slot, 'reloadResources')),
        )
        return
      }

      const foreground = this.foregroundSlot()
      const foregroundBinding = foreground
        ? {
            projectBinding: foreground.projectBinding,
            sessionBinding: foreground.sessionBinding,
            sessionFile: foreground.sessionFile,
          }
        : null
      if (foregroundBinding?.sessionBinding) {
        this.rememberSessionBinding(foregroundBinding.sessionBinding)
      }
      for (const slot of stale) await this.disposePoolSlot(slot)

      // Background Sessions are recreated lazily. Rebuild only the currently
      // visible binding so ResourceLoader, SessionManager and tools share the
      // newly captured project/config identity.
      if (foreground && stale.includes(foreground) && foregroundBinding) {
        if (foregroundBinding.sessionFile) {
          if (!foregroundBinding.sessionBinding) {
            throw new Error('TRUSTED_SESSION_BINDING_REQUIRED')
          }
          await this.ensureSessionWorkerUnlocked(foregroundBinding.sessionBinding)
          const refreshed = this.pool.get(normalizeSessionKey(foregroundBinding.sessionFile))
          if (refreshed) this.setForeground(refreshed)
        } else {
          await this.startWorkspaceUnlocked(foregroundBinding.projectBinding)
        }
      }
    })
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }
  async getCommandCompletions(commandName: string, argumentPrefix: string): Promise<WorkerCompletionItem[]> {
    const r = await this.request('getCommandCompletions', { commandName, argumentPrefix })
    return (r.items as WorkerCompletionItem[]) || []
  }
  async getModelSettingsSnapshot(): Promise<WorkerModelRow[]> {
    const r = await this.request('getModelSettingsSnapshot')
    return (r.models as WorkerModelRow[]) || []
  }
  async getModels(): Promise<WorkerModelRow[]> {
    const r = await this.request('getModels')
    return (r.models as WorkerModelRow[]) || []
  }
  async reloadModels(): Promise<void> {
    if (!this.isRunning) return
    await this.request('reloadModels')
  }
  async getPiSettings(): Promise<Record<string, unknown>> {
    return ((await this.request('getPiSettings')).settings as Record<string, unknown>) || {}
  }
  async setPiSettings(patch: Record<string, unknown>): Promise<void> {
    await this.request('setPiSettings', { patch })
  }
  async getMessages(
    sessionFile: string,
    offset?: number,
    limit?: number,
    leafId?: string | null,
  ): Promise<WorkerMessagesPage> {
    const payload: Record<string, unknown> = { sessionFile, offset, limit }
    if (leafId !== undefined) payload.leafId = leafId
    const r = await this.request('getMessages', payload)
    const items = (r.items as WorkerMessagesPage['items']) || []
    return {
      items,
      sourceCount: typeof r.sourceCount === 'number' ? r.sourceCount : items.length,
      totalCount:
        typeof r.totalCount === 'number'
          ? r.totalCount
          : Array.isArray(r.items)
            ? r.items.length
            : 0,
      sessionMeta: r.sessionMeta as WorkerMessagesPage['sessionMeta'],
    }
  }
  async loadSession(
    binding: TrustedSessionBindingHandleV1,
    opts?: { force?: boolean; leafId?: string | null },
  ): Promise<{
    sessionId: string
    model?: string
    leafId?: string | null
    thinkingLevel?: string
    modelFallbackMessage?: string
  }> {
    const session = this.capabilityAuthority.inspectSession(binding)
    const sessionFile = session.canonicalSessionFile
    // Re-apply rewound leaf tip (main override map) so agent context matches UI.
    let leafId = opts?.leafId
    if (leafId === undefined) leafId = getSessionLeafOverride(sessionFile)
    await this.ensureSessionWorker(binding, { force: opts?.force === true, leafId })
    const sk = normalizeSessionKey(sessionFile)
    const slot = this.pool.get(sk)
    if (!slot) throw new Error('Worker not started for session')
    const r = await this.requestOnSlot(slot, 'getState')
    const state = (r.state as WorkerState | undefined) ?? {}
    return {
      sessionId: String(state.sessionId ?? slot.sessionId ?? ''),
      model: state.model as string | undefined,
      leafId: (state.leafId as string | null | undefined) ?? null,
      thinkingLevel: state.thinkingLevel as string | undefined,
      modelFallbackMessage: state.modelFallbackMessage as string | undefined,
    }
  }

  /** Safe PR4 seam: identifiers, lengths and hashes only; never Prompt text. */
  async getEffectivePromptManifest(
    sessionFile?: string,
  ): Promise<XiaoguiEffectivePromptDiagnosticsV1> {
    const r = await this.request(
      'getEffectivePromptManifest',
      sessionFile ? { sessionFile } : undefined,
    )
    return r.promptDiagnostics as XiaoguiEffectivePromptDiagnosticsV1
  }

  /** Complete body is available only through the explicit advanced UI action. */
  async getEffectivePromptPreview(
    sessionFile?: string,
  ): Promise<XiaoguiAdvancedPromptDiagnosticsV1> {
    const r = await this.request('getEffectivePromptManifest', {
      ...(sessionFile ? { sessionFile } : {}),
      includePromptBody: true,
    })
    if (typeof r.prompt !== 'string') {
      throw new Error('XIAOGUI_PROMPT_BODY_UNAVAILABLE')
    }
    return {
      ...(r.promptDiagnostics as XiaoguiEffectivePromptDiagnosticsV1),
      prompt: r.prompt,
    }
  }
  async renameSessionFile(sessionFile: string, title: string): Promise<{ ok: boolean; title?: string; error?: string }> {
    const r = await this.request('sessionRenameFile', { sessionFile, title })
    return { ok: !!r.ok, title: r.title as string | undefined, error: r.error as string | undefined }
  }
  async deleteSessionFile(sessionFile: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.request('sessionDeleteFile', { sessionFile })
    return { ok: !!r.ok, error: r.error as string | undefined }
  }
  async getSessionTree(sessionFile?: string): Promise<{ nodes: WorkerSessionTreeNode[]; leafId: string | null; error?: string }> {
    const r = await this.request('getSessionTree', sessionFile ? { sessionFile } : {})
    return {
      nodes: (r.nodes as WorkerSessionTreeNode[]) || [],
      leafId: (r.leafId as string | null) ?? null,
      error: r.error as string | undefined,
    }
  }

  /** Main-only Pi Session checkpoint RPC. No path or leaf is returned to callers. */
  async inspectPiSessionCheckpoint(input: {
    sessionFile: string
    expectedSessionId: string
  }): Promise<{ sessionId: string; snapshotDigest: string }> {
    const r = await this.request('codingSessionCheckpoint', {
      action: 'INSPECT',
      sessionFile: input.sessionFile,
      expectedSessionId: input.expectedSessionId,
    })
    return {
      sessionId: String(r.sessionId ?? ''),
      snapshotDigest: String(r.snapshotDigest ?? ''),
    }
  }

  /** Main-only Pi Session checkpoint RPC. Snapshot refs stay behind TaskHub. */
  async capturePiSessionCheckpoint(input: {
    sessionFile: string
    expectedSessionId: string
    snapshotRef: string
  }): Promise<{ sessionId: string; snapshotRef: string; snapshotDigest: string }> {
    const r = await this.request('codingSessionCheckpoint', {
      action: 'CAPTURE',
      sessionFile: input.sessionFile,
      expectedSessionId: input.expectedSessionId,
      snapshotRef: input.snapshotRef,
    })
    return {
      sessionId: String(r.sessionId ?? ''),
      snapshotRef: String(r.snapshotRef ?? ''),
      snapshotDigest: String(r.snapshotDigest ?? ''),
    }
  }

  /** Main-only Pi Session checkpoint RPC. Restore remains session-scoped. */
  async restorePiSessionCheckpoint(input: {
    sessionFile: string
    expectedSessionId: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<{ sessionId: string; restoredSnapshotDigest: string }> {
    const r = await this.request('codingSessionCheckpoint', {
      action: 'RESTORE',
      sessionFile: input.sessionFile,
      expectedSessionId: input.expectedSessionId,
      snapshotRef: input.snapshotRef,
      expectedDigest: input.expectedDigest,
    })
    // The Worker persisted a RESTORE_HEAD as the latest Session entry. Any
    // earlier manual rewind override would otherwise defeat it on reload.
    clearSessionLeafOverride(input.sessionFile)
    return {
      sessionId: String(r.sessionId ?? ''),
      restoredSnapshotDigest: String(r.restoredSnapshotDigest ?? ''),
    }
  }

  async navigateTree(
    targetId: string,
    options?: { summarize?: boolean; label?: string; sessionFile?: string },
  ): Promise<{
    cancelled: boolean
    editorText?: string
    leafId?: string | null
    sessionMeta?: { model?: string; thinkingLevel?: string }
    error?: string
  }> {
    const sessionFile = options?.sessionFile
    const r = await this.request('navigateTree', {
      targetId,
      summarize: options?.summarize,
      label: options?.label,
      ...(sessionFile ? { sessionFile } : {}),
    })
    if (r.type === 'error') {
      return {
        cancelled: true,
        error: String((r as { error?: string }).error || 'navigateTree failed'),
      }
    }
    return {
      cancelled: !!r.cancelled,
      editorText: r.editorText as string | undefined,
      leafId: (r.leafId as string | null) ?? null,
      sessionMeta: r.sessionMeta as { model?: string; thinkingLevel?: string } | undefined,
    }
  }
  async runExtensionCommand(text: string): Promise<void> {
    await this.request('runExtensionCommand', { text })
  }

  respondExtensionUI(response: {
    id: string
    value?: string
    confirmed?: boolean
    cancelled?: boolean
    result?: unknown
  }): void {
    const slot = extensionUiDialogSource.get(response.id)
    extensionUiDialogSource.delete(response.id)
    if (!slot) return
    const existing = this.pool.get(slot.poolKey)
    if (!existing || existing.worker !== slot.worker || existing.stopping) return
    slot.worker.postMessage({ type: 'extension-ui-response', response })
  }

  cancelExtensionUI(id: string | undefined, reason: string): void {
    if (!id) return
    const slot = extensionUiDialogSource.get(id)
    extensionUiDialogSource.delete(id)
    if (!slot) return
    const existing = this.pool.get(slot.poolKey)
    if (!existing || existing.worker !== slot.worker || existing.stopping) return
    slot.worker.postMessage({ type: 'extension-ui-cancel', cancel: { id, reason } })
  }

  get isRunning(): boolean {
    return this.foregroundSlot() != null
  }

  get hasActiveTurns(): boolean {
    for (const slot of this.pool.values()) {
      if (slot.agentTurnActive) return true
    }
    return false
  }

  async awaitReady(): Promise<void> {
    const slot = this.foregroundSlot()
    if (slot?.initPromise) await slot.initPromise.catch(() => {})
  }

  get cwd(): string | null {
    return this.foregroundSlot()?.cwd ?? null
  }

  get lastSdkFallback(): boolean {
    return this.foregroundSlot()?.sdkFallback ?? false
  }

  get foregroundSessionFile(): string | null {
    return this.foregroundSlot()?.sessionFile ?? null
  }
}

function projectCodingRoleWorkerResponse(
  response: WorkerResponsePayload,
  expected: CodingRoleAgentSnapshotV1,
): CodingRoleWorkerProjectionV1 {
  if (
    (response.action !== 'CHECK' && response.action !== 'BIND') ||
    response.attemptId !== expected.attemptId ||
    response.profileId !== expected.snapshot.profileId ||
    response.role !== expected.snapshot.role ||
    response.snapshotDigest !== expected.snapshotDigest ||
    typeof response.model !== 'string' ||
    !response.model
  ) throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_RESPONSE_MISMATCH')
  return Object.freeze({
    attemptId: expected.attemptId,
    profileId: expected.snapshot.profileId,
    role: expected.snapshot.role,
    snapshotDigest: expected.snapshotDigest,
    model: response.model,
  })
}

export const workerManager = new WorkerManager()
