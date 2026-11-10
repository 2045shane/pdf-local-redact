import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { unlockPdf, UnlockError } from "../src/unlock.js";
import { pdfInfo, pdfToText } from "./helpers.js";

async function encryptedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("UNLOCK_ME_TOKEN", { x: 72, y: 700, size: 24, font });
  doc.encrypt({ userPassword: "known-password", ownerPassword: "owner-password" });
  return doc.save({ rewrite: true, useObjectStreams: false });
}

test("R1 correct known password writes a passwordless PDF", async () => {
  const locked = await encryptedPdf();
  const opened = await unlockPdf(locked, "known-password");
  assert.equal(opened instanceof Uint8Array, true);
  const info = pdfInfo(opened);
  assert.match(info, /Encrypted:\s+no/);
  assert.match(pdfToText(opened), /UNLOCK_ME_TOKEN/);
  const again = await PDFDocument.load(opened);
  assert.equal(again.isEncrypted, false);
  const text = again
    .getPages()[0]
    .extractContents()
    .filter((asset) => asset.kind === "text")
    .map((asset) => asset.getText())
    .join("");
  assert.match(text, /UNLOCK_ME_TOKEN/);
});

test("R1 wrong password produces no file", async () => {
  const locked = await encryptedPdf();
  await assert.rejects(unlockPdf(locked, "not-the-password"), (error) => {
    assert.ok(error instanceof UnlockError);
    assert.equal(error.code, "WRONG_PASSWORD");
    assert.match(error.message, /密码不正确/);
    assert.match(error.message, /Wrong password/);
    assert.match(error.message, /未生成文件/);
    return true;
  });
});

test("R1 empty password is not tried", async () => {
  const locked = await encryptedPdf();
  await assert.rejects(unlockPdf(locked, ""), (error) => {
    assert.equal(error.code, "EMPTY_PASSWORD");
    assert.match(error.message, /请输入打开密码/);
    assert.match(error.message, /Enter the open password/);
    return true;
  });
});

test("R1 unencrypted file is not rewritten as a cracked file", async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText("PLAIN", { x: 72, y: 700, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  const bytes = await doc.save();
  await assert.rejects(unlockPdf(bytes, "anything"), (error) => {
    assert.equal(error.code, "NOT_ENCRYPTED");
    return true;
  });
});
