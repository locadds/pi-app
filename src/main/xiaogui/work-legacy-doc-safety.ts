import * as CFB from "cfb";

export const LEGACY_DOC_SAFETY_MAX_FILE_BYTES_V1 = 20 * 1024 * 1024;
export const LEGACY_DOC_SAFETY_MAX_EXPANDED_BYTES_V1 = 64 * 1024 * 1024;
export const LEGACY_DOC_SAFETY_MAX_ENTRIES_V1 = 1_000;

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const WORD_FIB_IDENT = 0xa5ec;
const WORD_FIB_ENCRYPTED = 0x0100;
const WORD_FIB_OBFUSCATED = 0x8000;
// cfb@1.2.2 只在 .d.ts 暴露 const enum，CommonJS 运行时没有 CFB$EntryType 对象。
const CFB_ENTRY_TYPE_STREAM = 2;

export type LegacyDocSafetyErrorCodeV1 =
  | "INPUT_TOO_LARGE"
  | "INVALID_CFB"
  | "NOT_WORD_DOC"
  | "ENCRYPTED"
  | "VBA"
  | "ACTIVEX"
  | "EMBEDDED_OBJECT"
  | "STRUCTURE_LIMIT_EXCEEDED"
  | "ABNORMAL_STRUCTURE";

export class LegacyDocSafetyErrorV1 extends Error {
  constructor(readonly code: LegacyDocSafetyErrorCodeV1) {
    super(code);
    this.name = "LegacyDocSafetyErrorV1";
  }
}

export interface SafeLegacyDocV1 {
  format: "DOC";
  byteLength: number;
  entryCount: number;
  streamCount: number;
  expandedBytes: number;
  tableStream: "0Table" | "1Table";
  fibVersion: number;
}

function normalizedCfbName(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[\u0000-\u001f]/g, "").trim())
    .filter(Boolean)
    .join("/")
    .toLowerCase();
}

function isVbaEntry(name: string): boolean {
  const segments = name.split("/");
  return (
    segments.includes("vba") ||
    segments.includes("macros") ||
    segments.some((segment) =>
      ["_vba_project", "vba_project", "project", "projectwm"].includes(segment),
    )
  );
}

function isActiveXEntry(name: string): boolean {
  const segments = name.split("/");
  return segments.some(
    (segment) =>
      segment === "activex" ||
      segment === "ocxname" ||
      segment.endsWith(".ocx") ||
      segment.startsWith("activex"),
  );
}

function isEmbeddedObjectEntry(name: string): boolean {
  const segments = name.split("/");
  return segments.some(
    (segment) =>
      segment === "objectpool" ||
      segment === "embeddings" ||
      segment === "ole10native" ||
      segment === "package" ||
      /^mbd[0-9a-f]+$/i.test(segment),
  );
}

function isEncryptionEntry(name: string): boolean {
  const segments = name.split("/");
  return segments.some(
    (segment) =>
      segment === "encryptioninfo" ||
      segment === "encryptedpackage" ||
      segment === "dataspaces" ||
      segment === "strongencryptiondataspace",
  );
}

function entryContent(entry: CFB.CFB$Entry): Buffer {
  return Buffer.from(entry.content);
}

/**
 * 对旧版二进制 Word（DOC）执行只读 CFB 门禁。
 *
 * 此门禁只批准结构简单、未加密、无宏、无 ActiveX、无嵌入对象的 Word CFB。
 * 它不负责转换；调用方只有在本函数返回后才能把同一 Buffer 交给隔离的
 * LibreOffice 转换器。
 */
export function inspectSafeLegacyDocV1(content: Buffer): SafeLegacyDocV1 {
  if (content.byteLength > LEGACY_DOC_SAFETY_MAX_FILE_BYTES_V1) {
    throw new LegacyDocSafetyErrorV1("INPUT_TOO_LARGE");
  }
  if (
    content.byteLength < CFB_MAGIC.byteLength ||
    !content.subarray(0, 8).equals(CFB_MAGIC)
  ) {
    throw new LegacyDocSafetyErrorV1("INVALID_CFB");
  }

  let container: CFB.CFB$Container;
  try {
    container = CFB.parse(content, { type: "buffer", raw: false });
  } catch {
    throw new LegacyDocSafetyErrorV1("INVALID_CFB");
  }

  if (
    container.FullPaths.length === 0 ||
    container.FullPaths.length !== container.FileIndex.length ||
    container.FullPaths.length > LEGACY_DOC_SAFETY_MAX_ENTRIES_V1
  ) {
    throw new LegacyDocSafetyErrorV1("STRUCTURE_LIMIT_EXCEEDED");
  }

  let expandedBytes = 0;
  let streamCount = 0;
  let wordDocument: CFB.CFB$Entry | null = null;
  let tableStream: "0Table" | "1Table" | null = null;

  for (let index = 0; index < container.FileIndex.length; index += 1) {
    const entry = container.FileIndex[index];
    const fullPath = container.FullPaths[index];
    if (!fullPath || fullPath.includes("\u0000")) {
      throw new LegacyDocSafetyErrorV1("ABNORMAL_STRUCTURE");
    }
    const name = normalizedCfbName(fullPath);
    if (isEncryptionEntry(name)) throw new LegacyDocSafetyErrorV1("ENCRYPTED");
    if (isVbaEntry(name)) throw new LegacyDocSafetyErrorV1("VBA");
    if (isActiveXEntry(name)) throw new LegacyDocSafetyErrorV1("ACTIVEX");
    if (isEmbeddedObjectEntry(name))
      throw new LegacyDocSafetyErrorV1("EMBEDDED_OBJECT");

    if (entry.type !== CFB_ENTRY_TYPE_STREAM) continue;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new LegacyDocSafetyErrorV1("ABNORMAL_STRUCTURE");
    }
    streamCount += 1;
    expandedBytes += entry.size;
    if (expandedBytes > LEGACY_DOC_SAFETY_MAX_EXPANDED_BYTES_V1) {
      throw new LegacyDocSafetyErrorV1("STRUCTURE_LIMIT_EXCEEDED");
    }

    const leaf = name.split("/").at(-1);
    if (leaf === "worddocument") wordDocument = entry;
    if (leaf === "0table" || leaf === "1table")
      tableStream = leaf === "0table" ? "0Table" : "1Table";
  }

  if (!wordDocument || !tableStream)
    throw new LegacyDocSafetyErrorV1("NOT_WORD_DOC");
  const fib = entryContent(wordDocument);
  if (fib.byteLength < 12 || fib.readUInt16LE(0) !== WORD_FIB_IDENT) {
    throw new LegacyDocSafetyErrorV1("NOT_WORD_DOC");
  }
  const flags = fib.readUInt16LE(10);
  if (
    (flags & WORD_FIB_ENCRYPTED) !== 0 ||
    (flags & WORD_FIB_OBFUSCATED) !== 0
  ) {
    throw new LegacyDocSafetyErrorV1("ENCRYPTED");
  }

  return {
    format: "DOC",
    byteLength: content.byteLength,
    entryCount: container.FileIndex.length,
    streamCount,
    expandedBytes,
    tableStream,
    fibVersion: fib.readUInt16LE(2),
  };
}
