/** Professional checkout is intentionally off. There is no payment path. */
export const PRO_CHECKOUT_ENABLED = false;

/**
 * Local stub. Tests pass `unlocked: true` into redactPdf.
 * The extension can also set localStorage PRO_REDACTION_UNLOCKED=1.
 * This is not a license check and does not contact a server.
 */
export const PRO_REDACTION_UNLOCKED = false;

export const CTA_LABEL = "有问题请联系我";
export const CTA_HANDLE = "珊哥爱读书";
export const CTA_URL =
  "https://www.xiaohongshu.com/search_result?keyword=" +
  encodeURIComponent("珊哥爱读书");

export const PRO_LOCKED_MESSAGE = "专业版（即将上线）";
