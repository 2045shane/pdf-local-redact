import { EncryptedPDFError, PDFDict, PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { nameText } from "./fonts.js";

export class UnlockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UnlockError";
    this.code = code;
  }
}

/**
 * Remove encryption using exactly the password the user typed.
 * One decrypt attempt. No dictionary, no second guess, no empty-password fallback.
 */
export async function unlockPdf(bytes, password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new UnlockError(
      "请输入打开密码。 / Enter the open password.",
      "EMPTY_PASSWORD",
    );
  }
  const source = toBytes(bytes);
  let probe;
  try {
    probe = await PDFDocument.load(source, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    throw new UnlockError(
      "无法打开这份 PDF。 / Could not open this PDF.",
      "UNREADABLE",
    );
  }
  if (!probe.isEncrypted) {
    throw new UnlockError(
      "这份 PDF 没有打开密码。 / This PDF has no open password.",
      "NOT_ENCRYPTED",
    );
  }

  let doc;
  try {
    doc = await PDFDocument.load(source, {
      password,
      updateMetadata: false,
    });
  } catch (error) {
    if (error instanceof EncryptedPDFError || /password|encrypt/i.test(String(error?.message))) {
      throw new UnlockError(
        "密码不正确，未生成文件。 / Wrong password. No file was created.",
        "WRONG_PASSWORD",
      );
    }
    throw new UnlockError(
      "无法打开这份 PDF。 / Could not open this PDF.",
      "UNREADABLE",
    );
  }

  removeEncryptionArtifacts(doc);
  return doc.save({
    rewrite: true,
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
}

export function removeEncryptionArtifacts(doc) {
  const context = doc.context;
  delete context.trailerInfo.Encrypt;
  context.security = undefined;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFRawStream ? object.dict : object instanceof PDFDict ? object : null;
    if (!dict) continue;
    const filter = dict.lookup(PDFName.of("Filter"));
    const type = dict.lookup(PDFName.of("Type"));
    if (nameText(filter) === "Standard" || nameText(type) === "XRef") {
      context.delete(ref);
    }
  }
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new UnlockError("无法读取这份 PDF。 / Could not open this PDF.", "UNREADABLE");
}
