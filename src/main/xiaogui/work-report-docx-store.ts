import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  WorkReportDocxPlanV1,
  WorkReportDocxReceiptV1,
  WorkReportDocxStatusV1,
  WorkReportDraftV1,
} from '@shared/xiaogui-work-report-docx'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

export interface StoredWorkReportDocxRecordV1 {
  operationId: string
  address: SessionAddressV1
  draft: WorkReportDraftV1
  status: WorkReportDocxStatusV1
  preparedRunId: string
  previewPath: string
  plan: WorkReportDocxPlanV1
  createdAt: string
  updatedAt: string
  publishedPath?: string
  receipt?: WorkReportDocxReceiptV1
}

type Row = {
  operation_id: string
  project_id: string
  session_key: string
  draft_json: string
  status: WorkReportDocxStatusV1
  prepared_run_id: string
  preview_path: string
  plan_json: string
  created_at: string
  updated_at: string
  published_path: string | null
  receipt_json: string | null
}

function parse(row: Row): StoredWorkReportDocxRecordV1 {
  return {
    operationId: row.operation_id,
    address: { projectId: row.project_id, sessionKey: row.session_key } as SessionAddressV1,
    draft: JSON.parse(row.draft_json) as WorkReportDraftV1,
    status: row.status,
    preparedRunId: row.prepared_run_id,
    previewPath: row.preview_path,
    plan: JSON.parse(row.plan_json) as WorkReportDocxPlanV1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.published_path ? { publishedPath: row.published_path } : {}),
    ...(row.receipt_json
      ? { receipt: JSON.parse(row.receipt_json) as WorkReportDocxReceiptV1 }
      : {}),
  }
}

/** 草稿、预览路径和发布路径只保存在主进程私有 SQLite 中。 */
export class WorkReportDocxStoreV1 {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_report_docx_v1 (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        status TEXT NOT NULL,
        prepared_run_id TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_path TEXT,
        receipt_json TEXT
      );
      CREATE INDEX IF NOT EXISTS work_report_docx_v1_scope_updated
        ON work_report_docx_v1(project_id, session_key, updated_at DESC);
    `)
  }

  create(record: StoredWorkReportDocxRecordV1): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `DELETE FROM work_report_docx_v1
           WHERE project_id = ? AND session_key = ? AND status IN ('PREPARED', 'CANCELLED')`,
        )
        .run(record.address.projectId, record.address.sessionKey)
      this.db
        .prepare(
          `INSERT INTO work_report_docx_v1 (
            operation_id, project_id, session_key, draft_json, status, prepared_run_id,
            preview_path, plan_json, created_at, updated_at, published_path, receipt_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.operationId,
          record.address.projectId,
          record.address.sessionKey,
          JSON.stringify(record.draft),
          record.status,
          record.preparedRunId,
          record.previewPath,
          JSON.stringify(record.plan),
          record.createdAt,
          record.updatedAt,
          record.publishedPath ?? null,
          record.receipt ? JSON.stringify(record.receipt) : null,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* transaction already rolled back */
      }
      throw error
    }
  }

  latest(
    address: SessionAddressV1,
    statuses?: readonly WorkReportDocxStatusV1[],
  ): StoredWorkReportDocxRecordV1 | null {
    const clause = statuses?.length
      ? ` AND status IN (${statuses.map(() => '?').join(', ')})`
      : ''
    const row = this.db
      .prepare(
        `SELECT * FROM work_report_docx_v1
         WHERE project_id = ? AND session_key = ?${clause}
         ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      )
      .get(address.projectId, address.sessionKey, ...(statuses ?? [])) as Row | undefined
    return row ? parse(row) : null
  }

  save(record: StoredWorkReportDocxRecordV1): void {
    const result = this.db
      .prepare(
        `UPDATE work_report_docx_v1 SET
          draft_json = ?, status = ?, prepared_run_id = ?, preview_path = ?, plan_json = ?,
          updated_at = ?, published_path = ?, receipt_json = ?
         WHERE operation_id = ? AND project_id = ? AND session_key = ?`,
      )
      .run(
        JSON.stringify(record.draft),
        record.status,
        record.preparedRunId,
        record.previewPath,
        JSON.stringify(record.plan),
        record.updatedAt,
        record.publishedPath ?? null,
        record.receipt ? JSON.stringify(record.receipt) : null,
        record.operationId,
        record.address.projectId,
        record.address.sessionKey,
      )
    if (result.changes !== 1) throw new Error('WORK_REPORT_DOCX_RECORD_NOT_FOUND')
  }

  close(): void {
    this.db.close()
  }
}
