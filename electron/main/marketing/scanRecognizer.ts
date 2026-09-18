// scanRecognizer.ts —— 扫描件/图片 AI 识别兜底（PLAN-2.0.md Commit 05b）
//
// 契约（§七「Commit 05 边界」05b / §二 硬规则 9、10、13 / §五 错误码 / §六 已实测事实）：
//   - 范围：**仅扫描 PDF 与带文字的资料图（png/jpg/webp）**；客片/商品图归二期 Assets，不做
//     （技术上无法区分「资料图 vs 客片」，靠 UI 文案约束用户自觉；确认弹窗是最后闸门）。
//   - 「用 AI 识别」= **用户显式触发**（本模块没有任何自动调用路径）；
//     识别文本**人工确认后才入库**（硬规则 10）——本模块**不写库**：
//     落库由渲染端在确认弹窗里点「确认入库」后经 `marketing:knowledge:commitRecognized`
//     → `knowledgeManager.commitRecognized`（05a 联动）完成。
//   - **逐图发送**（图像按页归组）：一页一张图 = 一页一次请求；一页多张图（拼贴图/内嵌插图）
//     每张一次请求，指令里带「本页第 j/k 张图」，汇总时同页文本归入同一节——
//     「页数」上限/文案一律按**页**计而不是按图计（外部复审修正）。
//   - **栅格化前即注册任务**（外部复审修正）：taskId 与 cancel 在任何昂贵工作（PDF 解码）
//     之前就进入 `activeTasks` 注册表，abort / cancelAll 对整个生命周期即时生效，
//     不再只有「recognize() 返回后」才停得掉。
//   - **multimodal 预检**（外部复审修正）：注入 `multimodalConfigured()` 时，未配置在
//     **栅格化之前**同步报 VALIDATION_ERROR + reason='multimodal-model-not-configured'
//    （与 07 同 payload），不浪费几秒解码才失败；07 侧的按次透传仍是最终防线。
//   - 失败重试：每页最多重试 1 次，且**只重试可恢复错误**（OPENCLAW_NOT_READY / OPENCLAW_TIMEOUT）；
//     配置类（VALIDATION_ERROR）与鉴权失败绝不重试——重试「没配多模态模型」只会把同一个错误再烧一遍。
//   - 可中止（AbortController，四路中止语义照抄 08）：停止按钮 / 切换商家 / 组件卸载都从渲染端
//     走 `marketing:knowledge:recognize:abort`；应用退出由 main/index.ts before-quit 调
//     `abortAllScanStreams()`。中止经注入的 07 `GatewayClient` **真断上游**（07 已验 close 语义）。
//   - 复用 07：含图请求走 `imageDataPart(dataUri)`；模型选择（multimodal 按次解析）与
//     `multimodal-model-not-configured` 的 `VALIDATION_ERROR` **由 GatewayClient 抛出、原样透传**，
//     本模块绝不包装降级、绝不静默改发纯文本（07 口径「宁可报错也不假装看得见」）。
//   - **扫描 PDF → 图片**用仓库已有 pdfjs-dist v3 运行时资产（05a 双路径解析）：
//     `getOperatorList()` → 遇 `paintImageXObject`/`Repeat` 从 `page.objs` 取解码后位图；
//     遇 `paintInlineImageXObject`/`Group`(OPS 86/87) 直取 args[0] 位图（防御分支）。
//     ⚙️ **实测事实**（S17 探针抓出，修正复审断言）：v3 worker 对 BI/ID/EI 内嵌图实际发的是
//     `paintImageXObject` + 合成 objId（`img_p0_1`，走 objs 不走 commonObjs），不是直发 OPS 86；
//     两条都接住、不赌单一形态 → 内嵌图扫描件（含纯内嵌图的 ReportLab/LaTeX 类）不再假阴性。→
//     纯 Node `zlib` 手写 PNG 编码 → data URI。可行性由 `test/scan.probe.mjs` 实测 PASS
//     （证据 `test/.tmp/probe-scan-render.json`），故 05b 不降级。
//   - 过程性进度标记（【正在识别…】/（…重试…））**只进直播流、不进权威文本**；
//     另导出 `stripProgressMarkers`，渲染端在「打开确认弹窗」前兜底剥除（中止态没有 done 的干净文本）。
//   - 识别结果里**疑似价格**由本地正则确定性检测（`priceSuspected`），供 UI 显著提示
//     「价格数字请人工核对」；模型自己说什么不算数（§七：价格类不得盲信模型识别）。
//
// 设计约束：本模块**不 import electron、不发 HTTP、不碰数据库**——
// pdfjs 资产 / loadPdfjs / GatewayClient（07）全部注入，因此可被 esbuild bundle 后在纯 Node 里
// 直接测试（test/scan.accept.mjs 打的就是这份真源码）。

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { deflateSync } from 'node:zlib'
import { AppError, ERROR_CODES, errorCodeOf } from '../database/errors'
import {
  GATEWAY_ABORT_REASON,
  imageDataPart,
  textPart,
  type GatewayChatMessage,
  type GatewayStreamHandle
} from '../gatewayClient'
import { loadPdfjsModule } from './parsers/documentParsers'
import { asPdfjsDirUrl, type PdfjsAssets } from './parsers/pdfjsAssets'

/** pdfjs 模块形状（类型取官方 d.ts；运行时从随包资产加载，见 documentParsers） */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.js')

/** pdfjs 解码后位图的实测形状（kind 1=1bit 灰度 / 2=RGB24 / 3=RGBA32） */
interface PdfDecodedImage {
  width: number
  height: number
  kind: number
  data: Uint8Array
}

// ── 范围与上限（全部确定性常量，可注入覆盖以便验收） ─────────────────────────

/** 05b 接受的文件扩展名 → 知识条目 type（§四 type 枚举已放开到 image） */
export const SCAN_FILE_KIND_BY_EXT: Record<string, 'pdf' | 'image'> = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image'
}

/** 图片 data URI 的 MIME 按**魔数**判定（扩展名可以骗人） */
export const SCAN_IMAGE_MAGIC: Array<{ mime: 'image/png' | 'image/jpeg' | 'image/webp'; test: (b: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP'
  }
]

/** 整档文件大小上限（PDF 原件 + 逐页解码位图都要进内存，α 阶段 20MB 足够放几十页 300dpi 扫描） */
export const SCAN_MAX_FILE_BYTES = 20 * 1024 * 1024
/** 单次识别的页数上限（超了提示拆分——一页至少一次请求，12 页已是 12 次模型调用） */
export const SCAN_MAX_PAGES = 12
/** 单图 data URI（base64 字节）上限：超过即拒（模型侧一般也在 5-10MB 量级截断） */
export const SCAN_MAX_IMAGE_BYTES = 6 * 1024 * 1024
/** 超过此边长就纯 JS 最近邻降采样（高 DPI 扫描 2480x3508 → PNG 会爆到几十 MB；2000px 对 OCR 够用） */
export const SCAN_MAX_IMAGE_DIMENSION = 2000
/** 小于此边长的 PDF 内嵌图视为装饰性小图（logo/印章/边框），跳过不送 OCR（省请求与噪声） */
export const SCAN_MIN_IMAGE_DIMENSION = 64
/** 每页失败重试次数（只对可恢复错误生效） */
export const SCAN_PAGE_RETRIES = 1

/** 疑似价格的本地判据（¥/￥/$ + 数字，或 数字 + 元/块）。**不**问模型「有没有价格」。 */
export const PRICE_SUSPECT_PATTERN = /[¥￥$]\s*\d|\d+(?:[.,]\d+)?\s*(?:元|人民币|块(?:钱)?)/

/**
 * 过程性进度标记的匹配式（`【正在识别…】` 页头与「重试」提示行，整行）。
 * ⚠️ store 侧有一份同字面量的副本（跨 tsconfig 无法共享），由 test/scan.accept.mjs 静态比对防漂移。
 */
export const SCAN_PROGRESS_MARKER_PATTERN =
  /^\s*(?:【正在识别(?:第 \d+ 页 \/ 共 \d+ 页|：[^\n】]*)】|（第 \d+ 页识别失败，重试 1 次…）)\s*$/gm

/** OCR 护栏（写死；对应 §七「表格可能串行/错读」与 §一「不编造」） */
export const OCR_GUARDRAILS = [
  '你是文档识别助手。任务：逐字转录图片中**实际存在**的文字。',
  '硬性规则：',
  '1) 忠实原文：图片里没有的字一个都不要编；看不清/被遮挡的地方写「（不清楚）」。',
  '2) 保持阅读顺序与换行；表格输出为 Markdown 表格，单元格不要串行（一行一格）。',
  '3) 数字（价格、数量、日期）逐字符照抄，不推测、不补全、不换格式。',
  '4) 只输出转录文本本身：不要解释、不要前言后语、不要代码块围栏。'
].join('\n')

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface ScanLimits {
  maxFileBytes?: number
  maxPages?: number
  maxImageBytes?: number
  maxImageDimension?: number
  retries?: number
}

export interface ScanRecognizerOptions {
  /** 07 的 Gateway Client（唯一出站通道；token 与 multimodal 解析都在它手里，硬规则 13） */
  gateway: {
    createChatStream(input: {
      projectId: string
      messages: GatewayChatMessage[]
      /** 识别任务专用会话键（`scan-…`）：不把 OCR 转录灌进商家的 Advisor sticky 会话 */
      conversationKey?: string
      temperature?: number
      signal?: AbortSignal
    }): GatewayStreamHandle
  }
  /** pdfjs 运行时资产（扫描 PDF → 图像必需；缺失时 PDF 识别报 FILE_PARSE_ERROR） */
  pdfjsAssets?: PdfjsAssets | null
  /** 装载 pdfjs 模块（默认与 05a 同一实现：createRequire 按绝对路径加载随包资产） */
  loadPdfjs?: (assets: PdfjsAssets) => PdfjsModule
  /**
   * 「当前配置是否有可用多模态模型」的轻量同步预检（可选注入）。
   * false → 在**栅格化之前**就报与 07 同 payload 的 VALIDATION_ERROR，
   * 避免用户等几秒解码才发现「模型看不见图」。07 侧按次解析仍是最终防线。
   */
  multimodalConfigured?: () => boolean
  logger?: (message: string) => void
  limits?: ScanLimits
}

/** 一页（或一张资料图）的待识别图像 */
export interface ScanImage {
  /** 1 基页码（图片文件恒为 1） */
  page: number
  /** 本页第几张图（1 基；一页多图时用于指令，单图页也是 1） */
  imageInPage: number
  /** 本页图数（>1 时指令带「本页第 j/k 张图」） */
  imagesOnPage: number
  /** 全文档页数（指令与进度头里的「共 M 页」按页计，不是按图计） */
  totalPages: number
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  /** `data:image/...;base64,...` */
  dataUri: string
  /** data URI 的字节数（大小上限按它算） */
  bytes: number
  width: number
  height: number
  /** 位图是否被降采样（高 DPI 扫描件；提示识别精度可能受限） */
  downscaled: boolean
}

export interface RecognizeInput {
  /** 原件绝对路径（导入失败时渲染端记住了它） */
  filePath: string
  /** 可显式覆盖条目类型判定（默认按扩展名） */
  type?: string
  /** 外部中止信号（组件卸载/切换商家；与 cancel() 等价，08 同款双保险） */
  signal?: AbortSignal
}

/** 单页单图的识别产出（同一页可能有多条，汇总时按页归组） */
export interface ScanPageText {
  page: number
  text: string
}

/** 识别最终结果（**待人工确认**——确认前绝不入库，硬规则 10） */
export interface RecognitionResult {
  /** 汇总文本（多页带「【第 N 页】」分节头；单张资料图为裸文本；**不含进度标记**） */
  text: string
  pages: ScanPageText[]
  /** 转发给渲染端的增量数（与 07 GatewayStreamResult 字段对齐） */
  chunks: number
  /** 对齐 07 句柄形状：识别链路不碰 usage/model（§六：usage 恒 0，不参与任何判定） */
  usage: null
  model: null
  aborted: boolean
  ms: number
  /** 本地正则判定「疑似含价格」→ UI 显著提示「价格数字请人工核对」 */
  priceSuspected: boolean
  /** 原件信息（确认入库时回传给 commitRecognized） */
  kind: 'pdf' | 'image'
  filePath: string
  suggestedTitle: string
  images: Array<{ page: number; width: number; height: number; bytes: number; downscaled: boolean }>
}

/** 一次识别任务（IPC 层拿它去 forwardGatewayStream 转发） */
export interface RecognitionRun {
  taskId: string
  projectId: string
  kind: 'pdf' | 'image'
  filePath: string
  suggestedTitle: string
  images: ScanImage[]
  /** 给 forwardGatewayStream 的句柄形状（iterator + result + cancel） */
  handle: {
    iterator: AsyncIterable<{ index: number; delta: string }>
    result: Promise<RecognitionResult>
    cancel(): void
  }
  cancel(): void
}

export interface ScanRecognizer {
  recognize(projectId: string, input: RecognizeInput): Promise<RecognitionRun>
  /** 按 taskId 取消（覆盖「栅格化中」窗口）；未找到/已结束 → false（幂等） */
  cancelTask(taskId: string): boolean
  /**
   * 按 projectId 取消该商家全部在途任务（渲染端在拿到 taskId 前的 abort 兼路径：
   * 栅格化窗口里 taskId 尚未回到渲染端，但中止必须即时生效）。
   * 渲染端识别流设同商家同时至多一个任务（UI 约束），误伤面可控。
   */
  cancelByProject(projectId: string): number
  /** 取消全部在途任务（before-quit 第四路）；返回实际取消数 */
  cancelAll(): number
  /** 在途任务数（测试/巡检用；不参与业务判定） */
  activeTaskCount(): number
}

// ── PNG 编码（纯 Node：node:zlib + 自实现 CRC32；无原生依赖） ─────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** RGBA 位图 → PNG（color type 6，filter 0） */
export function encodePng(bitmap: { width: number; height: number; rgba: Uint8Array }): Buffer {
  const { width, height, rgba } = bitmap
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng 非法尺寸: ${width}x${height}`)
  }
  const expected = width * height * 4
  if (rgba.length < expected) throw new Error(`encodePng 数据不足: ${rgba.length} < ${expected}`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** pdfjs imgData（kind 1=1bit 灰度 / 2=RGB24 / 3=RGBA32）→ RGBA 位图 */
export function imgDataToRgba(img: PdfDecodedImage): { width: number; height: number; rgba: Uint8Array } {
  const { width, height, kind, data } = img
  if (!width || !height || !data) throw new Error(`imgData 缺字段: w=${width} h=${height} data=${!!data}`)
  const src = data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer)
  if (kind === 3) return { width, height, rgba: src }
  if (kind === 2) {
    // RGB_24BPP → 补 A=255
    if (src.length < width * height * 3) throw new Error(`RGB_24BPP 长度不足 ${src.length}`)
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = src[i * 3]
      rgba[i * 4 + 1] = src[i * 3 + 1]
      rgba[i * 4 + 2] = src[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    return { width, height, rgba }
  }
  if (kind === 1) {
    // GRAYSCALE_1BPP：位=0 → 黑、1 → 白；行按字节对齐（pdfjs 语义）
    const rgba = new Uint8Array(width * height * 4)
    const rowBytes = Math.ceil(width / 8)
    if (src.length < rowBytes * height) throw new Error(`1BPP 长度不足 ${src.length}`)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const i = (y * width + x) * 4
        rgba[i] = v
        rgba[i + 1] = v
        rgba[i + 2] = v
        rgba[i + 3] = 255
      }
    }
    return { width, height, rgba }
  }
  throw new Error(`未知 imgData.kind: ${kind}`)
}

/**
 * 最近邻降采样（高 DPI 扫描的 PNG 会爆大小；纯 JS 逐像素取样，无原生依赖）。
 * 只对超限图生效；OCR 模型常用输入分辨率 ≤2000px，降采样换可得性是划算的。
 */
export function downscaleNearest(
  bitmap: { width: number; height: number; rgba: Uint8Array },
  maxDimension: number
): { width: number; height: number; rgba: Uint8Array; downscaled: boolean } {
  const { width, height, rgba } = bitmap
  const longest = Math.max(width, height)
  if (!maxDimension || maxDimension <= 0 || longest <= maxDimension) {
    return { width, height, rgba, downscaled: false }
  }
  const ratio = maxDimension / longest
  const tw = Math.max(1, Math.round(width * ratio))
  const th = Math.max(1, Math.round(height * ratio))
  const out = new Uint8Array(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const sy = Math.min(height - 1, Math.floor(y / ratio))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(width - 1, Math.floor(x / ratio))
      const s = (sy * width + sx) * 4
      const d = (y * tw + x) * 4
      out[d] = rgba[s]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s + 2]
      out[d + 3] = rgba[s + 3]
    }
  }
  return { width: tw, height: th, rgba: out, downscaled: true }
}

// ── 增量队列（生产者 pump → 消费者 iterator；与 07 内部同构的小实现） ─────────

class DeltaQueue implements AsyncIterable<{ index: number; delta: string }> {
  private buffer: Array<{ index: number; delta: string }> = []
  private waiters: Array<{
    resolve: (r: IteratorResult<{ index: number; delta: string }>) => void
    reject: (e: unknown) => void
  }> = []
  private closed = false
  private failure: unknown = null

  push(item: { index: number; delta: string }): void {
    if (this.closed || this.failure) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value: item, done: false })
    else this.buffer.push(item)
  }

  close(): void {
    if (this.closed || this.failure) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as never, done: true })
  }

  fail(e: unknown): void {
    if (this.closed || this.failure) return
    this.failure = e
    for (const waiter of this.waiters.splice(0)) waiter.reject(e)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<{ index: number; delta: string }> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift() as { index: number; delta: string }
        continue
      }
      if (this.failure) throw this.failure
      if (this.closed) return
      const next = await new Promise<IteratorResult<{ index: number; delta: string }>>((resolve, reject) =>
        this.waiters.push({ resolve, reject })
      )
      if (next.done) return
      yield next.value
    }
  }
}

// ── ScanRecognizer ────────────────────────────────────────────────────────────

let scanTaskSeq = 0

export function createScanRecognizer(options: ScanRecognizerOptions): ScanRecognizer {
  if (!options || typeof options !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ScanRecognizer 需要注入式依赖配置')
  }
  if (!options.gateway || typeof options.gateway.createChatStream !== 'function') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ScanRecognizer 缺少依赖: gateway（07 GatewayClient）')
  }
  const gateway = options.gateway
  const logger = options.logger
  const pdfjsAssets = options.pdfjsAssets ?? null
  const loadPdfjs = options.loadPdfjs ?? loadPdfjsModule
  const multimodalConfigured = options.multimodalConfigured
  const limits: Required<ScanLimits> = {
    maxFileBytes: positiveOr(options.limits?.maxFileBytes, SCAN_MAX_FILE_BYTES),
    maxPages: positiveOr(options.limits?.maxPages, SCAN_MAX_PAGES),
    maxImageBytes: positiveOr(options.limits?.maxImageBytes, SCAN_MAX_IMAGE_BYTES),
    maxImageDimension: positiveOr(options.limits?.maxImageDimension, SCAN_MAX_IMAGE_DIMENSION),
    retries: Number.isFinite(Number(options.limits?.retries))
      ? Math.max(0, Math.floor(Number(options.limits?.retries)))
      : SCAN_PAGE_RETRIES
  }
  const log = (m: string): void => logger?.(m)

  /**
   * 在途任务注册表（taskId → { cancel, projectId }）。
   * **注册发生在栅格化之前**：整个生命周期（解码窗口 + 流式窗口）abort 都能命中，
   * 「停止识别」不再是栅格化期间的空操作（外部复审修正）。
   * cancel 返回「是否首次作废」，供上层的两本账去重计数。
   */
  const activeTasks = new Map<string, { cancel: () => boolean; projectId: string }>()

  /**
   * 识别一个扫描件/资料图（**显式触发**才会被调用；本函数只产出「待确认文本」，不写库）。
   *
   * 同步失败路径（直接抛 §五 码，IPC 以错误信封回；全部发生在模型调用之前）：
   *   FILE_NOT_FOUND / VALIDATION_ERROR(file-too-large|too-many-pages|image-too-large|
   *   unsupported-file-type|multimodal-model-not-configured 预检)
   *   / FILE_PARSE_ERROR(pdfjs-assets-missing|not-an-image|no-images|pdf 解析失败)
   * 异步失败（流 error 事件 / run.result reject）：
   *   上游与配置错误原样透传（含 multimodal-model-not-configured 的最终防线）。
   */
  async function recognize(projectId: string, input: RecognizeInput): Promise<RecognitionRun> {
    const pid = requireId(projectId)
    const filePath = requireText(input?.filePath, 'filePath')
    const kind = resolveKind(input?.type, filePath)

    let bytes = 0
    try {
      const st = statSync(filePath)
      if (!st.isFile()) throw new Error('not-a-file')
      bytes = st.size
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError(ERROR_CODES.FILE_NOT_FOUND, `原始文件不存在或不可读: ${filePath}`, {
        path: filePath,
        cause: e instanceof Error ? e.message : String(e)
      })
    }
    if (bytes > limits.maxFileBytes) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `文件过大（${(bytes / 1024 / 1024).toFixed(1)}MB > ${Math.round(limits.maxFileBytes / 1024 / 1024)}MB），请拆分后再识别`,
        { path: filePath, bytes, max: limits.maxFileBytes, reason: 'file-too-large' }
      )
    }
    // 多模态预检（便宜、同步、在昂贵栅格化之前）：未配置就别让用户等解码
    if (multimodalConfigured && !multimodalConfigured()) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        '当前模型未配置图片输入能力（多模态），已拒绝识别；请在配置里选择支持图片的模型',
        { reason: 'multimodal-model-not-configured', field: 'models.multimodal', stage: 'precheck' }
      )
    }

    // ── 任务注册（栅格化之前；abort 从这一刻起就能命中） ──
    const taskId = `scan-${++scanTaskSeq}-${Date.now().toString(36)}`
    const controller = new AbortController()
    if (input?.signal) {
      if (input.signal.aborted) controller.abort()
      else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let cancelled = controller.signal.aborted
    let currentHandle: GatewayStreamHandle | null = null
    const queue = new DeltaQueue()
    // 返回 true = 本次调用是**首次**令任务作废（已作废的重复调返回 false）；
    // abortAllScanStreams 靠这个语义去重：forward.cancel() 与 recognizer.cancelAll() 对同一
    // 任务各碰一次 closure，只有先到的那个计数（小瑕疵②：退出日志不再数两遍）
    const cancel = (): boolean => {
      if (cancelled) return false
      cancelled = true
      controller.abort()
      currentHandle?.cancel()
      queue.close()
      return true
    }
    activeTasks.set(taskId, { cancel, projectId: pid })

    const base = nameWithoutExtension(basename(filePath))
    let images: ScanImage[]
    try {
      const raw =
        kind === 'pdf'
          ? await rasterizePdfPages(filePath, () => cancelled || controller.signal.aborted)
          : rasterizeImageFile(filePath)
      if (cancelled || controller.signal.aborted) {
        // 栅格化期间被中止（停止按钮 / before-quit）：以「已中止」收场，不发任何模型请求
        throw new AppError(ERROR_CODES.OPENCLAW_TIMEOUT, '扫描件识别已中止', {
          reason: GATEWAY_ABORT_REASON,
          path: filePath
        })
      }
      if (!raw.length) {
        // 扫描判据来自 05a 的「无文字层」，正常必有图；一张都取不出说明文件异常/图像编码不支持
        throw new AppError(
          ERROR_CODES.FILE_PARSE_ERROR,
          `未能从文件取出可识别的图像: ${basename(filePath)}（图像编码可能不受支持，或全是装饰性小图）`,
          { path: filePath, kind, reason: 'no-images' }
        )
      }
      images = decorateImages(raw)
      const totalPages = images[0].totalPages
      if (totalPages > limits.maxPages) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `页数过多（${totalPages} 页 > ${limits.maxPages}）：请先拆分文档再识别`,
          { path: filePath, pages: totalPages, images: images.length, max: limits.maxPages, reason: 'too-many-pages' }
        )
      }
      for (const img of images) {
        if (img.bytes > limits.maxImageBytes) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            `第 ${img.page} 页的图像过大（${(img.bytes / 1024 / 1024).toFixed(1)}MB），请在原软件里降低扫描分辨率或拆分后重试`,
            { path: filePath, page: img.page, bytes: img.bytes, max: limits.maxImageBytes, reason: 'image-too-large' }
          )
        }
      }
    } catch (e) {
      activeTasks.delete(taskId)
      throw e
    }

    const run: RecognitionRun = {
      taskId,
      projectId: pid,
      kind,
      filePath,
      suggestedTitle: base,
      images,
      handle: null as unknown as RecognitionRun['handle'],
      cancel
    }

    const startedAt = Date.now()
    const resultPromise = pump()
    resultPromise.catch(() => undefined) // 消费方（IPC / forwardGatewayStream）各自处理
    run.handle = { iterator: queue, result: resultPromise, cancel }
    return run

    // ── 生产者：逐图（页序）调 07 流式识别；每张可重试 1 次；中止即停 ──
    async function pump(): Promise<RecognitionResult> {
      try {
        let outIndex = 0
        const push = (delta: string): void => {
          if (!delta) return
          outIndex += 1
          queue.push({ index: outIndex, delta })
        }
        const pageTexts: ScanPageText[] = []
        // 进度头按**页**推一次（小瑕疵①：同页多图不再重复推「正在识别第 N 页」；
        // 干净文本本来就会剥掉它们，这里修的是直播流的观感）
        let headerPage = 0
        try {
          for (let i = 0; i < images.length; i++) {
            if (cancelled || controller.signal.aborted) break
            const img = images[i]
            if (img.page !== headerPage) {
              headerPage = img.page
              push(
                kind === 'pdf' && img.totalPages > 1
                  ? `\n\n【正在识别第 ${img.page} 页 / 共 ${img.totalPages} 页】\n`
                  : `\n\n【正在识别：${base}${kind === 'pdf' ? '.pdf' : ''}】\n`
              )
            }
            let pageText = ''
            let lastError: unknown = null
            for (let attempt = 0; attempt <= limits.retries; attempt++) {
              if (cancelled || controller.signal.aborted) break
              pageText = ''
              try {
                const handle = gateway.createChatStream({
                  projectId: pid,
                  messages: buildPageMessages(base, kind, img),
                  // 识别会话与商家对话会话隔离（sticky user 机制，§六）：每张图每次尝试一把独立键，
                  // 不把 OCR 转录累积进 Advisor 的历史，也不让后一张「看见」前一张的转录
                  //（那会成倍抬高 prompt 成本并干扰「只转录这张图」的指令）
                  conversationKey: `scan-${taskId}-p${img.page}-i${img.imageInPage}-a${attempt}`,
                  temperature: 0,
                  signal: controller.signal
                })
                currentHandle = handle
                for await (const d of handle.iterator) {
                  if (cancelled || controller.signal.aborted) break
                  pageText += d.delta
                  push(d.delta)
                }
                const res = await handle.result
                currentHandle = null
                if (cancelled || res.aborted || controller.signal.aborted) break
                lastError = null
                break // 本图成功
              } catch (e) {
                currentHandle = null
                if (cancelled || controller.signal.aborted) break
                const code = errorCodeOf(e)
                const retriable = code === ERROR_CODES.OPENCLAW_NOT_READY || code === ERROR_CODES.OPENCLAW_TIMEOUT
                lastError = e
                if (!retriable || attempt >= limits.retries) {
                  // 配置/鉴权类错误：透传原码（multimodal-model-not-configured 走的就是这条路）
                  throw e
                }
                push(`\n（第 ${img.page} 页识别失败，重试 1 次…）\n`)
                log(
                  `[scan] ${taskId} 第 ${img.page} 页失败重试：${code ?? 'unknown'} ${e instanceof Error ? e.message : String(e)}`
                )
              }
            }
            if (cancelled || controller.signal.aborted) break
            if (lastError) throw lastError
            const trimmed = normalizeRecognizedText(pageText)
            pageTexts.push({ page: img.page, text: trimmed || '（本页未识别到文字）' })
          }
        } catch (e) {
          queue.fail(e)
          throw e
        }

        const aborted = cancelled || controller.signal.aborted
        const text = assembleText(kind, pageTexts)
        if (!aborted) {
          const useful = pageTexts.some((p) => p.text && p.text !== '（本页未识别到文字）')
          if (!useful && pageTexts.length) {
            const err = new AppError(
              ERROR_CODES.FILE_PARSE_ERROR,
              `未识别到任何文字: ${basename(filePath)}（图像可能过于模糊，或没有文字内容）`,
              { path: filePath, kind, reason: 'empty-recognition' }
            )
            queue.fail(err)
            throw err
          }
        }
        const priceSuspected = PRICE_SUSPECT_PATTERN.test(text)
        queue.close()
        log(
          `[scan] ${taskId} ${aborted ? '已中止' : '完成'}：${pageTexts.length}/${images.length} 图，` +
            `chunks=${outIndex} price=${priceSuspected ? '疑似含价格' : '未见价格'}`
        )
        return {
          text,
          pages: pageTexts,
          chunks: outIndex,
          usage: null,
          model: null,
          aborted,
          ms: Date.now() - startedAt,
          priceSuspected,
          kind,
          filePath,
          suggestedTitle: base,
          images: images.map((img) => ({
            page: img.page,
            width: img.width,
            height: img.height,
            bytes: img.bytes,
            downscaled: img.downscaled
          }))
        }
      } finally {
        // 任务终结（完成/失败/中止）：注销，注册表只反映真正在途的任务
        activeTasks.delete(taskId)
      }
    }
  }

  /** 给栅格化结果补页序语义：每页的图数、本页第几张、全文档页数（按页不按图） */
  function decorateImages(raw: Array<Omit<ScanImage, 'imageInPage' | 'imagesOnPage' | 'totalPages'>>): ScanImage[] {
    const pageCounts = new Map<number, number>()
    for (const item of raw) pageCounts.set(item.page, (pageCounts.get(item.page) ?? 0) + 1)
    const seen = new Map<number, number>()
    return raw.map((item) => {
      const nth = (seen.get(item.page) ?? 0) + 1
      seen.set(item.page, nth)
      return {
        ...item,
        imageInPage: nth,
        imagesOnPage: pageCounts.get(item.page) ?? 1,
        totalPages: pageCounts.size
      }
    })
  }

  // ── 扫描件 PDF → 逐页图像（05b 探针实测配方，证据 test/.tmp/probe-scan-render.json） ──

  async function rasterizePdfPages(
    filePath: string,
    isAborted: () => boolean
  ): Promise<Array<Omit<ScanImage, 'imageInPage' | 'imagesOnPage' | 'totalPages'>>> {
    if (!pdfjsAssets) {
      throw new AppError(
        ERROR_CODES.FILE_PARSE_ERROR,
        `扫描 PDF 识别缺少 pdfjs 运行时资产（resources/pdfjs）: ${basename(filePath)}`,
        { path: filePath, kind: 'pdf', reason: 'pdfjs-assets-missing' }
      )
    }
    const pdfjs = loadPdfjs(pdfjsAssets)
    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null
    const images: Array<Omit<ScanImage, 'imageInPage' | 'imagesOnPage' | 'totalPages'>> = []
    try {
      doc = await pdfjs.getDocument({
        data: new Uint8Array(readFileSync(filePath)),
        useSystemFonts: true,
        disableFontFace: true,
        isEvalSupported: false,
        cMapUrl: asPdfjsDirUrl(pdfjsAssets.cmapsDir),
        cMapPacked: true,
        standardFontDataUrl: asPdfjsDirUrl(pdfjsAssets.standardFontsDir)
      } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise
      const total = doc.numPages
      if (total > limits.maxPages) {
        // 提前拒（不用等全部栅格化）；文案按「页」计
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `页数过多（${total} 页 > ${limits.maxPages}）：请先拆分文档再识别`,
          { path: filePath, pages: total, max: limits.maxPages, reason: 'too-many-pages' }
        )
      }
      for (let p = 1; p <= total; p++) {
        if (isAborted()) break // 栅格化窗口也要响应中止（abort 即时性的另一半）
        const page = await doc.getPage(p)
        try {
          const ops = await page.getOperatorList()
          const seenObjIds = new Set<string>()
          for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i]
            let data: PdfDecodedImage | null = null
            if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageXObjectRepeat) {
              const objId = ops.argsArray[i][0]
              if (seenObjIds.has(String(objId))) continue // 同页重复绘制同一对象只取一次
              seenObjIds.add(String(objId))
              try {
                // PDFObjects.get 可能回 Promise（异步补齐）；await 兼容两种形态。
                // （v3 d.ts 未公开 objs，运行时存在——这里按实测形状取用）
                const objs = (page as unknown as { objs?: { get(id: string): unknown } }).objs
                if (!objs) break
                data = (await objs.get(objId)) as PdfDecodedImage | null
              } catch {
                /* 对象缺失：跳过这张（页内可能有多张，其余照常） */
              }
            } else if (
              fn === pdfjs.OPS.paintInlineImageXObject ||
              (pdfjs.OPS.paintInlineImageXObjectGroup !== undefined && fn === pdfjs.OPS.paintInlineImageXObjectGroup)
            ) {
              // 防御分支：部分 pdfjs 代码路径（worker 的 addImageOps）会把内嵌图直发 OPS 86/87，
              // 位图挂在 args[0] 不走 objs 缓存；group 变体（args[0]=imgData, args[1]=map）同取首参。
              // ⚙️ 实测：本仓库 v3 对 BI/ID/EI 实际转译成 paintImageXObject+objs（S17 探针），
              // 主路径在上面的 XObject 分支；两条都接住，不赌 pdfjs 内部实现形态。
              const direct = ops.argsArray[i][0] as PdfDecodedImage | null | undefined
              if (direct && typeof direct.width === 'number' && direct.data) data = direct
            }
            if (!data) continue
            if (!data.width || !data.height || !data.data) continue
            if (data.width < SCAN_MIN_IMAGE_DIMENSION || data.height < SCAN_MIN_IMAGE_DIMENSION) {
              log(`[scan] 第 ${p} 页跳过 ${data.width}x${data.height} 小图（装饰性/印章类）`)
              continue
            }
            let bitmap: { width: number; height: number; rgba: Uint8Array }
            try {
              bitmap = imgDataToRgba(data)
            } catch (e) {
              log(`[scan] 第 ${p} 页图像位图异常，跳过：${e instanceof Error ? e.message : String(e)}`)
              continue
            }
            const scaled = downscaleNearest(bitmap, limits.maxImageDimension)
            const png = encodePng(scaled)
            const dataUri = `data:image/png;base64,${png.toString('base64')}`
            images.push({
              page: p,
              mime: 'image/png',
              dataUri,
              bytes: dataUri.length,
              width: scaled.width,
              height: scaled.height,
              downscaled: scaled.downscaled
            })
          }
        } finally {
          page.cleanup()
        }
      }
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError(
        ERROR_CODES.FILE_PARSE_ERROR,
        `扫描 PDF 图像提取失败: ${basename(filePath)} — ${e instanceof Error ? e.message : String(e)}`,
        { path: filePath, kind: 'pdf', reason: 'page-image-extract-failed' }
      )
    } finally {
      try {
        await doc?.destroy()
      } catch {
        /* 关闭失败不影响已取出的位图 */
      }
    }
    return images
  }

  /** 资料图文件（png/jpg/webp）→ 单张图。**MIME 按魔数**，不信任扩展名；尺寸 best-effort（读不出=0） */
  function rasterizeImageFile(
    filePath: string
  ): Array<Omit<ScanImage, 'imageInPage' | 'imagesOnPage' | 'totalPages'>> {
    const buf = readFileSync(filePath)
    const hit = SCAN_IMAGE_MAGIC.find((m) => m.test(buf))
    if (!hit) {
      throw new AppError(
        ERROR_CODES.FILE_PARSE_ERROR,
        `文件内容不是受支持的图片格式（png/jpg/webp）: ${basename(filePath)}`,
        { path: filePath, kind: 'image', reason: 'not-an-image' }
      )
    }
    const dataUri = `data:${hit.mime};base64,${buf.toString('base64')}`
    const dims = readImageDimensions(buf, hit.mime)
    return [
      {
        page: 1,
        mime: hit.mime,
        dataUri,
        bytes: dataUri.length,
        width: dims.width,
        height: dims.height,
        downscaled: false
      }
    ]
  }

  function resolveKind(typeHint: string | undefined, filePath: string): 'pdf' | 'image' {
    const ext = extname(filePath).toLowerCase()
    const byExt = SCAN_FILE_KIND_BY_EXT[ext]
    const hint = typeof typeHint === 'string' && typeHint.trim() ? typeHint.trim().toLowerCase() : null
    if (hint && hint !== 'pdf' && hint !== 'image') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `识别类型只支持 pdf/image（实际 ${hint}）`, {
        field: 'type',
        allowed: ['pdf', 'image']
      })
    }
    if (!byExt) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `不支持识别该文件类型：${ext || '（无扩展名）'}（仅 ${Object.keys(SCAN_FILE_KIND_BY_EXT).join(' / ')}）`,
        {
          field: 'filePath',
          extension: ext,
          allowed: Object.keys(SCAN_FILE_KIND_BY_EXT),
          reason: 'unsupported-file-type'
        }
      )
    }
    if (hint && hint !== byExt) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `文件类型与实际不符：${basename(filePath)} 是 ${byExt}，不能按 ${hint} 识别`,
        { field: 'type', declared: hint, actual: byExt }
      )
    }
    return byExt
  }

  return {
    recognize,
    cancelTask: (taskId: string) => {
      const id = typeof taskId === 'string' ? taskId.trim() : ''
      const entry = id ? activeTasks.get(id) : undefined
      if (!entry) return false
      return entry.cancel() // 幂等：重复取消第二次返回 false（与 abort IPC 的 aborted:false 同语义）
    },
    cancelByProject: (projectId: string) => {
      const pid = typeof projectId === 'string' ? projectId.trim() : ''
      if (!pid) return 0
      let n = 0
      for (const [, entry] of [...activeTasks]) {
        if (entry.projectId !== pid) continue
        try {
          if (entry.cancel()) n += 1 // 只数首次作废的（幂等重试不重复计数）
        } catch {
          /* 尽力中止 */
        }
      }
      return n
    },
    cancelAll() {
      let count = 0
      for (const [, entry] of activeTasks) {
        try {
          if (entry.cancel()) count += 1 // 已被 forward.cancel() 命中过的任务不再重复计数
        } catch {
          /* 忽略：尽力中止 */
        }
      }
      activeTasks.clear()
      return count
    },
    activeTaskCount: () => activeTasks.size
  }
}

// ── 消息组装与文本整理（纯函数，验收直接断言） ──────────────────────────────

export function buildPageMessages(baseName: string, kind: 'pdf' | 'image', img: ScanImage): GatewayChatMessage[] {
  const pageClause =
    kind === 'pdf' && img.totalPages > 1 ? `第 ${img.page} 页（共 ${img.totalPages} 页）` : `《${baseName}》`
  const partClause = img.imagesOnPage > 1 ? `（本页第 ${img.imageInPage}/${img.imagesOnPage} 张图）` : ''
  const instruction = `这是文档${pageClause}${partClause ? ` ${partClause}` : ''}的扫描件图像。请忠实转录${
    img.imagesOnPage > 1 ? '这张图' : '这一页'
  }中的全部文字。`
  return [
    { role: 'system', content: OCR_GUARDRAILS },
    { role: 'user', content: [textPart(instruction), imageDataPart(img.dataUri)] }
  ]
}

/** 模型常见脏输出整理：剥代码块围栏 + 首尾空白（**不改写正文**，保真优先） */
export function normalizeRecognizedText(raw: string): string {
  return String(raw ?? '')
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

/**
 * 汇总：多页 PDF 带页分节头（与 05a 的 pdf 文字层抽取形态一致）；单图裸文本。
 * **按页归组**——同页多图的多条文本合并进同一节（外部复审：不许出现重复的【第 N 页】）。
 * 返回的文本不含任何进度标记（标记只存在于直播流增量里）。
 */
export function assembleText(kind: 'pdf' | 'image', pages: ScanPageText[]): string {
  if (!pages.length) return ''
  const groups: Array<{ page: number; parts: string[] }> = []
  for (const p of pages) {
    const last = groups[groups.length - 1]
    if (last && last.page === p.page) last.parts.push(p.text)
    else groups.push({ page: p.page, parts: [p.text] })
  }
  if (kind === 'image' || groups.length === 1) return groups[0].parts.join('\n')
  return groups.map((g) => `【第 ${g.page} 页】\n${g.parts.join('\n')}`).join('\n\n')
}

/**
 * 剥除直播流里的过程性标记（【正在识别…】/重试提示），产出「像文档原文」的文本。
 * 权威汇总（result.text）本来就不含标记；这里兜底「中止后没有 done 替换」的场景。
 * ⚠️ store 侧 `PRICE_SUSPECT_REGEX` 同款双份纪律：正则字面量由 test/scan.accept.mjs 比对同源。
 */
export function stripProgressMarkers(raw: string): string {
  return String(raw ?? '')
    .replace(SCAN_PROGRESS_MARKER_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 本地确定性「疑似价格」检测（§七：价格类不得盲信模型识别 → UI 显著提示人工核对） */
export function detectPriceSuspect(text: string): boolean {
  return PRICE_SUSPECT_PATTERN.test(String(text ?? ''))
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'recognize 需要 projectId', { field: 'projectId' })
  }
  return value.trim()
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `recognize 需要 ${field}`, { field })
  }
  return value.trim()
}

function nameWithoutExtension(name: string): string {
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  return base.trim() || name
}

function positiveOr(value: unknown, def: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
}

/** 零依赖读图片尺寸：png=IHDR、jpeg=SOF 段扫描；webp 一期不解析（回 0，UI 不显示尺寸） */
export function readImageDimensions(
  buf: Buffer,
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
): { width: number; height: number } {
  try {
    if (mime === 'image/png' && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (mime === 'image/jpeg' && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) {
          p += 1
          continue
        }
        const marker = buf[p + 1]
        // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15：携带尺寸
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) }
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          p += 2
          continue
        }
        const len = buf.readUInt16BE(p + 2)
        if (len < 2) break
        p += 2 + len
      }
    }
  } catch {
    /* 尺寸只是元信息：读不出不影响识别请求本身 */
  }
  return { width: 0, height: 0 }
}
