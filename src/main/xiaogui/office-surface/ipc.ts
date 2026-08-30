import { createHash, randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  readOfficeSurfaceModeV1,
  type OfficeSnapshotV1,
  type OfficeSurfaceModeV1,
  type OfficeSurfaceSessionReadyV1,
} from '@shared/xiaogui-office-surface'
import { registerHandler, registerHandlerWithSchema } from '../../ipc/registry'
import { getDefaultDocumentReviewRendererV1 } from '../work-document-review-renderer-composition'
import { projectDocxToUniverV1 } from './docx-univer-projection'
import {
  officeGatewaySupervisorV1,
  type OfficeGatewaySessionV1,
} from './gateway-supervisor'

const SourceAnchorSchema = z.object({
  part: z.enum(['BODY', 'HEADER', 'FOOTER', 'TABLE_CELL', 'TEXT_BOX', 'DRAWING']),
  sectionIndex: z.number().int().positive().optional(),
  partIndex: z.number().int().positive().optional(),
  paragraphIndex: z.number().int().positive().optional(),
  tableIndex: z.number().int().positive().optional(),
  rowIndex: z.number().int().positive().optional(),
  cellIndex: z.number().int().positive().optional(),
  drawingIndex: z.number().int().positive().optional(),
}).strict()

const PrepareSchema = z.object({
  purpose: z.enum([
    'TEMPLATE_DRAFT',
    'TEMPLATE_ADVANCED_REVIEW',
    'MATERIALIZED_PREVIEW',
    'TEMPLATE_LIBRARY_PREVIEW',
  ]),
  documentToken: z.string().min(16).max(256),
  title: z.string().trim().min(1).max(160),
  fields: z.array(z.object({
    fieldId: z.string().min(1).max(160),
    displayName: z.string().min(1).max(120),
    occurrenceIds: z.array(z.string().min(1).max(160)).max(2_000),
  }).strict()).max(500).optional(),
  occurrences: z.array(z.object({
    occurrenceId: z.string().min(1).max(160),
    fieldId: z.string().min(1).max(160),
    originalText: z.string().min(1).max(500),
    sourceAnchor: SourceAnchorSchema,
    textRange: z.object({
      startUtf16: z.number().int().nonnegative(),
      endUtf16Exclusive: z.number().int().positive(),
    }).strict().optional(),
    state: z.enum(['FIELD', 'WARNING', 'BLOCKING']),
  }).strict()).max(2_000).optional(),
}).strict()

const ReleaseSchema = z.object({ sessionId: z.string().uuid() }).strict()

const sessions = new Map<string, OfficeGatewaySessionV1>()

function currentMode(): OfficeSurfaceModeV1 {
  if (process.env.XIAOGUI_OFFICE_TEST === '1') return 'UNIVER_EXPERIMENTAL'
  return readOfficeSurfaceModeV1()
}

export function registerOfficeSurfaceHandlersV1(): void {
  registerHandler('ipc:xiaogui.officeSurface.mode.get', async () => ({
    mode: currentMode(),
    label: '小规 Office Surface 单机试验',
    limitations: [
      '当前直接把安全解析后的 DOCX 段落、样式和表格导入 Univer；复杂浮动对象仍可能近似显示。',
      '页面换行不冒充 Microsoft Word 像素级一致，正式导出仍需通过格式回归门。',
    ],
  }))

  registerHandlerWithSchema(
    'ipc:xiaogui.officeSurface.session.prepare',
    PrepareSchema,
    async (request): Promise<OfficeSurfaceSessionReadyV1> => {
      const mode = currentMode()
      if (mode === 'OFF') throw new Error('OFFICE_SURFACE_UNAVAILABLE')

      const asset = getDefaultDocumentReviewRendererV1()
        .readDocumentAssetByToken(request.documentToken)
      const content = Buffer.from(asset.docxBytes)
      try {
        const projection = await projectDocxToUniverV1({
          content,
          title: request.title,
          purpose: request.purpose,
          readOnly: request.purpose !== 'TEMPLATE_DRAFT',
          fields: request.fields,
          occurrences: request.occurrences,
        })
        const persistenceKey = createHash('sha256')
          // v2 invalidates early worktrees that stored LF-only text. Those
          // snapshots were structurally present but rendered as a blank page.
          .update(`${projection.sourceSha256}\0${request.purpose}\0office-surface-v4`)
          .digest('hex')
        const gateway = await officeGatewaySupervisorV1.start({
          initialSnapshot: projection as unknown as OfficeSnapshotV1,
          persistenceKey,
        })
        const sessionId = randomUUID()
        sessions.set(sessionId, gateway)
        return {
          sessionVersion: 1,
          sessionId,
          mode,
          gatewayOrigin: gateway.origin,
          gatewayAccessToken: gateway.accessToken,
          sourceSha256: projection.sourceSha256,
          readOnly: projection.readOnly,
          mappedOccurrenceIds: projection.occurrences.map((occurrence) => occurrence.occurrenceId),
          warnings: projection.warnings,
          statistics: projection.statistics,
        }
      } finally {
        content.fill(0)
      }
    },
  )

  registerHandlerWithSchema(
    'ipc:xiaogui.officeSurface.session.release',
    ReleaseSchema,
    async ({ sessionId }) => {
      const gateway = sessions.get(sessionId)
      if (!gateway) return { released: false }
      sessions.delete(sessionId)
      await gateway.close()
      return { released: true }
    },
  )
}

export async function closeOfficeSurfaceSessionsV1(): Promise<void> {
  const active = [...sessions.values()]
  sessions.clear()
  await Promise.allSettled(active.map((session) => session.close()))
  await officeGatewaySupervisorV1.closeAll()
}
