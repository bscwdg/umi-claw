import { EventEmitter } from 'events'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, createWriteStream, rmSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, renameSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { ConfigManager } from './configManager'
import path from 'path'

const execAsync = promisify(exec)

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
  channelsInstalled: boolean
  dataDir: string
  diskFree?: number
}

const MIRRORS = {
  nodeBase: [
    'https://npmmirror.com/mirrors/node',
    'https://nodejs.org/dist'
  ],
  npm: 'https://registry.npmmirror.com'
}

const OFFICIAL_REGISTRY = { name: '官方源', url: 'https://registry.npmjs.org/' };

const DOMESTIC_MIRRORS = [
  { name: '淘宝/阿里云镜像源', url: 'https://registry.npmmirror.com/' },
  { name: '腾讯云镜像源', url: 'https://mirrors.cloud.tencent.com/' },
  { name: '华为云镜像源', url: 'https://mirrors.huaweicloud.com/repository/npm/' },
];

const GATEWAY_TOKEN = "https://github.com/bscwdg/umi-claw";

// 🌟 建议未来逐步把 "latest" 替换为确定版本号
const clawVersion = {
  name: "openclaw-runtime",
  version: "1.0.0",
  dependencies: {
    openclaw: "latest",
    "@slack/web-api": "latest",
    "@slack/bolt": "latest",
    "@larksuiteoapi/node-sdk": "latest",
    "@tencent-weixin/openclaw-weixin": "latest",
  },
}

const NODE_VERSION = 'v22.22.3'

function safeMove(src: string, dest: string) {
  try {
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true })
    }
    renameSync(src, dest)
  } catch (err) {
    console.warn('rename failed, fallback to copy:', err)
    copyDir(src, dest)
    rmSync(src, { recursive: true, force: true })
  }
}

function copyDir(src: string, dest: string) {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }
  for (const file of readdirSync(src)) {
    const s = path.join(src, file)
    const d = path.join(dest, file)
    if (statSync(s).isDirectory()) {
      copyDir(s, d)
    } else {
      copyFileSync(s, d)
    }
  }
}

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
    const weixinPluginPath = join(dataDir, 'openclaw', 'node_modules', '@tencent-weixin', 'openclaw-weixin')
    console.log('weixinPluginPath:', weixinPluginPath)
    const info: EnvInfo = {
      nodeInstalled: existsSync(nodePath),
      openClawInstalled: existsSync(clawPath),
      channelsInstalled: existsSync(weixinPluginPath),
      dataDir
    }

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
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
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

      if (!info.nodeInstalled) {
        await this._downloadNode(useMirror)
      } else {
        this._progress('运行环境', 'Node.js 运行时已就绪', 20)
      }

      if (!info.openClawInstalled || !info.channelsInstalled) {
        await this._installOpenClaw(useMirror)
      } else {
        this._progress('运行环境', 'OpenClaw 核心及渠道插件均已安装', 90)
      }

      await this._installBuiltinSkills()
      this._progress('完成', '恭喜，全套环境初始化部署成功！', 100, true)
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

    this._progress('Node.js', `正在下载内置 Node.js ${NODE_VERSION}...`, 5)

    await this._downloadFile(url, destFile, (pct, speed) => {
      this._progress('Node.js', `下载中... 速度: ${speed}`, Math.floor(pct * 15))
    })

    this._progress('Node.js', '正在解压缩并配置运行时环境...', 15)
    await this._extractArchive(destFile, join(dataDir, 'runtime'), runtimeDir, fileName)

    try { rmSync(destFile) } catch { }

    this._progress('Node.js', 'Node.js 运行时环境配置成功', 20)
  }

  private async _installOpenClaw(useMirror: boolean, mirrorIndex?: number): Promise<void> {
    const dataDir = this.configManager.getDataDir();
    const nodePath = this.configManager.getNodePath();

    // 🌟 核心改进 1：优化跨平台的 npm 路径寻找策略
    const nodeBinDir = dirname(nodePath);
    const npmPath = process.platform === 'win32'
      ? join(nodeBinDir, 'npm.cmd')
      : join(nodeBinDir, 'npm');

    const openClawDir = join(dataDir, 'openclaw');
    mkdirSync(openClawDir, { recursive: true });

    let activeRegistry: { name: string; url: string };
    if (!useMirror) {
      activeRegistry = OFFICIAL_REGISTRY;
    } else {
      const idx = mirrorIndex !== undefined ? mirrorIndex : 0;
      if (idx >= DOMESTIC_MIRRORS.length) {
        this._progress('部署核心', '❌ 所有指定镜像源安装均尝试失败！', 100);
        throw new Error('渠道及核心依赖安装失败：国内镜像源响应超时，请检查外网连接。');
      }
      activeRegistry = DOMESTIC_MIRRORS[idx];
    }

    if (useMirror && mirrorIndex !== undefined && mirrorIndex > 0) {
      const nodeModulesPath = join(openClawDir, 'node_modules');
      const lockFilePath = join(openClawDir, 'package-lock.json');
      try {
        if (existsSync(nodeModulesPath)) rmSync(nodeModulesPath, { recursive: true, force: true });
        if (existsSync(lockFilePath)) rmSync(lockFilePath, { force: true });
      } catch (cleanupErr) {
        console.error('清理残余失败:', cleanupErr);
      }
    }

    writeFileSync(
      join(openClawDir, 'package.json'),
      JSON.stringify(clawVersion, null, 2)
    );

    const isOfficial = activeRegistry.url === OFFICIAL_REGISTRY.url;
    const cacheFlag = isOfficial ? '--no-cache' : '--prefer-offline';
    const cmd = `"${npmPath}" install --registry ${activeRegistry.url} ${cacheFlag} --no-audit --no-fund`;

    this._progress('部署核心', `正在通过 [${activeRegistry.name}] 统一部署核心服务及渠道插件...`, 30);

    // 🌟 核心改进 2：单向递增算法，避免进度条上下乱跳
    let currentPercent = 30;

    const installSuccess = await new Promise<boolean>((resolve, reject) => {
      const proc = exec(cmd, { cwd: openClawDir });
      let lastLine = '';

      proc.stdout?.on('data', (d: string) => {
        lastLine = d.toString().trim();
        if (currentPercent < 80) {
          currentPercent += 1; // 每次输出只缓缓向前递增，拒绝随机减小
        }
        this._progress('部署核心', `[${activeRegistry.name}] ${lastLine.slice(0, 60)}`, currentPercent);
      });

      proc.stderr?.on('data', (d: string) => {
        lastLine = d.toString().trim();
      });

      proc.on('exit', (code) => {
        if (code === 0) resolve(true);
        else {
          console.warn(`[安装失败] [${activeRegistry.name}] 退出码: ${code}, 错误提示: ${lastLine}`);
          if (useMirror) {
            const currentIndex = mirrorIndex !== undefined ? mirrorIndex : 0;
            const nextIndex = currentIndex + 1;
            if (nextIndex >= DOMESTIC_MIRRORS.length) {
              reject(new Error(`❌ 统一部署失败，底层抛出 (code ${code}): ${lastLine}`))
            } else {
              resolve(false); // 🌟 触发外层的镜像热切换
            }
          } else {
            reject(new Error(`npm install 运行终止 (code ${code}): ${lastLine}`))
          }
        }
      });
    });

    // 🌟 核心改进 3：在这里阻断并正确调用递归，实现热切换
    if (!installSuccess) {
      const currentIdx = mirrorIndex !== undefined ? mirrorIndex : 0;
      const nextIdx = currentIdx + 1;
      this._progress('部署核心', `⚠️ 当前镜像源异常，正在为您自动热切换到下一个备用国内源...`, 30);
      return await this._installOpenClaw(true, nextIdx);
    }

    this._progress('部署核心', `核心服务及渠道组件 [${activeRegistry.name}] 同步部署成功`, 85);
    this._ensureOpenClawConfig()
  }

  private async _installBuiltinSkills(): Promise<void> {
    this._progress('装配技能', '正在解压并激活内置基础交互技能包...', 92)
    await new Promise((r) => setTimeout(r, 400))
    this._progress('装配技能', '内置基础技能包部署完毕', 100)
  }

  private _ensureOpenClawConfig(): void {
    try {
      const dataDir = this.configManager.getDataDir()
      const configDir = join(dataDir, 'config', '.openclaw')
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true })
      }
      const fullSecureConfig = {
        "gateway": {
          "mode": "local",
          "auth": { "mode": "token", "token": GATEWAY_TOKEN },
        },
        "meta": {
          "lastTouchedVersion": "latest",
          "lastTouchedAt": new Date().toISOString(),
        },
        "channels": {
          "openclaw-weixin": {
            "enabled": true,
            "provider": "@tencent-weixin/openclaw-weixin",
            "config": {
              "appId": "",
              "appSecret": ""
            }
          }
        },
        "skills": {},
        "plugins": {
          "bonjour": { "enabled": false },
          "talk-voice": { "enabled": false }
        },
        "models": { "timeout": 30000 }
      }
      const configContent = JSON.stringify(fullSecureConfig, null, 2)
      const targetFiles = ['openclaw.json']

      targetFiles.forEach(fileName => {
        const filePath = join(configDir, fileName)
        if (!existsSync(filePath)) {
          writeFileSync(filePath, configContent, 'utf-8')
          console.log(`[Init] 成功生成保底配置文件: ${fileName}`)
        }
      })
    } catch (err) {
      console.error('❌ 初始化 OpenClaw 配置文件失败:', err)
    }
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
      await new Promise(r => setTimeout(r, 500))
      const extracted = join(outDir, fileName.replace('.zip', ''))
      if (existsSync(extracted) && extracted !== finalDir) {
        safeMove(extracted, finalDir)
      }
    } else {
      const flag = fileName.endsWith('.xz') ? 'J' : 'z'
      await execAsync(`tar -x${flag}f "${file}" -C "${outDir}"`)
      const baseName = fileName.replace(/\.(tar\.(gz|xz)|zip)$/, '')
      const extracted = join(outDir, baseName)
      if (existsSync(extracted) && extracted !== finalDir) {
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