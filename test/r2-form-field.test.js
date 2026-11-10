import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
} from "@cantoo/pdf-lib";
import { redactPdf } from "../src/redact.js";
import { assertPdfHealthy, pdfToText, uncompressedPdf } from "./helpers.js";

async function formFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("QA_KEEP_VISIBLE", { x: 72, y: 740, size: 16, font });
  page.drawText("QA_PAGE_SECRET", { x: 72, y: 674, size: 16, font });
  const context = doc.context;
  const appearance = context.flateStream(new TextEncoder().encode("BT (QA_FIELD_SECRET) Tj ET\n"), {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, 200, 40],
  });
  const appearanceRef = context.register(appearance);
  const widget = context.obj({
    Type: "Annot",
    Subtype: "Widget",
    Rect: [72, 352, 400, 392],
    F: 4,
    AP: context.obj({ N: appearanceRef }),
  });
  const widgetRef = context.register(widget);
  const field = context.obj({
    FT: "Tx",
    T: PDFString.of("secret_field"),
    V: PDFString.of("QA_FIELD_SECRET"),
    DV: PDFString.of("QA_FIELD_SECRET"),
    Kids: [widgetRef],
  });
  const fieldRef = context.register(field);
  widget.set(PDFName.of("Parent"), fieldRef);
  const noteAppearance = context.flateStream(new TextEncoder().encode("BT (QA_ANNOT_SECRET) Tj ET\n"));
  const note = context.obj({
    Type: "Annot",
    Subtype: "FreeText",
    Rect: [72, 442, 400, 492],
    Contents: PDFString.of("QA_ANNOT_SECRET"),
    AP: context.obj({ N: context.register(noteAppearance) }),
  });
  const keepWidget = context.obj({
    Type: "Annot",
    Subtype: "Widget",
    Rect: [72, 100, 280, 130],
    F: 4,
  });
  const keepWidgetRef = context.register(keepWidget);
  const keepField = context.obj({
    FT: "Tx",
    T: PDFString.of("keep_field"),
    V: PDFString.of("QA_KEEP_FIELD"),
    DA: PDFString.of("/Helv 12 Tf 0 g"),
    Kids: [keepWidgetRef],
  });
  const keepFieldRef = context.register(keepField);
  keepWidget.set(PDFName.of("Parent"), keepFieldRef);
  page.node.set(PDFName.of("Annots"), context.obj([widgetRef, context.register(note), keepWidgetRef]));
  doc.catalog.set(
    PDFName.of("AcroForm"),
    context.obj({ Fields: [fieldRef, keepFieldRef] }),
  );
  return doc.save({ useObjectStreams: false });
}

const regions = [
  { pageIndex: 0, x: 71, y: 666.3000030517578, width: 217.15997314453125, height: 25.259994506835938 },
  { pageIndex: 0, x: 71, y: 441, width: 330, height: 52 },
  { pageIndex: 0, x: 71, y: 351, width: 330, height: 42 },
];

test("R2 intersecting AcroForm fields are removed without breaking the file", async () => {
  const input = await formFixture();
  const out = await redactPdf(input, { unlocked: true, regions });
  const text = pdfToText(out);
  assert.match(text, /QA_KEEP_VISIBLE/);
  assert.doesNotMatch(text, /QA_PAGE_SECRET/);
  assert.doesNotMatch(text, /QA_ANNOT_SECRET/);
  assert.doesNotMatch(text, /QA_FIELD_SECRET/);
  const flat = uncompressedPdf(out);
  for (const secret of ["QA_FIELD_SECRET", "secret_field", "QA_ANNOT_SECRET"]) {
    assert.equal(Buffer.from(out).includes(Buffer.from(secret)), false, secret);
    assert.equal(flat.includes(Buffer.from(secret)), false, `decompressed ${secret}`);
  }
  assert.equal(flat.includes(Buffer.from("QA_KEEP_FIELD")), true);
  assertPdfHealthy(out);
  const reloaded = await PDFDocument.load(out);
  const acro = reloaded.catalog.lookup(PDFName.of("AcroForm"));
  const fields = acro.lookup(PDFName.of("Fields"));
  assert.equal(fields.size(), 1);
  assert.equal(fields.lookup(0).lookup(PDFName.of("T")).decodeText(), "keep_field");
});
