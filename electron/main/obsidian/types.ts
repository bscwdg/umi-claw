/**
 * Obsidian 知识库集成的类型定义。
 * - ObsidianConfig：用户在配置页填写的 Obsidian 设置，持久化进 app.json
 * - ObsidianIndexStatus / ObsidianIndexProgress：索引运行时状态，由 indexer 子进程产出
 */

/** embedding 请求格式适配器（见 embeddings.mjs 的 adapter 分派） */
export type EmbeddingAdapter = 'openai' | 'cohere' | 'local'

/**
 * embedding 来源：
 * - preset：复用模型配置的 provider（云端）
 * - custom：直填 baseUrl/key/model（任意外部服务）
 * - local：本机下载并加载的小模型（不随安装包，运行时在数据目录）
 */
export type EmbeddingSource = 'preset' | 'custom' | 'local'

/** 本地模型选择（只存 id/version；绝对路径按 dataDir 推导，数据目录可搬移） */
export interface LocalEmbeddingConfig {
  modelId: string
  version: string
}

/** 本地模型安装进度（主进程 → 渲染端事件） */
export interface LocalModelProgress {
  phase: 'downloading' | 'verifying' | 'installing' | 'self_test' | 'done' | 'error'
  downloadedBytes: number
  totalBytes: number
  /** 当前文件（相对包根路径） */
  file?: string
  message?: string
}

/** 本地模型安装状态（知识库页展示） */
export interface LocalModelStatus {
  /** 运行时与模型都已安装且状态文件存在 */
  installed: boolean
  installing: boolean
  runtime: { id: string; version: string } | null
  model: { id: string; version: string; name: string; dim: number; sizeBytes: number } | null
  progress: LocalModelProgress | null
  lastError: string | null
  /** 应用内置清单里的可安装项（即使未安装也返回，供 UI 显示大小/名称） */
  available: {
    modelId: string
    version: string
    name: string
    dim: number
    sizeBytes: number
    totalDownloadBytes: number
  } | null
  /** 平台是否受支持（当前仅 win32-x64） */
  supported: boolean
}

/** Obsidian 配置（持久化于 app.json 的 obsidian 字段） */
export interface ObsidianConfig {
  /** 是否启用 Obsidian MCP 集成（启用后写入 openclaw.json 的 mcp.servers.obsidian） */
  enabled: boolean
  /** Obsidian vault 根目录绝对路径 */
  vaultPath: string

  /** embedding 来源：preset 复用模型配置的 provider；custom 直填凭据接任意服务 */
  embeddingSource: EmbeddingSource

  // ── preset 模式字段 ──
  /** embedding 凭据来源：复用 AppConfig.providers[].id */
  embeddingProviderId: string
  /** embedding 模型 id（如 text-embedding-v3、bge-m3） */
  embeddingModel: string
  /** embedding 请求格式适配器，默认 openai */
  embeddingAdapter: EmbeddingAdapter

  // ── custom 模式字段（不依赖任何 provider，直填即可用） ──
  customEmbedding?: {
    baseUrl: string
    apiKey: string
    model: string
    dim: number
    adapter: EmbeddingAdapter
  }

  // ── local 模式字段（只存选择；模型/运行时在 <dataDir>/models/embedding/） ──
  localEmbedding?: LocalEmbeddingConfig

  /** 单块目标字符数，默认 800 */
  chunkSize?: number
  /** 单篇笔记最大切块数，防止超大笔记拖垮索引，默认 50 */
  maxChunksPerNote?: number
  /** 主动检索：开启后模型无需用户点名，问题可能相关即自动调用 search_notes，默认 true */
  proactiveSearch?: boolean
}

/** 索引状态快照（从向量库 meta 表与文件计数派生） */
export interface ObsidianIndexStatus {
  indexing: boolean
  noteCount: number
  chunkCount: number
  lastIndexedAt: number | null
  dbSizeBytes: number
  embeddingModel: string | null
  /** source+model+adapter 组合签名，用于判断是否换过 embedding（换过需清库重建） */
  embeddingSignature: string | null
  embeddingDim: number | null
  vaultPath: string | null
  lastError: string | null
  /** 超出切块上限被截断的笔记路径（上次索引） */
  truncatedFiles: string[]
  /** 上次索引中 embedding 失败的笔记及错误信息 */
  embedErrors: Array<{ file: string; error: string }>
}

/** indexer 子进程通过 stdout 上报的进度事件 */
export interface ObsidianIndexProgress {
  phase: 'scanning' | 'embedding' | 'writing' | 'truncated' | 'done' | 'error'
  processed: number
  total: number
  message?: string
}

/** 检索测试单条命中（search.mjs 产出，与 mcp-server search_notes 同链路） */
export interface ObsidianSearchHit {
  filePath: string
  headingPath: string | null
  content: string
  tags: string[]
  /** cosine 相似度 0..1 */
  score: number
}

/** embedding 模型预设（modelConfig 里导出，供前端下拉选择） */
export interface EmbeddingPreset {
  id: string
  name: string
  /** 对应 AppConfig.providers[].id，用于取 baseUrl/apiKey */
  providerId: string
  modelId: string
  dim: number
  /** 请求格式适配器，默认 openai */
  adapter: EmbeddingAdapter
}
