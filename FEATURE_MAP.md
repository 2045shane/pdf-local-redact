# FEATURE_MAP

Cut id：`PDF-LOCAL-REDACT-CUT-2026-11-10-v1`

| 能力 | 本版 | 说明 |
| --- | --- | --- |
| 选择 PDF | 扩展页文件框 / 拖放 | 不读网页，不申请 `<all_urls>` |
| 去密码 | 免费 | 仅用户输入的已知密码，一次尝试 |
| 错误密码 | 中文 + 英文提示 | 不生成文件 |
| 涂黑 | 专业版占位 | 默认锁住，不能导出 |
| 真删除 | 内容流 | 删除框内文字运算符、相交矢量、相交图片像素或整张无法改写的图片 |
| 黑块 | 删除之后 | 只用于盖住空白，不能单独当涂黑 |
| 未解锁 | 可见入口 | 「专业版（即将上线）」+「有问题请联系我」→ 小红书「珊哥爱读书」 |
| 付款 | 关闭 | `PRO_CHECKOUT_ENABLED=false`，无支付 SDK |
| 本地测试开关 | `PRO_REDACTION_UNLOCKED` 或扩展页勾选 | 只写 localStorage，不联网 |
| 上传 | 无 | 无 `fetch` / XHR / WebSocket |

## 验收对应

- **R1** `src/unlock.js`：正确密码 → `rewrite: true` 的无 `/Encrypt` 副本；`pdfinfo` 为 `Encrypted: no`，`pdftotext` 能读出原文。错误密码抛 `WRONG_PASSWORD`。
- **R2** `src/redact.js`：重写内容流。`pdftotext` 不再出现被涂文字；只 `drawRectangle` 的对照仍然能抽出原文。图片测试检查左半像素变黑、右半保留。
- **R3** `src/config.js` 与扩展页：未解锁调用 `redactPdf` 抛错且不返回字节。源码无 Creem/Dodo/Stripe。
- **R4** `extension/manifest.json`：无 `host_permissions`、无 `<all_urls>`、无 content script。
- **R5** 本文、README、`THIRD_PARTY_LICENSES.md`，以及 `npm test`。

## 库

- `pdfjs-dist` 4.10.38，Apache-2.0，只负责扩展页里的预览和框选坐标。
- `@cantoo/pdf-lib` 2.11.1，MIT。解密、读内容流、写回、Flate。上游 pdf-lib 不能解密，所以不用 1.17.1。

## 明确不做

猜密码、上传、收费、合并拆分、签名批注、OCR 涂黑扫描件、去掉无需打开密码的权限限制。
