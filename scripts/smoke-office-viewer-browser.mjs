import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { startOfficeGatewayV1 } from '../out/office-gateway/server.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const profileDir = process.env.XIAOGUI_OFFICE_BROWSER_PROFILE ?? 'D:\\CodexTemp\\xiaogui-office-browser-profile'
const executablePath =
  process.env.XIAOGUI_OFFICE_BROWSER_EXECUTABLE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
await mkdir(profileDir, { recursive: true })

const cookieName = `xiaogui_office_browser_${randomBytes(6).toString('hex')}`
const token = randomBytes(48).toString('base64url')
const projectedText = [
  '模板资产化试验文档',
  '项目名称：下盐公路电力排管迁改工程',
  '建设单位：华东送变电工程有限公司',
  '复核摘要：下盐公路电力排管迁改工程正在整理为模板资产。',
  '本视图用于核对字段图谱、编辑工作副本和恢复状态。',
].join('\n')
const projectName = '下盐公路电力排管迁改工程'
const projectStart = projectedText.indexOf(projectName)
const projectSecondStart = projectedText.indexOf(projectName, projectStart + projectName.length)
const replacementProjectName = '临港测试项目'
const channelNonce = randomBytes(32).toString('hex')
const smokeImageSource = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xcw6WQAAAABJRU5ErkJggg=='
const drawingIds = {
  body: 'smoke-body-image',
  table: 'smoke-table-image',
  header: 'smoke-header-image',
  footer: 'smoke-footer-image',
}
const structuredDrawingWarning = `XIAOGUI_DOCX_DRAWING_DEGRADATION_V1:${JSON.stringify({
  kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION',
  version: 1,
  id: 'body-0-5-unsupported_format',
  part: 'BODY',
  partIndex: 0,
  sequence: 5,
  severity: 'WARNING',
  reason: 'UNSUPPORTED_FORMAT',
  message: '正文绘图对象 5 使用暂不支持的 EMF 图片。',
  relationshipId: 'rEmf',
  packagePath: 'word/media/image.emf',
  format: 'EMF',
})}`
const projectedOccurrences = [projectStart, projectSecondStart].map((start, index) => ({
  occurrenceId: `occurrence.project.name.${index + 1}`,
  fieldId: 'project.name',
  originalText: projectName,
  startUtf16: start,
  endUtf16Exclusive: start + projectName.length,
  state: 'FIELD',
}))
const initialProjection = {
  projectionVersion: 1,
  kind: 'XIAOGUI_DOCX_STRUCTURED_PROJECTION',
  documentId: 'xiaogui-office-real-projection-smoke',
  title: '模板资产化与 Office Surface 联合冒烟',
  sourceSha256: createHash('sha256').update(projectedText).digest('hex'),
  purpose: 'TEMPLATE_DRAFT',
  readOnly: false,
  plainText: projectedText,
  univerDocument: createSmokeUniverDocument(projectedText, projectedOccurrences),
  fields: [
    {
      fieldId: 'project.name',
      displayName: '项目名称',
      occurrenceIds: ['occurrence.project.name.1', 'occurrence.project.name.2'],
    },
  ],
  occurrences: projectedOccurrences,
  warnings: [
    '当前为 DOCX 结构化试验视图，不代表 Word 原版式。',
    structuredDrawingWarning,
    '页眉、页脚和表格内图片必须随工作副本一起保存。',
  ],
  statistics: {
    paragraphCount: 4,
    tableCount: 1,
    tableCellCount: 1,
    mappedOccurrenceCount: 2,
    unmappedOccurrenceCount: 0,
  },
}

function createSmokeUniverDocument(text, occurrences) {
  const textStream = text.replaceAll('\n', '\r')
  let dataStream = `${textStream}\r`
  const bodyDrawingIndex = dataStream.length
  dataStream += '\b\r'
  const tableStart = dataStream.length
  dataStream += '\x1A\x1B\x1C'
  const tableDrawingIndex = dataStream.length
  dataStream += '\b\r\n\x1D\x0E\x0F'
  const tableEnd = dataStream.length
  dataStream += '\n'
  const boundaries = new Set([0, textStream.length])
  for (const occurrence of occurrences) {
    boundaries.add(occurrence.startUtf16)
    boundaries.add(occurrence.endUtf16Exclusive)
  }
  const points = [...boundaries].sort((left, right) => left - right)
  const textRuns = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (end <= start) continue
    const highlighted = occurrences.some(
      (occurrence) => occurrence.startUtf16 <= start && end <= occurrence.endUtf16Exclusive,
    )
    textRuns.push({
      st: start,
      ed: end,
      ts: highlighted ? { bg: { rgb: '#FFF2B2' } } : {},
    })
  }
  return {
    id: 'xiaogui-office-real-projection-smoke',
    title: '模板资产化与 Office Surface 联合冒烟',
    documentStyle: {
      pageSize: { width: 793.7, height: 1122.5 },
      documentFlavor: 1,
      marginTop: 96,
      marginBottom: 96,
      marginLeft: 96,
      marginRight: 96,
      marginHeader: 48,
      marginFooter: 48,
      defaultHeaderId: 'smoke-header',
      defaultFooterId: 'smoke-footer',
      firstPageHeaderId: '',
      firstPageFooterId: '',
      evenPageHeaderId: '',
      evenPageFooterId: '',
      evenAndOddHeaders: 0,
      useFirstPageHeaderFooter: 0,
      paragraphLineGapDefault: 0,
      renderConfig: {
        zeroWidthParagraphBreak: 0,
        vertexAngle: 0,
        centerAngle: 0,
        background: { rgb: '#d9d9d9' },
      },
      textStyle: {},
    },
    body: {
      dataStream,
      textRuns,
      paragraphs: [...dataStream.matchAll(/\r/g)].map((match) => ({
        startIndex: match.index,
        paragraphStyle: {},
      })),
      sectionBreaks: [...dataStream.matchAll(/\n/g)].map((match) => ({ startIndex: match.index })),
      customBlocks: [
        { startIndex: bodyDrawingIndex, blockId: drawingIds.body, blockType: 0 },
        { startIndex: tableDrawingIndex, blockId: drawingIds.table, blockType: 0 },
      ],
      customRanges: [],
      customDecorations: [],
      tables: [{ startIndex: tableStart, endIndex: tableEnd, tableId: 'smoke-table-1' }],
    },
    tableSource: {
      'smoke-table-1': {
        tableId: 'smoke-table-1',
        tableRows: [{
          tableCells: [{}],
          trHeight: { val: { v: 64 }, hRule: 1 },
        }],
        tableColumns: [{ size: { type: 1, width: { v: 320 } } }],
        align: 0,
        indent: { v: 0 },
        textWrap: 0,
        position: {
          positionH: { relativeFrom: 0, posOffset: 0 },
          positionV: { relativeFrom: 0, posOffset: 0 },
        },
        dist: { distT: 0, distB: 0, distL: 0, distR: 0 },
        size: { type: 1, width: { v: 320 } },
      },
    },
    headers: {
      'smoke-header': {
        headerId: 'smoke-header',
        body: createHeaderFooterBody(drawingIds.header),
      },
    },
    footers: {
      'smoke-footer': {
        footerId: 'smoke-footer',
        body: createHeaderFooterBody(drawingIds.footer),
      },
    },
    drawings: {
      [drawingIds.body]: createSmokeDrawing(drawingIds.body, 16, 20, 96, 48),
      [drawingIds.table]: createSmokeDrawing(drawingIds.table, 8, 8, 64, 32),
      [drawingIds.header]: createSmokeDrawing(drawingIds.header, 0, 0, 80, 24, true),
      [drawingIds.footer]: createSmokeDrawing(drawingIds.footer, 0, 0, 72, 20, true),
    },
    drawingsOrder: Object.values(drawingIds),
    headerFooterDrawingsOrder: [drawingIds.header, drawingIds.footer],
    resources: [{
      name: 'DOC_DRAWING_PLUGIN',
      data: JSON.stringify({
        data: {
          [drawingIds.body]: createSmokeDrawing(drawingIds.body, 16, 20, 96, 48),
          [drawingIds.table]: createSmokeDrawing(drawingIds.table, 8, 8, 64, 32),
          [drawingIds.header]: createSmokeDrawing(drawingIds.header, 0, 0, 80, 24, true),
          [drawingIds.footer]: createSmokeDrawing(drawingIds.footer, 0, 0, 72, 20, true),
        },
        order: Object.values(drawingIds),
      }),
    }],
  }
}

function createHeaderFooterBody(drawingId) {
  return {
    dataStream: '\b\r\n',
    textRuns: [],
    paragraphs: [{ startIndex: 1, paragraphStyle: {} }],
    sectionBreaks: [{ startIndex: 2 }],
    customBlocks: [{ startIndex: 0, blockId: drawingId, blockType: 0 }],
    customRanges: [],
    customDecorations: [],
    tables: [],
  }
}

function createSmokeDrawing(drawingId, left, top, width, height, multiTransform = false) {
  const transform = { left, top, width, height, angle: 0, flipX: false, flipY: false }
  return {
    drawingId,
    unitId: 'xiaogui-office-real-projection-smoke',
    subUnitId: 'xiaogui-office-real-projection-smoke',
    drawingType: 0,
    imageSourceType: 'BASE64',
    source: smokeImageSource,
    transform,
    ...(multiTransform ? { isMultiTransform: 1, transforms: [transform] } : {}),
    docTransform: {
      size: { width, height },
      positionH: { relativeFrom: 2, posOffset: left },
      positionV: { relativeFrom: 2, posOffset: top },
      angle: 0,
    },
    title: drawingId,
    description: `${drawingId} browser smoke`,
    layoutType: 0,
  }
}
const gateway = await startOfficeGatewayV1({
  sessionCookieName: cookieName,
  sessionToken: token,
  viewerRoot: resolve(projectRoot, 'artifacts', 'office-viewer'),
  initialSnapshot: initialProjection,
})

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: true,
})
try {
  await context.addCookies([
    {
      name: cookieName,
      value: token,
      url: gateway.origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  const page = await context.newPage()
  const pageErrors = []
  const imageConsoleErrors = []
  page.on('console', (message) => {
    process.stderr.write(`[viewer:${message.type()}] ${message.text()}\n`)
    if (message.type() === 'error' && /(?:image|drawing|decode|load)/i.test(message.text())) {
      imageConsoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    pageErrors.push(error.stack ?? error.message)
    process.stderr.write(`[viewer:error] ${error.message}\n`)
  })
  await page.goto(`${gateway.origin}/viewer/?channelNonce=${channelNonce}`, {
    waitUntil: 'domcontentloaded',
  })
  await connectViewer(page, channelNonce)
  try {
    await page.getByText('可以编辑', { exact: true }).waitFor({ timeout: 20_000 })
  } catch (error) {
    process.stderr.write(`[viewer:body] ${await page.locator('body').innerText()}\n`)
    throw error
  }
  await page.getByText('字段已定位', { exact: true }).waitFor({ timeout: 10_000 })
  await assertAllWarningsVisible(page)
  assertNoViewerErrors(pageErrors, imageConsoleErrors)
  await assertStructuredProjection(page, projectName, 2)
  await assertDrawingProjection(page)
  const updateResult = await updateFieldThroughParentBridge(page, channelNonce, replacementProjectName)
  if (updateResult.updatedOccurrenceIds.length !== 2 || updateResult.failedOccurrenceIds.length !== 0) {
    throw new Error(`field sync did not update both occurrences: ${JSON.stringify(updateResult)}`)
  }
  await assertStructuredProjection(page, replacementProjectName, 2)
  await page.getByRole('button', { name: '保存工作副本' }).click()
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 10_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await connectViewer(page, channelNonce)
  await page.getByText('可以编辑', { exact: true }).waitFor({ timeout: 20_000 })
  await page.getByText('字段已定位', { exact: true }).waitFor({ timeout: 10_000 })
  await assertAllWarningsVisible(page)
  assertNoViewerErrors(pageErrors, imageConsoleErrors)
  await assertStructuredProjection(page, replacementProjectName, 2)
  await assertDrawingProjection(page)
  assertNoViewerErrors(pageErrors, imageConsoleErrors)
  const usedJsHeapSize = await page.evaluate(() => {
    return globalThis.performance.memory?.usedJSHeapSize ?? null
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    usedJsHeapSize,
    drawingEvidence: {
      body: drawingIds.body,
      table: drawingIds.table,
      header: drawingIds.header,
      footer: drawingIds.footer,
      saveReloadVerified: true,
      browserDecodeVerified: true,
      canvasBoundary: 'canvas DOM does not expose one stable node per drawing; assertions use persisted public document/resource models, browser Image.decode, mounted document surface, and zero page/image console errors',
    },
  })}\n`)
} finally {
  await context.close()
  await gateway.close()
}

async function connectViewer(page, nonce) {
  await page.evaluate(
    ({ nonce }) =>
      new Promise((resolve, reject) => {
        const channel = new MessageChannel()
        const timer = window.setTimeout(() => reject(new Error('viewer parent bridge ready timeout')), 20_000)
        channel.port1.onmessage = async (event) => {
          if (event.data?.type === 'VIEWER_GATEWAY_READ_REQUEST') {
            const response = await fetch('/api/v1/snapshot', {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            const payload = await response.json()
            channel.port1.postMessage(response.ok
              ? {
                  protocol: 'xiaogui.office-surface.v1',
                  channelNonce: nonce,
                  type: 'PARENT_GATEWAY_RESPONSE',
                  requestId: event.data.requestId,
                  ok: true,
                  headSha256: payload.headSha256,
                  snapshot: payload.snapshot,
                }
              : {
                  protocol: 'xiaogui.office-surface.v1',
                  channelNonce: nonce,
                  type: 'PARENT_GATEWAY_RESPONSE',
                  requestId: event.data.requestId,
                  ok: false,
                  errorCode: payload.error ?? 'OFFICE_GATEWAY_PROXY_FAILED',
                  message: payload.message ?? 'snapshot read failed',
                })
            return
          }
          if (event.data?.type === 'VIEWER_GATEWAY_WRITE_REQUEST') {
            const response = await fetch('/api/v1/snapshot', {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                expectedHeadSha256: event.data.expectedHeadSha256,
                snapshot: event.data.snapshot,
              }),
            })
            const payload = await response.json()
            channel.port1.postMessage(response.ok
              ? {
                  protocol: 'xiaogui.office-surface.v1',
                  channelNonce: nonce,
                  type: 'PARENT_GATEWAY_RESPONSE',
                  requestId: event.data.requestId,
                  ok: true,
                  headSha256: payload.headSha256,
                }
              : {
                  protocol: 'xiaogui.office-surface.v1',
                  channelNonce: nonce,
                  type: 'PARENT_GATEWAY_RESPONSE',
                  requestId: event.data.requestId,
                  ok: false,
                  errorCode: payload.error ?? 'OFFICE_GATEWAY_PROXY_FAILED',
                  message: payload.message ?? 'snapshot write failed',
                })
            return
          }
          if (event.data?.type !== 'VIEWER_READY') return
          window.clearTimeout(timer)
          globalThis.__xiaoguiOfficeSmokePort = channel.port1
          resolve(event.data)
        }
        channel.port1.start()
        window.postMessage(
          {
            protocol: 'xiaogui.office-surface.v1',
            channelNonce: nonce,
            type: 'OFFICE_PORT_OFFER',
          },
          window.location.origin,
          [channel.port2],
        )
      }),
    { nonce },
  )
}

async function updateFieldThroughParentBridge(page, nonce, value) {
  return page.evaluate(
    ({ nonce, value }) =>
      new Promise((resolve, reject) => {
        const port = globalThis.__xiaoguiOfficeSmokePort
        if (!port) return reject(new Error('viewer parent bridge is unavailable'))
        const requestId = `smoke-${Date.now()}`
        const timer = window.setTimeout(() => reject(new Error('field update result timeout')), 20_000)
        const listener = (event) => {
          if (event.data?.type !== 'VIEWER_FIELD_UPDATE_RESULT' || event.data.requestId !== requestId) return
          window.clearTimeout(timer)
          port.removeEventListener('message', listener)
          resolve(event.data)
        }
        port.addEventListener('message', listener)
        port.postMessage({
          protocol: 'xiaogui.office-surface.v1',
          channelNonce: nonce,
          type: 'PARENT_UPDATE_FIELD',
          requestId,
          fieldId: 'project.name',
          value,
          occurrenceIds: ['occurrence.project.name.1', 'occurrence.project.name.2'],
        })
      }),
    { nonce, value },
  )
}

async function assertStructuredProjection(page, fieldText, expectedCount) {
  const persisted = await page.evaluate(async () => {
    const response = await fetch('/api/v1/snapshot', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`snapshot read failed: ${response.status}`)
    return response.json()
  })
  const snapshot = persisted?.snapshot
  const documentSnapshot = snapshot?.kind === 'XIAOGUI_DOCX_STRUCTURED_PROJECTION'
    ? snapshot.univerDocument
    : snapshot?.kind === 'XIAOGUI_UNIVER_WORKTREE'
      ? snapshot.document
      : snapshot
  const projection = snapshot?.kind === 'XIAOGUI_DOCX_STRUCTURED_PROJECTION'
    ? snapshot
    : snapshot?.kind === 'XIAOGUI_UNIVER_WORKTREE'
      ? snapshot.projection
      : null
  const body = documentSnapshot?.body
  const matches = [...String(body?.dataStream ?? '').matchAll(new RegExp(fieldText, 'g'))]
  if (matches.length !== expectedCount) {
    throw new Error(`structured DOCX field occurrence count mismatch: ${matches.length}`)
  }
  for (let index = 0; index < expectedCount; index += 1) {
    const occurrence = projection?.occurrences?.find(
      (item) => item.occurrenceId === `occurrence.project.name.${index + 1}`,
    )
    if (!occurrence) throw new Error('structured DOCX field occurrence metadata is missing')
    if (occurrence.startUtf16 !== matches[index].index || occurrence.endUtf16Exclusive !== matches[index].index + fieldText.length) {
      throw new Error('structured DOCX field occurrence range does not match the text')
    }
    const highlighted = body?.textRuns?.some((run) => (
      run.st <= occurrence.startUtf16
      && occurrence.endUtf16Exclusive <= run.ed
      && run.ts?.bg?.rgb === '#FFF2B2'
    ))
    if (!highlighted) {
      throw new Error('structured DOCX field highlight is missing')
    }
  }
}

async function assertAllWarningsVisible(page) {
  const details = page.locator('[data-office-warning-count="3"]')
  await details.waitFor({ timeout: 10_000 })
  await details.locator('summary').click()
  await page.getByText('当前为 DOCX 结构化试验视图，不代表 Word 原版式。', { exact: true }).waitFor()
  await page.getByText('正文绘图对象 5 使用暂不支持的 EMF 图片。', { exact: true }).waitFor()
  await page.getByText('页眉、页脚和表格内图片必须随工作副本一起保存。', { exact: true }).waitFor()
  const visibleWarningCount = await details.locator('li').count()
  if (visibleWarningCount !== 3) throw new Error(`expected all 3 warnings, found ${visibleWarningCount}`)
}

async function assertDrawingProjection(page) {
  const evidence = await page.evaluate(async ({ ids }) => {
    const response = await fetch('/api/v1/snapshot', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`snapshot read failed: ${response.status}`)
    const persisted = await response.json()
    const snapshot = persisted?.snapshot
    const documentSnapshot = snapshot?.kind === 'XIAOGUI_DOCX_STRUCTURED_PROJECTION'
      ? snapshot.univerDocument
      : snapshot?.kind === 'XIAOGUI_UNIVER_WORKTREE'
        ? snapshot.document
        : snapshot
    const body = documentSnapshot?.body
    const resource = documentSnapshot?.resources?.find((item) => item.name === 'DOC_DRAWING_PLUGIN')
    const parsedResource = resource?.data ? JSON.parse(resource.data) : null
    const failures = []
    for (const id of Object.values(ids)) {
      const drawing = documentSnapshot?.drawings?.[id]
      if (!drawing) {
        failures.push(`${id}: drawing missing`)
        continue
      }
      const image = new Image()
      image.src = drawing.source
      try {
        await image.decode()
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : 'image decode failed'}`)
      }
    }
    return {
      failures,
      bodyBlock: body?.customBlocks?.find((item) => item.blockId === ids.body),
      tableBlock: body?.customBlocks?.find((item) => item.blockId === ids.table),
      bodyStream: body?.dataStream ?? '',
      table: body?.tables?.[0] ?? null,
      headerBlock: documentSnapshot?.headers?.['smoke-header']?.body?.customBlocks?.find((item) => item.blockId === ids.header),
      footerBlock: documentSnapshot?.footers?.['smoke-footer']?.body?.customBlocks?.find((item) => item.blockId === ids.footer),
      drawingOrder: documentSnapshot?.drawingsOrder ?? [],
      headerFooterOrder: documentSnapshot?.headerFooterDrawingsOrder ?? [],
      resourceOrder: parsedResource?.order ?? [],
      resourceIds: Object.keys(parsedResource?.data ?? {}),
      renderHostChildCount: document.querySelector('.office-viewer-canvas')?.childElementCount ?? 0,
    }
  }, { ids: drawingIds })

  if (evidence.failures.length > 0) {
    throw new Error(`browser image decode failures:\n${evidence.failures.join('\n')}`)
  }
  if (evidence.bodyStream[evidence.bodyBlock?.startIndex] !== '\b') {
    throw new Error('body image custom block is missing from the document stream')
  }
  if (
    evidence.bodyStream[evidence.tableBlock?.startIndex] !== '\b'
    || !evidence.table
    || evidence.tableBlock.startIndex <= evidence.table.startIndex
    || evidence.tableBlock.startIndex >= evidence.table.endIndex
  ) {
    throw new Error('table-cell image custom block is not inside the persisted table range')
  }
  if (evidence.headerBlock?.startIndex !== 0 || evidence.footerBlock?.startIndex !== 0) {
    throw new Error('header/footer image custom blocks are missing')
  }
  const expected = Object.values(drawingIds)
  if (JSON.stringify(evidence.drawingOrder) !== JSON.stringify(expected)) {
    throw new Error(`drawing order mismatch: ${JSON.stringify(evidence.drawingOrder)}`)
  }
  if (JSON.stringify(evidence.headerFooterOrder) !== JSON.stringify([drawingIds.header, drawingIds.footer])) {
    throw new Error(`header/footer drawing order mismatch: ${JSON.stringify(evidence.headerFooterOrder)}`)
  }
  if (
    JSON.stringify(evidence.resourceOrder) !== JSON.stringify(expected)
    || !expected.every((id) => evidence.resourceIds.includes(id))
  ) {
    throw new Error('DOC_DRAWING_PLUGIN resource hydration is incomplete')
  }
  if (evidence.renderHostChildCount < 1) throw new Error('Univer did not mount its public document surface')
}

function assertNoViewerErrors(pageErrors, imageConsoleErrors) {
  if (pageErrors.length > 0) {
    throw new Error(`Office Viewer emitted page errors:\n${pageErrors.join('\n\n')}`)
  }
  if (imageConsoleErrors.length > 0) {
    throw new Error(`Office Viewer emitted image/drawing console errors:\n${imageConsoleErrors.join('\n\n')}`)
  }
}
