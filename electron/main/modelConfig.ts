// mainConfig.ts
// 存放默认模型配置格式，已对齐各厂商 2026 年 6 月最新官方接口规范

// ===================== 1. 百炼（DashScope 兼容模式）=====================
const QWEN_BAILIAN_DEFAULT_PROVIDERS = {
  bailian: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "YOUR_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "qwen3.6-plus",
        name: "qwen3.6-plus",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { thinkingFormat: "openai" },
      },
      {
        id: "MiniMax-M2.5",
        name: "MiniMax-M2.5",
        reasoning: false,
        input: ["text"],
        contextWindow: 204800,
        maxTokens: 131072,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "glm-5",
        name: "glm-5",
        reasoning: false,
        input: ["text"],
        contextWindow: 202752,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { thinkingFormat: "openai" },
      },
      {
        id: "deepseek-v3.2",
        name: "deepseek-v3.2",
        reasoning: false,
        input: ["text"],
        contextWindow: 163840,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { thinkingFormat: "openai" },
      },
    ],
  },
};

// ===================== 2. DeepSeek 官方 =====================
const DEEPSEEK_DEFAULT_PROVIDERS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 384000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 384000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 3. 火山方舟（Agent Plan）=====================
const VOLCENGINE_DEFAULT_PROVIDERS = {
  "volcengine-agent-plan": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    apiKey: "<ARK_API_KEY>",
    api: "openai-completions",
    models: [
      {
        id: "doubao-seed-2.1",
        name: "Doubao Seed 2.1",
        contextWindow: 256000,
        maxTokens: 64000,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "ark-code-latest",
        name: "ark-code-latest",
        contextWindow: 256000,
        maxTokens: 32000,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "glm-5.2",
        name: "glm-5.2",
        contextWindow: 1024000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "glm-latest",
        name: "glm-latest",
        contextWindow: 1024000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        contextWindow: 1024000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-pro",
        name: "deepseek-v4-pro",
        contextWindow: 1024000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-code",
        name: "doubao-seed-2.0-code",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-pro",
        name: "doubao-seed-2.0-pro",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-lite",
        name: "doubao-seed-2.0-lite",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-mini",
        name: "doubao-seed-2.0-mini",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "minimax-m2.7",
        name: "minimax-m2.7",
        contextWindow: 200000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "minimax-m3",
        name: "minimax-m3",
        contextWindow: 512000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "kimi-k2.6",
        name: "kimi-k2.6",
        contextWindow: 256000,
        maxTokens: 32000,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "kimi-k2.7-code",
        name: "kimi-k2.7-code",
        contextWindow: 256000,
        maxTokens: 32000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 4. Kimi（月之暗面）=====================
const KIMI_DEFAULT_PROVIDERS = {
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: "sk-你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        contextWindow: 262144,
        maxTokens: 256000,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        contextWindow: 262144,
        maxTokens: 262144,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 5. 通义千问 DashScope =====================
const QWEN_DASHSCOPE_PROVIDERS = {
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "qwen3.7-max",
        name: "Qwen3.7-Max",
        contextWindow: 1000000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "qwen3.7-plus",
        name: "Qwen3.7-Plus",
        contextWindow: 1000000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "qwen3.6-flash",
        name: "Qwen3.6-Flash",
        contextWindow: 1000000,
        maxTokens: 32768,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "qwen3.5-plus",
        name: "Qwen3.5-Plus",
        contextWindow: 1000000,
        maxTokens: 32768,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "qwen3.5-flash",
        name: "Qwen3.5-Flash",
        contextWindow: 1000000,
        maxTokens: 32768,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 6. 豆包旧版方舟 =====================
const DOUBAO_ARK_PROVIDERS = {
  volcengine: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "<ARK_API_KEY>",
    api: "openai-completions",
    models: [
      // ========== 推荐：动态演进模型（始终指向最新版本） ==========
      {
        id: "doubao-seed-evolving",
        name: "Doubao Seed Evolving",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== 豆包 Seed 系列（具体版本） ==========
      {
        id: "doubao-seed-1.6",
        name: "Doubao Seed 1.6",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.1",
        name: "Doubao Seed 2.1",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2-1-pro-260628",
        name: "Doubao Seed 2.1 Pro",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2-1-turbo-260628",
        name: "Doubao Seed 2.1 Turbo",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-pro",
        name: "Doubao Seed 2.0 Pro",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-code",
        name: "Doubao Seed 2.0 Code",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-lite",
        name: "Doubao Seed 2.0 Lite",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "doubao-seed-2.0-mini-260428",
        name: "Doubao Seed 2.0 Mini",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== DeepSeek 系列 ==========
      {
        id: "deepseek-ai/deepseek-r1:7b",
        name: "DeepSeek R1 7B",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-ai/deepseek-r1:32b",
        name: "DeepSeek R1 32B",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-ai/deepseek-r1:671b",
        name: "DeepSeek R1 671B",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-ai/deepseek-v3:671b",
        name: "DeepSeek V3 671B",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== GLM 系列 ==========
      {
        id: "glm-4.7",
        name: "GLM 4.7",
        contextWindow: 1024000,
        maxTokens: 65536,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== Kimi 系列 ==========
      {
        id: "kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        contextWindow: 256000,
        maxTokens: 32000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== MiniMax 系列 ==========
      {
        id: "minimax-m3",
        name: "MiniMax M3",
        contextWindow: 512000,
        maxTokens: 65536,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== 视觉/多模态模型 ==========
      {
        id: "doubao-vision-pro-32k-241028",
        name: "Doubao Vision Pro",
        contextWindow: 32000,
        maxTokens: 4096,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // ========== 向量化模型 ==========
      {
        id: "ark/doubao-embedding-large",
        name: "Doubao Embedding Large",
        contextWindow: 4096,
        maxTokens: 4096,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 7. 智谱 GLM =====================
const ZHIPU_DEFAULT_PROVIDERS = {
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "glm-5.2",
        name: "GLM-5.2",
        contextWindow: 1000000,
        maxTokens: 128000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "glm-5.1",
        name: "GLM-5.1",
        contextWindow: 200000,
        maxTokens: 128000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "glm-5",
        name: "GLM-5",
        contextWindow: 200000,
        maxTokens: 128000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "glm-5-turbo",
        name: "GLM-5-Turbo",
        contextWindow: 200000,
        maxTokens: 128000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 8. MiniMax =====================
const MINIMAX_DEFAULT_PROVIDERS = {
  minimax: {
    baseUrl: "https://api.minimax.chat/v1",
    apiKey: "你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "MiniMax-M3",
        name: "MiniMax M3",
        contextWindow: 1000000,
        maxTokens: 128000,
        input: ["text", "image", "video"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        contextWindow: 204800,
        maxTokens: 131072,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "MiniMax-M2.7-highspeed",
        name: "MiniMax M2.7 Highspeed",
        contextWindow: 204800,
        maxTokens: 131072,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 9. 硅基流动 =====================
const SILICONFLOW_DEFAULT_PROVIDERS = {
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "sk-你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-ai/DeepSeek-V4",
        name: "DeepSeek V4",
        contextWindow: 1000000,
        maxTokens: 16384,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "Pro/Qwen3.7-70B",
        name: "Qwen3.7 70B",
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 10. OpenAI =====================
const OPENAI_DEFAULT_PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 11. Anthropic =====================
const ANTHROPIC_DEFAULT_PROVIDERS = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-你的API密钥",
    api: "anthropic-messages",
    models: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextWindow: 200000,
        maxTokens: 128000,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};



const LONGCAT_DEFAULT_PROVIDERS = {
  "longCat": {
    "baseUrl": "https://api.longcat.chat/openai",
    "apiKey": "YOUR_API_KEY",
    "api": "openai-completions",
    "authHeader": true,
    "models": [
      {
        "id": "LongCat-2.0",
        "name": "LongCat-2.0",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "compat": {
          "maxTokensField": "max_tokens"
        }
      }
    ]
  }
}

// ===================== 12. 自定义（本地） =====================
const CUSTOM_DEFAULT_PROVIDERS = {
  custom: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    api: "openai-completions",
    models: [
      {
        id: "llama3",
        name: "Llama 3",
        contextWindow: 8192,
        maxTokens: 4096,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

// ===================== 统一导出（关键修正） =====================
// 为了使 DEFAULT_PROVIDERS 中的 configName 能直接匹配到配置，
// 将每个配置对象以其 configName 作为键导出，并直接指向内层配置（而非再套一层）
export const OFFICIAL_MODEL_PRESETS: Record<string, any> = {
  DEEPSEEK_DEFAULT_PROVIDERS: DEEPSEEK_DEFAULT_PROVIDERS.deepseek,
  DOUBAO_ARK_PROVIDERS: DOUBAO_ARK_PROVIDERS.volcengine,
  VOLCENGINE_DEFAULT_PROVIDERS: VOLCENGINE_DEFAULT_PROVIDERS['volcengine-agent-plan'],
  QWEN_DASHSCOPE_PROVIDERS: QWEN_DASHSCOPE_PROVIDERS.qwen,
  QWEN_BAILIAN_DEFAULT_PROVIDERS: QWEN_BAILIAN_DEFAULT_PROVIDERS.bailian,
  ZHIPU_DEFAULT_PROVIDERS: ZHIPU_DEFAULT_PROVIDERS.zhipu,
  KIMI_DEFAULT_PROVIDERS: KIMI_DEFAULT_PROVIDERS.kimi,
  MINIMAX_DEFAULT_PROVIDERS: MINIMAX_DEFAULT_PROVIDERS.minimax,
  SILICONFLOW_DEFAULT_PROVIDERS: SILICONFLOW_DEFAULT_PROVIDERS.siliconflow,
  OPENAI_DEFAULT_PROVIDERS: OPENAI_DEFAULT_PROVIDERS.openai,
  ANTHROPIC_DEFAULT_PROVIDERS: ANTHROPIC_DEFAULT_PROVIDERS.anthropic,
  LONGCAT_DEFAULT_PROVIDERS: LONGCAT_DEFAULT_PROVIDERS.longCat,
  CUSTOM_DEFAULT_PROVIDERS: CUSTOM_DEFAULT_PROVIDERS.custom,
};

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
