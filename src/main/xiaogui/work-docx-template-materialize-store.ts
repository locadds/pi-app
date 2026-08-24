import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  TemplateMaterializePlanV1,
  TemplateMaterializeReceiptV1,
  TemplateMaterializeStatusV1,
} from '@shared/xiaogui-work-docx-template-materialize'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

export interface StoredTemplateMaterializeRecordV1 {
  operationId: string
  address: SessionAddressV1
  reportId: string
  sourcePath: string
  sourceSha256: string
  decisionSha256: string
  preparedRunId: string
  previewPath: string
  plan: TemplateMaterializePlanV1
  status: TemplateMaterializeStatusV1
  createdAt: string
  updatedAt: string
  publishedPath?: string
  receipt?: TemplateMaterializeReceiptV1
}

type MaterializeRow = {
  operation_id: string
  project_id: string
  session_key: string
  report_id: string
  source_path: string
  source_sha256: string
  decision_sha256: string
  prepared_run_id: string
  preview_path: string
  plan_json: string
  status: TemplateMaterializeStatusV1
  created_at: string
  updated_at: string
  published_path: string | null
  receipt_json: string | null
}

function parseRow(row: MaterializeRow): StoredTemplateMaterializeRecordV1 {
  return {
    operationId: row.operation_id,
    address: { projectId: row.project_id, sessionKey: row.session_key } as SessionAddressV1,
    reportId: row.report_id,
    sourcePath: row.source_path,
    sourceSha256: row.source_sha256,
    decisionSha256: row.decision_sha256,
    preparedRunId: row.prepared_run_id,
    previewPath: row.preview_path,
    plan: JSON.parse(row.plan_json) as TemplateMaterializePlanV1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.published_path ? { publishedPath: row.published_path } : {}),
    ...(row.receipt_json
      ? { receipt: JSON.parse(row.receipt_json) as TemplateMaterializeReceiptV1 }
      : {}),
  }
}

export class WorkDocxTemplateMaterializeStoreV1 {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS template_materializations_v1 (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        report_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        decision_sha256 TEXT NOT NULL,
        prepared_run_id TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_path TEXT,
        receipt_json TEXT
      );
      CREATE INDEX IF NOT EXISTS template_materializations_v1_scope_updated
        ON template_materializations_v1(project_id, session_key, updated_at DESC);
      CREATE INDEX IF NOT EXISTS template_materializations_v1_project_created
        ON template_materializations_v1(project_id, created_at ASC);
    `)
  }

  create(record: StoredTemplateMaterializeRecordV1): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `DELETE FROM template_materializations_v1
            WHERE project_id = ? AND session_key = ? AND status IN ('CANCELLED', 'STALE')`,
        )
        .run(record.address.projectId, record.address.sessionKey)
      this.db
        .prepare(
          `INSERT INTO template_materializations_v1 (
            operation_id, project_id, session_key, report_id, source_path,
            source_sha256, decision_sha256, prepared_run_id, preview_path,
            plan_json, status, created_at, updated_at, published_path, receipt_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.operationId,
          record.address.projectId,
          record.address.sessionKey,
          record.reportId,
          record.sourcePath,
          record.sourceSha256,
          record.decisionSha256,
          record.preparedRunId,
          record.previewPath,
          JSON.stringify(record.plan),
          record.status,
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
        // SQLite may already have rolled back.
      }
      throw error
    }
  }

  latest(
    address: SessionAddressV1,
    statuses?: readonly TemplateMaterializeStatusV1[],
  ): StoredTemplateMaterializeRecordV1 | null {
    const statusClause = statuses?.length
      ? ` AND status IN (${statuses.map(() => '?').join(', ')})`
      : ''
    const row = this.db
      .prepare(
        `SELECT operation_id, project_id, session_key, report_id, source_path,
                source_sha256, decision_sha256, prepared_run_id, preview_path,
                plan_json, status, created_at, updated_at, published_path, receipt_json
           FROM template_materializations_v1
          WHERE project_id = ? AND session_key = ?${statusClause}
          ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      )
      .get(address.projectId, address.sessionKey, ...(statuses ?? [])) as MaterializeRow | undefined
    return row ? parseRow(row) : null
  }

  save(record: StoredTemplateMaterializeRecordV1): void {
    const result = this.db
      .prepare(
        `UPDATE template_materializations_v1
            SET source_path = ?, source_sha256 = ?, decision_sha256 = ?,
                prepared_run_id = ?, preview_path = ?, plan_json = ?, status = ?,
                updated_at = ?, published_path = ?, receipt_json = ?
          WHERE operation_id = ? AND project_id = ? AND session_key = ?`,
      )
      .run(
        record.sourcePath,
        record.sourceSha256,
        record.decisionSha256,
        record.preparedRunId,
        record.previewPath,
        JSON.stringify(record.plan),
        record.status,
        record.updatedAt,
        record.publishedPath ?? null,
        record.receipt ? JSON.stringify(record.receipt) : null,
        record.operationId,
        record.address.projectId,
        record.address.sessionKey,
      )
    if (result.changes !== 1) throw new Error('TEMPLATE_MATERIALIZE_RECORD_NOT_FOUND')
  }

  close(): void {
    this.db.close()
  }
}
