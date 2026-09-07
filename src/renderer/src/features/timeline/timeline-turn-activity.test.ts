import { describe, expect, it } from 'vitest'
import { buildTimelineDisplayItems } from './timeline-display-items'
import {
  buildTurnActivitySummary,
  collectRunIdsFromBlocks,
  countToolDiffStats,
} from './timeline-turn-activity'
import type { FileChange } from '@renderer/stores/ui-store-types'

describe('buildTurnActivitySummary', () => {
  it('aggregates tools and file changes for a turn', () => {
    const raw = [
      { id: 'u1', type: 'user-message', text: 'go', timestamp: 1 },
      {
        id: 't1',
        type: 'tool-call',
        toolName: 'write',
        toolPhase: 'end',
        runId: 'r1',
        toolArgs: { path: 'src/a.ts', content: 'line1\nline2\n' },
        timestamp: 2,
      },
      {
        id: 't2',
        type: 'tool-call',
        toolName: 'read',
        toolPhase: 'end',
        runId: 'r1',
        toolArgs: { path: 'src/a.ts' },
        timestamp: 3,
      },
      {
        id: 't3',
        type: 'tool-call',
        toolName: 'bash',
        toolPhase: 'end',
        runId: 'r1',
        toolArgs: { command: 'echo hi' },
        timestamp: 4,
      },
    ]
    const blocks = buildTimelineDisplayItems(raw)
    // drop user message for activity (turn blocks only)
    const turnBlocks = blocks.filter((b) => !(b.kind === 'single' && b.item.type === 'user-message'))
    const fileChanges: FileChange[] = [
      { path: 'src/a.ts', source: 'write', changeType: 'created', runId: 'r1' },
    ]
    const summary = buildTurnActivitySummary(turnBlocks, fileChanges, {
      runIds: collectRunIdsFromBlocks(turnBlocks),
      workspaceRoot: 'D:/workspace/pi-app',
    })
    expect(summary.toolCount).toBe(3)
    expect(summary.commandCount).toBe(1)
    expect(summary.exploreCount).toBe(1)
    expect(summary.files).toHaveLength(1)
    expect(summary.files[0].displayName).toContain('a.ts')
    expect(summary.additions).toBeGreaterThan(0)
  })

  it('counts only completed successful mutations while retaining an earlier success for the same file', () => {
    const raw = [
      {
        id: 'write-ok',
        type: 'tool-call',
        toolName: 'write',
        toolPhase: 'end',
        runId: 'r1',
        toolArgs: { path: 'src/a.ts', content: 'verified' },
        timestamp: 1,
      },
      {
        id: 'write-denied',
        type: 'tool-call',
        toolName: 'write',
        toolPhase: 'end',
        isError: true,
        runId: 'r1',
        toolArgs: { path: 'src/a.ts', content: 'must not count' },
        timestamp: 2,
      },
      {
        id: 'write-awaiting',
        type: 'tool-call',
        toolName: 'write',
        toolPhase: 'start',
        runId: 'r1',
        toolArgs: { path: 'src/pending.ts', content: 'must not count' },
        timestamp: 3,
      },
    ]
    const blocks = buildTimelineDisplayItems(raw)
    const fileChanges: FileChange[] = [
      { path: 'D:/workspace/src/a.ts', source: 'write', changeType: 'added', runId: 'r1' },
      { path: 'D:/workspace/src/pending.ts', source: 'write', changeType: 'added', runId: 'r1' },
    ]

    const summary = buildTurnActivitySummary(blocks, fileChanges, {
      runIds: collectRunIdsFromBlocks(blocks),
      workspaceRoot: 'D:/workspace',
    })

    expect(summary.toolCount).toBe(3)
    expect(summary.files).toHaveLength(1)
    expect(summary.files[0]).toMatchObject({ path: 'D:/workspace/src/a.ts', displayName: 'src/a.ts', additions: 1 })
    expect(summary.additions).toBe(1)
    expect(countToolDiffStats(raw[0]).additions).toBeGreaterThan(0)
    expect(countToolDiffStats(raw[1])).toEqual({ additions: 0, deletions: 0 })
    expect(countToolDiffStats(raw[2])).toEqual({ additions: 0, deletions: 0 })
  })
})
