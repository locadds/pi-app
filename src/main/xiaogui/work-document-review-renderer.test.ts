import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentReviewRendererV1,
  LibreOfficeConversionErrorV1,
  LibreOfficePrivateConverterV1,
  type LibreOfficeConverterV1,
  type PdfManifestBuilderV1,
} from "./work-document-review-renderer";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

async function createSafeDocx(text = "姓名：张三"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const mappedPdf: PdfManifestBuilderV1 = async () => [
  {
    pageNumber: 1,
    widthPoints: 595,
    heightPoints: 842,
    text: "姓名：张三",
    textSpans: [
      {
        text: "姓名：",
        startUtf16: 0,
        endUtf16Exclusive: 3,
        region: { pageNumber: 1, x: 10, y: 20, width: 30, height: 12 },
      },
      {
        text: "张三",
        startUtf16: 3,
        endUtf16Exclusive: 5,
        region: { pageNumber: 1, x: 40, y: 20, width: 20, height: 12 },
      },
    ],
  },
];

function fakePdfConverter(
  pdf = Buffer.from("%PDF-xiaogui"),
): LibreOfficeConverterV1 {
  return {
    async convert(_content, _inputFormat, target) {
      if (target !== "PDF") throw new Error("unexpected conversion target");
      return { content: pdf, format: "PDF", elapsedMs: 1 };
    },
  };
}

describe("DocumentReviewRendererV1", () => {
  it("creates opaque page tokens and keeps the PDF/text mapping in main-private state", async () => {
    const renderer = new DocumentReviewRendererV1({
      converter: fakePdfConverter(),
      pdfManifestBuilder: mappedPdf,
    });
    const result = await renderer.prepare(await createSafeDocx(), "DOCX");

    expect(result.render).toMatchObject({
      mode: "PDF",
      pageCount: 1,
      warnings: [],
    });
    expect(result.render.pages[0]).toMatchObject({
      pageNumber: 1,
      widthPoints: 595,
      heightPoints: 842,
      textLayerAvailable: true,
    });
    expect(result.render.pages[0].pageToken).not.toContain("\\");
    expect(result.render.pages[0].pageToken).not.toContain("/");

    const asset = renderer.readPageAsset(
      result.manifestId,
      result.render.pages[0].pageToken,
    );
    expect(Buffer.from(asset.pdfBytes).toString()).toBe("%PDF-xiaogui");
    expect(asset.text).toBe("姓名：张三");
    expect(renderer.locateExactText(result.manifestId, "张三")).toEqual([
      { pageNumber: 1, x: 40, y: 20, width: 20, height: 12 },
    ]);
    expect(renderer.countExactTextOccurrences(result.manifestId, "张三")).toBe(1);
    expect(JSON.stringify(result)).not.toContain("source.docx");

    expect(renderer.release(result.manifestId)).toBe(true);
    expect(() =>
      renderer.readPageAsset(
        result.manifestId,
        result.render.pages[0].pageToken,
      ),
    ).toThrow("TEMPLATE_REVIEW_PAGE_TOKEN_INVALID");
  });

  it("returns an explicit structured fallback when LibreOffice is unavailable", async () => {
    const renderer = new DocumentReviewRendererV1({
      converter: {
        async convert() {
          throw new LibreOfficeConversionErrorV1("LIBREOFFICE_UNAVAILABLE");
        },
      },
      pdfManifestBuilder: mappedPdf,
    });
    const result = await renderer.prepare(await createSafeDocx(), "DOCX");

    expect(result.render.mode).toBe("STRUCTURED_FALLBACK");
    expect(result.normalizedDocxAvailable).toBe(true);
    expect(result.render.pages).toEqual([]);
    expect(result.render.warnings.map((warning) => warning.code)).toEqual([
      "LIBREOFFICE_UNAVAILABLE",
      "STRUCTURED_FALLBACK_ACTIVE",
    ]);
    expect(renderer.readNormalizedDocx(result.manifestId)).not.toBeNull();
  });

  it("counts repeated page text so callers can reject ambiguous highlights", async () => {
    const renderer = new DocumentReviewRendererV1({
      converter: fakePdfConverter(),
      pdfManifestBuilder: async () => [{
        pageNumber: 1,
        widthPoints: 595,
        heightPoints: 842,
        text: "项目名称 项目名称",
        textSpans: [],
      }],
    });
    const result = await renderer.prepare(await createSafeDocx(), "DOCX");

    expect(renderer.countExactTextOccurrences(result.manifestId, "项目名称")).toBe(2);
    expect(renderer.release(result.manifestId)).toBe(true);
  });

  it("falls back instead of publishing partial pages when PDF text mapping fails", async () => {
    const renderer = new DocumentReviewRendererV1({
      converter: fakePdfConverter(),
      pdfManifestBuilder: async () => {
        throw new Error("mapping failed");
      },
    });
    const result = await renderer.prepare(await createSafeDocx(), "DOCX");
    expect(result.render.mode).toBe("STRUCTURED_FALLBACK");
    expect(result.render.warnings[0].code).toBe("PDF_TEXT_MAPPING_FAILED");
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
        const outputName = `${basename(sourcePath, extname(sourcePath))}.pdf`;
        await mkdir(outputRoot, { recursive: true });
        await writeFile(
          join(outputRoot, outputName),
          Buffer.from("%PDF-private"),
        );
        return { exitCode: 0, stderr: "" };
      },
    });

    const result = await converter.convert(Buffer.from("docx"), "DOCX", "PDF");
    expect(result.content.toString()).toBe("%PDF-private");
    expect(observedProfile).toContain("xiaogui-lo-review-");
    expect(await readdir(privateRoot)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(testRoot);
  });
});
