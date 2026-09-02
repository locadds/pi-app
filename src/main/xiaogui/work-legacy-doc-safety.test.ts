import { describe, expect, it } from "vitest";
import * as CFB from "cfb";

import {
  LegacyDocSafetyErrorV1,
  inspectSafeLegacyDocV1,
} from "./work-legacy-doc-safety";

function createLegacyDoc(options?: {
  flags?: number;
  extraEntry?: { name: string; content?: Buffer };
}): Buffer {
  const container = CFB.utils.cfb_new();
  const fib = Buffer.alloc(32);
  fib.writeUInt16LE(0xa5ec, 0);
  fib.writeUInt16LE(0x00c1, 2);
  fib.writeUInt16LE(options?.flags ?? 0, 10);
  CFB.utils.cfb_add(container, "WordDocument", fib);
  CFB.utils.cfb_add(container, "1Table", Buffer.alloc(16));
  if (options?.extraEntry) {
    CFB.utils.cfb_add(
      container,
      options.extraEntry.name,
      options.extraEntry.content ?? Buffer.alloc(4),
    );
  }
  return Buffer.from(CFB.write(container, { type: "buffer", fileType: "cfb" }));
}

function expectSafetyCode(
  content: Buffer,
  code: LegacyDocSafetyErrorV1["code"],
): void {
  try {
    inspectSafeLegacyDocV1(content);
    throw new Error("expected safety gate to reject input");
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyDocSafetyErrorV1);
    expect((error as LegacyDocSafetyErrorV1).code).toBe(code);
  }
}

describe("inspectSafeLegacyDocV1", () => {
  it("accepts a minimal unencrypted Word CFB without active content", () => {
    expect(inspectSafeLegacyDocV1(createLegacyDoc())).toMatchObject({
      format: "DOC",
      tableStream: "1Table",
      fibVersion: 0x00c1,
    });
  });

  it("rejects encrypted and obfuscated Word FIB flags", () => {
    expectSafetyCode(createLegacyDoc({ flags: 0x0100 }), "ENCRYPTED");
    expectSafetyCode(createLegacyDoc({ flags: 0x8000 }), "ENCRYPTED");
  });

  it.each([
    ["VBA/dir", "VBA"],
    ["ActiveX/ocxname", "ACTIVEX"],
    ["ObjectPool/item-1", "EMBEDDED_OBJECT"],
    ["EncryptionInfo", "ENCRYPTED"],
  ] as const)("rejects forbidden CFB entry %s", (name, code) => {
    expectSafetyCode(createLegacyDoc({ extraEntry: { name } }), code);
  });

  it("rejects arbitrary CFB containers that are not Word documents", () => {
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(container, "Workbook", Buffer.alloc(32));
    expectSafetyCode(
      Buffer.from(CFB.write(container, { type: "buffer", fileType: "cfb" })),
      "NOT_WORD_DOC",
    );
  });
});
