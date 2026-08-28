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

import type {
  TemplateReviewInputFormatV2,
  TemplateReviewPageRegionV2,
  TemplateReviewPageV2,
  TemplateReviewRenderWarningV2,
} from "@shared/xiaogui-work-template-review";
import { inspectSafeDocxArchiveV1 } from "./docx-safety";
import { inspectSafeLegacyDocV1 } from "./work-legacy-doc-safety";

export type LibreOfficeConversionTargetV1 = "DOCX" | "PDF";

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
    const outputExtension = target === "PDF" ? ".pdf" : ".docx";
    const outputPath = join(outputRoot, `${sourceBase}${outputExtension}`);

    try {
      await mkdir(join(profileRoot, "user"), { recursive: true });
      await mkdir(outputRoot, { recursive: true });
      await writeFile(
        join(profileRoot, "user", "registrymodifications.xcu"),
        macroSecurityRegistryV1(),
      );
      await writeFile(inputPath, content, { flag: "wx" });

      const convertFilter =
        target === "PDF"
          ? "pdf:writer_pdf_Export"
          : "docx:Office Open XML Text";
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

export interface PrivatePdfTextSpanV1 {
  text: string;
  startUtf16: number;
  endUtf16Exclusive: number;
  region: TemplateReviewPageRegionV2;
}

export interface PrivatePdfPageManifestV1 {
  pageNumber: number;
  widthPoints: number;
  heightPoints: number;
  text: string;
  textSpans: readonly PrivatePdfTextSpanV1[];
}

export type PdfManifestBuilderV1 = (
  pdfBytes: Buffer,
) => Promise<readonly PrivatePdfPageManifestV1[]>;

export const buildPdfManifestWithPdfJsV1: PdfManifestBuilderV1 = async (
  pdfBytes,
) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
  });
  const document = await loadingTask.promise;
  const pages: PrivatePdfPageManifestV1[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const spans: PrivatePdfTextSpanV1[] = [];
      let text = "";
      for (const item of textContent.items) {
        if (!("str" in item) || !item.str) continue;
        const startUtf16 = text.length;
        text += item.str;
        const endUtf16Exclusive = text.length;
        const transformed = pdfjs.Util.transform(
          viewport.transform,
          item.transform,
        );
        const height = Math.max(
          1,
          Math.abs(item.height || transformed[3] || transformed[0]),
        );
        spans.push({
          text: item.str,
          startUtf16,
          endUtf16Exclusive,
          region: {
            pageNumber,
            x: transformed[4],
            y: transformed[5] - height,
            width: Math.max(1, Math.abs(item.width)),
            height,
          },
        });
        if (item.hasEOL) text += "\n";
      }
      pages.push({
        pageNumber,
        widthPoints: viewport.width,
        heightPoints: viewport.height,
        text,
        textSpans: spans,
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
};

interface PrivateRenderManifestV1 {
  manifestId: string;
  sourceSha256: string;
  inputFormat: TemplateReviewInputFormatV2;
  normalizedDocx: Buffer | null;
  pdfBytes: Buffer | null;
  pagesByToken: Map<string, PrivatePdfPageManifestV1>;
}

export interface PreparedDocumentReviewRenderV1 {
  /** 仅供主进程私有存储，不得进入工具结果、Pi 会话或 Renderer 状态。 */
  manifestId: string;
  sourceSha256: string;
  normalizedDocxAvailable: boolean;
  render: {
    mode: "PDF" | "STRUCTURED_FALLBACK";
    pageCount: number | null;
    pages: readonly TemplateReviewPageV2[];
    warnings: readonly TemplateReviewRenderWarningV2[];
  };
}

export interface DocumentReviewPageAssetV1 {
  pageNumber: number;
  pdfBytes: Uint8Array;
  text: string;
  textSpans: readonly PrivatePdfTextSpanV1[];
}

export interface DocumentReviewRendererConfigV1 {
  converter: LibreOfficeConverterV1;
  pdfManifestBuilder?: PdfManifestBuilderV1;
}

function conversionWarning(error: unknown): TemplateReviewRenderWarningV2 {
  if (
    error instanceof LibreOfficeConversionErrorV1 &&
    error.code === "LIBREOFFICE_UNAVAILABLE"
  ) {
    return {
      code: "LIBREOFFICE_UNAVAILABLE",
      message: "本机文档渲染组件不可用，已切换为结构化复核视图",
    };
  }
  return {
    code: "LIBREOFFICE_CONVERSION_FAILED",
    message: "文档页面转换失败，已切换为结构化复核视图",
  };
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new LibreOfficeConversionErrorV1("LIBREOFFICE_ABORTED");
}

export class DocumentReviewRendererV1 {
  private readonly manifests = new Map<string, PrivateRenderManifestV1>();
  private readonly pdfManifestBuilder: PdfManifestBuilderV1;

  constructor(private readonly config: DocumentReviewRendererConfigV1) {
    this.pdfManifestBuilder =
      config.pdfManifestBuilder ?? buildPdfManifestWithPdfJsV1;
  }

  async prepare(
    content: Buffer,
    inputFormat: TemplateReviewInputFormatV2,
    signal?: AbortSignal,
  ): Promise<PreparedDocumentReviewRenderV1> {
    assertActive(signal);
    const sourceSha256 = createHash("sha256").update(content).digest("hex");
    let normalizedDocx: Buffer | null = null;

    if (inputFormat === "DOCX") {
      await inspectSafeDocxArchiveV1(content);
      normalizedDocx = Buffer.from(content);
    } else {
      inspectSafeLegacyDocV1(content);
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
      await inspectSafeDocxArchiveV1(normalizedDocx);
    }
    assertActive(signal);

    let pdfBytes: Buffer;
    try {
      const rendered = await this.config.converter.convert(
        normalizedDocx,
        "DOCX",
        "PDF",
        signal,
      );
      pdfBytes = Buffer.from(rendered.content);
    } catch (error) {
      return this.saveFallbackManifest(
        sourceSha256,
        inputFormat,
        normalizedDocx,
        conversionWarning(error),
      );
    }

    let pdfPages: readonly PrivatePdfPageManifestV1[];
    try {
      pdfPages = await this.pdfManifestBuilder(pdfBytes);
      if (pdfPages.length === 0) throw new Error("PDF_HAS_NO_PAGES");
    } catch {
      return this.saveFallbackManifest(
        sourceSha256,
        inputFormat,
        normalizedDocx,
        {
          code: "PDF_TEXT_MAPPING_FAILED",
          message: "页面文字位置无法可靠映射，已切换为结构化复核视图",
        },
      );
    }
    assertActive(signal);

    const manifestId = randomUUID();
    const pagesByToken = new Map<string, PrivatePdfPageManifestV1>();
    const pages = pdfPages.map((page) => {
      const pageToken = randomBytes(24).toString("base64url");
      pagesByToken.set(pageToken, page);
      return {
        pageNumber: page.pageNumber,
        pageToken,
        widthPoints: page.widthPoints,
        heightPoints: page.heightPoints,
        textLayerAvailable: page.textSpans.length > 0,
      };
    });
    this.manifests.set(manifestId, {
      manifestId,
      sourceSha256,
      inputFormat,
      normalizedDocx,
      pdfBytes,
      pagesByToken,
    });
    return {
      manifestId,
      sourceSha256,
      normalizedDocxAvailable: true,
      render: { mode: "PDF", pageCount: pages.length, pages, warnings: [] },
    };
  }

  private saveFallbackManifest(
    sourceSha256: string,
    inputFormat: TemplateReviewInputFormatV2,
    normalizedDocx: Buffer | null,
    cause: TemplateReviewRenderWarningV2,
  ): PreparedDocumentReviewRenderV1 {
    const manifestId = randomUUID();
    this.manifests.set(manifestId, {
      manifestId,
      sourceSha256,
      inputFormat,
      normalizedDocx,
      pdfBytes: null,
      pagesByToken: new Map(),
    });
    return {
      manifestId,
      sourceSha256,
      normalizedDocxAvailable: normalizedDocx !== null,
      render: {
        mode: "STRUCTURED_FALLBACK",
        pageCount: null,
        pages: [],
        warnings: [
          cause,
          {
            code: "STRUCTURED_FALLBACK_ACTIVE",
            message: "所有无法定位的内容必须进入人工清单，不会静默遗漏",
          },
        ],
      },
    };
  }

  readPageAsset(
    manifestId: string,
    pageToken: string,
  ): DocumentReviewPageAssetV1 {
    const manifest = this.manifests.get(manifestId);
    const page = manifest?.pagesByToken.get(pageToken);
    if (!manifest || !page || !manifest.pdfBytes)
      throw new Error("TEMPLATE_REVIEW_PAGE_TOKEN_INVALID");
    return {
      pageNumber: page.pageNumber,
      pdfBytes: Uint8Array.from(manifest.pdfBytes),
      text: page.text,
      textSpans: page.textSpans.map((span) => ({
        ...span,
        region: { ...span.region },
      })),
    };
  }

  /** Renderer 只回传主进程签发的页面令牌；主进程在私有清单中反查所属文档。 */
  readPageAssetByToken(pageToken: string): DocumentReviewPageAssetV1 {
    for (const manifest of this.manifests.values()) {
      if (manifest.pagesByToken.has(pageToken)) {
        return this.readPageAsset(manifest.manifestId, pageToken)
      }
    }
    throw new Error("TEMPLATE_REVIEW_PAGE_TOKEN_INVALID")
  }

  /** 供主进程解析/物化使用；返回副本，调用方不得转发给 Renderer。 */
  readNormalizedDocx(manifestId: string): Buffer | null {
    const content = this.manifests.get(manifestId)?.normalizedDocx;
    return content ? Buffer.from(content) : null;
  }

  locateExactText(
    manifestId: string,
    text: string,
    occurrence = 1,
  ): readonly TemplateReviewPageRegionV2[] {
    if (!text || !Number.isSafeInteger(occurrence) || occurrence < 1) return [];
    const manifest = this.manifests.get(manifestId);
    if (!manifest) return [];
    let seen = 0;
    for (const page of manifest.pagesByToken.values()) {
      let cursor = 0;
      while (cursor <= page.text.length) {
        const found = page.text.indexOf(text, cursor);
        if (found < 0) break;
        seen += 1;
        if (seen === occurrence) {
          const end = found + text.length;
          return page.textSpans
            .filter(
              (span) => span.endUtf16Exclusive > found && span.startUtf16 < end,
            )
            .map((span) => ({ ...span.region }));
        }
        cursor = found + Math.max(1, text.length);
      }
    }
    return [];
  }

  countExactTextOccurrences(manifestId: string, text: string): number {
    if (!text) return 0;
    const manifest = this.manifests.get(manifestId);
    if (!manifest) return 0;
    let count = 0;
    for (const page of manifest.pagesByToken.values()) {
      let cursor = 0;
      while (cursor <= page.text.length) {
        const found = page.text.indexOf(text, cursor);
        if (found < 0) break;
        count += 1;
        cursor = found + Math.max(1, text.length);
      }
    }
    return count;
  }

  release(manifestId: string): boolean {
    const manifest = this.manifests.get(manifestId);
    if (!manifest) return false;
    manifest.normalizedDocx?.fill(0);
    manifest.pdfBytes?.fill(0);
    manifest.pagesByToken.clear();
    return this.manifests.delete(manifestId);
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
