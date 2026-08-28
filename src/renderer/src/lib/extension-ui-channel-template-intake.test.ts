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

describe('template_materialize_preview custom kind 接入', () => {
  it('只接受预览摘要与页面文档摘要一致的内置预览', () => {
    ensureExtensionUIChannel()
    const previewSha256 = 'b'.repeat(64)
    const payload = {
      previewVersion: 1,
      suggestedTemplateName: '施工方案模板',
      plan: {
        materializeVersion: 1,
        source: { displayName: '施工方案.docx', sha256: 'a'.repeat(64), byteLength: 10 },
        previewSha256,
        variables: [],
        repeatBlocks: [],
        conditionalBlocks: [],
        excludedCandidateCount: 0,
        removedMediaCount: 0,
        retainedHighRiskCount: 0,
        warnings: [],
        requiresSecondConfirmation: true,
        originalSourceUnchanged: true,
        advancedGenerationRequired: false,
        reportSummary: { reportId: 'report-1', fileDisplayName: '施工方案.docx', fileSha256: 'a'.repeat(64), candidateCount: 0, warningCount: 0 },
      },
      document: {
        reviewVersion: 2,
        reviewId: 'preview-1',
        status: 'PREVIEWING',
        source: { displayName: '施工方案-模板.docx', sha256: previewSha256, byteLength: 10, inputFormat: 'DOCX' },
        render: { mode: 'PDF', pageCount: 1, pages: [], warnings: [] },
        targetCount: 0,
        pendingTargetCount: 0,
        resolvedTargetCount: 0,
        unmappedTargetCount: 0,
        requiresHumanConfirmation: true,
        sourceReadOnly: true,
        createdAt: '2026-08-28T10:00:00+08:00',
        updatedAt: '2026-08-28T10:00:00+08:00',
      },
    }
    requestHandler.fn?.({ id: 'tm-1', method: 'custom', kind: 'template_materialize_preview', payload })
    expect(useExtensionUIStore.getState().activePending).toEqual({
      id: 'tm-1',
      method: 'template_materialize_preview',
      payload,
    })

    useExtensionUIStore.setState({ activePending: null })
    requestHandler.fn?.({
      id: 'tm-2',
      method: 'custom',
      kind: 'template_materialize_preview',
      payload: { ...payload, document: { ...payload.document, source: { ...payload.document.source, sha256: 'c'.repeat(64) } } },
    })
    expect(useExtensionUIStore.getState().activePending).toBeNull()
  })
})
