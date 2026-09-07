import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import type { ToolTimelineItem } from '@renderer/stores/ui-store-types'
import { ToolCallRow } from './tool-call-row'

afterEach(() => cleanup())

beforeEach(() => {
  useUIStore.setState({
    historySessionFile: '/workspace/session.jsonl',
    runState: { status: 'idle', toolCount: 0, errorCount: 0 },
    toolExpandBySession: {},
  })
})

function renderRow(item: ToolTimelineItem) {
  render(<ToolCallRow item={item} />)
}

describe('ToolCallRow Skill context semantics', () => {
  it('renders SKILL.md reads as Skill context and keeps the read preview expandable', () => {
    renderRow({
      id: 'skill-read',
      type: 'tool-call',
      toolName: 'read',
      toolArgs: { path: 'C:\\Users\\dev\\.pi\\agent\\skills\\frontend-taste\\SKILL.md' },
      toolOutput: '# Frontend Taste',
      toolPhase: 'end',
      timestamp: 1,
    })

    const row = screen.getByRole('button', { name: /Loaded Skill context · frontend-taste/i })
    expect(row.querySelector('svg.text-primary\\/75')).toBeTruthy()
    expect(row.querySelector('svg.timeline-text-quiet')).toBeNull()
    expect(row).not.toHaveTextContent(/Read C:/i)

    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('# Frontend Taste')).toBeTruthy()
  })

  it('keeps ordinary read calls on the normal tool presentation', () => {
    renderRow({
      id: 'normal-read',
      type: 'tool-call',
      toolName: 'read',
      toolArgs: { path: '/repo/README.md' },
      toolOutput: '# Repo',
      toolPhase: 'end',
      timestamp: 1,
    })

    const row = screen.getByRole('button', { name: /Read \/repo\/README\.md/i })
    expect(row.querySelector('svg.timeline-text-quiet')).toBeTruthy()
    expect(row.querySelector('svg.text-primary\\/75')).toBeNull()
    expect(row).not.toHaveTextContent(/Skill context/i)
  })

  it('does not present pending or denied writes as completed edits', () => {
    const { rerender } = render(<ToolCallRow item={{
      id: 'pending-write',
      type: 'tool-call',
      toolName: 'write',
      toolArgs: { path: 'c01-denied.txt', content: 'must not write' },
      toolPhase: 'start',
      timestamp: 1,
    }} />)

    const pending = screen.getByRole('button', { name: /Running write/i })
    expect(pending).not.toHaveTextContent(/Edited c01-denied\.txt/i)
    expect(pending).not.toHaveTextContent('+1')
    fireEvent.click(pending)
    expect(screen.getByText('No successful change result yet')).toBeTruthy()

    rerender(<ToolCallRow item={{
      id: 'denied-write',
      type: 'tool-call',
      toolName: 'write',
      toolArgs: { path: 'c01-denied.txt', content: 'must not write' },
      toolOutput: 'DIRECT_CODING_PERMISSION_DENIED',
      toolPhase: 'end',
      isError: true,
      timestamp: 2,
    }} />)

    const denied = screen.getByRole('button', { name: /write failed/i })
    expect(denied).not.toHaveTextContent(/Edited c01-denied\.txt/i)
    expect(denied).not.toHaveTextContent('+1')

    rerender(<ToolCallRow item={{
      id: 'unknown-write',
      type: 'tool-call',
      toolName: 'write',
      toolArgs: { path: 'c01-denied.txt', content: 'must not write' },
      timestamp: 3,
    }} />)

    expect(screen.getByRole('button', { name: /Waiting for write result/i })).not.toHaveTextContent(/Edited c01-denied\.txt/i)
  })
})
