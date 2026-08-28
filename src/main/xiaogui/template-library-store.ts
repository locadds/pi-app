import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  TemplateLibraryEntryStatusV1,
  TemplateLibraryFieldSummaryV1,
} from '@shared/xiaogui-template-library'

export interface StoredTemplateLibraryEntryV1 {
  entryId: string
  normalizedName: string
  name: string
  purpose?: string
  tags: readonly string[]
  latestVersionId: string
  status: TemplateLibraryEntryStatusV1
  createdAt: string
  updatedAt: string
  trashedAt?: string
}
export interface StoredTemplateLibraryVersionV1 {
  versionId: string
  entryId: string
  versionNumber: number
  assetSha256: string
  byteLength: number
  fields: readonly TemplateLibraryFieldSummaryV1[]
  createdAt: string
}

export interface StoredTemplateLibraryAssetV1 {
  sha256: string
  byteLength: number
  relativePath: string
  createdAt: string
}

export interface SaveTemplateLibraryVersionRecordV1 {
  entryId: string
  versionId: string
  normalizedName: string
  name: string
  purpose?: string
  tags: readonly string[]
  fields: readonly TemplateLibraryFieldSummaryV1[]
  sha256: string
  byteLength: number
  relativeAssetPath: string
  createdAt: string
}

type EntryRow = {
  entry_id: string
  normalized_name: string
  name: string
  purpose: string | null
  tags_json: string
  latest_version_id: string
  status: TemplateLibraryEntryStatusV1
  created_at: string
  updated_at: string
  trashed_at: string | null
}

type VersionRow = {
  version_id: string
  entry_id: string
  version_number: number
  asset_sha256: string
  byte_length: number
  fields_json: string
  created_at: string
}

type AssetRow = {
  sha256: string
  byte_length: number
  relative_path: string
  created_at: string
}

function parseStringArray(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('TEMPLATE_LIBRARY_CORRUPT_STRING_ARRAY')
  }
  return parsed
}

function parseFields(json: string): readonly TemplateLibraryFieldSummaryV1[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('TEMPLATE_LIBRARY_CORRUPT_FIELDS')
  return parsed as readonly TemplateLibraryFieldSummaryV1[]
}

function parseEntry(row: EntryRow): StoredTemplateLibraryEntryV1 {
  return {
    entryId: row.entry_id,
    normalizedName: row.normalized_name,
    name: row.name,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    tags: parseStringArray(row.tags_json),
    latestVersionId: row.latest_version_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.trashed_at ? { trashedAt: row.trashed_at } : {}),
  }
}

function parseVersion(row: VersionRow): StoredTemplateLibraryVersionV1 {
  return {
    versionId: row.version_id,
    entryId: row.entry_id,
    versionNumber: row.version_number,
    assetSha256: row.asset_sha256,
    byteLength: row.byte_length,
    fields: parseFields(row.fields_json),
    createdAt: row.created_at,
  }
}

function parseAsset(row: AssetRow): StoredTemplateLibraryAssetV1 {
  return {
    sha256: row.sha256,
    byteLength: row.byte_length,
    relativePath: row.relative_path,
    createdAt: row.created_at,
  }
}

/**
 * 模板库 SQLite 元数据。绝对路径由主进程 service 持有，数据库仅保存资产相对路径。
 */
export class TemplateLibraryStoreV1 {
  private readonly db: DatabaseSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS template_library_assets_v1 (
        sha256 TEXT PRIMARY KEY,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS template_library_entries_v1 (
        entry_id TEXT PRIMARY KEY,
        normalized_name TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        purpose TEXT,
        tags_json TEXT NOT NULL,
        latest_version_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'TRASHED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        trashed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS template_library_versions_v1 (
        version_id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES template_library_entries_v1(entry_id)
          ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        asset_sha256 TEXT NOT NULL REFERENCES template_library_assets_v1(sha256),
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        fields_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entry_id, version_number)
      );

      CREATE INDEX IF NOT EXISTS template_library_entries_v1_status_updated
        ON template_library_entries_v1(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS template_library_versions_v1_entry_number
        ON template_library_versions_v1(entry_id, version_number DESC);
      CREATE INDEX IF NOT EXISTS template_library_versions_v1_asset
        ON template_library_versions_v1(asset_sha256);
    `)
  }

  saveVersion(record: SaveTemplateLibraryVersionRecordV1): {
    entry: StoredTemplateLibraryEntryV1
    version: StoredTemplateLibraryVersionV1
    assetAlreadyKnown: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existingAsset = this.getAsset(record.sha256)
      if (
        existingAsset &&
        (existingAsset.byteLength !== record.byteLength ||
          existingAsset.relativePath !== record.relativeAssetPath)
      ) {
        throw new Error('TEMPLATE_LIBRARY_ASSET_CONFLICT')
      }
      if (!existingAsset) {
        this.db
          .prepare(
            `INSERT INTO template_library_assets_v1
              (sha256, byte_length, relative_path, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(record.sha256, record.byteLength, record.relativeAssetPath, record.createdAt)
      }

      const existingEntry = this.getEntryByNormalizedName(record.normalizedName)
      let entryId = record.entryId
      let versionNumber = 1
      if (existingEntry) {
        entryId = existingEntry.entryId
        const numberRow = this.db
          .prepare(
            `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
               FROM template_library_versions_v1 WHERE entry_id = ?`,
          )
          .get(entryId) as { next_number: number }
        versionNumber = numberRow.next_number
      } else {
        this.db
          .prepare(
            `INSERT INTO template_library_entries_v1 (
              entry_id, normalized_name, name, purpose, tags_json, latest_version_id,
              status, created_at, updated_at, trashed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL)`,
          )
          .run(
            entryId,
            record.normalizedName,
            record.name,
            record.purpose ?? null,
            JSON.stringify(record.tags),
            record.versionId,
            record.createdAt,
            record.createdAt,
          )
      }

      this.db
        .prepare(
          `INSERT INTO template_library_versions_v1 (
            version_id, entry_id, version_number, asset_sha256, byte_length,
            fields_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.versionId,
          entryId,
          versionNumber,
          record.sha256,
          record.byteLength,
          JSON.stringify(record.fields),
          record.createdAt,
        )

      this.db
        .prepare(
          `UPDATE template_library_entries_v1
              SET name = ?, purpose = ?, tags_json = ?, latest_version_id = ?,
                  status = 'ACTIVE', updated_at = ?, trashed_at = NULL
            WHERE entry_id = ?`,
        )
        .run(
          record.name,
          record.purpose ?? null,
          JSON.stringify(record.tags),
          record.versionId,
          record.createdAt,
          entryId,
        )

      const entry = this.getEntry(entryId)
      const version = this.getVersion(record.versionId)
      if (!entry || !version) throw new Error('TEMPLATE_LIBRARY_SAVE_INCOMPLETE')
      this.db.exec('COMMIT')
      return { entry, version, assetAlreadyKnown: existingAsset !== null }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // SQLite may already have rolled back.
      }
      throw error
    }
  }

  getEntry(entryId: string): StoredTemplateLibraryEntryV1 | null {
    const row = this.db
      .prepare('SELECT * FROM template_library_entries_v1 WHERE entry_id = ?')
      .get(entryId) as EntryRow | undefined
    return row ? parseEntry(row) : null
  }

  getEntryByNormalizedName(normalizedName: string): StoredTemplateLibraryEntryV1 | null {
    const row = this.db
      .prepare('SELECT * FROM template_library_entries_v1 WHERE normalized_name = ?')
      .get(normalizedName) as EntryRow | undefined
    return row ? parseEntry(row) : null
  }

  listEntries(): readonly StoredTemplateLibraryEntryV1[] {
    const rows = this.db
      .prepare('SELECT * FROM template_library_entries_v1 ORDER BY updated_at DESC, entry_id ASC')
      .all() as unknown as EntryRow[]
    return rows.map(parseEntry)
  }

  getVersion(versionId: string): StoredTemplateLibraryVersionV1 | null {
    const row = this.db
      .prepare('SELECT * FROM template_library_versions_v1 WHERE version_id = ?')
      .get(versionId) as VersionRow | undefined
    return row ? parseVersion(row) : null
  }

  listVersions(entryId: string): readonly StoredTemplateLibraryVersionV1[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM template_library_versions_v1
          WHERE entry_id = ? ORDER BY version_number DESC`,
      )
      .all(entryId) as unknown as VersionRow[]
    return rows.map(parseVersion)
  }

  getAsset(sha256: string): StoredTemplateLibraryAssetV1 | null {
    const row = this.db
      .prepare('SELECT * FROM template_library_assets_v1 WHERE sha256 = ?')
      .get(sha256) as AssetRow | undefined
    return row ? parseAsset(row) : null
  }

  markTrashed(entryId: string, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE template_library_entries_v1
            SET status = 'TRASHED', trashed_at = ?, updated_at = ?
          WHERE entry_id = ? AND status = 'ACTIVE'`,
      )
      .run(at, at, entryId)
    return result.changes === 1
  }

  restore(entryId: string, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE template_library_entries_v1
            SET status = 'ACTIVE', trashed_at = NULL, updated_at = ?
          WHERE entry_id = ? AND status = 'TRASHED'`,
      )
      .run(at, entryId)
    return result.changes === 1
  }

  purgeTrashedEntry(entryId: string): readonly string[] | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const entry = this.getEntry(entryId)
      if (!entry || entry.status !== 'TRASHED') {
        this.db.exec('ROLLBACK')
        return null
      }
      const hashes = this.db
        .prepare(
          'SELECT DISTINCT asset_sha256 FROM template_library_versions_v1 WHERE entry_id = ?',
        )
        .all(entryId) as unknown as Array<{ asset_sha256: string }>
      this.db.prepare('DELETE FROM template_library_entries_v1 WHERE entry_id = ?').run(entryId)
      this.db.exec('COMMIT')
      return hashes.map((row) => row.asset_sha256)
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // SQLite may already have rolled back.
      }
      throw error
    }
  }

  isAssetReferenced(sha256: string): boolean {
    const row = this.db
      .prepare(
        'SELECT EXISTS(SELECT 1 FROM template_library_versions_v1 WHERE asset_sha256 = ?) AS found',
      )
      .get(sha256) as { found: number }
    return row.found === 1
  }

  forgetAssetIfUnreferenced(sha256: string): StoredTemplateLibraryAssetV1 | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.isAssetReferenced(sha256)) {
        this.db.exec('ROLLBACK')
        return null
      }
      const asset = this.getAsset(sha256)
      if (!asset) {
        this.db.exec('ROLLBACK')
        return null
      }
      this.db.prepare('DELETE FROM template_library_assets_v1 WHERE sha256 = ?').run(sha256)
      this.db.exec('COMMIT')
      return asset
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // SQLite may already have rolled back.
      }
      throw error
    }
  }

  usage(): {
    uniqueAssetCount: number
    templateCount: number
    activeTemplateCount: number
    trashedTemplateCount: number
    versionCount: number
    totalAssetBytes: number
  } {
    return this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM template_library_assets_v1) AS uniqueAssetCount,
          (SELECT COUNT(*) FROM template_library_entries_v1) AS templateCount,
          (SELECT COUNT(*) FROM template_library_entries_v1 WHERE status = 'ACTIVE')
            AS activeTemplateCount,
          (SELECT COUNT(*) FROM template_library_entries_v1 WHERE status = 'TRASHED')
            AS trashedTemplateCount,
          (SELECT COUNT(*) FROM template_library_versions_v1) AS versionCount,
          (SELECT COALESCE(SUM(byte_length), 0) FROM template_library_assets_v1)
            AS totalAssetBytes`,
      )
      .get() as {
      uniqueAssetCount: number
      templateCount: number
      activeTemplateCount: number
      trashedTemplateCount: number
      versionCount: number
      totalAssetBytes: number
    }
  }

  close(): void {
    this.db.close()
  }
}
