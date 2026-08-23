import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentSnapshotV1 } from '@shared/xiaogui-document-snapshot'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import {
  WorkDocumentSnapshotServiceV1,
  normalizePageText,
  sha256OfText,
  type WorkDocumentSnapshotDialogPortV1,
} from './work-document-snapshot-service'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-doc-snapshot-test-'))
  roots.push(root)
  return root
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    })),
  }
}

function dialogs(pdf: string | null): WorkDocumentSnapshotDialogPortV1 {
  return { choosePdf: vi.fn(async () => pdf) }
}

function digest(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/* ------------------------- 极简 PDF 构造器（仅测试用） ------------------------- */

function pdfObject(n: number, body: string): Buffer {
  return Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, 'latin1')
}

function assemblePdf(objects: Buffer[], trailerExtra = ''): Buffer {
  const header = Buffer.from('%PDF-1.4\n', 'latin1')
  const parts = [header, ...objects]
  const offsets: number[] = []
  let position = 0
  for (const part of parts) {
    offsets.push(position)
    position += part.length
  }
  const xrefOffset = position
  const lines: string[] = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n']
  for (let i = 0; i < objects.length; i++) {
    lines.push(`${String(offsets[i + 1]).padStart(10, '0')} 00000 n \n`)
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`
  return Buffer.concat([...parts, Buffer.from(lines.join('') + trailer, 'latin1')])
}

function escapeLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** 每页若干行文本（Helvetica/WinAnsi），生成结构完整的真实 PDF。 */
function buildTextPdf(pageLines: string[][], lineAdvance = -20): Buffer {
  const n = pageLines.length
  const fontObj = 2 * n + 3
  const kids = pageLines.map((_, i) => `${2 * i + 3} 0 R`).join(' ')
  const objects: Buffer[] = []
  objects.push(pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'))
  objects.push(pdfObject(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`))
  pageLines.forEach((lines, i) => {
    const ops = lines
      .map((line, j) => `(${escapeLiteral(line)}) Tj` + (j < lines.length - 1 ? ` 0 ${lineAdvance} Td` : ''))
      .join(' ')
    const stream = `BT /F1 12 Tf 72 720 Td ${ops} ET`
    objects.push(
      pdfObject(
        2 * i + 3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${2 * i + 4} 0 R >>`,
      ),
    )
    objects.push(pdfObject(2 * i + 4, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`))
  })
  objects.push(
    pdfObject(fontObj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  )
  return assemblePdf(objects)
}

/** 无文本页面（只有图形绘制），模拟扫描件/空白页。 */
function buildBlankPdf(): Buffer {
  const stream = 'q 0.5 0.5 0.5 rg 72 72 100 100 re f Q'
  return assemblePdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    pdfObject(4, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`),
    pdfObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  ])
}

/* ------------------------- RC4 加密 PDF（V=1 / R=2，仅测试用） ------------------------- */

const PAD_BYTES = Buffer.from(
  '\x28\xbf\x4e\x5e\x4e\x75\x8a\x41\x64\x00\x4e\x56\xff\xfa\x01\x08' +
    '\x2e\x2e\x00\xb6\xd0\x68\x3e\x80\x2f\x0c\xa9\xfe\x64\x53\x69\x7a',
  'latin1',
)

function md5(data: Buffer): Buffer {
  return createHash('md5').update(data).digest()
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const swap = s[i]
    s[i] = s[j]
    s[j] = swap
  }
  const out = Buffer.alloc(data.length)
  let i = 0
  j = 0
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const swap = s[i]
    s[i] = s[j]
    s[j] = swap
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

function padPassword(password: string): Buffer {
  const raw = Buffer.from(password, 'latin1')
  const padded = Buffer.alloc(32)
  raw.copy(padded, 0, 0, Math.min(raw.length, 32))
  if (raw.length < 32) PAD_BYTES.copy(padded, raw.length, 0, 32 - raw.length)
  return padded
}

/** 用户口令非空的标准安全处理器加密 PDF；无口令打开必须抛 PasswordException。 */
function buildEncryptedPdf(userPassword: string, ownerPassword: string, pageText: string): Buffer {
  const paddedUser = padPassword(userPassword)
  const paddedOwner = padPassword(ownerPassword)
  const ownerKey = md5(paddedOwner).subarray(0, 5)
  const O = rc4(ownerKey, paddedUser)
  const fileId = Buffer.from('ab'.repeat(16), 'hex')
  const p = Buffer.from([0xd4, 0xff, 0xff, 0xff])
  const fileKey = md5(Buffer.concat([paddedUser, O, p, fileId])).subarray(0, 5)
  const U = rc4(fileKey, PAD_BYTES)
  const objectKey = md5(Buffer.concat([fileKey, Buffer.from([4, 0, 0, 0, 0])])).subarray(0, 5)
  const stream = Buffer.from(`BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET`, 'latin1')
  const encrypted = rc4(objectKey, stream)
  const trailerExtra =
    ` /Encrypt << /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P -44 >>` +
    ` /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]`
  return assemblePdf(
    [
      pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      pdfObject(
        3,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      ),
      Buffer.concat([
        pdfObject(4, `<< /Length ${encrypted.length} >>\nstream\n`),
        encrypted,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]),
      pdfObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    ],
    trailerExtra,
  )
}

/* ------------------------- 测试 ------------------------- */

async function createService(
  fixture: { root: string; pdfs: Record<string, string | null> },
  mode: SessionMode = 'WORK',
  options?: { parseTimeoutMs?: number },
) {
  const service = new WorkDocumentSnapshotServiceV1({
    lookup: lookup(mode),
    dialogs: { choosePdf: vi.fn(async () => fixture.pdfs.pick ?? null) },
    tempRoot: join(fixture.root, 'staging'),
    parseTimeoutMs: options?.parseTimeoutMs,
  })
  return service
}

describe('WorkDocumentSnapshotServiceV1', () => {
  it('extracts a real small PDF page by page with stable hashes and repeats identically', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'sample.pdf')
    await writeFile(pdf, buildTextPdf([['Hello page 1'], ['Hello page 2', 'Second line']]))
    const service = await createService({ root, pdfs: { pick: pdf } })

    const first = await service.read({ address: ADDRESS })
    expect(first.ok).toBe(true)
    if (!first.ok || first.value.kind !== 'READY') throw new Error('expected ready')
    const snapshot = first.value.snapshot

    expect(snapshot.version).toBe('document-snapshot.v1')
    expect(snapshot.kind).toBe('PDF')
    expect(snapshot.sourceDisplayName).toBe('sample.pdf')
    expect(snapshot.sourceSha256).toBe(digest(await readFile(pdf)))
    expect(snapshot.extractorId).toBe('unpdf')
    expect(snapshot.extractorVersion).toBe('1.6.2')
    expect(snapshot.pageCount).toBe(2)
    expect(snapshot.pages.map((page) => page.pageNumber)).toEqual([1, 2])
    expect(snapshot.pages[0]!.text).toBe('Hello page 1')
    expect(snapshot.pages[1]!.text).toContain('Hello page 2')
    expect(snapshot.pages[1]!.text).toContain('Second line')
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.originalInputUnchanged).toBe(true)

    for (const page of snapshot.pages) {
      expect(page.textSha256).toBe(sha256OfText(page.text))
    }
    expect(snapshot.contentSha256).toBe(
      sha256OfText(
        JSON.stringify(snapshot.pages.map((page) => ({ pageNumber: page.pageNumber, textSha256: page.textSha256 }))),
      ),
    )

    const second = await service.read({ address: ADDRESS })
    if (!second.ok || second.value.kind !== 'READY') throw new Error('expected ready')
    expect(second.value.snapshot).toEqual(snapshot)

    expect(JSON.stringify(snapshot)).not.toContain(root)
    expect(JSON.stringify(snapshot)).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('returns SCANNED_OR_EMPTY instead of a fake empty success for pages without text', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'scan.pdf')
    await writeFile(pdf, buildBlankPdf())
    const service = await createService({ root, pdfs: { pick: pdf } })

    const outcome = await service.read({ address: ADDRESS })

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        kind: 'READY',
        snapshot: {
          pageCount: 1,
          warnings: ['SCANNED_OR_EMPTY'],
          pages: [{ pageNumber: 1, text: '' }],
        },
      },
    })
    const snapshot = (outcome as { ok: true; value: { kind: 'READY'; snapshot: DocumentSnapshotV1 } }).value.snapshot
    expect(snapshot.pages[0]!.textSha256).toBe(sha256OfText(''))
  })

  it('fails encrypted PDFs explicitly and keeps the original unchanged while cleaning temp files', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'locked.pdf')
    await writeFile(pdf, buildEncryptedPdf('userpass', 'ownerpass', 'Secret text'))
    const original = await readFile(pdf)
    const service = await createService({ root, pdfs: { pick: pdf } })

    const outcome = await service.read({ address: ADDRESS })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'PDF_ENCRYPTED' } })
    expect(await readFile(pdf)).toEqual(original)
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([])
  })

  it('fails corrupt PDFs explicitly and keeps the original unchanged while cleaning temp files', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'broken.pdf')
    await writeFile(pdf, Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from('garbage, no xref')]))
    const original = await readFile(pdf)
    const service = await createService({ root, pdfs: { pick: pdf } })

    const outcome = await service.read({ address: ADDRESS })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'PDF_CORRUPTED' } })
    expect(await readFile(pdf)).toEqual(original)
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([])
  })

  it('returns a normal cancellation result when the user closes the picker', async () => {
    const root = await fixtureRoot()
    const service = await createService({ root, pdfs: { pick: null } })

    await expect(service.read({ address: ADDRESS })).resolves.toEqual({
      ok: true,
      value: { kind: 'CANCELLED' },
    })
  })

  it.each(['DESIGN', 'CODING'] as const)('rejects %s sessions before the picker runs', async (mode) => {
    const root = await fixtureRoot()
    const service = await createService({ root, pdfs: { pick: null } }, mode)

    const outcome = await service.read({ address: ADDRESS })

    expect(outcome).toMatchObject({ ok: false, error: { code: 'MODE_NOT_ALLOWED' } })
  })

  it('rejects input over 20 MiB, wrong extension, and non-PDF headers at the right boundaries', async () => {
    const root = await fixtureRoot()

    const oversized = join(root, 'huge.pdf')
    await writeFile(
      oversized,
      Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(20 * 1024 * 1024)]),
    )
    const bigService = await createService({ root, pdfs: { pick: oversized } })
    await expect(bigService.read({ address: ADDRESS })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INPUT_TOO_LARGE' },
    })

    const wrongExt = join(root, 'notes.txt')
    await writeFile(wrongExt, buildTextPdf([['hello']]))
    const extService = await createService({ root, pdfs: { pick: wrongExt } })
    await expect(extService.read({ address: ADDRESS })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INPUT_INVALID' },
    })

    const badHeader = join(root, 'fake.pdf')
    await writeFile(badHeader, 'not a pdf at all')
    const headerService = await createService({ root, pdfs: { pick: badHeader } })
    await expect(headerService.read({ address: ADDRESS })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INPUT_INVALID' },
    })
  })

  it('rejects page ranges outside the 20-page window and beyond the document', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'three.pdf')
    await writeFile(pdf, buildTextPdf([['p1'], ['p2'], ['p3']]))
    const service = await createService({ root, pdfs: { pick: pdf } })

    await expect(service.read({ address: ADDRESS, startPage: 1, endPage: 21 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_RANGE_INVALID' },
    })
    await expect(service.read({ address: ADDRESS, startPage: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_RANGE_INVALID' },
    })
    await expect(service.read({ address: ADDRESS, startPage: 3, endPage: 2 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_RANGE_INVALID' },
    })
    await expect(service.read({ address: ADDRESS, startPage: 4 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PAGE_RANGE_INVALID' },
    })

    const ranged = await service.read({ address: ADDRESS, startPage: 2, endPage: 3 })
    expect(ranged).toMatchObject({
      ok: true,
      value: {
        kind: 'READY',
        snapshot: {
          pageCount: 3,
          pages: [
            { pageNumber: 2, text: 'p2' },
            { pageNumber: 3, text: 'p3' },
          ],
          warnings: [],
        },
      },
    })
  })

  it('reads at most 20 pages by default and marks TRUNCATED on longer documents', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'long.pdf')
    await writeFile(
      pdf,
      buildTextPdf(Array.from({ length: 25 }, (_, i) => [`Page ${i + 1} body`])),
    )
    const service = await createService({ root, pdfs: { pick: pdf } })

    const outcome = await service.read({ address: ADDRESS })

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        kind: 'READY',
        snapshot: {
          pageCount: 25,
          warnings: ['TRUNCATED'],
        },
      },
    })
    const snapshot = (outcome as { ok: true; value: { kind: 'READY'; snapshot: DocumentSnapshotV1 } }).value.snapshot
    expect(snapshot.pages).toHaveLength(20)
    expect(snapshot.pages[0]!.pageNumber).toBe(1)
    expect(snapshot.pages[19]!.pageNumber).toBe(20)
  })

  it('stops immediately at the per-page and total character caps with TRUNCATED', async () => {
    const root = await fixtureRoot()
    // pdf.js 会丢弃页面边界外的文本项，因此用多行（每行 80 字符、小行距）构造超限页。
    const longLines = Array.from({ length: 300 }, () => 'x'.repeat(80))
    const pdf = join(root, 'caps.pdf')
    await writeFile(pdf, buildTextPdf([['small first'], longLines], -2))
    const pageCapService = await createService({ root, pdfs: { pick: pdf } })
    const pageCapped = await pageCapService.read({ address: ADDRESS })
    expect(pageCapped).toMatchObject({
      ok: true,
      value: {
        kind: 'READY',
        snapshot: { warnings: ['TRUNCATED'] },
      },
    })
    const pageSnap = (pageCapped as { ok: true; value: { kind: 'READY'; snapshot: DocumentSnapshotV1 } }).value.snapshot
    expect(pageSnap.pages.map((page) => page.pageNumber)).toEqual([1])
    expect(pageSnap.pages[0]!.text).toBe('small first')

    const firstLong = join(root, 'first-long.pdf')
    await writeFile(firstLong, buildTextPdf([longLines], -2))
    const firstLongService = await createService({ root, pdfs: { pick: firstLong } })
    const firstLongOutcome = await firstLongService.read({ address: ADDRESS })
    expect(firstLongOutcome).toMatchObject({
      ok: true,
      value: {
        kind: 'READY',
        snapshot: { pages: [], warnings: ['TRUNCATED'] },
      },
    })

    const big = join(root, 'total.pdf')
    const pageLines = Array.from({ length: 213 }, () => 'z'.repeat(80))
    await writeFile(big, buildTextPdf(Array.from({ length: 6 }, () => pageLines), -2))
    const totalService = await createService({ root, pdfs: { pick: big } })
    const totalCapped = await totalService.read({ address: ADDRESS })
    expect(totalCapped.ok).toBe(true)
    if (!totalCapped.ok || totalCapped.value.kind !== 'READY') throw new Error('expected ready')
    expect(totalCapped.value.snapshot.warnings).toEqual(['TRUNCATED'])
    expect(totalCapped.value.snapshot.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5])
  })

  it('enforces the parse deadline and the cancellation signal before cleanup', async () => {
    const root = await fixtureRoot()
    const pdf = join(root, 'slow.pdf')
    await writeFile(pdf, buildTextPdf([['hello']]))
    const original = await readFile(pdf)

    const timed = await createService({ root, pdfs: { pick: pdf } }, 'WORK', { parseTimeoutMs: 0 })
    await expect(timed.read({ address: ADDRESS })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PARSE_TIMEOUT' },
    })
    expect(await readFile(pdf)).toEqual(original)
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([])

    const controller = new AbortController()
    controller.abort()
    const aborted = await createService({ root, pdfs: { pick: pdf } })
    await expect(aborted.read({ address: ADDRESS }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PARSE_ABORTED' },
    })
  })
})

describe('snapshot text normalization', () => {
  it('unifies line endings, strips trailing whitespace and blank lines, keeps inner spacing', () => {
    expect(normalizePageText('a  b \r\n\tc\t\n\n\n d \n\n')).toBe('a  b\n\tc\n\n\n d')
    expect(normalizePageText('\r\n\r\nx\r\ny\r\n')).toBe('x\ny')
    expect(normalizePageText('')).toBe('')
    expect(normalizePageText('  spaced  words  ')).toBe('  spaced  words')
  })

  it('normalizes to NFC so identical glyph sequences hash identically', () => {
    const composed = normalizePageText('caf\u00e9')
    const decomposed = normalizePageText('cafe\u0301')
    expect(composed).toBe(decomposed)
    expect(sha256OfText(composed)).toBe(sha256OfText(decomposed))
  })
})
