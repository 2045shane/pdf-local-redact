import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from "@cantoo/pdf-lib";
import { redactPdf } from "../src/redact.js";
import { decodedContent, makeSamplePdf, pdfToText } from "./helpers.js";

test("R2 true redaction removes text from pdftotext and the content stream", async () => {
  const sample = await makeSamplePdf();
  const out = await redactPdf(sample.bytes, {
    unlocked: true,
    regions: [sample.regions.secret, sample.regions.partial],
  });
  const text = pdfToText(out);
  assert.doesNotMatch(text, /SECRET_TOKEN_ALPHA/);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /KEEP_TOKEN_BETA/);
  assert.match(text, /AAAA_/);
  assert.match(text, /BBBB/);

  const stream = await decodedContent(out);
  assert.equal(stream.toLowerCase().includes(Buffer.from("SECRET_TOKEN_ALPHA").toString("hex")), false);
  assert.equal(stream.toLowerCase().includes(Buffer.from("SECRET").toString("hex")), false);
  assert.equal(stream.includes("SECRET_TOKEN_ALPHA"), false);
  assert.equal(Buffer.from(out).includes(Buffer.from("SECRET_TOKEN_ALPHA")), false);

  const reloaded = await PDFDocument.load(out);
  const extracted = reloaded
    .getPages()[0]
    .extractContents()
    .filter((asset) => asset.kind === "text")
    .map((asset) => asset.getText())
    .join("\n");
  assert.doesNotMatch(extracted, /SECRET/);
  assert.match(extracted, /KEEP_TOKEN_BETA/);
  assert.match(extracted, /AAAA_/);
  assert.match(extracted, /BBBB/);
});

test("R2 overlay-only still leaks text to pdftotext", async () => {
  const sample = await makeSamplePdf();
  const doc = await PDFDocument.load(sample.bytes);
  const region = sample.regions.secret;
  doc.getPages()[0].drawRectangle({
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    color: rgb(0, 0, 0),
  });
  const overlay = await doc.save({ useObjectStreams: false });
  assert.match(pdfToText(overlay), /SECRET_TOKEN_ALPHA/);
});

test("R2 vectors inside the region are removed and vectors outside remain", async () => {
  const sample = await makeSamplePdf();
  const out = await redactPdf(sample.bytes, {
    unlocked: true,
    regions: [sample.regions.vector],
  });
  const stream = await decodedContent(out);
  assert.equal(stream.includes("40 0 l"), false);
  assert.match(stream, /0 1 0 rg/);
  assert.match(pdfToText(out), /SECRET_TOKEN_ALPHA/);
  assert.match(pdfToText(out), /KEEP_TOKEN_BETA/);
});

test("R2 image samples inside the region are erased and the other half remains", async () => {
  const sample = await makeSamplePdf();
  const out = await redactPdf(sample.bytes, {
    unlocked: true,
    regions: [sample.regions.imageLeft],
  });
  const doc = await PDFDocument.load(out);
  const xobjects = doc.getPages()[0].node.Resources().lookup(PDFName.of("XObject"));
  const pixels = [];
  for (const [, value] of xobjects.entries()) {
    const stream = doc.context.lookup(value);
    if (!(stream instanceof PDFRawStream)) continue;
    if (stream.dict.lookup(PDFName.of("Subtype"))?.decodeText?.() !== "Image") continue;
    const width = stream.dict.lookup(PDFName.of("Width"));
    const height = stream.dict.lookup(PDFName.of("Height"));
    assert.ok(width instanceof PDFNumber && height instanceof PDFNumber);
    const decoded = decodePDFRawStream(stream).decode();
    pixels.push({ width: width.asNumber(), height: height.asNumber(), decoded });
  }
  assert.equal(pixels.length, 1);
  const image = pixels[0];
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual(Array.from(image.decoded.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(image.decoded.slice(3, 6)), [0, 0, 255]);
  assert.match(pdfToText(out), /KEEP_TOKEN_BETA/);
});

test("R2 text inside a form XObject is deleted", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("FORM_SECRET", { x: 0, y: 0, size: 18, font });
  const saved = await doc.save({ useObjectStreams: false });
  const loaded = await PDFDocument.load(saved);
  const loadedPage = loaded.getPages()[0];
  const context = loaded.context;
  const contentsRef = loadedPage.node.get(PDFName.of("Contents"));
  const source = context.lookup(contentsRef);
  const chunks = [];
  const collect = (obj) => {
    if (obj instanceof PDFRawStream) chunks.push(decodePDFRawStream(obj).decode());
    else {
      for (let i = 0; i < obj.size(); i += 1) collect(context.lookup(obj.get(i)));
    }
  };
  collect(source);
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
    merged[offset++] = 10;
  }
  const form = PDFRawStream.of(context.obj({}), merged);
  form.dict.set(PDFName.of("Type"), PDFName.of("XObject"));
  form.dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
  form.dict.set(PDFName.of("BBox"), context.obj([0, 0, 300, 40]));
  form.dict.set(PDFName.of("Resources"), loadedPage.node.get(PDFName.of("Resources")));
  const formRef = context.register(form);
  let xobjects = loadedPage.node.Resources().lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) {
    xobjects = context.obj({});
    loadedPage.node.Resources().set(PDFName.of("XObject"), xobjects);
  }
  xobjects.set(PDFName.of("Fm0"), formRef);
  const wrapper = PDFRawStream.of(
    context.obj({}),
    new TextEncoder().encode("q\n1 0 0 1 80 640 cm\n/Fm0 Do\nQ\n"),
  );
  loadedPage.node.set(PDFName.of("Contents"), context.register(wrapper));
  const forget = (entry) => {
    if (!entry || typeof entry.objectNumber !== "number") return;
    const looked = context.lookup(entry);
    context.delete(entry);
    if (looked?.size) {
      for (let i = 0; i < looked.size(); i += 1) forget(looked.get(i));
    }
  };
  forget(contentsRef);
  const bytes = await loaded.save({ rewrite: true, useObjectStreams: false });
  assert.match(pdfToText(bytes), /FORM_SECRET/);
  const out = await redactPdf(bytes, {
    unlocked: true,
    regions: [{ pageIndex: 0, x: 70, y: 630, width: 220, height: 40 }],
  });
  assert.doesNotMatch(pdfToText(out), /FORM_SECRET/);
  assert.equal(Buffer.from(out).includes(Buffer.from("FORM_SECRET")), false);
});

test("R2 a margin box does not destroy text outside it", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("ONLY_OUTSIDE", { x: 72, y: 700, size: 18, font });
  const bytes = await doc.save();
  const out = await redactPdf(bytes, {
    unlocked: true,
    regions: [{ pageIndex: 0, x: 10, y: 10, width: 20, height: 20 }],
  });
  assert.match(pdfToText(out), /ONLY_OUTSIDE/);
});
