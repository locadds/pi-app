import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WordConversionErrorV1,
  WordPrivateConverterV1,
} from "./work-word-private-converter";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<{ root: string; scriptPath: string; powershellPath: string; privateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "xiaogui-word-converter-test-"));
  temporaryRoots.push(root);
  const scriptPath = join(root, "convert-doc.ps1");
  const powershellPath = join(root, "powershell.exe");
  await writeFile(scriptPath, "# test script");
  await writeFile(powershellPath, "test executable");
  return { root, scriptPath, powershellPath, privateRoot: join(root, "private") };
}

describe("WordPrivateConverterV1", () => {
  it("converts only DOC through the private PowerShell seam, then cleans the session", async () => {
    const fixture = await fixtureRoot();
    const calls: Array<{ executable: string; args: readonly string[]; signal?: AbortSignal }> = [];
    const converter = new WordPrivateConverterV1({
      ...fixture,
      processRunner: async (executable, args, options) => {
        calls.push({ executable, args, signal: options.signal });
        const sessionRoot = args[args.indexOf("-SessionRoot") + 1];
        if (args.at(-1) === "Convert") {
          await writeFile(join(sessionRoot, "converted.docx"), "converted-by-word");
        }
        return { exitCode: 0, stderr: "" };
      },
    });

    const result = await converter.convert(Buffer.from("legacy-doc"), "DOC", "DOCX");

    expect(result.content.toString()).toBe("converted-by-word");
    expect(result.format).toBe("DOCX");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ executable: fixture.powershellPath });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.scriptPath,
      "-Operation", "Convert",
    ]));
    expect(calls[1].args).toEqual(expect.arrayContaining(["-Operation", "Cleanup"]));
    expect(calls[1].signal).toBeUndefined();
    expect(await readdir(fixture.privateRoot)).toEqual([]);
  });

  it("reports unavailable when the fixed PowerShell script is absent", async () => {
    const fixture = await fixtureRoot();
    await rm(fixture.scriptPath);
    const converter = new WordPrivateConverterV1({ ...fixture });

    await expect(converter.convert(Buffer.from("doc"), "DOC", "DOCX")).rejects.toMatchObject({
      code: "WORD_UNAVAILABLE",
    } satisfies Partial<WordConversionErrorV1>);
  });

  it.each([
    ["non-zero process", async () => ({ exitCode: 1, stderr: "failed" }), "WORD_FAILED"],
    ["missing output", async () => ({ exitCode: 0, stderr: "" }), "WORD_OUTPUT_MISSING"],
  ])("reports %s without treating LibreOffice as a fallback", async (_name, convertResult, expectedCode) => {
    const fixture = await fixtureRoot();
    const converter = new WordPrivateConverterV1({
      ...fixture,
      processRunner: async (_executable, args) =>
        args.at(-1) === "Cleanup" ? { exitCode: 0, stderr: "" } : convertResult(),
    });

    await expect(converter.convert(Buffer.from("doc"), "DOC", "DOCX")).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it("maps the script's allowlisted unavailable result without exposing stderr", async () => {
    const fixture = await fixtureRoot();
    const converter = new WordPrivateConverterV1({
      ...fixture,
      processRunner: async (_executable, args) => {
        const sessionRoot = args[args.indexOf("-SessionRoot") + 1];
        if (args.at(-1) === "Convert") {
          await writeFile(join(sessionRoot, "result.json"), '{"code":"WORD_UNAVAILABLE"}');
          return { exitCode: 1, stderr: "C:\\private\\details" };
        }
        return { exitCode: 0, stderr: "" };
      },
    });

    await expect(converter.convert(Buffer.from("doc"), "DOC", "DOCX")).rejects.toMatchObject({
      code: "WORD_UNAVAILABLE",
    });
  });

  it.each(["ABORTED", "TIMEOUT"])("cleans the owned Word session after %s", async (reason) => {
    const fixture = await fixtureRoot();
    let cleanupCalls = 0;
    const controller = new AbortController();
    const converter = new WordPrivateConverterV1({
      ...fixture,
      processRunner: async (_executable, args) => {
        if (args.at(-1) === "Cleanup") {
          cleanupCalls += 1;
          return { exitCode: 0, stderr: "" };
        }
        if (reason === "ABORTED") controller.abort();
        throw new Error(reason);
      },
    });

    await expect(converter.convert(Buffer.from("doc"), "DOC", "DOCX", controller.signal)).rejects.toMatchObject({
      code: reason === "ABORTED" ? "WORD_ABORTED" : "WORD_TIMEOUT",
    });
    expect(cleanupCalls).toBe(1);
    expect(await readdir(fixture.privateRoot)).toEqual([]);
  });

  it("does not return converted output once the caller cancelled during a successful helper run", async () => {
    const fixture = await fixtureRoot();
    const controller = new AbortController();
    const converter = new WordPrivateConverterV1({
      ...fixture,
      processRunner: async (_executable, args) => {
        const sessionRoot = args[args.indexOf("-SessionRoot") + 1];
        if (args.at(-1) === "Convert") {
          await writeFile(join(sessionRoot, "converted.docx"), "not-returned");
          controller.abort();
        }
        return { exitCode: 0, stderr: "" };
      },
    });

    await expect(converter.convert(Buffer.from("doc"), "DOC", "DOCX", controller.signal)).rejects.toMatchObject({
      code: "WORD_ABORTED",
    });
  });

  it("keeps the owned session evidence when cleanup fails", async () => {
    const fixture = await fixtureRoot();
    let sessionRoot = "";
    const converter = new WordPrivateConverterV1({
      ...fixture,
      processRunner: async (_executable, args) => {
        sessionRoot = args[args.indexOf("-SessionRoot") + 1];
        if (args.at(-1) === "Convert") {
          await writeFile(join(sessionRoot, "converted.docx"), "converted-by-word");
          return { exitCode: 0, stderr: "" };
        }
        return { exitCode: 1, stderr: "cleanup failed" };
      },
    });

    await expect(converter.convert(Buffer.from("doc"), "DOC", "DOCX")).rejects.toMatchObject({
      code: "WORD_FAILED",
    });
    expect(await readdir(sessionRoot)).toEqual(expect.arrayContaining(["source.doc", "converted.docx"]));
  });
});
