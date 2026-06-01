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

const OFFICIAL_REGISTRY = { name: '官方源', url: 'https://registry.npmjs.org/' };
// 由于在测试中经常安装openclaw失败，所以增加重新更换国内镜像功能
const DOMESTIC_MIRRORS = [
  { name: '淘宝/阿里云镜像源', url: 'https://registry.npmmirror.com/' },
  { name: '腾讯云镜像源', url: 'https://mirrors.cloud.tencent.com' },
  { name: '华为云镜像源', url: 'https://mirrors.huaweicloud.com/repository/npm/' },
  { name: '火山云镜像源', url: 'https://mirror-cn.clawhub.com/npm/' },
];
const clawVersion = {
  name: "openclaw-runtime",
  version: "1.0.0",
  dependencies: {
    openclaw: "2026.4.29",
    // openclaw 内置 Slack 插件的外部依赖，必须安装否则启动报错
    "@slack/web-api": "latest",
    "@slack/bolt": "latest",
    "@larksuiteoapi/node-sdk": "latest",
    "@zed-industries/codex-acp": "^0.11.1",
    "@tencent-weixin/openclaw-weixin": "latest",
  },
}

// node版本
const NODE_VERSION = 'v22.22.3'

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
      this._progress('完成', '恭喜，环境初始化完成！', 100, true)
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

  /**
   *  OpenClaw 安装方法
   * @param useMirror 是否允许使用国内镜像。如果为 false，失败时绝不换源重试！
   * @param mirrorIndex 当前正在尝试的国内镜像索引（内部递归使用）
   */
  private async _installOpenClaw(useMirror: boolean, mirrorIndex?: number): Promise<void> {
    const dataDir = this.configManager.getDataDir();
    const nodePath = this.configManager.getNodePath();
    const npmPath = nodePath.replace(/node(\.exe)?$/, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const openClawDir = join(dataDir, 'openclaw');
    console.log('openClawDir', openClawDir);
    mkdirSync(openClawDir, { recursive: true });
    // 1. 🎯 确定当前本次执行使用的具体源
    let activeRegistry: { name: string; url: string };
    if (!useMirror) {
      // 【严格模式】用户不使用镜像，每次进来（包括潜在的重试）都只能是官方源
      activeRegistry = OFFICIAL_REGISTRY;
    } else {
      // 【镜像模式】用户允许使用镜像
      const idx = mirrorIndex !== undefined ? mirrorIndex : 0;
      // 如果镜像数组越界，说明国内所有的镜像都试过了
      if (idx >= DOMESTIC_MIRRORS.length) {
        console.log('1111111111111111111111111')
        this._progress('OpenClaw', '❌ 所有国内镜像源均尝试失败！', 100);
        // throw new Error('OpenClaw 安装失败：已尝试完所有国内镜像源，均无法完成安装。');
      }
      activeRegistry = DOMESTIC_MIRRORS[idx];
    }
    // 2. 清理残余文件（仅在重试发生时执行，即 mirrorIndex 大于 0 时）
    if (useMirror && mirrorIndex !== undefined && mirrorIndex > 0) {
      const nodeModulesPath = join(openClawDir, 'node_modules');
      const lockFilePath = join(openClawDir, 'package-lock.json');
      try {
        if (require('fs').existsSync(nodeModulesPath)) {
          require('fs').rmSync(nodeModulesPath, { recursive: true, force: true });
        }
        if (require('fs').existsSync(lockFilePath)) {
          require('fs').rmSync(lockFilePath, { force: true });
        }
      } catch (cleanupErr) {
        console.error('清理残余失败:', cleanupErr);
      }
    }

    // 3. 写入 package.json
    require('fs').writeFileSync(
      join(openClawDir, 'package.json'),
      JSON.stringify(
        clawVersion,
        null,
        2,
      ),
    );

    // 4. 拼装命令：官方源不使用缓存，国内源开启 --prefer-offline 提速
    const isOfficial = activeRegistry.url === OFFICIAL_REGISTRY.url;
    const cacheFlag = isOfficial ? '--no-cache' : '--prefer-offline';
    const cmd = `"${npmPath}" install --registry ${activeRegistry.url} ${cacheFlag}`;

    this._progress('OpenClaw', `正在通过 [${activeRegistry.name}] 安装 OpenClaw...`, 25);

    // 5. 执行安装进程
    const installSuccess = await new Promise<boolean>((resolve, reject) => {
      const proc = exec(cmd, { cwd: openClawDir });
      let lastLine = '';

      proc.stdout?.on('data', (d: string) => {
        lastLine = d.toString().trim();
        this._progress('OpenClaw', `[${activeRegistry.name}] ${lastLine.slice(0, 50)}`, 25 + Math.random() * 50);
      });

      proc.stderr?.on('data', (d: string) => {
        lastLine = d.toString().trim();
      });

      proc.on('exit', (code) => {
        if (code === 0) resolve(true);
        else {
          console.warn(`[安装失败] [${activeRegistry.name}] 退出码: ${code}, 错误: ${lastLine}`);
          if (useMirror) {
            console.log(`正在尝试使用其他国内镜像源...`)
            const currentIndex = mirrorIndex !== undefined ? mirrorIndex : 0;
            const nextIndex = currentIndex + 1;
            if (nextIndex >= DOMESTIC_MIRRORS.length) {
              reject(new Error(`❌ 使用国内镜像安装失败，失败原因 (code ${code}): ${lastLine}`))
            } else {
              resolve(false);
            }
          } else {
            reject(new Error(`npm install 失败 (code ${code}): ${lastLine}`))
          }
        }
      });
    });

    // 6. 🎯 核心流向判定：严格分流控制
    if (installSuccess) {
      // ── 无论什么源，只要成功了，直接拉满到 100% 结束 ──
      this._progress('OpenClaw', `OpenClaw [${activeRegistry.name}] 安装完成`, 90, true);
      this._ensureOpenClawConfig()
      this._progress('完成', '环境初始化完成！', 100, true);
      return;
    }

    // ── 如果安装失败了 ──
    if (!useMirror) {
      // ❌ 【严格模式】用户说了不用镜像。官方源既然失败了，直接抛出异常，不再向下走任何重试！
      this._progress('OpenClaw', `❌ 官方源安装失败。`, 100, true);
      throw new Error(`OpenClaw 安装失败：官方源连接超时或下载被中断，请开启“使用镜像”后重试。`);
    } else {
      // 🔄 【镜像模式】用户允许使用镜像。当前镜像挂了，递增索引去尝试下一个国内源
      const currentIdx = mirrorIndex !== undefined ? mirrorIndex : 0;
      const nextIdx = currentIdx + 1;

      this._progress('OpenClaw', `⚠️ 当前镜像源下载失败，正在为您自动切换到下一个国内镜像...`, 30);
      return await this._installOpenClaw(true, nextIdx);
    }
  }
  private async _installBuiltinSkills(): Promise<void> {
    this._progress('技能', '安装内置中文技能包...', 92)
    // 技能安装由 ClawManager 负责，这里只是占位进度
    await new Promise((r) => setTimeout(r, 500))
    this._progress('技能', '技能包安装完成', 98, true)
    await new Promise((r) => setTimeout(r, 500))
  }

  /**
   * 初始化openclaw配置文件
   */
  private _ensureOpenClawConfig(): void {
    try {
      const dataDir = this.configManager.getDataDir()
      // 精准对接启动脚本的环境变量 OPENCLAW_CONFIG_DIR
      const configDir = join(dataDir, 'config', '.openclaw')
      // 确保目录一定存在
      if (!require('fs').existsSync(configDir)) {
        require('fs').mkdirSync(configDir, { recursive: true })
      }
      const fullSecureConfig = {
        gateway: {
          mode: "local",
          allowUnconfigured: true
        },
        // 预防某些配置加载器只认扁平化的 key
        "gateway.mode": "local",
        "gateway.allowUnconfigured": true,
        storage: {
          driver: "local"
        },
        "storage.driver": "local",
        channels: {},
        skills: {}
      }
      const configContent = JSON.stringify(fullSecureConfig, null, 2)
      const targetFiles = [
        'config.json',       // 基础名
        'oepenClaw.json',      // node-config 默认生产名
        'local.json'         // 本地保底名
      ]
      targetFiles.forEach(fileName => {
        const filePath = join(configDir, fileName)
        // 只有文件不存在时才写入，保护用户已有配置
        if (!require('fs').existsSync(filePath)) {
          require('fs').writeFileSync(filePath, configContent, 'utf-8')
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
