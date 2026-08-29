import { useEffect, useRef, useState } from 'react'
import { LocaleType, LogLevel, mergeLocales, Univer, type IDocumentData } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import UniverDesignZhCN from '@univerjs/design/locale/zh-CN'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import '@univerjs/docs-ui/facade'
import UniverDocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverUIPlugin } from '@univerjs/ui'
import UniverUIZhCN from '@univerjs/ui/locale/zh-CN'
import type { OfficeSnapshotV1 } from '../../packages/shared/xiaogui-office-surface'
import { OfficeGatewayClientV1 } from './core/gateway-client'
import { createOfficeParentBridgeV1 } from './core/parent-bridge'
import { ensureSyntheticFieldDecorationV1 } from './core/synthetic-field-decoration'

type ViewerStatus = '正在载入' | '可以编辑' | '有未保存修改' | '正在保存' | '已保存' | '载入失败'

export function OfficeViewerApp(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
  const reloadRef = useRef<(() => Promise<void>) | null>(null)
  const fieldDecorationVerifiedRef = useRef(false)
  const [status, setStatus] = useState<ViewerStatus>('正在载入')
  const [error, setError] = useState<string | null>(null)
  const [fieldDecorationVerified, setFieldDecorationVerified] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    const gateway = new OfficeGatewayClientV1()
    const parentBridge = createOfficeParentBridgeV1()
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

    const load = async (): Promise<void> => {
      suppressDirty = true
      setStatus('正在载入')
      const envelope = await gateway.load()
      if (document) {
        univer.dispose()
        throw new Error('当前验证版不支持在同一界面热替换文档，请重新打开界面。')
      }
      const hasSnapshot = Object.keys(envelope.snapshot).length > 0
      document = univerAPI.createUniverDoc(hasSnapshot
        ? envelope.snapshot as Partial<IDocumentData>
        : createSyntheticDocument())
      if (!hasSnapshot) {
        await document.appendText([
          '小规文档界面验证',
          '',
          '这是独立 Office Surface 的合成文档。',
          '本轮只验证中文编辑、快照保存和工作副本边界，不代表已经支持 DOCX 导入导出。',
        ].join('\n'))
      }
      const decoration = await ensureSyntheticFieldDecorationV1(document, univerAPI)
      if (!decoration.verified) throw new Error(decoration.reason ?? '非破坏性字段标记验证失败。')
      fieldDecorationVerifiedRef.current = true
      setFieldDecorationVerified(true)
      if (!hasSnapshot || decoration.created) {
        await gateway.save(document.getSnapshot() as unknown as OfficeSnapshotV1)
      }
      if (disposed) return
      suppressDirty = false
      setStatus('可以编辑')
      parentBridge?.post({
        type: 'VIEWER_READY',
        capabilities: {
          readSnapshot: true,
          writeSnapshot: true,
          syntheticDocument: true,
          docxImport: false,
          docxExport: false,
          nonDestructiveDecoration: true,
        },
      })
    }

    const save = async (): Promise<void> => {
      if (!document) return
      setStatus('正在保存')
      suppressDirty = true
      const headSha256 = await gateway.save(document.getSnapshot() as unknown as OfficeSnapshotV1)
      suppressDirty = false
      setStatus('已保存')
      parentBridge?.post({ type: 'VIEWER_DIRTY_STATE', dirty: false, headSha256 })
    }

    saveRef.current = save
    reloadRef.current = async () => {
      window.location.reload()
    }
    commandSubscription = univerAPI.onCommandExecuted(() => {
      if (suppressDirty || !document) return
      setStatus('有未保存修改')
      parentBridge?.post({
        type: 'VIEWER_DIRTY_STATE',
        dirty: true,
        headSha256: gateway.getHeadSha256(),
      })
    })
    parentSubscription = parentBridge?.subscribe((message) => {
      if (message.type === 'PARENT_SAVE') void save().catch(handleError)
      if (message.type === 'PARENT_RELOAD') window.location.reload()
      if (message.type === 'PARENT_DISPOSE') univer.dispose()
      if (message.type === 'PARENT_PING') {
        parentBridge.post({
          type: 'VIEWER_READY',
          capabilities: {
            readSnapshot: true,
            writeSnapshot: true,
            syntheticDocument: true,
            docxImport: false,
            docxExport: false,
            nonDestructiveDecoration: fieldDecorationVerifiedRef.current,
          },
        })
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
      saveRef.current = null
      reloadRef.current = null
      parentSubscription?.()
      commandSubscription?.dispose()
      univer.dispose()
    }
  }, [])

  return (
    <main
      className="office-viewer-shell"
      data-field-decoration={fieldDecorationVerified ? 'verified' : 'pending'}
    >
      <header className="office-viewer-toolbar">
        <div>
          <strong>小规文档界面</strong>
          <span className="office-viewer-badge">验证版</span>
          {fieldDecorationVerified ? <span className="office-viewer-badge">字段标记已验证</span> : null}
        </div>
        <div className="office-viewer-actions">
          <span className="office-viewer-status">{status}</span>
          <button type="button" onClick={() => void reloadRef.current?.()}>重新载入</button>
          <button type="button" className="primary" onClick={() => void saveRef.current?.()}>保存工作副本</button>
        </div>
      </header>
      {error ? <div className="office-viewer-error">{error}</div> : null}
      <section ref={containerRef} className="office-viewer-canvas" aria-label="小规文档编辑区域" />
    </main>
  )
}

function createSyntheticDocument(): IDocumentData {
  return {
    id: 'xiaogui-office-spike',
    title: '小规 Office Surface 验证文档',
    documentStyle: {},
    body: {
      dataStream: '\r\n',
      textRuns: [],
      paragraphs: [{ startIndex: 0 }],
      sectionBreaks: [],
      customBlocks: [],
      customRanges: [],
      tables: [],
    },
  }
}
