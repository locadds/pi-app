import type JSZip from 'jszip'

import type {
  IDocDrawingBase,
  IDocumentData,
  IObjectPositionH,
  IObjectPositionV,
} from '@univerjs/core'

const DOCS_DRAWING_RESOURCE_NAME = 'DOC_DRAWING_PLUGIN'
const EMU_PER_PIXEL = 9_525
const POINTS_TO_PIXELS = 4 / 3

type SupportedRasterFormatV1 = 'PNG' | 'JPEG' | 'GIF' | 'BMP' | 'WEBP'
type UnsupportedImageFormatV1 = 'EMF' | 'WMF' | 'SVG' | 'TIFF'
type ImageFormatV1 = SupportedRasterFormatV1 | UnsupportedImageFormatV1 | 'UNKNOWN'

interface MediaAssetV1 {
  readonly packagePath: string
  readonly format: ImageFormatV1
  readonly mimeType?: string
  readonly dataUrl?: string
}

interface PackageRelationshipV1 {
  readonly id: string
  readonly target: string
  readonly packagePath?: string
  readonly type?: string
  readonly external: boolean
}

export interface DocxUniverDrawingPackageV1 {
  readonly mediaCount: number
  readonly assets: ReadonlyMap<string, MediaAssetV1>
  readonly warnings: Set<string>
}

export interface DocxUniverDrawingPartContextV1 {
  readonly part: 'BODY' | 'HEADER' | 'FOOTER'
  readonly partIndex: number
  readonly partPath: string
  readonly documentId: string
  readonly relationships: ReadonlyMap<string, PackageRelationshipV1>
  readonly drawingPackage: DocxUniverDrawingPackageV1
  readonly drawingSequence: { value: number }
}

export interface UniverImageDrawingV1 extends IDocDrawingBase {
  readonly imageSourceType: 'BASE64'
  readonly source: string
}

export interface ParsedDocxUniverDrawingV1 {
  readonly drawing: UniverImageDrawingV1
  readonly approximateFloating: boolean
}

/**
 * Reads the package's media once. Detection prefers file signatures over file
 * names so browser-readable images are not lost merely because an OOXML
 * producer used a misleading extension.
 */
export async function prepareDocxUniverDrawingPackageV1(
  zip: JSZip,
): Promise<DocxUniverDrawingPackageV1> {
  const contentTypes = readContentTypes(await zip.file('[Content_Types].xml')?.async('string') ?? '')
  const paths = Object.keys(zip.files)
    .filter((path) => !zip.files[path].dir && isPotentialMediaPart(path, contentTypes))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const assets = new Map<string, MediaAssetV1>()
  for (const packagePath of paths) {
    const entry = zip.file(packagePath)
    if (!entry) continue
    const bytes = await entry.async('uint8array')
    const format = detectImageFormat(packagePath, bytes, contentTypes)
    const mimeType = supportedMimeType(format)
    const dataUrl = mimeType
      ? `data:${mimeType};base64,${await entry.async('base64')}`
      : undefined
    assets.set(normalizePackagePath(packagePath), {
      packagePath: normalizePackagePath(packagePath),
      format,
      mimeType,
      dataUrl,
    })
  }
  return {
    mediaCount: Object.keys(zip.files).filter((path) => /^word\/media\//i.test(path) && !zip.files[path].dir).length,
    assets,
    warnings: new Set<string>(),
  }
}

export async function prepareDocxUniverDrawingPartContextV1(
  zip: JSZip,
  drawingPackage: DocxUniverDrawingPackageV1,
  input: Omit<DocxUniverDrawingPartContextV1, 'relationships' | 'drawingPackage'>,
): Promise<DocxUniverDrawingPartContextV1> {
  const relationshipsPath = relationshipPartPath(input.partPath)
  const relationshipsXml = await zip.file(relationshipsPath)?.async('string') ?? ''
  return {
    ...input,
    drawingPackage,
    relationships: readRelationships(relationshipsXml, input.partPath),
  }
}

export function readDocxUniverDrawingV1(
  xml: string,
  context: DocxUniverDrawingPartContextV1,
): ParsedDocxUniverDrawingV1 | undefined {
  context.drawingSequence.value += 1
  const sequence = context.drawingSequence.value
  const location = drawingLocation(context, sequence)
  const svgBlip = firstOpenTag(xml, 'asvg:svgBlip')
  const groupDrawing = hasElement(xml, 'wpg:wgp')
    || hasElement(xml, 'a:grpSp')
    || /<a:graphicData\b[^>]*\buri\s*=\s*["'][^"']*(?:wordprocessingGroup|group)[^"']*["']/i.test(xml)
  if (groupDrawing) {
    context.drawingPackage.warnings.add(`${location} 是组合图形，当前不会伪装成已还原图片。`)
    return undefined
  }

  const blip = firstOpenTag(xml, 'a:blip')
  const vmlImage = firstOpenTag(xml, 'v:imagedata')
  const embeddedObject = hasElement(xml, 'w:object')
  const embeddedRelationshipId = blip
    ? attribute(blip, 'r:embed')
    : vmlImage
      ? attribute(vmlImage, 'r:id') ?? attribute(vmlImage, 'o:relid')
      : undefined
  const linkedRelationshipId = blip ? attribute(blip, 'r:link') : undefined
  const relationshipId = embeddedRelationshipId ?? linkedRelationshipId

  if (!relationshipId) {
    if (embeddedObject) {
      context.drawingPackage.warnings.add(`${location} 是嵌入对象，未发现可安全显示的图片关系。`)
    } else if (vmlImage || hasElement(xml, 'w:pict')) {
      context.drawingPackage.warnings.add(`${location} 是 VML 图形，未发现可安全显示的图片关系。`)
    } else {
      context.drawingPackage.warnings.add(`${location} 未包含可读取的图片关系，已保留为待处理对象。`)
    }
    return undefined
  }

  const relationship = context.relationships.get(relationshipId)
  if (!relationship) {
    context.drawingPackage.warnings.add(`${location} 引用缺失的关系 ${relationshipId}，图片未显示。`)
    return undefined
  }
  if (linkedRelationshipId || relationship.external) {
    context.drawingPackage.warnings.add(`${location} 引用外部图片，出于离线和数据边界要求未自动加载。`)
    return undefined
  }
  if (relationship.type && !/\/image$/i.test(relationship.type)) {
    context.drawingPackage.warnings.add(`${location} 是嵌入对象而非图片关系，当前不会伪装成已还原图片。`)
    return undefined
  }
  const asset = relationship.packagePath
    ? context.drawingPackage.assets.get(normalizePackagePath(relationship.packagePath))
    : undefined
  if (!asset) {
    context.drawingPackage.warnings.add(`${location} 的媒体文件 ${relationship.target} 缺失，图片未显示。`)
    return undefined
  }
  if (!asset.dataUrl || !asset.mimeType) {
    context.drawingPackage.warnings.add(
      `${location} 使用暂不可靠支持的 ${asset.format} 图片（${asset.packagePath}），已明确标记但不伪装成功。`,
    )
    return undefined
  }
  if (svgBlip) {
    context.drawingPackage.warnings.add(`${location} 包含 SVG；当前显示其浏览器可用的栅格回退图，请在正式模板前核对。`)
  }
  if (embeddedObject) {
    context.drawingPackage.warnings.add(`${location} 是嵌入对象；仅显示其浏览器可用的栅格预览，交互对象本身未还原。`)
  }

  const drawingId = `xiaogui-${context.part.toLowerCase()}-${context.partIndex}-drawing-${sequence}`
  const inline = hasElement(xml, 'wp:inline')
    || (!hasElement(xml, 'wp:anchor') && !vmlIsFloating(xml))
  const size = readDrawingSize(xml)
  const horizontal = inline
    ? { relativeFrom: 2, posOffset: 0 }
    : readDrawingHorizontalPosition(xml)
  const vertical = inline
    ? { relativeFrom: 2, posOffset: 0 }
    : readDrawingVerticalPosition(xml)
  const docProperties = firstOpenTag(xml, 'wp:docPr')
  const anchorTag = firstOpenTag(xml, 'wp:anchor')
  const transform = {
    left: horizontal.posOffset ?? 0,
    top: vertical.posOffset ?? 0,
    width: size.width,
    height: size.height,
    angle: 0,
  }
  const drawing: UniverImageDrawingV1 = {
    drawingId,
    unitId: context.documentId,
    subUnitId: context.documentId,
    drawingType: 0,
    imageSourceType: 'BASE64',
    source: asset.dataUrl,
    transform,
    ...(context.part === 'BODY'
      ? {}
      : { isMultiTransform: 1, transforms: [transform] }),
    docTransform: {
      size,
      positionH: horizontal,
      positionV: vertical,
      angle: 0,
    },
    title: docProperties ? attribute(docProperties, 'name') ?? '' : '',
    description: docProperties ? attribute(docProperties, 'descr') ?? '' : '',
    layoutType: inline ? 0 : readDrawingLayoutType(xml),
    behindDoc: anchorTag && attribute(anchorTag, 'behindDoc') === '1' ? 1 : 0,
    wrapText: readWrapText(xml),
    distL: emuToPixels(numericAttribute(anchorTag ?? '', 'distL')),
    distR: emuToPixels(numericAttribute(anchorTag ?? '', 'distR')),
    distT: emuToPixels(numericAttribute(anchorTag ?? '', 'distT')),
    distB: emuToPixels(numericAttribute(anchorTag ?? '', 'distB')),
  }
  return { drawing, approximateFloating: !inline }
}

export function getDocxUniverDrawingWarningsV1(
  drawingPackage: DocxUniverDrawingPackageV1,
): readonly string[] {
  return [...drawingPackage.warnings]
}

export function createUniverDocDrawingResourcesV1(
  drawings: NonNullable<IDocumentData['drawings']>,
  drawingsOrder: readonly string[],
): NonNullable<IDocumentData['resources']> {
  if (!drawingsOrder.length) return []
  return [{
    name: DOCS_DRAWING_RESOURCE_NAME,
    data: JSON.stringify({ data: drawings, order: drawingsOrder }),
  }]
}

function drawingLocation(context: DocxUniverDrawingPartContextV1, sequence: number): string {
  const part = context.part === 'BODY' ? '正文' : context.part === 'HEADER' ? `页眉 ${context.partIndex}` : `页脚 ${context.partIndex}`
  return `${part}绘图对象 ${sequence}`
}

interface ContentTypesV1 {
  readonly defaults: ReadonlyMap<string, string>
  readonly overrides: ReadonlyMap<string, string>
}

function readContentTypes(xml: string): ContentTypesV1 {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const match of xml.matchAll(/<(?:\w+:)?Default\b[^>]*\/?\s*>/gi)) {
    const extension = attribute(match[0], 'Extension')?.toLowerCase()
    const contentType = attribute(match[0], 'ContentType')?.toLowerCase()
    if (extension && contentType) defaults.set(extension, contentType)
  }
  for (const match of xml.matchAll(/<(?:\w+:)?Override\b[^>]*\/?\s*>/gi)) {
    const partName = attribute(match[0], 'PartName')
    const contentType = attribute(match[0], 'ContentType')?.toLowerCase()
    if (partName && contentType) overrides.set(normalizePackagePath(partName.replace(/^\//, '')), contentType)
  }
  return { defaults, overrides }
}

function isPotentialMediaPart(path: string, contentTypes: ContentTypesV1): boolean {
  if (/^word\/media\//i.test(path)) return true
  const normalized = normalizePackagePath(path)
  const extension = normalized.split('.').pop()?.toLowerCase() ?? ''
  const contentType = contentTypes.overrides.get(normalized) ?? contentTypes.defaults.get(extension)
  return !!contentType?.startsWith('image/')
}

function detectImageFormat(
  packagePath: string,
  bytes: Uint8Array,
  contentTypes: ContentTypesV1,
): ImageFormatV1 {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG'
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'JPEG'
  if (asciiPrefix(bytes, 'GIF87a') || asciiPrefix(bytes, 'GIF89a')) return 'GIF'
  if (asciiPrefix(bytes, 'BM')) return 'BMP'
  if (asciiPrefix(bytes, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'WEBP'
  if (startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'TIFF'
  if (startsWithBytes(bytes, [0xd7, 0xcd, 0xc6, 0x9a])) return 'WMF'
  if (bytes.length >= 44 && bytes[0] === 1 && asciiAt(bytes, 40, ' EMF')) return 'EMF'
  const textPrefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 512))).trimStart()
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(textPrefix)) return 'SVG'

  const normalized = normalizePackagePath(packagePath)
  const extension = normalized.split('.').pop()?.toLowerCase() ?? ''
  const contentType = contentTypes.overrides.get(normalized) ?? contentTypes.defaults.get(extension) ?? ''
  const byExtension: Record<string, ImageFormatV1> = {
    png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', jpe: 'JPEG', gif: 'GIF', bmp: 'BMP', dib: 'BMP', webp: 'WEBP',
    emf: 'EMF', wmf: 'WMF', svg: 'SVG', tiff: 'TIFF', tif: 'TIFF',
  }
  const byContentType: Record<string, ImageFormatV1> = {
    'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/bmp': 'BMP', 'image/webp': 'WEBP',
    'image/x-emf': 'EMF', 'image/emf': 'EMF', 'image/x-wmf': 'WMF', 'image/wmf': 'WMF',
    'image/svg+xml': 'SVG', 'image/tiff': 'TIFF',
  }
  return byContentType[contentType] ?? byExtension[extension] ?? 'UNKNOWN'
}

function supportedMimeType(format: ImageFormatV1): string | undefined {
  const types: Partial<Record<ImageFormatV1, string>> = {
    PNG: 'image/png',
    JPEG: 'image/jpeg',
    GIF: 'image/gif',
    BMP: 'image/bmp',
    WEBP: 'image/webp',
  }
  return types[format]
}

function readRelationships(xml: string, partPath: string): ReadonlyMap<string, PackageRelationshipV1> {
  const relationships = new Map<string, PackageRelationshipV1>()
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gi)) {
    const tag = match[0]
    const id = attribute(tag, 'Id')
    const target = attribute(tag, 'Target')
    if (!id || !target) continue
    const external = attribute(tag, 'TargetMode')?.toLowerCase() === 'external'
    relationships.set(id, {
      id,
      target: decodeXmlText(target),
      packagePath: external ? undefined : resolvePackagePath(partPath, decodeXmlText(target)),
      type: attribute(tag, 'Type'),
      external,
    })
  }
  return relationships
}

function relationshipPartPath(partPath: string): string {
  const slash = partPath.lastIndexOf('/')
  const directory = slash >= 0 ? partPath.slice(0, slash + 1) : ''
  const fileName = slash >= 0 ? partPath.slice(slash + 1) : partPath
  return `${directory}_rels/${fileName}.rels`
}

function resolvePackagePath(partPath: string, target: string): string {
  if (target.startsWith('/')) return normalizePackagePath(target.slice(1))
  const slash = partPath.lastIndexOf('/')
  const directory = slash >= 0 ? partPath.slice(0, slash + 1) : ''
  return normalizePackagePath(`${directory}${target}`)
}

function normalizePackagePath(path: string): string {
  const output: string[] = []
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') output.pop()
    else output.push(segment)
  }
  return output.join('/')
}

function readDrawingSize(xml: string): { width: number; height: number } {
  const extent = firstOpenTag(xml, 'wp:extent') ?? firstOpenTag(xml, 'a:ext')
  const cx = numericAttribute(extent ?? '', 'cx')
  const cy = numericAttribute(extent ?? '', 'cy')
  if (cx && cy) return { width: Math.max(1, cx / EMU_PER_PIXEL), height: Math.max(1, cy / EMU_PER_PIXEL) }
  const shape = firstOpenTag(xml, 'v:shape') ?? firstOpenTag(xml, 'v:rect') ?? firstOpenTag(xml, 'v:oval')
  const style = shape ? attribute(shape, 'style') ?? '' : ''
  const width = cssLengthToPixels(style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1])
  const height = cssLengthToPixels(style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)?.[1])
  return { width: width ?? 240, height: height ?? 160 }
}

function cssLengthToPixels(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  if (/pt\s*$/i.test(value)) return parsed * POINTS_TO_PIXELS
  if (/in\s*$/i.test(value)) return parsed * 96
  if (/cm\s*$/i.test(value)) return parsed * (96 / 2.54)
  if (/mm\s*$/i.test(value)) return parsed * (96 / 25.4)
  return parsed
}

function readDrawingHorizontalPosition(xml: string): IObjectPositionH {
  const position = firstElement(xml, 'wp:positionH') ?? ''
  const relative = attribute(firstOpenTag(position, 'wp:positionH') ?? '', 'relativeFrom')
  const relativeMap: Record<string, number> = {
    page: 0, column: 1, character: 2, margin: 3, insideMargin: 4,
    outsideMargin: 5, leftMargin: 6, rightMargin: 7,
  }
  const alignMap: Record<string, number> = {
    center: 0, inside: 1, left: 2, outside: 3, right: 4, both: 5, distribute: 6,
  }
  const align = textOfFirst(position, 'wp:align')
  const posOffset = numberOfFirst(position, 'wp:posOffset')
  const percent = numberOfFirst(position, 'wp14:pctPosHOffset')
  return {
    relativeFrom: relativeMap[relative ?? ''] ?? 0,
    ...(align && alignMap[align] !== undefined ? { align: alignMap[align] } : {}),
    ...(posOffset !== undefined ? { posOffset: emuToPixels(posOffset) } : {}),
    ...(percent !== undefined ? { percent: percent / 1000 } : {}),
  }
}

function readDrawingVerticalPosition(xml: string): IObjectPositionV {
  const position = firstElement(xml, 'wp:positionV') ?? ''
  const relative = attribute(firstOpenTag(position, 'wp:positionV') ?? '', 'relativeFrom')
  const relativeMap: Record<string, number> = {
    page: 0, paragraph: 1, line: 2, margin: 3, topMargin: 4,
    bottomMargin: 5, insideMargin: 6, outsideMargin: 7,
  }
  const alignMap: Record<string, number> = { bottom: 0, center: 1, inside: 2, outside: 3, top: 4 }
  const align = textOfFirst(position, 'wp:align')
  const posOffset = numberOfFirst(position, 'wp:posOffset')
  const percent = numberOfFirst(position, 'wp14:pctPosVOffset')
  return {
    relativeFrom: relativeMap[relative ?? ''] ?? 1,
    ...(align && alignMap[align] !== undefined ? { align: alignMap[align] } : {}),
    ...(posOffset !== undefined ? { posOffset: emuToPixels(posOffset) } : {}),
    ...(percent !== undefined ? { percent: percent / 1000 } : {}),
  }
}

function readDrawingLayoutType(xml: string): number {
  if (hasElement(xml, 'wp:wrapSquare')) return 3
  if (hasElement(xml, 'wp:wrapThrough')) return 4
  if (hasElement(xml, 'wp:wrapTight')) return 5
  if (hasElement(xml, 'wp:wrapTopAndBottom')) return 6
  if (hasElement(xml, 'wp:wrapNone')) return 1
  return 2
}

function readWrapText(xml: string): number {
  const wrapTag = firstOpenTag(xml, 'wp:wrapSquare')
    ?? firstOpenTag(xml, 'wp:wrapThrough')
    ?? firstOpenTag(xml, 'wp:wrapTight')
  const value = wrapTag ? attribute(wrapTag, 'wrapText') : undefined
  return value === 'left' ? 1 : value === 'right' ? 2 : value === 'largest' ? 3 : 0
}

function vmlIsFloating(xml: string): boolean {
  const shape = firstOpenTag(xml, 'v:shape') ?? firstOpenTag(xml, 'v:rect') ?? firstOpenTag(xml, 'v:oval')
  return /(?:^|;)\s*position\s*:\s*absolute/i.test(shape ? attribute(shape, 'style') ?? '' : '')
}

function firstElement(xml: string, tag: string): string | undefined {
  const start = xml.search(new RegExp(`<${escapeRegExp(tag)}\\b`, 'i'))
  if (start < 0) return undefined
  const token = new RegExp(`<\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi')
  token.lastIndex = start
  let depth = 0
  for (const match of xml.matchAll(token)) {
    const value = match[0]
    if (value.startsWith('</')) depth -= 1
    else if (!value.endsWith('/>')) depth += 1
    if (depth === 0) return xml.slice(start, (match.index ?? start) + value.length)
  }
  return undefined
}

function firstOpenTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'i'))?.[0]
}

function hasElement(xml: string, tag: string): boolean {
  return new RegExp(`<${escapeRegExp(tag)}\\b`, 'i').test(xml)
}

function attribute(openTag: string, name: string): string | undefined {
  return openTag.match(new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
}

function numericAttribute(openTag: string, name: string): number | undefined {
  const value = attribute(openTag, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function textOfFirst(xml: string, tag: string): string | undefined {
  const element = firstElement(xml, tag)
  if (!element) return undefined
  const openEnd = element.indexOf('>')
  const closeStart = element.lastIndexOf(`</${tag}>`)
  if (openEnd < 0 || closeStart < 0) return undefined
  return decodeXmlText(element.slice(openEnd + 1, closeStart)).trim()
}

function numberOfFirst(xml: string, tag: string): number | undefined {
  const value = textOfFirst(xml, tag)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function emuToPixels(value: number | undefined): number {
  return value === undefined ? 0 : value / EMU_PER_PIXEL
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value)
}

function asciiPrefix(bytes: Uint8Array, expected: string): boolean {
  return asciiAt(bytes, 0, expected)
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false
  }
  return true
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_whole, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
