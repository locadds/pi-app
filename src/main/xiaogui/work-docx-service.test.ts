import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Document, Packer, Paragraph, TextRun, patchDetector } from 'docx'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import {
  WorkDocxServiceV1,
  type WorkDocxDialogPortV1,
  type WorkDocxOutputAccessPortV1,
} from './work-docx-service'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-work-docx-test-'))
  roots.push(root)
  return root
}

async function writeTemplate(path: string): Promise<void> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('项目名称：{{project}}')] }),
          new Paragraph({ children: [new TextRun('负责人：{{owner}}')] }),
        ],
      },
    ],
  })
  await writeFile(path, await Packer.toBuffer(document))
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    })),
  }
}

function unresolvedLookup(kind: 'NOT_FOUND' | 'PROJECT_MISMATCH'): SessionScopeLookupV1 {
  return { lookup: vi.fn(async () => ({ kind })) }
}

function dialogs(template: string, payload: string, target: string): WorkDocxDialogPortV1 {
  return {
    chooseTemplate: vi.fn(async () => template),
    choosePayload: vi.fn(async () => payload),
    chooseNewTarget: vi.fn(async () => target),
  }
}

async function createFixture() {
  const root = await fixtureRoot()
  const template = join(root, 'template.docx')
  const payload = join(root, 'payload.json')
  const target = join(root, 'generated.docx')
  await writeTemplate(template)
  await writeFile(payload, JSON.stringify({ project: '中央活力区', owner: '规划一组' }), 'utf8')
  return { root, template, payload, target }
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('WorkDocxServiceV1', () => {
  it('uses real docx patching, keeps inputs unchanged, and publishes once', async () => {
    const fixture = await createFixture()
    const templateBefore = await readFile(fixture.template)
    const payloadBefore = await readFile(fixture.payload)
    const outputAccess: WorkDocxOutputAccessPortV1 = {
      openPath: vi.fn().mockResolvedValueOnce('暂时失败').mockResolvedValue(''),
      revealPath: vi.fn(async () => {}),
    }
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
      outputAccess,
    })

    const prepared = await service.prepare({ address: ADDRESS })
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        kind: 'PREPARED',
        templateDisplayName: 'template.docx',
        payloadDisplayName: 'payload.json',
        placeholders: ['owner', 'project'],
      },
    })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')

    const published = await service.confirm({ address: ADDRESS, operationId: prepared.value.operationId })
    expect(published).toMatchObject({
      ok: true,
      value: { kind: 'PUBLISHED', originalInputsUnchanged: true },
    })
    if (!published.ok) throw new Error('expected published')

    const output = await readFile(fixture.target)
    expect(await patchDetector({ data: output })).toEqual([])
    const zip = await JSZip.loadAsync(output)
    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('中央活力区')
    expect(documentXml).toContain('规划一组')
    expect(await readFile(fixture.template)).toEqual(templateBefore)
    expect(await readFile(fixture.payload)).toEqual(payloadBefore)
    expect(published.value.outputSha256).toBe(digest(output))

    await expect(
      service.confirm({ address: ADDRESS, operationId: prepared.value.operationId }),
    ).resolves.toEqual(published)

    await expect(
      service.accessOutput({ address: ADDRESS, operationId: prepared.value.operationId, action: 'OPEN' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'OUTPUT_ACCESS_FAILED',
        messageKey: 'xiaogui.work.docx.output_access_failed',
      },
    })
    await expect(
      service.accessOutput({ address: ADDRESS, operationId: prepared.value.operationId, action: 'OPEN' }),
    ).resolves.toEqual({
      ok: true,
      value: { kind: 'ACCESSED', operationId: prepared.value.operationId, action: 'OPEN' },
    })
    await expect(
      service.accessOutput({ address: ADDRESS, operationId: prepared.value.operationId, action: 'REVEAL' }),
    ).resolves.toEqual({
      ok: true,
      value: { kind: 'ACCESSED', operationId: prepared.value.operationId, action: 'REVEAL' },
    })
    expect(outputAccess.openPath).toHaveBeenCalledWith(fixture.target)
    expect(outputAccess.revealPath).toHaveBeenCalledWith(fixture.target)

    const otherAddress = {
      projectId: ADDRESS.projectId,
      sessionKey: `xgs1_${'3'.repeat(64)}`,
    } as SessionAddressV1
    await expect(
      service.confirm({ address: otherAddress, operationId: prepared.value.operationId }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'OPERATION_SCOPE_MISMATCH',
        messageKey: 'xiaogui.work.docx.operation_scope_mismatch',
      },
    })
    await expect(
      service.accessOutput({ address: otherAddress, operationId: prepared.value.operationId, action: 'OPEN' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'OPERATION_SCOPE_MISMATCH',
        messageKey: 'xiaogui.work.docx.operation_scope_mismatch',
      },
    })
  })

  it.each(['DESIGN', 'CODING'] as const)('rejects %s before opening a dialog', async (mode) => {
    const fixture = await createFixture()
    const dialogPort = dialogs(fixture.template, fixture.payload, fixture.target)
    const service = new WorkDocxServiceV1({
      lookup: lookup(mode),
      dialogs: dialogPort,
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: false,
      error: { code: 'MODE_NOT_ALLOWED', messageKey: 'xiaogui.work.docx.mode_not_allowed' },
    })
    expect(dialogPort.chooseTemplate).not.toHaveBeenCalled()
  })

  it.each([
    ['NOT_FOUND', 'SCOPE_NOT_FOUND'],
    ['PROJECT_MISMATCH', 'SCOPE_MISMATCH'],
  ] as const)('fails closed for %s before opening a dialog', async (lookupKind, errorCode) => {
    const fixture = await createFixture()
    const dialogPort = dialogs(fixture.template, fixture.payload, fixture.target)
    const service = new WorkDocxServiceV1({
      lookup: unresolvedLookup(lookupKind),
      dialogs: dialogPort,
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: false,
      error: { code: errorCode, messageKey: `xiaogui.work.docx.${errorCode.toLowerCase()}` },
    })
    expect(dialogPort.chooseTemplate).not.toHaveBeenCalled()
  })

  it('returns an explicit cancellation without staging or publishing', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: {
        chooseTemplate: vi.fn(async () => null),
        choosePayload: vi.fn(async () => fixture.payload),
        chooseNewTarget: vi.fn(async () => fixture.target),
      },
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: true,
      value: { kind: 'CANCELLED' },
    })
    await expect(readFile(fixture.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects missing placeholder data before producing an operation', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.payload, JSON.stringify({ project: '中央活力区' }), 'utf8')
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: false,
      error: { code: 'PLACEHOLDER_MISSING', messageKey: 'xiaogui.work.docx.placeholder_missing' },
    })
  })

  it('rejects external relationships in the template', async () => {
    const fixture = await createFixture()
    const zip = await JSZip.loadAsync(await readFile(fixture.template))
    zip.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>',
    )
    await writeFile(fixture.template, await zip.generateAsync({ type: 'nodebuffer' }))
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: false,
      error: { code: 'UNSAFE_DOCX', messageKey: 'xiaogui.work.docx.unsafe_docx' },
    })
  })

  it('rejects a macro payload in the template', async () => {
    const fixture = await createFixture()
    const zip = await JSZip.loadAsync(await readFile(fixture.template))
    zip.file('word/vbaProject.bin', Buffer.from('not-a-real-macro'))
    await writeFile(fixture.template, await zip.generateAsync({ type: 'nodebuffer' }))
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: false,
      error: { code: 'UNSAFE_DOCX', messageKey: 'xiaogui.work.docx.unsafe_docx' },
    })
  })

  it('rejects an existing save-as target', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.target, 'existing', 'utf8')
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })

    await expect(service.prepare({ address: ADDRESS })).resolves.toEqual({
      ok: false,
      error: { code: 'TARGET_EXISTS', messageKey: 'xiaogui.work.docx.target_exists' },
    })
  })

  it('fails closed when an original input changes after prepare', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const prepared = await service.prepare({ address: ADDRESS })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')
    await writeFile(fixture.payload, JSON.stringify({ project: '已变化', owner: '规划一组' }), 'utf8')

    await expect(
      service.confirm({ address: ADDRESS, operationId: prepared.value.operationId }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'SOURCE_CHANGED', messageKey: 'xiaogui.work.docx.source_changed' },
    })
    await expect(readFile(fixture.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancel removes the prepared record and stage directory', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const prepared = await service.prepare({ address: ADDRESS })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')
    const { operationId } = prepared.value

    const cancelled = await service.cancel({ address: ADDRESS, operationId })
    expect(cancelled).toEqual({ ok: true, value: { kind: 'CANCELLED', operationId } })

    await expect(
      service.confirm({ address: ADDRESS, operationId }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_NOT_FOUND', messageKey: 'xiaogui.work.docx.operation_not_found' },
    })
    await expect(readFile(fixture.target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(fixture.root, 'staging'))).resolves.toEqual([])
  })

  it('cancel rejects a cross-session operation', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const prepared = await service.prepare({ address: ADDRESS })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')
    const { operationId } = prepared.value

    const otherAddress = {
      projectId: ADDRESS.projectId,
      sessionKey: `xgs1_${'4'.repeat(64)}`,
    } as SessionAddressV1

    await expect(service.cancel({ address: otherAddress, operationId })).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_SCOPE_MISMATCH', messageKey: 'xiaogui.work.docx.operation_scope_mismatch' },
    })
    await expect(service.cancel({ address: ADDRESS, operationId })).resolves.toEqual({
      ok: true,
      value: { kind: 'CANCELLED', operationId },
    })
  })

  it('cancel rejects an unknown operation id', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const fakeId = `xgw1_${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`

    await expect(
      service.cancel({ address: ADDRESS, operationId: fakeId as import('@shared/xiaogui-work-docx').WorkDocxOperationIdV1 }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_NOT_FOUND', messageKey: 'xiaogui.work.docx.operation_not_found' },
    })
  })

  it('cancel rejects an already-completed operation', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const prepared = await service.prepare({ address: ADDRESS })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')
    const { operationId } = prepared.value

    await service.confirm({ address: ADDRESS, operationId })

    await expect(service.cancel({ address: ADDRESS, operationId })).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_NOT_FOUND', messageKey: 'xiaogui.work.docx.operation_not_found' },
    })
  })

  it('cancel removes only the selected operation', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const first = await service.prepare({ address: ADDRESS })
    const second = await service.prepare({ address: ADDRESS })
    if (!first.ok || first.value.kind !== 'PREPARED') throw new Error('expected first prepared')
    if (!second.ok || second.value.kind !== 'PREPARED') throw new Error('expected second prepared')

    await expect(service.cancel({ address: ADDRESS, operationId: first.value.operationId })).resolves.toEqual({
      ok: true,
      value: { kind: 'CANCELLED', operationId: first.value.operationId },
    })
    await expect(service.confirm({ address: ADDRESS, operationId: second.value.operationId })).resolves.toMatchObject({
      ok: true,
      value: { kind: 'PUBLISHED', operationId: second.value.operationId },
    })
  })

  it('does not report cancellation after confirmation has claimed the operation', async () => {
    const fixture = await createFixture()
    const service = new WorkDocxServiceV1({
      lookup: lookup('WORK'),
      dialogs: dialogs(fixture.template, fixture.payload, fixture.target),
      tempRoot: join(fixture.root, 'staging'),
    })
    const prepared = await service.prepare({ address: ADDRESS })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')

    const confirming = service.confirm({ address: ADDRESS, operationId: prepared.value.operationId })
    await expect(service.cancel({ address: ADDRESS, operationId: prepared.value.operationId })).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_NOT_FOUND', messageKey: 'xiaogui.work.docx.operation_not_found' },
    })
    await expect(confirming).resolves.toMatchObject({
      ok: true,
      value: { kind: 'PUBLISHED', operationId: prepared.value.operationId },
    })
  })
})
