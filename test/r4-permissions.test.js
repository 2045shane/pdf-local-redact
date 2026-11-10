import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("R4 manifest has no host access and product code does not upload", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const dumped = JSON.stringify(manifest);
  assert.equal(manifest.manifest_version, 3);
  assert.doesNotMatch(dumped, /all_urls|<all_urls>/);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.permissions, undefined);

  const files = [
    "src/ui/main.js",
    "src/redact.js",
    "src/unlock.js",
    "src/config.js",
    "extension/background.js",
    "extension/index.html",
  ];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /all_urls|<all_urls>/);
    assert.doesNotMatch(text, /\bfetch\s*\(/);
    assert.doesNotMatch(text, /XMLHttpRequest|WebSocket|sendBeacon/);
  }
});
