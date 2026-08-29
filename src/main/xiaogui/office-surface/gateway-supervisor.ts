import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { app, session, utilityProcess, type UtilityProcess } from 'electron'
import type { OfficeSnapshotV1 } from '@shared/xiaogui-office-surface'

const READY_TYPE = 'XIAOGUI_OFFICE_GATEWAY_READY_V1'
const CLOSE_TYPE = 'XIAOGUI_OFFICE_GATEWAY_CLOSE_V1'

export interface OfficeGatewaySessionV1 {
  readonly origin: string
  readonly viewerUrl: string
  readonly accessToken: string
  readonly headSha256: string
  close(): Promise<void>
}

export interface OfficeGatewaySupervisorOptionsV1 {
  readonly entryPath?: string
  readonly viewerRoot?: string
  readonly startupTimeoutMs?: number
  readonly initialSnapshot?: OfficeSnapshotV1
  /** 仅允许 SHA-256，用于在私有目录恢复同一文档工作副本。 */
  readonly persistenceKey?: string
  readonly persistenceRoot?: string
}

export class OfficeGatewaySupervisorV1 {
  private readonly sessions = new Set<OfficeGatewaySessionV1>()

  async start(options: OfficeGatewaySupervisorOptionsV1 = {}): Promise<OfficeGatewaySessionV1> {
    const appRoot = app.getAppPath()
    const entryPath = options.entryPath ?? resolve(appRoot, 'out', 'office-gateway', 'index.mjs')
    const viewerRoot = options.viewerRoot ?? (app.isPackaged
      ? resolve(process.resourcesPath, 'office-viewer')
      : resolve(appRoot, 'artifacts', 'office-viewer'))
    const cookieName = `xiaogui_office_${randomBytes(10).toString('hex')}`
    const sessionToken = randomBytes(48).toString('base64url')
    const persistenceKey = options.persistenceKey
    if (persistenceKey && !/^[a-f0-9]{64}$/.test(persistenceKey)) {
      throw new Error('OFFICE_WORKTREE_PERSISTENCE_KEY_INVALID')
    }
    const persistenceRoot = options.persistenceRoot
      ?? process.env.XIAOGUI_OFFICE_WORKTREE_ROOT
      ?? join(app.getPath('userData'), 'xiaogui', 'office-surface', 'v1', 'worktrees')
    const snapshotPath = persistenceKey ? join(persistenceRoot, `${persistenceKey}.json`) : undefined
    const child = utilityProcess.fork(entryPath, [], {
      stdio: 'pipe',
      env: {
        ...globalThis.process.env,
        XIAOGUI_OFFICE_GATEWAY_COOKIE_NAME: cookieName,
        XIAOGUI_OFFICE_GATEWAY_SESSION_TOKEN: sessionToken,
        XIAOGUI_OFFICE_VIEWER_ROOT: viewerRoot,
        ...(snapshotPath ? { XIAOGUI_OFFICE_SNAPSHOT_PATH: snapshotPath } : {}),
      },
    })

    const ready = await waitForReady(child, options.startupTimeoutMs ?? 15_000)
    try {
      await session.defaultSession.cookies.set({
        url: ready.origin,
        name: cookieName,
        value: sessionToken,
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      })
    } catch (error) {
      child.kill()
      throw error
    }

    let headSha256 = ready.headSha256
    try {
      const current = await readGatewaySnapshot(ready.origin, cookieName, sessionToken)
      if (options.initialSnapshot && Object.keys(current.snapshot).length === 0) {
        headSha256 = await writeGatewaySnapshot(
          ready.origin,
          cookieName,
          sessionToken,
          current.headSha256,
          options.initialSnapshot,
        )
      } else {
        headSha256 = current.headSha256
      }
    } catch (error) {
      await session.defaultSession.cookies.remove(ready.origin, cookieName).catch(() => {})
      child.kill()
      throw error
    }

    let closed = false
    const gatewaySession: OfficeGatewaySessionV1 = {
      origin: ready.origin,
      viewerUrl: `${ready.origin}/viewer/`,
      accessToken: sessionToken,
      headSha256,
      close: async () => {
        if (closed) return
        closed = true
        this.sessions.delete(gatewaySession)
        await session.defaultSession.cookies.remove(ready.origin, cookieName).catch(() => {})
        await closeUtilityProcess(child)
      },
    }
    this.sessions.add(gatewaySession)
    return gatewaySession
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions].map((gatewaySession) => gatewaySession.close()))
  }
}

async function readGatewaySnapshot(
  origin: string,
  cookieName: string,
  sessionToken: string,
): Promise<{ headSha256: string; snapshot: OfficeSnapshotV1 }> {
  const response = await fetch(`${origin}/api/v1/snapshot`, {
    headers: { Cookie: `${cookieName}=${encodeURIComponent(sessionToken)}` },
  })
  if (!response.ok) throw new Error(`OFFICE_GATEWAY_INITIAL_READ_FAILED_${response.status}`)
  return response.json() as Promise<{ headSha256: string; snapshot: OfficeSnapshotV1 }>
}

async function writeGatewaySnapshot(
  origin: string,
  cookieName: string,
  sessionToken: string,
  expectedHeadSha256: string,
  snapshot: OfficeSnapshotV1,
): Promise<string> {
  const response = await fetch(`${origin}/api/v1/snapshot`, {
    method: 'PUT',
    headers: {
      Cookie: `${cookieName}=${encodeURIComponent(sessionToken)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedHeadSha256, snapshot }),
  })
  if (!response.ok) throw new Error(`OFFICE_GATEWAY_INITIAL_WRITE_FAILED_${response.status}`)
  const payload = await response.json() as { headSha256?: unknown }
  if (typeof payload.headSha256 !== 'string') throw new Error('OFFICE_GATEWAY_INITIAL_WRITE_INVALID')
  return payload.headSha256
}

interface ReadyMessageV1 {
  readonly type: typeof READY_TYPE
  readonly origin: string
  readonly headSha256: string
}

function waitForReady(process: UtilityProcess, timeoutMs: number): Promise<ReadyMessageV1> {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => finish(new Error('本机文档网关启动超时。')), timeoutMs)
    const onExit = (code: number) => finish(new Error(`本机文档网关提前退出（${code}）。`))
    const onMessage = (raw: unknown) => {
      if (!isReadyMessage(raw)) return
      finish(null, raw)
    }
    const finish = (error: Error | null, value?: ReadyMessageV1) => {
      clearTimeout(timer)
      process.off('exit', onExit)
      process.off('message', onMessage)
      if (error) {
        process.kill()
        rejectReady(error)
      } else {
        resolveReady(value!)
      }
    }
    process.on('exit', onExit)
    process.on('message', onMessage)
  })
}

function isReadyMessage(value: unknown): value is ReadyMessageV1 {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.type === READY_TYPE
    && typeof message.origin === 'string'
    && /^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)
    && typeof message.headSha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(message.headSha256)
}

async function closeUtilityProcess(process: UtilityProcess): Promise<void> {
  await new Promise<void>((resolveClose) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveClose()
    }
    const timer = setTimeout(() => {
      process.kill()
      done()
    }, 2_000)
    process.once('exit', done)
    try {
      process.postMessage({ type: CLOSE_TYPE })
    } catch {
      process.kill()
      done()
    }
  })
}

export const officeGatewaySupervisorV1 = new OfficeGatewaySupervisorV1()
