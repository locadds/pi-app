import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import type { AskQuestionPayload } from '@renderer/features/extension-ui/questionnaire-dialog'
import type { ImageReviewPayload } from '@renderer/features/extension-ui/image-review-dialog'
import type { TemplateIntakeReviewRequestV1 } from '@shared/xiaogui-work-docx-template-intake'
import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import type { TemplateReviewRequestV2, TemplateReviewRequestV3 } from '@shared/xiaogui-work-template-review'
import type { TemplateMaterializePreviewRequestV1 } from '@shared/xiaogui-work-docx-template-materialize'
import type { CodingPermissionPromptV1 } from '@shared/xiaogui-coding-extension-pack'

export type ExtensionUIPending =
  | { id: string; method: 'ask_user_question'; questions: AskQuestionPayload[] }
  | { id: string; method: 'select'; title: string; options: string[] }
  | { id: string; method: 'confirm'; title: string; message: string }
  | { id: string; method: 'input'; title: string; placeholder?: string }
  | { id: string; method: 'image_review'; payload: ImageReviewPayload }
  | {
      id: string
      method: 'template_intake_review'
      payload: TemplateIntakeReviewRequestV1 | TemplateDraftReviewRequestV2 | TemplateReviewRequestV2 | TemplateReviewRequestV3
      origin?: 'DIRECT'
    }
  | { id: string; method: 'coding_permission'; prompt: CodingPermissionPromptV1 }
  | {
      id: string
      method: 'template_materialize_preview'
      payload: TemplateMaterializePreviewRequestV1
    }

export type ExtensionUISuspended = {
  requestId: string
  pending: ExtensionUIPending
  toolCallId?: string
  toolName?: string
  timelineItemId?: string
  suspendedAt: number
}

type ExtensionUIState = {
  activePending: ExtensionUIPending | null
  queuedPending: ExtensionUIPending[]
  suspended: ExtensionUISuspended | null
  setActivePending: (p: ExtensionUIPending | null) => void
  suspendActive: (meta: { toolCallId?: string; toolName?: string; timelineItemId?: string }) => void
  resumeSuspended: () => void
  clearAfterRespond: () => void
  dismissById: (id: string) => void
  resetForSessionContext: () => void
  pruneStaleSuspension: () => void
}

/** 仅全屏弹窗打开时阻塞（挂起后已关弹窗，可发消息、可切会话） */
function hasOpenExtensionDialog(): boolean {
  return useExtensionUIStore.getState().activePending != null
}

function pruneStaleSuspension(): void {
  const { activePending, suspended } = useExtensionUIStore.getState()
  if (activePending) return
  if (!suspended) return
  const items = useUIStore.getState().timelineItems
  const tid = suspended.timelineItemId
  if (suspended.pending.method === 'template_intake_review' && suspended.pending.origin === 'DIRECT') {
    return
  }
  if (!tid) {
    useExtensionUIStore.getState().dismissById(suspended.requestId)
    return
  }
  const row = items.find((i) => i.id === tid)
  if (!row?.extensionUiSuspended) {
    useExtensionUIStore.getState().dismissById(suspended.requestId)
  }
}

function cancelPendingDialogs(reason: string): void {
  const { activePending, queuedPending, suspended } = useExtensionUIStore.getState()
  const ids = new Set([
    activePending?.id,
    suspended?.requestId,
    ...queuedPending.map((entry) => entry.id),
  ].filter((id): id is string => !!id))
  for (const id of ids) {
    void ipcClient.invoke('extension.cancelUI', { id, reason }).catch(() => {})
  }
}

export const useExtensionUIStore = create<ExtensionUIState>((set, get) => ({
  activePending: null,
  queuedPending: [],
  suspended: null,

  setActivePending: (p) => {
    if (!p) {
      set({ activePending: null })
      return
    }
    const state = get()
    if (
      state.activePending?.id === p.id ||
      state.suspended?.requestId === p.id ||
      state.queuedPending.some((entry) => entry.id === p.id)
    ) return
    if (state.activePending || state.suspended) {
      set({ queuedPending: [...state.queuedPending, p] })
      return
    }
    set({ activePending: p })
  },

  suspendActive: (meta) => {
    const active = get().activePending
    if (!active) return
    set({
      activePending: null,
      suspended: {
        requestId: active.id,
        pending: active,
        toolCallId: meta.toolCallId,
        toolName: meta.toolName,
        timelineItemId: meta.timelineItemId,
        suspendedAt: Date.now(),
      },
    })
  },

  resumeSuspended: () => {
    const s = get().suspended
    if (!s) return
    set({ activePending: s.pending, suspended: null })
  },

  clearAfterRespond: () => set((state) => ({
    activePending: state.queuedPending[0] ?? null,
    queuedPending: state.queuedPending.slice(1),
    suspended: null,
  })),

  dismissById: (id) => set((state) => {
    const activeWasDismissed = state.activePending?.id === id
    const suspendedWasDismissed = state.suspended?.requestId === id
    const queuedPending = state.queuedPending.filter((entry) => entry.id !== id)
    if (!activeWasDismissed && !suspendedWasDismissed) return { queuedPending }
    return {
      activePending: queuedPending[0] ?? null,
      queuedPending: queuedPending.slice(1),
      suspended: null,
    }
  }),

  pruneStaleSuspension: () => pruneStaleSuspension(),

  resetForSessionContext: () => {
    cancelPendingDialogs('session-reset')
    set({ activePending: null, queuedPending: [], suspended: null })
    void import('@renderer/lib/extension-ui-channel').then((m) => m.clearExtensionDialogDedupe())
  },
}))

export function extensionUiBlocksComposer(): boolean {
  pruneStaleSuspension()
  if (!hasOpenExtensionDialog()) return false
  const running = useUIStore.getState().runState.status === 'running'
  // 无弹窗宿主可渲染的 pending（如 Worker 已超时 resolve）不应阻塞
  const p = useExtensionUIStore.getState().activePending
  if (!p) return false
  if (!running) return false
  return true
}

