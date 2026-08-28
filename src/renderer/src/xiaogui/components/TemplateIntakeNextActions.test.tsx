import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUIStore } from '@renderer/stores/ui-store'
import type { TimelineDisplayItem } from '@renderer/features/timeline/timeline-display-items'

import {
  hasConfirmedTemplateIntake,
  hasReviewableTemplateIntake,
  TemplateIntakeNextActions,
  TemplateIntakeStartReviewAction,
} from './TemplateIntakeNextActions'

let uiSnapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  uiSnapshot = useUIStore.getState()
  useUIStore.setState({ composerPrefill: null })
})

afterEach(() => {
  cleanup()
  useUIStore.setState(uiSnapshot, true)
})

describe('TemplateIntakeNextActions', () => {
  it('只识别已完成且已确认的模板整理工具', () => {
    const confirmedBlock = {
      kind: 'single' as const,
      item: {
        id: 'tool-1',
        type: 'tool-call',
        toolName: 'xiaogui_work_docx_template_intake',
        toolPhase: 'end',
        toolDetails: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED' },
      },
    } satisfies Extract<TimelineDisplayItem, { kind: 'single' }>
    const blocks: TimelineDisplayItem[] = [confirmedBlock]

    expect(hasConfirmedTemplateIntake(blocks)).toBe(true)
    expect(
      hasConfirmedTemplateIntake([
        {
          ...confirmedBlock,
          item: {
            ...confirmedBlock.item,
            toolDetails: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED' },
          },
        },
      ]),
    ).toBe(false)
  })

  it('识别可开始复核的候选报告，但不把已确认恢复记录当成待复核', () => {
    const block = (toolDetails: Record<string, unknown>) => ({
      kind: 'single' as const,
      item: {
        id: `tool-${String(toolDetails.kind)}`,
        type: 'tool-call' as const,
        toolName: 'xiaogui_work_docx_template_intake',
        toolPhase: 'end' as const,
        toolDetails,
      },
    })

    expect(
      hasReviewableTemplateIntake([
        block({ kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY' }),
      ]),
    ).toBe(true)
    expect(
      hasReviewableTemplateIntake([
        block({ kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED' }),
      ]),
    ).toBe(true)
    expect(
      hasReviewableTemplateIntake([
        block({ kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED' }),
      ]),
    ).toBe(true)
    expect(
      hasReviewableTemplateIntake([
        block({
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED',
          decision: { decisionVersion: 1 },
        }),
      ]),
    ).toBe(false)
  })

  it('开始复核按钮只填写现有输入框，不自动发送', async () => {
    const user = userEvent.setup()
    render(<TemplateIntakeStartReviewAction />)

    await user.click(screen.getByRole('button', { name: '填写提示词：开始复核' }))
    expect(useUIStore.getState().composerPrefill).toBe('复核')
  })

  it('两个按钮只填写现有输入框提示词，不直接发送', async () => {
    const user = userEvent.setup()
    render(<TemplateIntakeNextActions />)

    await user.click(screen.getByRole('button', { name: '填写提示词：生成正式模板' }))
    expect(useUIStore.getState().composerPrefill).toBe('生成正式模板')

    await user.click(screen.getByRole('button', { name: '填写模板修改要求' }))
    expect(useUIStore.getState().composerPrefill).toBe('需要修改：')
  })
})
