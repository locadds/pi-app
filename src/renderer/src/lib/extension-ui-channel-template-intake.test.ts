import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureExtensionUIChannel } from './extension-ui-channel'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'

const { requestHandler } = vi.hoisted(() => ({
  requestHandler: { fn: null as null | ((raw: unknown) => void) },
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn(async () => ({})) },
  onExtensionUIRequest: vi.fn((cb: (raw: unknown) => void) => {
    requestHandler.fn = cb
  }),
  onExtensionUIDismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), message: vi.fn() } }))
vi.mock('@renderer/lib/desktop-alerts', () => ({ signalDesktopAlert: vi.fn() }))
vi.mock('@renderer/lib/audio-trace', () => ({ traceAudioRenderer: vi.fn() }))
vi.mock('@renderer/lib/alert-trace', () => ({ alertTrace: vi.fn() }))
vi.mock('@renderer/lib/extension-ui-tool-sync', () => ({
  linkExtensionDialogToToolRow: vi.fn(),
  reconcileAllStaleInteractiveToolRows: vi.fn(),
  reconcileStaleInteractiveToolRows: vi.fn(),
}))
vi.mock('@renderer/stores/ui-store', () => ({
  useUIStore: {
    getState: () => ({ timelineItems: [], runState: { status: 'idle' } }),
  },
}))

const minimalReport = {
  reportVersion: 1,
  reportId: 'report-1',
  status: 'REVIEWING',
  file: { displayName: '模板.docx', sha256: 'sha', byteLength: 1 },
  candidates: [],
}

beforeEach(() => {
  useExtensionUIStore.setState({ activePending: null, suspended: null })
})

describe('template_intake_review custom kind 接入', () => {
  it('把 custom kind=template_intake_review 映射为复核卡 pending', () => {
    ensureExtensionUIChannel()
    const payload = { report: minimalReport, draftDecisions: [], pageSize: 20 }
    requestHandler.fn?.({ id: 'ti-1', method: 'custom', kind: 'template_intake_review', payload })

    const pending = useExtensionUIStore.getState().activePending
    expect(pending).toEqual({ id: 'ti-1', method: 'template_intake_review', payload })
  })

  it('payload 缺 report 或 draftDecisions 时不弹出', () => {
    ensureExtensionUIChannel()
    requestHandler.fn?.({ id: 'ti-2', method: 'custom', kind: 'template_intake_review', payload: {} })
    requestHandler.fn?.({ id: 'ti-3', method: 'custom', kind: 'template_intake_review' })

    expect(useExtensionUIStore.getState().activePending).toBeNull()
  })
})
