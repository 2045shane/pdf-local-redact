# 本地 PDF 涂黑和去密码

Cut id：`PDF-LOCAL-REDACT-CUT-2026-11-10-v1`

浏览器扩展（Manifest V3）。PDF 只在本机处理，不上传。

- **去密码（免费）**：只使用你输入的那一次已知打开密码，下载可直接打开的无密码副本。密码错误会提示中文和英文，并且不生成文件。不会猜测、字典或暴力破解。
- **涂黑（专业版占位）**：框选区域后，导出文件会从内容流里删除该区域的文字、图片和矢量，再盖一层不透明黑块。只盖黑框不算通过。未解锁时不能导出，界面显示「专业版（即将上线）」以及「有问题请联系我」→ 小红书「珊哥爱读书」。
- `PRO_CHECKOUT_ENABLED=false`。没有 Creem、Dodo、支付 SDK 或结账链接。

## 命令

```bash
npm install
npm test
npm run build
```

`npm test` 使用 Node 自带测试运行器，并用本机 `pdftotext` / `pdfinfo`（Poppler）检查导出结果。

在 Chrome / Edge 打开 `chrome://extensions`，打开开发者模式，加载已解压的扩展目录 `extension/`（需要先 `npm run build`）。点击工具栏图标会打开扩展页。

## 库与许可证

渲染使用 `pdfjs-dist`（pdf.js，Apache-2.0）。读写与已知密码解密使用 `@cantoo/pdf-lib`（MIT，pdf-lib 的维护分支）。上游 `pdf-lib` 1.x 不能用已知密码解密，所以这里用这个 MIT 分支，而不是再包一层上传服务。全文见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。不使用 AGPL/GPL 库。

功能对照见 [FEATURE_MAP.md](FEATURE_MAP.md)。

## 已知限制

- 没有宽度表、也不是标准 14 字体的文字，会停止导出，不会改成只盖黑框。
- 竖排 CID 字体、自定义 CMap、渐变 `sh` 会停止导出。
- 与框相交但无法按像素改写的图片（例如 JPEG、JBIG2）会整张换成黑图，框外的那张图也会消失。Flate 的 8 位灰/RGB/CMYK 会只擦框内像素。
- 与框相交的矢量路径会整段删除。
- 同一张图片被多次绘制时，擦掉的是共享像素。
- 扫描件上的字在图片里，本版不做 OCR。
- 不去除「没有打开密码、只有权限限制」的 owner 锁。
- 书签、附件、文档信息字典里的同名文字不在框选删除范围内。
- 小红书账号没有公开的数字 ID，CTA 打开的是「珊哥爱读书」的搜索页，不是结账。
