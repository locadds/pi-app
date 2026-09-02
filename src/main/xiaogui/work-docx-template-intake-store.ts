import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  TemplateIntakeDecisionV1,
  TemplateIntakeDraftDecisionItemV1,
  TemplateIntakeReportStatusV1,
  TemplateIntakeReportV1,
} from '@shared/xiaogui-work-docx-template-intake'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

const MAX_REPORTS_PER_PROJECT = 20
const MAX_REPORTS_GLOBAL = 100

export class TemplateIntakeStoreLimitErrorV1 extends Error {
  constructor() {
    super('TEMPLATE_INTAKE_REPORT_LIMIT_REACHED')
  }
}

export interface StoredTemplateIntakeRecordV1 {
  address: SessionAddressV1
  sourcePath: string
  sourceSha256: string
  sourceDisplayName: string
  sourceBytes: number
  report: TemplateIntakeReportV1
  draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
  decision?: TemplateIntakeDecisionV1
}

type ReportRow = {
  project_id: string
  session_key: string
  source_path: string
  source_sha256: string
  source_display_name: string
  source_bytes: number
  report_json: string
  draft_json: string
  decision_json: string | null
}

function parseRow(row: ReportRow): StoredTemplateIntakeRecordV1 {
  return {
    address: { projectId: row.project_id, sessionKey: row.session_key } as SessionAddressV1,
    sourcePath: row.source_path,
    sourceSha256: row.source_sha256,
    sourceDisplayName: row.source_display_name,
    sourceBytes: row.source_bytes,
    report: JSON.parse(row.report_json) as TemplateIntakeReportV1,
    draftDecisions: JSON.parse(row.draft_json) as TemplateIntakeDraftDecisionItemV1[],
    ...(row.decision_json
      ? { decision: JSON.parse(row.decision_json) as TemplateIntakeDecisionV1 }
      : {}),
  }
}

export class WorkDocxTemplateIntakeStoreV1 {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS template_intake_reports_v1 (
        report_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_display_name TEXT NOT NULL,
        source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
        report_json TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        decision_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS template_intake_reports_v1_scope_updated
        ON template_intake_reports_v1(project_id, session_key, updated_at DESC);
      CREATE INDEX IF NOT EXISTS template_intake_reports_v1_project_created
        ON template_intake_reports_v1(project_id, created_at ASC);
    `)
  }

  create(record: StoredTemplateIntakeRecordV1): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.pruneForInsert(record.address.projectId)
      this.db
        .prepare(
          `INSERT INTO template_intake_reports_v1 (
            report_id, project_id, session_key, source_path, source_sha256,
            source_display_name, source_bytes, report_json, draft_json,
            decision_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.report.reportId,
          record.address.projectId,
          record.address.sessionKey,
          record.sourcePath,
          record.sourceSha256,
          record.sourceDisplayName,
          record.sourceBytes,
          JSON.stringify(record.report),
          JSON.stringify(record.draftDecisions),
          record.decision ? JSON.stringify(record.decision) : null,
          record.report.status,
          record.report.createdAt,
          record.report.updatedAt,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackQuietly()
      throw error
    }
  }

  get(address: SessionAddressV1, reportId: string): StoredTemplateIntakeRecordV1 | null {
    const row = this.db
      .prepare(
        `SELECT project_id, session_key, source_path, source_sha256, source_display_name,
                source_bytes, report_json, draft_json, decision_json
           FROM template_intake_reports_v1
          WHERE report_id = ? AND project_id = ? AND session_key = ?`,
      )
      .get(reportId, address.projectId, address.sessionKey) as ReportRow | undefined
    return row ? parseRow(row) : null
  }

  latest(address: SessionAddressV1): StoredTemplateIntakeRecordV1 | null {
    const row = this.db
      .prepare(
        `SELECT project_id, session_key, source_path, source_sha256, source_display_name,
                source_bytes, report_json, draft_json, decision_json
           FROM template_intake_reports_v1
          WHERE project_id = ? AND session_key = ?
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
      )
      .get(address.projectId, address.sessionKey) as ReportRow | undefined
    return row ? parseRow(row) : null
  }

  latestConfirmed(address: SessionAddressV1): StoredTemplateIntakeRecordV1 | null {
    const row = this.db
      .prepare(
        `SELECT project_id, session_key, source_path, source_sha256, source_display_name,
                source_bytes, report_json, draft_json, decision_json
           FROM template_intake_reports_v1
          WHERE project_id = ? AND session_key = ? AND status = 'CONFIRMED'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1`,
      )
      .get(address.projectId, address.sessionKey) as ReportRow | undefined
    return row ? parseRow(row) : null
  }

  save(record: StoredTemplateIntakeRecordV1): void {
    const result = this.db
      .prepare(
        `UPDATE template_intake_reports_v1
            SET source_path = ?, source_sha256 = ?, source_display_name = ?, source_bytes = ?,
                report_json = ?, draft_json = ?, decision_json = ?, status = ?, updated_at = ?
          WHERE report_id = ? AND project_id = ? AND session_key = ?`,
      )
      .run(
        record.sourcePath,
        record.sourceSha256,
        record.sourceDisplayName,
        record.sourceBytes,
        JSON.stringify(record.report),
        JSON.stringify(record.draftDecisions),
        record.decision ? JSON.stringify(record.decision) : null,
        record.report.status,
        record.report.updatedAt,
        record.report.reportId,
        record.address.projectId,
        record.address.sessionKey,
      )
    if (result.changes !== 1) throw new Error('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
  }

  delete(address: SessionAddressV1, reportId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM template_intake_reports_v1
          WHERE report_id = ? AND project_id = ? AND session_key = ?`,
      )
      .run(reportId, address.projectId, address.sessionKey)
    return result.changes === 1
  }

  countPersistedTextOccurrences(needle: string): number {
    if (!needle) return 0
    const rows = this.db
      .prepare(
        `SELECT report_json, draft_json, COALESCE(decision_json, '') AS decision_json
           FROM template_intake_reports_v1`,
      )
      .all() as Array<{ report_json: string; draft_json: string; decision_json: string }>
    return rows.reduce(
      (count, row) =>
        count +
        (row.report_json.includes(needle) ? 1 : 0) +
        (row.draft_json.includes(needle) ? 1 : 0) +
        (row.decision_json.includes(needle) ? 1 : 0),
      0,
    )
  }

  close(): void {
    this.db.close()
  }

  private pruneForInsert(projectId: string): void {
    while (this.count('project_id = ?', projectId) >= MAX_REPORTS_PER_PROJECT) {
      if (!this.deleteOldestUnconfirmed('project_id = ?', projectId)) {
        throw new TemplateIntakeStoreLimitErrorV1()
      }
    }
    while (this.count('1 = 1') >= MAX_REPORTS_GLOBAL) {
      if (!this.deleteOldestUnconfirmed('1 = 1')) {
        throw new TemplateIntakeStoreLimitErrorV1()
      }
    }
  }

  private count(where: string, ...params: string[]): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM template_intake_reports_v1 WHERE ${where}`)
      .get(...params) as { count: number }
    return Number(row.count)
  }

  private deleteOldestUnconfirmed(where: string, ...params: string[]): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM template_intake_reports_v1
          WHERE report_id = (
            SELECT report_id FROM template_intake_reports_v1
             WHERE ${where} AND status <> 'CONFIRMED'
             ORDER BY created_at ASC, report_id ASC
             LIMIT 1
          )`,
      )
      .run(...params)
    return result.changes === 1
  }

  private rollbackQuietly(): void {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // 已由 SQLite 自动回滚时无需再处理。
    }
  }
}

export function withTemplateIntakeStatusV1(
  report: TemplateIntakeReportV1,
  status: TemplateIntakeReportStatusV1,
  updatedAt: string,
): TemplateIntakeReportV1 {
  return { ...report, status, updatedAt }
}
