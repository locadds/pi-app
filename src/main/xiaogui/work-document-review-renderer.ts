import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import JSZip from "jszip";
import type {
  TemplateReviewInputFormatV2,
  TemplateReviewRenderWarningV3,
  TemplateReviewSourceAnchorV2,
  TemplateReviewTargetKindV2,
} from "@shared/xiaogui-work-template-review";
import { inspectSafeDocxArchiveV1 } from "./docx-safety";
import { inspectSafeLegacyDocV1 } from "./work-legacy-doc-safety";

export type LibreOfficeConversionTargetV1 = "DOCX";

export type LibreOfficeConversionErrorCodeV1 =
  | "LIBREOFFICE_UNAVAILABLE"
  | "LIBREOFFICE_TIMEOUT"
  | "LIBREOFFICE_ABORTED"
  | "LIBREOFFICE_FAILED"
  | "LIBREOFFICE_OUTPUT_MISSING";

export class LibreOfficeConversionErrorV1 extends Error {
  constructor(readonly code: LibreOfficeConversionErrorCodeV1) {
    super(code);
    this.name = "LibreOfficeConversionErrorV1";
  }
}

export interface LibreOfficeConversionResultV1 {
  content: Buffer;
  format: LibreOfficeConversionTargetV1;
  elapsedMs: number;
}

export interface LibreOfficeConverterV1 {
  convert(
    content: Buffer,
    inputFormat: TemplateReviewInputFormatV2,
    target: LibreOfficeConversionTargetV1,
    signal?: AbortSignal,
  ): Promise<LibreOfficeConversionResultV1>;
}

interface PrivateProcessOptionsV1 {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface PrivateProcessResultV1 {
  exitCode: number;
  stderr: string;
}

export type PrivateProcessRunnerV1 = (
  executable: string,
  args: readonly string[],
  options: PrivateProcessOptionsV1,
) => Promise<PrivateProcessResultV1>;

class PrivateProcessErrorV1 extends Error {
  constructor(readonly reason: "TIMEOUT" | "ABORTED" | "FAILED") {
    super(reason);
  }
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
  maxLength = 16_384,
): string {
  const next = current + chunk.toString();
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveTermination) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolveTermination());
      killer.once("close", () => resolveTermination());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

export const runPrivateProcessV1: PrivateProcessRunnerV1 = async (
  executable,
  args,
  options,
) =>
  new Promise<PrivateProcessResultV1>((resolveRun, rejectRun) => {
    let stderr = "";
    let terminationReason: PrivateProcessErrorV1["reason"] | null = null;
    let settled = false;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectRun(error);
    };
    const terminate = (reason: PrivateProcessErrorV1["reason"]): void => {
      if (terminationReason || settled) return;
      terminationReason = reason;
      if (typeof child.pid !== "number") {
        rejectOnce(new PrivateProcessErrorV1(reason));
        return;
      }
      void terminateProcessTree(child.pid).finally(() =>
        rejectOnce(new PrivateProcessErrorV1(reason)),
      );
    };
    const onAbort = (): void => terminate("ABORTED");
    const timer = setTimeout(() => terminate("TIMEOUT"), options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", () => rejectOnce(new PrivateProcessErrorV1("FAILED")));
    child.once("close", (exitCode) => {
      if (terminationReason || settled) return;
      settled = true;
      cleanup();
      resolveRun({ exitCode: exitCode ?? -1, stderr });
    });
    if (options.signal?.aborted) onAbort();
  });

export interface LibreOfficePrivateConverterConfigV1 {
  executablePath: string;
  /** 必须是调用方选定的私有缓存根目录；每次转换都会创建并清理独立子目录。 */
  privateRoot: string;
  timeoutMs?: number;
  processRunner?: PrivateProcessRunnerV1;
}

function macroSecurityRegistryV1(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
  </item>
</oor:items>`;
}

async function removePrivateSessionRoot(
  privateRoot: string,
  sessionRoot: string,
): Promise<void> {
  const parent = resolve(privateRoot);
  const target = resolve(sessionRoot);
  if (target === parent || !target.startsWith(`${parent}${sep}`)) {
    throw new Error("LIBREOFFICE_PRIVATE_ROOT_SCOPE_MISMATCH");
  }
  await rm(target, { recursive: true, force: true });
}

export class LibreOfficePrivateConverterV1 implements LibreOfficeConverterV1 {
  private readonly timeoutMs: number;
  private readonly processRunner: PrivateProcessRunnerV1;

  constructor(private readonly config: LibreOfficePrivateConverterConfigV1) {
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.processRunner = config.processRunner ?? runPrivateProcessV1;
  }

  async convert(
    content: Buffer,
    inputFormat: TemplateReviewInputFormatV2,
    target: LibreOfficeConversionTargetV1,
    signal?: AbortSignal,
  ): Promise<LibreOfficeConversionResultV1> {
    const startedAt = Date.now();
    if (signal?.aborted)
      throw new LibreOfficeConversionErrorV1("LIBREOFFICE_ABORTED");
    try {
      const executable = await stat(this.config.executablePath);
      if (!executable.isFile()) throw new Error("not a file");
    } catch {
      throw new LibreOfficeConversionErrorV1("LIBREOFFICE_UNAVAILABLE");
    }

    await mkdir(this.config.privateRoot, { recursive: true });
    const sessionRoot = await mkdtemp(
      join(this.config.privateRoot, "xiaogui-lo-review-"),
    );
    const profileRoot = join(sessionRoot, "profile");
    const outputRoot = join(sessionRoot, "output");
    const sourceBase = `source-${randomUUID()}`;
    const inputExtension = inputFormat === "DOC" ? ".doc" : ".docx";
    const inputPath = join(sessionRoot, `${sourceBase}${inputExtension}`);
    const outputExtension = ".docx";
    const outputPath = join(outputRoot, `${sourceBase}${outputExtension}`);

    try {
      await mkdir(join(profileRoot, "user"), { recursive: true });
      await mkdir(outputRoot, { recursive: true });
      await writeFile(
        join(profileRoot, "user", "registrymodifications.xcu"),
        macroSecurityRegistryV1(),
      );
      await writeFile(inputPath, content, { flag: "wx" });

      const convertFilter = "docx:Office Open XML Text";
      const args = [
        `-env:UserInstallation=${pathToFileURL(profileRoot).href}`,
        "--headless",
        "--invisible",
        "--nologo",
        "--nodefault",
        "--nofirststartwizard",
        "--nolockcheck",
        "--norestore",
        "--convert-to",
        convertFilter,
        "--outdir",
        outputRoot,
        inputPath,
      ];

      let execution: PrivateProcessResultV1;
      try {
        execution = await this.processRunner(this.config.executablePath, args, {
          cwd: sessionRoot,
          timeoutMs: this.timeoutMs,
          signal,
        });
      } catch (error) {
        if (
          error instanceof PrivateProcessErrorV1 &&
          error.reason === "TIMEOUT"
        ) {
          throw new LibreOfficeConversionErrorV1("LIBREOFFICE_TIMEOUT");
        }
        if (
          signal?.aborted ||
          (error instanceof PrivateProcessErrorV1 && error.reason === "ABORTED")
        ) {
          throw new LibreOfficeConversionErrorV1("LIBREOFFICE_ABORTED");
        }
        throw new LibreOfficeConversionErrorV1("LIBREOFFICE_FAILED");
      }
      if (execution.exitCode !== 0) {
        throw new LibreOfficeConversionErrorV1("LIBREOFFICE_FAILED");
      }

      let output: Buffer;
      try {
        output = await readFile(outputPath);
      } catch {
        throw new LibreOfficeConversionErrorV1("LIBREOFFICE_OUTPUT_MISSING");
      }
      if (output.byteLength === 0) {
        throw new LibreOfficeConversionErrorV1("LIBREOFFICE_OUTPUT_MISSING");
      }
      return {
        content: output,
        format: target,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      await removePrivateSessionRoot(this.config.privateRoot, sessionRoot);
    }
  }
}

export interface DocumentReviewProjectionTargetV1 {
  targetId: string;
  kind: TemplateReviewTargetKindV2;
  preview: string;
  sourceAnchor: TemplateReviewSourceAnchorV2;
}

export type DocumentReviewProjectionStatusV1 =
  | "PROJECTED"
  | "UNMAPPED";

export interface DocumentReviewProjectionV1 {
  targetId: string;
  status: DocumentReviewProjectionStatusV1;
  startBookmark?: string;
  endBookmark?: string;
  textSelectionAllowed: boolean;
  objectSelectionAllowed?: boolean;
  expectedTextSha256?: string;
  expectedTextLengthUtf16?: number;
  expectedCompactTextSha256?: string;
  expectedCompactTextLengthUtf16?: number;
  warningCode?:
    | "TARGET_MARKER_MISSING"
    | "TARGET_TEXT_MISMATCH"
    | "TARGET_OBJECT_UNSUPPORTED"
    | "TARGET_LOCATION_UNMAPPED";
}

interface PrivateRenderManifestV1 {
  manifestId: string;
  sourceSha256: string;
  inputFormat: TemplateReviewInputFormatV2;
  normalizedDocx: Buffer | null;
  displayDocx: Buffer | null;
  documentToken: string | null;
}

export interface PreparedDocumentReviewRenderV1 {
  /** 仅供主进程私有存储，不得进入工具结果、Pi 会话或 Renderer 状态。 */
  manifestId: string;
  sourceSha256: string;
  normalizedDocxAvailable: boolean;
  render: {
    mode: "DOCX_HTML" | "STRUCTURED_FALLBACK";
    documentToken?: string;
    paginationBasis: "DOCX_STORED_BREAKS" | "UNKNOWN";
    approximatePageCount: number | null;
    warnings: readonly TemplateReviewRenderWarningV3[];
  };
  projections: readonly DocumentReviewProjectionV1[];
}

export interface DocumentReviewDocumentAssetV1 {
  docxBytes: Uint8Array;
  sha256: string;
}

export interface DocumentReviewRendererConfigV1 {
  converter: LibreOfficeConverterV1;
}

function conversionWarning(error: unknown): TemplateReviewRenderWarningV3 {
  if (
    error instanceof LibreOfficeConversionErrorV1 &&
    error.code === "LIBREOFFICE_UNAVAILABLE"
  ) {
    return {
      code: "LEGACY_DOC_CONVERSION_UNAVAILABLE",
      message: "旧版 DOC 转换组件不可用，已切换为结构化复核视图",
    };
  }
  return {
    code: "LEGACY_DOC_CONVERSION_FAILED",
    message: "旧版 DOC 转换失败，已切换为结构化复核视图",
  };
}

function docxHtmlRenderWarning(): TemplateReviewRenderWarningV3 {
  return {
    code: "DOCX_HTML_RENDER_FAILED",
    message: "DOCX 直接文档视图准备失败，已切换为结构化复核视图",
  };
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new LibreOfficeConversionErrorV1("LIBREOFFICE_ABORTED");
}

type XmlMatch = { value: string; index: number };
type ProjectionFileEditV1 = {
  path: string;
  start: number;
  end: number;
  replacement: string;
};

interface ProjectedDocxForReviewV1 {
  content: Buffer;
  approximatePageCount: number | null;
  warnings: readonly TemplateReviewRenderWarningV3[];
  projections: readonly DocumentReviewProjectionV1[];
}

const PARAGRAPH_RE = /<w:p\b[\s\S]*?<\/w:p>/g;
const TABLE_RE = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc\b[\s\S]*?<\/w:tc>/g;
const TEXT_BOX_RE = /<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g;
const RUN_RE = /<w:r\b[\s\S]*?<\/w:r>/g;
const DRAWING_RE = /<w:drawing\b[\s\S]*?<\/w:drawing>/g;
const IMAGE_USE_RE = /<a:blip\b[^>]*\br:embed=["'][^"']+["']/g;
const LEGACY_DOCX_CACHE_LIMIT = 4;

function collectMatches(text: string, pattern: RegExp): XmlMatch[] {
  const matches: XmlMatch[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    matches.push({ value: match[0], index: match.index ?? 0 });
  }
  return matches;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_whole, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function visibleText(xml: string): string {
  const withBreaks = xml.replace(/<w:(?:tab|br|cr)\b[^>]*\/?\s*>/g, "\n");
  return [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join("")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function normalizedForMatch(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function compactForRenderMap(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "");
}

function maskXmlRanges(text: string, matches: readonly XmlMatch[]): string {
  if (matches.length === 0) return text;
  const codeUnits = text.split("");
  for (const match of matches) {
    for (
      let index = match.index;
      index < match.index + match.value.length;
      index += 1
    ) {
      codeUnits[index] = " ";
    }
  }
  return codeUnits.join("");
}

function selectedMainParagraph(
  xml: string,
  paragraphIndex: number | undefined,
): XmlMatch | null {
  if (!paragraphIndex || paragraphIndex < 1) return null;
  const excluded = [...collectMatches(xml, TABLE_RE), ...collectMatches(xml, TEXT_BOX_RE)];
  const visibleXml = maskXmlRanges(xml, excluded);
  const paragraph = collectMatches(visibleXml, PARAGRAPH_RE)
    .filter((candidate) => visibleText(candidate.value).length > 0)
    [paragraphIndex - 1];
  if (!paragraph) return null;
  return {
    index: paragraph.index,
    value: xml.slice(paragraph.index, paragraph.index + paragraph.value.length),
  };
}

function selectedTableCell(xml: string, anchor: TemplateReviewSourceAnchorV2): XmlMatch | null {
  const table = collectMatches(xml, TABLE_RE)[(anchor.tableIndex ?? 0) - 1];
  if (!table) return null;
  const row = collectMatches(table.value, ROW_RE)[(anchor.rowIndex ?? 0) - 1];
  if (!row) return null;
  const cell = collectMatches(row.value, CELL_RE)[(anchor.cellIndex ?? 0) - 1];
  if (!cell) return null;
  return {
    value: cell.value,
    index: table.index + row.index + cell.index,
  };
}

function selectedHeaderFooterPath(
  paths: readonly string[],
  prefix: "header" | "footer",
  partIndex: number | undefined,
): string | null {
  const expected = partIndex ? `word/${prefix}${partIndex}.xml` : null;
  if (expected && paths.includes(expected)) return expected;
  return paths.find((path) => path.startsWith(`word/${prefix}`) && path.endsWith(".xml")) ?? null;
}

function selectedDrawingRun(
  xmlByPath: ReadonlyMap<string, string>,
  orderedPaths: readonly string[],
  drawingIndex: number | undefined,
): { path: string; run: XmlMatch; floating: boolean } | null {
  if (!drawingIndex || drawingIndex < 1) return null;
  let currentIndex = 0;
  for (const path of orderedPaths) {
    const xml = xmlByPath.get(path);
    if (!xml) continue;
    const runs = collectMatches(xml, RUN_RE);
    for (const drawing of collectMatches(xml, DRAWING_RE)) {
      const imageUseCount = drawing.value.match(IMAGE_USE_RE)?.length ?? 0;
      if (imageUseCount === 0) continue;
      const firstIndex = currentIndex + 1;
      currentIndex += imageUseCount;
      if (drawingIndex < firstIndex || drawingIndex > currentIndex) continue;
      const run = runs.find(
        (candidate) =>
          candidate.index <= drawing.index &&
          candidate.index + candidate.value.length >= drawing.index + drawing.value.length,
      );
      if (!run || /<w:txbxContent\b/.test(run.value)) return null;
      return {
        path,
        run,
        floating: /<wp:anchor\b/.test(drawing.value) || !/<wp:inline\b/.test(drawing.value),
      };
    }
  }
  return null;
}

function wrapRunWithBookmarks(
  runXml: string,
  startBookmark: string,
  endBookmark: string,
  firstBookmarkId: number,
): string {
  return [
    zeroLengthBookmark(firstBookmarkId, startBookmark),
    runXml,
    zeroLengthBookmark(firstBookmarkId + 1, endBookmark),
  ].join("");
}

function bookmarkName(targetId: string, side: "start" | "end"): string {
  const digest = createHash("sha256")
    .update(`${side}:${targetId}`)
    .digest("hex")
    .slice(0, 16);
  return `xg_${side}_${digest}`;
}

function zeroLengthBookmark(id: number, name: string): string {
  return `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`;
}

function maxBookmarkId(xml: string): number {
  let maxId = -1;
  for (const match of xml.matchAll(/<w:bookmarkStart\b[^>]*\bw:id=["'](\d+)["'][^>]*>/g)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > maxId) maxId = id;
  }
  return maxId;
}

function wrapContainerWithBookmarks(
  containerXml: string,
  startBookmark: string,
  endBookmark: string,
  firstBookmarkId: number,
): string | null {
  const firstParagraph = containerXml.match(/<w:p\b[^>]*>/);
  const lastParagraphEnd = containerXml.lastIndexOf("</w:p>");
  if (!firstParagraph || firstParagraph.index == null || lastParagraphEnd < 0) {
    return null;
  }
  let contentStart = firstParagraph.index + firstParagraph[0].length;
  const paragraphProperties = containerXml
    .slice(contentStart)
    .match(/^<w:pPr\b[\s\S]*?<\/w:pPr>/);
  if (paragraphProperties) contentStart += paragraphProperties[0].length;
  const contentEnd = lastParagraphEnd;
  return [
    containerXml.slice(0, contentStart),
    zeroLengthBookmark(firstBookmarkId, startBookmark),
    containerXml.slice(contentStart, contentEnd),
    zeroLengthBookmark(firstBookmarkId + 1, endBookmark),
    containerXml.slice(contentEnd),
  ].join("");
}

function projectionWarning(
  code: NonNullable<DocumentReviewProjectionV1["warningCode"]>,
  targetId: string,
): TemplateReviewRenderWarningV3 {
  const messageByCode: Record<NonNullable<DocumentReviewProjectionV1["warningCode"]>, string> = {
    TARGET_MARKER_MISSING: "候选位置无法插入稳定书签，已列入右侧待处理清单",
    TARGET_TEXT_MISMATCH: "候选文字与渲染副本中的锚点文字不一致，已列入右侧待处理清单",
    TARGET_OBJECT_UNSUPPORTED: "图片、浮动对象或绘图暂不支持直接标黄点击，已列入右侧待处理清单",
    TARGET_LOCATION_UNMAPPED: "候选逻辑位置无法映射到文档展示区，已列入右侧待处理清单",
  };
  return { code, message: messageByCode[code], targetIds: [targetId] };
}

async function projectDocxForReviewV1(
  content: Buffer,
  targets: readonly DocumentReviewProjectionTargetV1[],
): Promise<ProjectedDocxForReviewV1> {
  const zip = await JSZip.loadAsync(content);
  const xmlPaths = Object.keys(zip.files).filter((path) => path.endsWith(".xml"));
  const mainPath = "word/document.xml";
  const mainXml = await zip.file(mainPath)?.async("string");
  if (!mainXml) throw new Error("DOCX_DOCUMENT_XML_MISSING");

  const xmlByPath = new Map<string, string>([[mainPath, mainXml]]);
  const edits: ProjectionFileEditV1[] = [];
  const projections: DocumentReviewProjectionV1[] = [];
  const warnings: TemplateReviewRenderWarningV3[] = [];
  const usedContainers = new Set<string>();
  const usedRanges: Array<{ path: string; start: number; end: number }> = [];
  const hasRangeConflict = (path: string, start: number, end: number): boolean =>
    usedRanges.some((range) => range.path === path && start < range.end && end > range.start);
  let bookmarkId = 1;
  for (const path of xmlPaths) {
    const xml = xmlByPath.get(path) ?? await zip.file(path)?.async("string");
    if (!xml) continue;
    xmlByPath.set(path, xml);
    bookmarkId = Math.max(bookmarkId, maxBookmarkId(xml) + 1);
  }
  const drawingPaths = [
    mainPath,
    ...xmlPaths.filter((path) => /^word\/header[^/]*\.xml$/i.test(path)).sort(),
    ...xmlPaths.filter((path) => /^word\/footer[^/]*\.xml$/i.test(path)).sort(),
  ];

  for (const target of targets) {
    if (
      (target.kind === "IMAGE" || target.kind === "DRAWING") &&
      target.sourceAnchor.part === "DRAWING"
    ) {
      const selected = selectedDrawingRun(
        xmlByPath,
        drawingPaths,
        target.sourceAnchor.drawingIndex,
      );
      if (!selected || selected.floating) {
        projections.push({
          targetId: target.targetId,
          status: "UNMAPPED",
          textSelectionAllowed: false,
          warningCode: "TARGET_OBJECT_UNSUPPORTED",
        });
        warnings.push(projectionWarning("TARGET_OBJECT_UNSUPPORTED", target.targetId));
        continue;
      }
      const containerKey = `${selected.path}:${selected.run.index}:${selected.run.value.length}`;
      if (
        usedContainers.has(containerKey) ||
        hasRangeConflict(
          selected.path,
          selected.run.index,
          selected.run.index + selected.run.value.length,
        )
      ) {
        projections.push({
          targetId: target.targetId,
          status: "UNMAPPED",
          textSelectionAllowed: false,
          warningCode: "TARGET_LOCATION_UNMAPPED",
        });
        warnings.push(projectionWarning("TARGET_LOCATION_UNMAPPED", target.targetId));
        continue;
      }
      const startBookmark = bookmarkName(target.targetId, "start");
      const endBookmark = bookmarkName(target.targetId, "end");
      const replacement = wrapRunWithBookmarks(
        selected.run.value,
        startBookmark,
        endBookmark,
        bookmarkId,
      );
      bookmarkId += 2;
      usedContainers.add(containerKey);
      usedRanges.push({
        path: selected.path,
        start: selected.run.index,
        end: selected.run.index + selected.run.value.length,
      });
      edits.push({
        path: selected.path,
        start: selected.run.index,
        end: selected.run.index + selected.run.value.length,
        replacement,
      });
      projections.push({
        targetId: target.targetId,
        status: "PROJECTED",
        startBookmark,
        endBookmark,
        textSelectionAllowed: false,
        objectSelectionAllowed: true,
      });
      continue;
    }
    if (
      target.kind === "IMAGE" ||
      target.kind === "DRAWING" ||
      target.kind === "UNMAPPED" ||
      target.sourceAnchor.part === "TEXT_BOX" ||
      target.sourceAnchor.part === "DRAWING" ||
      target.sourceAnchor.part === "PAGE_IMAGE"
    ) {
      const warningCode = target.kind === "UNMAPPED" ? "TARGET_LOCATION_UNMAPPED" : "TARGET_OBJECT_UNSUPPORTED";
      projections.push({
        targetId: target.targetId,
        status: "UNMAPPED",
        textSelectionAllowed: false,
        warningCode,
      });
      warnings.push(projectionWarning(warningCode, target.targetId));
      continue;
    }

    const anchor = target.sourceAnchor;
    let path = mainPath;
    if (anchor.part === "HEADER" || anchor.part === "FOOTER") {
      const selectedPath = selectedHeaderFooterPath(
        xmlPaths,
        anchor.part === "HEADER" ? "header" : "footer",
        anchor.partIndex,
      );
      if (!selectedPath) {
        projections.push({
          targetId: target.targetId,
          status: "UNMAPPED",
          textSelectionAllowed: false,
          warningCode: "TARGET_LOCATION_UNMAPPED",
        });
        warnings.push(projectionWarning("TARGET_LOCATION_UNMAPPED", target.targetId));
        continue;
      }
      path = selectedPath;
    }
    if (!xmlByPath.has(path)) {
      const xml = await zip.file(path)?.async("string");
      if (xml) xmlByPath.set(path, xml);
    }
    const xml = xmlByPath.get(path);
    if (!xml) {
      projections.push({
        targetId: target.targetId,
        status: "UNMAPPED",
        textSelectionAllowed: false,
        warningCode: "TARGET_LOCATION_UNMAPPED",
      });
      warnings.push(projectionWarning("TARGET_LOCATION_UNMAPPED", target.targetId));
      continue;
    }

    const match = anchor.part === "TABLE_CELL"
      ? selectedTableCell(xml, anchor)
      : selectedMainParagraph(xml, anchor.paragraphIndex);
    if (!match) {
      projections.push({
        targetId: target.targetId,
        status: "UNMAPPED",
        textSelectionAllowed: false,
        warningCode: "TARGET_LOCATION_UNMAPPED",
      });
      warnings.push(projectionWarning("TARGET_LOCATION_UNMAPPED", target.targetId));
      continue;
    }
    const containerKey = `${path}:${match.index}:${match.value.length}`;
    if (
      usedContainers.has(containerKey) ||
      hasRangeConflict(path, match.index, match.index + match.value.length)
    ) {
      projections.push({
        targetId: target.targetId,
        status: "UNMAPPED",
        textSelectionAllowed: false,
        warningCode: "TARGET_LOCATION_UNMAPPED",
      });
      warnings.push(projectionWarning("TARGET_LOCATION_UNMAPPED", target.targetId));
      continue;
    }
    const expected = normalizedForMatch(target.preview);
    const actualText = visibleText(match.value);
    const actual = normalizedForMatch(actualText);
    if (expected && !actual.includes(expected)) {
      projections.push({
        targetId: target.targetId,
        status: "UNMAPPED",
        textSelectionAllowed: false,
        warningCode: "TARGET_TEXT_MISMATCH",
        expectedTextSha256: createHash("sha256").update(actualText).digest("hex"),
        expectedTextLengthUtf16: actualText.length,
      });
      warnings.push(projectionWarning("TARGET_TEXT_MISMATCH", target.targetId));
      continue;
    }

    const startBookmark = bookmarkName(target.targetId, "start");
    const endBookmark = bookmarkName(target.targetId, "end");
    const replacement = wrapContainerWithBookmarks(match.value, startBookmark, endBookmark, bookmarkId);
    bookmarkId += 2;
    if (!replacement) {
      projections.push({
        targetId: target.targetId,
        status: "UNMAPPED",
        textSelectionAllowed: false,
        warningCode: "TARGET_MARKER_MISSING",
      });
      warnings.push(projectionWarning("TARGET_MARKER_MISSING", target.targetId));
      continue;
    }
    usedContainers.add(containerKey);
    usedRanges.push({ path, start: match.index, end: match.index + match.value.length });
    edits.push({ path, start: match.index, end: match.index + match.value.length, replacement });
    projections.push({
      targetId: target.targetId,
      status: "PROJECTED",
      startBookmark,
      endBookmark,
      textSelectionAllowed: !!expected && actual === expected,
      expectedTextSha256: createHash("sha256").update(actualText).digest("hex"),
      expectedTextLengthUtf16: actualText.length,
      expectedCompactTextSha256: createHash("sha256")
        .update(compactForRenderMap(actualText))
        .digest("hex"),
      expectedCompactTextLengthUtf16: compactForRenderMap(actualText).length,
    });
  }

  const editsByPath = new Map<string, ProjectionFileEditV1[]>();
  for (const edit of edits) {
    const bucket = editsByPath.get(edit.path) ?? [];
    bucket.push(edit);
    editsByPath.set(edit.path, bucket);
  }
  for (const [path, pathEdits] of editsByPath) {
    let xml = xmlByPath.get(path);
    if (!xml) continue;
    for (const edit of pathEdits.sort((left, right) => right.start - left.start)) {
      xml = `${xml.slice(0, edit.start)}${edit.replacement}${xml.slice(edit.end)}`;
    }
    zip.file(path, xml);
  }

  const approximatePageCount = Math.max(
    1,
    1 + (mainXml.match(/<w:(?:lastRenderedPageBreak|br\b[^>]*w:type=["']page["'])/g)?.length ?? 0),
  );
  return {
    content: await zip.generateAsync({ type: "nodebuffer" }),
    approximatePageCount,
    warnings,
    projections,
  };
}

export class DocumentReviewRendererV1 {
  private readonly manifests = new Map<string, PrivateRenderManifestV1>();
  private readonly legacyDocxCache = new Map<string, Buffer>();

  constructor(private readonly config: DocumentReviewRendererConfigV1) {}

  private cachedLegacyDocx(sourceSha256: string): Buffer | null {
    const cached = this.legacyDocxCache.get(sourceSha256);
    if (!cached) return null;
    this.legacyDocxCache.delete(sourceSha256);
    this.legacyDocxCache.set(sourceSha256, cached);
    return Buffer.from(cached);
  }

  private rememberLegacyDocx(sourceSha256: string, content: Buffer): void {
    const previous = this.legacyDocxCache.get(sourceSha256);
    previous?.fill(0);
    this.legacyDocxCache.delete(sourceSha256);
    this.legacyDocxCache.set(sourceSha256, Buffer.from(content));
    while (this.legacyDocxCache.size > LEGACY_DOCX_CACHE_LIMIT) {
      const oldestKey = this.legacyDocxCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.legacyDocxCache.get(oldestKey)?.fill(0);
      this.legacyDocxCache.delete(oldestKey);
    }
  }

  async prepare(
    content: Buffer,
    inputFormat: TemplateReviewInputFormatV2,
    signal?: AbortSignal,
    projectionTargets: readonly DocumentReviewProjectionTargetV1[] = [],
  ): Promise<PreparedDocumentReviewRenderV1> {
    assertActive(signal);
    const sourceSha256 = createHash("sha256").update(content).digest("hex");
    let normalizedDocx: Buffer | null = null;

    if (inputFormat === "DOCX") {
      await inspectSafeDocxArchiveV1(content);
      normalizedDocx = Buffer.from(content);
    } else {
      inspectSafeLegacyDocV1(content);
      normalizedDocx = this.cachedLegacyDocx(sourceSha256);
      let shouldCacheNormalizedDocx = false;
      if (!normalizedDocx) {
        try {
          const converted = await this.config.converter.convert(
            content,
            "DOC",
            "DOCX",
            signal,
          );
          normalizedDocx = Buffer.from(converted.content);
        } catch (error) {
          return this.saveFallbackManifest(
            sourceSha256,
            inputFormat,
            null,
            conversionWarning(error),
          );
        }
        shouldCacheNormalizedDocx = true;
      }
      await inspectSafeDocxArchiveV1(normalizedDocx);
      if (shouldCacheNormalizedDocx) {
        this.rememberLegacyDocx(sourceSha256, normalizedDocx);
      }
    }
    assertActive(signal);

    let projected: ProjectedDocxForReviewV1;
    try {
      projected = await projectDocxForReviewV1(
        normalizedDocx,
        projectionTargets,
      );
    } catch {
      assertActive(signal);
      return this.saveFallbackManifest(
        sourceSha256,
        inputFormat,
        normalizedDocx,
        docxHtmlRenderWarning(),
      );
    }
    const manifestId = randomUUID();
    const documentToken = randomBytes(24).toString("base64url");
    this.manifests.set(manifestId, {
      manifestId,
      sourceSha256,
      inputFormat,
      normalizedDocx,
      displayDocx: projected.content,
      documentToken,
    });
    return {
      manifestId,
      sourceSha256,
      normalizedDocxAvailable: true,
      render: {
        mode: "DOCX_HTML",
        documentToken,
        paginationBasis: "DOCX_STORED_BREAKS",
        approximatePageCount: projected.approximatePageCount,
        warnings: [
          {
            code: "DOCX_HTML_PAGINATION_APPROXIMATE",
            message:
              "内置文档视图使用 DOCX 直接渲染，分页只按文档已有分页标记近似显示",
          },
          ...projected.warnings,
        ],
      },
      projections: projected.projections,
    };
  }

  private saveFallbackManifest(
    sourceSha256: string,
    inputFormat: TemplateReviewInputFormatV2,
    normalizedDocx: Buffer | null,
    cause: TemplateReviewRenderWarningV3,
  ): PreparedDocumentReviewRenderV1 {
    const manifestId = randomUUID();
    this.manifests.set(manifestId, {
      manifestId,
      sourceSha256,
      inputFormat,
      normalizedDocx,
      displayDocx: null,
      documentToken: null,
    });
    return {
      manifestId,
      sourceSha256,
      normalizedDocxAvailable: normalizedDocx !== null,
      render: {
        mode: "STRUCTURED_FALLBACK",
        paginationBasis: "UNKNOWN",
        approximatePageCount: null,
        warnings: [
          cause,
          {
            code: "STRUCTURED_FALLBACK_ACTIVE",
            message: "所有无法定位的内容必须进入人工清单，不会静默遗漏",
          },
        ],
      },
      projections: [],
    };
  }

  readDocumentAsset(
    manifestId: string,
    documentToken: string,
  ): DocumentReviewDocumentAssetV1 {
    const manifest = this.manifests.get(manifestId);
    if (
      !manifest ||
      !manifest.displayDocx ||
      manifest.documentToken !== documentToken
    ) {
      throw new Error("TEMPLATE_REVIEW_DOCUMENT_TOKEN_INVALID");
    }
    return {
      docxBytes: Uint8Array.from(manifest.displayDocx),
      sha256: createHash("sha256").update(manifest.displayDocx).digest("hex"),
    };
  }

  /** Renderer 只回传主进程签发的文档令牌；主进程在私有清单中反查所属文档。 */
  readDocumentAssetByToken(documentToken: string): DocumentReviewDocumentAssetV1 {
    for (const manifest of this.manifests.values()) {
      if (manifest.documentToken === documentToken) {
        return this.readDocumentAsset(manifest.manifestId, documentToken)
      }
    }
    throw new Error("TEMPLATE_REVIEW_DOCUMENT_TOKEN_INVALID")
  }

  /** 供主进程解析/物化使用；返回副本，调用方不得转发给 Renderer。 */
  readNormalizedDocx(manifestId: string): Buffer | null {
    const content = this.manifests.get(manifestId)?.normalizedDocx;
    return content ? Buffer.from(content) : null;
  }

  release(manifestId: string): boolean {
    const manifest = this.manifests.get(manifestId);
    if (!manifest) return false;
    manifest.normalizedDocx?.fill(0);
    manifest.displayDocx?.fill(0);
    return this.manifests.delete(manifestId);
  }

  close(): void {
    for (const manifest of this.manifests.values()) {
      manifest.normalizedDocx?.fill(0);
      manifest.displayDocx?.fill(0);
    }
    this.manifests.clear();
    for (const content of this.legacyDocxCache.values()) content.fill(0);
    this.legacyDocxCache.clear();
  }
}

/** 仅用于日志中展示不含路径的可执行文件名。 */
export function libreOfficeExecutableDisplayNameV1(
  executablePath: string,
): string {
  const name = basename(executablePath);
  return extname(name)
    ? name
    : `${name}${process.platform === "win32" ? ".exe" : ""}`;
}
