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
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import '@univerjs/docs-ui/facade'
import UniverDocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverUIPlugin } from '@univerjs/ui'
import UniverUIZhCN from '@univerjs/ui/locale/zh-CN'

import {
  isOfficeStructuredDocumentProjectionV1,
  type OfficeSurfaceParentMessageV1,
  type OfficeSnapshotV1,
  type OfficeStructuredDocumentProjectionV1,
} from '@shared/xiaogui-office-surface'
import { OfficeGatewayClientV1 } from './core/gateway-client'
import type { OfficeParentBridgeV1 } from './core/parent-bridge'
import { ensureSyntheticFieldDecorationV1 } from './core/synthetic-field-decoration'
import {
  isOfficeUniverWorktreeEnvelopeV1,
  materializeStructuredProjectionV1,
  occurrenceDecorationIdV1,
  worktreeEnvelopeV1,
  type OfficeUniverWorktreeEnvelopeV1,
} from './core/structured-docx-projection'

type ViewerStatus = '正在载入' | '可以编辑' | '有未保存修改' | '正在保存' | '已保存' | '载入失败'
type ProjectionMetadataV1 = OfficeUniverWorktreeEnvelopeV1['projection']

export function OfficeViewerApp({
  parentBridge,
}: {
  parentBridge: OfficeParentBridgeV1 | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
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
        [LocaleType.ZH_CN]: mergeLocales(UniverDesignZhCN, UniverDocsUIZhCN, UniverUIZhCN),
      },
      logLevel: LogLevel.WARN,
    })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container })
    univer.registerPlugin(UniverDocsUIPlugin)
    const univerAPI = FUniver.newAPI(univer)
    let commandSubscription: { dispose(): void } | null = null
    let parentSubscription: (() => void) | null = null
    let document = univerAPI.getActiveDocument()
    let suppressDirty = false
    let activeProjection: ProjectionMetadataV1 | null = null

    const capabilities = () => ({
      readSnapshot: true,
      writeSnapshot: true,
      syntheticDocument: true,
      docxImport: false,
      docxExport: false,
      nonDestructiveDecoration: fieldDecorationVerifiedFromDocument(document),
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
        document = univerAPI.createUniverDoc(createBlankDocument(projection.documentId, projection.title))
        const materialized = await materializeStructuredProjectionV1(projection, document, univerAPI)
        activeProjection = withoutPlainText(projection)
        setProjectionMetadata(activeProjection)
        const saved = worktreeEnvelopeV1(document.getSnapshot(), projection)
        await gateway.save(saved as unknown as OfficeSnapshotV1)
        if (materialized.unmappedOccurrenceIds.length > 0) {
          setError(`${materialized.unmappedOccurrenceIds.length} 个字段位置未能在试验视图中定位，请用兼容视图核对。`)
        }
      } else if (isOfficeUniverWorktreeEnvelopeV1(envelope.snapshot)) {
        document = univerAPI.createUniverDoc(envelope.snapshot.document)
        activeProjection = envelope.snapshot.projection
        setProjectionMetadata(activeProjection)
      } else if (Object.keys(envelope.snapshot).length > 0) {
        document = univerAPI.createUniverDoc(envelope.snapshot as Partial<IDocumentData>)
      } else {
        document = univerAPI.createUniverDoc(createBlankDocument('xiaogui-office-spike', '小规 Office Surface 验证文档'))
        await document.insertParagraph([
          '小规文档界面验证',
          '',
          '这是独立 Office Surface 的合成文档。',
          '本轮只验证中文编辑、快照保存和工作副本边界，不代表已经支持 DOCX 导入导出。',
        ].join('\n'))
        const decoration = await ensureSyntheticFieldDecorationV1(document, univerAPI)
        if (!decoration.verified) throw new Error(decoration.reason ?? '非破坏性字段标记验证失败。')
        await gateway.save(document.getSnapshot() as unknown as OfficeSnapshotV1)
      }

      if (disposed || !document) return
      loaded = true
      suppressDirty = false
      const verified = fieldDecorationVerifiedFromDocument(document)
      setFieldDecorationVerified(verified)
      setStatus('可以编辑')
      parentBridge?.post({ type: 'VIEWER_READY', capabilities: capabilities() })
    }

    const save = async (): Promise<void> => {
      if (!document) return
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
      parentBridge?.post({ type: 'VIEWER_DIRTY_STATE', dirty: false, headSha256 })
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
      const decoration = document.getSnapshot().body?.customDecorations?.find(
        (item) => item.id === occurrenceDecorationIdV1(occurrenceId),
      )
      if (decoration) document.setSelection(decoration.startIndex, decoration.endIndex + 1)
    }

    saveRef.current = save
    reloadRef.current = async () => window.location.reload()
    commandSubscription = univerAPI.onCommandExecuted(() => {
      if (suppressDirty || !document || !loaded) return
      setStatus('有未保存修改')
      parentBridge?.post({
        type: 'VIEWER_DIRTY_STATE',
        dirty: true,
        headSha256: gateway.getHeadSha256(),
      })
      scheduleAutosave()
    })
    parentSubscription = parentBridge?.subscribe((message: OfficeSurfaceParentMessageV1) => {
      if (message.type === 'PARENT_SAVE') void save().catch(handleError)
      else if (message.type === 'PARENT_RELOAD') window.location.reload()
      else if (message.type === 'PARENT_DISPOSE') univer.dispose()
      else if (message.type === 'PARENT_FOCUS_OCCURRENCE') focusOccurrence(message.occurrenceId)
      else if (message.type === 'PARENT_FOCUS_FIELD') {
        const occurrenceId = activeProjection?.fields.find((field) => field.fieldId === message.fieldId)?.occurrenceIds[0]
        if (occurrenceId) focusOccurrence(occurrenceId)
      } else if (message.type === 'PARENT_PING' && loaded) {
        parentBridge.post({ type: 'VIEWER_READY', capabilities: capabilities() })
      }
    }) ?? null

    const handleError = (reason: unknown): void => {
      const message = reason instanceof Error ? reason.message : '文档界面出现未知错误。'
      setError(message)
      setStatus('载入失败')
      parentBridge?.post({ type: 'VIEWER_ERROR', code: 'OFFICE_VIEWER_FAILED', message })
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
      univer.dispose()
    }
  }, [])

  return (
    <main className="office-viewer-shell" data-field-decoration={fieldDecorationVerified ? 'verified' : 'pending'}>
      <header className="office-viewer-toolbar">
        <div>
          <strong>小规文档工作表面</strong>
          <span className="office-viewer-badge">单机试验</span>
          {projectionMetadata ? <span className="office-viewer-badge">DOCX 结构视图</span> : null}
          {fieldDecorationVerified ? <span className="office-viewer-badge">字段已定位</span> : null}
        </div>
        <div className="office-viewer-actions">
          <span className="office-viewer-status">{status}</span>
          <button type="button" onClick={() => void reloadRef.current?.()}>重新载入</button>
          <button type="button" className="primary" onClick={() => void saveRef.current?.()}>保存工作副本</button>
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
      paragraphs: [{
        startIndex: 0,
        paragraphStyle: {
          spaceAbove: { v: 0 },
          lineSpacing: DEFAULT_DOCUMENT_PARAGRAPH_LINE_SPACING,
          spaceBelow: { v: 8 },
        },
      }],
      sectionBreaks: [{ startIndex: 1 }],
      customBlocks: [],
      customRanges: [],
      tables: [],
    },
  }
}

function withoutPlainText(projection: OfficeStructuredDocumentProjectionV1): ProjectionMetadataV1 {
  const { plainText: _plainText, ...metadata } = projection
  return metadata
}

function fieldDecorationVerifiedFromDocument(document: ReturnType<FUniver['getActiveDocument']>): boolean {
  return document?.getSnapshot().body?.customDecorations?.some(
    (decoration) => decoration.id.startsWith('xiaogui.'),
  ) ?? false
}
