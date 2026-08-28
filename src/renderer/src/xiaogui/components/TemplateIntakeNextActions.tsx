import { focusComposerInput } from '@renderer/lib/composer-line-ref'
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

function useFillComposer() {
  const setComposerPrefill = useUIStore((state) => state.setComposerPrefill)
  return (prompt: string) => {
    setComposerPrefill(prompt)
    focusComposerInput()
  }
}

export function TemplateIntakeStartReviewAction() {
  const fillComposer = useFillComposer()

  return (
    <div
      className="timeline-message-row timeline-prose-row flex flex-wrap gap-2 pt-1"
      role="group"
      aria-label="模板整理复核"
    >
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => fillComposer('复核')}
        aria-label="填写提示词：开始复核"
      >
        开始复核
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
