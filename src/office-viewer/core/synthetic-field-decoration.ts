import { CustomDecorationType, type IDocumentData } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { addCustomDecorationFactory } from '@univerjs/docs-ui'
import type { FDocument } from '@univerjs/docs-ui/facade'

export const SYNTHETIC_FIELD_DECORATION_ID = 'xiaogui.synthetic-field.office-surface.v1'
export const SYNTHETIC_FIELD_TEXT = '小规文档界面验证'

export interface SyntheticFieldDecorationResultV1 {
  readonly verified: boolean
  readonly created: boolean
  readonly reason?: string
}

/**
 * Proves the public Univer decoration path without changing the document text.
 * This probe only runs against the synthetic spike document; it is not the
 * production template-field implementation.
 */
export async function ensureSyntheticFieldDecorationV1(
  document: FDocument,
  univerAPI: FUniver,
): Promise<SyntheticFieldDecorationResultV1> {
  if (document.getId() !== 'xiaogui-office-spike') {
    return { verified: false, created: false, reason: '当前文档不是 Office Surface 合成验证文档。' }
  }

  const before = document.getSnapshot()
  const dataStream = before.body?.dataStream ?? ''
  const startOffset = dataStream.indexOf(SYNTHETIC_FIELD_TEXT)
  if (startOffset < 0) {
    return { verified: false, created: false, reason: '合成文档中没有找到字段标记验证文本。' }
  }

  if (hasVerifiedDecoration(before, startOffset)) {
    return { verified: true, created: false }
  }

  const mutation = addCustomDecorationFactory({
    unitId: document.getId(),
    id: SYNTHETIC_FIELD_DECORATION_ID,
    type: CustomDecorationType.COMMENT,
    ranges: [{
      startOffset,
      endOffset: startOffset + SYNTHETIC_FIELD_TEXT.length,
      collapsed: false,
    }],
  })
  const executed = await univerAPI.executeCommand(mutation.id, mutation.params)
  if (!executed) {
    return { verified: false, created: false, reason: 'Univer 拒绝执行公开字段装饰命令。' }
  }

  const after = document.getSnapshot()
  if (after.body?.dataStream !== dataStream) {
    return { verified: false, created: true, reason: '字段装饰意外改变了正文，验证已停止。' }
  }
  if (!hasVerifiedDecoration(after, startOffset)) {
    return { verified: false, created: true, reason: '字段装饰命令执行后没有生成可验证标记。' }
  }
  return { verified: true, created: true }
}

function hasVerifiedDecoration(snapshot: IDocumentData, startOffset: number): boolean {
  return snapshot.body?.customDecorations?.some((decoration) => (
    decoration.id === SYNTHETIC_FIELD_DECORATION_ID
    && decoration.type === CustomDecorationType.COMMENT
    && decoration.startIndex === startOffset
    && decoration.endIndex === startOffset + SYNTHETIC_FIELD_TEXT.length - 1
  )) ?? false
}
