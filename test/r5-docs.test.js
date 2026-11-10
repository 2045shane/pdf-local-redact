import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("R5 README and FEATURE_MAP name the cut, deletion, password, stub, and licenses", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const map = readFileSync(new URL("../FEATURE_MAP.md", import.meta.url), "utf8");
  const licenses = readFileSync(new URL("../THIRD_PARTY_LICENSES.md", import.meta.url), "utf8");
  for (const text of [readme, map]) {
    assert.match(text, /PDF-LOCAL-REDACT-CUT-2026-11-10-v1/);
    assert.match(text, /已知密码/);
    assert.match(text, /PRO_CHECKOUT_ENABLED/);
    assert.match(text, /有问题请联系我/);
    assert.match(text, /珊哥爱读书/);
    assert.match(text, /pdftotext/);
    assert.match(text, /npm test/);
  }
  assert.match(map, /真删除|删除底层|内容流/);
  assert.match(licenses, /Apache License/);
  assert.match(licenses, /MIT License/);
  assert.match(licenses, /pdf\.js|pdfjs/);
  assert.match(licenses, /pdf-lib/);
});
