import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs'
import path from 'node:path'

import type { XiaoguiBridgeConfig } from './config'
import { resolveXiaoguiConfig } from './config'

export const EXPECTED_RUNTIME_MANIFEST_SHA256_V1 =
  '6aa06c44d490b0b49b9acef729f2ffa630b9d06c7e866cc7963a82331e784648'
export const EXPECTED_DESIGN_RUNTIME_SOURCE_SHA256_V1 =
  '2d7e98ffe88a1ec7afff34fcb327d49c35b6e625'

const RUNTIME_MANIFEST_FILE = 'runtime-manifest.json'
const REQUIRED_SOURCE_FILES = [
  'python/xiaogui_runtime/__main__.py',
  'src/design/design-extension/index.ts',
  'src/design/design-extension/rpc.ts',
  'src/design/design-extension/phase-guard.ts',
] as const

interface RuntimeManifestFileV1 {
  path: string
  sha256: string
}

interface RuntimeManifestV1 {
  schemaVersion: 1
  sourceSha: typeof EXPECTED_DESIGN_RUNTIME_SOURCE_SHA256_V1
  files: RuntimeManifestFileV1[]
}

export interface TaskHubDesignRuntimeV1 {
  config: XiaoguiBridgeConfig
  extensionPath: string
}

export class TaskHubDesignRuntimeSourceErrorV1 extends Error {
  constructor(readonly reason: string) {
    super(`TASKHUB_DESIGN_RUNTIME_SOURCE_INVALID: ${reason}`)
    this.name = 'TaskHubDesignRuntimeSourceErrorV1'
  }
}

function reject(reason: string): never {
  throw new TaskHubDesignRuntimeSourceErrorV1(reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathKey(value: string): string {
  return path.resolve(value).replace(/[\\/]+/gu, '\\').replace(/[\\]+$/u, '').toLowerCase()
}

function isWithin(root: string, candidate: string): boolean {
  const rootKey = pathKey(root)
  const candidateKey = pathKey(candidate)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
}

function normalizeManifestPath(value: unknown, allowManifest = false): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F]/u.test(value)) {
    reject('MANIFEST_PATH_INVALID')
  }
  const normalized = value.replace(/\\/gu, '/')
  if (
    normalized.startsWith('/') ||
    path.win32.isAbsolute(normalized) ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    reject('MANIFEST_PATH_INVALID')
  }
  if (!allowManifest && normalized === RUNTIME_MANIFEST_FILE) {
    reject('MANIFEST_PATH_INVALID')
  }
  return normalized
}

function assertSafeEntry(root: string, realRoot: string, candidate: string): void {
  if (!isWithin(root, candidate)) reject('PATH_OUTSIDE_SOURCE')
  let info: ReturnType<typeof lstatSync>
  let realCandidate: string
  try {
    info = lstatSync(candidate)
    realCandidate = realpathSync.native(candidate)
  } catch {
    reject('SOURCE_PATH_MISSING')
  }
  if (info!.isSymbolicLink()) reject('SOURCE_REPARSE_POINT')
  if (!isWithin(realRoot, realCandidate!)) reject('PATH_OUTSIDE_SOURCE')
  // A junction/reparse point can appear as a directory rather than a symlink.
  // Requiring the canonical path to equal the lexical path rejects both forms.
  if (pathKey(realCandidate!) !== pathKey(candidate)) reject('SOURCE_REPARSE_POINT')
}

function assertSafeDirectory(candidate: string): string {
  if (!path.isAbsolute(candidate)) reject('SOURCE_PATH_NOT_ABSOLUTE')
  let info: ReturnType<typeof lstatSync>
  let realCandidate: string
  try {
    info = lstatSync(candidate)
    realCandidate = realpathSync.native(candidate)
  } catch {
    reject('SOURCE_PATH_MISSING')
  }
  if (!info!.isDirectory() || info!.isSymbolicLink()) reject('SOURCE_DIRECTORY_INVALID')
  if (pathKey(realCandidate!) !== pathKey(candidate)) reject('SOURCE_REPARSE_POINT')
  return realCandidate!
}

function parseManifest(content: Buffer): RuntimeManifestV1 {
  let value: unknown
  try {
    value = JSON.parse(content.toString('utf8')) as unknown
  } catch {
    reject('MANIFEST_INVALID')
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['schemaVersion', 'sourceSha', 'files'].includes(key)) ||
    value.schemaVersion !== 1 ||
    value.sourceSha !== EXPECTED_DESIGN_RUNTIME_SOURCE_SHA256_V1 ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    reject('MANIFEST_INVALID')
  }

  const files: RuntimeManifestFileV1[] = []
  const seen = new Set<string>()
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !['path', 'sha256'].includes(key)) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      reject('MANIFEST_FILE_INVALID')
    }
    const filePath = normalizeManifestPath(entry.path)
    if (seen.has(filePath)) reject('MANIFEST_DUPLICATE_FILE')
    seen.add(filePath)
    files.push({ path: filePath, sha256: entry.sha256 })
  }
  return {
    schemaVersion: 1,
    sourceSha: EXPECTED_DESIGN_RUNTIME_SOURCE_SHA256_V1,
    files,
  }
}

function allowedDirectories(files: readonly RuntimeManifestFileV1[]): Set<string> {
  const directories = new Set<string>([''])
  for (const file of files) {
    const segments = file.path.split('/')
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join('/'))
    }
  }
  return directories
}

function enumerateSourceFiles(
  root: string,
  realRoot: string,
  manifest: RuntimeManifestV1,
): Set<string> {
  const expected = new Set(manifest.files.map((file) => file.path))
  const directories = allowedDirectories(manifest.files)
  const found = new Set<string>()

  const visit = (directory: string, relativeDirectory: string): void => {
    assertSafeEntry(root, realRoot, directory)
    if (!directories.has(relativeDirectory)) reject('SOURCE_UNLISTED_DIRECTORY')
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      reject('SOURCE_DIRECTORY_READ_FAILED')
    }
    for (const entry of entries!) {
      const candidate = path.join(directory, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const normalizedPath = normalizeManifestPath(relativePath, true)
      assertSafeEntry(root, realRoot, candidate)
      const info = lstatSync(candidate)
      if (normalizedPath === RUNTIME_MANIFEST_FILE) {
        if (relativeDirectory || !info.isFile()) reject('MANIFEST_INVALID')
        continue
      }
      if (info.isDirectory()) {
        visit(candidate, normalizedPath)
        continue
      }
      if (!info.isFile()) reject('SOURCE_ENTRY_INVALID')
      if (!expected.has(normalizedPath)) reject('SOURCE_UNLISTED_FILE')
      if (found.has(normalizedPath)) reject('SOURCE_DUPLICATE_FILE')
      found.add(normalizedPath)
    }
  }

  visit(root, '')
  return found
}

function verifyManifestFiles(root: string, realRoot: string, manifest: RuntimeManifestV1): void {
  const found = enumerateSourceFiles(root, realRoot, manifest)
  const expected = new Set(manifest.files.map((file) => file.path))
  if (found.size !== expected.size || [...expected].some((file) => !found.has(file))) {
    reject('SOURCE_FILE_SET_MISMATCH')
  }
  for (const file of manifest.files) {
    const candidate = path.join(root, ...file.path.split('/'))
    assertSafeEntry(root, realRoot, candidate)
    if (!lstatSync(candidate).isFile()) reject('SOURCE_FILE_INVALID')
    let content: Buffer
    try {
      content = readFileSync(candidate)
    } catch {
      reject('SOURCE_FILE_READ_FAILED')
    }
    if (createHash('sha256').update(content!).digest('hex') !== file.sha256) {
      reject('SOURCE_FILE_HASH_MISMATCH')
    }
  }
  for (const required of REQUIRED_SOURCE_FILES) {
    if (!expected.has(required)) reject('SOURCE_REQUIRED_FILE_MISSING')
  }
}

export function resolveTaskHubDesignRuntimeV1(): TaskHubDesignRuntimeV1 {
  const config = resolveXiaoguiConfig()
  if (!config.repoRoot || !config.pythonCwd) reject('RUNTIME_CONFIG_MISSING')
  const root = config.repoRoot
  const realRoot = assertSafeDirectory(root)

  const manifestPath = path.join(root, RUNTIME_MANIFEST_FILE)
  assertSafeEntry(root, realRoot, manifestPath)
  if (!lstatSync(manifestPath).isFile()) reject('MANIFEST_INVALID')
  let manifestContent: Buffer
  try {
    manifestContent = readFileSync(manifestPath)
  } catch {
    reject('MANIFEST_READ_FAILED')
  }
  if (createHash('sha256').update(manifestContent!).digest('hex') !== EXPECTED_RUNTIME_MANIFEST_SHA256_V1) {
    reject('MANIFEST_HASH_MISMATCH')
  }
  const manifest = parseManifest(manifestContent!)
  verifyManifestFiles(root, realRoot, manifest)

  const manifestPythonRoot = path.join(root, 'python')
  const realManifestPythonRoot = assertSafeDirectory(manifestPythonRoot)
  const realConfiguredPythonCwd = assertSafeDirectory(config.pythonCwd!)
  if (pathKey(realConfiguredPythonCwd) !== pathKey(realManifestPythonRoot)) {
    reject('PYTHON_RUNTIME_MISMATCH')
  }

  const extensionPath = path.join(root, 'src', 'design', 'design-extension', 'index.ts')
  assertSafeEntry(root, realRoot, extensionPath)
  if (!lstatSync(extensionPath).isFile()) reject('EXTENSION_ENTRY_MISSING')
  return { config, extensionPath }
}
