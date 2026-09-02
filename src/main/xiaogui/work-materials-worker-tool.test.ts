import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { WorkMaterialsSnapshotV1 } from '@shared/xiaogui-work-materials'

import type { SessionScopeResolverV1 } from './scope-resolver'
import { createXiaoguiWorkMaterialsWorkerToolHandlerV1 } from './work-materials-worker-tool'

const PROJECT_ID = `xgp1_${'1'.repeat(64)}`
const SESSION_KEY = `xgs1_${'2'.repeat(64)}`

function request(paths?: readonly string[]): WorkerHostToolRequestV1 {
  return {
    type: 'host-tool-request',
    requestId: 'materials-1',
    method: 'xiaogui.work.materials.v1',
    payload: {
      paths,
      sourceSessionId: 'pi-session-1',
      sourceRunId: 'run-1',
      toolCallId: 'call-1',
    },
  }
}

function setup(hasPendingTemplateIntakeSource: boolean) {
  const snapshot: WorkMaterialsSnapshotV1 = {
    version: 'work-materials-snapshot.v1',
    requestedPaths: ['D:/project'],
    totalFileCount: 0,
    totalDirectoryCount: 1,
    extractedFileCount: 0,
    metadataOnlyFileCount: 0,
    failedFileCount: 0,
    files: [],
    warnings: [],
    originalInputsUnchanged: true,
  }
  const read = vi.fn(async () => snapshot)
  const handler = createXiaoguiWorkMaterialsWorkerToolHandlerV1({
    scopeResolver: {
      resolveExisting: vi.fn(async () => ({
        projectId: PROJECT_ID,
        sessionKey: SESSION_KEY,
        sessionMode: 'WORK',
        rootPath: 'D:/project',
        sessionFile: 'D:/session.jsonl',
      })),
    } as unknown as SessionScopeResolverV1,
    getService: () => ({ read }),
    hasPendingTemplateIntakeSource: () => hasPendingTemplateIntakeSource,
  })
  const metadata = (toolRequest: WorkerHostToolRequestV1) => ({
    request: toolRequest,
    fromCwd: 'D:/project',
    fromPoolKey: 'D:/session.jsonl',
    sessionFile: 'D:/session.jsonl',
    fromSessionId: 'pi-session-1',
  })
  return { handler, metadata, read }
}

describe('WORK materials host-tool routing guard', () => {
  it('does not scan the current directory when a quick-action document awaits template intake', async () => {
    const test = setup(true)

    const outcome = await test.handler(test.metadata(request()))

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'HOST_TOOL_FAILED',
        message: expect.stringContaining('普通文档模板整理'),
      },
    })
    expect(test.read).not.toHaveBeenCalled()
  })

  it('still permits an explicitly addressed materials request', async () => {
    const test = setup(true)

    const outcome = await test.handler(test.metadata(request(['D:/other'])))

    expect(outcome).toMatchObject({ ok: true, value: { kind: 'XIAOGUI_WORK_MATERIALS_READY' } })
    expect(test.read).toHaveBeenCalledWith(
      { cwd: 'D:/project', paths: ['D:/other'] },
      expect.any(AbortSignal),
    )
  })
})
