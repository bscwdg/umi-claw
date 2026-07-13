import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { ConfigManager } from './configManager'

export interface ChannelInfo {
  id: string
  name: string
  icon: string
  desc?: string
  installed?: boolean
  enabled?: boolean
}

export class ChannelManager {
  constructor(private configManager: ConfigManager) {}

  private get dataDir() {
    return this.configManager.getDataDir()
  }

  private get channelDir() {
    return path.join(this.dataDir, 'channels')
  }

  private get configPath() {
    return path.join(this.dataDir, 'config', '.openclaw', 'channels.json')
  }

  private loadConfig() {
    if (!fs.existsSync(this.configPath)) return {}
    return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
  }

  private saveConfig(data: any) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2))
  }

  async available(): Promise<ChannelInfo[]> {
    const cfg = this.loadConfig()
    return [
      {
        id: 'telegram',
        name: 'Telegram',
        icon: '📨',
        desc: 'Telegram Bot',
        installed: true,
        enabled: cfg.telegram?.enabled ?? false
      },
      {
        id: 'discord',
        name: 'Discord',
        icon: '🎮',
        desc: 'Discord Bot',
        installed: true,
        enabled: cfg.discord?.enabled ?? false
      },
      {
        id: 'weixin',
        name: '微信',
        icon: '🟢',
        desc: '腾讯官方微信渠道',
        installed: fs.existsSync(path.join(this.channelDir, 'weixin')),
        enabled: cfg.weixin?.enabled ?? false
      }
    ]
  }

  async install(id: string) {
    if (id !== 'weixin') return false
    return this.execWechat(['install'])
  }

  async login(id: string) {
    if (id !== 'weixin') return false
    return this.execWechat(['login'])
  }

  async uninstall(id: string) {
    if (id !== 'weixin') return false
    const dir = path.join(this.channelDir, 'weixin')
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return true
  }

  enable(id: string) {
    const cfg = this.loadConfig()
    cfg[id] ??= {}
    cfg[id].enabled = true
    this.saveConfig(cfg)
    return true
  }

  disable(id: string) {
    const cfg = this.loadConfig()
    cfg[id] ??= {}
    cfg[id].enabled = false
    this.saveConfig(cfg)
    return true
  }

  saveConfigById(id: string, data: any) {
    const cfg = this.loadConfig()
    cfg[id] ??= {}
    cfg[id] = { ...cfg[id], ...data }
    this.saveConfig(cfg)
    return true
  }

  private execWechat(args: string[]): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const installDir = path.join(this.channelDir, 'weixin')
      fs.mkdirSync(installDir, { recursive: true })

      const proc = spawn('npx', ['-y', '@tencent-weixin/openclaw-weixin-cli@latest', ...args], {
        cwd: installDir,
        shell: true,
        stdio: 'inherit'
      })

      proc.on('close', code => {
        code === 0 ? resolve(true) : reject(new Error(`${args[0]} 失败`))
      })
    })
  }
}