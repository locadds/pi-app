import { useState } from 'react'
import { toast } from 'sonner'

import { focusComposerInput } from '@renderer/lib/composer-line-ref'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'
import { useUIStore } from '@renderer/stores/ui-store'
import type { TimelineDisplayItem, TimelineRawItem } from '@renderer/features/timeline/timeline-display-items'

const TEMPLATE_INTAKE_TOOL_NAME = 'xiaogui_work_docx_template_intake'
const TEMPLATE_INTAKE_CONFIRMED_KIND = 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED'
const TEMPLATE_INTAKE_REVIEWABLE_KINDS = new Set([
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_CANCELLED',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isConfirmedTemplateIntakeTool(item: TimelineRawItem): boolean {
  if (
    item.type !== 'tool-call' ||
    item.toolName !== TEMPLATE_INTAKE_TOOL_NAME ||
    item.toolPhase !== 'end' ||
    item.isError === true
  ) {
    return false
  }

  return isRecord(item.toolDetails) && item.toolDetails.kind === TEMPLATE_INTAKE_CONFIRMED_KIND
}

function isReviewableTemplateIntakeTool(item: TimelineRawItem): boolean {
  if (
    item.type !== 'tool-call' ||
    item.toolName !== TEMPLATE_INTAKE_TOOL_NAME ||
    item.toolPhase !== 'end' ||
    item.isError === true ||
    !isRecord(item.toolDetails)
  ) {
    return false
  }

  if (TEMPLATE_INTAKE_REVIEWABLE_KINDS.has(String(item.toolDetails.kind))) return true

  return (
    item.toolDetails.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED' &&
    item.toolDetails.decision == null
  )
}

export interface ReviewableTemplateIntakeTarget {
  reportId: string
  resumable?: boolean
}

function reviewTargetFromTool(item: TimelineRawItem): ReviewableTemplateIntakeTarget | null {
  if (!isReviewableTemplateIntakeTool(item) || !isRecord(item.toolDetails)) return null
  const report = item.toolDetails.report
  if (!isRecord(report) || typeof report.reportId !== 'string' || !report.reportId.trim()) {
    return null
  }
  return {
    reportId: report.reportId,
    resumable: item.toolDetails.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
  }
}

/** 仅在当前轮确实保存了人工确认记录后，提供下一步提示词。 */
export function hasConfirmedTemplateIntake(blocks: readonly TimelineDisplayItem[]): boolean {
  return blocks.some((block) =>
    block.kind === 'tool-group'
      ? block.tools.some(isConfirmedTemplateIntakeTool)
      : isConfirmedTemplateIntakeTool(block.item),
  )
}

/** 候选报告已就绪但尚未形成确认记录时，提供进入复核的提示词。 */
export function hasReviewableTemplateIntake(blocks: readonly TimelineDisplayItem[]): boolean {
  return blocks.some((block) =>
    block.kind === 'tool-group'
      ? block.tools.some(isReviewableTemplateIntakeTool)
      : isReviewableTemplateIntakeTool(block.item),
  )
}

export function findReviewableTemplateIntake(
  blocks: readonly TimelineDisplayItem[],
): ReviewableTemplateIntakeTarget | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.kind === 'tool-group') {
      for (let toolIndex = block.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const target = reviewTargetFromTool(block.tools[toolIndex])
        if (target) return target
      }
      continue
    }
    const target = reviewTargetFromTool(block.item)
    if (target) return target
  }
  return null
}

function useFillComposer() {
  const setComposerPrefill = useUIStore((state) => state.setComposerPrefill)
  return (prompt: string) => {
    setComposerPrefill(prompt)
    focusComposerInput()
  }
}

function isSuspendedDirectReview(reportId: string): boolean {
  const suspended = useExtensionUIStore.getState().suspended
  if (
    suspended?.pending.method !== 'template_intake_review' ||
    suspended.pending.origin !== 'DIRECT' ||
    !('reviewVersion' in suspended.pending.payload) ||
    ![2, 3, 4].includes(suspended.pending.payload.reviewVersion)
  ) {
    return false
  }
  return suspended.pending.payload.document.reviewId === reportId
}

export function TemplateIntakeStartReviewAction({
  target,
}: {
  target: ReviewableTemplateIntakeTarget
}) {
  const sessionFile = useUIStore((state) => state.historySessionFile)
  const suspended = useExtensionUIStore((state) => state.suspended)
  const resumeSuspended = useExtensionUIStore((state) => state.resumeSuspended)
  const [state, setState] = useState<'IDLE' | 'OPENING' | 'RESUMABLE' | 'CONFIRMED'>('IDLE')
  const hasSuspendedReview = isSuspendedDirectReview(target.reportId) && suspended != null
  const shouldContinue = hasSuspendedReview || target.resumable === true || state === 'RESUMABLE'

  if (state === 'CONFIRMED') return <TemplateIntakeNextActions />

  const openReview = async () => {
    if (hasSuspendedReview) {
      resumeSuspended()
      return
    }
    if (state === 'OPENING') return
    if (!sessionFile) {
      toast.error('当前会话尚未准备好，请重新打开后再试')
      return
    }

    setState('OPENING')
    try {
      // Re-assert the visible session before opening a local-only review. A cached
      // history view can be painted before the fire-and-forget visibility report
      // reaches main, but the review must still bind to exactly what the user sees.
      await ipcClient.invoke('session.setVisible', { sessionFile })
      const result = await ipcClient.invoke('xiaogui.work.template-intake.review.open', {
        sessionFile,
        reportId: target.reportId,
      })
      if (!result?.ok) {
        toast.error(result?.message || '暂时无法打开文档复核')
        setState(shouldContinue ? 'RESUMABLE' : 'IDLE')
        return
      }
      setState(result.state === 'CONFIRMED' ? 'CONFIRMED' : 'RESUMABLE')
    } catch {
      toast.error('暂时无法打开文档复核，请稍后重试')
      setState(shouldContinue ? 'RESUMABLE' : 'IDLE')
    }
  }

  return (
    <div
      className="timeline-message-row timeline-prose-row flex flex-wrap gap-2 pt-1"
      role="group"
      aria-label="模板整理复核"
    >
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => void openReview()}
        disabled={state === 'OPENING' && !hasSuspendedReview}
        aria-label={shouldContinue ? '继续文档复核' : '直接打开文档复核'}
      >
        {hasSuspendedReview
          ? '继续复核'
          : state === 'OPENING'
            ? '正在打开复核…'
            : shouldContinue
              ? '继续复核'
              : '开始复核'}
      </button>
    </div>
  )
}

export function TemplateIntakeNextActions() {
  const fillComposer = useFillComposer()

  return (
    <div
      className="timeline-message-row timeline-prose-row flex flex-wrap gap-2 pt-1"
      role="group"
      aria-label="模板整理下一步"
    >
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => fillComposer('生成正式模板')}
        aria-label="填写提示词：生成正式模板"
      >
        生成正式模板
      </button>
      <button
        type="button"
        className="rounded-md border border-border/60 bg-transparent px-3 py-1.5 text-[12px] font-medium text-foreground-secondary transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => fillComposer('需要修改：')}
        aria-label="填写模板修改要求"
      >
        需要修改
      </button>
    </div>
  )
}
