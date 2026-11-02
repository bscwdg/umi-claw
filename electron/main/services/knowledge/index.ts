// electron/main/services/knowledge/index.ts —— 知识库解析能力的**公共面**
//
// 背景：文档解析（Word / Excel / PDF / TXT）、pdfjs 运行时资产定位、URL 抓取原先在
// work 与 marketing 各有一份**逐字节相同**的实现（WP1 已合并为一份）。
//
// 用法约定：
//   - 域侧的 manager（work/marketing 的 knowledgeManager、marketing 的 scanRecognizer）从这里取；
//   - **只要 pdfjs 资产定位的插件侧**请直接 `import ... from './parsers/pdfjsAssets'`：
//     本 barrel 会连带 documentParsers 的 `mammoth` / `exceljs`，别为取一个函数把两者拖进包。
//   - 这里是具名白名单，不 `export *`：上限常量、UA、`parseErrorOf` 等内部符号
//     不构成公共 API，改它们不该被别人当成破坏性变更。

export {
  PARSEABLE_FILE_TYPES,
  TEXT_FILE_EXTENSIONS,
  LEGACY_OFFICE_EXTENSIONS,
  FILE_TYPE_EXTENSIONS,
  assertFileTypeMatchesPath,
  extensionOf,
  parseDocumentFile,
  parseDocxFile,
  parseXlsxFile,
  parseTextFile,
  parsePdfFile,
  loadPdfjsModule
} from './parsers/documentParsers'
export type { ParseableFileType, ParsedDocument, PdfParseOptions } from './parsers/documentParsers'

export { resolvePdfjsAssets, resolveResourcesRoot, asPdfjsDirUrl } from './parsers/pdfjsAssets'
export type { PdfjsAssets, PdfjsAssetRoots } from './parsers/pdfjsAssets'

export { assertImportableUrl, extractTextFromHtml, fetchHtmlPage } from './parsers/urlParser'
export type { HtmlFetcher, FetchedHtml } from './parsers/urlParser'
