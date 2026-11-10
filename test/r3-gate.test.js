import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { PRO_CHECKOUT_ENABLED, PRO_LOCKED_MESSAGE } from "../src/config.js";
import { redactPdf, RedactionError } from "../src/redact.js";

test("R3 checkout flag stays off and locked export produces no file", async () => {
  assert.equal(PRO_CHECKOUT_ENABLED, false);
  const doc = await PDFDocument.create();
  doc.addPage().drawText("NO_EXPORT", {
    x: 72,
    y: 700,
    size: 18,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  const bytes = await doc.save();
  await assert.rejects(
    redactPdf(bytes, {
      unlocked: false,
      regions: [{ pageIndex: 0, x: 70, y: 690, width: 200, height: 30 }],
    }),
    (error) => {
      assert.ok(error instanceof RedactionError);
      assert.equal(error.code, "LOCKED");
      assert.match(error.message, /专业版（即将上线）/);
      assert.match(error.message, /未生成文件/);
      return true;
    },
  );
});

test("R3 source has the CTA and no payment provider", () => {
  const files = sourceFiles();
  const joined = files.map((file) => file.text).join("\n");
  assert.match(joined, /有问题请联系我/);
  assert.match(joined, /珊哥爱读书/);
  assert.match(joined, new RegExp(PRO_LOCKED_MESSAGE));
  assert.doesNotMatch(joined, /creem|dodo|stripe|lemonsqueezy|paypal|gumroad/i);
  assert.doesNotMatch(readFileSync(new URL("../src/unlock.js", import.meta.url), "utf8"), /123456|password123|qwerty|letmein|admin123/);
});

function sourceFiles() {
  const roots = ["src", "extension"];
  const out = [];
  for (const root of roots) {
    walk(root, out);
  }
  return out;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "cmaps" || entry.name === "standard_fonts") continue;
    if (entry.name === "app.js" || entry.name.startsWith("pdf.worker")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(js|html|css|json|md)$/.test(entry.name)) {
      out.push({ path, text: readFileSync(path, "utf8") });
    }
  }
}
