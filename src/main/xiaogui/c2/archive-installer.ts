import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import JSZip, { type JSZipObject } from 'jszip'

import {
  C2_LAN_PILOT_TRUST_ROOT,
  C2_PACKAGE_LIMITS,
  canonicalizeC2ArtifactReleaseForSignatureV1,
  parseC2ArtifactReleaseRefV1,
  type C2ArtifactReleaseRefV1,
  type XiaoguiModeV1,
} from '@shared/xiaogui-c2-artifact'

export interface C2ArtifactTrustRootV1 {
  algorithm: 'Ed25519'
  keyId: string
  publicKeyPem: string
}

export interface C2ArchiveInstallerOptionsV1 {
  trustRoot?: C2ArtifactTrustRootV1
  currentXiaoguiVersion: string
  supportedModes: readonly XiaoguiModeV1[]
}

export interface C2ArchiveInstallInputV1 {
  release: C2ArtifactReleaseRefV1
  archiveBytes: Buffer
  targetDirectory: string
}

export interface C2ArchiveInstallResultV1 {
  artifactId: string
  kind: C2ArtifactReleaseRefV1['kind']
  targetDirectory: string
  entrypointPath: string
}

const SKILL_RESOURCE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
])
const APP_STATIC_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.ico', '.woff', '.woff2', '.ttf', '.map',
])

/** Fixed production composition. Tests may provide a generated Ed25519 root. */
export class C2ArchiveInstallerV1 {
  private readonly trustRoot: C2ArtifactTrustRootV1

  constructor(private readonly options: C2ArchiveInstallerOptionsV1) {
    this.trustRoot = options.trustRoot ?? C2_LAN_PILOT_TRUST_ROOT
  }

  async verifyAndInstall(input: C2ArchiveInstallInputV1): Promise<C2ArchiveInstallResultV1> {
    const release = parseC2ArtifactReleaseRefV1(input.release)
    this.verifyRelease(release, input.archiveBytes)
    const entries = await this.loadAndValidateZip(release, input.archiveBytes)
    const targetDirectory = resolve(input.targetDirectory)
    const parent = dirname(targetDirectory)
    await mkdir(parent, { recursive: true })
    const stagedDirectory = await mkdtemp(join(parent, `.${basename(targetDirectory)}.c2-stage-`))
    const backupDirectory = `${targetDirectory}.c2-previous`
    let movedExisting = false
    try {
      await this.extract(entries, stagedDirectory)
      await rm(backupDirectory, { recursive: true, force: true })
      try {
        await rename(targetDirectory, backupDirectory)
        movedExisting = true
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error
      }
      try {
        await rename(stagedDirectory, targetDirectory)
      } catch (error) {
        if (movedExisting) await rename(backupDirectory, targetDirectory).catch(() => undefined)
        throw error
      }
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined)
      return {
        artifactId: release.artifactId,
        kind: release.kind,
        targetDirectory,
        entrypointPath: assertChildPath(targetDirectory, join(targetDirectory, ...release.entrypoint.split('/'))),
      }
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true })
    }
  }

  private verifyRelease(release: C2ArtifactReleaseRefV1, archiveBytes: Buffer): void {
    if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > C2_PACKAGE_LIMITS.maxPackageBytes) {
      throw new Error('C2 package size exceeds policy')
    }
    const digest = createHash('sha256').update(archiveBytes).digest('hex')
    if (digest !== release.packageSha256) throw new Error('C2 package SHA-256 mismatch')
    if (this.trustRoot.algorithm !== 'Ed25519' || release.signatureKeyId !== this.trustRoot.keyId) {
      throw new Error('C2 release signing key is not trusted')
    }
    if (release.publicKeyPem !== undefined && release.publicKeyPem !== this.trustRoot.publicKeyPem) {
      throw new Error('C2 release public key metadata does not match the pinned key')
    }
    const key = createPublicKey(this.trustRoot.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('C2 trust root is not Ed25519')
    let signature: Buffer
    try {
      signature = Buffer.from(release.signature, 'base64')
    } catch {
      throw new Error('C2 release signature is invalid')
    }
    const canonical = canonicalizeC2ArtifactReleaseForSignatureV1(release)
    if (signature.byteLength !== 64 || !verify(null, Buffer.from(canonical, 'utf8'), key, signature)) {
      throw new Error('C2 release signature is invalid')
    }
    if (compareVersions(this.options.currentXiaoguiVersion, release.compatibility.minXiaoguiVersion) < 0) {
      throw new Error('C2 release is not compatible with this Xiaogui version')
    }
    if (!release.compatibility.supportedModes.some((mode) => this.options.supportedModes.includes(mode))) {
      throw new Error('C2 release has no compatible Xiaogui mode')
    }
  }

  private async loadAndValidateZip(
    release: C2ArtifactReleaseRefV1,
    archiveBytes: Buffer,
  ): Promise<readonly JSZipObject[]> {
    const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true })
    const entries = Object.values(zip.files)
    if (entries.length === 0 || entries.length > C2_PACKAGE_LIMITS.maxEntryCount) {
      throw new Error('C2 ZIP entry count exceeds policy')
    }
    const seen = new Set<string>()
    let totalBytes = 0
    for (const entry of entries) {
      const unsafeOriginalName = (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName
      const archivePath = unsafeOriginalName ?? entry.name
      validateArchivePath(archivePath, entry.dir)
      const caseKey = entry.name.replace(/\/$/, '').toLocaleLowerCase('en-US')
      if (seen.has(caseKey)) throw new Error('C2 ZIP has a case-insensitive path conflict')
      seen.add(caseKey)
      if (isLinkOrSpecial(entry)) throw new Error('C2 ZIP contains a forbidden link or special entry')
      if (!entry.dir) {
        validateFilePolicy(release.kind, entry.name)
        const bytes = await entry.async('nodebuffer')
        if (bytes.byteLength > C2_PACKAGE_LIMITS.maxEntryBytes) throw new Error('C2 ZIP entry exceeds size policy')
        totalBytes += bytes.byteLength
        if (totalBytes > C2_PACKAGE_LIMITS.maxTotalUncompressedBytes) throw new Error('C2 ZIP expands beyond policy')
      }
    }
    if (release.kind === 'SKILL' && release.entrypoint !== 'SKILL.md') {
      throw new Error('C2 Skill entrypoint must be root SKILL.md')
    }
    if (release.kind === 'APP' && release.entrypoint !== 'index.html') {
      throw new Error('C2 App entrypoint must be root index.html')
    }
    const entrypoint = zip.file(release.entrypoint)
    if (!entrypoint || entrypoint.dir) throw new Error('C2 entrypoint is missing from ZIP')
    return entries
  }

  private async extract(entries: readonly JSZipObject[], stagedDirectory: string): Promise<void> {
    for (const entry of entries) {
      const archivePath = entry.name.replace(/\/$/, '')
      const destination = assertChildPath(stagedDirectory, join(stagedDirectory, ...archivePath.split('/')))
      if (entry.dir) await mkdir(destination, { recursive: true })
      else {
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, await entry.async('nodebuffer'), { flag: 'wx' })
      }
    }
  }
}

function validateArchivePath(value: string, directory: boolean): void {
  const normalized = directory && value.endsWith('/') ? value.slice(0, -1) : value
  if (
    !normalized || normalized.includes('\0') || normalized.includes('\\') ||
    /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe C2 ZIP entry: ${value}`)
  }
}

function validateFilePolicy(kind: C2ArtifactReleaseRefV1['kind'], name: string): void {
  const extension = extname(name).toLocaleLowerCase('en-US')
  const allowed = kind === 'SKILL' ? SKILL_RESOURCE_EXTENSIONS : APP_STATIC_EXTENSIONS
  if (!allowed.has(extension)) throw new Error(`C2 ${kind} package contains a non-static or executable file`)
}

function isLinkOrSpecial(entry: JSZipObject): boolean {
  if (entry.dir) return false
  const unixPermissions = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0
  const type = unixPermissions & 0o170000
  return type !== 0 && type !== 0o100000
}

function compareVersions(left: string, right: string): number {
  const toParts = (value: string): number[] => {
    const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!match) throw new Error('C2 compatibility version is invalid')
    return match.slice(1).map(Number)
  }
  const a = toParts(left)
  const b = toParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!
  }
  return 0
}

export function assertChildPath(root: string, child: string): string {
  const resolvedRoot = resolve(root)
  const resolvedChild = resolve(child)
  const rel = relative(resolvedRoot, resolvedChild)
  if (!rel || rel.startsWith('..') || rel.includes(':') || resolve(resolvedRoot, rel) !== resolvedChild) {
    if (!rel) return resolvedChild
    throw new Error('C2 path escapes install root')
  }
  return resolvedChild
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code)
}
