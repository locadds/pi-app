import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_DOCUMENT_PARAGRAPH_LINE_SPACING,
  DocumentFlavor,
  LocaleType,
  LogLevel,
  MODERN_DOCUMENT_WIDTH,
  ModernDocumentWidthMode,
  mergeLocales,
  Univer,
  type IDocumentData,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import UniverDesignZhCN from '@univerjs/design/locale/zh-CN'
import {
  SetTextSelectionsOperation,
  UniverDocsPlugin,
  type ISetTextSelectionsOperationParams,
} from '@univerjs/docs'
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing'
import { UniverDocsDrawingUIPlugin } from '@univerjs/docs-drawing-ui'
import '@univerjs/docs-drawing-ui/lib/index.css'
import UniverDocsDrawingUIZhCN from '@univerjs/docs-drawing-ui/locale/zh-CN'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import '@univerjs/docs-ui/facade'
import UniverDocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui'
import '@univerjs/drawing-ui/lib/index.css'
import UniverDrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverUIPlugin } from '@univerjs/ui'
import UniverUIZhCN from '@univerjs/ui/locale/zh-CN'

import {
  isOfficeStructuredDocumentProjectionV1,
  type OfficeSurfaceParentMessageV1,
  type OfficeSnapshotV1,
  type OfficeStructuredDocumentProjectionV1,
} from '@shared/xiaogui-office-surface'
import { ensureUniverDocDrawingResourcesV1 } from './core/doc-drawing-resources'
import { OfficeGatewayClientV1 } from './core/gateway-client'
import type { OfficeParentBridgeV1 } from './core/parent-bridge'
import { ensureSyntheticFieldDecorationV1 } from './core/synthetic-field-decoration'
import {
  isOfficeUniverWorktreeEnvelopeV1,
  materializeStructuredProjectionV1,
  worktreeEnvelopeV1,
  type OfficeUniverWorktreeEnvelopeV1,
} from './core/structured-docx-projection'

type ViewerStatus = '正在载入' | '可以编辑' | '只读预览' | '有未保存修改' | '正在保存' | '已保存' | '载入失败'
type ProjectionMetadataV1 = OfficeUniverWorktreeEnvelopeV1['projection']

export function OfficeViewerApp({ parentBridge }: { parentBridge: OfficeParentBridgeV1 | null }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef<(() => Promise<string>) | null>(null)
  const reloadRef = useRef<(() => Promise<void>) | null>(null)
  const [status, setStatus] = useState<ViewerStatus>('正在载入')
  const [error, setError] = useState<string | null>(null)
  const [fieldDecorationVerified, setFieldDecorationVerified] = useState(false)
  const [projectionMetadata, setProjectionMetadata] = useState<ProjectionMetadataV1 | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let loaded = false
    let autosaveTimer: number | null = null
    const gateway = new OfficeGatewayClientV1()
    const univer = new Univer({
      locale: LocaleType.ZH_CN,
      locales: {
        [LocaleType.ZH_CN]: mergeLocales(
          UniverDesignZhCN,
          UniverDocsUIZhCN,
          UniverDrawingUIZhCN,
          UniverDocsDrawingUIZhCN,
          UniverUIZhCN,
        ),
      },
      logLevel: LogLevel.WARN,
    })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container })
    univer.registerPlugin(UniverDrawingPlugin)
    univer.registerPlugin(UniverDrawingUIPlugin)
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverDocsDrawingPlugin)
    univer.registerPlugin(UniverDocsDrawingUIPlugin)
    const univerAPI = FUniver.newAPI(univer)
    let commandSubscription: { dispose(): void } | null = null
    let parentSubscription: (() => void) | null = null
    let document = univerAPI.getActiveDocument()
    let suppressDirty = false
    let activeProjection: ProjectionMetadataV1 | null = null
    let readOnlyBaseline = ''
    let programmaticOccurrenceId: string | null = null
    let programmaticFocusUntil = 0

    const preventReadOnlyMutation = (event: Event): void => {
      if (!activeProjection?.readOnly) return
      event.preventDefault()
      event.stopPropagation()
    }
    const preventReadOnlyKey = (event: KeyboardEvent): void => {
      if (!activeProjection?.readOnly) return
      const key = event.key.toLocaleLowerCase('en-US')
      const allowedShortcut = (event.ctrlKey || event.metaKey) && ['a', 'c', 'f'].includes(key)
      const allowedNavigation = [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Escape',
        'Shift',
        'Control',
        'Alt',
        'Meta',
      ].includes(event.key)
      if (allowedShortcut || allowedNavigation) return
      if (event.key.length === 1 || ['Backspace', 'Delete', 'Enter', 'Tab'].includes(event.key) || event.ctrlKey || event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    container.addEventListener('beforeinput', preventReadOnlyMutation, true)
    container.addEventListener('paste', preventReadOnlyMutation, true)
    container.addEventListener('cut', preventReadOnlyMutation, true)
    container.addEventListener('drop', preventReadOnlyMutation, true)
    container.addEventListener('keydown', preventReadOnlyKey, true)

    const capabilities = () => ({
      readSnapshot: true,
      writeSnapshot: true,
      syntheticDocument: true,
      docxImport: false,
      docxExport: false,
      nonDestructiveDecoration:
        (activeProjection?.occurrences.length ?? 0) > 0 || fieldDecorationVerifiedFromDocument(document),
      structuredDocxProjection: true,
    })

    const load = async (): Promise<void> => {
      suppressDirty = true
      setStatus('正在载入')
      if (parentBridge) gateway.authorize(await parentBridge.waitForAuthorization())
      const envelope = await gateway.load()
      if (document) throw new Error('当前验证版不支持在同一界面热替换文档，请重新打开界面。')

      if (isOfficeStructuredDocumentProjectionV1(envelope.snapshot)) {
        const projection = envelope.snapshot
        document = univerAPI.createUniverDoc(
          ensureUniverDocDrawingResourcesV1(projection.univerDocument as Partial<IDocumentData>),
        )
        const materialized = await materializeStructuredProjectionV1(projection, document)
        activeProjection = withoutPrivateProjectionData(projection)
        setProjectionMetadata(activeProjection)
        if (materialized.unmappedOccurrenceIds.length > 0) {
          setError(`${materialized.unmappedOccurrenceIds.length} 个字段位置未能在文档中可靠定位，已保留在右侧清单。`)
        }
      } else if (isOfficeUniverWorktreeEnvelopeV1(envelope.snapshot)) {
        document = univerAPI.createUniverDoc(ensureUniverDocDrawingResourcesV1(envelope.snapshot.document))
        activeProjection = envelope.snapshot.projection
        setProjectionMetadata(activeProjection)
      } else if (Object.keys(envelope.snapshot).length > 0) {
        document = univerAPI.createUniverDoc(
          ensureUniverDocDrawingResourcesV1(envelope.snapshot as Partial<IDocumentData>),
        )
      } else {
        document = univerAPI.createUniverDoc(
          createBlankDocument('xiaogui-office-spike', '小规 Office Surface 验证文档'),
        )
        await document.insertParagraph(
          [
            '小规文档界面验证',
            '',
            '这是独立 Office Surface 的合成文档。',
            '本轮只验证中文编辑、快照保存和工作副本边界，不代表已经支持 DOCX 导入导出。',
          ].join('\n'),
        )
        const decoration = await ensureSyntheticFieldDecorationV1(document, univerAPI)
        if (!decoration.verified) throw new Error(decoration.reason ?? '非破坏性字段标记验证失败。')
        await gateway.save(document.getSnapshot() as unknown as OfficeSnapshotV1)
      }

      if (disposed || !document) return
      loaded = true
      suppressDirty = false
      readOnlyBaseline = JSON.stringify(document.getSnapshot())
      const verified = (activeProjection?.occurrences.length ?? 0) > 0 || fieldDecorationVerifiedFromDocument(document)
      setFieldDecorationVerified(verified)
      setStatus(activeProjection?.readOnly ? '只读预览' : '可以编辑')
      parentBridge?.post({
        type: 'VIEWER_READY',
        capabilities: capabilities(),
      })
    }

    const save = async (): Promise<string> => {
      if (!document) throw new Error('OFFICE_DOCUMENT_NOT_READY')
      if (activeProjection?.readOnly) {
        setStatus('只读预览')
        return gateway.getHeadSha256()
      }
      setStatus('正在保存')
      suppressDirty = true
      const snapshot = activeProjection
        ? {
            envelopeVersion: 1,
            kind: 'XIAOGUI_UNIVER_WORKTREE',
            document: document.getSnapshot(),
            projection: activeProjection,
          }
        : document.getSnapshot()
      const headSha256 = await gateway.save(snapshot as unknown as OfficeSnapshotV1)
      suppressDirty = false
      setStatus('已保存')
      parentBridge?.post({
        type: 'VIEWER_DIRTY_STATE',
        dirty: false,
        headSha256,
      })
      return headSha256
    }

    const updateField = async (message: Extract<OfficeSurfaceParentMessageV1, { type: 'PARENT_UPDATE_FIELD' }>) => {
      if (!document || !activeProjection) throw new Error('当前文档没有可同步的业务字段。')
      if (activeProjection.readOnly) throw new Error('当前是只读复核或预览，不能直接修改文档内容。')
      const field = activeProjection.fields.find((item) => item.fieldId === message.fieldId)
      if (!field) throw new Error('没有找到要同步的业务字段。')
      const allowedOccurrenceIds = new Set(field.occurrenceIds)
      const requestedIds = [...new Set(message.occurrenceIds)].filter((id) => allowedOccurrenceIds.has(id))
      if (!requestedIds.length) throw new Error('业务字段没有可同步的位置。')

      const before = document.getSnapshot()
      const dataStream = before.body?.dataStream ?? ''
      const plans = requestedIds.map((occurrenceId) => {
        const occurrence = activeProjection?.occurrences.find((item) => item.occurrenceId === occurrenceId)
        if (!occurrence || dataStream.slice(occurrence.startUtf16, occurrence.endUtf16Exclusive) !== occurrence.originalText) return null
        return {
          occurrenceId,
          start: occurrence.startUtf16,
          end: occurrence.endUtf16Exclusive,
        }
      })
      const missingIds = requestedIds.filter((_, index) => !plans[index])
      const validPlans = plans
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((left, right) => left.start - right.start)
      const overlaps = validPlans.some((item, index) => index > 0 && item.start < validPlans[index - 1].end)
      if (missingIds.length || overlaps) {
        const failedOccurrenceIds = overlaps ? requestedIds : missingIds
        parentBridge?.post({
          type: 'VIEWER_FIELD_UPDATE_RESULT',
          requestId: message.requestId,
          fieldId: message.fieldId,
          updatedOccurrenceIds: [],
          failedOccurrenceIds,
          headSha256: gateway.getHeadSha256(),
        })
        return
      }

      suppressDirty = true
      const executedIds: string[] = []
      let executedCommandCount = 0
      try {
        for (const plan of [...validPlans].sort((left, right) => right.start - left.start)) {
          const executed = await document.insertText(message.value, {
            startOffset: plan.start,
            endOffset: plan.end,
            cursorOffset: message.value.length,
          })
          if (!executed) break
          executedIds.push(plan.occurrenceId)
          executedCommandCount += 1
        }

        const expectedRanges = expectedRangesAfterReplacement(validPlans, message.value)
        const textAfter = document.getSnapshot().body?.dataStream ?? ''
        let verified =
          executedIds.length === validPlans.length &&
          validPlans.every((plan) => {
            const expected = expectedRanges.get(plan.occurrenceId)
            return !!expected && textAfter.slice(expected.start, expected.end) === message.value
          })

        if (!verified) {
          for (let index = 0; index < executedCommandCount; index += 1) await document.undo()
          const headSha256 = await save()
          parentBridge?.post({
            type: 'VIEWER_FIELD_UPDATE_RESULT',
            requestId: message.requestId,
            fieldId: message.fieldId,
            updatedOccurrenceIds: [],
            failedOccurrenceIds: requestedIds,
            headSha256,
          })
          return
        }

        activeProjection = {
          ...activeProjection,
          occurrences: activeProjection.occurrences.map((occurrence) => {
            const expected = expectedRanges.get(occurrence.occurrenceId)
            if (!expected) {
              const shift = replacementShiftBefore(validPlans, message.value, occurrence.startUtf16)
              return shift === 0
                ? occurrence
                : {
                    ...occurrence,
                    startUtf16: occurrence.startUtf16 + shift,
                    endUtf16Exclusive: occurrence.endUtf16Exclusive + shift,
                  }
            }
            return {
              ...occurrence,
              originalText: message.value,
              startUtf16: expected.start,
              endUtf16Exclusive: expected.end,
            }
          }),
        }
        setProjectionMetadata(activeProjection)
        const headSha256 = await save()
        parentBridge?.post({
          type: 'VIEWER_FIELD_UPDATE_RESULT',
          requestId: message.requestId,
          fieldId: message.fieldId,
          updatedOccurrenceIds: requestedIds,
          failedOccurrenceIds: [],
          headSha256,
        })
      } finally {
        suppressDirty = false
      }
    }

    const scheduleAutosave = () => {
      if (autosaveTimer !== null) window.clearTimeout(autosaveTimer)
      autosaveTimer = window.setTimeout(() => {
        autosaveTimer = null
        void save().catch(handleError)
      }, 900)
    }

    const focusOccurrence = (occurrenceId: string) => {
      if (!document) return
      const occurrence = activeProjection?.occurrences.find((item) => item.occurrenceId === occurrenceId)
      if (occurrence) {
        programmaticOccurrenceId = occurrenceId
        programmaticFocusUntil = performance.now() + 250
        document.setSelection(occurrence.startUtf16, occurrence.endUtf16Exclusive)
      }
    }

    saveRef.current = save
    reloadRef.current = async () => window.location.reload()
    commandSubscription = univerAPI.onCommandExecuted((command) => {
      if (command.id === SetTextSelectionsOperation.id) {
        const selected = occurrenceAtSelection(
          activeProjection?.occurrences ?? [],
          command.params as ISetTextSelectionsOperationParams,
        )
        if (
          selected &&
          selected.occurrenceId === programmaticOccurrenceId &&
          performance.now() <= programmaticFocusUntil
        ) {
          return
        }
        programmaticOccurrenceId = null
        programmaticFocusUntil = 0
        if (selected) {
          parentBridge?.post({
            type: 'VIEWER_OCCURRENCE_SELECTED',
            occurrenceId: selected.occurrenceId,
            fieldId: selected.fieldId,
          })
        }
        return
      }
      if (suppressDirty || !document || !loaded) return
      if (activeProjection?.readOnly) {
        const changed = JSON.stringify(document.getSnapshot()) !== readOnlyBaseline
        if (changed) {
          suppressDirty = true
          void document.undo().then(() => {
            const restored = JSON.stringify(document?.getSnapshot()) === readOnlyBaseline
            suppressDirty = false
            setStatus('只读预览')
            if (!restored) window.location.reload()
          })
        }
        return
      }
      setStatus('有未保存修改')
      parentBridge?.post({
        type: 'VIEWER_DIRTY_STATE',
        dirty: true,
        headSha256: gateway.getHeadSha256(),
      })
      scheduleAutosave()
    })
    parentSubscription =
      parentBridge?.subscribe((message: OfficeSurfaceParentMessageV1) => {
        if (message.type === 'PARENT_SAVE') void save().catch(handleError)
        else if (message.type === 'PARENT_RELOAD') window.location.reload()
        else if (message.type === 'PARENT_DISPOSE') univer.dispose()
        else if (message.type === 'PARENT_FOCUS_OCCURRENCE') focusOccurrence(message.occurrenceId)
        else if (message.type === 'PARENT_UPDATE_FIELD') void updateField(message).catch(handleError)
        else if (message.type === 'PARENT_FOCUS_FIELD') {
          const occurrenceId = activeProjection?.fields.find((field) => field.fieldId === message.fieldId)
            ?.occurrenceIds[0]
          if (occurrenceId) focusOccurrence(occurrenceId)
        } else if (message.type === 'PARENT_PING' && loaded) {
          parentBridge.post({
            type: 'VIEWER_READY',
            capabilities: capabilities(),
          })
        }
      }) ?? null

    const handleError = (reason: unknown): void => {
      const message = reason instanceof Error ? reason.message : '文档界面出现未知错误。'
      setError(message)
      setStatus('载入失败')
      parentBridge?.post({
        type: 'VIEWER_ERROR',
        code: 'OFFICE_VIEWER_FAILED',
        message,
      })
    }
    void load().catch(handleError)

    return () => {
      disposed = true
      if (autosaveTimer !== null) window.clearTimeout(autosaveTimer)
      saveRef.current = null
      reloadRef.current = null
      parentSubscription?.()
      parentBridge?.dispose()
      commandSubscription?.dispose()
      container.removeEventListener('beforeinput', preventReadOnlyMutation, true)
      container.removeEventListener('paste', preventReadOnlyMutation, true)
      container.removeEventListener('cut', preventReadOnlyMutation, true)
      container.removeEventListener('drop', preventReadOnlyMutation, true)
      container.removeEventListener('keydown', preventReadOnlyKey, true)
      univer.dispose()
    }
  }, [])

  return (
    <main
      className="office-viewer-shell"
      data-field-decoration={fieldDecorationVerified ? 'verified' : 'pending'}
      data-readonly={projectionMetadata?.readOnly ? 'true' : 'false'}
    >
      <header className="office-viewer-toolbar">
        <div>
          <strong>小规文档工作表面</strong>
          <span className="office-viewer-badge">单机试验</span>
          {projectionMetadata ? <span className="office-viewer-badge">DOCX 原结构导入</span> : null}
          {projectionMetadata?.readOnly ? <span className="office-viewer-badge">只读</span> : null}
          {fieldDecorationVerified ? <span className="office-viewer-badge">字段已定位</span> : null}
        </div>
        <div className="office-viewer-actions">
          <span className="office-viewer-status">{status}</span>
          <button type="button" onClick={() => void reloadRef.current?.()}>
            重新载入
          </button>
          {!projectionMetadata?.readOnly ? (
            <button type="button" className="primary" onClick={() => void saveRef.current?.()}>
              保存工作副本
            </button>
          ) : null}
        </div>
      </header>
      {projectionMetadata?.warnings[0] ? (
        <div className="office-viewer-warning">{projectionMetadata.warnings[0]}</div>
      ) : null}
      {error ? <div className="office-viewer-error">{error}</div> : null}
      <section ref={containerRef} className="office-viewer-canvas" aria-label="小规文档编辑区域" />
    </main>
  )
}

function createBlankDocument(id: string, title: string): IDocumentData {
  return {
    id,
    title,
    documentStyle: {
      pageSize: {
        width: MODERN_DOCUMENT_WIDTH[ModernDocumentWidthMode.MEDIUM],
        height: 842 / 0.75,
      },
      documentFlavor: DocumentFlavor.MODERN,
      marginTop: 50,
      marginBottom: 50,
      marginRight: 50,
      marginLeft: 50,
      renderConfig: {
        zeroWidthParagraphBreak: 0,
        vertexAngle: 0,
        centerAngle: 0,
        background: { rgb: '#cccccc' },
      },
      autoHyphenation: 1,
      doNotHyphenateCaps: 0,
      consecutiveHyphenLimit: 2,
      defaultHeaderId: '',
      defaultFooterId: '',
      evenPageHeaderId: '',
      evenPageFooterId: '',
      firstPageHeaderId: '',
      firstPageFooterId: '',
      evenAndOddHeaders: 0,
      useFirstPageHeaderFooter: 0,
      marginHeader: 30,
      marginFooter: 30,
    },
    body: {
      dataStream: '\r\n',
      textRuns: [],
      paragraphs: [
        {
          startIndex: 0,
          paragraphStyle: {
            spaceAbove: { v: 0 },
            lineSpacing: DEFAULT_DOCUMENT_PARAGRAPH_LINE_SPACING,
            spaceBelow: { v: 8 },
          },
        },
      ],
      sectionBreaks: [{ startIndex: 1 }],
      customBlocks: [],
      customRanges: [],
      tables: [],
    },
  }
}

function expectedRangesAfterReplacement(
  plans: readonly { occurrenceId: string; start: number; end: number }[],
  value: string,
): Map<string, { start: number; end: number }> {
  const ranges = new Map<string, { start: number; end: number }>()
  let shift = 0
  for (const plan of [...plans].sort((left, right) => left.start - right.start)) {
    const start = plan.start + shift
    const end = start + value.length
    ranges.set(plan.occurrenceId, { start, end })
    shift += value.length - (plan.end - plan.start)
  }
  return ranges
}

function withoutPrivateProjectionData(projection: OfficeStructuredDocumentProjectionV1): ProjectionMetadataV1 {
  const { plainText: _plainText, univerDocument: _univerDocument, ...metadata } = projection
  return metadata
}

function occurrenceAtSelection(
  occurrences: ProjectionMetadataV1['occurrences'],
  params: ISetTextSelectionsOperationParams,
): ProjectionMetadataV1['occurrences'][number] | null {
  const range = params.ranges?.[0]
  if (!range || range.segmentId) return null
  const start = Math.min(range.startOffset, range.endOffset)
  const end = Math.max(range.startOffset, range.endOffset)
  return occurrences.find((occurrence) => (
    start === end
      ? occurrence.startUtf16 <= start && start <= occurrence.endUtf16Exclusive
      : start < occurrence.endUtf16Exclusive && occurrence.startUtf16 < end
  )) ?? null
}

function replacementShiftBefore(
  plans: readonly { start: number; end: number }[],
  value: string,
  offset: number,
): number {
  return plans.reduce(
    (shift, plan) => plan.end <= offset ? shift + value.length - (plan.end - plan.start) : shift,
    0,
  )
}

function fieldDecorationVerifiedFromDocument(document: ReturnType<FUniver['getActiveDocument']>): boolean {
  return (
    document?.getSnapshot().body?.customDecorations?.some((decoration) => decoration.id.startsWith('xiaogui.')) ?? false
  )
}
