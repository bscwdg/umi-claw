import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import type { ConfigManager } from './configManager'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'
import {
  CHANNEL_PLUGINS,
  buildPluginInstallArgs,
  channelPluginByPackage,
  getChannelPluginPresence,
  hasStaleManagedProject,
  isChannelPluginInstalled,
  isChannelPluginKey
} from './claw/channelPlugins'
import type { ChannelPluginKey, ChannelPluginPresence, ChannelStatus } from '../../src/types/channels'

/** QQ 扫码登录前置结果：失败不抛异常，由渲染端按 success/error 展示。 */
export interface QQBotPrepareResult {
  success: boolean
  installed: boolean
  enabled: boolean
  error?: string
}

/** 渠道插件「确保就绪」结果：安装缺失插件 + 在 openclaw.json 里启用。 */
export interface ChannelPluginEnsureResult {
  success: boolean
  key: ChannelPluginKey | string
  installed: boolean
  installedNow: boolean
  enabled: boolean
  error?: string
}

export class ChannelManager extends EventEmitter {
  /** ensurePlugin 单飞：同一渠道插件同时只允许一次安装/启用，避免重复装包与并发写配置。 */
  private ensureTasks = new Map<string, Promise<ChannelPluginEnsureResult>>()

  constructor(private configManager: ConfigManager) {
    super()
  }

  private get dataDir() {
    return this.configManager.getDataDir()
  }

  /** OpenClaw 配置目录（config/.openclaw）：渠道插件受管项目就在其 npm/projects 下 */
  private get configDir() {
    return openClawPaths.configDir(this.dataDir)
  }

  /**
   * 渠道插件是否已安装。
   * 判定下沉到 claw/channelPlugins（注册表唯一真源）：要求包目录里的 package.json 完整且
   * name 匹配，避免「安装回滚残留空目录」被误判为已安装而跳过安装。
   */
  isPluginInstalled(pluginId: string): boolean {
    if (!isChannelPluginKey(pluginId)) return false
    return isChannelPluginInstalled(this.configDir, pluginId)
  }

  /** 全部渠道插件安装态快照（渠道页一次取完） */
  getChannelPluginPresence(): ChannelPluginPresence[] {
    return getChannelPluginPresence(this.configDir)
  }

  /**
   * 安装 OpenClaw 渠道插件（终端交互用）。
   *
   * 与 downloadManager 的受管安装保持一致：优先国内镜像、失败回落官方源；
   * 单次最长 5 分钟，避免网络异常时终端长时间无响应。
   */
  async installPlugin(pluginPkg: string, opts: { force?: boolean } = {}): Promise<boolean> {
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

    // --force：受管目录已存在（半损坏/旧版本）时允许覆盖重装；普通安装不传，避免误删用户插件。
    const installArgs = buildPluginInstallArgs(clawJsPath, pluginPkg, { force: opts.force === true })

    const attempt = (registry: string): Promise<boolean> => {
      return new Promise((resolve, reject) => {
        this.emit('log', `[channels] installing plugin ${pluginPkg} (registry=${registry}) ...`, 'system')
        const env = buildOpenClawEnv(this.dataDir, nodePath, {
          OPENCLAW_DISABLE_BONJOUR: '1',
          OPENCLAW_GATEWAY_MODE: 'local',
          npm_config_registry: registry
        })
        const proc = spawn(nodePath, installArgs, {
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
        // 但 --force 重装必须真失败（否则 UI 会把「没重装成功」显示成已重装）。
        const spec = channelPluginByPackage(pluginPkg)
        if (!opts.force && spec && isChannelPluginInstalled(this.configDir, spec.key)) {
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
   * 直接复用 ensurePlugin：扫码按钮与渠道页「安装」/保存流程共用同一套单飞，
   * 同一个插件不会被并发安装两次。
   *
   * 失败不抛异常：返回 {success:false,error} 交给渲染端；渲染端失败时留在渠道页显示
   * 原因、不跳终端（否则终端只会再跑一遍必然失败的 channels login）。
   */
  async prepareQQBotLogin(): Promise<QQBotPrepareResult> {
    const result = await this.ensurePlugin('qqbot')
    return {
      success: result.success,
      installed: result.installed,
      enabled: result.enabled,
      ...(result.error ? { error: result.error } : {})
    }
  }

  /**
   * 确保一个渠道插件「已安装 + 已启用」。
   *
   * 为什么需要统一入口：飞书/QQ/微信/企微/Slack 的安装以前各写一套（初始化流程只装微信、
   * QQ 扫码前单独准备、飞书只在保存时顺手装、企微走 npx 向导），删掉任何一个渠道插件后
   * 都没有「装回来」的路径；而且 `plugins install` 会保留用户显式卸载留下的
   * `enabled:false` 标记，只装不启用时渠道仍然不加载。这里把「缺失就装、禁用就启用」
   * 收敛成一次幂等调用，所有渠道共用。
   *
   * 半拷贝/空目录残留会让普通 `plugins install` 报 already exists：检测到受管项目目录
   * 存在但包不完整时自动升级为 `--force` 重装。
   *
   * 失败不抛异常（返回 {success:false,error}），由渲染端显示原因并允许重试。
   * 同一渠道并发调用复用同一个 Promise：安装会长时间占 npm 与受管目录。
   * 注意：正在跑普通安装时后到的 force 会复用进行中的任务（不会并发装同包），
   * 需要强制重装请等它结束后再点一次。
   */
  async ensurePlugin(
    key: ChannelPluginKey | string,
    opts: { force?: boolean } = {}
  ): Promise<ChannelPluginEnsureResult> {
    if (!isChannelPluginKey(key)) {
      return {
        success: false,
        key,
        installed: false,
        installedNow: false,
        enabled: false,
        error: `未知渠道插件：${String(key)}`
      }
    }
    const running = this.ensureTasks.get(key)
    if (running) return running
    const task = this._ensurePlugin(key, opts.force === true).finally(() => {
      if (this.ensureTasks.get(key) === task) this.ensureTasks.delete(key)
    })
    this.ensureTasks.set(key, task)
    return task
  }

  private async _ensurePlugin(
    key: ChannelPluginKey,
    force: boolean
  ): Promise<ChannelPluginEnsureResult> {
    const spec = CHANNEL_PLUGINS[key]
    const wasInstalled = isChannelPluginInstalled(this.configDir, key)
    let installed = wasInstalled
    const base: ChannelPluginEnsureResult = {
      success: false,
      key,
      installed: wasInstalled,
      installedNow: false,
      enabled: false
    }
    try {
      // 残留项目（空目录/半拷贝/包名不符）会让普通 install 报 already exists，必须 --force
      const needForce = force || (!installed && hasStaleManagedProject(this.configDir, key))
      if (!installed || needForce) {
        this.emit(
          'log',
          `[channels] ${needForce ? '重装' : '安装'}渠道插件 ${spec.label}（${spec.packageName}）…`,
          'system'
        )
        await this.installPlugin(spec.packageName, { force: needForce })
        installed = isChannelPluginInstalled(this.configDir, key)
        if (!installed) {
          return {
            ...base,
            error: '安装命令已执行，但受管目录里仍找不到完整插件包'
          }
        }
        this.emit('log', `[channels] 渠道插件 ${spec.label} 已写入受管目录`, 'system')
      }
      const enable = await this.configManager.ensureOpenClawPluginEnabled(spec.openclawPluginId)
      if (!enable.ok) {
        return {
          success: false,
          key,
          installed: true,
          installedNow: !wasInstalled,
          enabled: false,
          error: enable.error || `启用 ${spec.openclawPluginId} 插件失败`
        }
      }
      this.emit('log', `[channels] 渠道插件 ${spec.label} 已就绪`, 'system')
      return {
        success: true,
        key,
        installed: true,
        installedNow: !wasInstalled,
        enabled: true
      }
    } catch (err) {
      return {
        ...base,
        installed,
        installedNow: installed && !wasInstalled,
        error: (err as Error)?.message ?? String(err)
      }
    }
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
