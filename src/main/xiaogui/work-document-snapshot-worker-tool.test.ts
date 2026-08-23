import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { DocumentSnapshotV1 } from '@shared/xiaogui-document-snapshot'

import type { PiSessionScopeV1 } from './scope-derive'
import type { SessionScopeResolverV1 } from './scope-resolver'
import {
  createXiaoguiWorkDocumentSnapshotWorkerToolHandlerV1,
  type WorkDocumentSnapshotWorkerToolServiceV1,
} from './work-document-snapshot-worker-tool'

const PROJECT_1 = `xgp1_${'1'.repeat(64)}`
const PROJECT_2 = `xgp1_${'3'.repeat(64)}`
const SESSION_1 = `xgs1_${'2'.repeat(64)}`
const SESSION_2 = `xgs1_${'4'.repeat(64)}`

const SNAPSHOT: DocumentSnapshotV1 = {
  version: 'document-snapshot.v1',
  kind: 'PDF',
  sourceDisplayName: '报告.pdf',
  sourceSha256: 'a'.repeat(64),
  extractorId: 'unpdf',
  extractorVersion: '1.6.2',
  pageCount: 2,
  pages: [
    { pageNumber: 1, text: '第一页正文', textSha256: 'b'.repeat(64) },
    { pageNumber: 2, text: '第二页正文', textSha256: 'c'.repeat(64) },
  ],
  contentSha256: 'd'.repeat(64),
  warnings: [],
  originalInputUnchanged: true,
}

function request(overrides?: {
  startPage?: number
  endPage?: number
  sourceSessionId?: string
  extra?: Record<string, unknown>
}): WorkerHostToolRequestV1 {
  return {
    type: 'host-tool-request',
    requestId: 'host-read-1',
    method: 'xiaogui.work.document-snapshot.v1',
    payload: {
      action: 'READ_PDF',
      startPage: overrides?.startPage,
      endPage: overrides?.endPage,
      sourceSessionId: overrides?.sourceSessionId ?? 'pi-session-1',
      sourceRunId: 'run-1',
      toolCallId: 'call-1',
      ...overrides?.extra,
    } as never,
  }
}

function scope(sessionMode: 'WORK' | 'DESIGN' | 'CODING' = 'WORK', second = false): PiSessionScopeV1 {
  return {
    projectId: (second ? PROJECT_2 : PROJECT_1) as never,
    sessionKey: (second ? SESSION_2 : SESSION_1) as never,
    sessionMode,
    rootPath: second ? 'D:/other' : 'D:/project',
    sessionFile: second ? 'D:/other-session.jsonl' : 'D:/session.jsonl',
  }
}

function setup(initialScope: PiSessionScopeV1 | null = scope()) {
  const resolveExisting = vi.fn(async () => initialScope)
  const read = vi.fn(
    async (): Promise<
      | { ok: true; value: { kind: 'READY'; snapshot: DocumentSnapshotV1 } }
      | { ok: true; value: { kind: 'CANCELLED' } }
      | { ok: false; error: { code: string; messageKey: string } }
    > => ({ ok: true, value: { kind: 'READY', snapshot: SNAPSHOT } }),
  )
  const service = { read } as unknown as WorkDocumentSnapshotWorkerToolServiceV1
  const getService = vi.fn(() => service)
  const handler = createXiaoguiWorkDocumentSnapshotWorkerToolHandlerV1({
    scopeResolver: { resolveExisting } as unknown as SessionScopeResolverV1,
    getService,
  })
  const metadata = (toolRequest: WorkerHostToolRequestV1, second = false) => ({
    request: toolRequest,
    fromCwd: second ? 'D:/other' : 'D:/project',
    fromPoolKey: second ? 'D:/other-session.jsonl' : 'D:/session.jsonl',
    sessionFile: second ? 'D:/other-session.jsonl' : 'D:/session.jsonl',
    fromSessionId: second ? 'pi-session-2' : 'pi-session-1',
  })
  return { handler, metadata, resolveExisting, getService, read }
}

describe('WORK document snapshot Worker host-tool adapter', () => {
  it('derives the trusted address, reads through the service, and returns only the path-free snapshot', async () => {
    const test = setup()

    const outcome = await test.handler(test.metadata(request()))

    expect(test.resolveExisting).toHaveBeenCalledWith({
      rootPath: 'D:/project',
      sessionFile: 'D:/session.jsonl',
    })
    expect(test.read).toHaveBeenCalledWith(
      {
        address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
        startPage: undefined,
        endPage: undefined,
      },
      undefined,
    )
    expect(outcome).toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY', snapshot: SNAPSHOT },
    })
    expect(JSON.stringify(outcome)).not.toContain('D:/project')
    expect(JSON.stringify(outcome)).not.toContain('D:/session.jsonl')
  })

  it('forwards only the model-side page range without any address or path field', async () => {
    const test = setup()

    await test.handler(test.metadata(request({ startPage: 3, endPage: 7 })))

    expect(test.read).toHaveBeenCalledWith(
      {
        address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
        startPage: 3,
        endPage: 7,
      },
      undefined,
    )
    const sent = test.metadata(request({ startPage: 3, endPage: 7 })).request.payload
    expect(sent).not.toHaveProperty('projectId')
    expect(sent).not.toHaveProperty('sessionKey')
    expect(sent).not.toHaveProperty('path')
    expect(sent).not.toHaveProperty('password')
  })

  it('rejects extra fields and absolute path payloads at the schema boundary', async () => {
    const test = setup()
    const pathPayload = request({ extra: { path: 'C:\\secret\\notes.pdf' } })
    await expect(test.handler(test.metadata(pathPayload))).resolves.toMatchObject({
      ok: false,
      error: { code: 'HOST_TOOL_REQUEST_INVALID' },
    })
    expect(test.getService).not.toHaveBeenCalled()

    const addressPayload = request({ extra: { address: { projectId: 'x', sessionKey: 'y' } } })
    await expect(test.handler(test.metadata(addressPayload))).resolves.toMatchObject({
      ok: false,
      error: { code: 'HOST_TOOL_REQUEST_INVALID' },
    })
  })

  it.each(['DESIGN', 'CODING'] as const)(
    'keeps %s sessions out before any service or picker can run',
    async (mode) => {
      const test = setup(scope(mode))

      const outcome = await test.handler(test.metadata(request()))

      expect(outcome).toMatchObject({ ok: false, error: { code: 'MODE_NOT_ALLOWED' } })
      expect(test.getService).not.toHaveBeenCalled()
      expect(test.read).not.toHaveBeenCalled()
    },
  )

  it('fails closed for an unbound scope, missing session file, and a reused Worker session mismatch', async () => {
    const unbound = setup(null)
    await expect(unbound.handler(unbound.metadata(request()))).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_SCOPE_MISMATCH' },
    })
    expect(unbound.getService).not.toHaveBeenCalled()

    const missing = setup()
    await expect(
      missing.handler({ ...missing.metadata(request()), sessionFile: null }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_NOT_READY' } })
    expect(missing.resolveExisting).not.toHaveBeenCalled()

    const switched = setup()
    await expect(
      switched.handler(switched.metadata(request({ sourceSessionId: 'stale-session' }))),
    ).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })
    expect(switched.resolveExisting).not.toHaveBeenCalled()
  })

  it('maps picker cancellation to a normal worker result', async () => {
    const test = setup()
    test.read.mockResolvedValueOnce({ ok: true, value: { kind: 'CANCELLED' } })

    await expect(test.handler(test.metadata(request()))).resolves.toEqual({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' },
    })
  })

  it.each([
    ['INPUT_INVALID', '所选文件不是受支持的 PDF，请重新选择'],
    ['INPUT_TOO_LARGE', '所选 PDF 超过 20 MB 上限，请换一个文件后重试'],
    ['PAGE_RANGE_INVALID', '页码范围无效：最多连续读取 20 页，请调整后重试'],
    ['PDF_ENCRYPTED', '该 PDF 已加密，当前版本暂不支持读取加密文档'],
    ['PDF_CORRUPTED', '该 PDF 已损坏或结构不完整，无法读取'],
    ['PARSE_TIMEOUT', '解析 PDF 超过 60 秒已停止，请换一个文件后重试'],
    ['PARSE_FAILED', '解析 PDF 失败，请换一个文件后重试'],
    ['SOURCE_CHANGED', '所选 PDF 在读取过程中被修改，请重新选择'],
  ] as const)('turns %s into a safe path-free user message', async (code, expected) => {
    const test = setup()
    test.read.mockResolvedValueOnce({
      ok: false,
      error: { code, messageKey: `xiaogui.work.documentSnapshot.${code.toLowerCase()}` },
    })

    const outcome = await test.handler(test.metadata(request()))

    expect(outcome).toMatchObject({ ok: false, error: { code, message: expected } })
    expect(JSON.stringify(outcome)).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('reports an abort when the Worker cancels while the read is in flight', async () => {
    const test = setup()
    let finishRead!: (value: Awaited<ReturnType<typeof test.read>>) => void
    test.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
    )
    const controller = new AbortController()
    const pending = test.handler({
      ...test.metadata(request()),
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(test.read).toHaveBeenCalledOnce())

    controller.abort()
    finishRead({ ok: false, error: { code: 'PARSE_ABORTED', messageKey: 'x' } })

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'HOST_TOOL_ABORTED' },
    })
  })

  it('serializes concurrent reads per scope', async () => {
    const test = setup()
    let finishRead!: (value: Awaited<ReturnType<typeof test.read>>) => void
    test.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
    )
    const first = test.handler(test.metadata(request()))
    await vi.waitFor(() => expect(test.read).toHaveBeenCalledOnce())

    await expect(test.handler(test.metadata(request()))).resolves.toMatchObject({
      ok: false,
      error: { code: 'WORK_DOCUMENT_SNAPSHOT_ACTIVE' },
    })

    finishRead({ ok: true, value: { kind: 'READY', snapshot: SNAPSHOT } })
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY' },
    })
  })

  it('scopes in-flight reads to the bound session so another session is unaffected', async () => {
    const test = setup()
    let finishRead!: (value: Awaited<ReturnType<typeof test.read>>) => void
    test.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
    )
    const first = test.handler(test.metadata(request()))
    await vi.waitFor(() => expect(test.read).toHaveBeenCalledOnce())

    test.resolveExisting.mockResolvedValueOnce(scope('WORK', true))
    const second = await test.handler(test.metadata(request({ sourceSessionId: 'pi-session-2' }), true))
    expect(second).toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY' },
    })
    expect(test.read).toHaveBeenCalledTimes(2)

    finishRead({ ok: true, value: { kind: 'READY', snapshot: SNAPSHOT } })
    await expect(first).resolves.toMatchObject({ ok: true })
  })
})
