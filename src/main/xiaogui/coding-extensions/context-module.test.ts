import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { CodingContextModuleV1 } from './context-module'

const roots: string[] = []
const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-coding-context-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'answer.ts'), 'export const answer = 42\n', 'utf8')
  return root
}

function moduleFor(root: string, address: SessionAddressV1 = ADDRESS) {
  const resolveProjectRoot = vi.fn(() => root)
  const lookup = vi.fn(async (request: SessionAddressV1) => (
    request.projectId === address.projectId && request.sessionKey === address.sessionKey
      ? { kind: 'FOUND' as const, scope: { ...address, sessionMode: 'CODING' as const } }
      : { kind: 'NOT_FOUND' as const }
  ))
  return {
    module: new CodingContextModuleV1({
      projectResolver: { resolveProjectRoot },
      scopeLookup: { lookup },
    }),
    lookup,
    resolveProjectRoot,
  }
}

describe('CodingContextModuleV1', () => {
  it('由 Main 的会话地址解析权威项目根，并只公开摘要', async () => {
    const root = workspace()
    const { module, lookup, resolveProjectRoot } = moduleFor(root)

    const snapshot = await module.snapshot({
      address: ADDRESS,
      relativePaths: ['src/answer.ts'],
    })

    expect(lookup).toHaveBeenCalledWith(ADDRESS)
    expect(resolveProjectRoot).toHaveBeenCalledWith(ADDRESS.projectId)
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.sources).toEqual([
      expect.objectContaining({
        relativePath: 'src/answer.ts',
        byteLength: 25,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentSummary: { lineCount: 2, includedBytes: 25, truncated: false },
      }),
    ])
    expect(snapshot.symbolService).toBe('UNAVAILABLE')
    expect(snapshot.diagnosticService).toBe('UNAVAILABLE')
    expect(snapshot.resolutionMode).toBe('CONTROLLED_TEXT_FALLBACK')
    expect(JSON.stringify(snapshot)).not.toContain(root)
    expect(JSON.stringify(snapshot)).not.toContain('export const answer')
  })

  it('将受控全文只交给相同会话的单次 Agent turn，并在读取后销毁', async () => {
    const root = workspace()
    const { module } = moduleFor(root)
    const snapshot = await module.snapshot({ address: ADDRESS, relativePaths: ['src/answer.ts'] })

    expect(module.resolveForAgent(ADDRESS, [snapshot.snapshotId])).toEqual({
      schemaVersion: 1,
      snapshotIds: [snapshot.snapshotId],
      sources: [{ relativePath: 'src/answer.ts', content: 'export const answer = 42\n', truncated: false }],
      symbolService: 'UNAVAILABLE',
      diagnosticService: 'UNAVAILABLE',
    })
    expect(() => module.resolveForAgent(ADDRESS, [snapshot.snapshotId]))
      .toThrow('CODING_CONTEXT_SNAPSHOT_SCOPE_MISMATCH')
  })

  it('拒绝 Renderer 伪造会话、绝对路径、越界路径和目录', async () => {
    const root = workspace()
    const { module } = moduleFor(root)
    const foreignAddress = { ...ADDRESS, sessionKey: `xgs1_${'c'.repeat(64)}` } as SessionAddressV1

    await expect(module.snapshot({ address: foreignAddress, relativePaths: ['src/answer.ts'] }))
      .rejects.toThrow('CODING_CONTEXT_SCOPE_NOT_AUTHORIZED')
    await expect(module.snapshot({ address: ADDRESS, relativePaths: [join(root, 'src', 'answer.ts')] }))
      .rejects.toThrow('CODING_CONTEXT_RELATIVE_PATH_REQUIRED')
    await expect(module.snapshot({ address: ADDRESS, relativePaths: ['../outside.ts'] }))
      .rejects.toThrow('CODING_CONTEXT_OUTSIDE_WORKSPACE')
    await expect(module.snapshot({ address: ADDRESS, relativePaths: ['src'] }))
      .rejects.toThrow('CODING_CONTEXT_FILE_REQUIRED')
  })

  it('拒绝把一个会话的快照交给另一会话', async () => {
    const root = workspace()
    const { module } = moduleFor(root)
    const snapshot = await module.snapshot({ address: ADDRESS, relativePaths: ['src/answer.ts'] })
    const foreignAddress = { ...ADDRESS, sessionKey: `xgs1_${'c'.repeat(64)}` } as SessionAddressV1

    expect(() => module.resolveForAgent(foreignAddress, [snapshot.snapshotId]))
      .toThrow('CODING_CONTEXT_SNAPSHOT_SCOPE_MISMATCH')
  })

  it('到期时主动销毁全文，并以数量和字节硬上限拒绝继续缓存', async () => {
    vi.useFakeTimers()
    try {
      const root = workspace()
      const module = new CodingContextModuleV1({
        projectResolver: { resolveProjectRoot: vi.fn(() => root) },
        scopeLookup: {
          lookup: vi.fn(async () => ({
            kind: 'FOUND' as const,
            scope: { ...ADDRESS, sessionMode: 'CODING' as const },
          })),
        },
        ttlMs: 25,
        maxSnapshots: 1,
        maxStoredBytes: 30,
      })
      await module.snapshot({ address: ADDRESS, relativePaths: ['src/answer.ts'] })
      expect(module.__testState()).toEqual({ snapshotCount: 1, storedBytes: 25 })
      await expect(module.snapshot({ address: ADDRESS, relativePaths: ['src/answer.ts'] }))
        .rejects.toThrow('CODING_CONTEXT_STORE_LIMIT_EXCEEDED')

      await vi.advanceTimersByTimeAsync(30)
      expect(module.__testState()).toEqual({ snapshotCount: 0, storedBytes: 0 })
      module.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
