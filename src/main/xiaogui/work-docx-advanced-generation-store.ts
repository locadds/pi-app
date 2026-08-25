import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AdvancedGenerationPlanV1,
  AdvancedGenerationReceiptV1,
  AdvancedGenerationStatusV1,
  AdvancedTemplateDataV1,
  AdvancedTemplateSchemaV1,
} from '@shared/xiaogui-work-docx-advanced-generation'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

export interface StoredAdvancedGenerationRecordV1 {
  operationId: string
  address: SessionAddressV1
  templatePath: string
  templateSha256: string
  schema: AdvancedTemplateSchemaV1
  status: AdvancedGenerationStatusV1
  selectedRunId: string
  createdAt: string
  updatedAt: string
  data?: AdvancedTemplateDataV1
  preparedRunId?: string
  previewPath?: string
  plan?: AdvancedGenerationPlanV1
  publishedPath?: string
  receipt?: AdvancedGenerationReceiptV1
}

type Row = {
  operation_id: string
  project_id: string
  session_key: string
  template_path: string
  template_sha256: string
  schema_json: string
  status: AdvancedGenerationStatusV1
  selected_run_id: string
  created_at: string
  updated_at: string
  data_json: string | null
  prepared_run_id: string | null
  preview_path: string | null
  plan_json: string | null
  published_path: string | null
  receipt_json: string | null
}

function parse(row: Row): StoredAdvancedGenerationRecordV1 {
  return {
    operationId: row.operation_id,
    address: { projectId: row.project_id, sessionKey: row.session_key } as SessionAddressV1,
    templatePath: row.template_path,
    templateSha256: row.template_sha256,
    schema: JSON.parse(row.schema_json) as AdvancedTemplateSchemaV1,
    status: row.status,
    selectedRunId: row.selected_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.data_json ? { data: JSON.parse(row.data_json) as AdvancedTemplateDataV1 } : {}),
    ...(row.prepared_run_id ? { preparedRunId: row.prepared_run_id } : {}),
    ...(row.preview_path ? { previewPath: row.preview_path } : {}),
    ...(row.plan_json ? { plan: JSON.parse(row.plan_json) as AdvancedGenerationPlanV1 } : {}),
    ...(row.published_path ? { publishedPath: row.published_path } : {}),
    ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as AdvancedGenerationReceiptV1 } : {}),
  }
}

export class WorkDocxAdvancedGenerationStoreV1 {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS advanced_generations_v1 (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        template_path TEXT NOT NULL,
        template_sha256 TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT,
        prepared_run_id TEXT,
        preview_path TEXT,
        plan_json TEXT,
        published_path TEXT,
        receipt_json TEXT
      );
      CREATE INDEX IF NOT EXISTS advanced_generations_v1_scope_updated
        ON advanced_generations_v1(project_id, session_key, updated_at DESC);
    `)
  }

  create(record: StoredAdvancedGenerationRecordV1): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`DELETE FROM advanced_generations_v1 WHERE project_id = ? AND session_key = ? AND status IN ('SELECTED', 'PREPARED', 'CANCELLED', 'STALE')`).run(record.address.projectId, record.address.sessionKey)
      this.db.prepare(`INSERT INTO advanced_generations_v1 (
        operation_id, project_id, session_key, template_path, template_sha256, schema_json,
        status, selected_run_id, created_at, updated_at, data_json, prepared_run_id,
        preview_path, plan_json, published_path, receipt_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.operationId, record.address.projectId, record.address.sessionKey, record.templatePath,
        record.templateSha256, JSON.stringify(record.schema), record.status, record.selectedRunId,
        record.createdAt, record.updatedAt, record.data ? JSON.stringify(record.data) : null,
        record.preparedRunId ?? null, record.previewPath ?? null,
        record.plan ? JSON.stringify(record.plan) : null, record.publishedPath ?? null,
        record.receipt ? JSON.stringify(record.receipt) : null,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  latest(address: SessionAddressV1, statuses?: readonly AdvancedGenerationStatusV1[]): StoredAdvancedGenerationRecordV1 | null {
    const clause = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(', ')})` : ''
    const row = this.db.prepare(`SELECT * FROM advanced_generations_v1 WHERE project_id = ? AND session_key = ?${clause} ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(address.projectId, address.sessionKey, ...(statuses ?? [])) as Row | undefined
    return row ? parse(row) : null
  }

  save(record: StoredAdvancedGenerationRecordV1): void {
    const result = this.db.prepare(`UPDATE advanced_generations_v1 SET
      template_path = ?, template_sha256 = ?, schema_json = ?, status = ?, selected_run_id = ?,
      updated_at = ?, data_json = ?, prepared_run_id = ?, preview_path = ?, plan_json = ?,
      published_path = ?, receipt_json = ?
      WHERE operation_id = ? AND project_id = ? AND session_key = ?`).run(
      record.templatePath, record.templateSha256, JSON.stringify(record.schema), record.status,
      record.selectedRunId, record.updatedAt, record.data ? JSON.stringify(record.data) : null,
      record.preparedRunId ?? null, record.previewPath ?? null,
      record.plan ? JSON.stringify(record.plan) : null, record.publishedPath ?? null,
      record.receipt ? JSON.stringify(record.receipt) : null, record.operationId,
      record.address.projectId, record.address.sessionKey,
    )
    if (result.changes !== 1) throw new Error('ADVANCED_GENERATION_RECORD_NOT_FOUND')
  }

  close(): void { this.db.close() }
}
