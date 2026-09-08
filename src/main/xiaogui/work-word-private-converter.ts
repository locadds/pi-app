import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { TemplateReviewInputFormatV2 } from "@shared/xiaogui-work-template-review";
import {
  runPrivateProcessV1,
  type LibreOfficeConversionTargetV1,
  type LibreOfficeConverterV1,
  type LibreOfficeConversionResultV1,
  type PrivateProcessRunnerV1,
} from "./work-document-review-renderer";

export type WordConversionErrorCodeV1 =
  | "WORD_UNAVAILABLE"
  | "WORD_TIMEOUT"
  | "WORD_ABORTED"
  | "WORD_FAILED"
  | "WORD_OUTPUT_MISSING";

export class WordConversionErrorV1 extends Error {
  constructor(readonly code: WordConversionErrorCodeV1) {
    super(code);
    this.name = "WordConversionErrorV1";
  }
}

export interface WordPrivateConverterConfigV1 {
  /** 必须是调用方选定的私有临时根目录；每次转换会创建独立会话。 */
  privateRoot: string;
  scriptPath: string;
  powershellPath?: string;
  timeoutMs?: number;
  processRunner?: PrivateProcessRunnerV1;
}

function defaultPowerShellPathV1(): string {
  return resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function isRegularFileV1(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function removePrivateSessionRootV1(
  privateRoot: string,
  sessionRoot: string,
): Promise<void> {
  const parent = resolve(privateRoot);
  const target = resolve(sessionRoot);
  if (target === parent || !target.startsWith(`${parent}${sep}`)) {
    throw new Error("WORD_PRIVATE_ROOT_SCOPE_MISMATCH");
  }
  await rm(target, { recursive: true, force: true });
}

function mapProcessErrorV1(error: unknown, signal?: AbortSignal): WordConversionErrorV1 {
  if (signal?.aborted || (error instanceof Error && error.message === "ABORTED")) {
    return new WordConversionErrorV1("WORD_ABORTED");
  }
  if (error instanceof Error && error.message === "TIMEOUT") {
    return new WordConversionErrorV1("WORD_TIMEOUT");
  }
  return new WordConversionErrorV1("WORD_FAILED");
}

async function readScriptErrorV1(sessionRoot: string): Promise<WordConversionErrorV1 | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(sessionRoot, "result.json"), "utf8"));
    const code =
      typeof parsed === "object" && parsed !== null && "code" in parsed
        ? (parsed as { code?: unknown }).code
        : undefined;
    if (
      code === "WORD_UNAVAILABLE" ||
      code === "WORD_TIMEOUT" ||
      code === "WORD_ABORTED" ||
      code === "WORD_FAILED" ||
      code === "WORD_OUTPUT_MISSING"
    ) {
      return new WordConversionErrorV1(code);
    }
  } catch {
    // A failing helper may be unable to write result.json; never expose stderr.
  }
  return null;
}

export class WordPrivateConverterV1 implements LibreOfficeConverterV1 {
  private readonly timeoutMs: number;
  private readonly processRunner: PrivateProcessRunnerV1;

  constructor(private readonly config: WordPrivateConverterConfigV1) {
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
    if (process.platform !== "win32" || signal?.aborted) {
      throw new WordConversionErrorV1(
        signal?.aborted ? "WORD_ABORTED" : "WORD_UNAVAILABLE",
      );
    }
    if (inputFormat !== "DOC" || target !== "DOCX") {
      throw new WordConversionErrorV1("WORD_FAILED");
    }

    const powershellPath = this.config.powershellPath ?? defaultPowerShellPathV1();
    if (
      !(await isRegularFileV1(powershellPath)) ||
      !(await isRegularFileV1(this.config.scriptPath))
    ) {
      throw new WordConversionErrorV1("WORD_UNAVAILABLE");
    }

    await mkdir(this.config.privateRoot, { recursive: true });
    const sessionRoot = await mkdtemp(join(this.config.privateRoot, "xiaogui-word-review-"));
    const sourcePath = join(sessionRoot, "source.doc");
    const outputPath = join(sessionRoot, "converted.docx");
    const scriptArgs = (operation: "Convert" | "Cleanup") => [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.config.scriptPath,
      "-SessionRoot",
      sessionRoot,
      "-Operation",
      operation,
    ];

    let result: LibreOfficeConversionResultV1 | null = null;
    let conversionError: WordConversionErrorV1 | null = null;
    try {
      await writeFile(sourcePath, content, { flag: "wx" });
      try {
        const execution = await this.processRunner(powershellPath, scriptArgs("Convert"), {
          cwd: sessionRoot,
          timeoutMs: this.timeoutMs,
          signal,
        });
        if (signal?.aborted) {
          conversionError = new WordConversionErrorV1("WORD_ABORTED");
        } else if (execution.exitCode !== 0) {
          conversionError =
            (await readScriptErrorV1(sessionRoot)) ??
            new WordConversionErrorV1("WORD_FAILED");
        } else {
          try {
            const output = await readFile(outputPath);
            if (output.byteLength === 0) {
              conversionError = new WordConversionErrorV1("WORD_OUTPUT_MISSING");
            } else {
              result = { content: output, format: target, elapsedMs: Date.now() - startedAt };
            }
          } catch {
            conversionError = new WordConversionErrorV1("WORD_OUTPUT_MISSING");
          }
        }
      } catch (error) {
        conversionError = mapProcessErrorV1(error, signal);
      }
    } catch {
      conversionError = new WordConversionErrorV1("WORD_FAILED");
    }

    let cleanupSucceeded = false;
    try {
      const cleanup = await this.processRunner(powershellPath, scriptArgs("Cleanup"), {
        cwd: sessionRoot,
        timeoutMs: 10_000,
      });
      cleanupSucceeded = cleanup.exitCode === 0;
    } catch {
      cleanupSucceeded = false;
    }
    if (!cleanupSucceeded) {
      throw new WordConversionErrorV1("WORD_FAILED");
    }
    try {
      await removePrivateSessionRootV1(this.config.privateRoot, sessionRoot);
    } catch {
      throw new WordConversionErrorV1("WORD_FAILED");
    }
    if (conversionError) throw conversionError;
    if (!result) throw new WordConversionErrorV1("WORD_FAILED");
    return result;
  }
}
