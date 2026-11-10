import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from "@cantoo/pdf-lib";
import { redactPdf } from "../src/redact.js";
import { assertPdfHealthy, pngRgb } from "./helpers.js";

test("R2 ICCBased RGB Flate images are erased only inside the region", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const width = 8;
  const height = 4;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      if (x < 4) rgb.set([255, 0, 0], index);
      else rgb.set([0, 0, 255], index);
    }
  }
  const image = await doc.embedPng(pngRgb(width, height, rgb));
  page.drawImage(image, { x: 100, y: 100, width: 80, height: 40 });
  const loaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
  const xobjects = loaded.getPages()[0].node.Resources().lookup(PDFName.of("XObject"));
  const imageStream = loaded.context.lookup(xobjects.entries()[0][1]);
  const profile = loaded.context.register(
    loaded.context.flateStream(new Uint8Array([0, 1, 2, 3]), { N: 3, Alternate: "DeviceRGB" }),
  );
  imageStream.dict.set(PDFName.of("ColorSpace"), loaded.context.obj(["ICCBased", profile]));
  const input = await loaded.save({ rewrite: true, useObjectStreams: false });

  const out = await redactPdf(input, {
    unlocked: true,
    regions: [{ pageIndex: 0, x: 100, y: 100, width: 40, height: 40 }],
  });
  assertPdfHealthy(out);

  const saved = await PDFDocument.load(out);
  const savedXObjects = saved.getPages()[0].node.Resources().lookup(PDFName.of("XObject"));
  const savedImage = [...savedXObjects.entries()]
    .map(([, ref]) => saved.context.lookup(ref))
    .find((stream) => stream instanceof PDFRawStream && stream.dict.lookup(PDFName.of("Subtype"))?.decodeText?.() === "Image");
  const savedWidth = savedImage.dict.lookup(PDFName.of("Width"));
  const savedHeight = savedImage.dict.lookup(PDFName.of("Height"));
  assert.ok(savedWidth instanceof PDFNumber && savedHeight instanceof PDFNumber);
  assert.equal(savedWidth.asNumber(), width);
  assert.equal(savedHeight.asNumber(), height);
  assert.equal(savedImage.dict.lookup(PDFName.of("ColorSpace")).lookup(0).decodeText(), "ICCBased");
  const pixels = decodePDFRawStream(savedImage).decode();
  assert.equal(pixels.length, width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const sample = [pixels[index], pixels[index + 1], pixels[index + 2]];
      if (x < 4) assert.deepEqual(sample, [0, 0, 0]);
      else assert.deepEqual(sample, [0, 0, 255]);
    }
  }
});
