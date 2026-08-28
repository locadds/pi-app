import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertDDriveCacheRoot,
  LIBREOFFICE_CONTRACT,
} from './verify-libreoffice-runtime.mjs'

const VERSION = LIBREOFFICE_CONTRACT.version
const FILE_NAME = LIBREOFFICE_CONTRACT.fileName
const DOWNLOAD_URL = LIBREOFFICE_CONTRACT.downloadUrl
const SOURCE_URL = LIBREOFFICE_CONTRACT.sourceUrl
const EXPECTED_SHA256 = LIBREOFFICE_CONTRACT.installerSha256
const EXPECTED_BYTES = LIBREOFFICE_CONTRACT.installerBytes

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDirectory, '..')
const cacheRoot = resolve(
  process.env.XIAOGUI_LIBREOFFICE_CACHE_ROOT || 'D:\\CodexTemp\\xiaogui-libreoffice-cache',
)
const installerPath = join(cacheRoot, FILE_NAME)
const extractRoot = join(cacheRoot, `admin-${VERSION}`)
const stagingRoot = join(workspaceRoot, 'resources', 'libreoffice-runtime', 'runtime')

function assertContained(root, target) {
  const difference = relative(resolve(root), resolve(target))
  if (difference === '' || difference === '..' || difference.startsWith(`..${sep}`)) {
    throw new Error(`REFUSE_BROAD_PATH:${target}`)
  }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadIfNeeded() {
  try {
    const information = await stat(installerPath)
    if (information.size === EXPECTED_BYTES && await sha256(installerPath) === EXPECTED_SHA256) return
  } catch {
    // Download below.
  }
  await mkdir(cacheRoot, { recursive: true })
  const temporary = `${installerPath}.download`
  await rm(temporary, { force: true })
  const response = await fetch(DOWNLOAD_URL, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`DOWNLOAD_FAILED:${response.status}`)
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(temporary, { flags: 'wx' }),
  )
  const information = await stat(temporary)
  const digest = await sha256(temporary)
  if (information.size !== EXPECTED_BYTES || digest !== EXPECTED_SHA256) {
    await rm(temporary, { force: true })
    throw new Error('LIBREOFFICE_INSTALLER_CHECKSUM_MISMATCH')
  }
  await rm(installerPath, { force: true })
  await rename(temporary, installerPath)
}

async function run(executable, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'inherit', shell: false })
    child.once('error', rejectRun)
    child.once('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`PROCESS_FAILED:${code}`)))
  })
}

async function findSoffice(root) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const found = await findSoffice(path)
      if (found) return found
    } else if (entry.isFile() && entry.name.toLowerCase() === 'soffice.exe') {
      return path
    }
  }
  return null
}

async function main() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_X64_ONLY')
  assertDDriveCacheRoot(cacheRoot)
  assertContained(cacheRoot, extractRoot)
  assertContained(workspaceRoot, stagingRoot)
  await downloadIfNeeded()
  await rm(extractRoot, { recursive: true, force: true })
  await mkdir(extractRoot, { recursive: true })
  await run('msiexec.exe', ['/a', installerPath, '/qn', `TARGETDIR=${extractRoot}`])
  const soffice = await findSoffice(extractRoot)
  if (!soffice) throw new Error('LIBREOFFICE_RUNTIME_NOT_FOUND')
  const installationRoot = dirname(dirname(await realpath(soffice)))
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  await cp(installationRoot, stagingRoot, { recursive: true, force: true })
  const stagedSoffice = join(stagingRoot, 'program', 'soffice.exe')
  await stat(stagedSoffice)
  const notice = [
    `LibreOffice ${VERSION} Windows x64 private runtime`,
    `Source: ${DOWNLOAD_URL}`,
    `Installer SHA-256: ${EXPECTED_SHA256}`,
    'License: MPL-2.0 and bundled third-party notices from the official distribution.',
    `Source code: ${SOURCE_URL}`,
    '',
  ].join('\n')
  await writeFile(join(stagingRoot, 'XIAOGUI_RUNTIME_NOTICE.txt'), notice)
  const manifest = {
    version: VERSION,
    sourceUrl: DOWNLOAD_URL,
    sourceCodeUrl: SOURCE_URL,
    installerSha256: EXPECTED_SHA256,
    installerBytes: EXPECTED_BYTES,
    executable: 'program/soffice.exe',
  }
  await writeFile(join(stagingRoot, 'xiaogui-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const verified = JSON.parse(await readFile(join(stagingRoot, 'xiaogui-runtime-manifest.json'), 'utf8'))
  if (verified.installerSha256 !== EXPECTED_SHA256) throw new Error('RUNTIME_MANIFEST_INVALID')
  process.stdout.write(`LIBREOFFICE_RUNTIME_READY ${stagingRoot}\n`)
}

await main()
