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