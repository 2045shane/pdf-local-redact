import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  StandardFonts,
} from "@cantoo/pdf-lib";

const STANDARD = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  "Helvetica-Oblique": StandardFonts.HelveticaOblique,
  "Helvetica-BoldOblique": StandardFonts.HelveticaBoldOblique,
  "Times-Roman": StandardFonts.TimesRoman,
  "Times-Bold": StandardFonts.TimesBold,
  "Times-Italic": StandardFonts.TimesItalic,
  "Times-BoldItalic": StandardFonts.TimesBoldItalic,
  Courier: StandardFonts.Courier,
  "Courier-Bold": StandardFonts.CourierBold,
  "Courier-Oblique": StandardFonts.CourierOblique,
  "Courier-BoldOblique": StandardFonts.CourierBoldOblique,
};

const standardTables = new Map();

export function nameText(obj) {
  if (!obj) return "";
  if (typeof obj.decodeText === "function") return obj.decodeText();
  const text = String(obj);
  return text.startsWith("/") ? text.slice(1) : text;
}

function canonicalBase(name) {
  return String(name || "").replace(/^[A-Z]{6}\+/, "");
}

function readWidthMap(array, first) {
  const map = new Map();
  for (let i = 0; i < array.size(); i += 1) {
    const value = array.lookup(i);
    if (value instanceof PDFNumber) map.set(first + i, value.asNumber());
  }
  return map;
}

function readCidWidths(cidFont) {
  const dwObj = cidFont.lookup(PDFName.of("DW"));
  const dw = dwObj instanceof PDFNumber ? dwObj.asNumber() : 1000;
  const widths = cidFont.lookup(PDFName.of("W"));
  const map = new Map();
  if (widths instanceof PDFArray) {
    let i = 0;
    while (i < widths.size()) {
      const startObj = widths.lookup(i);
      if (!(startObj instanceof PDFNumber)) break;
      const start = startObj.asNumber();
      const next = widths.lookup(i + 1);
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k += 1) {
          const width = next.lookup(k);
          if (width instanceof PDFNumber) map.set(start + k, width.asNumber());
        }
        i += 2;
      } else if (next instanceof PDFNumber) {
        const end = next.asNumber();
        const widthObj = widths.lookup(i + 2);
        const width = widthObj instanceof PDFNumber ? widthObj.asNumber() : dw;
        for (let cid = start; cid <= end; cid += 1) map.set(cid, width);
        i += 3;
      } else break;
    }
  }
  return {
    units(code) {
      return map.has(code) ? map.get(code) : dw;
    },
  };
}

function readSimpleWidths(font) {
  const first = font.lookup(PDFName.of("FirstChar"));
  const widths = font.lookup(PDFName.of("Widths"));
  if (!(first instanceof PDFNumber) || !(widths instanceof PDFArray)) return null;
  const map = readWidthMap(widths, first.asNumber());
  const descriptor = font.lookup(PDFName.of("FontDescriptor"));
  let missing;
  if (descriptor instanceof PDFDict) {
    const mw = descriptor.lookup(PDFName.of("MissingWidth"));
    if (mw instanceof PDFNumber) missing = mw.asNumber();
  }
  return {
    units(code) {
      if (map.has(code)) return map.get(code);
      return missing;
    },
  };
}

function readFontMatrixScale(font) {
  const matrix = font.lookup(PDFName.of("FontMatrix"));
  if (matrix instanceof PDFArray && matrix.size() >= 1) {
    const a = matrix.lookup(0);
    if (a instanceof PDFNumber && a.asNumber() !== 0) return a.asNumber();
  }
  return 0.001;
}

export function describeFont(font) {
  if (!(font instanceof PDFDict)) {
    return { measurable: false, reason: "missing-font" };
  }
  const subtype = nameText(font.lookup(PDFName.of("Subtype")));
  const base = canonicalBase(nameText(font.lookup(PDFName.of("BaseFont"))));
  const scale = readFontMatrixScale(font);
  if (subtype === "Type0") {
    const encoding = font.lookup(PDFName.of("Encoding"));
    const encodingName = encoding instanceof PDFName ? nameText(encoding) : "";
    if (encodingName === "Identity-V") {
      return { measurable: false, reason: "vertical-font", base, subtype };
    }
    if (encodingName !== "Identity-H") {
      return { measurable: false, reason: "custom-cmap", base, subtype };
    }
    const descendants = font.lookup(PDFName.of("DescendantFonts"));
    const cid = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    if (!(cid instanceof PDFDict)) {
      return { measurable: false, reason: "missing-cid", base, subtype };
    }
    return {
      measurable: true,
      bytesPerChar: 2,
      widths: readCidWidths(cid),
      scale: readFontMatrixScale(cid) || scale,
      base,
      subtype,
    };
  }
  const simple = readSimpleWidths(font);
  if (simple) {
    return { measurable: true, bytesPerChar: 1, widths: simple, scale, base, subtype };
  }
  if (STANDARD[base]) {
    return {
      measurable: true,
      bytesPerChar: 1,
      standard: base,
      scale,
      base,
      subtype,
    };
  }
  return { measurable: false, reason: "no-widths", base, subtype, bytesPerChar: 1 };
}

async function standardTable(base) {
  const cached = standardTables.get(base);
  if (cached) return cached;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(STANDARD[base]);
  const decoder = new TextDecoder("windows-1252");
  const table = new Array(256).fill(undefined);
  for (let code = 0; code < 256; code += 1) {
    const ch = decoder.decode(Uint8Array.of(code));
    try {
      table[code] = font.widthOfTextAtSize(ch, 1000);
    } catch {
      table[code] = undefined;
    }
  }
  standardTables.set(base, table);
  return table;
}

export async function glyphWidthUnits(info, code) {
  if (info.widths) {
    const width = info.widths.units(code);
    if (width !== undefined) return width;
  }
  if (info.standard) {
    const table = await standardTable(info.standard);
    if (table[code] !== undefined) return table[code];
  }
  return undefined;
}
