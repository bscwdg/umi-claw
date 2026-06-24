// mainConfig.ts存放默认模型配置格式,对齐官方配置防止启动失败

const QWEN_BAILIAN_DEFAULT_PROVIDERS = {
  "bailian": {
    "baseUrl": "https://dashscope.aliyuncs.com/apps/anthropic",
    "apiKey": "YOUR_API_KEY",
    "api": "anthropic-messages",
    "models": [
      {
        "id": "qwen3.6-plus",
        "name": "qwen3.6-plus",
        "reasoning": false,
        "input": ["text", "image"],
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "compat": { "thinkingFormat": "openai" }
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 204800,
        "maxTokens": 131072,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
      },
      {
        "id": "glm-5",
        "name": "glm-5",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 202752,
        "maxTokens": 16384,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "compat": { "thinkingFormat": "openai" }
      },
      {
        "id": "deepseek-v3.2",
        "name": "deepseek-v3.2",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 163840,
        "maxTokens": 16384,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "compat": { "thinkingFormat": "openai" }
      }
    ]
  }
};

const DEEPSEEK_DEFAULT_PROVIDERS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-你的API密钥", // 建议通过环境变量设置
    api: "openai-completions",
    models: [
      {
        // 高性能旗舰模型，适合复杂任务
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true, // 支持思考模式
        input: ["text"],
        contextWindow: 1000000, // 100万上下文[reference:7][reference:8]
        maxTokens: 384000,
      },
      {
        // 高性价比模型，适合日常对话和轻量任务[reference:9]
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 384000,
      },
    ],
  },
};

const VOLCENGINE_DEFAULT_PROVIDERS = {
  "volcengine-agent-plan": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    apiKey: "<ARK_API_KEY>",
    api: "openai-completions",
    "models": [
      {
        "id": "ark-code-latest",
        "name": "ark-code-latest",
        "contextWindow": 256000,
        "maxTokens": 32000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "glm-5.2",
        "name": "glm-5.2",
        "contextWindow": 1024000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "glm-latest",
        "name": "glm-latest",
        "contextWindow": 1024000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-v4-flash",
        "name": "deepseek-v4-flash",
        "contextWindow": 1024000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "deepseek-v4-pro",
        "name": "deepseek-v4-pro",
        "contextWindow": 1024000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "doubao-seed-2.0-code",
        "name": "doubao-seed-2.0-code",
        "contextWindow": 256000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "doubao-seed-2.0-pro",
        "name": "doubao-seed-2.0-pro",
        "contextWindow": 256000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "doubao-seed-2.0-lite",
        "name": "doubao-seed-2.0-lite",
        "contextWindow": 256000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "doubao-seed-2.0-mini",
        "name": "doubao-seed-2.0-mini",
        "contextWindow": 256000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "minimax-m2.7",
        "name": "minimax-m2.7",
        "contextWindow": 200000,
        "maxTokens": 65536,
        "input": [
          "text"
        ]
      },
      {
        "id": "minimax-m3",
        "name": "minimax-m3",
        "contextWindow": 512000,
        "maxTokens": 65536,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "kimi-k2.6",
        "name": "kimi-k2.6",
        "contextWindow": 256000,
        "maxTokens": 32000,
        "input": [
          "text",
          "image"
        ]
      },
      {
        "id": "kimi-k2.7-code",
        "name": "kimi-k2.7-code",
        "contextWindow": 256000,
        "maxTokens": 32000,
        "input": [
          "text"
        ]
      }
    ]
  },
};

// Kimi (月之暗面) – 最新 kimi-k2 系列
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
        maxTokens: 32768,
        input: ["text", "image"],
      },
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        contextWindow: 262144,
        maxTokens: 16384,
        input: ["text", "image"],
      },
    ],
  },
};

// 通义千问 DashScope 兼容模式 – 使用 qwen3 系列
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
      },
      {
        id: "qwen3.7-plus",
        name: "Qwen3.7-Plus",
        contextWindow: 1000000,
        maxTokens: 65536,
        input: ["text", "image"],
      },
      {
        id: "qwen3.6-flash",
        name: "Qwen3.6-Flash",
        contextWindow: 1000000,
        maxTokens: 32768,
        input: ["text", "image"],
      },
    ],
  },
};

// 豆包旧版方舟 – 更新为当前主流 doubao-seed-2.0 系列
const DOUBAO_ARK_PROVIDERS = {
  doubao: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "<ARK_API_KEY>",
    api: "openai-completions",
    models: [
      {
        id: "doubao-seed-2.0-pro",
        name: "Doubao Seed 2.0 Pro",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
      },
      {
        id: "doubao-seed-2.0-code",
        name: "Doubao Seed 2.0 Code",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
      },
      {
        id: "doubao-seed-2.0-lite",
        name: "Doubao Seed 2.0 Lite",
        contextWindow: 256000,
        maxTokens: 65536,
        input: ["text", "image"],
      },
    ],
  },
};

// 智谱 GLM – 最新 GLM-5 系列
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
        maxTokens: 16384,
        input: ["text"],
      },
      {
        id: "glm-5.1",
        name: "GLM-5.1",
        contextWindow: 202752,
        maxTokens: 16384,
        input: ["text"],
      },
      {
        id: "glm-5",
        name: "GLM-5",
        contextWindow: 202752,
        maxTokens: 16384,
        input: ["text"],
      },
    ],
  },
};

// MiniMax – 最新 M2.5/M3
const MINIMAX_DEFAULT_PROVIDERS = {
  minimax: {
    baseUrl: "https://api.minimax.chat/v1",
    apiKey: "你的API密钥",
    api: "openai-completions",
    models: [
      {
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        contextWindow: 204800,
        maxTokens: 131072,
        input: ["text"],
      },
      {
        id: "minimax-m3",
        name: "MiniMax M3",
        contextWindow: 512000,
        maxTokens: 65536,
        input: ["text", "image"],
      },
    ],
  },
};

// 硅基流动 – 当前热门的推理模型
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
      },
      {
        id: "Pro/Qwen3.7-70B",
        name: "Qwen3.7 70B",
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text"],
      },
    ],
  },
};

// OpenAI – 保留 gpt-4o-mini 并添加可能的新模型
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
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text", "image"],
      },
    ],
  },
};

// Anthropic – 只保留最新的 Sonnet 4.6，修正 baseUrl 和协议
const ANTHROPIC_DEFAULT_PROVIDERS = {
  anthropic: {
    baseUrl: "https://api.anthropic.com", // 注意：Anthropic API 通常不带 /v1
    apiKey: "sk-ant-你的API密钥",
    api: "anthropic-messages",
    models: [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
        maxTokens: 4096,
        input: ["text", "image"],
      },
    ],
  },
};

// 自定义（本地模型）不变
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
      },
    ],
  },
};
// 统一导出
export const OFFICIAL_MODEL_PRESETS: Record<string, any> = {
  'deepseek': DEEPSEEK_DEFAULT_PROVIDERS,
  'doubao': DOUBAO_ARK_PROVIDERS,
  'volcengine-plan': VOLCENGINE_DEFAULT_PROVIDERS,
  'qwen': QWEN_DASHSCOPE_PROVIDERS,
  'bailian-token-plan': QWEN_BAILIAN_DEFAULT_PROVIDERS,
  'zhipu': ZHIPU_DEFAULT_PROVIDERS,
  'kimi': KIMI_DEFAULT_PROVIDERS,
  'minimax': MINIMAX_DEFAULT_PROVIDERS,
  'siliconflow': SILICONFLOW_DEFAULT_PROVIDERS,
  'openai': OPENAI_DEFAULT_PROVIDERS,
  'anthropic': ANTHROPIC_DEFAULT_PROVIDERS,
  'custom': CUSTOM_DEFAULT_PROVIDERS
};