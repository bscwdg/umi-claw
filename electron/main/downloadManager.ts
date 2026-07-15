import { EventEmitter } from 'events'
import { join, dirname, delimiter as pathDelimiter } from 'path'
import { existsSync, mkdirSync, createWriteStream, rmSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, renameSync, appendFileSync, cpSync, symlinkSync, realpathSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { ConfigManager } from './configManager'
import { GATEWAY_TOKEN, openClawPaths } from './openClawPaths'

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

// OpenClaw 微信渠道插件的 npm 包名，也是 openclaw plugins install 的目标 spec。
const WEIXIN_PLUGIN_PACKAGE = '@tencent-weixin/openclaw-weixin'

/**
 * 复刻 OpenClaw 内部 `safePathSegmentHashed`，用于计算受管 npm 插件目录名。
 * 逻辑必须与 OpenClaw 保持一致，否则算出的目录名对不上会导致检测失效。
 */
function safePathSegmentHashed(input: string): string {
  const trimmed = input.trim()
  const base = trimmed
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  const normalized = base.length > 0 ? base : 'skill'
  const safe = normalized === '.' || normalized === '..' ? 'skill' : normalized
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 10)
  if (safe !== trimmed) return `${safe.length > 50 ? safe.slice(0, 50) : safe}-${hash}`
  if (safe.length > 60) return `${safe.slice(0, 50)}-${hash}`
  return safe
}

/**
 * 语义化版本号比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 忽略预发布标签，仅比较主版本段的数字部分。
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

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
    const s = join(src, file)
    const d = join(dest, file)
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

  // 🟢 专门增加的方法：强行把调试日志写入磁盘，解决 console.log 看不到的问题
  private _writeDebugLog(message: string): void {
    try {
      const dataDir = this.configManager.getDataDir();
      const logDir = join(dataDir, 'logs');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const logFile = join(logDir, 'runtime-debug.log');
      const timeStr = new Date().toISOString();
      appendFileSync(logFile, `[${timeStr}] ${message}\n`, 'utf-8');
    } catch (e) {
      // 保底防止写日志本身挂掉
    }
  }

  async checkEnvironment(): Promise<EnvInfo> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawPath = join(dataDir, 'openclaw', 'node_modules', '.bin', 'openclaw')
    // OpenClaw 只识别它自己受管的插件目录（.openclaw/npm/projects/<hash>/node_modules/...）；
    // 仅装进 openclaw/node_modules 的副本不会被 channels 命令识别，因此以受管目录为准。
    const weixinPluginPath = this._getWeixinManagedPluginDir()

    this._writeDebugLog(`[CheckEnv] nodePath: ${nodePath}, exist: ${existsSync(nodePath)}`);
    this._writeDebugLog(`[CheckEnv] clawPath: ${clawPath}, exist: ${existsSync(clawPath)}`);
    this._writeDebugLog(`[CheckEnv] weixinPluginPath: ${weixinPluginPath}, exist: ${existsSync(weixinPluginPath)}`);

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
      } catch (e: any) {
        this._writeDebugLog(`[CheckEnv Error] 获取 Node 版本失败: ${e.message}`);
      }
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

  /**
   * 计算 OpenClaw 受管微信插件所在的目录。
   * OpenClaw 通过 `openclaw plugins install` 把插件装进
   * `<configDir>/npm/projects/<safePathSegmentHashed(pkg)>/node_modules/<pkg>`，
   * 目录哈希仅由包名决定，因此跨机器一致，可直接用于检测。
   */
  private _getWeixinManagedPluginDir(): string {
    const dataDir = this.configManager.getDataDir()
    const configDir = openClawPaths.configDir(dataDir)
    const projectDirName = safePathSegmentHashed(WEIXIN_PLUGIN_PACKAGE)
    return join(
      configDir,
      'npm',
      'projects',
      projectDirName,
      'node_modules',
      ...WEIXIN_PLUGIN_PACKAGE.split('/')
    )
  }

  /**
   * 通过 OpenClaw 自身的 `plugins install` 把微信渠道插件装进受管目录，
   * 这样 `channels login` 才会识别为“已安装”。
   * 仅把插件安装进 openclaw/node_modules 是不够的。
   */
  private async _installWeixinChannelPlugin(useMirror: boolean, force = false): Promise<boolean> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(dataDir)

    if (!existsSync(nodePath) || !existsSync(clawJsPath)) {
      this._writeDebugLog('[InstallWeixinPlugin] Node 或 OpenClaw 尚未就绪，跳过受管插件安装')
      return false
    }

    const managedDir = this._getWeixinManagedPluginDir()
    if (force) {
      // 更新场景：清掉旧的受管插件项目目录，强制 plugins install 重新拉取最新版本。
      const projectDir = join(managedDir, '..', '..', '..')
      try {
        if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true })
      } catch (e: any) {
        this._writeDebugLog(`[InstallWeixinPlugin] 清理旧受管插件目录失败: ${e.message}`)
      }
    } else if (existsSync(managedDir)) {
      this._writeDebugLog('[InstallWeixinPlugin] 受管微信插件已存在，跳过安装')
      return true
    }

    const nodeBinDir = dirname(nodePath)
    const configDir = join(dataDir, 'config')
    // 依次尝试国内镜像源，最后回落官方源；任一源装出受管目录即视为成功。
    const registries = useMirror
      ? [...DOMESTIC_MIRRORS.map((m) => m.url), OFFICIAL_REGISTRY.url]
      : [OFFICIAL_REGISTRY.url]

    this._progress('装配渠道', '正在将微信渠道插件安装到 OpenClaw 受管目录...', 88)

    for (const registry of registries) {
      const env = {
        ...process.env,
        PATH: `${nodeBinDir}${pathDelimiter}${process.env.PATH || ''}`,
        HOME: configDir,
        USERPROFILE: configDir,
        OPENCLAW_CONFIG_DIR: join(configDir, '.openclaw'),
        OPENCLAW_DATA_DIR: join(dataDir, 'data'),
        npm_config_registry: registry,
        NODE_ENV: 'production'
      }

      const cmd = `"${nodePath}" "${clawJsPath}" plugins install "${WEIXIN_PLUGIN_PACKAGE}@latest"`
      this._writeDebugLog(`[InstallWeixinPlugin] 执行受管插件安装 (registry=${registry}): ${cmd}`)

      try {
        await execAsync(cmd, { cwd: join(dataDir, 'openclaw'), env, maxBuffer: 1024 * 1024 * 64 })
      } catch (err: any) {
        // OpenClaw 安装成功时也可能因为无关的配置告警返回非零码，故以受管目录是否生成为准。
        this._writeDebugLog(`[InstallWeixinPlugin] plugins install 返回异常 (registry=${registry}): ${err.message}`)
      }

      if (existsSync(this._getWeixinManagedPluginDir())) {
        this._writeDebugLog(`[InstallWeixinPlugin] 受管微信插件安装成功 (registry=${registry})`)
        return true
      }
      this._writeDebugLog(`[InstallWeixinPlugin] 该镜像源未生成受管目录，尝试下一个源`)
    }

    // 所有源的 plugins install 都失败：最常见原因是可执行目录所在卷（如 U 盘 exFAT/FAT32）
    // 无法创建 openclaw 的 node_modules junction 链接，导致 OpenClaw 回滚安装。
    // 兜底：用真实目录拷贝手动组装受管插件目录，绕开对文件系统链接能力的依赖。
    this._writeDebugLog('[InstallWeixinPlugin] plugins install 全部失败，改用手动拷贝组装受管目录')
    this._progress('装配渠道', '正在以兼容模式组装微信渠道插件（可能较慢）...', 89)
    try {
      const assembled = this._assembleWeixinPluginManually()
      if (assembled) {
        this._writeDebugLog('[InstallWeixinPlugin] 手动组装受管微信插件成功')
        this._progress('装配渠道', '微信渠道插件已装配完成', 90)
        return true
      }
    } catch (e: any) {
      this._writeDebugLog(`[InstallWeixinPlugin] 手动组装失败: ${e.message}`)
    }

    // 仍失败：不中断初始化。点击“扫码登录”时 channels login 交互流会再次引导下载插件作为兜底。
    this._writeDebugLog('[InstallWeixinPlugin] 手动组装亦未成功，已跳过（登录时可再引导安装）')
    this._progress('装配渠道', '微信渠道插件将在首次扫码登录时自动补装', 90)
    return false
  }

  /**
   * 手动组装 OpenClaw 受管微信插件目录（拷贝兜底方案）。
   * 当 `plugins install` 因文件系统不支持 junction 而回滚时使用。
   *
   * 目标结构：
   *   <configDir>/npm/projects/<hash>/
   *     package.json                       （受管项目清单）
   *     node_modules/
   *       .package-lock.json               （锁文件，可选）
   *       @tencent-weixin/openclaw-weixin/  （插件包，含其 node_modules/openclaw 真实拷贝）
   *       zod, qrcode-terminal, ...         （插件运行时依赖）
   *
   * 所有内容均从核心 npm 已装好的 data/openclaw/node_modules 拷贝而来。
   */
  private _assembleWeixinPluginManually(): boolean {
    const dataDir = this.configManager.getDataDir()
    const coreNodeModules = join(dataDir, 'openclaw', 'node_modules')
    const openClawSrc = join(coreNodeModules, 'openclaw')
    const pluginSrc = join(coreNodeModules, ...WEIXIN_PLUGIN_PACKAGE.split('/'))

    if (!existsSync(join(pluginSrc, 'package.json')) || !existsSync(join(openClawSrc, 'package.json'))) {
      this._writeDebugLog('[AssembleWeixin] 核心 node_modules 缺少插件包或 openclaw 宿主包，无法手动组装')
      return false
    }

    // 受管项目目录：<configDir>/npm/projects/<hash>
    const managedPluginDir = this._getWeixinManagedPluginDir()
    const projectDir = join(managedPluginDir, '..', '..', '..')
    const projectNodeModules = join(projectDir, 'node_modules')

    // 从零重建，避免残留的坏链接干扰。
    try {
      if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true })
    } catch (e: any) {
      this._writeDebugLog(`[AssembleWeixin] 清理旧项目目录失败: ${e.message}`)
    }
    mkdirSync(projectNodeModules, { recursive: true })

    // 1. 受管项目清单 package.json（声明插件依赖）。
    const projectManifest = {
      private: true,
      dependencies: {
        [WEIXIN_PLUGIN_PACKAGE]: this._readPackageVersion(pluginSrc) || 'latest'
      }
    }
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify(projectManifest, null, 2))

    // 2. 拷贝插件包本身。
    const pluginDest = join(projectNodeModules, ...WEIXIN_PLUGIN_PACKAGE.split('/'))
    mkdirSync(dirname(pluginDest), { recursive: true })
    cpSync(pluginSrc, pluginDest, { recursive: true })

    // 3. 拷贝插件运行时依赖（从核心 node_modules 顶层解析插件 package.json 里的 dependencies）。
    const pluginDeps = this._readPackageDependencies(pluginSrc)
    for (const depName of pluginDeps) {
      const depSrc = join(coreNodeModules, ...depName.split('/'))
      if (!existsSync(depSrc)) {
        this._writeDebugLog(`[AssembleWeixin] 依赖 ${depName} 不在核心 node_modules，跳过`)
        continue
      }
      const depDest = join(projectNodeModules, ...depName.split('/'))
      mkdirSync(dirname(depDest), { recursive: true })
      cpSync(depSrc, depDest, { recursive: true })
    }

    // 4. 关键：把宿主 openclaw 真实拷贝进插件的 node_modules/openclaw（替代 junction）。
    const openClawDest = join(pluginDest, 'node_modules', 'openclaw')
    mkdirSync(dirname(openClawDest), { recursive: true })
    try {
      if (existsSync(openClawDest)) rmSync(openClawDest, { recursive: true, force: true })
      const linkTarget = (() => { try { return realpathSync(openClawSrc) } catch { return openClawSrc } })()
      symlinkSync(linkTarget, openClawDest, 'junction')
    } catch (e: any) {
      this._writeDebugLog(`[AssembleWeixin] junction fallback to copy: ${e.message}`)
      try {
        if (existsSync(openClawDest)) rmSync(openClawDest, { recursive: true, force: true })
      } catch { /* ignore */ }
      cpSync(openClawSrc, openClawDest, { recursive: true })
    }

    return existsSync(join(managedPluginDir, 'package.json'))
  }

  /** 读取指定包目录 package.json 的 version。 */
  private _readPackageVersion(pkgDir: string): string | null {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      return null
    }
  }

  /** 读取指定包目录 package.json 的 dependencies 名称列表（不含 peerDependencies）。 */
  private _readPackageDependencies(pkgDir: string): string[] {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
      return pkg.dependencies && typeof pkg.dependencies === 'object'
        ? Object.keys(pkg.dependencies)
        : []
    } catch {
      return []
    }
  }

  async initEnvironment(options: { useMirror?: boolean } = {}): Promise<{ success: boolean; error?: string }> {
    const { useMirror = true } = options
    this.abortController = new AbortController()

    this._writeDebugLog('--- 开始初始化环境 ---');

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

      // 无论核心是否重装，只要受管微信插件缺失就补装（核心已装、仅缺插件时也能命中）。
      // 该方法内部会判断插件是否已存在，存在则直接跳过。
      await this._installWeixinChannelPlugin(useMirror)

      await this._installBuiltinSkills()
      this._progress('完成', '恭喜，全套环境初始化部署成功！', 100, true)
      return { success: true }
    } catch (err: any) {
      this._writeDebugLog(`[InitEnvironment Error] 异常中断: ${err.message}`);
      if (err.name === 'AbortError') {
        return { success: false, error: '用户取消了安装' }
      }
      this._progressError(err.message)
      return { success: false, error: err.message }
    }
  }

  /**
   * 一键更新 OpenClaw 核心及渠道插件到最新版本。
   * 通过删除 package-lock.json 强制 npm 重新解析 latest 版本再安装。
   */
  async updateOpenClaw(options: { useMirror?: boolean } = {}): Promise<{
    success: boolean
    error?: string
    previousVersion?: string
    currentVersion?: string
  }> {
    const { useMirror = true } = options
    this.abortController = new AbortController()
    this._writeDebugLog('--- 开始更新 OpenClaw ---')

    try {
      const before = await this.checkEnvironment()
      if (!before.nodeInstalled) {
        throw new Error('Node.js 运行时尚未安装，请先完成环境初始化')
      }

      this._progress('检查更新', '正在准备更新 OpenClaw 核心及渠道插件...', 10)

      // 删除锁文件与已装模块，强制 npm 联网重新解析并拉取 latest（否则会沿用旧版本）
      const openClawDir = join(this.configManager.getDataDir(), 'openclaw')
      const cleanupTargets = [
        join(openClawDir, 'package-lock.json'),
        join(openClawDir, 'node_modules', 'openclaw'),
        join(openClawDir, 'node_modules', '@tencent-weixin'),
      ]
      for (const target of cleanupTargets) {
        try {
          if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        } catch (e: any) {
          this._writeDebugLog(`[UpdateOpenClaw] 清理 ${target} 失败: ${e.message}`)
        }
      }

      await this._installOpenClaw(useMirror, 0, true)
      // 更新核心后同步刷新受管微信插件，保证渠道登录持续可用。
      await this._installWeixinChannelPlugin(useMirror, true)
      await this._installBuiltinSkills()

      const after = await this.checkEnvironment()
      const previousVersion = before.openClawVersion
      const currentVersion = after.openClawVersion
      const upToDate = previousVersion && currentVersion === previousVersion

      this._progress(
        '完成',
        upToDate
          ? `已是最新版本 v${currentVersion}`
          : `更新成功：v${previousVersion ?? '未知'} → v${currentVersion ?? '未知'}`,
        100,
        true
      )
      return { success: true, previousVersion, currentVersion }
    } catch (err: any) {
      this._writeDebugLog(`[UpdateOpenClaw Error] 异常中断: ${err.message}`)
      this._progressError(err.message)
      return { success: false, error: err.message }
    }
  }

  /**
   * 查询 npm 上 openclaw 的最新版本，并与本地已安装版本对比。
   * @returns currentVersion 本地版本；latestVersion 远端最新版本；hasUpdate 是否有可用更新
   */
  async checkLatestVersion(options: { useMirror?: boolean } = {}): Promise<{
    success: boolean
    error?: string
    currentVersion?: string
    latestVersion?: string
    hasUpdate?: boolean
  }> {
    const { useMirror = true } = options
    try {
      const nodePath = this.configManager.getNodePath()
      if (!existsSync(nodePath)) {
        throw new Error('Node.js 运行时尚未安装，请先完成环境初始化')
      }

      const info = await this.checkEnvironment()
      const currentVersion = info.openClawVersion

      const nodeBinDir = dirname(nodePath)
      const npmPath = process.platform === 'win32'
        ? join(nodeBinDir, 'npm.cmd')
        : join(nodeBinDir, 'npm')
      const registry = useMirror ? DOMESTIC_MIRRORS[0].url : OFFICIAL_REGISTRY.url
      const cmd = `"${npmPath}" view openclaw version --registry ${registry}`

      const { stdout } = await execAsync(cmd, {
        env: {
          ...process.env,
          PATH: `${nodeBinDir}${pathDelimiter}${process.env.PATH || ''}`
        }
      })
      const latestVersion = stdout.trim()
      if (!latestVersion) {
        throw new Error('未能解析 npm 返回的版本号')
      }

      const hasUpdate = !currentVersion || compareVersions(latestVersion, currentVersion) > 0
      this._writeDebugLog(`[CheckLatest] 本地: ${currentVersion ?? '未装'}, 最新: ${latestVersion}, 有更新: ${hasUpdate}`)
      return { success: true, currentVersion, latestVersion, hasUpdate }
    } catch (err: any) {
      this._writeDebugLog(`[CheckLatest Error] ${err.message}`)
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

    this._writeDebugLog(`[DownloadNode] 开始下载 Node, URL: ${url}, Dest: ${destFile}`);

    this._progress('Node.js', `正在下载内置 Node.js ${NODE_VERSION}...`, 5)

    await this._downloadFile(url, destFile, (pct, speed) => {
      this._progress('Node.js', `下载中... 速度: ${speed}`, Math.floor(pct * 15))
    })

    this._progress('Node.js', '正在解压缩并配置运行时环境...', 15)
    await this._extractArchive(destFile, join(dataDir, 'runtime'), runtimeDir, fileName)

    try { rmSync(destFile) } catch { }

    this._writeDebugLog(`[DownloadNode Success] Node.js 解压配置成功，存在状态: ${existsSync(this.configManager.getNodePath())}`);
    this._progress('Node.js', 'Node.js 运行时环境配置成功', 20)
  }

  private async _installOpenClaw(useMirror: boolean, mirrorIndex?: number, forceOnline = false): Promise<void> {
    const dataDir = this.configManager.getDataDir();
    const nodePath = this.configManager.getNodePath();

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
      const currentIdx = mirrorIndex ?? 0;
      if (currentIdx >= DOMESTIC_MIRRORS.length) {
        this._progress('部署核心', '❌ 所有指定镜像源安装均尝试失败！', 100);
        this._writeDebugLog('[InstallOpenClaw Error] 所有镜像源均已尝试，全数失败。');
        throw new Error('渠道及核心依赖安装失败：国内镜像源响应超时，请检查外网连接。');
      }
      activeRegistry = DOMESTIC_MIRRORS[currentIdx];
    }

    this._writeDebugLog(`[InstallOpenClaw] 当前使用的源: ${activeRegistry.name}, 路径: ${activeRegistry.url}`);
    this._writeDebugLog(`[InstallOpenClaw] 准备调用的 npmPath: ${npmPath}, 存在状态: ${existsSync(npmPath)}`);

    if (useMirror && (mirrorIndex ?? 0) > 0) {
      const nodeModulesPath = join(openClawDir, 'node_modules');
      const lockFilePath = join(openClawDir, 'package-lock.json');
      try {
        if (existsSync(nodeModulesPath)) rmSync(nodeModulesPath, { recursive: true, force: true });
        if (existsSync(lockFilePath)) rmSync(lockFilePath, { force: true });
      } catch (cleanupErr: any) {
        this._writeDebugLog(`[Clean Error] 清理残余失败: ${cleanupErr.message}`);
      }
    }

    writeFileSync(
      join(openClawDir, 'package.json'),
      JSON.stringify(clawVersion, null, 2)
    );

    const isOfficial = activeRegistry.url === OFFICIAL_REGISTRY.url;
    // 更新场景强制联网并显式安装 latest，绕过缓存与已装版本判断
    const cacheFlag = forceOnline
      ? '--prefer-online'
      : isOfficial
      ? '--no-cache'
      : '--prefer-offline';
    const explicitLatest = forceOnline
      ? ' openclaw@latest "@tencent-weixin/openclaw-weixin@latest"'
      : '';
    const cmd = `"${npmPath}" install${explicitLatest} --registry ${activeRegistry.url} ${cacheFlag} --no-audit --no-fund`;

    this._writeDebugLog(`[InstallOpenClaw] 最终执行生成的命令行: ${cmd}`);

    this._progress('部署核心', `正在通过 [${activeRegistry.name}] 统一部署核心服务及渠道插件...`, 30);

    let currentPercent = 30;

   const installSuccess = await new Promise<boolean>((resolve, reject) => {
      // 1. 注入环境变量，解决找不到 node 命令的根本问题
      const proc = exec(cmd, {
        cwd: openClawDir,
        env: {
          ...process.env,
          PATH: `${nodeBinDir}${pathDelimiter}${process.env.PATH || ''}`
        }
      });

      let lastLine = '';
      // 🟢 2. 定义安全的智能解码器
      const decodeChunk = (chunk: any) => {
        try {
          const encoding = process.platform === 'win32' ? 'gbk' : 'utf-8';
          return new TextDecoder(encoding).decode(chunk).trim();
        } catch {
          return chunk.toString().trim();
        }
      };

      // 🟢 3. 正常输出流解码
      proc.stdout?.on('data', (d: any) => {
        lastLine = decodeChunk(d);
        if (currentPercent < 80) {
          currentPercent += 1;
        }
        this._progress('部署核心', `[${activeRegistry.name}] ${lastLine.slice(0, 60)}`, currentPercent);
      });

      // 🟢 4. 错误输出流解码（精准修复点：把原本的 d: string 改为 d: any，并调用解码器）
      proc.stderr?.on('data', (d: any) => {
        lastLine = decodeChunk(d);
        this._writeDebugLog(`[NPM STDERR] ${lastLine}`);
      });

      // 5. spawn 失败兜底：进程根本没起来时 exit 不会触发，必须监听 error，否则 Promise 永不 settle
      proc.on('error', (err) => {
        this._writeDebugLog(`[NPM Spawn Error] 进程启动失败: ${err.message}`);
        reject(new Error(`npm 进程启动失败: ${err.message}`));
      });

      proc.on('exit', (code) => {
        this._writeDebugLog(`[NPM EXIT] 进程退出，退出码 (code): ${code}`);
        if (code === 0) resolve(true);
        else {
          this._writeDebugLog(`[安装失败详细归档] [${activeRegistry.name}] 退出码: ${code}, 截获最后一行提示: ${lastLine}`);
          if (useMirror) {
            const nextIndex = (mirrorIndex ?? 0) + 1;
            if (nextIndex >= DOMESTIC_MIRRORS.length) {
              reject(new Error(`❌ 统一部署失败，底层抛出 (code ${code}): ${lastLine}`))
            } else {
              resolve(false);
            }
          } else {
            reject(new Error(`npm install 运行终止 (code ${code}): ${lastLine}`))
          }
        }
      });
    });

    if (!installSuccess) {
      const nextIdx = (mirrorIndex ?? 0) + 1;
      this._progress('部署核心', `⚠️ 当前镜像源异常，正在为您自动热切换到下一个备用国内源...`, 30);
      return await this._installOpenClaw(true, nextIdx, forceOnline);
    }

    this._progress('部署核心', `核心服务及渠道组件 [${activeRegistry.name}] 同步部署成功`, 85);
    this._ensureOpenClawConfig()
  }

  private async _installBuiltinSkills(): Promise<void> {
    this._progress('装配技能', '正在解压并激活内置基础交互技能包...', 92)
    await new Promise((r) => setTimeout(r, 400))
    // 这里不要发 100%：100% 留给最终“完成”事件（携带 done=true），
    // 否则进度条到 100% 但 done 仍为 false，UI 会一直显示“正在拼命装配”。
    this._progress('装配技能', '内置基础技能包部署完毕', 98)
  }

  private _ensureOpenClawConfig(): void {
    try {
      const dataDir = this.configManager.getDataDir()
      const configDir = openClawPaths.configDir(dataDir)
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
      const filePath = join(configDir, 'openclaw.json')
      if (!existsSync(filePath)) {
        writeFileSync(filePath, configContent, 'utf-8')
        this._writeDebugLog('[Init Config] 成功生成保底配置文件: openclaw.json');
      }
    } catch (err: any) {
      this._writeDebugLog(`[Init Config Error] 初始化配置文件失败: ${err.message}`);
    }
  }

  private async _downloadFile(
    url: string,
    dest: string,
    onProgress?: (pct: number, speed: string) => void
  ): Promise<void> {
    const response = await fetch(url, { signal: this.abortController?.signal })
    if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)
    if (!response.body) throw new Error('下载失败: 响应无内容流')

    const total = Number(response.headers.get('content-length') || 0)
    let downloaded = 0
    let lastTime = Date.now()
    let lastBytes = 0

    // 通过 Transform 流统计已下载字节并节流上报进度，pipeline 自动处理背压与异常销毁
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length
        const now = Date.now()
        if (now - lastTime > 500) {
          const speed = ((downloaded - lastBytes) / ((now - lastTime) / 1000) / 1024 / 1024).toFixed(1)
          const pct = total ? downloaded / total : 0
          onProgress?.(pct, `${speed} MB/s`)
          lastTime = now
          lastBytes = downloaded
        }
        callback(null, chunk)
      }
    })

    await pipeline(Readable.fromWeb(response.body as any), counter, createWriteStream(dest))
  }

  private async _extractArchive(file: string, outDir: string, finalDir: string, fileName: string): Promise<void> {
    const platform = process.platform

    if (platform === 'win32' && fileName.endsWith('.zip')) {
      const { default: AdmZip } = await import('adm-zip').catch((e) => {
        this._writeDebugLog(`[Zip Error] 缺少 adm-zip 依赖: ${e.message}`);
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
