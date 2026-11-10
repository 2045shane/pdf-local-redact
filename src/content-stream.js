const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

function isDigit(byte) {
  return byte >= 0x30 && byte <= 0x39;
}

/**
 * Tokenize a decoded content stream into operators.
 * Inline images are kept as `{ name: "BI", raw }` so they can be dropped or copied.
 */
export function parseContentStream(bytes) {
  const parser = new Parser(bytes);
  return parser.parse();
}

class Parser {
  constructor(bytes) {
    this.bytes = bytes;
    this.i = 0;
  }

  parse() {
    const ops = [];
    let args = [];
    while (!this.done()) {
      this.skipWsAndComments();
      if (this.done()) break;
      const byte = this.peek();
      if (byte === 0x2f) {
        args.push(this.parseName());
        continue;
      }
      if (byte === 0x28) {
        args.push(this.parseLiteral());
        continue;
      }
      if (byte === 0x3c && this.peekAt(1) === 0x3c) {
        args.push(this.parseDict());
        continue;
      }
      if (byte === 0x3c) {
        args.push(this.parseHex());
        continue;
      }
      if (byte === 0x5b) {
        args.push(this.parseArray());
        continue;
      }
      if (byte === 0x2b || byte === 0x2d || byte === 0x2e || isDigit(byte)) {
        args.push(this.parseNumber());
        continue;
      }
      const opStart = this.i;
      const op = this.parseOperator();
      if (op === "true") {
        args.push(1);
        continue;
      }
      if (op === "false" || op === "null") {
        args.push(0);
        continue;
      }
      if (op === "BI") {
        const end = this.skipInlineImage();
        ops.push({ name: "BI", args: [], raw: this.bytes.subarray(opStart, end) });
        args = [];
        continue;
      }
      ops.push({ name: op, args });
      args = [];
    }
    return ops;
  }

  done() {
    return this.i >= this.bytes.length;
  }

  peek() {
    return this.bytes[this.i];
  }

  peekAt(n) {
    return this.bytes[this.i + n];
  }

  next() {
    return this.bytes[this.i++];
  }

  skipWsAndComments() {
    while (!this.done()) {
      const byte = this.peek();
      if (WS.has(byte)) {
        this.i += 1;
        continue;
      }
      if (byte === 0x25) {
        while (!this.done()) {
          const b = this.next();
          if (b === 10 || b === 13) break;
        }
        continue;
      }
      break;
    }
  }

  parseOperator() {
    const first = this.peek();
    if (first === 0x27 || first === 0x22) {
      this.i += 1;
      return String.fromCharCode(first);
    }
    let value = "";
    while (!this.done()) {
      const byte = this.peek();
      if (WS.has(byte) || DELIM.has(byte)) break;
      value += String.fromCharCode(this.next());
    }
    return value;
  }

  parseName() {
    this.i += 1;
    let raw = "";
    while (!this.done()) {
      const byte = this.peek();
      if (WS.has(byte) || DELIM.has(byte)) break;
      raw += String.fromCharCode(this.next());
    }
    const value = raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    return { type: "name", value };
  }

  parseNumber() {
    const start = this.i;
    if (this.peek() === 0x2b || this.peek() === 0x2d) this.i += 1;
    while (!this.done() && isDigit(this.peek())) this.i += 1;
    if (!this.done() && this.peek() === 0x2e) {
      this.i += 1;
      while (!this.done() && isDigit(this.peek())) this.i += 1;
    }
    const text = latin1Slice(this.bytes, start, this.i);
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw new Error(`无法解析内容流数字：${text}`);
    }
    return value;
  }

  parseLiteral() {
    this.i += 1;
    const out = [];
    let depth = 1;
    while (!this.done() && depth > 0) {
      const byte = this.next();
      if (byte === 0x5c) {
        if (this.done()) break;
        const esc = this.next();
        if (esc === 0x6e) out.push(0x0a);
        else if (esc === 0x72) out.push(0x0d);
        else if (esc === 0x74) out.push(0x09);
        else if (esc === 0x62) out.push(0x08);
        else if (esc === 0x66) out.push(0x0c);
        else if (esc === 0x28 || esc === 0x29 || esc === 0x5c) out.push(esc);
        else if (esc === 0x0a) {
          /* line continuation */
        } else if (esc === 0x0d) {
          if (!this.done() && this.peek() === 0x0a) this.i += 1;
        } else if (esc >= 0x30 && esc <= 0x37) {
          let oct = String.fromCharCode(esc);
          for (let n = 0; n < 2; n += 1) {
            if (this.done()) break;
            const d = this.peek();
            if (d < 0x30 || d > 0x37) break;
            oct += String.fromCharCode(this.next());
          }
          out.push(parseInt(oct, 8) & 0xff);
        } else out.push(esc);
        continue;
      }
      if (byte === 0x28) {
        depth += 1;
        out.push(byte);
        continue;
      }
      if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) break;
        out.push(byte);
        continue;
      }
      out.push(byte);
    }
    return { type: "string", encoding: "literal", bytes: Uint8Array.from(out) };
  }

  parseHex() {
    this.i += 1;
    let hex = "";
    while (!this.done()) {
      const byte = this.next();
      if (byte === 0x3e) break;
      if (WS.has(byte)) continue;
      hex += String.fromCharCode(byte);
    }
    if (hex.length % 2 === 1) hex += "0";
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return { type: "string", encoding: "hex", bytes };
  }

  parseArray() {
    this.i += 1;
    const items = [];
    while (!this.done()) {
      this.skipWsAndComments();
      if (this.done()) break;
      if (this.peek() === 0x5d) {
        this.i += 1;
        break;
      }
      items.push(this.parseValue());
    }
    return items;
  }

  parseDict() {
    this.i += 2;
    const entries = {};
    while (!this.done()) {
      this.skipWsAndComments();
      if (this.done()) break;
      if (this.peek() === 0x3e && this.peekAt(1) === 0x3e) {
        this.i += 2;
        break;
      }
      const key = this.parseName();
      this.skipWsAndComments();
      entries[key.value] = this.parseValue();
    }
    return { type: "dict", entries };
  }

  parseValue() {
    this.skipWsAndComments();
    const byte = this.peek();
    if (byte === 0x2f) return this.parseName();
    if (byte === 0x28) return this.parseLiteral();
    if (byte === 0x3c && this.peekAt(1) === 0x3c) return this.parseDict();
    if (byte === 0x3c) return this.parseHex();
    if (byte === 0x5b) return this.parseArray();
    if (byte === 0x2b || byte === 0x2d || byte === 0x2e || isDigit(byte)) {
      return this.parseNumber();
    }
    const op = this.parseOperator();
    if (op === "true") return 1;
    if (op === "false" || op === "null") return 0;
    return { type: "name", value: op };
  }

  skipInlineImage() {
    while (!this.done()) {
      this.skipWsAndComments();
      if (this.done()) break;
      if (
        this.peek() === 0x49 &&
        this.peekAt(1) === 0x44 &&
        (this.i + 2 >= this.bytes.length ||
          WS.has(this.bytes[this.i + 2]) ||
          DELIM.has(this.bytes[this.i + 2]))
      ) {
        this.i += 2;
        if (!this.done() && WS.has(this.peek())) this.i += 1;
        break;
      }
      this.parseValue();
    }
    while (!this.done()) {
      if (this.peek() === 0x45 && this.peekAt(1) === 0x49) {
        const prev = this.i > 0 ? this.bytes[this.i - 1] : 0x20;
        const next = this.bytes[this.i + 2];
        if (
          WS.has(prev) &&
          (next === undefined || WS.has(next) || DELIM.has(next))
        ) {
          this.i += 2;
          return this.i;
        }
      }
      this.i += 1;
    }
    return this.i;
  }
}

function latin1Slice(bytes, start, end) {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1e6) / 1e6;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) return String(Math.round(rounded));
  return String(rounded);
}

function toHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function escapeName(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const regular =
      code > 0x20 &&
      code < 0x7f &&
      !DELIM.has(code) &&
      code !== 0x23;
    out += regular ? value[i] : `#${code.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function serializeLiteral(bytes) {
  let out = "(";
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x09) out += "\\t";
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

function serializeOperand(value) {
  if (typeof value === "number") return formatNumber(value);
  if (Array.isArray(value)) {
    return `[${value.map(serializeOperand).join(" ")}]`;
  }
  if (value?.type === "name") return `/${escapeName(value.value)}`;
  if (value?.type === "string") {
    return value.encoding === "literal"
      ? serializeLiteral(value.bytes)
      : `<${toHex(value.bytes)}>`;
  }
  if (value?.type === "dict") {
    const body = Object.entries(value.entries)
      .map(([key, item]) => `/${escapeName(key)} ${serializeOperand(item)}`)
      .join(" ");
    return `<<${body}>>`;
  }
  return "null";
}

export function serializeContentStream(ops) {
  const lines = [];
  for (const op of ops) {
    if (op.raw) {
      lines.push(latin1Slice(op.raw, 0, op.raw.length));
      continue;
    }
    const args = (op.args || []).map(serializeOperand).join(" ");
    lines.push(args ? `${args} ${op.name}` : op.name);
  }
  const text = `${lines.join("\n")}\n`;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export function stringBytes(value) {
  if (value?.type === "string") return value.bytes;
  return null;
}
