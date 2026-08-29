import '@testing-library/jest-dom/vitest'

import { createHash, webcrypto } from 'node:crypto'
import { createRef } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TemplateReviewTargetV3 } from '@shared/xiaogui-work-template-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import {
  DocxHtmlViewer,
  type DocxHtmlViewerHandleV1,
} from './docx-html-viewer'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_blob: Blob, body: HTMLElement) => {
    body.innerHTML = [
      '<div class="xiaogui-docx-wrapper"><section class="xiaogui-docx">',
      '<span id="xg_start"></span><span data-testid="content">甲\u2003乙</span><span id="xg_end"></span>',
      '<span id="xg_img_start"></span><img data-testid="image" alt="图件"><span id="xg_img_end"></span>',
      '</section></div>',
    ].join('')
  }),
}))

const invoke = vi.mocked(ipcClient.invoke)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const originalGetClientRects = Range.prototype.getClientRects

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: vi.fn(() => []),
  })
  invoke.mockReset()
  invoke.mockResolvedValue({
    docxBytes: new Uint8Array([1, 2, 3]),
    sha256: 'a'.repeat(64),
  })
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  cleanup()
  vi.unstubAllGlobals()
  if (originalGetClientRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: originalGetClientRects,
    })
  } else {
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
  }
})

describe('DocxHtmlViewer', () => {
  it('creates a bounded native scroll container for mouse-wheel document navigation', async () => {
    const { container } = render(
      <div className="h-[600px] min-h-0">
        <DocxHtmlViewer documentToken="opaque-token" className="h-full" />
      </div>,
    )

    const host = container.querySelector('.relative') as HTMLElement
    await waitFor(() => expect(host.shadowRoot).toBeTruthy())

    const shadow = host.shadowRoot!
    const shell = shadow.querySelector<HTMLElement>('.xiaogui-docx-shell')
    const css = shadow.querySelector('style')?.textContent ?? ''

    expect(host).toHaveClass('h-full', 'min-h-0', 'overflow-hidden')
    expect(shell).toBeTruthy()
    expect(css).toContain('height: 100%')
    expect(css).toContain('min-height: 0')
    expect(css).toContain('overflow-y: auto')
  })

  it('maps whitespace-equivalent rendered text but keeps local split disabled', async () => {
    const target: TemplateReviewTargetV3 = {
      targetId: 'target-1',
      kind: 'TEXT',
      preview: '甲乙',
      sourceAnchor: { part: 'BODY', paragraphIndex: 1 },
      renderAnchor: {
        status: 'PROJECTED',
        startBookmark: 'xg_start',
        endBookmark: 'xg_end',
        textSelectionAllowed: true,
        expectedTextSha256: sha256('甲乙'),
        expectedTextLengthUtf16: 2,
        expectedCompactTextSha256: sha256('甲乙'),
        expectedCompactTextLengthUtf16: 2,
      },
      reason: '需要人工复核',
      confidence: 0.5,
      riskFlags: ['LOW_CONFIDENCE'],
      highlight: 'YELLOW',
      status: 'PENDING',
      highRisk: false,
    }
    const viewerRef = createRef<DocxHtmlViewerHandleV1>()
    const onMappedTargetsChange = vi.fn()
    const onSelectTarget = vi.fn()
    const { container } = render(
      <DocxHtmlViewer
        ref={viewerRef}
        documentToken="opaque-token"
        targets={[target]}
        onMappedTargetsChange={onMappedTargetsChange}
        onSelectTarget={onSelectTarget}
      />,
    )

    await waitFor(() => expect(onMappedTargetsChange).toHaveBeenCalledWith(['target-1']))
    const content = container.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('[data-testid="content"]')
    expect(content).toBeTruthy()

    content!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    expect(onSelectTarget).toHaveBeenCalledWith(target)

    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(content!)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(viewerRef.current?.readSelection()).toBeNull()
  })

  it('maps and selects a projected inline image without pretending it is text', async () => {
    const target: TemplateReviewTargetV3 = {
      targetId: 'target-image',
      kind: 'IMAGE',
      preview: '图片或图件 1',
      sourceAnchor: { part: 'DRAWING', drawingIndex: 1 },
      renderAnchor: {
        status: 'PROJECTED',
        startBookmark: 'xg_img_start',
        endBookmark: 'xg_img_end',
        textSelectionAllowed: false,
        objectSelectionAllowed: true,
      },
      reason: '图件需要人工确认',
      confidence: 1,
      riskFlags: ['OLD_PROJECT_DRAWING'],
      highlight: 'YELLOW',
      status: 'PENDING',
      highRisk: true,
    }
    const onMappedTargetsChange = vi.fn()
    const onSelectTarget = vi.fn()
    const { container } = render(
      <DocxHtmlViewer
        documentToken="opaque-token"
        targets={[target]}
        onMappedTargetsChange={onMappedTargetsChange}
        onSelectTarget={onSelectTarget}
      />,
    )

    await waitFor(() => expect(onMappedTargetsChange).toHaveBeenCalledWith(['target-image']))
    const image = container.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('[data-testid="image"]')
    expect(image).toBeTruthy()
    image!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    expect(onSelectTarget).toHaveBeenCalledWith(target)
  })
})
