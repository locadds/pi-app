import { toast } from 'sonner'
import { onExtensionUIRequest, onExtensionUIDismiss } from '@renderer/lib/ipc-client'
import { useExtensionUIStore, type ExtensionUIPending } from '@renderer/stores/extension-ui-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { shouldShowExtensionNotify } from '@renderer/lib/extension-notify-policy'
import { signalDesktopAlert } from '@renderer/lib/desktop-alerts'
import type { AskQuestionPayload } from '@renderer/features/extension-ui/questionnaire-dialog'
import type { ImageReviewPayload } from '@renderer/features/extension-ui/image-review-dialog'
import type { TemplateIntakeReviewRequestV1 } from '@shared/xiaogui-work-docx-template-intake'
import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import type { TemplateReviewRequestV2, TemplateReviewRequestV3 } from '@shared/xiaogui-work-template-review'
import type { TemplateMaterializePreviewRequestV1 } from '@shared/xiaogui-work-docx-template-materialize'
import type { CodingPermissionPromptV1 } from '@shared/xiaogui-coding-extension-pack'
import type { DirectCodingPermissionPromptV2 } from '@shared/xiaogui-direct-coding'
import { traceAudioRenderer } from '@renderer/lib/audio-trace'
import { alertTrace } from '@renderer/lib/alert-trace'
import {
  linkExtensionDialogToToolRow,
  reconcileAllStaleInteractiveToolRows,
  reconcileStaleInteractiveToolRows,
} from '@renderer/lib/extension-ui-tool-sync'

let started = false
const seenDialogIds = new Set<string>()
const INTERACTIVE_TOOL_NAMES = new Set([
  'ask_user_question',
  'image_review',
  'template_intake_review',
  'template_materialize_preview',
])

function timelineToolName(method: string): string {
  if (method === 'template_intake_review') return 'xiaogui_work_docx_template_intake'
  if (method === 'template_materialize_preview') return 'xiaogui_work_docx_template_materialize'
  return method
}

function pruneSeenIds(): void {
  if (seenDialogIds.size > 120) seenDialogIds.clear()
}

const CODING_PERMISSION_SUMMARIES = Object.freeze({
  READ: 'Agent 请求读取本任务已批准范围内的文件。',
  WRITE: 'Agent 请求修改本任务已批准范围内的文件。',
  COMMAND: 'Agent 请求在当前任务工作树中运行命令。',
  DATA_EGRESS: 'Agent 请求将本任务数据发送到外部服务。',
} as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMainPermissionPrompt(value: unknown): value is CodingPermissionPromptV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  const operation = value.operation
  if (operation !== 'READ' && operation !== 'WRITE' && operation !== 'COMMAND' && operation !== 'DATA_EGRESS') {
    return false
  }
  const expectedKeys = new Set([
    'schemaVersion', 'operation', 'relativePaths', 'dataEgress', 'summary', 'choices',
    ...(operation === 'COMMAND' ? ['commandSummary'] : []),
    ...(operation === 'DATA_EGRESS' ? ['egressDestination'] : []),
  ])
  if (Object.keys(value).some((key) => !expectedKeys.has(key)) || Object.keys(value).length !== expectedKeys.size) {
    return false
  }
  if (
    value.summary !== CODING_PERMISSION_SUMMARIES[operation]
    || value.dataEgress !== (operation === 'DATA_EGRESS' ? 'REQUESTED' : 'NONE')
    || !Array.isArray(value.choices)
    || value.choices.length !== 3
    || value.choices[0] !== 'ALLOW_ONCE'
    || value.choices[1] !== 'ALLOW_TASK_RULE'
    || value.choices[2] !== 'DENY'
  ) return false

  if (!Array.isArray(value.relativePaths) || value.relativePaths.length === 0 || value.relativePaths.length > 256) {
    return false
  }
  const normalizedPaths: string[] = []
  for (const path of value.relativePaths) {
    if (
      typeof path !== 'string'
      || path.length > 512
      || path !== path.trim()
      || !path
      || path.includes('\\')
      || path.startsWith('/')
      || /^[a-z]:\//i.test(path)
      || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) return false
    normalizedPaths.push(path)
  }
  if (new Set(normalizedPaths).size !== normalizedPaths.length) return false
  if ([...normalizedPaths].sort().some((path, index) => path !== normalizedPaths[index])) return false

  const safeDisplayText = (text: unknown): text is string =>
    typeof text === 'string'
    && text.length > 0
    && text.length <= 256
    && text === text.trim()
    && !/[\u0000-\u001f\u007f]/.test(text)
  if (operation === 'COMMAND' && !safeDisplayText(value.commandSummary)) return false
  if (operation === 'DATA_EGRESS' && !safeDisplayText(value.egressDestination)) return false
  return true
}

function isDirectPermissionPrompt(value: unknown): value is DirectCodingPermissionPromptV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.subject !== 'DIRECT_SESSION') return false
  const operation = value.operation
  if (!['READ', 'EDIT', 'WRITE', 'BASH', 'DATA_EGRESS'].includes(String(operation))) return false
  if (!['CONFIRM_EACH', 'AUTO_APPROVE', 'FULL_AUTONOMY'].includes(String(value.mode))) return false
  const expected = new Set([
    'schemaVersion', 'subject', 'requestDigest', 'operation', 'mode', 'choices',
    ...(operation === 'READ' || operation === 'EDIT' || operation === 'WRITE' ? ['relativePath'] : []),
    ...(operation === 'BASH' ? ['commandPreview', 'warning'] : []),
    ...(operation === 'DATA_EGRESS' ? ['warning'] : []),
  ])
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) return false
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.requestDigest))) return false
  if (!Array.isArray(value.choices) || value.choices.length !== 2 || value.choices[0] !== 'ALLOW_ONCE' || value.choices[1] !== 'DENY') return false
  if (expected.has('relativePath')) {
    const path = value.relativePath
    if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\\') || /^[a-z]:/i.test(path) || path.startsWith('/')) return false
    if (path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) return false
  }
  const safeText = (text: unknown, max: number) => typeof text === 'string' && text.length > 0 && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text)
  if (expected.has('commandPreview') && !safeText(value.commandPreview, 240)) return false
  if (expected.has('warning') && !safeText(value.warning, 256)) return false
  return true
}

export function parseExtensionUIRequestV1(raw: Record<string, unknown>): ExtensionUIPending | null {
  const id = raw.id as string
  const method = raw.method as string
  if (method === 'custom' && raw.kind === 'ask_user_question') {
    return { id, method: 'ask_user_question', questions: (raw.questions as AskQuestionPayload[]) || [] }
  }
  if (method === 'custom' && raw.kind === 'image_review') {
    return {
      id,
      method: 'image_review',
      payload: {
        image: (raw.image as string) || '',
        title: (raw.title as string) || '图片审查',
        question: (raw.question as string) || '这张图片是否可用？',
        context: raw.context as string | undefined,
        options: (raw.options as string[]) || ['通过', '需要修改', '重做', '取消'],
        allowFeedback: raw.allowFeedback !== false,
      },
    }
  }
  if (method === 'custom' && raw.kind === 'template_intake_review') {
    const payload = (raw.payload ?? raw) as unknown as
      | TemplateIntakeReviewRequestV1
      | TemplateDraftReviewRequestV2
      | TemplateReviewRequestV2
      | TemplateReviewRequestV3
    const validV1 = 'report' in payload && !!payload.report && Array.isArray(payload.draftDecisions)
    const validV2 =
      'reviewVersion' in payload &&
      payload.reviewVersion === 2 &&
      'document' in payload &&
      Array.isArray(payload.targets) &&
      Array.isArray(payload.draftActions)
    const validV3 =
      'reviewVersion' in payload &&
      payload.reviewVersion === 3 &&
      'document' in payload &&
      Array.isArray(payload.targets) &&
      Array.isArray(payload.draftActions)
    const validDraftV2 =
      'reviewVersion' in payload &&
      payload.reviewVersion === 4 &&
      'fieldGraph' in payload &&
      'advancedReview' in payload &&
      Array.isArray(payload.targetBindings)
    if (!validV1 && !validV2 && !validV3 && !validDraftV2) return null
    return {
      id,
      method: 'template_intake_review',
      payload,
      ...(raw.origin === 'xiaogui-direct' ? { origin: 'DIRECT' as const } : {}),
    }
  }
  if (method === 'custom' && raw.kind === 'template_materialize_preview') {
    const payload = raw.payload as TemplateMaterializePreviewRequestV1 | undefined
    if (
      !payload ||
      payload.previewVersion !== 1 ||
      !payload.document ||
      !payload.plan ||
      payload.plan.previewSha256 !== payload.document.source.sha256
    ) return null
    return { id, method: 'template_materialize_preview', payload }
  }
  if (method === 'custom' && raw.kind === 'coding_permission') {
    if (
      raw.origin !== 'xiaogui-direct'
      || typeof id !== 'string'
      || !/^xiaogui-direct-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || (!isMainPermissionPrompt(raw.payload) && !isDirectPermissionPrompt(raw.payload))
    ) return null
    const prompt = raw.payload
    return { id, method: 'coding_permission', prompt }
  }
  if (method === 'select') {
    return { id, method: 'select', title: raw.title as string, options: (raw.options as string[]) || [] }
  }
  if (method === 'confirm') {
    return { id, method: 'confirm', title: raw.title as string, message: raw.message as string }
  }
  if (method === 'input') {
    return {
      id,
      method: 'input',
      title: raw.title as string,
      placeholder: raw.placeholder as string | undefined,
    }
  }
  return null
}

export function clearExtensionDialogDedupe(): void {
  seenDialogIds.clear()
}

/** Worker 侧对话框超时/中止或 compaction 开始时，清理 Renderer 悬挂状态 */
export function dismissExtensionDialogState(id?: string): void {
  const st = useExtensionUIStore.getState()
  const activeId = st.activePending?.id
  const suspendedId = st.suspended?.requestId
  const queued = id ? st.queuedPending.some((entry) => entry.id === id) : false
  if (id && activeId !== id && suspendedId !== id && !queued) return
  if (id) seenDialogIds.delete(id)
  if (id) st.dismissById(id)
  else st.clearAfterRespond()
}

/** 只注册一次 IPC 监听，避免 StrictMode 双挂载导致重复 toast / 双提示音 */
export function ensureExtensionUIChannel(): void {
  if (started) return
  started = true

  onExtensionUIDismiss((payload) => {
    if (payload.type === 'extension-ui-dismiss-all') {
      seenDialogIds.clear()
      useExtensionUIStore.setState({ activePending: null, queuedPending: [], suspended: null })
      reconcileAllStaleInteractiveToolRows()
      return
    }
    if (payload.type === 'extension-ui-dismiss' && payload.id) {
      dismissExtensionDialogState(payload.id)
      reconcileStaleInteractiveToolRows(payload.id)
    }
  })

  onExtensionUIRequest((raw) => {
    const req = raw as Record<string, unknown>
    const method = req.method as string

    if (method === 'notify') {
      const t = (req.notifyType as string) || 'info'
      const msg = req.message as string
      traceAudioRenderer('extension-ui.notify', { notifyType: t, msg: msg?.slice(0, 120) })
      const show = shouldShowExtensionNotify(msg, t)
      alertTrace('extension notify', { notifyType: t, show, msg: msg?.slice(0, 120) })
      if (!show) return
      const running = useUIStore.getState().runState.status === 'running'
      if (!running && t !== 'error') {
        alertTrace('skip notify toast (not running)', { notifyType: t })
        return
      }
      alertTrace('sonner toast（Windows 常伴系统提示音，≠ 设置里的「提示音」）', { notifyType: t })
      traceAudioRenderer('extension-ui.toast', { notifyType: t, msg: msg?.slice(0, 120) })
      if (t === 'error') toast.error(msg)
      else if (t === 'warning') toast.warning(msg)
      else toast.info(msg)
      return
    }

    const p = parseExtensionUIRequestV1(req)
    if (!p) return

    // Dialog requests (select/confirm/input/custom) must always be shown, even when
    // the agent is not running — pi-rewind and other extensions call ui.select()/confirm()
    // during session_before_tree / session_before_fork which happen outside agent turns.
    if (seenDialogIds.has(p.id)) return
    seenDialogIds.add(p.id)
    pruneSeenIds()

    traceAudioRenderer('extension-ui.dialog', { method: p.method, id: p.id })
    useExtensionUIStore.getState().setActivePending(p)
    if (INTERACTIVE_TOOL_NAMES.has(p.method)) {
      linkExtensionDialogToToolRow(p.id, timelineToolName(p.method))
    }

    const body =
      p.method === 'image_review'
        ? p.payload.title || '图片审查'
        : p.method === 'template_intake_review'
          ? '模板候选复核'
          : p.method === 'template_materialize_preview'
            ? '修改后模板预览'
          : p.method === 'coding_permission'
            ? 'Coding 权限确认'
          : p.method === 'ask_user_question'
          ? '扩展问答'
          : p.method === 'confirm' || p.method === 'select' || p.method === 'input'
            ? p.title || '需要你的操作'
            : '需要你的操作'
    // Desktop alert only when running (idle dialog doesn't need system notification)
    if (useUIStore.getState().runState.status === 'running') {
      void signalDesktopAlert('extension_ui', {
        title: '小规 Agent · 等待操作',
        body,
      })
    }
  })
}
