import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, rmSync } from 'fs'
import { pipeline } from 'stream/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { ConfigManager } from './configManager'
import fs from 'fs'
import path from 'path'

const execAsync = promisify(exec)

function safeMove(src: string, dest: string) {
  try {
    // ✅ 1. 如果目标存在 → 先删
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }

    fs.renameSync(src, dest)
  } catch (err) {
    console.warn('rename failed, fallback to copy:', err)

    // ✅ 2. fallback：复制
    copyDir(src, dest)

    // ✅ 3. 删除原目录
    fs.rmSync(src, { recursive: true, force: true })
  }
}

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }

  for (const file of fs.readdirSync(src)) {
    const s = path.join(src, file)
    const d = path.join(dest, file)

    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d)
    } else {
      fs.copyFileSync(s, d)
    }
  }
}

function fixPackageJson(dir: string) {
  const file = path.join(dir, 'package.json')

  const json = JSON.parse(fs.readFileSync(file, 'utf-8'))

  if (json.dependencies?.['content-type']) {
    json.dependencies['content-type'] = '^1.0.4'
  }

  fs.writeFileSync(file, JSON.stringify(json, null, 2))
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAsyncResult() {
  await delay(1000 * 60 * 5);          // 等待 1 秒
  const res = await window.api.env.check();
  return res.openClawInstalled && res.nodeInstalled;
}


export interface DownloadProgress {
  stage: string
  step: string
  percent: number
  speed?: string
  downloaded?: number
  total?: number
  done: boolean
  error?: string
}

export interface EnvInfo {
  nodeInstalled: boolean
  nodeVersion?: string
  openClawInstalled: boolean
  openClawVersion?: string
  dataDir: string
  diskFree?: number
}

// 国内镜像
const MIRRORS = {
  nodeBase: [
    'https://npmmirror.com/mirrors/node',
    'https://nodejs.org/dist'
  ],
  npm: 'https://registry.npmmirror.com'
}

// node版本
const NODE_VERSION = 'v22.22.3'

function getNodeDownloadUrl(useMirror: boolean): string {
  const platform = process.platform
  const arch = process.arch
  const base = useMirror ? MIRRORS.nodeBase[0] : MIRRORS.nodeBase[1]

  if (platform === 'win32') {
    return `${base}/${NODE_VERSION}/node-${NODE_VERSION}-win-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`
  } else if (platform === 'darwin') {
    return `${base}/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${arch}.tar.gz`
  } else {
    return `${base}/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.xz`
  }
}

export class DownloadManager extends EventEmitter {
  private configManager: ConfigManager
  private abortController: AbortController | null = null

  constructor(configManager: ConfigManager) {
    super()
    this.configManager = configManager
  }

  async checkEnvironment(): Promise<EnvInfo> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawPath = join(dataDir, 'openclaw', 'node_modules', '.bin', 'openclaw')

    const info: EnvInfo = {
      nodeInstalled: existsSync(nodePath),
      openClawInstalled: existsSync(clawPath),
      dataDir
    }
    console.log('环境信息:', info)
    if (info.nodeInstalled) {
      try {
        const { stdout } = await execAsync(`"${nodePath}" --version`)
        info.nodeVersion = stdout.trim()
      } catch { }
    }

    if (info.openClawInstalled) {
      try {
        const pkgPath = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'package.json')
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'))
          info.openClawVersion = pkg.version
        }
      } catch { }
    }

    return info
  }

  async getEnvInfo(): Promise<EnvInfo> {
    return this.checkEnvironment()
  }

  async initEnvironment(options: { useMirror?: boolean } = {}): Promise<{ success: boolean; error?: string }> {
    const { useMirror = true } = options
    this.abortController = new AbortController()

    try {
      const info = await this.checkEnvironment()

      // Step 1: 下载 Node.js
      if (!info.nodeInstalled) {
        await this._downloadNode(useMirror)
      } else {
        this._progress('Node.js', 'Node.js 已安装，跳过', 20, true)
      }

      // Step 2: 安装 OpenClaw
      if (!info.openClawInstalled) {
        await this._installOpenClaw(useMirror)
      } else {
        this._progress('OpenClaw', 'OpenClaw 已安装，跳过', 100, true)
      }

      // Step 3: 安装内置技能
      await this._installBuiltinSkills()

      this._progress('完成', '环境初始化完成！', 100, true)
      return { success: true }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { success: false, error: '用户取消了安装' }
      }
      this._progressError(err.message)
      return { success: false, error: err.message }
    }
  }

  private async _downloadNode(useMirror: boolean): Promise<void> {
    const dataDir = this.configManager.getDataDir()
    const platform = process.platform
    const arch = process.arch
    const runtimeDir = join(dataDir, 'runtime', `node-${platform}-${arch}`)

    mkdirSync(runtimeDir, { recursive: true })

    const url = getNodeDownloadUrl(useMirror)
    const fileName = url.split('/').pop()!
    const destFile = join(dataDir, 'runtime', fileName)

    this._progress('Node.js', `下载 Node.js ${NODE_VERSION}...`, 0)

    await this._downloadFile(url, destFile, (pct, speed) => {
      this._progress('Node.js', `下载 Node.js... ${speed}`, Math.floor(pct * 0.15))
    })

    this._progress('Node.js', '解压 Node.js...', 15)
    await this._extractArchive(destFile, join(dataDir, 'runtime'), runtimeDir, fileName)

    // 清理压缩包
    try { rmSync(destFile) } catch { }

    this._progress('Node.js', 'Node.js 安装完成', 20, true)
  }

  private async _installOpenClaw(useMirror: boolean): Promise<void> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const npmPath = nodePath.replace(/node(\.exe)?$/, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    const openClawDir = join(dataDir, 'openclaw')
    console.log('openClawDir', openClawDir)
    mkdirSync(openClawDir, { recursive: true })

    // 写入 package.json
    require('fs').writeFileSync(
      join(openClawDir, 'package.json'),
      // JSON.stringify({ name: 'claw-runtime', version: '1.0.0', private: true }, null, 2)
      JSON.stringify(
        {
          name: "openclaw-runtime",
          version: "1.0.0",
          dependencies: {
            openclaw: "2026.5.29",
            // openclaw 内置 Slack 插件的外部依赖，必须安装否则启动报错
            "@slack/web-api": "latest",
            "@slack/bolt": "latest",
            "@larksuiteoapi/node-sdk": "latest",
            "@zed-industries/codex-acp": "^0.11.1",
            "@tencent-weixin/openclaw-weixin": "latest",
          },
        },
        null, 2,
      ),
    )

    // const registry = useMirror ? `--registry ${MIRRORS.npm}` : ''
    // const cmd = `"${npmPath}" install openclaw ${registry} --prefer-offline`
    //  修改后的代码：如果不使用镜像，强行指定官方源；并且去掉缓存干扰
    const registry = useMirror ? `--registry ${MIRRORS.npm}` : '--registry https://registry.npmjs.org'
    // 如果不使用镜像，顺便把 --prefer-offline 关掉，确保去官方拉取最新包
    const cmd = `"${npmPath}" install openclaw ${registry} ${useMirror ? '--prefer-offline' : '--no-cache'}`

    this._progress('OpenClaw', '安装 OpenClaw...', 25)

    await new Promise<void>((resolve, reject) => {
      const proc = exec(cmd, { cwd: openClawDir })
      let lastLine = ''

      proc.stdout?.on('data', (d: string) => {
        lastLine = d.toString().trim()
        this._progress('OpenClaw', lastLine.slice(0, 60), 25 + Math.random() * 60)
      })
      proc.stderr?.on('data', (d: string) => {
        lastLine = d.toString().trim()
      })
      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm install 失败 (code ${code}): ${lastLine}`))
      })
    })

    this._progress('OpenClaw', 'OpenClaw 安装完成', 90, true)
    if (!useMirror) {
      // 防止卡顿进度卡住
      const isFinish = getAsyncResult()
      if (!isFinish) {
        this._progress('完成', '环境初始化完成！', 100, true)
      }
    }
  }

  private async _installBuiltinSkills(): Promise<void> {
    this._progress('技能', '安装内置中文技能包...', 92)
    // 技能安装由 ClawManager 负责，这里只是占位进度
    await new Promise((r) => setTimeout(r, 500))
    this._progress('技能', '技能包安装完成', 98, true)
  }

  private async _downloadFile(
    url: string,
    dest: string,
    onProgress?: (pct: number, speed: string) => void
  ): Promise<void> {
    const response = await fetch(url, { signal: this.abortController?.signal })
    if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)

    const total = Number(response.headers.get('content-length') || 0)
    let downloaded = 0
    let lastTime = Date.now()
    let lastBytes = 0

    const writer = createWriteStream(dest)
    const reader = response.body!.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      writer.write(value)
      downloaded += value.length

      const now = Date.now()
      if (now - lastTime > 500) {
        const speed = ((downloaded - lastBytes) / ((now - lastTime) / 1000) / 1024 / 1024).toFixed(1)
        const pct = total ? downloaded / total : 0
        onProgress?.(pct, `${speed} MB/s`)
        lastTime = now
        lastBytes = downloaded
      }
    }

    await new Promise<void>((res, rej) => writer.end((err?: Error) => err ? rej(err) : res()))
  }

  private async _extractArchive(file: string, outDir: string, finalDir: string, fileName: string): Promise<void> {
    const platform = process.platform

    if (platform === 'win32' && fileName.endsWith('.zip')) {
      const { default: AdmZip } = await import('adm-zip').catch(() => {
        throw new Error('需要 adm-zip 依赖来解压 zip 文件')
      })
      const zip = new AdmZip(file)
      zip.extractAllTo(outDir, true)
      console.log('解压完成')
      await new Promise(r => setTimeout(r, 500))
      // 重命名解压后的目录
      const extracted = join(outDir, fileName.replace('.zip', ''))
      if (existsSync(extracted) && extracted !== finalDir) {
        // require('fs').renameSync(extracted, finalDir)
        safeMove(extracted, finalDir)
      }
    } else {
      // tar.gz / tar.xz
      const flag = fileName.endsWith('.xz') ? 'J' : 'z'
      await execAsync(`tar -x${flag}f "${file}" -C "${outDir}"`)
      // 重命名
      const baseName = fileName.replace(/\.(tar\.(gz|xz)|zip)$/, '')
      const extracted = join(outDir, baseName)
      if (existsSync(extracted) && extracted !== finalDir) {
        // require('fs').renameSync(extracted, finalDir)
        safeMove(extracted, finalDir)
      }
    }
  }

  private _progress(stage: string, step: string, percent: number, done = false): void {
    const progress: DownloadProgress = { stage, step, percent, done }
    this.emit('progress', progress)
  }

  private _progressError(error: string): void {
    const progress: DownloadProgress = {
      stage: '错误',
      step: error,
      percent: 0,
      done: true,
      error
    }
    this.emit('progress', progress)
  }
}
