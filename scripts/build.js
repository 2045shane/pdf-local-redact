import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

await build({
  entryPoints: ["src/ui/main.js"],
  bundle: true,
  format: "esm",
  outfile: "extension/app.js",
  target: "es2022",
  legalComments: "none",
});

cpSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "extension/pdf.worker.min.mjs");
rmSync("extension/cmaps", { recursive: true, force: true });
rmSync("extension/standard_fonts", { recursive: true, force: true });
cpSync("node_modules/pdfjs-dist/cmaps", "extension/cmaps", { recursive: true });
cpSync("node_modules/pdfjs-dist/standard_fonts", "extension/standard_fonts", { recursive: true });
