import { app,dialog } from 'electron'
import { join, dirname, basename, resolve, sep } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, renameSync, rmSync } from 'fs'
import AdmZip from 'adm-zip'
import { OFFICIAL_MODEL_PRESETS, toOpenClawProviderKey, pruneReservedOpenClawProviderRefs, isReservedOpenClawProviderKey } from './modelConfig'
import { ModelPresetService, type PresetInfo, type RefreshResult } from './modelPresets'
import { GATEWAY_TOKEN, openClawPaths } from './openClawPaths'
import type { ObsidianConfig } from './obsidian/types'

/**
 * 技能版本 manifest 的单条记录（skill-manifest.json）。
 * key 为 zip 文件名 stem（与云端 versions.json 的 key 一致，作为唯一锚点）；
 * 磁盘目录名与 openclaw.json skills.entries 的键一律用 actualDir。
 */
export interface SkillManifestEntry {
  /** 安装/更新时的版本号；取不到记 'unknown' */
  version: string
  /** 安装/更新时间（ISO 字符串） */
  installedAt: string
  /** 实际落盘目录名（规范包按 zip 顶层目录名落盘，可能与 key 不同） */
  actualDir: string
}

export interface PresetModel {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  compat?: Record<string, any>
  [key: string]: any
}

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean,
  configName: string,
  customModels?: PresetModel[]
  /** Provider 请求超时（秒），写入 openclaw.json 的 models.providers.<id>.timeoutSeconds；国内模型卡顿建议调大 */
  timeoutSeconds?: number
  /** 获取模型列表的接口地址：完整 URL 或路径（如 /models），留空默认 {baseUrl}/models，仅本应用测试/拉取用 */
  modelsListUrl?: string
}

export interface AppConfig {
  activeProvider: string
  providers: ModelProvider[]
  port: number
  autoStart: boolean
  launchOnBoot: boolean
  minimizeToTray: boolean
  closeAction: 'ask' | 'tray' | 'exit'
  useChineseMirror: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  language: 'zh-CN' | 'en-US'
  theme: string
  themeBase?: string
  themeAccent?: string
  channels?: Record<string, Record<string, unknown>>
  obsidian?: ObsidianConfig
}

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4-flash',
    enabled: true,
    configName: 'DEEPSEEK_DEFAULT_PROVIDERS',
  },
  {
    id: 'volcengine', //
    name: '豆包 (字节跳动)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    model: 'doubao-seed-evolving', // 🔧 修正：原 doubao-seed-evolving 已失效
    enabled: false,
    configName: 'DOUBAO_ARK_PROVIDERS',
  },
  {
    id: 'volcengine-agent-plan',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKey: '',
    model: 'ark-code-latest',
    enabled: false,
    configName: 'VOLCENGINE_DEFAULT_PROVIDERS',
  },
  {
    id: 'bailian', // ✅ 保持原样，不改为 qwen
    name: '通义千问 (阿里云)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen3.7-max',
    enabled: false,
    configName: 'QWEN_DASHSCOPE_PROVIDERS',
  },
  {
    id: 'bailian-token-plan',
    name: '千问百炼 (阿里云)',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    apiKey: '',
    // 🔧 对齐预设清单：QWEN_BAILIAN_DEFAULT_PROVIDERS 只有 qwen3.6-plus/MiniMax-M2.5/glm-5/deepseek-v3.2，
    // 原默认 qwen3.7-max 未声明（那是通义千问 QWEN_DASHSCOPE 的模型），激活不换模型会指向不存在的 primary
    model: 'qwen3.6-plus',
    enabled: false,
    configName: 'QWEN_BAILIAN_DEFAULT_PROVIDERS',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-5.2', // 🔧 修正：原 glm-4-flash 已下线，换为最新旗舰 5.2
    enabled: false,
    configName: 'ZHIPU_DEFAULT_PROVIDERS',
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: 'kimi-k2.6', // 🔧 修正：原 moonshot-v1-8k 已弃用，换为 k2.6
    enabled: false,
    configName: 'KIMI_DEFAULT_PROVIDERS',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKey: '',
    model: 'MiniMax-M3', // 🔧 修正：原 abab6.5s-chat 已退役，换为 M3（1M/多模态）
    enabled: false,
    configName: 'MINIMAX_DEFAULT_PROVIDERS',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'deepseek-ai/DeepSeek-V4', // 🔧 建议优化：原 Qwen2.5 过旧，换为热门 DeepSeek V4
    enabled: false,
    configName: 'SILICONFLOW_DEFAULT_PROVIDERS',
  },
  {
    id: 'longCat',
    name: '美团',
    baseUrl: 'https://api.longcat.chat/openai', 
    apiKey: '',
    model: 'LongCat-2.0',
    enabled: false,
    configName: 'LONGCAT_DEFAULT_PROVIDERS',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    enabled: false,
    configName: 'OPENAI_DEFAULT_PROVIDERS',
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    baseUrl: 'https://api.anthropic.com', // 🔧 修正：去掉 /v1，官方标准 BaseUrl 不带
    apiKey: '',
    model: 'claude-sonnet-4-6',
    enabled: false,
    configName: 'ANTHROPIC_DEFAULT_PROVIDERS',
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    model: 'llama3',
    enabled: false,
    configName: 'CUSTOM_DEFAULT_PROVIDERS',
  },
];

// 使用深拷贝函数确保默认配置不会被意外修改
const getDeepCopyDefaultConfig = (): AppConfig => ({
  activeProvider: 'deepseek',
  providers: DEFAULT_PROVIDERS.map(p => ({ ...p })),
  port: 3213,
  autoStart: false,
  launchOnBoot: false,
  minimizeToTray: true,
  closeAction: 'ask',
  useChineseMirror: true,
  logLevel: 'info',
  language: 'zh-CN',
  theme: 'dark'
})

const DEFAULT_CONFIG = getDeepCopyDefaultConfig()

export class ConfigManager {
  private dataDir: string
  private configPath: string
  private config: AppConfig
  private openClawConfigPath: string
  private portableSkillsDir: string
  /** 技能版本 manifest（记录云端同步/导入的技能版本，供更新比对） */
  private skillManifestPath: string
  /** 官方模型预设服务（overlay → 内置快照加载 + 「拉取最新」在线更新） */
  private modelPresets: ModelPresetService
  /** Obsidian MCP 注入器：返回 mcp.servers.obsidian 配置，未启用返回 null */
  private obsidianMcpInjector: (() => Record<string, unknown> | null) | null = null

  setObsidianMcpInjector(fn: (() => Record<string, unknown> | null) | null): void {
    this.obsidianMcpInjector = fn
  }

  constructor() {
    // 确定数据目录
    // 优先级：CLAW_DATA_DIR 环境变量 > 便携模式 > 默认规则
    // - 便携模式：exe 同级存在 data 文件夹时启用（U 盘携带等场景），
    //   数据跟随程序，更新直接替换程序文件即可
    // - 普通安装默认：%APPDATA%\UmiClaw\data（与安装目录分离，
    //   NSIS 更新时会清空安装目录，数据放安装目录内会被删、也容易被其他程序占用卡住更新）
    // - 设置 CLAW_DATA_DIR 可让本地安装版与开发环境共享同一份 data，
    //   便于使用 openclaw（需通过带环境变量的启动脚本运行，避免双实例同时写同一份数据）
    const envDataDir = process.env.CLAW_DATA_DIR
    if (envDataDir) {
      this.dataDir = envDataDir
    } else if (app.isPackaged) {
      const exePath = app.getPath('exe')
      const portableDataDir = join(dirname(exePath), 'data')
      if (existsSync(portableDataDir)) {
        // 便携模式（U 盘等）：exe 同级存在 data 时数据跟随程序走，
        // 更新时直接替换程序文件即可，数据目录原地不动
        this.dataDir = portableDataDir
      } else {
        // 普通安装：%APPDATA%\UmiClaw\data
        this.dataDir = join(app.getPath('appData'), 'UmiClaw', 'data')
      }
    } else {
      // 开发环境：项目根目录下的 data 文件夹
      this.dataDir = join(process.cwd(), 'data')
    }

    // 设置配置文件路径
    this.configPath = join(this.dataDir, 'config', 'app.json')
    this.openClawConfigPath = openClawPaths.openClawConfig(this.dataDir)
    this.portableSkillsDir = openClawPaths.portableSkillsDir(this.dataDir)
    this.skillManifestPath = openClawPaths.skillManifest(this.dataDir)
    // 初始化目录结构
    this._ensureDirectories()

    // 加载官方模型预设（overlay → 内置快照）。必须先于 _load()：
    // _load 的动态服务商合并依赖预设 meta
    this.modelPresets = new ModelPresetService(this.dataDir)
    this.modelPresets.loadLocal()

    // 加载配置
    this.config = this._load()

    // 初始同步 OpenClaw 配置
    this._syncOpenClawConfig()
  }

  /**
   * 获取当前配置的深拷贝，防止外部修改内部状态
   */
  getConfig(): AppConfig {
    return JSON.parse(JSON.stringify(this.config))
  }

  /**
   * 保存部分配置更新
   * @param partial 部分配置对象
   * @returns 更新后的完整配置
   */
  saveConfig(partial: Partial<AppConfig>): AppConfig {
    // 1. 深度合并基础字段
    this.config = {
      ...this.config,
      ...partial,
      // 2. 安全深拷贝处理 providers
      providers: partial.providers
        ? partial.providers.map(p => ({ ...p }))
        : this.config.providers
    }

    // 3. 必须恢复 app.json 本身的持久化写入
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err) {
      console.error('[ConfigManager] 保存 app.json 失败:', err)
    }

    // 4. 同步衍生配置
    this._syncOpenClawConfig()

    return this.getConfig()
  }

  /**
   * 重置配置为默认值
   */
  resetConfig(): AppConfig {
    this.config = getDeepCopyDefaultConfig()
    // 恢复默认不丢「拉取最新」带来的动态服务商（DEFAULT_CONFIG 是静态快照，不含动态项）
    this._appendDynamicPresetProviders(this.config.providers)
    // this._persist()
    this._syncOpenClawConfig()
    return this.getConfig()
  }

  getDataDir(): string {
    return this.dataDir
  }

  /**
   * 同步 openclaw.json，供启动流程在 spawn 前调用，确保凭证/模型/渠道是最新的。
   * 内部等价于 _syncOpenClawConfig，对外暴露一个稳定入口，避免 clawManager 重复实现。
   */
  syncOpenClawConfig(): void {
    this._syncOpenClawConfig()
  }

  /**
   * 「拉取最新」：从 Gitee 上游拉取最新官方模型预设并立即生效（无需重启）。
   * 成功后把新增的动态服务商合并进 providers：有新增则 saveConfig({}) 持久化并
   * 同步 openclaw.json；无新增（仅模型更新）也重写 openclaw.json，让已填 key 的
   * provider 立即拿到新模型列表。失败时本地数据分毫不动。
   */
  async refreshModelPresets(): Promise<RefreshResult> {
    const result = await this.modelPresets.fetchLatest()
    if (result.success) {
      const added = this._appendDynamicPresetProviders(this.config.providers)
      if (added.length) {
        // saveConfig({}) 会把当前 providers 落盘并触发 _syncOpenClawConfig
        this.saveConfig({})
        result.addedProviders = added
      } else {
        this._syncOpenClawConfig()
      }
    }
    return result
  }

  /** 预设来源信息（overlay / 内置快照 / 空），供配置页展示 */
  getModelPresetsInfo(): PresetInfo {
    return this.modelPresets.getInfo()
  }

  /**
   * 把预设 meta 中的动态服务商追加进 providers 列表（幂等，两条 _load 返回路径与
   * resetConfig 共用）。只新增：同 configName 或同 id 已存在时跳过，
   * 永不覆盖用户已填 key 的行；持久化由调用方在 this.config 就绪后负责。
   * @returns 本次实际新增的 [providerId, label] 列表
   */
  private _appendDynamicPresetProviders(providers: ModelProvider[]): Array<{ id: string; label: string }> {
    const meta = this.modelPresets.getMeta()
    const added: Array<{ id: string; label: string }> = []
    for (const [configName, m] of Object.entries(meta)) {
      if (providers.some((p) => p.configName === configName || p.id === m.providerId)) continue
      const body = OFFICIAL_MODEL_PRESETS[configName]
      if (!body || !Array.isArray(body.models)) continue
      providers.push({
        id: m.providerId,
        name: m.label,
        baseUrl: String(body.baseUrl || ''),
        apiKey: '',
        model: body.models[0]?.id ? String(body.models[0].id) : '',
        enabled: false,
        configName,
      })
      added.push({ id: m.providerId, label: m.label })
    }
    return added
  }

  /**
   * 解析 provider 请求超时（秒）：合法正数采用用户值（上限 86400/天），
   * 无效或未填时默认 900 秒（15 分钟）。主路径与预设缺失的 fallback 路径共用，
   * 保证两种情况下写入 openclaw.json 的超时行为一致。
   */
  private _resolveTimeoutSeconds(p: ModelProvider): number {
    const timeoutSeconds = Number(p.timeoutSeconds)
    return Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.min(Math.round(timeoutSeconds), 86400)
      : 900
  }

  /**
   * 把用户自定义模型合并进预设模型列表（去重，自定义覆盖同 id 预设）。
   * 同时做 OpenClaw model schema 规范化：name 缺失/空白用 id 兜底；
   * input/contextWindow/maxTokens/cost 缺失补最小合法默认，避免自定义模型
   * 被网关 Zod 校验拒绝（仅补缺失项，用户显式值保留）。
   */
  private _mergeCustomModels(baseModels: any[], customModels?: PresetModel[]): any[] {
    const merged = Array.isArray(baseModels) ? baseModels.map((m) => ({ ...m })) : []
    if (!Array.isArray(customModels)) return merged
    for (const rawCm of customModels) {
      if (!rawCm || !rawCm.id) continue
      const cm = {
        input: ['text'],
        contextWindow: 8192,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...rawCm,
        name: (rawCm.name && String(rawCm.name).trim()) ? rawCm.name : rawCm.id,
      }
      const idx = merged.findIndex((m: any) => m && m.id === cm.id)
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], ...cm }
      } else {
        merged.push(cm)
      }
    }
    return merged
  }

  /**
   * 读取 modelConfig.ts 中某个服务商的官方预设模型列表
   * @param configName 例如 'DEEPSEEK_DEFAULT_PROVIDERS'
   * @returns 模型数组 [{ id, name, contextWindow, maxTokens, input, reasoning }]
   */
  getPresetModels(configName: string): Array<Record<string, any>> {
    const preset = OFFICIAL_MODEL_PRESETS[configName]
    if (!preset || !Array.isArray(preset.models)) {
      return []
    }
    return JSON.parse(JSON.stringify(preset.models))
  }

  getNodePath(): string {
    const platform = process.platform
    const arch = process.arch
    const nodeDir = join(this.dataDir, 'runtime', `node-${platform}-${arch}`)
    if (platform === 'win32') {
      return join(nodeDir, 'node.exe')
    }
    return join(nodeDir, 'bin', 'node')
  }

  /**
   * 安全读取并解析 openclaw.json；文件不存在或解析失败时返回传入的兜底对象
   * @param fallback 读取失败时返回的兜底配置
   * @param onError 解析失败时的可选日志回调
   */
  /**
   * Read and parse openclaw.json, tolerating a UTF-8 BOM prefix.
   * Some editors (e.g. Windows Notepad) or external writers may prepend a BOM,
   * which makes JSON.parse throw "Unexpected token". Strip it defensively.
   */
  private _parseOpenClawJsonRaw(): any {
    let text = readFileSync(this.openClawConfigPath, 'utf-8')
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1)
    }
    return JSON.parse(text)
  }
  private _readOpenClawConfig(fallback: any, onError?: (e: unknown) => void): any {
    if (!existsSync(this.openClawConfigPath)) {
      return fallback
    }
    try {
      const parsed = this._parseOpenClawJsonRaw()
      if (parsed && typeof parsed === 'object') {
        return parsed
      }
    } catch (e) {
      onError?.(e)
    }
    return fallback
  }

  /**
   * 读取当前安装的 OpenClaw 版本（`data/openclaw/node_modules/openclaw/package.json`）。
   *
   * 用途：写 `meta.lastTouchedVersion`（§九 待办 #15）。该字段语义是「最后写这份配置的
   * OpenClaw 版本」，写 'latest' 会被 schema 拒绝；读不到（未安装/文件损坏）返回 null，
   * 调用方据此不写该字段。**只读**，绝不修改 data/openclaw（硬规则 1）。
   */
  private _readInstalledOpenClawVersion(): string | null {
    try {
      const pkgPath = join(this.dataDir, 'openclaw', 'node_modules', 'openclaw', 'package.json')
      if (!existsSync(pkgPath)) return null
      const version = JSON.parse(readFileSync(pkgPath, 'utf-8'))?.version
      if (typeof version !== 'string') return null
      const trimmed = version.trim()
      return trimmed && trimmed !== 'latest' ? trimmed : null
    } catch {
      return null
    }
  }

  /**
   * 从 SKILL.md 的 YAML Front Matter 中解析指定字段
   * 支持 name: xxx、name: "xxx"、name: 'xxx' 三种写法
   * 只在前置 front-matter 区块（文件开头的 --- ... ---）内匹配：
   * 正文里出现的同名行（如文档示例中的 version:）不会被误取；嵌套缩进的
   * 子键（如 metadata.version）也不会被当成顶层字段；无 front-matter 区块返回 undefined。
   * @returns 解析到的值（已 trim），未匹配到返回 undefined
   */
  private _parseFrontMatterField(content: string, field: string): string | undefined {
    let text = content
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!block) return undefined
    const match = block[1].match(new RegExp(`^${field}:\\s*["']?(.*?)["']?\\s*(\\r?\\n|$)`, 'm'))
    return match && match[1] ? match[1].trim() : undefined
  }

  /**
   * Atomically write text to a path: write to a temp file then rename over the target.
   * Prevents readers from seeing a half-written file and reduces multi-writer races.
   */
  private _atomicWriteFileSync(targetPath: string, content: string): void {
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmpPath, content, 'utf-8')
    try {
      renameSync(tmpPath, targetPath)
    } catch (renameErr) {
      // 某些文件系统（exFAT/FAT32 等）对「rename 覆盖已存在文件」支持不佳，回退为直接写目标文件。
      // 回退写入成功即视为整体成功——不再抛出 rename 错误，否则调用方会误判「同步失败」而文件其实已落盘。
      try {
        writeFileSync(targetPath, content, 'utf-8')
      } finally {
        try { if (existsSync(tmpPath)) { renameSync(tmpPath, `${tmpPath}.stale`) } } catch { /* ignore */ }
      }
    }
  }

  /**
   * 确保所有必要的目录存在
   */
  private _ensureDirectories(): void {
    const dirs = [
      this.dataDir,
      join(this.dataDir, 'config'),
      openClawPaths.configDir(this.dataDir),
      this.portableSkillsDir,
      join(this.dataDir, 'logs')
    ]

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true })
        } catch (err) {
          console.error(`[ConfigManager] 创建目录失败: ${dir}`, err)
          // 如果关键目录创建失败，可能需要抛出错误或采取降级策略
          throw new Error(`Failed to create directory: ${dir}`)
        }
      }
    }
  }

  /**
   * 加载配置
   */
  private _load(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, 'utf-8')
        const saved = JSON.parse(raw) as Partial<AppConfig>

        // 验证基本结构，防止损坏的 JSON 导致崩溃
        if (!saved || typeof saved !== 'object') {
          throw new Error('Invalid config format')
        }

        // 合并默认值
        // 优化：增加对 saved.providers 元素的类型检查，防止脏数据导致崩溃
        const savedProviders = Array.isArray(saved.providers) ? saved.providers : []

        const mergedProviders = DEFAULT_PROVIDERS.map((def) => {
          const saved_p = savedProviders.find((p: any) => p && typeof p === 'object' && p.id === def.id)
          // 如果找到保存的配置且是对象，则合并，否则使用默认值
          return saved_p ? { ...def, ...saved_p } : def
        })
        // 追加保存了但不在 DEFAULT_PROVIDERS 里的 provider（例如「拉取最新」带来的
        // 新服务商）：否则重启时会被下面的默认合并静默丢弃，用户已填的 apiKey 随之丢失。
        // 只复活预设 meta 中仍存在的官方动态服务商（configName 或 providerId 命中），
        // 避免历史版本遗留的已下线 provider（UI 无删除入口）被静默永久带回列表
        const presetMeta = this.modelPresets.getMeta()
        const metaProviderIds = new Set(Object.values(presetMeta).map((m) => m.providerId))
        for (const sp of savedProviders) {
          if (!sp || typeof sp !== 'object') continue
          if (typeof sp.id !== 'string' || !sp.id) continue
          if (typeof sp.name !== 'string') continue
          const isDynamicPreset =
            (typeof sp.configName === 'string' && Object.prototype.hasOwnProperty.call(presetMeta, sp.configName)) ||
            metaProviderIds.has(sp.id)
          if (!isDynamicPreset) continue
          if (!mergedProviders.some((p) => p.id === sp.id)) {
            mergedProviders.push(sp as ModelProvider)
          }
        }
        // 合并「拉取最新」带来的动态服务商（幂等；只新增，永不覆盖已填 key 的行）
        this._appendDynamicPresetProviders(mergedProviders)
        return {
          ...DEFAULT_CONFIG,
          ...saved,
          providers: mergedProviders
        }
      }
    } catch (err) {
      console.warn('[ConfigManager] 加载配置失败，使用默认配置', err)
      // 备份损坏的文件以便调试
      try {
        const backupPath = `${this.configPath}.bak.${Date.now()}`
        if (existsSync(this.configPath)) {
          // 修复：使用导入的 copyFileSync 而不是动态 require
          copyFileSync(this.configPath, backupPath)
          console.log(`[ConfigManager] 已备份损坏的配置文件至: ${backupPath}`)
        }
      } catch (e) {
        // 忽略备份失败
        console.error('[ConfigManager] 备份配置文件失败', e)
      }
    }

    // 返回全新的默认配置副本
    const defaults = getDeepCopyDefaultConfig()
    this._appendDynamicPresetProviders(defaults.providers)
    return defaults
  }

  /**
   * 同步更新 OpenClaw 配置 (利用 mainConfig 里的官方标准模板完美对齐 Zod 结构)
   */
private _syncOpenClawConfig(): void {
  try {
    const workspacePath = join(openClawPaths.configDir(this.dataDir), 'workspace')

    let existingConfig: any = {
      agents: { defaults: {} },
      gateway: { mode: "local", auth: { mode: "token", token: GATEWAY_TOKEN } },
      channels: {},
      plugins: { entries: { "openclaw-weixin": { "enabled": true } } },
      skills: { entries: {} },
      wizard: {
        "lastRunAt": new Date().toISOString(),
        "lastRunVersion": "2026.6.8",
        "lastRunCommand": "doctor",
        "lastRunMode": "local"
      }
    }

    // 读取已有 openclaw.json：只读一次并复用解析结果，避免「守卫读一遍、兜底再读一遍」之间的
    // TOCTOU 窗口——若文件在两次读之间被截断，守卫通过而兜底返回骨架，反而会用骨架覆盖真实配置
    // （正是守卫想防的 clobber）。
    let parsedExisting: any = null
    if (existsSync(this.openClawConfigPath)) {
      try {
        parsedExisting = this._parseOpenClawJsonRaw()
        if (!parsedExisting || typeof parsedExisting !== 'object') parsedExisting = null
      } catch (parseErr) {
        console.error('[ConfigManager] openclaw.json parse failed; skip sync to avoid overwriting config with skeleton', parseErr)
        return
      }
    }
    existingConfig = parsedExisting || existingConfig

    // ----- 保证基础骨架存在 -----
    existingConfig.agents = existingConfig.agents || {}
    existingConfig.agents.defaults = existingConfig.agents.defaults || {}
    existingConfig.agents.defaults.workspace = workspacePath
    existingConfig.agents.defaults.models = existingConfig.agents.defaults.models || {}

    existingConfig.gateway = existingConfig.gateway || {}
    existingConfig.gateway.mode = "local"
    existingConfig.gateway.auth = existingConfig.gateway.auth || {}
    existingConfig.gateway.auth = {
      ...existingConfig.gateway.auth,
      mode: "token",
      token: GATEWAY_TOKEN
    }

    // ----- Gateway HTTP 端点开关（Commit 07：默认化 + 老用户迁移）-----
    // §六 实测：`gateway.http.endpoints.chatCompletions.enabled` 是 OpenAI 兼容面
    // （`GET /v1/models` / `POST /v1/chat/completions`）的总开关，默认 **false**
    // （关闭时 `/v1/models` → 404），且 `reloadKind = hot`（改完无需重启网关）。
    // AI 调用链（Commit 07/08/09）全部依赖它，所以由应用自己在这里写默认值——
    // 这正是配置生成与同步的唯一入口，新装与老用户（原本没有 http 段）同一条路径覆盖。
    // 幂等：只写这一个叶子键；`gateway` 段其余字段（含用户自加的）一律保留。
    existingConfig.gateway.http = existingConfig.gateway.http || {}
    existingConfig.gateway.http.endpoints = existingConfig.gateway.http.endpoints || {}
    const existingChatCompletions = existingConfig.gateway.http.endpoints.chatCompletions
    existingConfig.gateway.http.endpoints.chatCompletions = {
      ...(existingChatCompletions && typeof existingChatCompletions === 'object'
        ? existingChatCompletions
        : {}),
      enabled: true
    }

    existingConfig.models = existingConfig.models || {}
    existingConfig.models.mode = "merge"
    existingConfig.models.providers = existingConfig.models.providers || {}

    existingConfig.skills = existingConfig.skills || {}
    existingConfig.skills.entries = existingConfig.skills.entries || {}

    // ----- 🔥 核心改动：遍历 providers，使用 configName 从 OFFICIAL_MODEL_PRESETS 获取配置 -----
    const allProviders = this.config.providers || []
    for (const p of allProviders) {
      if (!p.apiKey || p.apiKey.trim() === '') {
        continue
      }

      // 直接用 configName 作为键（例如 'DEEPSEEK_DEFAULT_PROVIDERS'）获取预设
      const providerConfig = OFFICIAL_MODEL_PRESETS[p.configName]
      if (providerConfig) {
        const officialBody = JSON.parse(JSON.stringify(providerConfig)) // 深拷贝
        // 覆盖用户自定义的 baseUrl 和 apiKey
        officialBody.baseUrl = p.baseUrl || officialBody.baseUrl
        officialBody.apiKey = p.apiKey
        officialBody.api = officialBody.api || "openai-completions"
        // 请求超时：合法正数写入 provider 级 timeoutSeconds（OpenClaw 原生字段，
        // 国内慢模型卡顿可调大）；无效/未填时默认 900 秒（15 分钟），
        // 显式落盘保证默认值生效，也避免下方 {...旧值, ...officialBody}
        // 合并残留上次设置的旧超时
        officialBody.timeoutSeconds = this._resolveTimeoutSeconds(p)
        // 合并用户自定义模型（去重，自定义覆盖同 id 预设；并做 schema 规范化）
        officialBody.models = this._mergeCustomModels(
          Array.isArray(officialBody.models) ? officialBody.models : [],
          p.customModels
        )
        // 融合技能（如果预设中包含 skills）
        if (officialBody.skills) {
          const incomingSkills = officialBody.skills.entries || officialBody.skills
          existingConfig.skills.entries = {
            ...existingConfig.skills.entries,
            ...incomingSkills
          }
        }

        // 使用避让后的安全 key 作为 provider 的键（与后续 primary 拼接一致），
        // 避免与 OpenClaw 外部 provider 目录重名而触发插件强制安装。
        const providerKey = toOpenClawProviderKey(p.id)
        existingConfig.models.providers[providerKey] = {
          ...existingConfig.models.providers[providerKey],
          ...officialBody
        }
      } else {
        // 预设缺失（如内置快照损坏且从未拉取成功）：用 provider 自身数据合成最小 body，
        // 避免 keyed provider 从 openclaw.json 静默消失导致网关不可用
        console.warn(`[ConfigManager] 未找到 configName: ${p.configName} 对应的预设配置，使用 provider 数据合成最小配置`)
        // 与主路径保持一致：默认超时 900 秒，并合入用户自定义模型（schema 规范化），
        // 避免降级场景下行为分叉
        const fallbackBaseModels = p.model
          ? [{
              id: p.model,
              name: p.model,
              input: ['text'],
              contextWindow: 8192,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }]
          : []
        const fallbackBody: any = {
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          api: 'openai-completions',
          timeoutSeconds: this._resolveTimeoutSeconds(p),
          models: this._mergeCustomModels(fallbackBaseModels, p.customModels)
        }
        const fallbackKey = toOpenClawProviderKey(p.id)
        existingConfig.models.providers[fallbackKey] = {
          ...existingConfig.models.providers[fallbackKey],
          ...fallbackBody
        }
      }
    }

    // ----- 处理激活模型 Primary 与可切换范围 -----
    const activeProvider = this.config.providers.find((p) => p.id === this.config.activeProvider)
    const activeReady =
      activeProvider && activeProvider.model && activeProvider.apiKey && activeProvider.apiKey.trim() !== ''
    if (activeReady) {
      const pId = toOpenClawProviderKey(activeProvider.id)
      const fullModelKey = `${pId}/${activeProvider.model}`
      existingConfig.agents.defaults.model = { primary: fullModelKey }
      existingConfig.agents.defaults.models[fullModelKey] =
        existingConfig.agents.defaults.models[fullModelKey] || {}
    } else {
      // 激活方未配置 Key/模型：清掉可能残留的 primary，
      // OpenClaw 会从已配置 provider 回退解析默认模型
      delete existingConfig.agents.defaults.model
    }

    // 切换范围仅限当前激活服务商（产品决策）：modelPolicy.allow 写一条
    // <safeKey>/* 通配，OpenClaw 内用 /model 即可在该服务商的全部模型
    // （预设+自定义，见 models.providers）间切换，无需重启——网关会监听
    // openclaw.json 热加载。若不写 modelPolicy，单条 models 记录会被 OpenClaw
    // 按 legacy 规则迁移成单模型白名单，/model 切换会被直接拒绝。
    if (activeReady) {
      const pId = toOpenClawProviderKey(activeProvider.id)
      existingConfig.agents.defaults.modelPolicy = {
        ...(existingConfig.agents.defaults.modelPolicy || {}),
        allow: [`${pId}/*`]
      }
    } else {
      // 无激活服务商时清掉残留白名单，避免旧限制把 /model 锁死
      delete existingConfig.agents.defaults.modelPolicy
    }

    // ----- 清理累积残留（只写不清会导致 openclaw.json 持续膨胀）-----
    // 1) models.providers：以「当前已填 apiKey 的 provider 安全 key 集合」为白名单，
    //    删除曾启用、现已清空 key 或从列表移除的 provider 残留。保留 id 键已由
    //    pruneReservedOpenClawProviderRefs 处理，这里处理其余普通 provider。
    const liveProviderKeys = new Set(
      (this.config.providers || [])
        .filter(p => p.apiKey && p.apiKey.trim() !== '')
        .map(p => toOpenClawProviderKey(p.id))
    )
    if (existingConfig.models?.providers) {
      for (const key of Object.keys(existingConfig.models.providers)) {
        if (!liveProviderKeys.has(key) && !isReservedOpenClawProviderKey(key)) {
          // 保留 id 不删（交给 prune 流程统一判定），其余不在白名单的一律清理
          delete existingConfig.models.providers[key]
        }
      }
    }
    // 2) agents.defaults.models：只保留当前激活服务商的模型键，
    //    删除历史切换 provider 累积下来的旧模型键。
    {
      const keepKey = activeReady
        ? `${toOpenClawProviderKey(activeProvider.id)}/${activeProvider.model}`
        : null
      const modelsMap = existingConfig.agents?.defaults?.models
      if (modelsMap && typeof modelsMap === 'object') {
        for (const key of Object.keys(modelsMap)) {
          if (key !== keepKey && !isReservedOpenClawProviderKey(key.split('/')[0])) {
            delete modelsMap[key]
          }
        }
      }
    }

    // 清理多余字段
    if (existingConfig.models) delete existingConfig.models.timeout
    if (existingConfig.plugins) {
      delete existingConfig.plugins.bonjour
      delete (existingConfig.plugins as any)['talk-voice']

      // remove stale plugin entries that are actually model providers
      // (they live under models.providers, not as installed plugins)
      if (existingConfig.plugins.entries) {
        const providerIds = new Set((this.config.providers || []).map(p => p.id))
        for (const key of Object.keys(existingConfig.plugins.entries)) {
          if (providerIds.has(key)) {
            delete existingConfig.plugins.entries[key]
          }
        }
      }
    }

    // 自愈：清理旧版本/旧配置里会触发 OpenClaw 外部 provider 插件安装的冲突残留
    // （models.providers 下的保留 id 键、agents.defaults.models 下命中前缀的模型键）。
    pruneReservedOpenClawProviderRefs(existingConfig)

    // channel config injection (native channels such as feishu)
    existingConfig.channels = existingConfig.channels || {}

    // 兼容老版 feishu 插件：群白名单字段由 allowGroups 改名为 groupAllowFrom（v2026.6.x 起）。
    // openclaw.json 里残留的 allowGroups 会被新版 schema（additionalProperties:false）当作非法附加属性拒绝，
    // 导致网关启动失败（exit 78）。同步时迁移到新字段并删除旧字段；若已显式配置 groupAllowFrom 则不覆盖。
    const feishuExisting = existingConfig.channels.feishu
    if (feishuExisting && Array.isArray(feishuExisting.allowGroups)) {
      if (feishuExisting.groupAllowFrom === undefined) {
        feishuExisting.groupAllowFrom = feishuExisting.allowGroups
      }
      delete feishuExisting.allowGroups
    }

    const uiChannels = this.config.channels || {}
    const feishuCfg = uiChannels.feishu as Record<string, unknown> | undefined
    if (feishuCfg && feishuCfg.enabled) {
      const appId = String(feishuCfg.appId ?? '').trim()
      const appSecret = String(feishuCfg.appSecret ?? '').trim()
      if (appId && appSecret) {
        const feishu: Record<string, unknown> = {
          ...(existingConfig.channels.feishu || {}),
          appId,
          appSecret,
          dmPolicy: feishuCfg.dmPolicy || 'pairing',
          groupPolicy: feishuCfg.groupPolicy || 'allowlist',
          requireMention: feishuCfg.requireMention ?? true
        }
        const encryptKey = String(feishuCfg.encryptKey ?? '').trim()
        const verificationToken = String(feishuCfg.verificationToken ?? '').trim()
        if (encryptKey) feishu.encryptKey = encryptKey
        if (verificationToken) feishu.verificationToken = verificationToken
        existingConfig.channels.feishu = feishu

        existingConfig.plugins = existingConfig.plugins || {}
        existingConfig.plugins.entries = existingConfig.plugins.entries || {}
        existingConfig.plugins.entries.feishu = {
          ...(existingConfig.plugins.entries.feishu || {}),
          enabled: true
        }
      }
    } else if (existingConfig.channels.feishu) {
      delete existingConfig.channels.feishu
    }

    // ----- meta：兼容元数据（待办 #15 修复，Commit 07 顺带）-----
    // 现象：旧代码写 `lastTouchedVersion: 'latest'` + `lastTouchedAt` 会被 OpenClaw schema 拒绝。
    // 实测（本机安装版 2026.9.4，读 `dist/schema-*.mjs` 的 lookupConfigSchema）：
    //   `meta` 是 `additionalProperties: false` 的对象 → `lastTouchedAt` **根本不是合法字段**（lookup 返回 null）；
    //   `lastTouchedVersion` 是合法字段，但语义是「最后写这份配置的 OpenClaw 版本」，不是字面量 'latest'。
    // 修法：①删掉 `lastTouchedAt`；②`lastTouchedVersion` 写**真实安装版本**（读 openclaw/package.json），
    // 读不到就整键删掉——宁可没有该字段，也不写非法值。meta 以外的字段一概不动。
    const meta = existingConfig.meta && typeof existingConfig.meta === 'object' ? { ...existingConfig.meta } : {}
    delete meta.lastTouchedAt
    const touchedVersion = this._readInstalledOpenClawVersion()
    if (touchedVersion) meta.lastTouchedVersion = touchedVersion
    else delete meta.lastTouchedVersion
    if (Object.keys(meta).length > 0) existingConfig.meta = meta
    else delete existingConfig.meta

    // 注入 Obsidian MCP server 配置（由 ObsidianManager 提供）
    this._injectObsidianMcp(existingConfig)

    const content = JSON.stringify(existingConfig, null, 2)
    this._atomicWriteFileSync(this.openClawConfigPath, content)
    console.log('[ConfigManager] openclaw.json 已使用新版预设结构同步完成。')

    // 归档 legacy 凭证文件 auth-profiles.json：OpenClaw v2026.9.x 以 SQLite 为凭证规范
    // 存储，遗留的 auth-profiles.json 会触发 AuthProfileMigrationRequiredError，
    // 拦截全部模型服务商鉴权（apiKey 已内嵌于 openclaw.json 的 models.providers，此文件多余）。
    this._archiveLegacyAuthProfiles()
  } catch (err: any) {
    console.error('[ConfigManager] 同步 OpenClaw 配置失败:', err.message)
  }
}

/**
 * 注入 Obsidian MCP server 配置到 openclaw.json 的 mcp.servers.obsidian。
 * 由 ObsidianManager 通过 setObsidianMcpInjector 提供生成器；未启用则移除已存在的 obsidian 条目。
 */
private _injectObsidianMcp(existingConfig: any): void {
  if (!this.obsidianMcpInjector) return
  existingConfig.mcp = existingConfig.mcp || {}
  existingConfig.mcp.servers = existingConfig.mcp.servers || {}
  const obsidianCfg = this.obsidianMcpInjector()
  if (obsidianCfg) {
    existingConfig.mcp.servers.obsidian = obsidianCfg
  } else if (existingConfig.mcp.servers.obsidian) {
    delete existingConfig.mcp.servers.obsidian
  }
  // 清理空节点：只删空的 servers，不删 mcp 本身——mcp 上未来可能挂其他字段
  //（timeout 等），整删会把它们一起抹掉。
  if (existingConfig.mcp.servers && Object.keys(existingConfig.mcp.servers).length === 0) {
    delete existingConfig.mcp.servers
  }
}

/**
 * 归档 legacy 凭证文件 auth-profiles.json（<configDir>/agents/main/agent/auth-profiles.json）。
 *
 * 背景：OpenClaw v2026.9.x 起以 openclaw-agent.sqlite 为凭证规范存储，启动时若发现
 * 遗留的 auth-profiles.json 且 SQLite 凭证库为空，会抛 AuthProfileMigrationRequiredError
 * 并拦截 bailian/custom/deepseek/longcat/volcengine 等全部服务商鉴权。
 * 此前 _syncAuthProfiles 每次保存配置都以 legacy flat 格式重写该文件，导致反复触发。
 *
 * 修复：不再写入该文件（API Key 本就随 models.providers 写入 openclaw.json），
 * 并将历史残留改名为 OpenClaw 认可的「已迁移」命名（*.migrated-* 前缀，官方迁移
 * 诊断逻辑会将其视为 retired 文件忽略）。幂等：文件不存在时为空操作。
 */
private _archiveLegacyAuthProfiles(): void {
  try {
    const agentAuthDir = join(openClawPaths.configDir(this.dataDir), 'agents', 'main', 'agent')
    const authProfilesPath = join(agentAuthDir, 'auth-profiles.json')
    if (!existsSync(authProfilesPath)) return
    const archivedPath = join(
      agentAuthDir,
      `auth-profiles.json.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}-umiclaw`
    )
    renameSync(authProfilesPath, archivedPath)
    console.warn('[ConfigManager] 已归档 legacy auth-profiles.json:', archivedPath)
  } catch (err: any) {
    // 归档失败不阻断主流程：下次启动/保存配置时会重试
    console.warn('[ConfigManager] 归档 auth-profiles.json 失败:', err.message)
  }
}
  getRuntimeDir() {
    return join(
      this.getDataDir(),
      'runtime'
    )
  }
  /**
   * 🟢 [方向 A] 供前端 Skills 页面调用：全量扫描本地便携式子目录，解析并返回技能列表
   */
  public getInstalledSkills(): Array<{ id: string; name: string; description: string; enabled: boolean }> {
    const list: any[] = []
    try {
      // 1. 安全检查：如果便携目录不存在，直接返回空列表
      if (!existsSync(this.portableSkillsDir)) {
        return list
      }

      // 2. 读取 openclaw.json 里的全局技能开关状态，用来做前端对齐
      let enabledSkillsMap: Record<string, any> = {}
      const parsedForSkills = this._readOpenClawConfig(null, (e) =>
        console.warn('[ConfigManager] 匹配技能开关时读取 openclaw.json 失败', e)
      )
      if (parsedForSkills) {
        // 从 skills.entries 节点获取已启用的映射表
        enabledSkillsMap = parsedForSkills?.skills?.entries || parsedForSkills?.skills || {}
      }

      // 3. 扫描父目录下的所有子文件夹（即每个独立的 Skill 包）
      const entries = readdirSync(this.portableSkillsDir, { withFileTypes: true })

      for (const entry of entries) {
        // 以点开头的目录是内部目录（如 staging 更新残留 .staging-*），不属于技能
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const skillFolderId = entry.name // 文件夹名作为唯一 ID（例如 "pdf-helper"）
          const skillMdPath = join(this.portableSkillsDir, skillFolderId, 'SKILL.md')

          // 默认兜底信息，防止某些 Skill 没有写标准声明导致崩溃
          let skillName = skillFolderId
          let skillDescription = "暂无描述信息。"

          // 4. 如果根部存在 SKILL.md，开始硬核解析它的 Front Matter
          if (existsSync(skillMdPath)) {
            try {
              const fileContent = readFileSync(skillMdPath, 'utf-8')
              skillName = this._parseFrontMatterField(fileContent, 'name') ?? skillName
              skillDescription =
                this._parseFrontMatterField(fileContent, 'description') ?? skillDescription
            } catch (mdErr) {
              console.error(`[ConfigManager] 解析 ${skillFolderId}/SKILL.md 失败:`, mdErr)
            }
          }

          // 5. 组装成前端开箱即用的标准 JSON 结构
          list.push({
            id: skillFolderId,                     // 用于命令行的目录标识
            name: skillName,                       // 页面显示的技能名称
            description: skillDescription,         // 页面显示的描述
            enabled: enabledSkillsMap[skillFolderId]?.enabled ?? false // 默认没在配置里的算关闭
          })
        }
      }
    } catch (err) {
      console.error('[ConfigManager] 全量扫描本地 Skill 失败:', err)
    }

    console.log(`[ConfigManager] 本地 Skills 扫描完成，共找到 ${list.length} 个技能。`)
    return list
  }
  /**
   * 🟢 供前端 Skills 页面调用：控制某个本地 Skill 的启用/禁用开关
   * @param skillId 技能的唯一标识（即文件夹名，例如 "pdf-helper"）
   * @param enabled 目标状态：true 开启，false 关闭
   */
  public toggleSkillStatus(skillId: string, enabled: boolean): void {
    try {
      // 1. 初始化或读取现有的 openclaw.json 配置
      let openClawConfig: any = {
        agents: { defaults: {} },
        gateway: { mode: "local", auth: {} },
        channels: {},
        plugins: { entries: { "openclaw-weixin": { "enabled": true } } },
        skills: { entries: {} }
      }

      // 只读一次并复用解析结果，避免守卫/兜底双读的 TOCTOU 窗口（同 _syncOpenClawConfig）
      let parsedForToggle: any = null
      if (existsSync(this.openClawConfigPath)) {
        try {
          parsedForToggle = this._parseOpenClawJsonRaw()
          if (!parsedForToggle || typeof parsedForToggle !== 'object') parsedForToggle = null
        } catch (parseErr) {
          console.error('[ConfigManager] openclaw.json parse failed; skip skill toggle to avoid overwriting config', parseErr)
          return
        }
      }
      openClawConfig = parsedForToggle || openClawConfig

      // 2. 强保障 skills 节点存在
      openClawConfig.skills = openClawConfig.skills || {}
      openClawConfig.skills.entries = openClawConfig.skills.entries || {}

      // 🟢 写入到 entries 内部
      openClawConfig.skills.entries[skillId] = {
        enabled: enabled
      }
      // 4. 安全回写到磁盘
      this._atomicWriteFileSync(this.openClawConfigPath, JSON.stringify(openClawConfig, null, 2))
      console.log(`[ConfigManager] 本地技能 [${skillId}] 状态已成功切换为: ${enabled}`)

    } catch (err) {
      console.error(`[ConfigManager] 切换技能 [${skillId}] 开关失败:`, err)
    }
  }

  /**
   * 🟢 供前端 Skills 页面调用：弹出文件选择框，选择 zip 包并自动解压到便携 skills 目录
   */
  public async importSkillZip(): Promise<{ success: boolean; error?: string }> {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择 OpenClaw 技能压缩包 (.zip)',
        filters: [{ name: 'Zip Archives', extensions: ['zip'] }],
        properties: ['openFile']
      })

      if (canceled || filePaths.length === 0) {
        return { success: false, error: '用户取消了选择' }
      }

      const zipPath = filePaths[0]
      // 获取压缩包本来的文件名（去掉 .zip），作为无根目录时的备用文件夹名
      const zipFileName = basename(zipPath, '.zip')

      const result = this.installSkillZipData(readFileSync(zipPath), zipFileName)
      if (result.success && !result.exists) {
        // 手动导入也记 manifest 台账：key = zip 文件名 stem；SKILL.md 无 version 时记 'unknown'
        // （若恰好与云端同名同 stem，后续更新检测可正常比对）
        this.recordSkillInstalled(zipFileName, result.version ?? 'unknown', result.skillId ?? zipFileName)
      }
      return { success: result.success, error: result.error }

    } catch (err: any) {
      console.error('[ConfigManager] 导入 Skill 压缩包失败:', err)
      return { success: false, error: err.message || '解压安装过程中发生未知错误' }
    }
  }

  // ───────────────────────── 技能版本 manifest ─────────────────────────

  /**
   * 读取技能版本 manifest。文件不存在 / BOM / JSON 非法 / 结构非法时
   * 降级返回 {}（全量已装技能会被云端同步视为「版本未记录 → 可更新」），不抛异常。
   */
  public getSkillManifest(): Record<string, SkillManifestEntry> {
    try {
      if (!existsSync(this.skillManifestPath)) return {}
      let text = readFileSync(this.skillManifestPath, 'utf-8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, SkillManifestEntry> = {}
      for (const [key, val] of Object.entries(parsed)) {
        const v = val as any
        if (v && typeof v === 'object' && typeof v.version === 'string' && typeof v.actualDir === 'string') {
          out[key] = { version: v.version, installedAt: String(v.installedAt ?? ''), actualDir: v.actualDir }
        }
      }
      return out
    } catch (err) {
      console.warn('[ConfigManager] 读取技能 manifest 失败，视为空台账:', err)
      return {}
    }
  }

  /** 原子写入 manifest（复用 _atomicWriteFileSync 的 tmp + rename 策略） */
  private _writeSkillManifest(manifest: Record<string, SkillManifestEntry>): void {
    mkdirSync(dirname(this.skillManifestPath), { recursive: true })
    this._atomicWriteFileSync(this.skillManifestPath, JSON.stringify(manifest, null, 2))
  }

  /**
   * 合并写入单条安装/更新记录。台账只是辅助数据，任何异常仅 warn 吞掉，
   * 绝不影响已成功的安装/更新主流程。
   */
  public recordSkillInstalled(skillKey: string, version: string, actualDir: string): void {
    try {
      const manifest = this.getSkillManifest()
      manifest[skillKey] = { version: version || 'unknown', installedAt: new Date().toISOString(), actualDir }
      this._writeSkillManifest(manifest)
    } catch (err) {
      console.warn(`[ConfigManager] 记录技能 [${skillKey}] 版本到 manifest 失败（不影响安装）:`, err)
    }
  }

  // ───────────────────────── zip 包安装/更新 ─────────────────────────

  /**
   * 解析 zip 包结构：定位 SKILL.md、判定规范包（自带顶层文件夹）或平铺包，
   * 并算出应落盘的目录名（平铺包按 SKILL.md name，frontmatter 不可信已做合法化）。
   * installSkillZipData 与 updateSkillZipData 共用，保证落盘目录名判定逻辑只有一份。
   */
  private _resolveZipTarget(
    zip: AdmZip,
    fallbackName: string
  ): { ok: true; dirName: string; hasParentFolder: boolean; skillMdContent: string | null } | { ok: false; error: string } {
    // 深度扫描：定位 SKILL.md 并摸清它的底层结构
    let skillMdEntry: any = null
    let hasParentFolder = false
    let detectedFolderName = ''

    for (const entry of zip.getEntries()) {
      if (entry.entryName.endsWith('SKILL.md')) {
        skillMdEntry = entry
        const parts = entry.entryName.split('/')
        // 如果切开大于 1，说明形如 "pdf-helper/SKILL.md"，天然自带了父文件夹
        if (parts.length > 1 && parts[0] !== '') {
          hasParentFolder = true
          detectedFolderName = parts[0]
        }
        break
      }
    }

    if (!skillMdEntry) {
      return { ok: false, error: '不合法的 Skill 包：未检测到 SKILL.md 文件！' }
    }

    let skillMdContent: string | null = null
    try {
      skillMdContent = skillMdEntry.getData().toString('utf8')
    } catch { /* 内容读不出时 version 解析降级为 undefined，不阻断安装 */ }

    if (hasParentFolder) {
      return { ok: true, dirName: detectedFolderName, hasParentFolder: true, skillMdContent }
    }

    // 平铺包：解析 SKILL.md 里的 name 作为专属文件夹名
    let targetSkillName = fallbackName
    try {
      if (skillMdContent) {
        targetSkillName = this._parseFrontMatterField(skillMdContent, 'name') ?? targetSkillName
      }
    } catch (e) {
      console.warn('[ConfigManager] 从平铺的 SKILL.md 中解析 name 失败，改用压缩包名')
    }
    // 目录名安全合法化：frontmatter 不可信，防 `name: ../../evil` 目录穿越
    if (targetSkillName === '.' || targetSkillName === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetSkillName)) {
      console.warn(`[ConfigManager] SKILL.md name 非法 (${targetSkillName})，回退为 zip 文件名`)
      targetSkillName = fallbackName
    }
    return { ok: true, dirName: targetSkillName, hasParentFolder: false, skillMdContent }
  }

  /**
   * zip 包安装核心：解析缓冲区中的技能压缩包并解压落盘到便携 skills 目录。
   * 手动导入（importSkillZip）与云端技能同步（SkillSyncService）共用这一份逻辑。
   * @param data zip 文件内容
   * @param fallbackName zip 文件名（去 .zip），平铺包解析不出 name 时作为目录名兜底
   * @param opts.overwrite 目标技能目录已存在时是否覆盖；云端同步传 false 以保护用户已改过的技能
   */
  public installSkillZipData(
    data: Buffer,
    fallbackName: string,
    opts?: { overwrite?: boolean }
  ): { success: boolean; skillId?: string; exists?: boolean; version?: string; error?: string } {
    const overwrite = opts?.overwrite !== false
    try {
      const zip = new AdmZip(data)

      // 0. zip-slip 校验：任一 entry 落点越出技能目录即整体拒绝
      const slipProblem = this._validateZipEntries(zip, this.portableSkillsDir)
      if (slipProblem) return { success: false, error: `不合法的 Skill 包：${slipProblem}` }

      const target = this._resolveZipTarget(zip, fallbackName)
      if (!target.ok) return { success: false, error: target.error }

      mkdirSync(this.portableSkillsDir, { recursive: true })

      // SKILL.md 顶层 version 字段（可能没有），供调用方记 manifest 台账
      const version = target.skillMdContent
        ? this._parseFrontMatterField(target.skillMdContent, 'version')
        : undefined

      // 智能化分流解压机制
      if (target.hasParentFolder) {
        // 🔹 情况 A：压缩包本身很规范，里面已经套了文件夹 (如 pdf-helper/SKILL.md)
        if (!overwrite && existsSync(join(this.portableSkillsDir, target.dirName))) {
          return { success: true, exists: true, skillId: target.dirName, version: version ?? undefined }
        }
        // 直接解压释放到父目录，adm-zip 会完整保留 pdf-helper 文件夹
        zip.extractAllTo(this.portableSkillsDir, true)
        console.log(`[ConfigManager] 规范包解压完成，保留了原有目录: ${target.dirName}`)
        return { success: true, skillId: target.dirName, version: version ?? undefined }
      }

      // 🔹 情况 B：压缩包不规范，文件全平铺在根部 (如 📂zip根部/SKILL.md)
      // 拼接出它应该去的合规子目录绝对路径：data/config/.openclaw/skills/pdf-helper
      const finalSkillDir = join(this.portableSkillsDir, target.dirName)
      if (!overwrite && existsSync(finalSkillDir)) {
        return { success: true, exists: true, skillId: target.dirName, version: version ?? undefined }
      }

      // 强行把整个压缩包的所有内容，解压释放到这个新建的独立子目录下
      zip.extractAllTo(finalSkillDir, true)
      console.log(`[ConfigManager] 平铺包解压完成，已自动为其创建合规子目录: ${target.dirName}`)
      return { success: true, skillId: target.dirName, version: version ?? undefined }

    } catch (err: any) {
      console.error('[ConfigManager] 安装 Skill 包失败:', err)
      return { success: false, error: err.message || '解压安装过程中发生未知错误' }
    }
  }

  /**
   * staging 安全更新：解压到临时目录 → 校验 → 旧目录改名让位 → 新目录改名就位 → 清理。
   * 与 installSkillZipData(overwrite:true) 的原地覆盖不同：不残留旧文件、失败自动回滚不留残骸。
   * @param skillKey manifest key（= versions.json key = zip 文件名 stem），仅用于 staging 临时目录命名
   * @param previousActualDir 上一次安装的实际落盘目录名（manifest.actualDir）；
   *        与本次目录名不同时按新名落盘，并迁移 openclaw.json 里的 enabled 开关
   */
  public updateSkillZipData(
    data: Buffer,
    skillKey: string,
    previousActualDir?: string
  ): { success: boolean; actualDir?: string; version?: string; error?: string } {
    // staging 目录名中的 key 按白名单消毒，防注入路径
    const safeKey = /^[A-Za-z0-9._-]+$/.test(skillKey) ? skillKey : 'skill'
    const stagingDir = join(this.portableSkillsDir, `.staging-${Date.now()}-${safeKey}`)
    const trashDir = join(this.portableSkillsDir, `.staging-old-${Date.now()}-${safeKey}`)
    try {
      const zip = new AdmZip(data)

      const slipProblem = this._validateZipEntries(zip, this.portableSkillsDir)
      if (slipProblem) return { success: false, error: `不合法的 Skill 包：${slipProblem}` }

      const target = this._resolveZipTarget(zip, skillKey)
      if (!target.ok) return { success: false, error: target.error }
      const { dirName, hasParentFolder, skillMdContent } = target

      mkdirSync(this.portableSkillsDir, { recursive: true })
      mkdirSync(stagingDir, { recursive: true })

      // 解压到 staging：规范包内容落在 staging/<dirName>/，平铺包直接在 staging 根部
      zip.extractAllTo(stagingDir, true)
      const payloadDir = hasParentFolder ? join(stagingDir, dirName) : stagingDir
      if (!existsSync(join(payloadDir, 'SKILL.md'))) {
        return { success: false, error: '不合法的 Skill 包：未检测到 SKILL.md 文件！' }
      }

      const newDir = join(this.portableSkillsDir, dirName)
      // 旧目录位置：上次目录名与本次不同时，旧内容在 previousActualDir 下
      const oldDir =
        previousActualDir && previousActualDir !== dirName && existsSync(join(this.portableSkillsDir, previousActualDir))
          ? join(this.portableSkillsDir, previousActualDir)
          : newDir

      // 三段式换目录（Windows 下 renameSync 不能覆盖已存在目录）：
      // 旧目录 → trash，payload → 原位；payload 就位失败则把 trash 回滚回去
      let movedOld = false
      if (existsSync(oldDir)) {
        renameSync(oldDir, trashDir)
        movedOld = true
      }
      try {
        renameSync(payloadDir, newDir)
      } catch (renameErr) {
        if (movedOld) {
          try { renameSync(trashDir, oldDir) } catch { /* 回滚失败仅记录，旧数据仍在 trash 目录 */ }
        }
        throw renameErr
      }
      // 就位成功：清掉 trash 与 staging 残余（规范包 staging 下已空，平铺包 staging 本身已挪走）
      try { rmSync(trashDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
      try { if (stagingDir !== payloadDir) rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }

      // 目录名变化时迁移 openclaw.json 的 enabled 开关（非致命，失败仅 warn）
      if (oldDir !== newDir) {
        this._migrateSkillEnabledState(basename(oldDir), dirName)
      }

      const version = skillMdContent ? this._parseFrontMatterField(skillMdContent, 'version') : undefined
      console.log(`[ConfigManager] 技能 [${skillKey}] staging 更新完成，落盘目录: ${dirName}`)
      return { success: true, actualDir: dirName, version: version ?? undefined }

    } catch (err: any) {
      console.error('[ConfigManager] staging 更新技能失败:', err)
      // 尽力清理临时目录，不留残骸
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
      try { rmSync(trashDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return { success: false, error: err.message || '更新过程中发生未知错误' }
    }
  }

  /**
   * 目录名变化时，把 openclaw.json skills.entries 里旧目录名的开关条目搬到新名下。
   * 非致命：读失败/写失败仅 warn，绝不影响更新结果。
   */
  private _migrateSkillEnabledState(oldName: string, newName: string): void {
    try {
      const cfg = this._readOpenClawConfig(null)
      if (!cfg || !cfg.skills) return
      const entries = cfg.skills.entries || cfg.skills
      if (!entries || typeof entries !== 'object' || entries[oldName] === undefined) return
      entries[newName] = entries[oldName]
      delete entries[oldName]
      this._atomicWriteFileSync(this.openClawConfigPath, JSON.stringify(cfg, null, 2))
      console.log(`[ConfigManager] 技能目录改名 ${oldName} → ${newName}，enabled 状态已迁移`)
    } catch (err) {
      console.warn('[ConfigManager] 迁移技能 enabled 状态失败（不影响更新）:', err)
    }
  }

  /**
   * zip-slip 纵深防御：遍历全部 entry，任一落点越出 destDir 即拒绝。
   * 跳过 macOS 打包垃圾项（__MACOSX/、.DS_Store）。返回 null 表示校验通过。
   */
  private _validateZipEntries(zip: AdmZip, destDir: string): string | null {
    const resolvedDest = resolve(destDir)
    for (const entry of zip.getEntries()) {
      const name = entry.entryName
      if (!name || name.startsWith('__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store')) continue
      if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split(/[\\/]/).includes('..')) {
        return `条目路径越界 (${name})`
      }
      const target = resolve(resolvedDest, name)
      if (target !== resolvedDest && !target.startsWith(resolvedDest + sep)) {
        return `条目路径越界 (${name})`
      }
    }
    return null
  }

  /**
   * 供云端技能同步做跳过预检：本地技能目录是否已存在
   */
  public hasLocalSkill(skillId: string): boolean {
    return existsSync(join(this.portableSkillsDir, skillId))
  }
}
