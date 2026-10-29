// pdfjsAssets.ts —— pdfjs-dist 运行时资产路径解析（PLAN-2.0.md Commit 05a）
//
// 为什么需要这个模块：
//   `pdfjs-dist` 的中文 PDF 文字层抽取**必须**提供 cMap（CJK 编码表）与 standard_fonts
//   （标准字体度量）两份外部资产；此外 worker 脚本也是一个独立文件。
//   实测：不传 `cMapUrl`/`standardFontDataUrl` 时，一份 8 页中文国标 PDF 抽出 **0 个汉字**
//   （全丢成空白）；补上后抽出 764 个汉字。
//
// 资产落点：`resources/pdfjs/`（commit 级资产，随 electron-builder 的 `extraResources`
//   一起进安装包 → `<安装目录>/resources/resources/pdfjs/...`）。
//   - `cmaps/`            169 个 .bcmap
//   - `standard_fonts/`    16 个字体度量文件
//   - `build/pdf.worker.js`  worker（Node 下 pdfjs 用 fake worker 时以 require 方式加载）
//
// **dev / 安装包双路径解析**：与 `electron/main/obsidian/obsidianManager.ts` 的
// `getScriptPath()` 同一套口径——dev 用 `app.getAppPath()/resources`，
// 打包用 `process.resourcesPath/resources`。本模块**不 import electron**：
// electron 的取值由 main/index.ts 注入，因此纯 Node 可测（test/knowledge.accept.mjs）。

import { join } from 'node:path'
import { AppError, ERROR_CODES } from '../../database/errors'

/** `resources/` 下 pdfjs 资产的子目录名 */
export const PDFJS_ASSETS_SUBDIR = 'pdfjs'

/** dev / 打包两种根路径取值（由 main/index.ts 从 electron app 取） */
export interface PdfjsAssetRoots {
  /** `app.isPackaged` */
  isPackaged: boolean
  /** `app.getAppPath()`（dev 下 = 仓库根） */
  appPath: string
  /** `process.resourcesPath`（打包下 = <安装目录>/resources） */
  resourcesPath: string
}

export interface PdfjsAssets {
  /** `.../resources/pdfjs` */
  root: string
  /** `.../resources/pdfjs/cmaps`（→ pdfjs `cMapUrl`，需带尾部分隔符时由调用方补） */
  cmapsDir: string
  /** `.../resources/pdfjs/standard_fonts`（→ `standardFontDataUrl`） */
  standardFontsDir: string
  /** `.../resources/pdfjs/build/pdf.worker.js`（→ `GlobalWorkerOptions.workerSrc`） */
  workerPath: string
  /** `.../resources/pdfjs/build/pdf.js`（**运行时加载的 pdfjs 本体**：打包器看不见它，见 documentParsers） */
  modulePath: string
}

/**
 * 解析 `resources/` 根目录（dev / 打包两种形态）。
 * 与 `createMarketingDatabase()`（main/index.ts）里 DB worker 的解析保持同一口径，
 * 避免出现「DB worker 找得到、pdfjs 资产找不到」这类只在打包态暴露的错位。
 */
export function resolveResourcesRoot(roots: PdfjsAssetRoots): string {
  if (!roots || typeof roots !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'resolveResourcesRoot 需要 PdfjsAssetRoots')
  }
  if (typeof roots.appPath !== 'string' || !roots.appPath) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'resolveResourcesRoot 缺少 appPath', {
      field: 'appPath'
    })
  }
  if (typeof roots.resourcesPath !== 'string' || !roots.resourcesPath) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'resolveResourcesRoot 缺少 resourcesPath', {
      field: 'resourcesPath'
    })
  }
  return roots.isPackaged
    ? join(roots.resourcesPath, 'resources')
    : join(roots.appPath, 'resources')
}

/** 解析 pdfjs 资产三件套的绝对路径（不检查文件是否存在：存在性由导入时的解析错误暴露） */
export function resolvePdfjsAssets(roots: PdfjsAssetRoots): PdfjsAssets {
  const root = join(resolveResourcesRoot(roots), PDFJS_ASSETS_SUBDIR)
  return {
    root,
    cmapsDir: join(root, 'cmaps'),
    standardFontsDir: join(root, 'standard_fonts'),
    workerPath: join(root, 'build', 'pdf.worker.js'),
    modulePath: join(root, 'build', 'pdf.js')
  }
}

/** pdfjs 期望目录 URL 带尾部分隔符（否则会把末段当文件名拼掉） */
export function asPdfjsDirUrl(dir: string): string {
  return dir.endsWith('\\') || dir.endsWith('/') ? dir : dir + (process.platform === 'win32' ? '\\' : '/')
}
