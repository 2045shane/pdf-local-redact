import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from "@cantoo/pdf-lib";
import { PRO_CHECKOUT_ENABLED } from "./config.js";
import { parseContentStream, serializeContentStream, stringBytes } from "./content-stream.js";
import { describeFont, glyphWidthUnits, nameText } from "./fonts.js";
import {
  IDENTITY,
  apply,
  bboxOfPoints,
  hitsAny,
  intersects,
  invert,
  isIdentity,
  multiply,
  normalizeRect,
  unitSquareBox,
} from "./geometry.js";

export class RedactionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RedactionError";
    this.code = code;
  }
}

const VISIBLE_PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);
const PAINT = new Set([...VISIBLE_PAINT, "n"]);
const PATH = new Set(["m", "l", "c", "v", "y", "h", "re"]);

/**
 * Delete text, vectors, and image samples that intersect `regions`, then paint
 * an opaque black rectangle. Returns no bytes when redaction cannot be done
 * safely — it does not fall back to a black overlay.
 */
export async function redactPdf(bytes, options) {
  if (PRO_CHECKOUT_ENABLED) {
    throw new RedactionError("没有付款路径。", "CHECKOUT_DISABLED");
  }
  if (!options?.unlocked) {
    throw new RedactionError("专业版（即将上线）。未生成文件。", "LOCKED");
  }
  const regions = (options.regions || [])
    .map((region) => ({ ...normalizeRect(region), pageIndex: region.pageIndex }))
    .filter((region) => region.width > 0 && region.height > 0 && region.pageIndex >= 0);
  if (!regions.length) {
    throw new RedactionError("请先框选要涂黑的区域。未生成文件。", "NO_REGION");
  }

  const source = toBytes(bytes);
  let doc;
  try {
    doc = await PDFDocument.load(source, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError || /encrypt/i.test(String(error?.message))) {
      throw new RedactionError("请先用已知密码去除打开密码，再涂黑。未生成文件。", "ENCRYPTED");
    }
    throw new RedactionError("无法读取这份 PDF。未生成文件。", "UNREADABLE");
  }

  const pages = doc.getPages();
  const byPage = new Map();
  for (const region of regions) {
    if (region.pageIndex >= pages.length) {
      throw new RedactionError("框选落在不存在的页面上。未生成文件。", "BAD_PAGE");
    }
    const list = byPage.get(region.pageIndex) || [];
    list.push(region);
    byPage.set(region.pageIndex, list);
  }

  const useCounts = countContentUses(doc);
  for (const [pageIndex, rects] of byPage) {
    await redactPage(pages[pageIndex], rects, useCounts);
  }

  return doc.save({
    rewrite: true,
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new RedactionError("无法读取这份 PDF。未生成文件。", "UNREADABLE");
}

function contentRefs(page) {
  const entry = page.node.get(PDFName.of("Contents"));
  const context = page.doc.context;
  if (entry instanceof PDFRef) {
    const looked = context.lookup(entry);
    if (looked instanceof PDFArray) return refsIn(looked);
    return [entry];
  }
  if (entry instanceof PDFArray) return refsIn(entry);
  return [];
}

function refsIn(array) {
  const refs = [];
  for (let i = 0; i < array.size(); i += 1) {
    const item = array.get(i);
    if (item instanceof PDFRef) refs.push(item);
  }
  return refs;
}

function countContentUses(doc) {
  const counts = new Map();
  for (const page of doc.getPages()) {
    for (const ref of contentRefs(page)) {
      const key = ref.toString();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function decodeStream(stream) {
  if (!(stream instanceof PDFRawStream)) {
    throw new RedactionError("无法读取内容流，已停止导出。", "UNREADABLE_STREAM");
  }
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    throw new RedactionError("内容流解压失败，已停止导出，没有只盖黑框。", "UNREADABLE_STREAM");
  }
}

function concatStreams(doc, refs) {
  const parts = refs.map((ref) => decodeStream(doc.context.lookup(ref)));
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const out = new Uint8Array(Math.max(total, 1));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
    out[offset++] = 10;
  }
  return out.subarray(0, offset || 0);
}

function writePlain(stream, bytes) {
  stream.updateContents(bytes);
  stream.dict.delete(PDFName.of("Filter"));
  stream.dict.delete(PDFName.of("DecodeParms"));
  stream.dict.delete(PDFName.of("DL"));
}

async function redactPage(page, rects, useCounts) {
  const doc = page.doc;
  const refs = contentRefs(page);
  const decoded = refs.length ? concatStreams(doc, refs) : new Uint8Array();
  const resources = page.node.Resources();
  const rewritten = await rewriteOps(decoded, resources, IDENTITY, rects, doc, 0);
  const finalOps = scrubMarkedContent(rewritten.ops).concat(blackBoxes(rewritten.ctm, rects));
  const bytes = serializeContentStream(finalOps);
  const stream = PDFRawStream.of(doc.context.obj({}), bytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of("Contents"), ref);
  const shared = refs.some((old) => (useCounts.get(old.toString()) || 0) > 1);
  if (!shared) {
    for (const old of refs) doc.context.delete(old);
  }
  removeAnnots(page, rects);
}

function blackBoxes(ctm, rects) {
  const inv = isIdentity(ctm) ? IDENTITY : invert(ctm);
  if (!inv) {
    throw new RedactionError("页面变换无法还原，已停止导出。", "CTM");
  }
  const ops = [{ name: "q", args: [] }];
  if (!isIdentity(inv)) ops.push({ name: "cm", args: [...inv] });
  ops.push({ name: "rg", args: [0, 0, 0] });
  for (const rect of rects) {
    ops.push({ name: "re", args: [rect.x, rect.y, rect.width, rect.height] });
    ops.push({ name: "f", args: [] });
  }
  ops.push({ name: "Q", args: [] });
  return ops;
}

function scrubMarkedContent(ops) {
  return ops.map((op) => {
    if (op.name !== "BDC" && op.name !== "DP") return op;
    return {
      ...op,
      args: op.args.map((arg) => {
        if (arg?.type !== "dict") return arg;
        const entries = { ...arg.entries };
        delete entries.ActualText;
        delete entries.Alt;
        delete entries.E;
        return { type: "dict", entries };
      }),
    };
  });
}

function removeAnnots(page, rects) {
  const annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) return;
  const context = page.doc.context;
  for (let i = annots.size() - 1; i >= 0; i -= 1) {
    const item = annots.get(i);
    const annot = context.lookup(item);
    if (!(annot instanceof PDFDict)) continue;
    const rect = annotRect(annot);
    if (!rect || !hitsAny(rect, rects)) continue;
    annots.remove(i);
    wipeValue(context, annot.get(PDFName.of("AP")));
    if (item instanceof PDFRef) context.delete(item);
  }
}

function annotRect(annot) {
  const rect = annot.lookup(PDFName.of("Rect"));
  if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
  const n = (index) => {
    const value = rect.lookup(index);
    return value instanceof PDFNumber ? value.asNumber() : 0;
  };
  const x1 = n(0);
  const y1 = n(1);
  const x2 = n(2);
  const y2 = n(3);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function wipeValue(context, value) {
  if (value instanceof PDFRef) {
    const resolved = context.lookup(value);
    context.delete(value);
    if (resolved instanceof PDFDict || resolved instanceof PDFRawStream) {
      const dict = resolved instanceof PDFRawStream ? resolved.dict : resolved;
      for (const [, child] of dict.entries()) wipeValue(context, child);
    }
    return;
  }
  if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i += 1) wipeValue(context, value.get(i));
  }
}

function freshText() {
  return {
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScale: 100,
    leading: 0,
    rise: 0,
    fontName: null,
    fontSize: 0,
    matrix: IDENTITY.slice(),
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
  };
}

function cloneText(text) {
  return { ...text, matrix: text.matrix.slice() };
}

async function rewriteOps(bytes, resources, ctm, rects, doc, depth) {
  if (depth > 6) {
    throw new RedactionError("内容流嵌套过深，已停止导出。", "NESTING");
  }
  const ops = bytes?.length ? parseContentStream(bytes) : [];
  const state = { ctm: ctm.slice(), text: freshText() };
  const stack = [];
  const out = [];
  const fontCache = new Map();
  let pathOps = [];
  let pathPoints = [];
  let clipFlag = false;
  let currentPoint = null;
  let subpathStart = null;

  const flushLoosePath = () => {
    if (!pathOps.length) return;
    out.push(...pathOps);
    pathOps = [];
    pathPoints = [];
    clipFlag = false;
  };

  for (const op of ops) {
    if (op.name === "BI") {
      flushLoosePath();
      const box = unitSquareBox(state.ctm);
      if (!hitsAny(box, rects)) out.push(op);
      continue;
    }
    if (op.name === "q") {
      flushLoosePath();
      stack.push({ ctm: state.ctm.slice(), text: cloneText(state.text) });
      out.push(op);
      continue;
    }
    if (op.name === "Q") {
      flushLoosePath();
      const prev = stack.pop();
      if (prev) {
        state.ctm = prev.ctm;
        state.text = prev.text;
      }
      out.push(op);
      continue;
    }
    if (op.name === "cm") {
      flushLoosePath();
      state.ctm = multiply(state.ctm, op.args.slice(0, 6));
      out.push(op);
      continue;
    }
    if (PATH.has(op.name)) {
      pathOps.push(op);
      addPath(op, state, () => currentPoint, (point) => {
        currentPoint = point;
      }, (point) => {
        subpathStart = point;
      }, () => subpathStart, pathPoints);
      continue;
    }
    if (op.name === "W" || op.name === "W*") {
      pathOps.push(op);
      clipFlag = true;
      continue;
    }
    if (PAINT.has(op.name)) {
      const box = bboxOfPoints(pathPoints);
      const visible = VISIBLE_PAINT.has(op.name);
      if (visible && hitsAny(box, rects)) {
        if (clipFlag) out.push(...pathOps, { name: "n", args: [] });
      } else {
        out.push(...pathOps, op);
      }
      pathOps = [];
      pathPoints = [];
      clipFlag = false;
      continue;
    }

    flushLoosePath();
    if (op.name === "BT") {
      state.text.matrix = IDENTITY.slice();
      state.text.x = 0;
      state.text.y = 0;
      state.text.lineX = 0;
      state.text.lineY = 0;
      out.push(op);
      continue;
    }
    if (op.name === "ET") {
      out.push(op);
      continue;
    }
    if (op.name === "Tc") {
      state.text.charSpacing = op.args[0] || 0;
      out.push(op);
      continue;
    }
    if (op.name === "Tw") {
      state.text.wordSpacing = op.args[0] || 0;
      out.push(op);
      continue;
    }
    if (op.name === "Tz") {
      state.text.horizontalScale = op.args[0] || 100;
      out.push(op);
      continue;
    }
    if (op.name === "TL") {
      state.text.leading = op.args[0] || 0;
      out.push(op);
      continue;
    }
    if (op.name === "Tr") {
      out.push(op);
      continue;
    }
    if (op.name === "Ts") {
      state.text.rise = op.args[0] || 0;
      out.push(op);
      continue;
    }
    if (op.name === "Tf") {
      state.text.fontName = op.args[0]?.value || null;
      state.text.fontSize = Math.abs(Number(op.args[1]) || 0);
      out.push(op);
      continue;
    }
    if (op.name === "Tm") {
      state.text.matrix = op.args.slice(0, 6).map(Number);
      state.text.x = 0;
      state.text.y = 0;
      state.text.lineX = 0;
      state.text.lineY = 0;
      out.push(op);
      continue;
    }
    if (op.name === "Td") {
      moveText(state, op.args[0] || 0, op.args[1] || 0);
      out.push(op);
      continue;
    }
    if (op.name === "TD") {
      state.text.leading = -(op.args[1] || 0);
      moveText(state, op.args[0] || 0, op.args[1] || 0);
      out.push(op);
      continue;
    }
    if (op.name === "T*") {
      moveText(state, 0, -state.text.leading);
      out.push(op);
      continue;
    }
    if (op.name === "Tj" || op.name === "TJ" || op.name === "'" || op.name === '"') {
      const emitted = await rewriteShow(op, state, rects, resources, fontCache);
      out.push(...emitted);
      continue;
    }
    if (op.name === "Do") {
      const name = op.args[0]?.value;
      const replacement = await rewriteXObject(name, state.ctm, rects, resources, doc, depth);
      out.push(replacement || op);
      continue;
    }
    if (op.name === "sh") {
      throw new RedactionError(
        "遇到渐变（sh），无法确认区域内的矢量已被删除。已停止导出。",
        "SHADING",
      );
    }
    out.push(op);
  }
  flushLoosePath();
  return { ops: out, ctm: state.ctm, bytes: serializeContentStream(out) };
}

function moveText(state, tx, ty) {
  state.text.lineX += tx;
  state.text.lineY += ty;
  state.text.x = state.text.lineX;
  state.text.y = state.text.lineY;
}

function addPath(op, state, getCurrent, setCurrent, setStart, getStart, points) {
  const mark = (x, y) => {
    points.push(apply(state.ctm, x, y));
    setCurrent([x, y]);
  };
  if (op.name === "m") {
    mark(op.args[0], op.args[1]);
    setStart([op.args[0], op.args[1]]);
    return;
  }
  if (op.name === "l") {
    mark(op.args[0], op.args[1]);
    return;
  }
  if (op.name === "c") {
    mark(op.args[0], op.args[1]);
    mark(op.args[2], op.args[3]);
    mark(op.args[4], op.args[5]);
    return;
  }
  if (op.name === "v") {
    const current = getCurrent() || [0, 0];
    mark(current[0], current[1]);
    mark(op.args[0], op.args[1]);
    mark(op.args[2], op.args[3]);
    return;
  }
  if (op.name === "y") {
    mark(op.args[0], op.args[1]);
    mark(op.args[2], op.args[3]);
    mark(op.args[2], op.args[3]);
    return;
  }
  if (op.name === "h") {
    const start = getStart();
    if (start) setCurrent(start);
    return;
  }
  if (op.name === "re") {
    const [x, y, w, h] = op.args;
    mark(x, y);
    mark(x + w, y);
    mark(x + w, y + h);
    mark(x, y + h);
    setStart([x, y]);
    setCurrent([x, y]);
  }
}

function textToPage(state, tx, ty) {
  const [ux, uy] = apply(state.text.matrix, tx, ty);
  return apply(state.ctm, ux, uy);
}

async function fontInfo(resources, fontName, cache) {
  if (!fontName) {
    throw new RedactionError(
      "文字没有字体，无法确认位置。已停止导出。",
      "UNMEASURABLE_FONT",
    );
  }
  if (cache.has(fontName)) return cache.get(fontName);
  const fonts = resources?.lookup?.(PDFName.of("Font"));
  const font = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(fontName)) : null;
  const info = describeFont(font);
  cache.set(fontName, info);
  return info;
}

async function rewriteShow(op, state, rects, resources, fontCache) {
  if (op.name === '"') {
    state.text.wordSpacing = Number(op.args[0]) || 0;
    state.text.charSpacing = Number(op.args[1]) || 0;
  }
  if (op.name === "'" || op.name === '"') {
    moveText(state, 0, -state.text.leading);
  }
  const info = await fontInfo(resources, state.text.fontName, fontCache);
  if (!info.measurable) {
    throw new RedactionError(
      "无法安全涂黑：有字体缺少宽度，继续导出可能会只盖住文字。已停止，没有生成文件。",
      "UNMEASURABLE_FONT",
    );
  }
  const pieces = [];
  let changed = false;
  if (op.name === "TJ") {
    const array = Array.isArray(op.args[0]) ? op.args[0] : [];
    for (const item of array) {
      if (typeof item === "number") {
        const h = state.text.horizontalScale / 100;
        state.text.x += (-item * state.text.fontSize) / 1000 * h;
        pieces.push(item);
      } else {
        const part = await layoutBytes(stringBytes(item) || new Uint8Array(), info, state, rects);
        pieces.push(...part.items);
        changed = changed || part.changed;
      }
    }
  } else {
    const raw = stringBytes(op.args[op.name === '"' ? 2 : 0]) || new Uint8Array();
    const part = await layoutBytes(raw, info, state, rects);
    pieces.push(...part.items);
    changed = part.changed;
  }
  if (!changed) return [op];
  const emitted = [];
  if (op.name === '"') {
    emitted.push({ name: "Tw", args: [op.args[0]] });
    emitted.push({ name: "Tc", args: [op.args[1]] });
  }
  if (op.name === "'" || op.name === '"') emitted.push({ name: "T*", args: [] });
  emitted.push({ name: "TJ", args: [pieces] });
  return emitted;
}

async function layoutBytes(bytes, info, state, rects) {
  const width = info.bytesPerChar || 1;
  if (bytes.length % width !== 0) {
    throw new RedactionError(
      "无法安全涂黑：文字编码无法按字符切开。已停止，没有生成文件。",
      "UNMEASURABLE_FONT",
    );
  }
  const h = state.text.horizontalScale / 100 || 0;
  const items = [];
  let chunk = [];
  let removed = 0;
  let changed = false;
  const flushChunk = () => {
    if (!chunk.length) return;
    items.push({ type: "string", encoding: "hex", bytes: Uint8Array.from(chunk) });
    chunk = [];
  };
  const flushRemoved = () => {
    if (!removed) return;
    const size = state.text.fontSize || 1;
    items.push((-removed * 1000) / (size * (h || 1)));
    removed = 0;
  };
  for (let i = 0; i < bytes.length; i += width) {
    let code = 0;
    const raw = [];
    for (let k = 0; k < width; k += 1) {
      raw.push(bytes[i + k]);
      code = (code << 8) | bytes[i + k];
    }
    const units = await glyphWidthUnits(info, code);
    if (units === undefined) {
      throw new RedactionError(
        "无法安全涂黑：有字符缺少宽度，继续导出可能会只盖住文字。已停止，没有生成文件。",
        "UNMEASURABLE_FONT",
      );
    }
    const visual = units * state.text.fontSize * (info.scale || 0.001) * (h || 1);
    const spacing = (code === 32 ? state.text.wordSpacing : 0) + state.text.charSpacing;
    const advance = (units * state.text.fontSize * (info.scale || 0.001) + spacing) * (h || 1);
    const y = state.text.y + state.text.rise;
    const box = bboxOfPoints([
      textToPage(state, state.text.x, y - state.text.fontSize * 0.3),
      textToPage(state, state.text.x + visual, y - state.text.fontSize * 0.3),
      textToPage(state, state.text.x + visual, y + state.text.fontSize),
      textToPage(state, state.text.x, y + state.text.fontSize),
    ]);
    if (hitsAny(box, rects)) {
      flushChunk();
      removed += advance;
      changed = true;
    } else {
      flushRemoved();
      chunk.push(...raw);
    }
    state.text.x += advance;
  }
  flushChunk();
  flushRemoved();
  return { changed, items };
}

async function rewriteXObject(name, ctm, rects, resources, doc, depth) {
  if (!name) return null;
  const xobjects = resources?.lookup?.(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return null;
  const stream = xobjects.lookup(PDFName.of(name));
  if (!(stream instanceof PDFRawStream)) return null;
  const box = unitSquareBox(ctm);
  if (!hitsAny(box, rects)) return null;
  const subtype = nameText(stream.dict.lookup(PDFName.of("Subtype")));
  if (subtype === "Image") {
    if (!editImage(stream, ctm, rects, doc.context)) blankImage(stream, doc.context);
    return null;
  }
  if (subtype === "Form") {
    const matrixObj = stream.dict.lookup(PDFName.of("Matrix"));
    const matrix = readMatrix(matrixObj) || IDENTITY;
    const formResources = stream.dict.lookup(PDFName.of("Resources"));
    const nested = formResources instanceof PDFDict ? formResources : resources;
    const inner = await rewriteOps(
      decodeStream(stream),
      nested,
      multiply(ctm, matrix),
      rects,
      doc,
      depth + 1,
    );
    writePlain(stream, serializeContentStream(scrubMarkedContent(inner.ops)));
    return null;
  }
  throw new RedactionError("遇到无法删除的绘制对象，已停止导出。", "XOBJECT");
}

function readMatrix(value) {
  if (!(value instanceof PDFArray) || value.size() < 6) return null;
  const nums = [];
  for (let i = 0; i < 6; i += 1) {
    const n = value.lookup(i);
    if (!(n instanceof PDFNumber)) return null;
    nums.push(n.asNumber());
  }
  return nums;
}

function filterNames(dict) {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return [nameText(filter)];
  if (filter instanceof PDFArray) {
    const names = [];
    for (let i = 0; i < filter.size(); i += 1) {
      const item = filter.lookup(i);
      if (item instanceof PDFName) names.push(nameText(item));
    }
    return names;
  }
  return [];
}

function editImage(stream, ctm, rects, context) {
  const filters = filterNames(stream.dict);
  if (filters.length !== 1 || filters[0] !== "FlateDecode") return false;
  const bpc = stream.dict.lookup(PDFName.of("BitsPerComponent"));
  if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) return false;
  const channels = channelsFor(stream.dict.lookup(PDFName.of("ColorSpace")));
  if (!channels) return false;
  const widthObj = stream.dict.lookup(PDFName.of("Width"));
  const heightObj = stream.dict.lookup(PDFName.of("Height"));
  if (!(widthObj instanceof PDFNumber) || !(heightObj instanceof PDFNumber)) return false;
  const width = widthObj.asNumber();
  const height = heightObj.asNumber();
  const predictor = predictorOf(stream.dict);
  if (predictor !== 1 && (predictor < 10 || predictor > 15)) return false;
  let pixels;
  try {
    const decoded = decodePDFRawStream(stream).decode();
    pixels = predictor === 1 ? decoded : unfilterPng(decoded, width, height, channels);
  } catch {
    return false;
  }
  if (!pixels || pixels.length < width * height * channels) return false;
  const inv = invert(ctm);
  if (!inv) return false;
  const imageBox = unitSquareBox(ctm);
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const rect of rects) {
    if (!intersects(imageBox, rect)) continue;
    for (const [px, py] of [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x + rect.width, rect.y + rect.height],
      [rect.x, rect.y + rect.height],
    ]) {
      const [ux, uy] = apply(inv, px, py);
      const col = ux * width;
      const row = (1 - uy) * height;
      minC = Math.min(minC, col);
      maxC = Math.max(maxC, col);
      minR = Math.min(minR, row);
      maxR = Math.max(maxR, row);
    }
  }
  if (!Number.isFinite(minC)) return true;
  const c0 = clamp(Math.floor(minC + 1e-4), 0, width);
  const c1 = clamp(Math.ceil(maxC - 1e-4), 0, width);
  const r0 = clamp(Math.floor(minR + 1e-4), 0, height);
  const r1 = clamp(Math.ceil(maxR - 1e-4), 0, height);
  for (let row = r0; row < r1; row += 1) {
    for (let col = c0; col < c1; col += 1) {
      const index = (row * width + col) * channels;
      for (let channel = 0; channel < channels; channel += 1) pixels[index + channel] = 0;
    }
  }
  const wrapped = context.flateStream(pixels);
  stream.updateContents(wrapped.getContents());
  stream.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  stream.dict.delete(PDFName.of("DecodeParms"));
  return true;
}

function channelsFor(color) {
  if (color instanceof PDFName) {
    const name = nameText(color);
    if (name === "DeviceGray") return 1;
    if (name === "DeviceRGB") return 3;
    if (name === "DeviceCMYK") return 4;
  }
  return 0;
}

function predictorOf(dict) {
  const parms = dict.lookup(PDFName.of("DecodeParms"));
  if (!(parms instanceof PDFDict)) return 1;
  const predictor = parms.lookup(PDFName.of("Predictor"));
  return predictor instanceof PDFNumber ? predictor.asNumber() : 1;
}

function unfilterPng(data, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let pos = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    if (pos >= data.length) return null;
    const filter = data[pos++];
    if (pos + stride > data.length) return null;
    const row = data.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? cur[i - channels] : 0;
      const up = prev[i];
      const ul = i >= channels ? prev[i - channels] : 0;
      const x = row[i];
      if (filter === 0) cur[i] = x;
      else if (filter === 1) cur[i] = (x + left) & 255;
      else if (filter === 2) cur[i] = (x + up) & 255;
      else if (filter === 3) cur[i] = (x + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) cur[i] = (x + paeth(left, up, ul)) & 255;
      else return null;
    }
    prev = cur;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function blankImage(stream, context) {
  const smask = stream.dict.get(PDFName.of("SMask"));
  const wrapped = context.flateStream(new Uint8Array([0, 0, 0]));
  stream.updateContents(wrapped.getContents());
  stream.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  stream.dict.delete(PDFName.of("DecodeParms"));
  stream.dict.set(PDFName.of("Width"), PDFNumber.of(1));
  stream.dict.set(PDFName.of("Height"), PDFNumber.of(1));
  stream.dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
  stream.dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  stream.dict.delete(PDFName.of("SMask"));
  if (smask instanceof PDFRef) {
    const mask = context.lookup(smask);
    if (mask instanceof PDFRawStream) {
      const gray = context.flateStream(new Uint8Array([0]));
      mask.updateContents(gray.getContents());
      mask.dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
      mask.dict.delete(PDFName.of("DecodeParms"));
      mask.dict.set(PDFName.of("Width"), PDFNumber.of(1));
      mask.dict.set(PDFName.of("Height"), PDFNumber.of(1));
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
