import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUIStore } from '@renderer/stores/ui-store'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'
import type { TimelineDisplayItem } from '@renderer/features/timeline/timeline-display-items'

import {
  hasConfirmedTemplateIntake,
  findReviewableTemplateIntake,
  hasReviewableTemplateIntake,
  TemplateIntakeNextActions,
  TemplateIntakeStartReviewAction,
} from './TemplateIntakeNextActions'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue({}),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: invokeMock },
}))

let uiSnapshot: ReturnType<typeof useUIStore.getState>
let extensionUiSnapshot: ReturnType<typeof useExtensionUIStore.getState>

beforeEach(() => {
  uiSnapshot = useUIStore.getState()
  extensionUiSnapshot = useExtensionUIStore.getState()
  useUIStore.setState({
    composerPrefill: null,
    historySessionFile: 'D:\\sessions\\work.jsonl',
  })
  useExtensionUIStore.setState({ activePending: null, suspended: null })
  invokeMock.mockReset()
})

afterEach(() => {
  cleanup()
  useUIStore.setState(uiSnapshot, true)
  useExtensionUIStore.setState(extensionUiSnapshot, true)
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
        block({
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report: { reportId: 'report-1' },
        }),
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

    expect(
      findReviewableTemplateIntake([
        block({
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report: { reportId: 'report-1' },
        }),
      ]),
    ).toEqual({ reportId: 'report-1' })
  })

  it('开始复核按钮直接打开当前报告，不填写或发送提示词', async () => {
    invokeMock.mockResolvedValue({ ok: true, state: 'CONFIRMED' })
    const user = userEvent.setup()
    render(<TemplateIntakeStartReviewAction target={{ reportId: 'report-1' }} />)

    await user.click(screen.getByRole('button', { name: '直接打开文档复核' }))
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.work.template-intake.review.open', {
      sessionFile: 'D:\\sessions\\work.jsonl',
      reportId: 'report-1',
    })
    expect(useUIStore.getState().composerPrefill).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '填写提示词：生成正式模板' })).toBeVisible()
    })
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
