import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import type { ConfigManager } from './configManager'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'
import type { ChannelStatus } from '../../src/types/channels'

/** QQ 扫码登录前置结果：失败不抛异常，由渲染端按 success/error 展示。 */
export interface QQBotPrepareResult {
  success: boolean
  installed: boolean
  enabled: boolean
  error?: string
}

export class ChannelManager extends EventEmitter {
  /** prepareQQBotLogin 单飞：安装会长时间占 npm 与受管目录，多入口不能并发跑。 */
  private qqbotPrepareTask: Promise<QQBotPrepareResult> | null = null

  constructor(private configManager: ConfigManager) {
    super()
  }

  private get dataDir() {
    return this.configManager.getDataDir()
  }

  /**
   * 插件 id → OpenClaw 受管项目目录前缀。
   * 目录名由 `safePathSegmentHashed(包名)` 生成（scope 被扁平化、末尾带哈希），
   * 例如 @tencent-connect/openclaw-qqbot → tencent-connect-openclaw-qqbot-<hash>。
   */
  private static readonly PLUGIN_PROJECT_PREFIX: Record<string, string> = {
    feishu: 'openclaw-feishu',
    qqbot: 'tencent-connect-openclaw-qqbot',
    weixin: 'tencent-weixin-openclaw-weixin'
  }

  /** 插件包名 → 插件 id（用于安装失败后回查受管目录，避免“成功但非零退出”误判）。 */
  private static readonly PLUGIN_ID_BY_PACKAGE: Record<string, string> = {
    '@openclaw/feishu': 'feishu',
    '@tencent-connect/openclaw-qqbot': 'qqbot',
    '@tencent-weixin/openclaw-weixin': 'weixin'
  }

  /** QQ 机器人官方插件的包名与 openclaw.json 里的插件 id（扫码登录前置用）。 */
  private static readonly QQBOT_PLUGIN_PACKAGE = '@tencent-connect/openclaw-qqbot'
  private static readonly QQBOT_PLUGIN_ID = 'openclaw-qqbot'

  isPluginInstalled(pluginId: string): boolean {
    const projectsDir = path.join(openClawPaths.configDir(this.dataDir), 'npm', 'projects')
    if (!fs.existsSync(projectsDir)) return false
    const prefix = ChannelManager.PLUGIN_PROJECT_PREFIX[pluginId] ?? `openclaw-${pluginId}`
    return fs
      .readdirSync(projectsDir)
      .some(name => name === prefix || name.startsWith(`${prefix}-`))
  }

  /**
   * 安装 OpenClaw 渠道插件（终端交互用）。
   *
   * 与 downloadManager 的受管安装保持一致：优先国内镜像、失败回落官方源；
   * 单次最长 5 分钟，避免网络异常时终端长时间无响应。
   */
  async installPlugin(pluginPkg: string): Promise<boolean> {
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(this.dataDir)
    if (!fs.existsSync(nodePath) || !fs.existsSync(clawJsPath)) {
      throw new Error('OpenClaw runtime not found, please init environment first')
    }

    const useMirror = this.configManager.getConfig().useChineseMirror !== false
    const registries = useMirror
      ? ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
      : ['https://registry.npmjs.org']
    const timeoutMs = 5 * 60 * 1000

    const attempt = (registry: string): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        this.emit('log', `[channels] installing plugin ${pluginPkg} (registry=${registry}) ...`, 'system')
        const env = buildOpenClawEnv(this.dataDir, nodePath, {
          OPENCLAW_DISABLE_BONJOUR: '1',
          OPENCLAW_GATEWAY_MODE: 'local',
          npm_config_registry: registry
        })
        const proc = spawn(nodePath, [clawJsPath, 'plugins', 'install', pluginPkg], {
          cwd: openClawPaths.installDir(this.dataDir),
          env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        const timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {
            /* ignore */
          }
          reject(new Error(`install plugin ${pluginPkg} timed out after ${timeoutMs / 1000}s`))
        }, timeoutMs)

        const forward = (buf: Buffer, type: 'stdout' | 'stderr') => {
          buf
            .toString()
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(line => line.length > 0)
            .forEach(line => this.emit('log', line, type))
        }
        proc.stdout?.on('data', (buf: Buffer) => forward(buf, 'stdout'))
        proc.stderr?.on('data', (buf: Buffer) => forward(buf, 'stderr'))

        proc.on('error', err => {
          clearTimeout(timer)
          reject(err)
        })
        proc.on('close', code => {
          clearTimeout(timer)
          if (code === 0) {
            this.emit('log', `[channels] plugin ${pluginPkg} installed`, 'system')
            resolve(true)
          } else {
            reject(new Error(`install plugin ${pluginPkg} failed (code ${code}, registry=${registry})`))
          }
        })
      })
    }

    let lastError: unknown = null
    for (const registry of registries) {
      try {
        return await attempt(registry)
      } catch (err) {
        // OpenClaw 安装成功时也可能因无关告警返回非零码：以受管目录是否生成为准。
        const pluginId = ChannelManager.PLUGIN_ID_BY_PACKAGE[pluginPkg]
        if (pluginId && this.isPluginInstalled(pluginId)) {
          this.emit('log', `[channels] plugin ${pluginPkg} 已写入受管目录（忽略非零退出码）`, 'system')
          return true
        }
        lastError = err
        this.emit('log', `[channels] registry 安装失败，尝试下一个源: ${registry}`, 'stderr')
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`install plugin ${pluginPkg} failed`)
  }

  /**
   * QQ 扫码登录前置：确保官方插件已安装**且已在 openclaw.json 中启用**。
   *
   * 为什么不能只装不启用：OpenClaw 的 `channels login --channel qqbot` 只认已加载的
   * 渠道插件。插件受管目录存在、但 `plugins.entries['openclaw-qqbot'].enabled=false` 时，
   * OpenClaw 会把 qqbot 当成未安装 → 现场从 npm 重装（用户级 npm-cache 只读时必失败）
   * → 最后报「Channel "qqbot" does not support login」。本应用此前只在表单里填了
   * AppID/Secret 后才启用该插件，而扫码登录正是拿到凭据的手段，形成死锁。
   *
   * 失败不抛异常：返回 {success:false,error} 交给渲染端；渲染端失败时留在渠道页显示
   * 原因、不跳终端（否则终端只会再跑一遍必然失败的 channels login）。
   */
  async prepareQQBotLogin(): Promise<QQBotPrepareResult> {
    // 单飞：多窗口/连点同时触发时只跑一次受管安装（会长时间占 npm 与受管目录）。
    if (this.qqbotPrepareTask) return this.qqbotPrepareTask
    const task = this._prepareQQBotLogin().finally(() => {
      if (this.qqbotPrepareTask === task) this.qqbotPrepareTask = null
    })
    this.qqbotPrepareTask = task
    return task
  }

  private async _prepareQQBotLogin(): Promise<QQBotPrepareResult> {
    let installed = this.isPluginPackagePresent('qqbot')
    if (!installed) {
      try {
        this.emit('log', '[channels] QQ 机器人插件未安装或受管目录不完整，开始受管安装…', 'system')
        await this.installPlugin(ChannelManager.QQBOT_PLUGIN_PACKAGE)
      } catch (err) {
        return {
          success: false,
          installed: false,
          enabled: false,
          error: (err as Error)?.message ?? String(err)
        }
      }
      installed = this.isPluginPackagePresent('qqbot')
    }
    if (!installed) {
      return {
        success: false,
        installed: false,
        enabled: false,
        error: '插件安装命令已执行，但受管目录里仍找不到插件包'
      }
    }

    const enable = await this.configManager.ensureOpenClawPluginEnabled(ChannelManager.QQBOT_PLUGIN_ID)
    if (!enable.ok) {
      return {
        success: false,
        installed: true,
        enabled: false,
        error: enable.error || '启用 openclaw-qqbot 插件失败'
      }
    }
    this.emit('log', '[channels] QQ 机器人插件已就绪，可以扫码登录', 'system')
    return { success: true, installed: true, enabled: true }
  }

  /**
   * 插件包实体是否存在（比只看受管项目目录名严格）。
   *
   * 受管安装回滚 / 手动组装中断会留下空项目目录；只看目录名会误判为「已安装」，
   * 于是跳过安装、写 enabled=true，但 `channels login` 仍加载不到插件，症状不变。
   * 至少要求 package.json 可解析且 name 与目标包一致（挡掉空文件/半拷贝的残缺包）。
   */
  private isPluginPackagePresent(pluginId: string): boolean {
    const packageName = Object.keys(ChannelManager.PLUGIN_ID_BY_PACKAGE).find(
      (pkg) => ChannelManager.PLUGIN_ID_BY_PACKAGE[pkg] === pluginId
    )
    if (!packageName) return false
    const projectsDir = path.join(openClawPaths.configDir(this.dataDir), 'npm', 'projects')
    if (!fs.existsSync(projectsDir)) return false
    const prefix = ChannelManager.PLUGIN_PROJECT_PREFIX[pluginId] ?? `openclaw-${pluginId}`
    return fs.readdirSync(projectsDir).some((name) => {
      if (!(name === prefix || name.startsWith(`${prefix}-`))) return false
      const pkgPath = path.join(projectsDir, name, 'node_modules', ...packageName.split('/'), 'package.json')
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        return parsed && parsed.name === packageName
      } catch {
        return false
      }
    })
  }

  /**
   * 探测各渠道是否已接入，供渠道页做「已配置」展示。
   *
   * 依据是网关真实配置（openclaw.json 的 channels）与插件登录态，而不是 UI 表单值：
   * 企业微信扫码接入后写的是 channels.wecom 的 botId + secret，UI 表单卡要的
   * corpId/agentId 始终为空，只看表单会误判成未配置。
   *
   * 恒返回全部 6 个 key（含未配置的），渲染层据此渲染空状态与徽标。
   * 任何读取失败都降级为「未配置」，绝不抛错。
   */
  getChannelStatuses(): ChannelStatus[] {
    const fallback: ChannelStatus[] = [
      { key: 'feishu', configured: false },
      { key: 'weixin', configured: false },
      { key: 'wecom', configured: false },
      { key: 'wechat_mp', configured: false },
      { key: 'dingtalk', configured: false },
      { key: 'qqbot', configured: false }
    ]
    try {
      const channels = this.configManager.getOpenClawChannels()
      return [
        this._feishuStatus(channels.feishu),
        this._weixinStatus(),
        this._wecomStatus(channels.wecom),
        this._wechatMpStatus(channels.wechat_mp),
        this._dingtalkStatus(channels.dingtalk),
        this._qqbotStatus(channels.qqbot)
      ]
    } catch (err) {
      // 强制兜底：任何意外异常都不能冒泡到 IPC，全部降级为未配置
      console.warn('[ChannelManager] 探测渠道状态发生意外异常，全部降级为未配置:', err)
      return fallback
    }
  }

  private _nonEmpty(v: unknown): boolean {
    return typeof v === 'string' && v.trim().length > 0
  }

  private _feishuStatus(cfg: Record<string, unknown> | undefined): ChannelStatus {
    const configured = !!cfg && this._nonEmpty(cfg.appId) && this._nonEmpty(cfg.appSecret)
    return {
      key: 'feishu',
      configured,
      detail: configured ? `AppID ${String(cfg!.appId).slice(0, 14)}` : undefined
    }
  }

  /**
   * 对齐企微插件自身的 isConfigured（dist/src/channel.js）：
   * 机器人 botId + secret / 企业应用 agent.configured / 群机器人 Webhook token + encodingAESKey。
   * 插件会把顶层与 channels.wecom.accounts.* 合并，这里同样两处都查。
   */
  private _wecomStatus(cfg: Record<string, unknown> | undefined): ChannelStatus {
    if (!cfg) return { key: 'wecom', configured: false }
    const accounts = cfg.accounts
    const list: Record<string, unknown>[] = [
      cfg,
      ...(accounts && typeof accounts === 'object'
        ? Object.values(accounts as Record<string, Record<string, unknown>>)
        : [])
    ]

    const bot = list.find(a => this._nonEmpty(a?.botId) && this._nonEmpty(a?.secret))
    if (bot) {
      return { key: 'wecom', configured: true, detail: `机器人 ${String(bot.botId).slice(0, 12)}` }
    }
    const agent = list.find(a => (a?.agent as { configured?: boolean } | undefined)?.configured === true)
    if (agent) return { key: 'wecom', configured: true, detail: '企业应用' }
    const webhook = list.find(a => this._nonEmpty(a?.token) && this._nonEmpty(a?.encodingAESKey))
    if (webhook) return { key: 'wecom', configured: true, detail: 'Webhook' }
    return { key: 'wecom', configured: false }
  }

  /**
   * 微信插件没有配置文件里的凭证，登录态存在状态目录的 accounts.json（账号 id 数组）。
   * 注意：downloadManager 初始化时会预写 channels["openclaw-weixin"] 的空骨架，
   * 所以不能凭该 key 是否存在来判定。
   */
  private _weixinStatus(): ChannelStatus {
    const accountsFile = path.join(
      openClawPaths.pluginStateDir(this.dataDir, 'openclaw-weixin'),
      'accounts.json'
    )
    const legacyFile = path.join(
      openClawPaths.configDir(this.dataDir),
      'credentials',
      'openclaw-weixin',
      'credentials.json'
    )

    let count = 0
    try {
      if (fs.existsSync(accountsFile)) {
        const parsed = JSON.parse(fs.readFileSync(accountsFile, 'utf-8'))
        if (Array.isArray(parsed)) {
          count = parsed.filter(id => typeof id === 'string' && id.trim() !== '').length
        }
      }
    } catch {
      // accounts.json 损坏 → 视为未登录
    }

    const configured = count > 0 || fs.existsSync(legacyFile)
    return {
      key: 'weixin',
      configured,
      detail: configured ? (count > 0 ? `${count} 个账号` : '已登录') : undefined
    }
  }

  private _wechatMpStatus(cfg: Record<string, unknown> | undefined): ChannelStatus {
    const configured =
      !!cfg && this._nonEmpty(cfg.appId) && this._nonEmpty(cfg.appSecret) && this._nonEmpty(cfg.token)
    return {
      key: 'wechat_mp',
      configured,
      detail: configured ? `AppID ${String(cfg!.appId).slice(0, 14)}` : undefined
    }
  }

  private _dingtalkStatus(cfg: Record<string, unknown> | undefined): ChannelStatus {
    const configured = !!cfg && this._nonEmpty(cfg.appKey) && this._nonEmpty(cfg.appSecret)
    return {
      key: 'dingtalk',
      configured,
      detail: configured ? `AppKey ${String(cfg!.appKey).slice(0, 12)}` : undefined
    }
  }

  /**
   * QQ 机器人（官方插件 @tencent-connect/openclaw-qqbot）。
   * 扫码登录成功后插件会把 appId/clientSecret 写入 channels.qqbot；
   * 也兼容多账号形态 channels.qqbot.accounts.*。
   */
  private _qqbotStatus(cfg: Record<string, unknown> | undefined): ChannelStatus {
    const hasCreds = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false
      const v = value as Record<string, unknown>
      return this._nonEmpty(v.appId) && (this._nonEmpty(v.clientSecret) || this._nonEmpty(v.clientSecretFile))
    }
    if (!cfg) return { key: 'qqbot', configured: false }
    if (cfg.enabled === false) return { key: 'qqbot', configured: false, detail: '已禁用' }
    if (hasCreds(cfg)) {
      return { key: 'qqbot', configured: true, detail: `AppID ${String(cfg.appId).slice(0, 10)}` }
    }
    const accounts = cfg.accounts
    if (accounts && typeof accounts === 'object') {
      for (const account of Object.values(accounts as Record<string, unknown>)) {
        if (hasCreds(account)) return { key: 'qqbot', configured: true, detail: '已绑定机器人' }
      }
    }
    return { key: 'qqbot', configured: false }
  }
}
