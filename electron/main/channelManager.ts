import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import { ConfigManager } from './configManager'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'

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
}
