import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import type { ConfigManager } from './configManager'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'
import type { ChannelStatus } from '../../src/types/channels'

export class ChannelManager extends EventEmitter {
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
