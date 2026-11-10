import * as pdfjs from "pdfjs-dist";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  CTA_HANDLE,
  CTA_LABEL,
  CTA_URL,
  PRO_LOCKED_MESSAGE,
  PRO_REDACTION_UNLOCKED,
} from "../config.js";
import { redactPdf } from "../redact.js";
import { unlockPdf } from "../unlock.js";

const STUB_KEY = "PRO_REDACTION_UNLOCKED";

function assetUrl(path) {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(path, import.meta.url).href;
}

pdfjs.GlobalWorkerOptions.workerSrc = assetUrl("pdf.worker.min.mjs");

const app = document.querySelector("#app");
const state = {
  name: "",
  bytes: null,
  encrypted: false,
  rects: [],
  unlocked: readStub(),
};

app.innerHTML = `
  <section class="grid">
    <section class="card">
      <div id="drop" class="drop">
        <p>把 PDF 拖到这里，或选择文件</p>
        <div class="row" style="justify-content:center">
          <button id="pick" type="button">选择 PDF</button>
          <input id="file" type="file" accept="application/pdf,.pdf" hidden />
        </div>
        <p id="file-name" class="note"></p>
      </div>
    </section>
    <section class="card" id="password-card" hidden>
      <h2>去密码（免费）</h2>
      <p>只使用你输入的这一次已知打开密码。不会猜测，也不会上传。</p>
      <form id="unlock-form">
        <div class="row">
          <label for="password">打开密码</label>
          <input id="password" type="password" autocomplete="off" />
          <button id="unlock" type="submit">下载无密码副本</button>
        </div>
      </form>
      <p id="password-status" class="note"></p>
    </section>
    <section class="card">
      <h2>涂黑（专业版）</h2>
      <p>在页面上拖拽框选。导出时会删除框内的文字、图片和矢量，再盖上不透明黑块。只盖黑框不算涂黑。</p>
      <div id="pro" class="pro"></div>
      <div class="row">
        <button id="export" type="button">导出涂黑 PDF</button>
        <button id="clear" class="secondary" type="button">清除框选</button>
      </div>
      <p id="redact-status" class="note"></p>
      <details>
        <summary>本地测试解锁（不连接付款）</summary>
        <label class="row">
          <input id="stub" type="checkbox" />
          在这台浏览器打开专业版占位。不会打开结账，也不会上传文件。
        </label>
      </details>
    </section>
    <section class="card">
      <h2>页面</h2>
      <div id="pages" class="pages"></div>
      <p id="empty" class="note">还没有打开 PDF。</p>
    </section>
  </section>
`;

const drop = document.querySelector("#drop");
const fileInput = document.querySelector("#file");
const pro = document.querySelector("#pro");
const stub = document.querySelector("#stub");
stub.checked = state.unlocked;
renderPro();

document.querySelector("#pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("over");
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});
document.querySelector("#unlock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void unlockCurrent();
});
document.querySelector("#export").addEventListener("click", () => void exportRedaction());
document.querySelector("#clear").addEventListener("click", () => {
  state.rects = [];
  drawBoxes();
  setStatus("redact-status", "已清除框选。");
});
stub.addEventListener("change", () => {
  state.unlocked = stub.checked;
  try {
    localStorage.setItem(STUB_KEY, stub.checked ? "1" : "0");
  } catch {
    /* private mode */
  }
  renderPro();
});

function readStub() {
  if (PRO_REDACTION_UNLOCKED) return true;
  try {
    return localStorage.getItem(STUB_KEY) === "1";
  } catch {
    return false;
  }
}

function renderPro() {
  if (state.unlocked) {
    pro.innerHTML = `<p>本地测试解锁已打开。导出时会真删除框内内容。</p>`;
    return;
  }
  pro.innerHTML = `
    <p><strong>${PRO_LOCKED_MESSAGE}</strong></p>
    <p>未解锁时不能导出涂黑件。</p>
    <p><a href="${CTA_URL}" target="_blank" rel="noreferrer">${CTA_LABEL}</a> → 小红书「${CTA_HANDLE}」</p>
  `;
}

async function loadFile(file) {
  setStatus("password-status", "");
  setStatus("redact-status", "");
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.name = file.name || "document.pdf";
  state.bytes = bytes;
  state.rects = [];
  document.querySelector("#file-name").textContent = state.name;
  let encrypted = false;
  try {
    const probe = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    encrypted = probe.isEncrypted;
  } catch (error) {
    setStatus("redact-status", errorMessage(error), true);
    return;
  }
  state.encrypted = encrypted;
  document.querySelector("#password-card").hidden = !encrypted;
  if (encrypted) {
    document.querySelector("#pages").replaceChildren();
    document.querySelector("#empty").hidden = false;
    setStatus("password-status", "这份 PDF 有打开密码。输入已知密码后才会在本地解密。");
    return;
  }
  setStatus("password-status", "这份 PDF 没有打开密码。");
  await renderPages(bytes);
}

async function unlockCurrent() {
  const password = document.querySelector("#password").value;
  try {
    const opened = await unlockPdf(state.bytes, password);
    state.bytes = opened;
    state.encrypted = false;
    download(opened, suffix(state.name, ".unlocked"));
    setStatus("password-status", "已去掉打开密码，并开始下载无密码副本。");
    await renderPages(opened);
  } catch (error) {
    setStatus("password-status", errorMessage(error), true);
  }
}

async function exportRedaction() {
  if (!state.bytes) {
    setStatus("redact-status", "请先选择 PDF。", true);
    return;
  }
  if (state.encrypted) {
    setStatus("redact-status", "请先用已知密码去除打开密码。未生成文件。", true);
    return;
  }
  if (!state.rects.length) {
    setStatus("redact-status", "请先框选要涂黑的区域。未生成文件。", true);
    return;
  }
  if (!state.unlocked) {
    setStatus("redact-status", `${PRO_LOCKED_MESSAGE}。未生成文件。`, true);
    return;
  }
  try {
    const out = await redactPdf(state.bytes, {
      unlocked: true,
      regions: state.rects,
    });
    download(out, suffix(state.name, ".redacted"));
    setStatus("redact-status", "已删除框选区域内的文字、图片和矢量，并盖上黑块。开始下载。");
  } catch (error) {
    setStatus("redact-status", errorMessage(error), true);
  }
}

async function renderPages(bytes) {
  const pages = document.querySelector("#pages");
  pages.replaceChildren();
  document.querySelector("#empty").hidden = true;
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: assetUrl("standard_fonts/"),
    cMapUrl: assetUrl("cmaps/"),
    cMapPacked: true,
    isEvalSupported: false,
  }).promise;
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const viewport = page.getViewport({ scale: 1.25 });
    const wrap = document.createElement("div");
    const title = document.createElement("p");
    title.className = "note";
    title.textContent = `第 ${index} 页 · 拖拽框选`;
    const stage = document.createElement("div");
    stage.className = "page-frame";
    stage.dataset.pageIndex = String(index - 1);
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.__viewport = viewport;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    stage.append(canvas, overlay);
    wrap.append(title, stage);
    pages.append(wrap);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    installDrag(canvas, overlay, viewport, index - 1);
  }
  drawBoxes();
}

function installDrag(canvas, overlay, viewport, pageIndex) {
  let start = null;
  let draft = null;
  canvas.addEventListener("pointerdown", (event) => {
    const point = pointInCanvas(canvas, event);
    start = point;
    draft = document.createElement("div");
    draft.className = "box";
    overlay.append(draft);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic events cannot capture the pointer */
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!start || !draft) return;
    const point = pointInCanvas(canvas, event);
    placeDraft(draft, start, point, canvas);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!start) return;
    const point = pointInCanvas(canvas, event);
    const css = cssRect(start, point);
    start = null;
    draft?.remove();
    draft = null;
    if (css.width < 3 || css.height < 3) return;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const [x1, y1] = viewport.convertToPdfPoint(css.x * scaleX, css.y * scaleY);
    const [x2, y2] = viewport.convertToPdfPoint((css.x + css.width) * scaleX, (css.y + css.height) * scaleY);
    state.rects.push({
      pageIndex,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    });
    drawBoxes();
  });
}

function drawBoxes() {
  document.querySelectorAll(".page-frame").forEach((stage) => {
    const pageIndex = Number(stage.dataset.pageIndex);
    const canvas = stage.querySelector("canvas");
    const overlay = stage.querySelector(".overlay");
    const viewport = canvas.__viewport;
    overlay.replaceChildren();
    if (!viewport) return;
    const scaleX = canvas.clientWidth / canvas.width;
    const scaleY = canvas.clientHeight / canvas.height;
    for (const rect of state.rects.filter((item) => item.pageIndex === pageIndex)) {
      const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y + rect.height);
      const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y);
      const box = document.createElement("div");
      box.className = "box";
      box.style.left = `${Math.min(x1, x2) * scaleX}px`;
      box.style.top = `${Math.min(y1, y2) * scaleY}px`;
      box.style.width = `${Math.abs(x2 - x1) * scaleX}px`;
      box.style.height = `${Math.abs(y2 - y1) * scaleY}px`;
      overlay.append(box);
    }
  });
}

function pointInCanvas(canvas, event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function cssRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function placeDraft(draft, start, point, canvas) {
  const rect = cssRect(start, point);
  const maxW = canvas.clientWidth;
  const maxH = canvas.clientHeight;
  const x = clamp(rect.x, 0, maxW);
  const y = clamp(rect.y, 0, maxH);
  draft.style.left = `${x}px`;
  draft.style.top = `${y}px`;
  draft.style.width = `${Math.max(0, Math.min(rect.x + rect.width, maxW) - x)}px`;
  draft.style.height = `${Math.max(0, Math.min(rect.y + rect.height, maxH) - y)}px`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function suffix(name, extra) {
  return name.replace(/\.pdf$/i, "") + extra + ".pdf";
}

function setStatus(id, message, isError = false) {
  const node = document.querySelector(`#${id}`);
  node.textContent = message;
  node.className = isError ? "error" : "note";
}

function errorMessage(error) {
  return error?.message || "处理失败。未生成文件。";
}
