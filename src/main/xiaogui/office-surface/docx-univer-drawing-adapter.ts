import type JSZip from 'jszip'

import type {
  IDocDrawingBase,
  IDocumentData,
  IObjectPositionH,
  IObjectPositionV,
  ISrcRect,
} from '@univerjs/core'
import {
  encodeOfficeDrawingDegradationV1,
  type OfficeDrawingDegradationReasonV1,
  type OfficeDrawingDegradationV1,
} from '@shared/xiaogui-office-drawing-degradation'

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
  readonly degradations: Map<string, OfficeDrawingDegradationV1>
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
  readonly srcRect?: ISrcRect
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
    degradations: new Map<string, OfficeDrawingDegradationV1>(),
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
    recordDrawingDegradationV1(context, sequence, 'GROUP_DRAWING', `${location} 是组合图形，当前不会伪装成已还原图片。`)
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
      recordDrawingDegradationV1(context, sequence, 'MISSING_RELATIONSHIP', `${location} 是嵌入对象，未发现可安全显示的图片关系。`)
    } else if (vmlImage || hasElement(xml, 'w:pict')) {
      recordDrawingDegradationV1(context, sequence, 'MISSING_RELATIONSHIP', `${location} 是 VML 图形，未发现可安全显示的图片关系。`)
    } else {
      recordDrawingDegradationV1(context, sequence, 'MISSING_RELATIONSHIP', `${location} 未包含可读取的图片关系，已保留为待处理对象。`)
    }
    return undefined
  }

  const relationship = context.relationships.get(relationshipId)
  if (!relationship) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'RELATIONSHIP_NOT_FOUND',
      `${location} 引用缺失的关系 ${relationshipId}，图片未显示。`,
      { relationshipId },
    )
    return undefined
  }
  if (linkedRelationshipId || relationship.external) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'EXTERNAL_IMAGE',
      `${location} 引用外部图片，出于离线和数据边界要求未自动加载。`,
      { relationshipId, format: summarizeExternalReferenceV1(relationship.target) },
    )
    return undefined
  }
  if (relationship.type && !/\/image$/i.test(relationship.type)) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'NON_IMAGE_RELATIONSHIP',
      `${location} 是嵌入对象而非图片关系，当前不会伪装成已还原图片。`,
      { relationshipId },
    )
    return undefined
  }
  const asset = relationship.packagePath
    ? context.drawingPackage.assets.get(normalizePackagePath(relationship.packagePath))
    : undefined
  if (!asset) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'MEDIA_MISSING',
      `${location} 的媒体文件缺失，图片未显示。`,
      { relationshipId },
    )
    return undefined
  }
  if (!asset.dataUrl || !asset.mimeType) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'UNSUPPORTED_FORMAT',
      `${location} 使用暂不可靠支持的 ${asset.format} 图片，已明确标记但不伪装成功。`,
      {
        relationshipId,
        format: asset.format,
      },
    )
    return undefined
  }
  if (svgBlip) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'SVG_RASTER_FALLBACK',
      `${location} 包含 SVG；当前显示其浏览器可用的栅格回退图，请在正式模板前核对。`,
      { relationshipId, format: 'SVG' },
    )
  }
  if (embeddedObject) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'OLE_RASTER_PREVIEW',
      `${location} 是嵌入对象；仅显示其浏览器可用的栅格预览，交互对象本身未还原。`,
      { relationshipId, format: asset.format },
    )
  }

  const drawingId = `xiaogui-${context.part.toLowerCase()}-${context.partIndex}-drawing-${sequence}`
  const inline = hasElement(xml, 'wp:inline')
    || (!hasElement(xml, 'wp:anchor') && !vmlIsFloating(xml))
  const size = readDrawingSize(xml)
  const vmlPosition = readVmlPosition(xml)
  const horizontal = inline
    ? { relativeFrom: 2, posOffset: 0 }
    : vmlPosition?.horizontal ?? readDrawingHorizontalPosition(xml)
  const vertical = inline
    ? { relativeFrom: 2, posOffset: 0 }
    : vmlPosition?.vertical ?? readDrawingVerticalPosition(xml)
  const drawingTransform = readDrawingTransform(xml, size)
  if (hasUnmappedWrapPolygon(xml)) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'COMPLEX_WRAP_APPROXIMATION',
      `${location} 使用未完整映射的紧密/穿越型多边形环绕；当前仅保留近似环绕类型和位置，请人工核对。`,
      { relationshipId, format: asset.format },
    )
  }
  if (drawingTransform.cropWarning) {
    recordDrawingDegradationV1(
      context,
      sequence,
      'CROP_NOT_APPLIED',
      `${location} 的裁剪参数无法可靠映射，已保留原图并明确告警。`,
      { relationshipId, format: asset.format },
    )
  }
  const docProperties = firstOpenTag(xml, 'wp:docPr')
  const anchorTag = firstOpenTag(xml, 'wp:anchor')
  const transform = {
    left: horizontal.posOffset ?? 0,
    top: vertical.posOffset ?? 0,
    width: size.width,
    height: size.height,
    angle: drawingTransform.angle,
    flipX: drawingTransform.flipX,
    flipY: drawingTransform.flipY,
  }
  const drawing: UniverImageDrawingV1 = {
    drawingId,
    unitId: context.documentId,
    subUnitId: context.documentId,
    drawingType: 0,
    imageSourceType: 'BASE64',
    source: asset.dataUrl,
    ...(drawingTransform.srcRect ? { srcRect: drawingTransform.srcRect } : {}),
    transform,
    ...(context.part === 'BODY'
      ? {}
      : { isMultiTransform: 1, transforms: [transform] }),
    docTransform: {
      size,
      positionH: horizontal,
      positionV: vertical,
      angle: drawingTransform.angle,
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

/**
 * Selects one drawing representation from each common OOXML
 * mc:AlternateContent container. The document tokenizer must call this before
 * scanning w:drawing/w:pict nodes; keeping it here makes that integration seam
 * explicit without coupling the drawing reader to paragraph tokenization.
 */
export function selectDocxUniverAlternateContentV1(xml: string): string {
  let output = xml
  let searchFrom = 0
  while (searchFrom < output.length) {
    const tail = output.slice(searchFrom)
    const alternate = firstElement(tail, 'mc:AlternateContent')
    if (!alternate) break
    const localStart = tail.indexOf(alternate)
    if (localStart < 0) break
    const start = searchFrom + localStart
    const choices = [...alternate.matchAll(/<mc:Choice\b[^>]*>[\s\S]*?<\/mc:Choice\s*>/gi)].map((match) => match[0])
    const fallback = firstElement(alternate, 'mc:Fallback')
    const selected = choices.find((choice) => alternateChoiceIsSupported(choice) && drawingBranchIsReadable(choice))
      ?? (fallback && drawingBranchIsReadable(fallback) ? fallback : undefined)
      ?? choices.find(alternateChoiceIsSupported)
      ?? fallback
      ?? choices[0]
    const content = selected ? stripOuterElement(selected) : ''
    output = `${output.slice(0, start)}${content}${output.slice(start + alternate.length)}`
    searchFrom = start + content.length
  }
  return output
}

const SUPPORTED_ALTERNATE_CONTENT_REQUIREMENTS = new Set([
  'a',
  'asvg',
  'mc',
  'o',
  'pic',
  'r',
  'v',
  'w',
  'wp',
  'wp14',
])

function alternateChoiceIsSupported(choice: string): boolean {
  const opening = firstOpenTag(choice, 'mc:Choice') ?? ''
  const requires = attribute(opening, 'Requires')?.trim()
  if (!requires) return true
  return requires
    .split(/\s+/)
    .every((prefix) => SUPPORTED_ALTERNATE_CONTENT_REQUIREMENTS.has(prefix.toLowerCase()))
}

function drawingBranchIsReadable(branch: string): boolean {
  if (
    hasElement(branch, 'wpg:wgp')
    || hasElement(branch, 'a:grpSp')
    || /<a:graphicData\b[^>]*\buri\s*=\s*["'][^"']*(?:wordprocessingGroup|group)[^"']*["']/i.test(branch)
  ) return false
  const blip = firstOpenTag(branch, 'a:blip')
  if (blip && (attribute(blip, 'r:embed') || attribute(blip, 'r:link'))) return true
  const vmlImage = firstOpenTag(branch, 'v:imagedata')
  return Boolean(vmlImage && (attribute(vmlImage, 'r:id') || attribute(vmlImage, 'o:relid')))
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

function recordDrawingDegradationV1(
  context: DocxUniverDrawingPartContextV1,
  sequence: number,
  reason: OfficeDrawingDegradationReasonV1,
  message: string,
  details: Pick<OfficeDrawingDegradationV1, 'relationshipId' | 'format'> = {},
): void {
  const id = `${context.part.toLowerCase()}-${context.partIndex}-${sequence}-${reason.toLowerCase()}`
  const record: OfficeDrawingDegradationV1 = {
    kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION',
    version: 1,
    id,
    part: context.part,
    partIndex: context.partIndex,
    sequence,
    severity: reason === 'SVG_RASTER_FALLBACK' || reason === 'OLE_RASTER_PREVIEW' ? 'INFO' : 'WARNING',
    reason,
    message,
    ...details,
  }
  context.drawingPackage.degradations.set(id, record)
  context.drawingPackage.warnings.add(encodeOfficeDrawingDegradationV1(record))
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
  return cssNumericLengthToPixels(parsed, value)
}

function summarizeExternalReferenceV1(target: string): string {
  if (/^file:/i.test(target)) return 'EXTERNAL_FILE_URI'
  if (/^(?:\\\\|\/\/)/.test(target)) return 'EXTERNAL_UNC_PATH'
  if (/^https:/i.test(target)) return 'EXTERNAL_HTTPS_URL'
  if (/^http:/i.test(target)) return 'EXTERNAL_HTTP_URL'
  return 'EXTERNAL_REFERENCE'
}

function cssPositionToPixels(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return undefined
  return cssNumericLengthToPixels(parsed, value)
}

function cssNumericLengthToPixels(parsed: number, source: string): number {
  if (/pt\s*$/i.test(source)) return parsed * POINTS_TO_PIXELS
  if (/in\s*$/i.test(source)) return parsed * 96
  if (/cm\s*$/i.test(source)) return parsed * (96 / 2.54)
  if (/mm\s*$/i.test(source)) return parsed * (96 / 25.4)
  return parsed
}

function readVmlPosition(xml: string): {
  readonly horizontal: IObjectPositionH
  readonly vertical: IObjectPositionV
} | undefined {
  const shape = firstOpenTag(xml, 'v:shape') ?? firstOpenTag(xml, 'v:rect') ?? firstOpenTag(xml, 'v:oval')
  if (!shape) return undefined
  const style = attribute(shape, 'style') ?? ''
  if (!/(?:^|;)\s*position\s*:\s*absolute/i.test(style)) return undefined
  const left = cssPositionToPixels(readCssProperty(style, 'left') ?? readCssProperty(style, 'margin-left')) ?? 0
  const top = cssPositionToPixels(readCssProperty(style, 'top') ?? readCssProperty(style, 'margin-top')) ?? 0
  const horizontalRelative = readCssProperty(style, 'mso-position-horizontal-relative')?.trim().toLowerCase()
  const verticalRelative = readCssProperty(style, 'mso-position-vertical-relative')?.trim().toLowerCase()
  return {
    horizontal: {
      relativeFrom: horizontalRelative === 'text' || horizontalRelative === 'char' ? 2 : 0,
      posOffset: left,
    },
    vertical: {
      relativeFrom: verticalRelative === 'text' || verticalRelative === 'line' ? 1 : 0,
      posOffset: top,
    },
  }
}

function readCssProperty(style: string, name: string): string | undefined {
  return style.match(new RegExp(`(?:^|;)\\s*${escapeRegExp(name)}\\s*:\\s*([^;]+)`, 'i'))?.[1]
}

function readDrawingTransform(
  xml: string,
  size: { readonly width: number; readonly height: number },
): {
  readonly angle: number
  readonly flipX: boolean
  readonly flipY: boolean
  readonly srcRect?: ISrcRect
  readonly cropWarning: boolean
} {
  const drawingMlTransform = firstOpenTag(xml, 'a:xfrm')
  const vmlShape = firstOpenTag(xml, 'v:shape') ?? firstOpenTag(xml, 'v:rect') ?? firstOpenTag(xml, 'v:oval')
  const vmlStyle = vmlShape ? attribute(vmlShape, 'style') ?? '' : ''
  const drawingMlRotation = numericAttribute(drawingMlTransform ?? '', 'rot')
  const vmlRotation = Number.parseFloat(readCssProperty(vmlStyle, 'rotation') ?? '')
  const angle = drawingMlRotation !== undefined
    ? drawingMlRotation / 60_000
    : Number.isFinite(vmlRotation)
      ? vmlRotation
      : 0
  const vmlFlip = (readCssProperty(vmlStyle, 'flip') ?? attribute(vmlShape ?? '', 'flip') ?? '')
    .toLowerCase()
    .replaceAll(/\s+/g, '')
  const flipX = drawingMlTransform
    ? booleanAttribute(drawingMlTransform, 'flipH')
    : vmlFlip.includes('x')
  const flipY = drawingMlTransform
    ? booleanAttribute(drawingMlTransform, 'flipV')
    : vmlFlip.includes('y')
  const crop = readCropRectangle(xml, size)
  return {
    angle,
    flipX,
    flipY,
    ...(crop.srcRect ? { srcRect: crop.srcRect } : {}),
    cropWarning: crop.warning,
  }
}

function readCropRectangle(
  xml: string,
  size: { readonly width: number; readonly height: number },
): { readonly srcRect?: ISrcRect; readonly warning: boolean } {
  const tag = firstOpenTag(xml, 'a:srcRect')
  if (!tag) return { warning: false }
  const raw = ['l', 't', 'r', 'b'].map((name) => numericAttribute(tag, name) ?? 0)
  if (raw.some((value) => !Number.isFinite(value) || value < 0 || value > 100_000)) return { warning: true }
  const [leftFraction, topFraction, rightFraction, bottomFraction] = raw.map((value) => value / 100_000)
  const horizontalVisible = 1 - leftFraction - rightFraction
  const verticalVisible = 1 - topFraction - bottomFraction
  if (horizontalVisible <= 0 || verticalVisible <= 0) return { warning: true }
  return {
    warning: false,
    srcRect: {
      left: size.width * leftFraction / horizontalVisible,
      top: size.height * topFraction / verticalVisible,
      right: size.width * rightFraction / horizontalVisible,
      bottom: size.height * bottomFraction / verticalVisible,
    },
  }
}

function booleanAttribute(tag: string, name: string): boolean {
  const value = attribute(tag, name)?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on'
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

function hasUnmappedWrapPolygon(xml: string): boolean {
  if (hasElement(xml, 'wp:wrapPolygon')) return true
  const vmlShape = firstOpenTag(xml, 'v:shape') ?? firstOpenTag(xml, 'v:rect') ?? firstOpenTag(xml, 'v:oval')
  if (vmlShape && attribute(vmlShape, 'wrapcoords')) return true
  const vmlWrap = firstOpenTag(xml, 'w10:wrap')
  const vmlWrapType = vmlWrap ? attribute(vmlWrap, 'type')?.toLowerCase() : undefined
  return vmlWrapType === 'tight' || vmlWrapType === 'through'
}

function stripOuterElement(xml: string): string {
  const openingEnd = xml.indexOf('>')
  const closingStart = xml.lastIndexOf('</')
  if (openingEnd < 0 || closingStart <= openingEnd) return ''
  return xml.slice(openingEnd + 1, closingStart)
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
