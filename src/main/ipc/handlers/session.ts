import { configStore } from '../../config-store'
import { workerManager } from '../../worker-manager'
import { listRewindCheckpoints } from '../../pi-rewind-read'
import { listMessageAnchorsFromSessionFile } from '../../session-branch-anchors'
import { readSessionIdFromFile } from '../../session-file-meta'
import { resolvePreparedSessionFile } from '../../session-prepare'
import { clearSessionDisplayName, resolveSessionListTitle } from '../../session-display-names'
import { renamePiSessionOnDisk } from '../../rename-pi-session'
import { bindSandboxSession, isSandboxWorkspacePath, renameSandboxWorkspace } from '../../sandbox-workspaces'
import {
  ensureWorkerSessionBound,
  getPendingWorkerSessionBinding,
  setPendingEphemeralSandboxDraft,
  setPendingWorkerSessionBinding,
} from '../../session-bind-state'
import { setVisibleSessionFile } from '../../completion-notification-events'
import { sessionPreviewProcess } from '../../session-preview-process'
import { listForkCandidatesFromSessionFile } from '../../session-fork-candidates'
import { getSessionLeafOverride, setSessionLeafOverride } from '../../session-leaf-override'
import type { SessionOnDiskRow } from '../sdk-session'
import type { PiSessionMessage } from '@shared/worker-message'
import { registerHandler, registerHandlerWithSchema } from '../registry'
import {
  sessionDeleteSchema,
  sessionExportSchema,
  sessionGetMessagesSchema,
  sessionNavigateTreeSchema,
  sessionNewSchema,
  sessionPrepareSchema,
  sessionTreeSchema,
} from '../schemas'
import { authorizeTrustedSessionFile } from '../../trusted-workspace'
import { errorMessage } from '@shared/error-message'
import { isAbsolute } from 'node:path'
import type { CanonicalSessionAddressScopeV1, SessionMode } from '@shared/xiaogui-session-scope'
import type { PiSessionRefV1, PiSessionScopeV1 } from '../../xiaogui/scope-derive'
import { sessionScopeResolverV1 } from '../../xiaogui/scope-service'
import { xiaogui } from '../../xiaogui/sidecar-bridge'
import { recordDefaultCodingCheckpointSessionAddressV1 } from '../../xiaogui/coding-extensions/checkpoint-default-composition'
import { trustedSessionAccessV1 } from '../../trusted-session-access'
import {
  trustedWorkerCapabilityAuthorityV1,
  type TrustedProjectBindingHandleV1,
  type TrustedSessionBindingHandleV1,
} from '../../trusted-worker-capability'

function publicSessionScope(scope: PiSessionScopeV1): CanonicalSessionAddressScopeV1 {
  return {
    projectId: scope.projectId,
    sessionKey: scope.sessionKey,
    sessionMode: scope.sessionMode,
  }
}

function trustedSessionRef(workspaceId: string, sessionFile: string): PiSessionRefV1 {
  const authorized = authorizeTrustedSessionFile(workspaceId, sessionFile)
  if (!authorized.ok) throw new Error(authorized.error)
  return { rootPath: authorized.cwd, sessionFile: authorized.sessionFile }
}

/**
 * A new/fork/clone target is issued by the already-running Pi worker inside the
 * main-process lifecycle gate. Pi intentionally defers creating the JSONL file
 * until the first assistant message, so an existing-file authorization would
 * reject legitimate pre-activation targets. Keep renderer-provided source files
 * on trustedSessionRef(); only the worker-issued target may use this seam.
 */
function runtimeIssuedSessionRef(rootPath: string, sessionFile: string): PiSessionRefV1 {
  const trustedRoot = String(rootPath || '').trim()
  const issuedFile = String(sessionFile || '').trim()
  const portableAbsolute = isAbsolute(issuedFile) || /^[a-zA-Z]:[\\/]/.test(issuedFile)
  if (!trustedRoot || !issuedFile || issuedFile.includes('\0') || !portableAbsolute) {
    throw new Error('invalid_runtime_session_path')
  }
  return { rootPath: trustedRoot, sessionFile: issuedFile }
}

async function resolveTrustedSessionScope(
  workspaceId: string,
  sessionFile: string,
){
  const opened = await trustedSessionAccessV1.open({ workspaceId, sessionFile })
  const { ref, scope, binding } = opened
  if (scope.sessionMode === 'CODING') {
    const sourceSessionId = readSessionIdFromFile(ref.sessionFile)
    if (sourceSessionId) {
      recordDefaultCodingCheckpointSessionAddressV1({
        address: { projectId: scope.projectId, sessionKey: scope.sessionKey },
        sourceSessionId,
        sessionFile: ref.sessionFile,
      })
    }
  }
  return { ref, scope, binding }
}

async function resolveDisplaySessionScope(
  workspaceId: string,
  sessionFile: string,
): Promise<{ ref: PiSessionRefV1; scope: PiSessionScopeV1 }> {
  const ref = trustedSessionRef(workspaceId, sessionFile)
  const scope = await sessionScopeResolverV1.resolveExisting(ref)
    ?? await sessionScopeResolverV1.resolve(ref)
  return { ref, scope }
}

async function discoverTrustedSessions(
  workspaceId: string,
  refresh = false,
): Promise<{
  readonly authorizedRoot: string
  readonly projectBinding: TrustedProjectBindingHandleV1
  readonly sessions: SessionOnDiskRow[]
}> {
  const project = trustedSessionAccessV1.project({ workspaceId })
  const authorizedRoot = project.authorizedRoot
  if (refresh) await sessionPreviewProcess.invalidateListSessions(authorizedRoot)
  const discovered = await sessionPreviewProcess.listSessions(authorizedRoot)
  const accepted = new Set(trustedSessionAccessV1.recordListedSessions({
    projectBinding: project.binding,
    sessions: discovered,
  }))
  return {
    authorizedRoot,
    projectBinding: project.binding,
    sessions: discovered.filter((session) => accepted.has(session.path)),
  }
}

export function registerSessionHandlers(): void {
  registerHandler('ipc:session.list', async (req) => {
    const workspaceId = req.workspaceId || workerManager.cwd || configStore.get('currentProject') || ''
    const discovery = workspaceId
      ? await discoverTrustedSessions(workspaceId, req.refresh === true)
      : { authorizedRoot: '', sessions: [] as SessionOnDiskRow[] }
    const sessions = discovery.sessions
    const candidates = await Promise.all(
      sessions.map(async (s: SessionOnDiskRow) => {
        try {
          const { ref, scope } = await resolveDisplaySessionScope(discovery.authorizedRoot, s.path)
          return {
            sessionId: s.id,
            sessionFile: s.path,
            workspaceId: ref.rootPath,
            title: resolveSessionListTitle(s.path, s.firstMessage?.slice(0, 60) || s.id.slice(0, 8), s.name),
            createdAt: s.created?.getTime() || 0,
            updatedAt: s.modified?.getTime() || 0,
            messageCount: s.messageCount || 0,
            modelId: '',
            status: 'idle' as const,
            canonicalScope: publicSessionScope(scope),
          }
        } catch (error) {
          // SessionManager.list is trusted discovery output, but one legacy or
          // corrupt row must not prevent a new message from being sent. Keep the
          // row hidden and avoid logging its local path.
          console.warn(
            '[session.list] skipped an invalid historical session:',
            errorMessage(error) || 'authorization_failed',
          )
          return null
        }
      }),
    )
    const formatted = candidates.filter((session): session is NonNullable<typeof session> => session !== null)
    return { sessions: formatted }
  })

  registerHandler('ipc:session.open', async (req) => {
    const sessionId = req.sessionId
    let canonicalScope: CanonicalSessionAddressScopeV1 | undefined
    if (req.sessionFile) {
      const workspaceId = String(req.workspaceId || workerManager.cwd || configStore.get('currentProject') || '')
      const resolved = await resolveTrustedSessionScope(workspaceId, req.sessionFile)
      canonicalScope = publicSessionScope(resolved.scope)
      xiaogui.setMode(resolved.scope.sessionMode)
      setPendingWorkerSessionBinding(resolved.binding)
      workerManager.focusExistingSession(resolved.ref.sessionFile)
    }
    return {
      session: {
        sessionId,
        workspaceId: workerManager.cwd || '',
        title: '',
        createdAt: 0,
        updatedAt: 0,
        modelId: '',
        status: 'idle' as const,
        canonicalScope,
      },
    }
  })

  registerHandler('ipc:session.setPendingBind', async (req) => {
    const sessionFile = req.sessionFile ?? null
    let canonicalSessionFile: string | null = null
    let canonicalScope: CanonicalSessionAddressScopeV1 | undefined
    let binding: TrustedSessionBindingHandleV1 | null = null
    if (sessionFile) {
      const workspaceId = String(req.workspaceId || workerManager.cwd || configStore.get('currentProject') || '')
      const resolved = await resolveTrustedSessionScope(workspaceId, sessionFile)
      canonicalScope = publicSessionScope(resolved.scope)
      canonicalSessionFile = resolved.ref.sessionFile
      binding = resolved.binding
      xiaogui.setMode(resolved.scope.sessionMode)
    }
    setPendingWorkerSessionBinding(binding)
    if (canonicalSessionFile) {
      const hasLiveSlot = workerManager.focusExistingSession(canonicalSessionFile)
      // Eagerly load only when the session already has a live worker slot so the
      // composer model/context refresh from the correct runtime state after switching.
      // Otherwise defer to first-prompt lazy load — never block UI switching on a
      // WSL worker fork (which takes seconds).
      if (hasLiveSlot && workerManager.isRunning && workerManager.cwd) {
        try {
          const binding = getPendingWorkerSessionBinding()
          if (!binding) throw new Error('trusted_session_binding_missing')
          await workerManager.loadSession(binding)
        } catch (e) {
          console.warn('[session.setPendingBind] loadSession failed:', e)
        }
      }
    }
    return { ok: true, canonicalScope }
  })

  registerHandler('ipc:session.setVisible', async (req) => {
    const visibleSessionFile = typeof req.sessionFile === 'string' ? req.sessionFile : null
    setVisibleSessionFile(visibleSessionFile)
    if (!visibleSessionFile) workerManager.clearForegroundSession()
    return { ok: true }
  })

  registerHandlerWithSchema('ipc:session.prepare', sessionPrepareSchema, async (req) => {
    const sessionFile = req.sessionFile
    const discovery = await discoverTrustedSessions(req.workspaceId)
    const prepared = await resolvePreparedSessionFile(sessionFile, async () => discovery.sessions)
    if (!prepared) {
      return { bound: false, sessionId: null as string | null, sessionFile }
    }
    if (prepared.parentSessionFile) {
      const recordedChild = trustedSessionAccessV1.recordDerivedSession({
        projectBinding: discovery.projectBinding,
        parentSessionFile: prepared.parentSessionFile,
        session: { id: prepared.sessionId, path: prepared.sessionFile },
      })
      if (!recordedChild) throw new Error('trusted_session_not_listed')
    }
    const authorized = await trustedSessionAccessV1.open({
      workspaceId: req.workspaceId,
      sessionFile: prepared.sessionFile,
    })
    if (req.bind !== false) setPendingWorkerSessionBinding(authorized.binding)
    return {
      bound: false,
      sessionId: prepared.sessionId,
      sessionFile: authorized.ref.sessionFile,
    }
  })

  registerHandler('ipc:session.setEphemeralDraft', async (req) => {
    setPendingEphemeralSandboxDraft(!!req.active)
    if (req.active) setPendingWorkerSessionBinding(null)
    return { ok: true }
  })

  registerHandlerWithSchema('ipc:session.tree', sessionTreeSchema, async (req) => {
    const requestedSessionFile = req.sessionFile
    const authorized = requestedSessionFile ? authorizeTrustedSessionFile(req.workspaceId, requestedSessionFile) : null
    if (authorized && !authorized.ok) {
      return { nodes: [], leafId: null, error: authorized.error }
    }
    const cwd = authorized?.cwd || workerManager.cwd || configStore.get('currentProject') || process.cwd()
    let sessionFile = authorized?.sessionFile
    let workerSessionFile: string | undefined
    let leafOverride: string | null | undefined
    if (sessionFile) leafOverride = getSessionLeafOverride(sessionFile)
    if (workerManager.isRunning) {
      try {
        const st = sessionFile
          ? await workerManager.getState(sessionFile).catch(() => null)
          : await workerManager.getState().catch(() => null)
        workerSessionFile = (st as { sessionFile?: string } | null)?.sessionFile
        if (!sessionFile) sessionFile = workerSessionFile
        if (leafOverride === undefined && st && 'leafId' in (st || {})) {
          leafOverride = (st as { leafId?: string | null }).leafId ?? null
        }
      } catch {
        /* disk tree still works */
      }
    }
    if (sessionFile) {
      try {
        const r = await sessionPreviewProcess.getTree({
          sessionFile,
          cwd,
          leafId: leafOverride,
        })
        return {
          nodes: r.nodes,
          leafId: r.leafId,
          workerBound: workerSessionFile === sessionFile,
        }
      } catch (e: unknown) {
        return { nodes: [], leafId: null, error: errorMessage(e) }
      }
    }
    try {
      const p = workerManager.getSessionTree()
      const timeout = new Promise<{ nodes: []; leafId: null; error: string }>((resolve) =>
        setTimeout(() => resolve({ nodes: [], leafId: null, error: 'timeout' }), 15000),
      )
      return await Promise.race([p, timeout])
    } catch (e: unknown) {
      return { nodes: [], leafId: null, error: errorMessage(e) }
    }
  })

  registerHandlerWithSchema('ipc:session.navigateTree', sessionNavigateTreeSchema, async (req) => {
    try {
      const resolved = await resolveTrustedSessionScope(req.workspaceId, req.sessionFile)
      xiaogui.setMode(resolved.scope.sessionMode)
      // Bind only after the Session file has been authorized against its original
      // workspace. The current UI project can never rewrite this binding.
      await ensureWorkerSessionBound(
        (binding, o) => workerManager.loadSession(binding, { force: o?.force }),
        { sessionBinding: resolved.binding },
      )
      const result = await workerManager.navigateTree(req.targetId, {
        summarize: req.summarize === true,
        label: req.label,
        sessionFile: resolved.ref.sessionFile,
      })
      // Persist leaf tip for disk getMessages / next loadSession (pi does not write leaf to JSONL).
      if (!result.cancelled) {
        const leaf = result.leafId !== undefined ? result.leafId : req.targetId
        setSessionLeafOverride(resolved.ref.sessionFile, leaf)
      }
      return result
    } catch (e: unknown) {
      return { cancelled: true, error: errorMessage(e) }
    }
  })

  registerHandler('ipc:session.branchAnchors', async (req) => {
    const file =
      req.sessionFile ||
      (
        (await workerManager.getState().catch(() => null)) as {
          sessionFile?: string
        } | null
      )?.sessionFile
    if (!file) return { anchors: [] }
    return { anchors: listMessageAnchorsFromSessionFile(file) }
  })

  registerHandler('ipc:rewind.checkpoints', async (req) => {
    const cwd = workerManager.cwd || configStore.get('currentProject') || ''
    if (!cwd) return { checkpoints: [] }
    let sessionId = req.sessionId as string | undefined
    if (!sessionId) {
      const state = await workerManager.getState().catch(() => null)
      sessionId = (state as { sessionId?: string } | null)?.sessionId
    }
    if (!sessionId && req.sessionFile) sessionId = readSessionIdFromFile(req.sessionFile) || undefined
    return { checkpoints: listRewindCheckpoints(cwd, sessionId || undefined) }
  })

  registerHandler('ipc:rewind.runCommand', async (req) => {
    await workerManager.runExtensionCommand(String(req.text || '/rewind').trim())
    return { ok: true }
  })

  registerHandlerWithSchema('ipc:session.getMessages', sessionGetMessagesSchema, async (req) => {
    const authorized = authorizeTrustedSessionFile(req.workspaceId, req.sessionFile)
    if (!authorized.ok) return { items: [], totalCount: 0, error: authorized.error }
    const offset = req.offset ?? 0
    const limit = req.limit ?? 0
    // Disk-first timeline preview. NEVER spawn/ensure a worker just to read history —
    // that was the main cause of slow session switches (loadSession + dispose thrash).
    try {
      let leafId: string | null | undefined =
        typeof req.leafId === 'string'
          ? req.leafId
          : req.leafId === null
            ? null
            : getSessionLeafOverride(authorized.sessionFile)

      // If a live worker already has this session, prefer its leaf when no override.
      if (leafId === undefined) {
        try {
          const st = await workerManager.getState(authorized.sessionFile)
          if (st && 'leafId' in st && (st as { leafId?: string | null }).leafId != null) {
            leafId = (st as { leafId?: string | null }).leafId ?? null
          }
        } catch {
          /* ignore — disk path below */
        }
      }

      const disk = await sessionPreviewProcess.getMessages({
        sessionFile: authorized.sessionFile,
        cwd: authorized.cwd,
        offset,
        limit: limit || undefined,
        leafId,
      })
      return {
        items: disk.items,
        sourceCount: disk.items.length,
        totalCount: disk.totalCount,
        sessionMeta: disk.sessionMeta,
      }
    } catch (e: unknown) {
      console.error('[IPC] session.getMessages failed:', e)
      return {
        items: [],
        totalCount: 0,
        error: errorMessage(e) || 'get_messages_failed',
      }
    }
  })

  registerHandlerWithSchema('ipc:session.new', sessionNewSchema, async (req) => {
    const workspaceId = req.workspaceId
    const project = trustedSessionAccessV1.project({ workspaceId })
    const authorizedRoot = project.authorizedRoot
    if (!workerManager.isRunning || workerManager.cwd !== authorizedRoot) {
      await workerManager.start(project.binding)
    }
    setPendingWorkerSessionBinding(null)
    const requestedMode = (req.mode ?? xiaogui.getMode()) as SessionMode
    let canonical: PiSessionScopeV1 | undefined
    const result = await workerManager.newSession(project.binding, {
      mode: requestedMode,
      issueRuntimeSession: (sessionFile) => trustedSessionAccessV1.runtimeIssued({
        projectBinding: project.binding,
        sessionFile,
      }),
      beforeActivate: async ({ sessionFile }) => {
        canonical = await sessionScopeResolverV1.registerNew(
          runtimeIssuedSessionRef(authorizedRoot, sessionFile),
          requestedMode,
        )
      },
    })
    await sessionPreviewProcess.invalidateListSessions(authorizedRoot)
    const state = await workerManager.getState().catch(() => ({}))
    const sessionFile = result.sessionFile || (state as { sessionFile?: string })?.sessionFile
    if (!sessionFile || !canonical) throw new Error('canonical_session_scope_missing')
    if (isSandboxWorkspacePath(authorizedRoot)) {
      bindSandboxSession(authorizedRoot, result.sessionId, sessionFile)
    }
    return {
      session: {
        sessionId: result.sessionId,
        sessionFile,
        workspaceId: authorizedRoot,
        title: '新会话',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        modelId: '',
        status: 'idle' as const,
        canonicalScope: publicSessionScope(canonical),
      },
    }
  })

  registerHandler('ipc:session.fork', async (req) => {
    const title = String(req?.title || '')
    const entryId = String(req?.entryId || req?.fromMessageId || '').trim()
    const sessionFile = String(req?.sessionFile || '').trim()
    const workspaceId = String(req?.workspaceId || workerManager.cwd || configStore.get('currentProject') || '')
    try {
      if (!entryId) {
        return {
          cancelled: false,
          error: 'missing entryId',
          session: {
            sessionId: '',
            workspaceId,
            title: title || 'Fork',
            createdAt: 0,
            updatedAt: 0,
            modelId: '',
            status: 'idle' as const,
            error: 'missing entryId',
          },
        }
      }
      if (!sessionFile) {
        return {
          cancelled: false,
          error: 'missing sessionFile',
          session: {
            sessionId: '',
            workspaceId,
            title: title || 'Fork',
            createdAt: 0,
            updatedAt: 0,
            modelId: '',
            status: 'idle' as const,
            error: 'missing sessionFile',
          },
        }
      }
      const sourceAccess = await resolveTrustedSessionScope(workspaceId, sessionFile)
      const source = sourceAccess.ref
      let canonical: PiSessionScopeV1 | undefined
      const result = await workerManager.forkSession({
        sourceBinding: sourceAccess.binding,
        entryId,
        position: req?.position === 'at' ? 'at' : 'before',
        issueRuntimeSession: (projectBinding, targetSessionFile) =>
          trustedSessionAccessV1.runtimeIssued({ projectBinding, sessionFile: targetSessionFile }),
        beforeActivate: async ({ sessionFile: targetSessionFile }) => {
          canonical = await sessionScopeResolverV1.derive({
            kind: 'FORK',
            source,
            target: runtimeIssuedSessionRef(source.rootPath, targetSessionFile),
          })
        },
      })
      if (result.error) {
        return {
          cancelled: false,
          error: result.error,
          session: {
            sessionId: '',
            workspaceId,
            title: title || 'Fork',
            createdAt: 0,
            updatedAt: 0,
            modelId: '',
            status: 'idle' as const,
            error: result.error,
          },
        }
      }
      if (result.cancelled) {
        return {
          cancelled: true,
          session: {
            sessionId: result.sessionId || '',
            sessionFile: result.sessionFile,
            workspaceId,
            title: title || 'Fork',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            modelId: '',
            status: 'idle' as const,
          },
        }
      }
      if (!result.sessionFile || !canonical) throw new Error('canonical_session_scope_missing')
      setPendingWorkerSessionBinding(null)
      await sessionPreviewProcess.invalidateListSessions(workspaceId)
      return {
        cancelled: false,
        editorText: result.editorText,
        sessionId: result.sessionId,
        sessionFile: result.sessionFile,
        workspaceId,
        session: {
          sessionId: result.sessionId || '',
          sessionFile: result.sessionFile,
          workspaceId,
          title: title || 'Fork',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          modelId: result.model || '',
          status: 'idle' as const,
          canonicalScope: publicSessionScope(canonical),
        },
      }
    } catch (e: unknown) {
      return {
        cancelled: false,
        error: errorMessage(e),
        session: {
          sessionId: '',
          workspaceId,
          title: title || 'Fork',
          createdAt: 0,
          updatedAt: 0,
          modelId: '',
          status: 'idle' as const,
          error: errorMessage(e),
        },
      }
    }
  })

  registerHandler('ipc:session.clone', async (req) => {
    const title = String(req?.title || '')
    const sessionFile = String(req?.sessionFile || '').trim()
    const workspaceId = String(req?.workspaceId || workerManager.cwd || configStore.get('currentProject') || '')
    try {
      if (!sessionFile) {
        return {
          cancelled: false,
          error: 'missing sessionFile',
          session: {
            sessionId: '',
            workspaceId,
            title: title || 'Clone',
            createdAt: 0,
            updatedAt: 0,
            modelId: '',
            status: 'idle' as const,
            error: 'missing sessionFile',
          },
        }
      }
      const sourceAccess = await resolveTrustedSessionScope(workspaceId, sessionFile)
      const source = sourceAccess.ref
      let canonical: PiSessionScopeV1 | undefined
      const result = await workerManager.cloneSession({
        sourceBinding: sourceAccess.binding,
        issueRuntimeSession: (projectBinding, targetSessionFile) =>
          trustedSessionAccessV1.runtimeIssued({ projectBinding, sessionFile: targetSessionFile }),
        beforeActivate: async ({ sessionFile: targetSessionFile }) => {
          canonical = await sessionScopeResolverV1.derive({
            kind: 'CLONE',
            source,
            target: runtimeIssuedSessionRef(source.rootPath, targetSessionFile),
          })
        },
      })
      if (result.error) {
        return {
          cancelled: false,
          error: result.error,
          session: {
            sessionId: '',
            workspaceId,
            title: title || 'Clone',
            createdAt: 0,
            updatedAt: 0,
            modelId: '',
            status: 'idle' as const,
            error: result.error,
          },
        }
      }
      if (result.cancelled) {
        return {
          cancelled: true,
          session: {
            sessionId: result.sessionId || '',
            sessionFile: result.sessionFile,
            workspaceId,
            title: title || 'Clone',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            modelId: '',
            status: 'idle' as const,
          },
        }
      }
      if (!result.sessionFile || !canonical) throw new Error('canonical_session_scope_missing')
      setPendingWorkerSessionBinding(null)
      await sessionPreviewProcess.invalidateListSessions(workspaceId)
      return {
        cancelled: false,
        sessionId: result.sessionId,
        sessionFile: result.sessionFile,
        workspaceId,
        session: {
          sessionId: result.sessionId || '',
          sessionFile: result.sessionFile,
          workspaceId,
          title: title || 'Clone',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          modelId: result.model || '',
          status: 'idle' as const,
          canonicalScope: publicSessionScope(canonical),
        },
      }
    } catch (e: unknown) {
      return {
        cancelled: false,
        error: errorMessage(e),
        session: {
          sessionId: '',
          workspaceId,
          title: title || 'Clone',
          createdAt: 0,
          updatedAt: 0,
          modelId: '',
          status: 'idle' as const,
          error: errorMessage(e),
        },
      }
    }
  })

  registerHandler('ipc:session.forkCandidates', async (req) => {
    const sessionFile = String(req?.sessionFile || '').trim()
    try {
      if (!sessionFile) return { messages: [] }
      const leafId = getSessionLeafOverride(sessionFile)
      return {
        messages: listForkCandidatesFromSessionFile(sessionFile, leafId),
      }
    } catch (e: unknown) {
      return { messages: [], error: errorMessage(e) }
    }
  })

  registerHandler('ipc:session.rename', async (req) => {
    const title = (req.title || '').trim()
    if (!title) return { ok: false, title: req.title }
    const cwd = workerManager.cwd || configStore.get('currentProject') || ''
    if (req.sandboxPath && isSandboxWorkspacePath(req.sandboxPath)) {
      renameSandboxWorkspace(req.sandboxPath, title)
      return { ok: true, title }
    }
    if (isSandboxWorkspacePath(cwd) && !req.sessionFile) {
      renameSandboxWorkspace(cwd, title)
      return { ok: true, title }
    }
    const file = req.sessionFile as string | undefined
    if (!file) return { ok: false, title, error: 'missing sessionFile' }
    const workspaceCwd =
      (req.workspaceId as string | undefined) || workerManager.cwd || configStore.get('currentProject') || undefined
    const r = await renamePiSessionOnDisk(file, title, workspaceCwd)
    if (!r.ok) return { ok: false, title, error: r.error || 'rename failed' }
    clearSessionDisplayName(file)
    await sessionPreviewProcess.invalidateListSessions(workspaceCwd)
    return { ok: true, title }
  })

  registerHandlerWithSchema('ipc:session.delete', sessionDeleteSchema, async (req) => {
    const authorized = authorizeTrustedSessionFile(req.workspaceId, req.sessionFile)
    if (!authorized.ok) return { ok: false, error: authorized.error }
    const r = await workerManager.deleteSessionFile(authorized.sessionFile)
    if (r.ok) {
      workerManager.forgetSessionBinding(authorized.sessionFile)
      clearSessionDisplayName(authorized.sessionFile)
      await sessionPreviewProcess.invalidateListSessions(authorized.cwd)
    }
    return { ok: !!r.ok, error: r.error }
  })

  registerHandler('ipc:session.reloadFromDisk', async (req) => {
    const binding = getPendingWorkerSessionBinding()
    const registered = req.sessionFile
      ? workerManager.resolveRegisteredSessionBinding(String(req.sessionFile))
      : binding
    const sessionFile = registered
      ? trustedWorkerCapabilityAuthorityV1.inspectSession(registered).canonicalSessionFile
      : undefined
    if (!sessionFile) return { ok: false, error: 'no session file' }
    try {
      const st = await workerManager.getState().catch(() => null)
      if (workerManager.isRunning && (st as { sessionFile?: string } | null)?.sessionFile === sessionFile) {
        if (!registered) throw new Error('trusted_session_binding_missing')
        await workerManager.loadSession(registered)
      }
      return { ok: true, sessionFile }
    } catch (e: unknown) {
      return { ok: false, error: errorMessage(e) || 'reload failed' }
    }
  })

  registerHandler('ipc:project.removeRecent', async (req) => {
    const path = (req.path as string | undefined)?.trim()
    if (!path) return { ok: false, error: 'missing path' }
    configStore.removeRecentProject(path)
    const cur = configStore.get('currentProject')
    if (cur === path) {
      const recent = configStore.get('recentProjects') || []
      const next = recent.find((p) => p && p !== path) || null
      configStore.set('currentProject', next)
    }
    return { ok: true, currentProject: configStore.get('currentProject') }
  })

  registerHandler('ipc:session.compact', async () => {
    try {
      if (!workerManager.isRunning) {
        return {
          sessionId: '',
          compacted: false,
          tokensSaved: 0,
          error: 'worker_not_ready',
        }
      }
      await workerManager.runExtensionCommand('/compact')
      return { sessionId: '', compacted: true, tokensSaved: 0 }
    } catch (e: unknown) {
      return {
        sessionId: '',
        compacted: false,
        tokensSaved: 0,
        error: errorMessage(e),
      }
    }
  })

  registerHandlerWithSchema('ipc:session.export', sessionExportSchema, async (req) => {
    const format = String(req.format || 'json')
    const sessionFile = String(req.sessionFile || '')
    try {
      if (!sessionFile)
        return {
          content: '',
          format,
          filename: 'export',
          error: 'missing sessionFile',
        }
      if (!workerManager.isRunning) {
        return {
          content: '',
          format,
          filename: 'export',
          error: 'worker_not_ready',
        }
      }
      const messages = await workerManager.getMessages(sessionFile, 0, 10000)
      const items = messages.items || []
      const filename = `session-${Date.now()}.${format === 'json' ? 'json' : format === 'html' ? 'html' : 'md'}`
      if (format === 'json') {
        return { content: JSON.stringify(items, null, 2), format, filename }
      }
      if (format === 'markdown') {
        const lines = items.map((m: PiSessionMessage) => {
          const role = m.role || 'unknown'
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
          return `### ${role}\n\n${content}\n`
        })
        return { content: lines.join('\n---\n\n'), format, filename }
      }
      if (format === 'html') {
        const body = items
          .map((m: PiSessionMessage) => {
            const role = m.role || 'unknown'
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
            return `<div><strong>${role}</strong><p>${String(content).replace(/</g, '&lt;')}</p></div>`
          })
          .join('\n')
        return {
          content: `<!DOCTYPE html><html><body>${body}</body></html>`,
          format,
          filename,
        }
      }
      return { content: '', format, filename, error: 'unsupported format' }
    } catch (e: unknown) {
      return {
        content: '',
        format,
        filename: 'export',
        error: errorMessage(e),
      }
    }
  })
}
