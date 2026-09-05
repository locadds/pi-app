import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerSlot } from '../worker-manager-types'
import { readCurrentWorkerExecutionIdentityDigestV1 } from '../worker-execution-identity'
import type { WorkerTransport } from '../worker-transport'

vi.mock('../config-store', () => ({
  configStore: { get: vi.fn(() => undefined) },
}))
vi.mock('../worker-execution-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-execution-identity')>()
  return {
    ...actual,
    readCurrentWorkerExecutionIdentityDigestV1: vi.fn((cwd: string) => {
      const value = Buffer.from(cwd, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64)
      return `sha256:${value}`
    }),
  }
})

import {
  attachWorkerHandlers,
  dismissExtensionUiRequestsForSlot,
  extensionUiDialogSource,
} from '../worker-manager-pool'
import { WorkerManager } from '../worker-manager'
import { createTrustedWorkerCapabilityFixtureV1 } from './trusted-worker-capability-fixture'

const trusted = createTrustedWorkerCapabilityFixtureV1()

function makeTransport(): WorkerTransport & { emitMessage: (message: Record<string, unknown>) => void } {
  const listeners: Array<(message: Record<string, unknown>) => void> = []
  return {
    kind: 'utilityProcess',
    postMessage: vi.fn(),
    onMessage: (listener) => listeners.push(listener as (message: Record<string, unknown>) => void),
    onExit: () => {},
    onStdout: () => {},
    onStderr: () => {},
    kill: () => {},
    emitMessage: (message) => listeners.forEach((listener) => listener(message)),
  }
}

function slot(poolKey: string, worker: WorkerTransport = makeTransport()): WorkerSlot {
  const projectBinding = trusted.issueProject('/w')
  const project = trusted.authority.inspectProject(projectBinding)
  return {
    poolKey,
    cwd: '/w',
    runtime: { mode: 'host', distro: null },
    executionIdentityDigest: readCurrentWorkerExecutionIdentityDigestV1('/w', {
      mode: 'host',
      distro: null,
    }),
    projectIdentityDigest: project.projectIdentityDigest,
    projectBinding,
    sessionBinding: trusted.issueSession('/w', poolKey),
    slotBindingDigest: `slot:${poolKey}`,
    sessionFile: poolKey,
    sessionId: `session:${poolKey}`,
    worker,
    pendingRequests: new Map(),
    requestCounter: 0,
    initResolver: null,
    initRejecter: null,
    initPromise: null,
    agentTurnActive: true,
    lastIdleAt: Date.now(),
    lastForegroundAt: Date.now(),
    sdkFallback: false,
    autoRestartEnabled: true,
    stopping: false,
  }
}

function managerWithSlots(foreground: WorkerSlot, ...rest: WorkerSlot[]): WorkerManager {
  const manager = new WorkerManager(undefined, trusted.authority)
  const internals = manager as unknown as { pool: Map<string, WorkerSlot>; foregroundPoolKey: string | null }
  internals.pool.set(foreground.poolKey, foreground)
  for (const row of rest) internals.pool.set(row.poolKey, row)
  internals.foregroundPoolKey = foreground.poolKey
  return manager
}

describe('extension UI source routing', () => {
  beforeEach(() => extensionUiDialogSource.clear())

  it('should_route_responses_to_the_dialog_origin', () => {
    const foreground = slot('/s/foreground')
    const background = slot('/s/background')
    extensionUiDialogSource.set('dialog-b', background)

    managerWithSlots(foreground, background).respondExtensionUI({ id: 'dialog-b', confirmed: true })

    expect(background.worker.postMessage).toHaveBeenCalledWith({
      type: 'extension-ui-response',
      response: { id: 'dialog-b', confirmed: true },
    })
    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
  })

  it('resolves a permission window for an exact live foreground or background Worker source', () => {
    const foreground = slot('/s/foreground')
    const background = slot('/s/background')
    const manager = managerWithSlots(foreground, background)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    ;(manager as unknown as { mainWindow: typeof mainWindow }).mainWindow = mainWindow

    expect(manager.resolveHostToolRequestWindow({
      fromCwd: foreground.cwd,
      fromPoolKey: foreground.poolKey,
      sessionFile: foreground.sessionFile!,
      sourceSessionId: foreground.sessionId!,
    })).toBe(mainWindow)
    expect(manager.resolveHostToolRequestWindow({
      fromCwd: background.cwd,
      fromPoolKey: background.poolKey,
      sessionFile: background.sessionFile!,
      sourceSessionId: background.sessionId!,
    })).toBe(mainWindow)
    expect(manager.resolveHostToolRequestWindow({
      fromCwd: foreground.cwd,
      fromPoolKey: foreground.poolKey,
      sessionFile: foreground.sessionFile!,
      sourceSessionId: 'wrong-session',
    })).toBeUndefined()
  })

  it('should_drop_stale_sources_instead_of_falling_back_to_foreground', () => {
    const foreground = slot('/s/foreground')
    extensionUiDialogSource.set('stale-dialog', slot('/s/missing'))

    managerWithSlots(foreground).respondExtensionUI({ id: 'stale-dialog', confirmed: true })

    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
  })

  it('should_cancel_the_dialog_origin', () => {
    const foreground = slot('/s/foreground')
    const background = slot('/s/background')
    extensionUiDialogSource.set('dialog-b', background)

    managerWithSlots(foreground, background).cancelExtensionUI('dialog-b', 'session-reset')

    expect(background.worker.postMessage).toHaveBeenCalledWith({
      type: 'extension-ui-cancel',
      cancel: { id: 'dialog-b', reason: 'session-reset' },
    })
    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
  })

  it('should_dismiss_only_dialogs_owned_by_the_emitting_slot', () => {
    const background = slot('/s/background')
    const send = vi.fn()
    extensionUiDialogSource.set('dialog-a', slot('/s/foreground'))
    extensionUiDialogSource.set('dialog-b', background)

    dismissExtensionUiRequestsForSlot(background, send, 'compaction')

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'extension-ui-dismiss',
      id: 'dialog-b',
      reason: 'compaction',
    })
    expect(extensionUiDialogSource.has('dialog-a')).toBe(true)
    expect(extensionUiDialogSource.has('dialog-b')).toBe(false)
  })

  it('should_dismiss_dialogs_when_the_source_worker_exits', () => {
    const transport = makeTransport()
    const exitListeners: Array<(code: number) => void> = []
    transport.onExit = (listener) => exitListeners.push(listener)
    const source = slot('/s/source', transport)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    attachWorkerHandlers(source, transport, {
      mainWindow: mainWindow as never,
      getForegroundPoolKey: () => source.poolKey,
      onAppEvent: vi.fn(),
      onSlotExit: vi.fn(),
    })
    extensionUiDialogSource.set('dialog-source', source)

    exitListeners.forEach((listener) => listener(1))

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('ipc:extension-ui-dismiss', {
      type: 'extension-ui-dismiss',
      id: 'dialog-source',
      reason: 'worker-stopped',
    })
    expect(extensionUiDialogSource.has('dialog-source')).toBe(false)
  })

  it('should_cancel_background_dialogs_and_only_forward_foreground_dialogs', () => {
    const foregroundTransport = makeTransport()
    const foreground = slot('/s/foreground', foregroundTransport)
    const backgroundTransport = makeTransport()
    const background = slot('/s/background', backgroundTransport)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const options = {
      mainWindow: mainWindow as never,
      getForegroundPoolKey: () => foreground.poolKey,
      onAppEvent: vi.fn(),
      onSlotExit: vi.fn(),
    }
    attachWorkerHandlers(foreground, foregroundTransport, options)
    attachWorkerHandlers(background, backgroundTransport, options)

    backgroundTransport.emitMessage({
      type: 'extension-ui-request',
      request: { id: 'dialog-b', method: 'confirm', title: 'Confirm', message: 'Continue?' },
    })
    foregroundTransport.emitMessage({
      type: 'extension-ui-request',
      request: { id: 'dialog-a', method: 'confirm', title: 'Confirm', message: 'Continue?' },
    })

    expect(backgroundTransport.postMessage).toHaveBeenCalledWith({
      type: 'extension-ui-cancel',
      cancel: { id: 'dialog-b', reason: 'background-session' },
    })
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(extensionUiDialogSource.get('dialog-a')).toBe(foreground)
    expect(extensionUiDialogSource.has('dialog-b')).toBe(false)
  })

  it('should_replace_worker_claimed_direct_origin_before_forwarding', () => {
    const transport = makeTransport()
    const source = slot('/s/foreground', transport)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    attachWorkerHandlers(source, transport, {
      mainWindow: mainWindow as never,
      getForegroundPoolKey: () => source.poolKey,
      onAppEvent: vi.fn(),
      onSlotExit: vi.fn(),
    })

    transport.emitMessage({
      type: 'extension-ui-request',
      request: {
        id: 'xiaogui-direct-123e4567-e89b-42d3-a456-426614174000',
        method: 'custom',
        kind: 'coding_permission',
        origin: 'xiaogui-direct',
        payload: {},
      },
    })

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('ipc:extension-ui-request', expect.objectContaining({
      kind: 'coding_permission',
      origin: 'worker',
    }))
  })
})
