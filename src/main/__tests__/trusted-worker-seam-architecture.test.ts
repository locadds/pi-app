import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        entry.isFile()
        && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
        && !entry.name.includes('.test.')
      ) {
        files.push(path)
      }
    }
  }
  visit(resolve(repoRoot, root))
  return files
}

describe('trusted Pi Worker seam architecture gate', () => {
  it('has no bare session/cwd compatibility seam in WorkerManager', () => {
    const manager = source('src/main/worker-manager.ts')

    expect(manager).not.toMatch(/rememberSessionWorkspace|resolveSessionWorkspaceCwd|getPendingWorkerSessionFile/)
    expect(manager).not.toContain('readSessionMetaFromFile')
    expect(manager).not.toMatch(/async\s+loadSession\(\s*sessionFile\s*:/)
    expect(manager).not.toMatch(/async\s+start\(\s*cwd\s*:/)
    expect(manager).toMatch(/async\s+loadSession\(\s*binding:\s*TrustedSessionBindingHandleV1/)
    expect(manager).toMatch(/async\s+start\(\s*projectBinding:\s*TrustedProjectBindingHandleV1/)
    expect(manager).toContain("if (type === 'loadSession')")
    expect(manager).toContain('TRUSTED_SESSION_EXECUTION_LEASE_REQUIRED')
  })

  it('keeps the production capability issuer private to TrustedSessionAccessModule', () => {
    const consumers = productionTypeScriptFiles('src/main')
      .filter((path) => !path.endsWith('trusted-worker-capability.ts'))
      .filter((path) => source(relative(repoRoot, path)).includes('trustedSessionAccessCapabilityIssuerV1'))
      .map((path) => relative(repoRoot, path).replace(/\\/g, '/'))

    expect(consumers).toEqual(['src/main/trusted-session-access.ts'])
  })

  it('does not expose Main capability handles through shared, preload, renderer, or Worker contracts', () => {
    const exposedRoots = ['packages/shared', 'src/preload', 'src/renderer', 'src/worker']
    const exposedFiles = exposedRoots.flatMap((root) => productionTypeScriptFiles(root))

    for (const path of exposedFiles) {
      expect(source(relative(repoRoot, path))).not.toMatch(
        /Trusted(?:Project|Session)Binding(?:Handle)?V1/,
      )
    }
  })

  it('keeps List/Preview display-only and prevents a list request from forking a Worker', () => {
    const manager = source('src/main/worker-manager.ts')
    const sessionHandlers = source('src/main/ipc/handlers/session.ts')
    const listStart = sessionHandlers.indexOf("registerHandler('ipc:session.list'")
    const listEnd = sessionHandlers.indexOf("registerHandler('ipc:session.open'", listStart)
    const listHandler = sessionHandlers.slice(listStart, listEnd)

    expect(manager).not.toContain('forkListWorkerForWsl')
    expect(sessionHandlers).toContain('sessionPreviewProcess.listSessions(authorizedRoot)')
    expect(sessionHandlers).toContain('trustedSessionAccessV1.recordListedSessions')
    expect(listHandler).toContain('discoverTrustedSessions')
    expect(listHandler).not.toContain('trustedSessionAccessV1.open')
    expect(listHandler).not.toContain('workerManager.start')
    expect(listHandler).not.toContain('workerManager.loadSession')
  })

  it('uses the Main lease cwd for both Pi cold open and warm switch', () => {
    const runtime = source('src/worker/worker-runtime.ts')
    const handlers = source('src/worker/handlers/worker-handlers-session.ts')

    expect(runtime).toContain(
      'sdk.SessionManager.open(lease.sessionFile, undefined, lease.authorizedCwd)',
    )
    expect(runtime).toContain(
      'st.runtime!.switchSession(lease.sessionFile, { cwdOverride: lease.authorizedCwd })',
    )
    expect(handlers).toContain('const targetFile = executionLease.sessionFile')
    expect(handlers).not.toMatch(/const\s+targetFile\s*=\s*String\(msg\.sessionFile/)
  })
})
