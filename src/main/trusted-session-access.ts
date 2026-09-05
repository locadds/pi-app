import { canonicalWorkerProjectRootV1 } from './worker-execution-identity'
import { authorizeTrustedSessionFile } from './trusted-workspace'
import { workerManager } from './worker-manager'
import { sessionScopeResolverV1 } from './xiaogui/scope-service'
import type { PiSessionRefV1, PiSessionScopeV1 } from './xiaogui/scope-derive'
import type { SessionScopeRegistrarV1, SessionScopeResolverV1 } from './xiaogui/scope-resolver'

export interface TrustedSessionAccessV1 {
  readonly ref: PiSessionRefV1
  readonly scope: PiSessionScopeV1
}

interface TrustedSessionBindingPortV1 {
  rememberSessionWorkspace(sessionFile: string, cwd: string): void
  resolveRegisteredSessionWorkspaceCwd(sessionFile: string): string | null
  readLiveSessionBinding(
    sessionFile: string,
    cwd: string,
  ): { readonly sessionId: string; readonly agentTurnActive: boolean } | null
}

export class TrustedSessionAccessModuleV1 {
  constructor(private readonly options: {
    readonly authorizeFile: typeof authorizeTrustedSessionFile
    readonly scopeResolver: SessionScopeResolverV1 & SessionScopeRegistrarV1
    readonly bindings: TrustedSessionBindingPortV1
  }) {}

  /** Authorize an explicit Main-owned open/navigation action, then record its canonical scope. */
  async open(input: {
    readonly workspaceId: string
    readonly sessionFile: string
  }): Promise<TrustedSessionAccessV1> {
    const authorized = this.options.authorizeFile(input.workspaceId, input.sessionFile)
    if (!authorized.ok) throw new Error(authorized.error)
    const ref = { rootPath: authorized.cwd, sessionFile: authorized.sessionFile }
    const scope = await this.options.scopeResolver.resolveExisting(ref)
      ?? await this.options.scopeResolver.resolve(ref)
    this.options.bindings.rememberSessionWorkspace(ref.sessionFile, ref.rootPath)
    return { ref, scope }
  }

  /**
   * Prompt access accepts only a previously registered Main binding. Renderer
   * workspaceId/sessionFile values can select a binding, but cannot create one.
   */
  async prompt(input: {
    readonly workspaceId: string
    readonly sessionFile: string
    readonly requireRunningWorker?: boolean
  }): Promise<TrustedSessionAccessV1> {
    const workspaceId = String(input.workspaceId || '').trim()
    const sessionFile = String(input.sessionFile || '').trim()
    if (!workspaceId || !sessionFile) throw new Error('trusted_session_required')

    const registeredRoot = this.options.bindings.resolveRegisteredSessionWorkspaceCwd(sessionFile)
    if (
      !registeredRoot ||
      canonicalWorkerProjectRootV1(registeredRoot) !== canonicalWorkerProjectRootV1(workspaceId)
    ) throw new Error('trusted_session_binding_mismatch')

    const ref = { rootPath: registeredRoot, sessionFile }
    const scope = await this.options.scopeResolver.resolveExisting(ref)
    if (!scope) throw new Error('trusted_session_scope_missing')

    if (input.requireRunningWorker) {
      const live = this.options.bindings.readLiveSessionBinding(sessionFile, registeredRoot)
      if (!live?.agentTurnActive) throw new Error('trusted_running_session_required')
    }
    return { ref, scope }
  }
}

export const trustedSessionAccessV1 = new TrustedSessionAccessModuleV1({
  authorizeFile: authorizeTrustedSessionFile,
  scopeResolver: sessionScopeResolverV1,
  bindings: workerManager,
})
