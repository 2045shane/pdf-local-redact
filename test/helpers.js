import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from "@cantoo/pdf-lib";

export function pdfToText(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "pdf-redact-"));
  const file = join(dir, "in.pdf");
  writeFileSync(file, bytes);
  try {
    return execFileSync("pdftotext", [file, "-"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function pdfInfo(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "pdf-redact-"));
  const file = join(dir, "in.pdf");
  writeFileSync(file, bytes);
  try {
    return execFileSync("pdfinfo", [file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function pngRgb(width, height, rgbBytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    rgbBytes.copy(raw, row + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

export async function decodedContent(bytes) {
  const doc = await PDFDocument.load(bytes);
  const parts = [];
  for (const page of doc.getPages()) {
    const entry = page.node.get(PDFName.of("Contents"));
    const streams = [];
    const looked = doc.context.lookup(entry);
    if (looked instanceof PDFRawStream) streams.push(looked);
    else if (looked?.size) {
      for (let i = 0; i < looked.size(); i += 1) streams.push(doc.context.lookup(looked.get(i)));
    }
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) {
        parts.push(Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"));
      }
    }
    const resources = page.node.Resources();
    const xobjects = resources?.lookup(PDFName.of("XObject"));
    if (xobjects?.entries) {
      for (const [, value] of xobjects.entries()) {
        const obj = doc.context.lookup(value);
        if (obj instanceof PDFRawStream) {
          const subtype = obj.dict.lookup(PDFName.of("Subtype"))?.decodeText?.();
          if (subtype === "Form") {
            parts.push(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"));
          }
        }
      }
    }
  }
  return parts.join("\n");
}

export async function makeSamplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  const size = 20;
  page.drawText("SECRET_TOKEN_ALPHA", { x: 72, y: 700, size, font, color: rgb(0, 0, 0) });
  page.drawText("KEEP_TOKEN_BETA", { x: 72, y: 80, size, font, color: rgb(0, 0, 0) });
  const partial = "AAAA_SECRET_BBBB";
  const partialSize = 18;
  const partialX = 72;
  const partialY = 500;
  page.drawText(partial, { x: partialX, y: partialY, size: partialSize, font });
  const prefixW = font.widthOfTextAtSize("AAAA_", partialSize);
  const secretW = font.widthOfTextAtSize("SECRET", partialSize);
  page.drawRectangle({ x: 320, y: 400, width: 40, height: 18, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 320, y: 200, width: 30, height: 12, color: rgb(0, 1, 0) });
  const png = pngRgb(2, 1, Buffer.from([255, 0, 0, 0, 0, 255]));
  const image = await doc.embedPng(png);
  page.drawImage(image, { x: 72, y: 250, width: 80, height: 40 });
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return {
    bytes,
    font,
    regions: {
      secret: { pageIndex: 0, x: 70, y: 696, width: 280, height: 28 },
      partial: {
        pageIndex: 0,
        x: partialX + prefixW + 0.4,
        y: partialY - 2,
        width: Math.max(1, secretW - 0.8),
        height: partialSize + 4,
      },
      vector: { pageIndex: 0, x: 318, y: 398, width: 44, height: 22 },
      imageLeft: { pageIndex: 0, x: 72, y: 250, width: 40, height: 40 },
    },
  };
}

export function readSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}
