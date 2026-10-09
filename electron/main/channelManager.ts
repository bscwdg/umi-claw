import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import { ConfigManager } from './configManager'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'
import type { ChannelStatus } from '../../src/types/channels'

export class ChannelManager extends EventEmitter {
  constructor(private configManager: ConfigManager) {
    super()
  }

  private get dataDir() {
    return this.configManager.getDataDir()
  }

  isPluginInstalled(pluginId: string): boolean {
    const projectsDir = path.join(openClawPaths.configDir(this.dataDir), 'npm', 'projects')
    if (!fs.existsSync(projectsDir)) return false
    const prefix = `openclaw-${pluginId}`
    return fs.readdirSync(projectsDir).some(name => name.startsWith(prefix))
  }

  installPlugin(pluginPkg: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const nodePath = this.configManager.getNodePath()
      const clawJsPath = openClawPaths.clawJs(this.dataDir)
      if (!fs.existsSync(nodePath) || !fs.existsSync(clawJsPath)) {
        reject(new Error('OpenClaw runtime not found, please init environment first'))
        return
      }

      this.emit('log', `[feishu] installing plugin ${pluginPkg} ...`, 'system')
      const env = buildOpenClawEnv(this.dataDir, nodePath, {
        OPENCLAW_DISABLE_BONJOUR: '1',
        OPENCLAW_GATEWAY_MODE: 'local'
      })
      const proc = spawn(nodePath, [clawJsPath, 'plugins', 'install', pluginPkg], {
        cwd: openClawPaths.installDir(this.dataDir),
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })

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

      proc.on('error', reject)
      proc.on('close', code => {
        if (code === 0) {
          this.emit('log', `[feishu] plugin ${pluginPkg} installed`, 'system')
          resolve(true)
        } else {
          reject(new Error(`install plugin ${pluginPkg} failed (code ${code})`))
        }
      })
    })
  }

  /**
   * 探测各渠道是否已接入，供渠道页做「已配置」展示。
   *
   * 依据是网关真实配置（openclaw.json 的 channels）与插件登录态，而不是 UI 表单值：
   * 企业微信扫码接入后写的是 channels.wecom 的 botId + secret，UI 表单卡要的
   * corpId/agentId 始终为空，只看表单会误判成未配置。
   *
   * 恒返回全部 5 个 key（含未配置的），渲染层据此渲染空状态与徽标。
   * 任何读取失败都降级为「未配置」，绝不抛错。
   */
  getChannelStatuses(): ChannelStatus[] {
    const fallback: ChannelStatus[] = [
      { key: 'feishu', configured: false },
      { key: 'weixin', configured: false },
      { key: 'wecom', configured: false },
      { key: 'wechat_mp', configured: false },
      { key: 'dingtalk', configured: false }
    ]
    try {
      const channels = this.configManager.getOpenClawChannels()
      return [
        this._feishuStatus(channels.feishu),
        this._weixinStatus(),
        this._wecomStatus(channels.wecom),
        this._wechatMpStatus(channels.wechat_mp),
        this._dingtalkStatus(channels.dingtalk)
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
}
