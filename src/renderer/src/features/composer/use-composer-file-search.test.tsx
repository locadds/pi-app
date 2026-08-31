import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useComposerFileSearch } from './use-composer-file-search'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setEditorToken(editor: HTMLDivElement, text: string) {
  editor.textContent = text
  const range = document.createRange()
  range.setStart(editor.firstChild!, text.length)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('useComposerFileSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(ipcClient.invoke).mockReset()
  })

  it('debounces requests and suppresses stale responses', async () => {
    const editor = document.createElement('div')
    document.body.appendChild(editor)
    const first = deferred<{ ok: boolean; entries: { path: string; name: string; isDirectory: boolean }[] }>()
    const second = deferred<{ ok: boolean; entries: { path: string; name: string; isDirectory: boolean }[] }>()
    vi.mocked(ipcClient.invoke).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    setEditorToken(editor, '@a')
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useComposerFileSearch({
          editorRef: { current: editor },
          revision,
          workspaceRoot: 'C:/workspace',
          enabled: true,
          onAccepted: vi.fn(),
        }),
      { initialProps: { revision: 1 } },
    )

    await act(async () => vi.advanceTimersByTime(120))
    expect(ipcClient.invoke).toHaveBeenCalledTimes(1)

    setEditorToken(editor, '@ab')
    rerender({ revision: 2 })
    await act(async () => vi.advanceTimersByTime(120))
    expect(ipcClient.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      second.resolve({ ok: true, entries: [{ path: 'ab.ts', name: 'ab.ts', isDirectory: false }] })
      await second.promise
    })
    expect(result.current.entries.map((entry) => entry.path)).toEqual(['ab.ts'])

    await act(async () => {
      first.resolve({ ok: true, entries: [{ path: 'a.ts', name: 'a.ts', isDirectory: false }] })
      await first.promise
    })
    expect(result.current.entries.map((entry) => entry.path)).toEqual(['ab.ts'])
  })

  it('continues searching immediately after accepting a directory', async () => {
    const editor = document.createElement('div')
    document.body.appendChild(editor)
    vi.mocked(ipcClient.invoke)
      .mockResolvedValueOnce({
        ok: true,
        entries: [{ path: 'src', name: 'src', isDirectory: true }],
      })
      .mockResolvedValueOnce({
        ok: true,
        entries: [{ path: 'src/a.ts', name: 'a.ts', isDirectory: false }],
      })

    setEditorToken(editor, '@s')
    const onAccepted = vi.fn()
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useComposerFileSearch({
          editorRef: { current: editor },
          revision,
          workspaceRoot: 'C:/workspace',
          enabled: true,
          onAccepted,
        }),
      { initialProps: { revision: 1 } },
    )
    await act(async () => vi.advanceTimersByTime(120))
    await act(async () => Promise.resolve())

    await result.current.acceptSelected()
    await act(async () => Promise.resolve())
    expect(editor.textContent).toBe('@src/')
    expect(onAccepted).toHaveBeenCalled()

    rerender({ revision: 2 })
    await act(async () => vi.advanceTimersByTime(120))
    await act(async () => Promise.resolve())
    expect(ipcClient.invoke).toHaveBeenLastCalledWith('workspace.fs.search', {
      workspaceRoot: 'C:/workspace',
      query: 'src/',
      maxResults: 20,
    })
  })

})
