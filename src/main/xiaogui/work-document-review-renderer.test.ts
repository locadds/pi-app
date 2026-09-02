import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import JSZip from "jszip";
import * as CFB from "cfb";
import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentReviewRendererV1,
  LibreOfficePrivateConverterV1,
  type LibreOfficeConverterV1,
} from "./work-document-review-renderer";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

async function createSafeDocxFromBody(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function createSafeDocx(text = "姓名：张三"): Promise<Buffer> {
  return createSafeDocxFromBody(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`);
}

function neverConvert(): LibreOfficeConverterV1 {
  return {
    async convert() {
      throw new Error("DOCX render path must not call LibreOffice");
    },
  };
}

function createLegacyDoc(): Buffer {
  const container = CFB.utils.cfb_new();
  const fib = Buffer.alloc(32);
  fib.writeUInt16LE(0xa5ec, 0);
  fib.writeUInt16LE(0x00c1, 2);
  CFB.utils.cfb_add(container, "WordDocument", fib);
  CFB.utils.cfb_add(container, "1Table", Buffer.alloc(16));
  return Buffer.from(CFB.write(container, { type: "buffer", fileType: "cfb" }));
}

describe("DocumentReviewRendererV1", () => {
  it("serves a safe DOCX through an opaque document token without converting to PDF", async () => {
    const renderer = new DocumentReviewRendererV1({ converter: neverConvert() });
    const result = await renderer.prepare(await createSafeDocx(), "DOCX", undefined, [
      {
        targetId: "xgt_1",
        kind: "TEXT",
        preview: "姓名：张三",
        sourceAnchor: { part: "BODY", sectionIndex: 1, paragraphIndex: 1 },
      },
    ]);

    expect(result.render.mode).toBe("DOCX_HTML");
    expect(result.render.documentToken).toBeTruthy();
    expect(result.render.approximatePageCount).toBe(1);
    expect(result.projections[0]).toMatchObject({
      targetId: "xgt_1",
      status: "PROJECTED",
      textSelectionAllowed: true,
    });

    const asset = renderer.readDocumentAssetByToken(result.render.documentToken!);
    const projected = await JSZip.loadAsync(Buffer.from(asset.docxBytes));
    const xml = await projected.file("word/document.xml")!.async("string");
    expect(xml).toContain(result.projections[0].startBookmark!);
    expect(xml).toContain(result.projections[0].endBookmark!);
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("source.docx");

    expect(renderer.release(result.manifestId)).toBe(true);
    expect(() =>
      renderer.readDocumentAssetByToken(result.render.documentToken!),
    ).toThrow("TEMPLATE_REVIEW_DOCUMENT_TOKEN_INVALID");
  });

  it("projects a reliably indexed inline image for in-document highlighting", async () => {
    const renderer = new DocumentReviewRendererV1({ converter: neverConvert() });
    const content = await createSafeDocxFromBody(
      '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    );
    const result = await renderer.prepare(content, "DOCX", undefined, [
      {
        targetId: "xgt_image",
        kind: "IMAGE",
        preview: "图片或图件 1",
        sourceAnchor: { part: "DRAWING", drawingIndex: 1 },
      },
    ]);

    expect(result.render.mode).toBe("DOCX_HTML");
    expect(result.projections[0]).toMatchObject({
      targetId: "xgt_image",
      status: "PROJECTED",
      textSelectionAllowed: false,
      objectSelectionAllowed: true,
    });
    const asset = renderer.readDocumentAssetByToken(result.render.documentToken!);
    const projected = await JSZip.loadAsync(Buffer.from(asset.docxBytes));
    const xml = await projected.file("word/document.xml")!.async("string");
    expect(xml.indexOf(result.projections[0].startBookmark!)).toBeLessThan(xml.indexOf("<w:drawing>"));
    expect(xml.indexOf(result.projections[0].endBookmark!)).toBeGreaterThan(xml.indexOf("</w:drawing>"));
  });

  it("keeps floating drawings in the explicit manual list", async () => {
    const renderer = new DocumentReviewRendererV1({ converter: neverConvert() });
    const content = await createSafeDocxFromBody(
      '<w:p><w:r><w:drawing><wp:anchor><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>',
    );
    const result = await renderer.prepare(content, "DOCX", undefined, [
      {
        targetId: "xgt_floating",
        kind: "IMAGE",
        preview: "浮动图件 1",
        sourceAnchor: { part: "DRAWING", drawingIndex: 1 },
      },
    ]);

    expect(result.projections[0]).toMatchObject({
      targetId: "xgt_floating",
      status: "UNMAPPED",
      warningCode: "TARGET_OBJECT_UNSUPPORTED",
    });
  });

  it("keeps paragraph anchors aligned when a drawing paragraph contains a text box", async () => {
    const renderer = new DocumentReviewRendererV1({ converter: neverConvert() });
    const content = await createSafeDocxFromBody([
      '<w:p><w:r><w:object><w:txbxContent><w:p><w:r><w:t>浮动文字</w:t></w:r></w:p></w:txbxContent></w:object></w:r></w:p>',
      '<w:p><w:r><w:t>正文第一段</w:t></w:r></w:p>',
    ].join(""));
    const result = await renderer.prepare(content, "DOCX", undefined, [
      {
        targetId: "xgt_body_1",
        kind: "TEXT",
        preview: "正文第一段",
        sourceAnchor: { part: "BODY", sectionIndex: 1, paragraphIndex: 1 },
      },
      {
        targetId: "xgt_text_box",
        kind: "TEXT",
        preview: "浮动文字",
        sourceAnchor: { part: "TEXT_BOX", drawingIndex: 1 },
      },
    ]);

    expect(result.projections).toEqual([
      expect.objectContaining({
        targetId: "xgt_body_1",
        status: "PROJECTED",
      }),
      expect.objectContaining({
        targetId: "xgt_text_box",
        status: "UNMAPPED",
        warningCode: "TARGET_OBJECT_UNSUPPORTED",
      }),
    ]);
  });

  it("reuses one safe legacy DOC conversion across review and materialization prepares", async () => {
    const convertedDocx = await createSafeDocx("旧版文档正文");
    let conversionCount = 0;
    const renderer = new DocumentReviewRendererV1({
      converter: {
        async convert() {
          conversionCount += 1;
          return { content: convertedDocx, format: "DOCX", elapsedMs: 1 };
        },
      },
    });
    const source = createLegacyDoc();

    const first = await renderer.prepare(source, "DOC");
    renderer.release(first.manifestId);
    const second = await renderer.prepare(source, "DOC");

    expect(conversionCount).toBe(1);
    expect(second.render.mode).toBe("DOCX_HTML");
    renderer.close();
  });
});

describe("LibreOfficePrivateConverterV1", () => {
  it("uses an isolated profile/output directory and removes the conversion session", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "xiaogui-lo-test-"));
    temporaryRoots.push(testRoot);
    const executablePath = join(testRoot, "soffice.exe");
    const privateRoot = join(testRoot, "private");
    await writeFile(executablePath, Buffer.from("fake executable"));

    let observedProfile = "";
    const converter = new LibreOfficePrivateConverterV1({
      executablePath,
      privateRoot,
      timeoutMs: 500,
      processRunner: async (_executable, args) => {
        expect(args).toContain("--headless");
        expect(args).toContain("--norestore");
        const profileArgument = args.find((argument) =>
          argument.startsWith("-env:UserInstallation="),
        );
        expect(profileArgument).toBeTruthy();
        observedProfile = profileArgument ?? "";
        const outputFlagIndex = args.indexOf("--outdir");
        const outputRoot = args[outputFlagIndex + 1];
        const sourcePath = args.at(-1)!;
        const outputName = `${basename(sourcePath, extname(sourcePath))}.docx`;
        await mkdir(outputRoot, { recursive: true });
        await writeFile(
          join(outputRoot, outputName),
          Buffer.from("docx-private"),
        );
        return { exitCode: 0, stderr: "" };
      },
    });

    const result = await converter.convert(Buffer.from("doc"), "DOC", "DOCX");
    expect(result.content.toString()).toBe("docx-private");
    expect(observedProfile).toContain("xiaogui-lo-review-");
    expect(await readdir(privateRoot)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(testRoot);
  });
});
