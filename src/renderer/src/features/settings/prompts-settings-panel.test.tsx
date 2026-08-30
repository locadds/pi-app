import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { XiaoguiEffectivePromptDiagnosticsV1 } from '@shared/xiaogui-prompt-contract'
import { ipcClient } from '@renderer/lib/ipc-client'
import { EffectivePromptDiagnosticsPanel } from './prompts-settings-panel'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key.endsWith('advancedSummary')) return 'Advanced diagnostics: expand Prompt body'
      if (key.endsWith('advancedTruncated')) return 'Prompt preview truncated'
      return key
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('./markdown-resource-editor', () => ({
  MarkdownResourceEditor: () => <div />,
}))

vi.mock('./settings-shell', () => ({
  SettingsPageHeader: () => <div />,
}))

const completeHash = 'b'.repeat(64)
const diagnostics: XiaoguiEffectivePromptDiagnosticsV1 = {
  manifest: {
    schemaVersion: 1,
    mode: 'WORK',
    phase: 'EXECUTE',
    workspaceAvailable: true,
    projectTrusted: true,
    capabilityIds: ['work.report-docx'],
    toolNames: ['read', 'xiaogui_work_report_docx'],
    layers: [{
      id: 'xiaogui.mode.work',
      version: '1.0.0',
      kind: 'MODE',
      required: true,
      characterCount: 321,
      sha256: 'c'.repeat(64),
    }],
    completePromptCharacterCount: 15001,
    completePromptSha256: completeHash,
    generatedAt: '2026-08-30T00:00:00.000Z',
  },
  migrationNotices: [],
}

beforeEach(() => {
  vi.mocked(ipcClient.invoke).mockReset().mockResolvedValue({
    content: `advanced-only:${'x'.repeat(15000)}`,
  })
})

afterEach(() => cleanup())

describe('EffectivePromptDiagnosticsPanel', () => {
  it('shows the complete Manifest by default and loads a truncated body only after explicit expansion', async () => {
    render(
      <EffectivePromptDiagnosticsPanel
        diagnostics={diagnostics}
        previewPath="pi-desktop://system-prompt-preview"
      />,
    )

    expect(screen.getByText('WORK')).toBeInTheDocument()
    expect(screen.getByText('EXECUTE')).toBeInTheDocument()
    expect(screen.getByText('xiaogui.mode.work')).toBeInTheDocument()
    expect(screen.getByText('xiaogui_work_report_docx')).toBeInTheDocument()
    expect(screen.getByText(completeHash)).toBeInTheDocument()
    expect(screen.queryByText(/advanced-only:/)).not.toBeInTheDocument()
    expect(ipcClient.invoke).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(/Advanced diagnostics/i))

    await waitFor(() => {
      expect(ipcClient.invoke).toHaveBeenCalledWith('resource.read', {
        path: 'pi-desktop://system-prompt-preview',
        expectedPromptSha256: completeHash,
      })
    })
    expect(await screen.findByText(/advanced-only:/)).toBeInTheDocument()
    expect(screen.getByText(/truncated/i)).toBeInTheDocument()
    expect(screen.getByText(completeHash)).toBeInTheDocument()
  })
})
