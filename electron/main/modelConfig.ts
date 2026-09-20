// mainConfig.ts
// 官方模型预设已外置为 JSON（模型更新快，不再硬编码进发版流程）：
//   - 内置快照：resources/model-presets/model-presets.json（随包分发，出厂即有完整预设）
//   - 上游源：https://gitee.com/bscwdg/awesome-llm-models（国内直连，raw 地址匿名可读）
//   - 数据目录 overlay：<dataDir>/model-presets.json（「拉取最新」成功后落盘，优先于快照）
// 加载 / 校验 / 在线拉取逻辑见 ./modelPresets（ModelPresetService）。
// OFFICIAL_MODEL_PRESETS 保持同名导出：启动与每次拉取成功后由 loader **就地重填**
// （消费方 configManager 均按键取值，引用不变），键 = AppConfig.providers[].configName。

export const OFFICIAL_MODEL_PRESETS: Record<string, any> = {}

// ===================== OpenClaw 外部 provider 命名避让 =====================
// OpenClaw（2026.7 起）会把配置里出现的 provider id / 别名（按小写匹配）
// 视为“官方外部 provider 插件”，启动时强制执行
// `plugins install @openclaw/<id>-provider`。这些插件将 openclaw 声明为
// peerDependency，需要在插件目录内建立 node_modules/openclaw 的 junction 链接，
// 而在 U 盘 / 移动硬盘 / 网络盘（exFAT/FAT32/UNC）上无法创建 junction，
// 从而导致 missing-openclaw-peer-link，网关启动失败。
// 我们的 longCat/deepseek/kimi 等都是内联的 openai-completions provider（已自带
// baseUrl+apiKey），本不需要外部插件。因此写入 openclaw.json 时，把会与该
// 目录冲突的 provider key / 模型前缀 / env 变量名统一改成带前缀的安全名，
// 绕开这个自动安装机制（功能不受影响，仍是普通内联 provider）。
export const RESERVED_OPENCLAW_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'amazon-bedrock', 'amazon-bedrock-mantle', 'anthropic-vertex', 'arcee', 'cerebras',
  'chutes', 'cloudflare-ai-gateway', 'codex', 'cohere', 'deepinfra', 'deepseek',
  'featherless', 'fireworks', 'gmi', 'groq', 'kilocode', 'kimi', 'longcat', 'meta',
  'moonshot', 'pixverse', 'qianfan', 'qwen', 'qwen-oauth', 'stepfun', 'stepfun-plan',
  'tencent', 'tencent-tokenhub', 'tencent-tokenplan', 'venice', 'vercel-ai-gateway', 'zai',
  'gmi-cloud', 'gmicloud', 'meituan-longcat', 'kimi-coding', 'qwencloud', 'modelstudio',
  'dashscope', 'qwen-portal', 'qwen-cli', 'fireworks-ai', 'moonshotai', 'moonshot-ai',
  'z-ai', 'z.ai',
])

export const SAFE_PROVIDER_KEY_PREFIX = 'umiclaw-'

/** Add a safe prefix when a provider key would collide with the OpenClaw external provider catalog; otherwise return as-is. */
export function toOpenClawProviderKey(rawKey: string): string {
  const key = (rawKey || '').trim()
  if (!key) return key
  return RESERVED_OPENCLAW_PROVIDER_IDS.has(key.toLowerCase())
    ? SAFE_PROVIDER_KEY_PREFIX + key
    : key
}

/** Whether a provider key (models.providers key or model prefix) would trigger external plugin install. */
export function isReservedOpenClawProviderKey(rawKey: string): boolean {
  const key = (rawKey || '').trim().toLowerCase()
  return key.length > 0 && RESERVED_OPENCLAW_PROVIDER_IDS.has(key)
}

/**
 * Prune conflicting leftovers in openclaw.json that trigger external provider plugin installs:
 *  - models.providers keys matching a reserved id
 *  - agents.defaults.models "provider/model" prefixes matching a reserved id
 * Safe to delete because we now write providers under the safe key.
 */
export function pruneReservedOpenClawProviderRefs(config: any): void {
  if (!config || typeof config !== 'object') return
  const providers = config.models && config.models.providers
  if (providers && typeof providers === 'object') {
    for (const key of Object.keys(providers)) {
      if (isReservedOpenClawProviderKey(key)) delete providers[key]
    }
  }
  const models = config.agents && config.agents.defaults && config.agents.defaults.models
  if (models && typeof models === 'object') {
    for (const key of Object.keys(models)) {
      const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : key
      if (isReservedOpenClawProviderKey(prefix)) delete models[key]
    }
  }
}

// ===================== Embedding 预设 =====================
// 供前端「知识库」页选择 embedding 模型。providerId 对应 AppConfig.providers[].id，
// 选中后把 providerId 与 modelId 写入 ObsidianConfig；运行时由 indexer/mcp-server
// 从对应 provider 取 baseUrl + apiKey 调用 embedding 接口。
//
// adapter 标注请求/响应格式（见 resources/obsidian/embeddings.mjs 的 adapter 分派）：
//   - 'openai'  OpenAI 兼容 /v1/embeddings，{model,input} -> data[].embedding
//               百炼/智谱/硅基/豆包/OpenAI/Mistral/Jina/Voyage/Moonshot/本地(Ollama 兼容端点) 通用
//   - 'cohere'  Cohere 专有 /v1/embed，{texts,model,input_type,embedding_types} -> embeddings[]
//
// ⚠️ 收录原则：provider 必须已在 AppConfig.providers 中配置。项目未内置的 provider
// (Mistral/Jina/Voyage/Cohere/Google/百度/腾讯等) 用「自定义 embedding」模式直填凭据接入，
// 不进预设列表--避免预设里出现选了却取不到凭据的项。
export const EMBEDDING_PRESETS = [
  // ====== 阿里云百炼（OpenAI 兼容） ======
  // bailian 走 DashScope OpenAI 兼容端点，可用 embedding。
  // bailian-token-plan 的 baseUrl 是 .../apps/anthropic（Anthropic 协议专用），
  // 不提供 /embeddings，故不收录其 embedding 预设，避免选了调不通。
  { id: 'bailian-text-embedding-v3', name: '通义千问 text-embedding-v3 (1024维)', providerId: 'bailian', modelId: 'text-embedding-v3', dim: 1024, adapter: 'openai' },
  { id: 'bailian-text-embedding-v4', name: '通义千问 text-embedding-v4 (1536维)', providerId: 'bailian', modelId: 'text-embedding-v4', dim: 1536, adapter: 'openai' },

  // ====== 智谱 AI（OpenAI 兼容） ======
  { id: 'zhipu-embedding-2', name: '智谱 embedding-2 (1024维)', providerId: 'zhipu', modelId: 'embedding-2', dim: 1024, adapter: 'openai' },
  { id: 'zhipu-embedding-3', name: '智谱 embedding-3 (2048维)', providerId: 'zhipu', modelId: 'embedding-3', dim: 2048, adapter: 'openai' },

  // ====== 硅基流动（开源 BGE 系列聚合，OpenAI 兼容） ======
  { id: 'siliconflow-bge-m3', name: '硅基流动 BAAI/bge-m3 (1024维·多语种)', providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dim: 1024, adapter: 'openai' },
  { id: 'siliconflow-bge-large-zh-v1-5', name: '硅基流动 bge-large-zh-v1.5 (1024维·中文优化)', providerId: 'siliconflow', modelId: 'bge-large-zh-v1.5', dim: 1024, adapter: 'openai' },
  { id: 'siliconflow-bge-m3-v2', name: '硅基流动 bge-m3-v2 (1024维·多语种升级)', providerId: 'siliconflow', modelId: 'BAAI/bge-m3-v2', dim: 1024, adapter: 'openai' },

  // ====== 豆包（火山方舟，OpenAI 兼容） ======
  // 项目有两个火山方舟 provider，baseUrl 不同，必须按用户填 key 的那个选对应预设：
  //   - volcengine            旧版方舟  ark.cn-beijing.volces.com/api/v3     (DOUBAO_ARK_PROVIDERS)
  //   - volcengine-agent-plan  套餐版    ark.cn-beijing.volces.com/api/plan/v3 (VOLCENGINE_DEFAULT_PROVIDERS)
  // 两者的 embedding 模型 id 通用（doubao-embedding-*），但 baseUrl 不互通，选错会连不上。
  { id: 'volcengine-doubao-embedding', name: '豆包 doubao-embedding-large (2048维)', providerId: 'volcengine', modelId: 'doubao-embedding-large', dim: 2048, adapter: 'openai' },
  { id: 'volcengine-doubao-embedding-v2', name: '豆包 doubao-embedding-v2 (1536维)', providerId: 'volcengine', modelId: 'doubao-embedding-v2', dim: 1536, adapter: 'openai' },
  { id: 'volcengine-agent-plan-doubao-embedding', name: '火山方舟(套餐) doubao-embedding-large (2048维)', providerId: 'volcengine-agent-plan', modelId: 'doubao-embedding-large', dim: 2048, adapter: 'openai' },
  { id: 'volcengine-agent-plan-doubao-embedding-v2', name: '火山方舟(套餐) doubao-embedding-v2 (1536维)', providerId: 'volcengine-agent-plan', modelId: 'doubao-embedding-v2', dim: 1536, adapter: 'openai' },
  { id: 'volcengine-agent-plan-doubao-embedding-vision', name: '火山方舟(套餐) doubao-embedding-vision (1024维·多模态)', providerId: 'volcengine-agent-plan', modelId: 'doubao-embedding-vision', dim: 1024, adapter: 'openai' },

  // ====== OpenAI（OpenAI 兼容） ======
  { id: 'openai-text-embedding-3-small', name: 'OpenAI text-embedding-3-small (1536维)', providerId: 'openai', modelId: 'text-embedding-3-small', dim: 1536, adapter: 'openai' },
  { id: 'openai-text-embedding-3-large', name: 'OpenAI text-embedding-3-large (3072维)', providerId: 'openai', modelId: 'text-embedding-3-large', dim: 3072, adapter: 'openai' },

  // ====== 本地（Ollama 等，走 OpenAI 兼容端点 :11434/v1） ======
  // 需在「模型配置」的「自定义」provider 里填好 baseUrl（默认 http://localhost:11434/v1）
  // 并在本地服务中拉取对应 embedding 模型（如 ollama pull bge-m3 / nomic-embed-text）
  { id: 'local-bge-m3', name: '本地 bge-m3 (1024维·Ollama)', providerId: 'custom', modelId: 'bge-m3', dim: 1024, adapter: 'openai' },
  { id: 'local-nomic-embed-text', name: '本地 nomic-embed-text (768维·Ollama)', providerId: 'custom', modelId: 'nomic-embed-text', dim: 768, adapter: 'openai' },
] as const

/**
 * 不提供 embedding 接口的服务商 id 集合。
 * 这些 provider 即便在模型配置里填了 key，也调不出 embedding--前端据此提示用户。
 * 原因：DeepSeek / Kimi / MiniMax / LongCat / Anthropic 官方仅提供对话/补全，无 embedding 服务；
 *       bailian-token-plan 的 baseUrl 是 Anthropic 协议专用端点，无 /embeddings。
 */
export const PROVIDERS_WITHOUT_EMBEDDING: ReadonlySet<string> = new Set([
  'deepseek', 'kimi', 'minimax', 'longCat', 'anthropic', 'bailian-token-plan'
])
