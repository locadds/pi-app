import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  TEMPLATE_LIBRARY_CONTRACT_VERSION_V1,
  type TemplateLibraryConfigurationV1,
  type TemplateLibraryDetailV1,
  type TemplateLibraryErrorCodeV1,
  type TemplateLibraryFieldSummaryV1,
  type TemplateLibraryListQueryV1,
  type TemplateLibraryListResultV1,
  type TemplateLibrarySaveMetadataV1,
  type TemplateLibrarySaveResultV1,
  type TemplateLibrarySummaryV1,
  type TemplateLibraryUsageV1,
  type TemplateLibraryVersionSummaryV1,
} from '@shared/xiaogui-template-library'

import { inspectSafeDocxArchiveV1 } from './docx-safety'
import {
  TemplateLibraryStoreV1,
  type StoredTemplateLibraryEntryV1,
  type StoredTemplateLibraryVersionV1,
} from './template-library-store'

const DATABASE_FILE_NAME = 'template-library.sqlite'
const ASSETS_DIRECTORY_NAME = 'assets'
const MAX_NAME_LENGTH = 120
const MAX_PURPOSE_LENGTH = 500
const MAX_TAG_COUNT = 20
const MAX_TAG_LENGTH = 32
const MAX_FIELD_COUNT = 200
const MAX_FIELD_NAME_LENGTH = 80

type RootPreferenceV1 = {
  version: 1
  rootPath: string
}

export interface TemplateLibraryServiceOptionsV1 {
  /** 位于小规 userData 的私有配置文件，只由主进程读取。 */
  preferencePath: string
  now?: () => Date
}

/** 仅主进程可见；不得透传给 Renderer、工具结果或模型。 */
export interface ResolvedTemplateLibraryVersionForUseV1 {
  entry: TemplateLibrarySummaryV1
  version: TemplateLibraryVersionSummaryV1
  assetPath: string
}

export class TemplateLibraryServiceErrorV1 extends Error {
  constructor(readonly code: TemplateLibraryErrorCodeV1) {
    super(code)
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function compactText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function comparisonKey(value: string): string {
  return compactText(value).toLocaleLowerCase()
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function validateMetadata(metadata: TemplateLibrarySaveMetadataV1): {
  name: string
  normalizedName: string
  purpose?: string
  tags: readonly string[]
  fields: readonly TemplateLibraryFieldSummaryV1[]
} {
  const name = compactText(metadata.name)
  if (!name || name.length > MAX_NAME_LENGTH || hasControlCharacters(name)) {
    throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_NAME_INVALID')
  }

  const purpose = metadata.purpose === undefined ? undefined : compactText(metadata.purpose)
  if (
    purpose !== undefined &&
    (purpose.length > MAX_PURPOSE_LENGTH || hasControlCharacters(purpose))
  ) {
    throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_NAME_INVALID')
  }

  const tagKeys = new Set<string>()
  const tags: string[] = []
  for (const rawTag of metadata.tags ?? []) {
    const tag = compactText(rawTag)
    const key = comparisonKey(tag)
    if (!tag || tag.length > MAX_TAG_LENGTH || hasControlCharacters(tag)) {
      throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_TAG_INVALID')
    }
    if (!tagKeys.has(key)) {
      tagKeys.add(key)
      tags.push(tag)
    }
  }
  if (tags.length > MAX_TAG_COUNT) {
    throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_TAG_INVALID')
  }

  const allowedKinds = new Set(['TEXT', 'IMAGE', 'REPEAT', 'CONDITIONAL'])
  const fieldIds = new Set<string>()
  const fields = (metadata.fields ?? []).map((rawField) => {
    const fieldId = rawField.fieldId.trim()
    const fieldName = compactText(rawField.name)
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(fieldId) ||
      fieldIds.has(fieldId) ||
      !fieldName ||
      fieldName.length > MAX_FIELD_NAME_LENGTH ||
      hasControlCharacters(fieldName) ||
      !allowedKinds.has(rawField.kind) ||
      typeof rawField.required !== 'boolean'
    ) {
      throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_FIELD_INVALID')
    }
    fieldIds.add(fieldId)
    return { ...rawField, fieldId, name: fieldName }
  })
  if (fields.length > MAX_FIELD_COUNT) {
    throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_FIELD_INVALID')
  }

  return {
    name,
    normalizedName: comparisonKey(name),
    ...(purpose ? { purpose } : {}),
    tags,
    fields,
  }
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..')
}

export class TemplateLibraryServiceV1 {
  private store: TemplateLibraryStoreV1 | null = null
  private rootPath: string | null = null
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly options: TemplateLibraryServiceOptionsV1) {}

  async getConfiguration(): Promise<TemplateLibraryConfigurationV1> {
    return this.exclusive(async () => {
      await this.tryOpenRememberedRoot()
      return { configured: this.store !== null }
    })
  }

  async configureRoot(selectedRootPath: string): Promise<TemplateLibraryConfigurationV1> {
    return this.exclusive(async () => {
      const root = await this.validateAndPrepareRoot(selectedRootPath)
      const nextStore = new TemplateLibraryStoreV1(join(root, DATABASE_FILE_NAME))
      try {
        await this.writePreference(root)
      } catch (error) {
        nextStore.close()
        throw error
      }
      this.store?.close()
      this.store = nextStore
      this.rootPath = root
      return { configured: true }
    })
  }

  async saveFromBuffer(
    content: Buffer,
    metadata: TemplateLibrarySaveMetadataV1,
  ): Promise<TemplateLibrarySaveResultV1> {
    return this.exclusive(async () => {
      const { store, root } = await this.requireReady()
      const safeMetadata = validateMetadata(metadata)
      try {
        await inspectSafeDocxArchiveV1(content)
      } catch {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_DOCUMENT_INVALID')
      }

      const digest = sha256(content)
      const relativeAssetPath = `${ASSETS_DIRECTORY_NAME}/${digest}.docx`
      const assetPath = this.resolveAssetPath(root, relativeAssetPath)
      const assetAlreadyPresent = await this.persistAsset(assetPath, content, digest)
      const createdAt = this.now().toISOString()
      try {
        const stored = store.saveVersion({
          entryId: `xgtle1_${randomUUID()}`,
          versionId: `xgtlv1_${randomUUID()}`,
          normalizedName: safeMetadata.normalizedName,
          name: safeMetadata.name,
          purpose: safeMetadata.purpose,
          tags: safeMetadata.tags,
          fields: safeMetadata.fields,
          sha256: digest,
          byteLength: content.byteLength,
          relativeAssetPath,
          createdAt,
        })
        const entry = this.detailFromStored(store, stored.entry)
        const version = this.versionSummary(
          stored.version,
          stored.entry.latestVersionId === stored.version.versionId,
        )
        return {
          entry,
          version,
          assetDeduplicated: assetAlreadyPresent || stored.assetAlreadyKnown,
        }
      } catch (error) {
        if (!assetAlreadyPresent && !store.isAssetReferenced(digest)) {
          await unlink(assetPath).catch(() => {})
        }
        throw error
      }
    })
  }

  async list(query: TemplateLibraryListQueryV1 = {}): Promise<TemplateLibraryListResultV1> {
    return this.exclusive(async () => {
      const { store } = await this.requireReady()
      const status = query.status ?? 'ACTIVE'
      const words = comparisonKey(query.query ?? '')
      const requiredTags = (query.tags ?? []).map(comparisonKey).filter(Boolean)
      const matching = store.listEntries().filter((entry) => {
        if (status !== 'ALL' && entry.status !== status) return false
        const tagKeys = entry.tags.map(comparisonKey)
        if (requiredTags.some((tag) => !tagKeys.includes(tag))) return false
        if (!words) return true
        return comparisonKey([entry.name, entry.purpose ?? '', ...entry.tags].join(' ')).includes(words)
      })
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200)
      const offset = Math.max(Math.trunc(query.offset ?? 0), 0)
      return {
        items: matching.slice(offset, offset + limit).map((entry) => this.summary(store, entry)),
        total: matching.length,
        limit,
        offset,
      }
    })
  }

  async getDetail(entryId: string): Promise<TemplateLibraryDetailV1> {
    return this.exclusive(async () => {
      const { store } = await this.requireReady()
      const entry = store.getEntry(entryId)
      if (!entry) throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_FOUND')
      return this.detailFromStored(store, entry)
    })
  }

  async listVersions(entryId: string): Promise<readonly TemplateLibraryVersionSummaryV1[]> {
    return this.exclusive(async () => {
      const { store } = await this.requireReady()
      const entry = store.getEntry(entryId)
      if (!entry) throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_FOUND')
      return store
        .listVersions(entry.entryId)
        .map((version) => this.versionSummary(version, version.versionId === entry.latestVersionId))
    })
  }

  async getUsage(): Promise<TemplateLibraryUsageV1> {
    return this.exclusive(async () => {
      const { store } = await this.requireReady()
      return { ...store.usage(), capacityLimitBytes: null }
    })
  }

  async moveToTrash(entryId: string): Promise<TemplateLibrarySummaryV1> {
    return this.exclusive(async () => {
      const { store } = await this.requireReady()
      const entry = store.getEntry(entryId)
      if (!entry) throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_FOUND')
      if (entry.status === 'ACTIVE') store.markTrashed(entryId, this.now().toISOString())
      const trashed = store.getEntry(entryId)
      if (!trashed) throw new Error('TEMPLATE_LIBRARY_TRASH_INCOMPLETE')
      return this.summary(store, trashed)
    })
  }

  async restore(entryId: string): Promise<TemplateLibrarySummaryV1> {
    return this.exclusive(async () => {
      const { store } = await this.requireReady()
      const entry = store.getEntry(entryId)
      if (!entry) throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_FOUND')
      if (entry.status === 'TRASHED') store.restore(entryId, this.now().toISOString())
      const restored = store.getEntry(entryId)
      if (!restored) throw new Error('TEMPLATE_LIBRARY_RESTORE_INCOMPLETE')
      return this.summary(store, restored)
    })
  }

  /** 明确的彻底删除动作；活动模板不会被删除。 */
  async purgeTrashed(entryId: string): Promise<void> {
    await this.exclusive(async () => {
      const { store, root } = await this.requireReady()
      const entry = store.getEntry(entryId)
      if (!entry) throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_FOUND')
      if (entry.status !== 'TRASHED') {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_TRASHED')
      }
      const hashes = store.purgeTrashedEntry(entryId)
      if (!hashes) {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_NOT_TRASHED')
      }
      for (const digest of hashes) {
        if (store.isAssetReferenced(digest)) continue
        const asset = store.getAsset(digest)
        if (!asset) continue
        const path = this.resolveAssetPath(root, asset.relativePath)
        try {
          await unlink(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        store.forgetAssetIfUnreferenced(digest)
      }
    })
  }

  /**
   * 供主进程的生成服务解析模板版本。返回值含私有路径，禁止进入共享契约或 IPC。
   */
  async resolveVersionForUse(
    versionId: string,
  ): Promise<ResolvedTemplateLibraryVersionForUseV1> {
    return this.exclusive(async () => {
      const { store, root } = await this.requireReady()
      const version = store.getVersion(versionId)
      if (!version) {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_VERSION_NOT_FOUND')
      }
      const entry = store.getEntry(version.entryId)
      if (!entry) throw new Error('TEMPLATE_LIBRARY_VERSION_WITHOUT_ENTRY')
      if (entry.status !== 'ACTIVE') {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ENTRY_TRASHED')
      }
      const asset = store.getAsset(version.assetSha256)
      if (!asset) throw new Error('TEMPLATE_LIBRARY_VERSION_WITHOUT_ASSET')
      const assetPath = this.resolveAssetPath(root, asset.relativePath)
      const information = await stat(assetPath)
      if (!information.isFile() || information.size !== version.byteLength) {
        throw new Error('TEMPLATE_LIBRARY_ASSET_MISSING')
      }
      if (sha256(await readFile(assetPath)) !== version.assetSha256) {
        throw new Error('TEMPLATE_LIBRARY_ASSET_CHANGED')
      }
      return {
        entry: this.summary(store, entry),
        version: this.versionSummary(version, version.versionId === entry.latestVersionId),
        assetPath,
      }
    })
  }

  close(): void {
    this.store?.close()
    this.store = null
    this.rootPath = null
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const started = this.pending.then(operation, operation)
    this.pending = started.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await started
    } catch (error) {
      if (error instanceof TemplateLibraryServiceErrorV1) throw error
      throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_STORAGE_FAILED')
    }
  }

  private async requireReady(): Promise<{
    store: TemplateLibraryStoreV1
    root: string
  }> {
    await this.tryOpenRememberedRoot()
    if (!this.store || !this.rootPath) {
      throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_NOT_CONFIGURED')
    }
    return { store: this.store, root: this.rootPath }
  }

  private async tryOpenRememberedRoot(): Promise<void> {
    if (this.store) return
    let preference: RootPreferenceV1
    try {
      preference = JSON.parse(await readFile(this.options.preferencePath, 'utf8')) as RootPreferenceV1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (preference.version !== 1 || typeof preference.rootPath !== 'string') {
      throw new Error('TEMPLATE_LIBRARY_PREFERENCE_INVALID')
    }
    const root = await this.validateAndPrepareRoot(preference.rootPath)
    this.store = new TemplateLibraryStoreV1(join(root, DATABASE_FILE_NAME))
    this.rootPath = root
  }

  private async validateAndPrepareRoot(selectedRootPath: string): Promise<string> {
    if (!isAbsolute(selectedRootPath)) {
      throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ROOT_INVALID')
    }
    const root = resolve(selectedRootPath)
    try {
      await mkdir(root, { recursive: true })
      const rootInfo = await lstat(root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ROOT_INVALID')
      }
      if ((await realpath(root)).toLocaleLowerCase() !== root.toLocaleLowerCase()) {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ROOT_INVALID')
      }
      const assets = join(root, ASSETS_DIRECTORY_NAME)
      await mkdir(assets, { recursive: true })
      const assetsInfo = await lstat(assets)
      if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) {
        throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ROOT_INVALID')
      }
      await access(root, fsConstants.R_OK | fsConstants.W_OK)
      return root
    } catch (error) {
      if (error instanceof TemplateLibraryServiceErrorV1) throw error
      throw new TemplateLibraryServiceErrorV1('TEMPLATE_LIBRARY_ROOT_INVALID')
    }
  }

  private async writePreference(root: string): Promise<void> {
    await mkdir(dirname(this.options.preferencePath), { recursive: true })
    const temporary = `${this.options.preferencePath}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, rootPath: root } satisfies RootPreferenceV1),
        { flag: 'wx' },
      )
      await rename(temporary, this.options.preferencePath)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  private async persistAsset(path: string, content: Buffer, digest: string): Promise<boolean> {
    try {
      const information = await stat(path)
      if (!information.isFile() || information.size !== content.byteLength) {
        throw new Error('TEMPLATE_LIBRARY_ASSET_CONFLICT')
      }
      if (sha256(await readFile(path)) !== digest) {
        throw new Error('TEMPLATE_LIBRARY_ASSET_CONFLICT')
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporary = `${path}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx')
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      handle = null
      try {
        await link(temporary, path)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readFile(path)
        if (sha256(existing) !== digest) throw error
        return true
      }
    } finally {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
    }
  }

  private resolveAssetPath(root: string, relativePath: string): string {
    const path = resolve(root, relativePath)
    if (!isContained(root, path)) throw new Error('TEMPLATE_LIBRARY_ASSET_PATH_INVALID')
    return path
  }

  private summary(
    store: TemplateLibraryStoreV1,
    entry: StoredTemplateLibraryEntryV1,
  ): TemplateLibrarySummaryV1 {
    const versions = store.listVersions(entry.entryId)
    const latest = versions.find((version) => version.versionId === entry.latestVersionId)
    if (!latest) throw new Error('TEMPLATE_LIBRARY_LATEST_VERSION_MISSING')
    return {
      libraryVersion: TEMPLATE_LIBRARY_CONTRACT_VERSION_V1,
      entryId: entry.entryId,
      name: entry.name,
      ...(entry.purpose ? { purpose: entry.purpose } : {}),
      tags: entry.tags,
      fields: latest.fields,
      status: entry.status,
      latestVersion: this.versionSummary(latest, true),
      versionCount: versions.length,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.trashedAt ? { trashedAt: entry.trashedAt } : {}),
    }
  }

  private detailFromStored(
    store: TemplateLibraryStoreV1,
    entry: StoredTemplateLibraryEntryV1,
  ): TemplateLibraryDetailV1 {
    const summary = this.summary(store, entry)
    return {
      ...summary,
      versions: store
        .listVersions(entry.entryId)
        .map((version) => this.versionSummary(version, version.versionId === entry.latestVersionId)),
    }
  }

  private versionSummary(
    version: StoredTemplateLibraryVersionV1,
    isLatest: boolean,
  ): TemplateLibraryVersionSummaryV1 {
    return {
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      sha256: version.assetSha256,
      byteLength: version.byteLength,
      fields: version.fields,
      createdAt: version.createdAt,
      isLatest,
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
}
