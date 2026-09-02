import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'

import type { TemplateReviewTargetV3, TemplateReviewTextRangeV2 } from '@shared/xiaogui-work-template-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import { cn } from '@renderer/lib/utils'

type DocumentAssetV1 = {
  docxBytes: Uint8Array
  sha256: string
}

export type DocxHtmlViewerStateV1 = 'LOADING' | 'READY' | 'FAILED'

export type DocxHtmlViewerSelectionV1 = {
  targetId: string
  text: string
  range: TemplateReviewTextRangeV2
}

export type DocxHtmlViewerHandleV1 = {
  focus: (targetId: string) => boolean
  readSelection: () => DocxHtmlViewerSelectionV1 | null
  dispose: () => void
}

type RenderedTargetV1 = {
  target: TemplateReviewTargetV3
  start: HTMLElement
  end: HTMLElement
  range: Range
  text: string
  textSelectionAllowed: boolean
  visualElements: HTMLElement[]
}

async function sha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function textAnchorMatch(
  target: TemplateReviewTargetV3,
  text: string,
  digest: string,
): Promise<'EXACT' | 'WHITESPACE_EQUIVALENT' | null> {
  if (
    target.renderAnchor.expectedTextLengthUtf16 === text.length &&
    target.renderAnchor.expectedTextSha256 === digest
  ) {
    return 'EXACT'
  }
  const compact = text.normalize('NFKC').replace(/\s+/g, '')
  if (
    target.renderAnchor.expectedCompactTextLengthUtf16 === compact.length &&
    target.renderAnchor.expectedCompactTextSha256 === await sha256Hex(compact)
  ) {
    return 'WHITESPACE_EQUIVALENT'
  }
  return null
}

function containsSelectionRange(targetRange: Range, selectedRange: Range): boolean {
  try {
    return (
      targetRange.compareBoundaryPoints(Range.START_TO_START, selectedRange) <= 0 &&
      targetRange.compareBoundaryPoints(Range.END_TO_END, selectedRange) >= 0
    )
  } catch {
    return false
  }
}

function rangeOffsetInTarget(targetRange: Range, selectedRange: Range): TemplateReviewTextRangeV2 | null {
  const prefix = targetRange.cloneRange()
  prefix.setEnd(selectedRange.startContainer, selectedRange.startOffset)
  const startUtf16 = prefix.toString().length
  const selectedText = selectedRange.toString()
  const endUtf16Exclusive = startUtf16 + selectedText.length
  return endUtf16Exclusive > startUtf16 ? { startUtf16, endUtf16Exclusive } : null
}

function visualElementsInRange(range: Range): HTMLElement[] {
  const common = range.commonAncestorContainer
  const root = common instanceof Element ? common : common.parentElement
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('img, svg, canvas'))
    .filter((element) => {
      try {
        return range.intersectsNode(element)
      } catch {
        return false
      }
    })
}

export const DocxHtmlViewer = forwardRef<DocxHtmlViewerHandleV1, {
  documentToken: string | undefined
  targets?: readonly TemplateReviewTargetV3[]
  selectedId?: string
  readonlyLabel?: string
  onSelectTarget?: (target: TemplateReviewTargetV3) => void
  onStateChange?: (state: DocxHtmlViewerStateV1, pageCount: number | null) => void
  onMappedTargetsChange?: (targetIds: readonly string[]) => void
  className?: string
}>(function DocxHtmlViewer({
  documentToken,
  targets = [],
  selectedId,
  readonlyLabel = '文档只读预览',
  onSelectTarget,
  onStateChange,
  onMappedTargetsChange,
  className,
}, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const renderedTargetsRef = useRef(new Map<string, RenderedTargetV1>())
  const targetsRef = useRef(targets)
  const selectedIdRef = useRef(selectedId)
  const onSelectTargetRef = useRef(onSelectTarget)
  const onStateChangeRef = useRef(onStateChange)
  const onMappedTargetsChangeRef = useRef(onMappedTargetsChange)
  const [state, setState] = useState<DocxHtmlViewerStateV1>('LOADING')

  targetsRef.current = targets
  selectedIdRef.current = selectedId
  onSelectTargetRef.current = onSelectTarget
  onStateChangeRef.current = onStateChange
  onMappedTargetsChangeRef.current = onMappedTargetsChange

  const disposeDom = () => {
    for (const item of renderedTargetsRef.current.values()) item.range.detach()
    renderedTargetsRef.current.clear()
    const shadow = shadowRef.current
    if (shadow) shadow.replaceChildren()
  }

  const refreshHighlights = () => {
    const shell = shellRef.current
    const overlay = overlayRef.current
    if (!shell || !overlay) return
    const shellRect = shell.getBoundingClientRect()
    overlay.replaceChildren()
    const mappedTargetIds: string[] = []
    for (const rendered of renderedTargetsRef.current.values()) {
      mappedTargetIds.push(rendered.target.targetId)
      if (rendered.target.highlight !== 'YELLOW') continue
      const rects = rendered.visualElements.length > 0
        ? rendered.visualElements.map((element) => element.getBoundingClientRect())
        : Array.from(rendered.range.getClientRects())
      for (const rect of rects) {
        if (rect.width < 1 || rect.height < 1) continue
        const highlight = document.createElement('div')
        highlight.className = 'xiaogui-docx-highlight'
        highlight.dataset.targetId = rendered.target.targetId
        highlight.dataset.selected = String(selectedIdRef.current === rendered.target.targetId)
        highlight.style.left = `${rect.left - shellRect.left + shell.scrollLeft}px`
        highlight.style.top = `${rect.top - shellRect.top + shell.scrollTop}px`
        highlight.style.width = `${Math.max(2, rect.width)}px`
        highlight.style.height = `${Math.max(2, rect.height)}px`
        overlay.append(highlight)
      }
    }
    onMappedTargetsChangeRef.current?.([...new Set(mappedTargetIds)])
  }

  useImperativeHandle(ref, () => ({
    focus(targetId: string) {
      const rendered = renderedTargetsRef.current.get(targetId)
      if (!rendered) return false
      const focusTarget = rendered.visualElements[0] ?? rendered.start
      focusTarget.scrollIntoView({ block: 'center', inline: 'nearest' })
      return true
    },
    readSelection() {
      const selection = (shadowRef.current as unknown as { getSelection?: () => Selection | null } | null)
        ?.getSelection?.() ?? window.getSelection()
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
      const selectedRange = selection.getRangeAt(0)
      const text = selectedRange.toString()
      if (!text) return null
      for (const rendered of renderedTargetsRef.current.values()) {
        if (!rendered.textSelectionAllowed) continue
        if (!containsSelectionRange(rendered.range, selectedRange)) continue
        const offset = rangeOffsetInTarget(rendered.range, selectedRange)
        if (!offset) continue
        if (offset.startUtf16 < 0 || offset.endUtf16Exclusive > rendered.text.length) continue
        return { targetId: rendered.target.targetId, text, range: offset }
      }
      return null
    },
    dispose: disposeDom,
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !documentToken) {
      setState('FAILED')
      onStateChangeRef.current?.('FAILED', null)
      return
    }

    let disposed = false
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    shadowRef.current = shadow
    shadow.replaceChildren()
    renderedTargetsRef.current.clear()

    const styleMount = document.createElement('div')
    const localStyle = document.createElement('style')
    const body = document.createElement('div')
    const overlay = document.createElement('div')
    const shell = document.createElement('div')
    body.className = 'xiaogui-docx-body'
    overlay.className = 'xiaogui-docx-overlay'
    shell.className = 'xiaogui-docx-shell'
    localStyle.textContent = `
      :host { display: block; height: 100%; min-height: 0; overflow: hidden; }
      .xiaogui-docx-shell {
        position: relative;
        height: 100%;
        min-height: 0;
        overflow-x: auto;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        touch-action: pan-x pan-y;
      }
      .xiaogui-docx-body { position: relative; color: #111827; }
      .xiaogui-docx-body a { color: inherit; text-decoration: none; pointer-events: none; }
      .xiaogui-docx-overlay { position: absolute; inset: 0; pointer-events: none; }
      .xiaogui-docx-highlight {
        position: absolute;
        border: 1px solid rgba(245, 158, 11, 0.9);
        background: rgba(252, 211, 77, 0.36);
        border-radius: 2px;
        pointer-events: none;
      }
      .xiaogui-docx-highlight[data-selected="true"] {
        outline: 2px solid #111827;
        outline-offset: 1px;
      }
      .xiaogui-docx-wrapper { background: transparent !important; padding: 24px 0 !important; }
      .xiaogui-docx-wrapper > section.xiaogui-docx { margin: 0 auto 18px auto !important; box-shadow: 0 1px 6px rgba(15, 23, 42, 0.12) !important; }
    `
    shell.append(body, overlay)
    shadow.append(styleMount, localStyle, shell)
    shellRef.current = shell
    overlayRef.current = overlay

    const mapTargets = async () => {
      const next = new Map<string, RenderedTargetV1>()
      for (const target of targetsRef.current) {
        if (target.renderAnchor.status !== 'PROJECTED') continue
        const start = target.renderAnchor.startBookmark
          ? shadow.getElementById(target.renderAnchor.startBookmark)
          : null
        const end = target.renderAnchor.endBookmark
          ? shadow.getElementById(target.renderAnchor.endBookmark)
          : null
        if (!start || !end) continue
        const range = document.createRange()
        range.setStartAfter(start)
        range.setEndBefore(end)
        const text = range.toString()
        const visualElements = target.renderAnchor.objectSelectionAllowed
          ? visualElementsInRange(range)
          : []
        const match = visualElements.length > 0
          ? 'OBJECT'
          : await textAnchorMatch(target, text, await sha256Hex(text))
        if (!match) {
          range.detach()
          continue
        }
        next.set(target.targetId, {
          target,
          start,
          end,
          range,
          text,
          textSelectionAllowed:
            target.renderAnchor.textSelectionAllowed && match === 'EXACT',
          visualElements,
        })
      }
      if (disposed) {
        for (const item of next.values()) item.range.detach()
        return
      }
      for (const item of renderedTargetsRef.current.values()) item.range.detach()
      renderedTargetsRef.current = next
      refreshHighlights()
    }

    const run = async () => {
      try {
        setState('LOADING')
        onStateChangeRef.current?.('LOADING', null)
        const asset = await ipcClient.invoke(
          'xiaogui.templateReview.document.read',
          { documentToken },
        ) as DocumentAssetV1
        const blob = new Blob([new Uint8Array(asset.docxBytes)], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
        await renderAsync(blob, body, styleMount, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          ignoreLastRenderedPageBreak: false,
          useBase64URL: true,
          renderChanges: false,
          renderComments: false,
          renderAltChunks: false,
          experimental: false,
          debug: false,
          className: 'xiaogui-docx',
          trimXmlDeclaration: true,
        })
        if (disposed) return
        body.addEventListener('click', (event) => {
          const eventTarget = event.target
          if (!(eventTarget instanceof Node)) return
          if (eventTarget instanceof HTMLElement && eventTarget.closest('a')) {
            event.preventDefault()
          }
          const selection = (shadow as unknown as { getSelection?: () => Selection | null })
            .getSelection?.() ?? window.getSelection()
          if (selection && !selection.isCollapsed) return
          const matched = [...renderedTargetsRef.current.values()]
            .filter((item) => {
              try {
                return item.range.intersectsNode(eventTarget)
              } catch {
                return false
              }
            })
            .sort((left, right) => left.text.length - right.text.length)[0]
          if (matched) onSelectTargetRef.current?.(matched.target)
        })
        const pageCount = shadow.querySelectorAll('.xiaogui-docx-wrapper > section.xiaogui-docx').length || null
        setState('READY')
        onStateChangeRef.current?.('READY', pageCount)
        await mapTargets()
      } catch {
        if (!disposed) {
          setState('FAILED')
          onStateChangeRef.current?.('FAILED', null)
          onMappedTargetsChangeRef.current?.([])
        }
      }
    }

    void run()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(refreshHighlights)
    resizeObserver?.observe(host)
    window.addEventListener('resize', refreshHighlights)
    return () => {
      disposed = true
      resizeObserver?.disconnect()
      window.removeEventListener('resize', refreshHighlights)
      disposeDom()
      shellRef.current = null
      overlayRef.current = null
    }
  }, [documentToken])

  useEffect(() => {
    for (const highlight of overlayRef.current?.querySelectorAll<HTMLElement>('.xiaogui-docx-highlight') ?? []) {
      highlight.dataset.selected = String(highlight.dataset.targetId === selectedId)
    }
  }, [selectedId])

  return (
    <div ref={hostRef} className={cn('relative h-full min-h-0 w-full overflow-hidden', className)}>
      {readonlyLabel ? <span className="sr-only">{readonlyLabel}</span> : null}
      {state === 'LOADING' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 text-[12px] text-muted-foreground">
          正在显示{readonlyLabel}…
        </div>
      )}
      {state === 'FAILED' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-amber-50 p-6 text-center text-[12px] leading-6 text-amber-900">
          {readonlyLabel}暂时无法直接显示，请使用右侧待处理清单继续复核。
        </div>
      )}
    </div>
  )
})
