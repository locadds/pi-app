import { describe, expect, it } from 'vitest'
import {
  createOfficeWorktreeV1,
  discardOfficeWorktreeV1,
  hasOfficeTrunkDivergedV1,
  markOfficeWorktreeReadyV1,
  mergeOfficeWorktreeV1,
  reopenOfficeWorktreeV1,
  saveOfficeWorktreeHeadV1,
} from './xiaogui-office-worktree'

const sha = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`

describe('OfficeWorktreeV1', () => {
  it('keeps snapshots immutable while moving from draft to ready and merge', () => {
    const draft = createOfficeWorktreeV1({
      worktreeId: 'worktree-1',
      documentId: 'document-1',
      trunkSha256: sha('a'),
      now: '2026-08-29T00:00:00.000Z',
    })
    const changed = saveOfficeWorktreeHeadV1(draft, {
      expectedHeadSha256: sha('a'),
      nextHeadSha256: sha('b'),
      now: '2026-08-29T00:01:00.000Z',
    })
    const ready = markOfficeWorktreeReadyV1(changed, {
      expectedHeadSha256: sha('b'),
      now: '2026-08-29T00:02:00.000Z',
    })
    const result = mergeOfficeWorktreeV1(ready, {
      actor: 'USER',
      currentTrunkSha256: sha('a'),
      now: '2026-08-29T00:03:00.000Z',
    })

    expect(draft.state).toBe('DRAFT')
    expect(draft.headSha256).toBe(sha('a'))
    expect(result.worktree.state).toBe('MERGED')
    expect(result.trunkSha256).toBe(sha('b'))
  })

  it('rejects stale saves and changed trunks', () => {
    const draft = createOfficeWorktreeV1({ worktreeId: 'w', documentId: 'd', trunkSha256: sha('a') })
    expect(() => saveOfficeWorktreeHeadV1(draft, {
      expectedHeadSha256: sha('b'),
      nextHeadSha256: sha('c'),
    })).toThrow(/重新载入/)

    const ready = markOfficeWorktreeReadyV1(draft, { expectedHeadSha256: sha('a') })
    expect(hasOfficeTrunkDivergedV1(ready, sha('c'))).toBe(true)
    expect(() => mergeOfficeWorktreeV1(ready, {
      actor: 'USER',
      currentTrunkSha256: sha('c'),
    })).toThrow(/正式版本已经变化/)
  })

  it('requires a user action for merge and discard', () => {
    const draft = createOfficeWorktreeV1({ worktreeId: 'w', documentId: 'd', trunkSha256: sha('a') })
    const ready = markOfficeWorktreeReadyV1(draft, { expectedHeadSha256: sha('a') })
    expect(() => mergeOfficeWorktreeV1(ready, {
      actor: 'SYSTEM',
      currentTrunkSha256: sha('a'),
    })).toThrow(/只有用户/)
    expect(() => discardOfficeWorktreeV1(draft, { actor: 'SYSTEM' })).toThrow(/只有用户/)
    expect(discardOfficeWorktreeV1(draft, { actor: 'USER' }).state).toBe('DISCARDED')
  })

  it('can reopen a ready worktree without changing its head', () => {
    const draft = createOfficeWorktreeV1({ worktreeId: 'w', documentId: 'd', trunkSha256: sha('a') })
    const ready = markOfficeWorktreeReadyV1(draft, { expectedHeadSha256: sha('a') })
    const reopened = reopenOfficeWorktreeV1(ready)
    expect(reopened.state).toBe('DRAFT')
    expect(reopened.headSha256).toBe(sha('a'))
  })
})
