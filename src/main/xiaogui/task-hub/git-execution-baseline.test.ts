import { describe, expect, it, vi } from 'vitest'

import type { FlowId, HubAddressV1, PlanRevisionId } from '@shared/xiaogui-collaboration-hub'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import { digestJson } from './digest'
import {
  GitExecutionBaselineErrorV1,
  GitExecutionBaselineProviderV1,
  type GitExecutionBaselineReaderV1,
} from './git-execution-baseline'

const projectId = `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId']
const address: HubAddressV1 = {
  projectId,
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}
const captureInput = {
  address,
  flowId: 'flow-1' as FlowId,
  planRevisionId: 'revision-1' as PlanRevisionId,
}

function subject(outputs: readonly string[]) {
  const resolveProjectRoot = vi.fn(async () => 'C:\\private\\project')
  const read = vi.fn(async () => outputs[read.mock.calls.length - 1] ?? '')
  return {
    provider: new GitExecutionBaselineProviderV1(
      { resolveProjectRoot } satisfies ProjectWorkspaceResolverV1,
      { read } satisfies GitExecutionBaselineReaderV1,
    ),
    resolveProjectRoot,
    read,
  }
}

describe('GitExecutionBaselineProviderV1', () => {
  it('captures the exact Git revisions and returns a deterministic path-free baseline', async () => {
    const commitOid = '1'.repeat(40)
    const treeOid = '2'.repeat(40)
    const { provider, resolveProjectRoot, read } = subject([`${commitOid}\n`, `${treeOid}\n`])

    const first = await provider.capture(captureInput)
    const second = await subject([commitOid, treeOid]).provider.capture({
      ...captureInput,
      flowId: 'flow-2' as FlowId,
      planRevisionId: null,
    })
    const expectedBase = {
      baselineId: `git-baseline-v1-${digestJson({ projectId, baseRevision: commitOid, baselineTreeHash: treeOid })}`,
      baseRevision: commitOid,
      baselineTreeHash: treeOid,
      initialTargetFingerprint: digestJson({ kind: 'xiaogui-git-project-v1', projectId }),
    }

    expect(resolveProjectRoot).toHaveBeenCalledExactlyOnceWith(projectId)
    expect(read.mock.calls).toEqual([
      ['C:\\private\\project', 'HEAD'],
      ['C:\\private\\project', 'HEAD^{tree}'],
    ])
    expect(first).toEqual({ ...expectedBase, baselineDigest: digestJson(expectedBase) })
    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain('C:\\private\\project')
  })

  it('fails closed when the Git reader fails', async () => {
    const reader: GitExecutionBaselineReaderV1 = {
      read: vi.fn(async () => { throw new Error('private Git failure') }),
    }
    const provider = new GitExecutionBaselineProviderV1(
      { resolveProjectRoot: async () => 'C:\\private\\project' },
      reader,
    )

    await expect(provider.capture(captureInput))
      .rejects.toEqual(new GitExecutionBaselineErrorV1('GIT_BASELINE_READ_FAILED'))
  })

  it('fails closed for empty or malformed Git object ids', async () => {
    for (const invalidOid of ['', 'not-an-object-id', '3'.repeat(39), '4'.repeat(64), `${'4'.repeat(40)}\n${'5'.repeat(40)}`]) {
      const { provider, read } = subject([invalidOid, '2'.repeat(40)])

      await expect(provider.capture(captureInput))
        .rejects.toEqual(new GitExecutionBaselineErrorV1('GIT_BASELINE_INVALID_OID'))
      expect(read).toHaveBeenCalledTimes(1)
    }
  })
})
