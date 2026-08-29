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
})
