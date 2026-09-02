import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  CanonicalSessionAddressScopeV1,
  ProjectId,
  SessionKey,
  SessionMode,
} from '@shared/xiaogui-session-scope'

import {
  canShowCollaborationEntry,
  groupCanonicalSessionsByMode,
} from './canonical-session-display'

function scope(name: string, sessionMode: SessionMode): CanonicalSessionAddressScopeV1 {
  return {
    projectId: `xgp1_${name}` as ProjectId,
    sessionKey: `xgs1_${name}` as SessionKey,
    sessionMode,
  }
}

describe('canonical session display projection', () => {
  it('groups in WORK → DESIGN → CODING order and preserves order inside each group', () => {
    const groups = groupCanonicalSessionsByMode([
      { item: 'coding-1', scope: scope('coding-1', 'CODING') },
      { item: 'work-1', scope: scope('work-1', 'WORK') },
      { item: 'design-1', scope: scope('design-1', 'DESIGN') },
      { item: 'work-2', scope: scope('work-2', 'WORK') },
      { item: 'coding-2', scope: scope('coding-2', 'CODING') },
    ])

    expect(groups).toEqual([
      { key: 'WORK', label: '工作', items: ['work-1', 'work-2'], collaborationAvailable: true },
      {
        key: 'DESIGN',
        label: '规划设计',
        items: ['design-1'],
        collaborationAvailable: false,
      },
      {
        key: 'CODING',
        label: '编程',
        items: ['coding-1', 'coding-2'],
        collaborationAvailable: true,
      },
    ])
  })

  it('omits empty groups without changing the input', () => {
    const input = [{ item: { title: 'only work' }, scope: scope('work', 'WORK') }] as const
    const before = structuredClone(input)

    expect(groupCanonicalSessionsByMode(input)).toEqual([
      {
        key: 'WORK',
        label: '工作',
        items: [{ title: 'only work' }],
        collaborationAvailable: true,
      },
    ])
    expect(input).toEqual(before)
  })

  it('keeps DESIGN visible while reserving its collaboration entry', () => {
    expect(canShowCollaborationEntry('WORK')).toBe(true)
    expect(canShowCollaborationEntry('CODING')).toBe(true)
    expect(canShowCollaborationEntry('DESIGN')).toBe(false)
  })

  it('contains no renderer-owned identity or ownership derivation seam', () => {
    const source = readFileSync(
      resolve('src/renderer/src/xiaogui/lib/canonical-session-display.ts'),
      'utf8',
    )
    for (const forbidden of [
      'rootPath',
      'sessionFile',
      'normalizeSessionFileKey',
      'scope.set',
      'ipcClient',
      'projectModeMap',
      'sessionModeMap',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
