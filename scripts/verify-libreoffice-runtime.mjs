#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LIBREOFFICE_CONTRACT = Object.freeze({
  version: '26.2.5',
  fileName: 'LibreOffice_26.2.5_Win_x86-64.msi',
  downloadUrl:
    'https://download.documentfoundation.org/libreoffice/stable/26.2.5/win/x86_64/LibreOffice_26.2.5_Win_x86-64.msi',
  sourceUrl: 'https://download.documentfoundation.org/libreoffice/src/26.2.5/',
  installerSha256: 'f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9',
  installerBytes: 372_948_992,
  executable: 'program/soffice.exe',
})

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRootDir = resolve(scriptDirectory, '..')

export function assertDDriveCacheRoot(cacheRoot) {
  if (typeof cacheRoot !== 'string' || !/^D:[\\/]/i.test(cacheRoot)) {
    throw new Error(`BUILD_CACHE_MUST_BE_ON_D_DRIVE:${cacheRoot || '<empty>'}`)
  }
  return resolve(cacheRoot)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function requireNonEmpty(path, label) {
  let information
  try {
    information = await stat(path)
  } catch {
    throw new Error(`PACKAGING_REQUIRED_FILE_MISSING:${label}:${path}`)
  }
  if (!information.isFile() || information.size === 0) {
    throw new Error(`PACKAGING_REQUIRED_FILE_EMPTY:${label}:${path}`)
  }
  return information
}

function requireIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`PACKAGING_LEGAL_CONTENT_INVALID:${label}`)
}

export async function verifyLibreOfficeRuntime({
  rootDir = defaultRootDir,
  cacheRoot,
  contract = LIBREOFFICE_CONTRACT,
} = {}) {
  const resolvedRoot = resolve(rootDir)
  const resolvedCache = resolve(cacheRoot || 'D:\\CodexTemp\\xiaogui-libreoffice-cache')
  const runtimeRoot = join(resolvedRoot, 'resources', 'libreoffice-runtime', 'runtime')
  const executablePath = join(runtimeRoot, ...contract.executable.split('/'))
  const manifestPath = join(runtimeRoot, 'xiaogui-runtime-manifest.json')
  const installerPath = join(resolvedCache, contract.fileName)

  await requireNonEmpty(executablePath, 'LibreOffice soffice.exe')
  await requireNonEmpty(manifestPath, 'LibreOffice runtime manifest')
  const installerInformation = await requireNonEmpty(installerPath, 'LibreOffice fixed installer')
  if (installerInformation.size !== contract.installerBytes) {
    throw new Error(`LIBREOFFICE_INSTALLER_SIZE_MISMATCH:${installerInformation.size}`)
  }
  const installerSha256 = await sha256(installerPath)
  if (installerSha256 !== contract.installerSha256) {
    throw new Error(`LIBREOFFICE_INSTALLER_CHECKSUM_MISMATCH:${installerSha256}`)
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`LIBREOFFICE_RUNTIME_MANIFEST_INVALID_JSON:${error.message}`)
  }
  const expectedManifest = {
    version: contract.version,
    sourceUrl: contract.downloadUrl,
    sourceCodeUrl: contract.sourceUrl,
    installerSha256: contract.installerSha256,
    installerBytes: contract.installerBytes,
    executable: contract.executable,
  }
  for (const [field, expected] of Object.entries(expectedManifest)) {
    if (manifest[field] !== expected) {
      throw new Error(`LIBREOFFICE_RUNTIME_MANIFEST_MISMATCH:${field}`)
    }
  }

  const legalPaths = {
    notice: join(resolvedRoot, 'THIRD_PARTY_NOTICES.md'),
    sbom: join(resolvedRoot, 'sbom.cdx.json'),
    mpl: join(resolvedRoot, 'resources', 'legal', 'MPL-2.0.txt'),
    apache: join(resolvedRoot, 'resources', 'legal', 'Apache-2.0.txt'),
    source: join(resolvedRoot, 'resources', 'legal', 'LIBREOFFICE_SOURCE.md'),
    readme: join(resolvedRoot, 'resources', 'libreoffice-runtime', 'README.md'),
  }
  await Promise.all(
    Object.entries(legalPaths).map(([label, path]) => requireNonEmpty(path, label)),
  )
  const notice = await readFile(legalPaths.notice, 'utf8')
  requireIncludes(notice, contract.version, 'NOTICE:version')
  requireIncludes(notice, contract.installerSha256, 'NOTICE:sha256')
  requireIncludes(notice, contract.sourceUrl, 'NOTICE:source')
  const sourceNotice = await readFile(legalPaths.source, 'utf8')
  requireIncludes(sourceNotice, contract.sourceUrl, 'SOURCE:fixed-version-url')
  const runtimeReadme = await readFile(legalPaths.readme, 'utf8')
  requireIncludes(runtimeReadme, contract.version, 'README:version')
  requireIncludes(runtimeReadme, contract.sourceUrl, 'README:source')

  let sbom
  try {
    sbom = JSON.parse(await readFile(legalPaths.sbom, 'utf8'))
  } catch (error) {
    throw new Error(`PACKAGING_SBOM_INVALID_JSON:${error.message}`)
  }
  const libreOffice = sbom.components?.find(
    (component) => component.name === 'LibreOffice Windows x64 private runtime',
  )
  const sbomSha = libreOffice?.hashes?.find((hash) => hash.alg === 'SHA-256')?.content
  if (libreOffice?.version !== contract.version || sbomSha !== contract.installerSha256) {
    throw new Error('PACKAGING_SBOM_LIBREOFFICE_MISMATCH')
  }

  return { version: contract.version, installerSha256, runtimeRoot, installerPath }
}

const invokedAsCli =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('verify-libreoffice-runtime.mjs')
if (invokedAsCli) {
  const cacheRoot = process.env.XIAOGUI_LIBREOFFICE_CACHE_ROOT
    || 'D:\\CodexTemp\\xiaogui-libreoffice-cache'
  assertDDriveCacheRoot(cacheRoot)
  assertDDriveCacheRoot(
    process.env.XIAOGUI_BUILD_CACHE_ROOT || 'D:\\CodexTemp\\xiaogui-build-cache',
  )
  const result = await verifyLibreOfficeRuntime({ cacheRoot })
  process.stdout.write(
    `LIBREOFFICE_PACKAGING_GATE_OK ${result.version} ${result.installerSha256}\n`,
  )
}
