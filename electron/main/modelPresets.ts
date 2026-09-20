// modelPresets.ts —— 官方模型预设的加载与在线更新（模型外置化）
//
// 数据来源链（优先级从高到低）：
//   1. <dataDir>/model-presets.json   「拉取最新」成功后落盘的 overlay（断网后重启仍可用）
//   2. resources/model-presets/model-presets.json   随包分发的内置快照（全新安装、从未联网）
//   3. 空（软降级：服务商列表仍由 DEFAULT_PROVIDERS 保证，仅模型预设为空）
//
// 上游源为 Gitee 公开仓库 raw 地址：公开仓库匿名可读，普通用户拉取不需要任何账号/令牌；
// 仅维护者向仓库推送更新时需要认证。拉取仅由用户点击「拉取最新」触发，无启动自动请求。
//
// 校验失败 / 网络失败一律不动本地数据与内存预设；apply 通过后**就地重填**
// OFFICIAL_MODEL_PRESETS（消费方 configManager 按键取值，引用不变，即时生效）。
import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { OFFICIAL_MODEL_PRESETS } from './modelConfig'

export const MODEL_PRESETS_RAW_URL =
  'https://gitee.com/bscwdg/awesome-llm-models/raw/master/model-presets.json'

const OVERLAY_FILE_NAME = 'model-presets.json' // 相对 <dataDir> 根
const BUNDLED_REL_PATH = join('resources', 'model-presets', 'model-presets.json')
const FETCH_TIMEOUT_MS = 15_000
const MAX_JSON_BYTES = 2 * 1024 * 1024 // 2MB 上限，防异常大响应
const MAX_PROVIDERS = 64
const MAX_MODELS_PER_PROVIDER = 512
// configName / providerId 的合法字符集（防路径注入与原型污染键）
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 预设条目元数据：用于把「拉取来的新服务商」合成进 providers 列表 */
export interface PresetMetaEntry {
  providerId: string
  label: string
}

export interface PresetInfo {
  source: 'overlay' | 'bundled' | 'empty'
  updatedAt: string
  providerCount: number
}

export interface RefreshResult {
  success: boolean
  error?: string
  /** 内容与本地一致，未做任何写入 */
  unchanged?: boolean
  /** overlay 是否写盘成功；false = 内存预设已生效但落盘失败，重启后会回退（success 仍为 true，不谎报失败） */
  persisted?: boolean
  updatedAt?: string
  providerCount?: number
  /** 本次新合入 providers 列表的动态服务商（由 ConfigManager 拉取成功后填充） */
  addedProviders?: Array<{ id: string; label: string }>
}

interface RawPresetDoc {
  version?: unknown
  updatedAt?: unknown
  providers?: unknown
}

/**
 * 官方模型预设服务：本地加载（overlay → 内置快照）+ 在线拉取 + 校验 + 就地刷新。
 * 生命周期挂在 ConfigManager（dataDir 由其解析，天然继承 CLAW_DATA_DIR/便携模式）。
 */
export class ModelPresetService {
  private overlayPath: string
  private meta: Record<string, PresetMetaEntry> = {}
  private info: PresetInfo = { source: 'empty', updatedAt: '', providerCount: 0 }
  /** 最近一次成功 apply 的原始文档（用于拉取后的 unchanged 判定） */
  private rawDoc: RawPresetDoc | null = null
  private inFlight: Promise<RefreshResult> | null = null

  constructor(dataDir: string) {
    this.overlayPath = join(dataDir, OVERLAY_FILE_NAME)
  }

  /** 启动时调用：按 overlay → 内置快照 → 空的顺序加载，失败软降级不抛出 */
  loadLocal(): void {
    if (existsSync(this.overlayPath)) {
      try {
        const doc = JSON.parse(readFileSync(this.overlayPath, 'utf-8'))
        // 本地 overlay 与远程同标准：损坏半写、手改、或未来新写入口都可能产出畸形
        // 数据（非法 id / 明文 http baseUrl / __proto__ 键等）。校验器现成，一律过
        // validateDoc——与远程输入共用同一条信任边界；失败按损坏处理（改名留证 + 回退）
        const problem = validateDoc(doc)
        if (problem) throw new Error(`校验失败：${problem}`)
        this.apply(doc, 'overlay')
        return
      } catch (err) {
        console.warn('[ModelPresets] 数据目录 overlay 解析/校验失败，回退内置快照:', err)
        // 损坏文件改名留证（对齐 app.json 损坏备份的做法），避免每次启动重复报警
        try {
          renameSync(this.overlayPath, `${this.overlayPath}.corrupt-${Date.now()}`)
          this._pruneCorruptBackups()
        } catch { /* ignore */ }
      }
    }

    const bundledPath = app.isPackaged
      ? join(process.resourcesPath, BUNDLED_REL_PATH)
      : join(app.getAppPath(), BUNDLED_REL_PATH)
    if (existsSync(bundledPath)) {
      try {
        const doc = JSON.parse(readFileSync(bundledPath, 'utf-8'))
        // 内置快照同样过校验（随包资源只读，不做改名留证）
        const problem = validateDoc(doc)
        if (problem) throw new Error(`校验失败：${problem}`)
        this.apply(doc, 'bundled')
        return
      } catch (err) {
        console.warn('[ModelPresets] 内置快照解析/校验失败，预设为空:', err)
      }
    }

    this.info = { source: 'empty', updatedAt: '', providerCount: 0 }
  }

  /** 损坏留证只保留最近 1 份（含刚改名这份），反复损坏时避免 .corrupt-* 无限累积 */
  private _pruneCorruptBackups(): void {
    try {
      const stale = readdirSync(dirname(this.overlayPath))
        .filter((f) => f.startsWith(`${OVERLAY_FILE_NAME}.corrupt-`))
        .sort()
        .slice(0, -1)
      for (const f of stale) unlinkSync(join(dirname(this.overlayPath), f))
    } catch { /* 清理失败不影响加载 */ }
  }

  /**
   * 从 Gitee raw 拉取最新预设。成功且通过校验后：内容有变化才写 overlay 并刷新内存。
   * 任何失败（网络/格式/校验）都不触碰本地数据与内存预设。
   */
  async fetchLatest(): Promise<RefreshResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this._doFetch().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async _doFetch(): Promise<RefreshResult> {
    let res: Response
    try {
      // cache-buster：绕开 Gitee raw 的 CDN 缓存，保证拉到刚推送的内容
      res = await fetch(`${MODEL_PRESETS_RAW_URL}?t=${Date.now()}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (err) {
      return { success: false, error: `网络请求失败：${err instanceof Error ? err.message : err}` }
    }
    if (!res.ok) {
      return { success: false, error: `远端返回 HTTP ${res.status}` }
    }
    // 防 https → http 降级：Gitee raw 正常 302 到 https CDN，终态必为 https。
    // 请求不携带任何凭据，终态协议校验足以保证响应体来自 TLS 连接。
    try {
      const finalUrl = new URL(res.url || MODEL_PRESETS_RAW_URL)
      if (finalUrl.protocol !== 'https:') {
        return { success: false, error: '重定向到非 HTTPS 地址，已拒绝' }
      }
    } catch {
      return { success: false, error: '最终响应地址非法，已拒绝' }
    }
    const declaredLen = Number(res.headers.get('content-length') || 0)
    if (declaredLen > MAX_JSON_BYTES) {
      return { success: false, error: '响应体积超出上限，已拒绝' }
    }
    let text: string
    try {
      text = await res.text()
    } catch (err) {
      return { success: false, error: `读取响应失败：${err instanceof Error ? err.message : err}` }
    }
    if (text.length > MAX_JSON_BYTES) {
      return { success: false, error: '响应体积超出上限，已拒绝' }
    }
    let doc: RawPresetDoc
    try {
      doc = JSON.parse(text)
    } catch {
      return { success: false, error: '返回内容不是合法 JSON' }
    }
    // 校验失败直接返回，本地数据与内存分毫不动
    const problem = validateDoc(doc)
    if (problem) return { success: false, error: `远端数据校验失败：${problem}` }

    // 内容与当前一致：跳过写盘
    if (this.rawDoc && JSON.stringify(doc) === JSON.stringify(this.rawDoc)) {
      return { success: true, unchanged: true, updatedAt: this.info.updatedAt, providerCount: this.info.providerCount }
    }

    this.apply(doc, 'overlay')
    // 原子写 overlay（tmp + rename；exFAT 等文件系统 rename 覆盖失败时回退直写）
    const content = JSON.stringify(doc, null, 2) + '\n'
    const tmpPath = `${this.overlayPath}.tmp.${process.pid}.${Date.now()}`
    let persisted = true
    try {
      writeFileSync(tmpPath, content, 'utf-8')
      try {
        renameSync(tmpPath, this.overlayPath)
      } catch {
        writeFileSync(this.overlayPath, content, 'utf-8')
        try { if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.stale`) } catch { /* ignore */ }
      }
    } catch (err) {
      // 内存预设已生效但磁盘仍旧：重启会回退内置快照。不谎报「完全成功」，
      // 用 persisted:false 让调用方提示用户（有 fallback 合成兜底，不会崩）
      persisted = false
      console.error('[ModelPresets] 写入 overlay 失败（内存预设已生效）:', err)
    }
    return { success: true, persisted, updatedAt: this.info.updatedAt, providerCount: this.info.providerCount }
  }

  /** 校验通过后清空并就地重填 OFFICIAL_MODEL_PRESETS（剥离 providerId/label 元数据） */
  private apply(doc: RawPresetDoc, source: PresetInfo['source']): void {
    const providers = doc.providers as Record<string, any>
    // 防御性再挡：即使未来新增写入口绕过 validateDoc，也不让原型污染键
    // 进入预设/meta 对象（赋值 __proto__ 键会静默替换对象自身原型链）。
    // 在清空既有预设**之前**抛出，保持「任一条目不合法即整体拒绝」的原子语义
    for (const key of Object.keys(providers)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`非法键: ${key}`)
    }
    for (const k of Object.keys(OFFICIAL_MODEL_PRESETS)) delete OFFICIAL_MODEL_PRESETS[k]
    this.meta = {}
    for (const [key, entry] of Object.entries(providers)) {
      const { providerId, label, ...body } = entry
      OFFICIAL_MODEL_PRESETS[key] = body
      this.meta[key] = { providerId: String(providerId), label: String(label) }
    }
    this.rawDoc = doc
    this.info = {
      source,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
      providerCount: Object.keys(providers).length
    }
  }

  getMeta(): Record<string, PresetMetaEntry> {
    return this.meta
  }

  getInfo(): PresetInfo {
    return { ...this.info }
  }
}

/** 整文档校验：任一条目不合法即整体拒绝（原子语义，避免半新半旧） */
function validateDoc(doc: RawPresetDoc): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return '根节点必须是对象'
  if (doc.version !== 1) return `不支持的 version: ${String(doc.version)}`
  const providers = doc.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return 'providers 必须是对象'
  const keys = Object.keys(providers)
  if (keys.length === 0) return 'providers 不能为空'
  if (keys.length > MAX_PROVIDERS) return `服务商数量超过上限 ${MAX_PROVIDERS}`
  const seenProviderIds = new Set<string>()
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) return `非法键: ${key}`
    if (!ID_RE.test(key)) return `configName 不合法: ${key}`
    const entry = (providers as Record<string, any>)[key]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${key}: 条目必须是对象`
    if (typeof entry.providerId !== 'string' || !ID_RE.test(entry.providerId)) return `${key}: providerId 不合法`
    // providerId 会成为 providers 列表行 id 与 openclaw provider key，重复会导致互相覆盖
    if (seenProviderIds.has(entry.providerId)) return `${key}: providerId 重复: ${entry.providerId}`
    seenProviderIds.add(entry.providerId)
    if (typeof entry.label !== 'string' || !entry.label.trim()) return `${key}: label 不能为空`
    if (typeof entry.baseUrl !== 'string' || !/^https?:\/\//.test(entry.baseUrl)) return `${key}: baseUrl 必须是 http(s) 地址`
    // 供应链防护：非本机 baseUrl 强制 https——用户会向该地址发送 apiKey，
    // 且预设源是无签名的公开仓库，必须挡住被篡改数据里的 http 窃密端点
    let parsedBaseUrl: URL
    try {
      parsedBaseUrl = new URL(entry.baseUrl)
    } catch {
      return `${key}: baseUrl 不是合法 URL`
    }
    const isLoopback = parsedBaseUrl.hostname === 'localhost'
      || parsedBaseUrl.hostname === '127.0.0.1'
      || parsedBaseUrl.hostname === '::1'
      || parsedBaseUrl.hostname === '[::1]'
    if (parsedBaseUrl.protocol !== 'https:' && !isLoopback) return `${key}: 非本机 baseUrl 必须使用 https`
    if (typeof entry.api !== 'string' || !entry.api.trim()) return `${key}: api 不能为空`
    if (typeof entry.apiKey !== 'string') return `${key}: apiKey 必须是字符串（占位符）`
    if (!Array.isArray(entry.models)) return `${key}: models 必须是数组`
    if (entry.models.length === 0) return `${key}: models 不能为空`
    if (entry.models.length > MAX_MODELS_PER_PROVIDER) return `${key}: 模型数量超过上限 ${MAX_MODELS_PER_PROVIDER}`
    const seenModelIds = new Set<string>()
    for (const m of entry.models) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return `${key}: models 含非法条目`
      if (typeof m.id !== 'string' || !m.id.trim()) return `${key}: 存在缺少 id 的模型`
      if (seenModelIds.has(m.id)) return `${key}: 模型 id 重复: ${m.id}`
      seenModelIds.add(m.id)
    }
  }
  return null
}
