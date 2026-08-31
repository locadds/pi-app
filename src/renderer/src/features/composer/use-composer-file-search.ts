import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceFsSearchEntry } from '@shared/ipc-contract'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { ipcClient } from '@renderer/lib/ipc-client'
import { getAttachmentKind } from './attachments'
import {
  extractComposerFileToken,
  replaceComposerFileToken,
  type ComposerFileToken,
} from './composer-file-search'
import { resolveCodingContextStatus } from './coding-context-status'

interface UseComposerFileSearchOptions {
  editorRef: React.RefObject<HTMLDivElement | null>
  revision: number
  workspaceRoot: string | null
  enabled: boolean
  codingContextEnabled?: boolean
  codingContextAddress?: SessionAddressV1 | null
  onAccepted: () => void
}

export function useComposerFileSearch({
  editorRef,
  revision,
  workspaceRoot,
  enabled,
  codingContextEnabled = false,
  codingContextAddress = null,
  onAccepted,
}: UseComposerFileSearchOptions) {
  const [token, setToken] = useState<ComposerFileToken | null>(null)
  const [entries, setEntries] = useState<WorkspaceFsSearchEntry[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const requestSequence = useRef(0)
  const previousTokenKey = useRef<string | null>(null)
  const activeToken = useRef<ComposerFileToken | null>(null)

  useEffect(() => {
    const onSelectionChange = () => {
      const el = editorRef.current
      const selection = window.getSelection()
      if (el && selection?.anchorNode && el.contains(selection.anchorNode)) {
        setSelectionRevision((value) => value + 1)
      }
    }
    const onWindowBlur = () => setSelectionRevision((value) => value + 1)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [editorRef])

  useEffect(() => {
    const next = enabled && workspaceRoot && editorRef.current
      ? extractComposerFileToken(editorRef.current)
      : null
    activeToken.current = next
    setToken((current) => (current?.key === next?.key ? current : next))
    if (next?.key !== previousTokenKey.current) {
      previousTokenKey.current = next?.key ?? null
      setSelectedIdx(0)
      setSettledKey(null)
    }
    if (!next || next.key !== dismissedKey) setDismissedKey(null)
    if (!next) {
      requestSequence.current += 1
      setEntries([])
      setLoading(false)
    }
  }, [dismissedKey, editorRef, enabled, revision, selectionRevision, workspaceRoot])

  useEffect(() => {
    if (!token || token.key === dismissedKey || !enabled || !workspaceRoot) return
    const sequence = ++requestSequence.current
    setLoading(true)
    const timer = window.setTimeout(() => {
      void ipcClient
        .invoke('workspace.fs.search', {
          workspaceRoot,
          query: token.query,
          maxResults: 20,
        })
        .then((response) => {
          if (sequence !== requestSequence.current) return
          setEntries(response?.ok ? response.entries || [] : [])
          setSettledKey(response?.ok ? token.key : null)
          setLoading(false)
        })
        .catch(() => {
          if (sequence !== requestSequence.current) return
          setEntries([])
          setSettledKey(null)
          setLoading(false)
        })
    }, 100)
    return () => window.clearTimeout(timer)
  }, [dismissedKey, enabled, token, workspaceRoot])

  const dismiss = useCallback(() => {
    requestSequence.current += 1
    setDismissedKey(token?.key ?? null)
    setEntries([])
    setSettledKey(null)
    setLoading(false)
  }, [token])

  const acceptEntry = useCallback(
    async (entry: WorkspaceFsSearchEntry) => {
      const el = editorRef.current
      const currentToken = activeToken.current
      if (!el || !currentToken) return
      if (entry.isDirectory) {
        previousTokenKey.current = null
        replaceComposerFileToken(el, currentToken, `${entry.path.replace(/\/+$/, '')}/`)
      } else {
        const codingContext = await resolveCodingContextStatus({
          enabled: codingContextEnabled,
          address: codingContextAddress,
          relativePath: entry.path,
        })
        replaceComposerFileToken(el, currentToken, {
          path: entry.path,
          name: entry.name,
          kind: getAttachmentKind(entry.name),
          ...codingContext,
        })
      }
      onAccepted()
      setEntries([])
      setSelectedIdx(0)
      if (!entry.isDirectory) {
        previousTokenKey.current = null
        setToken(null)
        setDismissedKey(null)
      }
    },
    [codingContextAddress, codingContextEnabled, editorRef, onAccepted],
  )

  const acceptSelected = useCallback(async () => {
    const entry = entries[selectedIdx]
    if (entry) await acceptEntry(entry)
  }, [acceptEntry, entries, selectedIdx])

  const show =
    !!token &&
    token.key !== dismissedKey &&
    (loading || entries.length > 0 || settledKey === token.key)

  return {
    show,
    loading,
    entries,
    selectedIdx,
    setSelectedIdx,
    acceptEntry,
    acceptSelected,
    dismiss,
  }
}
