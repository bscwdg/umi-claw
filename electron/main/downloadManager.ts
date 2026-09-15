import { EventEmitter } from 'events'
import { join, dirname, delimiter as pathDelimiter } from 'path'
import { existsSync, mkdirSync, createWriteStream, rmSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, renameSync, appendFileSync, cpSync, symlinkSync, realpathSync } from 'fs'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { ConfigManager } from './configManager'
import { GATEWAY_TOKEN, openClawPaths } from './openClawPaths'
import { subprocessRegistry } from './subprocessRegistry'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

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

// 新装环境内置的默认 Node 版本：必须满足 OpenClaw 2026.9.4+ 的引擎要求
// (>=24.16.0 <25 || >=26.1.0)，OpenClaw 安装前会执行 preinstall 引擎检查。
const NODE_VERSION = 'v24.21.0'

// OpenClaw 微信渠道插件的 npm 包名，也是 openclaw plugins install 的目标 spec。
const WEIXIN_PLUGIN_PACKAGE = '@tencent-weixin/openclaw-weixin'

/**
 * OpenClaw 更新前的回滚快照描述：live 为当前路径，backup 为同卷改名后的快照路径。
 * 同卷 rename 瞬时完成、不复制不额外占空间，更新成功删快照，失败改回来即完成回滚。
 */
interface OpenClawUpdateSnapshot {
  coreModules: string
  coreModulesBackup: string
  lockFile: string
  lockFileBackup: string
  managedRoot: string
  managedRootBackup: string
  hasCoreModules: boolean
  hasLockFile: boolean
  hasManagedRoot: boolean
}

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

/** 归一化版本号：允许用户输入 24.21.0，统一补成 v24.21.0 */
function normalizeNodeVersion(input: string): string {
  const t = input.trim()
  return /^\d+\.\d+\.\d+/.test(t) ? `v${t}` : t
}

/**
 * 判断版本是否满足 OpenClaw 2026.9.4 起的 Node 引擎要求：
 * >=24.16.0 <25 || >=26.1.0（25.x 不在受支持区间）。
 */
function satisfiesOpenClawNodeRange(version: string): boolean {
  const m = version.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const maj = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (maj === 24) return min >= 16
  if (maj === 25) return false
  if (maj === 26) return min >= 1
  return maj > 26
}

function getNodeDownloadUrl(useMirror: boolean, version: string = NODE_VERSION): string {
  const platform = process.platform
  const arch = process.arch
  const base = useMirror ? MIRRORS.nodeBase[0] : MIRRORS.nodeBase[1]

  if (platform === 'win32') {
    return `${base}/${version}/node-${version}-win-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`
  } else if (platform === 'darwin') {
    return `${base}/${version}/node-${version}-darwin-${arch}.tar.gz`
  } else {
    return `${base}/${version}/node-${version}-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.xz`
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
      } else if (info.nodeVersion && !satisfiesOpenClawNodeRange(info.nodeVersion)) {
        // 已装 Node 不满足新版 OpenClaw 引擎要求（如 v22）：先自动升级内置 Node，避免 preinstall 失败
        const upgraded = await this.updateNodeRuntime({ version: NODE_VERSION, useMirror })
        if (!upgraded.success) {
          throw new Error(upgraded.error || 'Node.js 运行时升级失败')
        }
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
   *
   * 兜底策略（对齐 OpenClaw v2026.9.1「升级失败自动回滚 npm 候选版本」）：
   * 1. 更新前把现有核心 node_modules、锁文件、受管插件目录整体改名快照
   *    （同卷 rename，不复制、不额外占空间）；
   * 2. 候选版本安装后做可用性冒烟（CLI --version、核心版本可读）；
   * 3. 安装或冒烟失败 → 自动改名回滚到原版本，回报 rolledBack=true；
   * 4. 本方法成功时保留快照；由 IPC 层执行 doctor 迁移：迁移失败调
   *    restoreOpenClawBackup() 回滚候选版本，迁移通过才调
   *    discardOpenClawBackup() 删除快照。
   * 用户配置 openclaw.json 与密钥引用不在安装目录内，更新全程不动。
   */
  async updateOpenClaw(options: { useMirror?: boolean } = {}): Promise<{
    success: boolean
    error?: string
    warning?: string
    /** 更新失败后是否已自动回滚到原可用版本 */
    rolledBack?: boolean
    previousVersion?: string
    currentVersion?: string
  }> {
    const { useMirror = true } = options
    this.abortController = new AbortController()
    this._writeDebugLog('--- 开始更新 OpenClaw ---')

    let before: EnvInfo
    try {
      before = await this.checkEnvironment()
    } catch (err: any) {
      this._progressError(err.message)
      return { success: false, error: err.message }
    }
    if (!before.nodeInstalled) {
      return { success: false, error: 'Node.js 运行时尚未安装，请先完成环境初始化' }
    }
    const previousVersion = before.openClawVersion

    let snapshot: OpenClawUpdateSnapshot | null = null
    try {
      this._progress('检查更新', '正在为当前可用版本创建回滚快照...', 8)
      snapshot = await this._snapshotOpenClawForUpdate()

      // 快照已把旧 node_modules 整体挪走，候选版本直接安装到原路径，
      // forceOnline 强制 npm 联网重新解析并拉取 latest（否则会沿用旧版本）。
      await this._installOpenClaw(useMirror, 0, true)

      // 候选版本冒烟：核心版本可读，且 CLI 能正常启动（防止装出残缺包）。
      const candidate = await this.checkEnvironment()
      if (!candidate.openClawInstalled || !candidate.openClawVersion) {
        throw new Error('候选版本安装不完整：未找到 OpenClaw 核心文件')
      }
      await this._smokeTestOpenClaw(candidate.openClawVersion)

      // 更新核心后同步刷新受管微信插件，保证渠道登录持续可用。
      const pluginReady = await this._installWeixinChannelPlugin(useMirror, true)
      await this._installBuiltinSkills()

      // 冒烟与插件装配均通过，候选版本可用；快照暂不删除——
      // IPC 层还要执行 doctor 迁移，迁移失败需据此回滚（见 restoreOpenClawBackup）。

      const currentVersion = candidate.openClawVersion
      const upToDate = previousVersion && currentVersion === previousVersion

      const warnings: string[] = []
      if (!pluginReady) {
        warnings.push('微信渠道插件刷新未完成，将在首次扫码登录时自动补装')
      }
      this._progress(
        '完成',
        upToDate
          ? `已是最新版本 v${currentVersion}`
          : `更新成功：v${previousVersion ?? '未知'} → v${currentVersion ?? '未知'}`,
        100,
        true
      )
      return {
        success: true,
        previousVersion,
        currentVersion,
        warning: warnings.length ? warnings.join('；') : undefined
      }
    } catch (err: any) {
      this._writeDebugLog(`[UpdateOpenClaw Error] 异常中断: ${err.message}`)
      const restore = await this._restoreOpenClawSnapshot(snapshot)
      if (restore.restored) {
        const rolledBackVersion = restore.version ?? previousVersion
        const msg =
          `更新失败：${err.message}。已自动回滚到原版本 v${rolledBackVersion ?? '未知'}，` +
          '当前环境可继续使用，可稍后重试更新'
        this._writeDebugLog(`[UpdateOpenClaw] 已自动回滚: ${msg}`)
        this._progressError(msg)
        return {
          success: false,
          error: msg,
          rolledBack: true,
          previousVersion,
          currentVersion: rolledBackVersion
        }
      }
      const error = restore.error
        ? `更新失败：${err.message}；且自动回滚失败：${restore.error}，请检查日志后重试`
        : err.message
      this._progressError(error)
      return { success: false, error, previousVersion }
    }
  }

  /**
   * 更新前快照：把核心 node_modules、package-lock.json 与受管插件根目录
   * 整体 rename 到 *.update-backup（同卷改名瞬时完成）。
   * 若上次更新异常中断残留了备份而 live 缺失，则直接复用该备份作为回滚点。
   */
  private async _snapshotOpenClawForUpdate(): Promise<OpenClawUpdateSnapshot> {
    const dataDir = this.configManager.getDataDir()
    const openClawDir = join(dataDir, 'openclaw')
    const coreModules = join(openClawDir, 'node_modules')
    const coreModulesBackup = join(openClawDir, 'node_modules.update-backup')
    const lockFile = join(openClawDir, 'package-lock.json')
    const lockFileBackup = join(openClawDir, 'package-lock.update-backup.json')
    const managedRoot = join(openClawPaths.configDir(dataDir), 'npm')
    const managedRootBackup = join(openClawPaths.configDir(dataDir), 'npm.update-backup')

    // 大目录改名走带重试的版本：Windows 杀软实时扫描可能造成瞬时 EPERM/EBUSY。
    const moveDirToBackup = async (live: string, backup: string): Promise<boolean> => {
      try {
        if (existsSync(live)) {
          if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
          await this._renameWithRetry(live, backup, 'snapshot')
          return true
        }
        // live 缺失但备份存在（上次更新崩溃残留）：保留备份作为回滚点
        return existsSync(backup)
      } catch (e: any) {
        this._writeDebugLog(`[UpdateSnapshot] 快照失败 ${live} -> ${backup}: ${e.message}`)
        return false
      }
    }

    const moveFileToBackup = (live: string, backup: string): boolean => {
      try {
        if (existsSync(live)) {
          if (existsSync(backup)) rmSync(backup, { force: true })
          renameSync(live, backup)
          return true
        }
        return existsSync(backup)
      } catch (e: any) {
        this._writeDebugLog(`[UpdateSnapshot] 快照失败 ${live} -> ${backup}: ${e.message}`)
        return false
      }
    }

    const snapshot: OpenClawUpdateSnapshot = {
      coreModules,
      coreModulesBackup,
      lockFile,
      lockFileBackup,
      managedRoot,
      managedRootBackup,
      hasCoreModules: await moveDirToBackup(coreModules, coreModulesBackup),
      hasLockFile: moveFileToBackup(lockFile, lockFileBackup),
      hasManagedRoot: await moveDirToBackup(managedRoot, managedRootBackup)
    }
    this._writeDebugLog(
      `[UpdateSnapshot] core=${snapshot.hasCoreModules}, lock=${snapshot.hasLockFile}, ` +
        `managed=${snapshot.hasManagedRoot}`
    )
    return snapshot
  }

  /**
   * 丢弃回滚快照。snapshot 为 null 时按固定备份路径自动发现
   * （供 IPC 层 doctor 迁移通过后调用）。快照残留不影响新版本运行。
   */
  private _discardOpenClawSnapshot(snapshot: OpenClawUpdateSnapshot | null): void {
    const dataDir = this.configManager.getDataDir()
    const openClawDir = join(dataDir, 'openclaw')
    const backups = [
      snapshot?.coreModulesBackup ?? join(openClawDir, 'node_modules.update-backup'),
      snapshot?.lockFileBackup ?? join(openClawDir, 'package-lock.update-backup.json'),
      snapshot?.managedRootBackup ??
        join(openClawPaths.configDir(dataDir), 'npm.update-backup')
    ]
    for (const backup of backups) {
      try {
        if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      } catch (e: any) {
        // 快照残留不影响新版本运行，下次更新会自动清理
        this._writeDebugLog(`[UpdateSnapshot] 清理快照失败 ${backup}: ${e.message}`)
      }
    }
  }

  /** IPC 层在更新后 doctor 迁移通过时调用：候选版本正式生效，删除回滚快照。 */
  discardOpenClawBackup(): { success: boolean; error?: string } {
    try {
      this._discardOpenClawSnapshot(null)
      return { success: true }
    } catch (e: any) {
      this._writeDebugLog(`[UpdateSnapshot] doctor 通过后清理快照失败: ${e.message}`)
      return { success: false, error: e.message }
    }
  }

  /**
   * 回滚：把 *.update-backup 快照改回原路径，丢弃残缺的候选版本。
   * 回滚前结束占用便携 Node 的进程，避免 Windows 文件锁导致改名失败。
   * snapshot 为 null 时按固定备份路径自动发现（供 IPC 层 doctor 失败后调用）。
   */
  private async _restoreOpenClawSnapshot(
    snapshot: OpenClawUpdateSnapshot | null
  ): Promise<{ restored: boolean; version?: string; error?: string }> {
    const dataDir = this.configManager.getDataDir()
    const openClawDir = join(dataDir, 'openclaw')
    const coreModules = snapshot?.coreModules ?? join(openClawDir, 'node_modules')
    const coreModulesBackup =
      snapshot?.coreModulesBackup ?? join(openClawDir, 'node_modules.update-backup')
    const lockFile = snapshot?.lockFile ?? join(openClawDir, 'package-lock.json')
    const lockFileBackup =
      snapshot?.lockFileBackup ?? join(openClawDir, 'package-lock.update-backup.json')
    const managedRoot =
      snapshot?.managedRoot ?? join(openClawPaths.configDir(dataDir), 'npm')
    const managedRootBackup =
      snapshot?.managedRootBackup ?? join(openClawPaths.configDir(dataDir), 'npm.update-backup')

    if (![coreModulesBackup, lockFileBackup, managedRootBackup].some(existsSync)) {
      return { restored: false, error: '未找到更新前的版本快照' }
    }

    this._progress('回滚', '更新未完成，正在恢复到原有可用版本...', 96)
    try {
      await this._stopRuntimeProcesses()

      const restoreOne = async (live: string, backup: string, label: string): Promise<void> => {
        if (!existsSync(backup)) return
        if (existsSync(live)) rmSync(live, { recursive: true, force: true })
        await this._renameWithRetry(backup, live, label)
      }
      await restoreOne(coreModules, coreModulesBackup, 'rollback-core')
      await restoreOne(lockFile, lockFileBackup, 'rollback-lock')
      await restoreOne(managedRoot, managedRootBackup, 'rollback-managed')

      const info = await this.checkEnvironment()
      if (!info.openClawVersion) {
        return { restored: false, error: '快照已恢复但 OpenClaw 核心版本仍无法读取' }
      }
      this._writeDebugLog(`[UpdateRollback] 回滚完成，版本 v${info.openClawVersion}`)
      return { restored: true, version: info.openClawVersion }
    } catch (e: any) {
      this._writeDebugLog(`[UpdateRollback] 回滚失败: ${e.message}`)
      return { restored: false, error: e.message }
    }
  }

  /** IPC 层在更新成功但 doctor 迁移失败时调用：回滚候选 npm 版本。 */
  async restoreOpenClawBackup(): Promise<{
    restored: boolean
    version?: string
    error?: string
  }> {
    return this._restoreOpenClawSnapshot(null)
  }

  /**
   * 候选版本冒烟：以便携 Node 执行 openclaw --version。
   * 仅能读到 package.json 不代表 dist 完整可运行，CLI 能启动才算候选可用，
   * 冒烟失败会抛出异常，由调用方触发自动回滚。
   */
  private async _smokeTestOpenClaw(version: string): Promise<void> {
    const dataDir = this.configManager.getDataDir()
    const nodePath = this.configManager.getNodePath()
    const clawJsPath = openClawPaths.clawJs(dataDir)
    const nodeBinDir = dirname(nodePath)
    this._progress('部署核心', `正在校验新版本 v${version} 可运行...`, 86)
    try {
      const { stdout } = await execFileAsync(nodePath, [clawJsPath, '--version'], {
        cwd: openClawPaths.installDir(dataDir),
        env: {
          ...process.env,
          PATH: `${nodeBinDir}${pathDelimiter}${process.env.PATH || ''}`,
          NODE_ENV: 'production'
        },
        timeout: 30000,
        maxBuffer: 1024 * 1024
      })
      this._writeDebugLog(`[UpdateSmokeTest] openclaw --version => ${stdout.trim()}`)
    } catch (e: any) {
      const reason = String(e?.message || e).split('\n')[0]
      throw new Error(`候选版本冒烟运行失败（openclaw --version）：${reason}`)
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

  /**
   * 查询可安装的 Node 版本：每个大版本仅取最新一个；LTS 优先，
   * 另补一个最新的非 LTS 当前版本；并标记是否满足 OpenClaw 引擎要求。
   */
  async getNodeVersions(options: { useMirror?: boolean } = {}): Promise<{
    success: boolean
    error?: string
    /** 推荐稳定版：满足 OpenClaw 要求的最新 LTS 版本号 */
    recommended?: string
    versions?: {
      version: string
      lts: string | false
      compatible: boolean
      recommended: boolean
    }[]
  }> {
    const useMirror = options.useMirror ?? true
    const bases = useMirror ? MIRRORS.nodeBase : [MIRRORS.nodeBase[1]]
    let lastErr = ''

    for (const base of bases) {
      try {
        const resp = await fetch(`${base}/index.json`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const list = (await resp.json()) as Array<{
          version: string
          lts?: string | false
        }>

        const newestLtsByMajor = new Map<number, { version: string; lts: string | false }>()
        let newestCurrent: { version: string; lts: string | false } | null = null

        for (const item of list) {
          if (!/^v\d+\.\d+\.\d+$/.test(item.version)) continue
          const major = parseInt(item.version.slice(1).split('.')[0], 10)
          if (major < 22) continue
          if (item.lts) {
            if (!newestLtsByMajor.has(major)) {
              newestLtsByMajor.set(major, { version: item.version, lts: item.lts })
            }
          } else if (
            !newestCurrent ||
            compareVersions(item.version, newestCurrent.version) > 0
          ) {
            newestCurrent = { version: item.version, lts: false }
          }
        }

        const picked = [...newestLtsByMajor.values()]
        if (
          newestCurrent &&
          !newestLtsByMajor.has(
            parseInt(newestCurrent.version.slice(1).split('.')[0], 10)
          )
        ) {
          picked.push(newestCurrent)
        }
        picked.sort((a, b) => compareVersions(b.version, a.version))

        const versions = picked.slice(0, 8).map((item) => ({
          version: item.version,
          lts: item.lts,
          compatible: satisfiesOpenClawNodeRange(item.version),
          recommended: false
        }))
        // 推荐稳定版：优先「满足 OpenClaw 要求的最新 LTS」，
        // 没有兼容 LTS 时才退而求其次选最新兼容版本。
        const recommended =
          versions.find((item) => item.lts && item.compatible) ||
          versions.find((item) => item.compatible)
        if (recommended) recommended.recommended = true

        return { success: true, recommended: recommended?.version, versions }
      } catch (e: any) {
        lastErr = e.message
        this._writeDebugLog(`[NodeVersions] ${base} 获取失败: ${lastErr}`)
      }
    }

    return { success: false, error: `获取 Node 版本列表失败：${lastErr}` }
  }

  /**
   * 将内置便携 Node 更新/切换到指定版本。
   * 流程：校验版本 → 结束占用便携 Node 的进程 → 下载（镜像→官方兜底）→
   * 解压到暂存目录并校验版本 → 备份旧目录后切换 → 失败自动回滚。
   * 调用方（IPC 层）需先停止 OpenClaw 网关，成功后按需重启。
   */
  async updateNodeRuntime(options: { version?: string; useMirror?: boolean } = {}): Promise<{
    success: boolean
    error?: string
    /** 非致命问题（如更新成功但网关重启失败），由 UI 附加展示 */
    warning?: string
    previousVersion?: string
    currentVersion?: string
  }> {
    const target = normalizeNodeVersion(options.version || NODE_VERSION)
    if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
      return { success: false, error: `版本号格式不正确：${options.version}（示例：v24.21.0）` }
    }
    const useMirror = options.useMirror ?? true
    this.abortController = new AbortController()
    this._writeDebugLog(`--- 开始更新 Node: ${target} ---`)

    const dataDir = this.configManager.getDataDir()
    const platform = process.platform
    const arch = process.arch
    const runtimeRoot = join(dataDir, 'runtime')
    const runtimeDir = join(runtimeRoot, `node-${platform}-${arch}`)
    const nodeExeRelPath = platform === 'win32' ? 'node.exe' : join('bin', 'node')
    const currentNodePath = join(runtimeDir, nodeExeRelPath)
    const stagingDir = join(runtimeRoot, `node-${platform}-${arch}.new`)
    const backupDir = join(runtimeRoot, `node-${platform}-${arch}.bak`)
    const archiveSuffix =
      platform === 'win32' ? '.zip' : platform === 'darwin' ? '.tar.gz' : '.tar.xz'
    const archiveName = `node-${target}-${platform}-${arch}${archiveSuffix}`
    const destFile = join(runtimeRoot, archiveName)

    try {
      let previousVersion: string | undefined
      if (existsSync(currentNodePath)) {
        const { stdout } = await execAsync(`"${currentNodePath}" --version`)
        previousVersion = stdout.trim()
        if (previousVersion === target) {
          this._progress('Node.js', `当前已是 Node ${target}，无需更新`, 100, true)
          return { success: true, previousVersion, currentVersion: target }
        }
      }

      this._progress('Node.js', '正在停止占用 Node 运行时的进程...', 5)
      await this._stopRuntimeProcesses()

      // 下载：国内镜像失败自动回落官方源
      const urls = useMirror
        ? [getNodeDownloadUrl(true, target), getNodeDownloadUrl(false, target)]
        : [getNodeDownloadUrl(false, target)]
      let downloaded = false
      let lastErr = ''
      for (const url of urls) {
        try {
          this._progress('Node.js', `正在下载 Node.js ${target}...`, 10)
          await this._downloadFile(url, destFile, (pct, speed) => {
            this._progress(
              'Node.js',
              `下载 Node.js ${target} ... ${speed}`,
              10 + Math.floor(pct * 50)
            )
          })
          downloaded = true
          break
        } catch (e: any) {
          lastErr = e.message
          this._writeDebugLog(`[UpdateNode] 下载失败 ${url}: ${lastErr}`)
        }
      }
      if (!downloaded) throw new Error(`Node ${target} 下载失败：${lastErr}`)

      this._progress('Node.js', '正在解压新版本运行时...', 65)
      // 清理上一次失败留下的暂存目录与 node-vX 解压残留
      for (const stale of [
        stagingDir,
        join(runtimeRoot, `node-${target}-${platform}-${arch}`)
      ]) {
        try {
          if (existsSync(stale)) rmSync(stale, { recursive: true, force: true })
        } catch (e: any) {
          this._writeDebugLog(`[UpdateNode] 清理残留 ${stale} 失败: ${e.message}`)
        }
      }
      this._writeDebugLog(`[UpdateNode] 解压前 runtime 目录内容: ${readdirSync(runtimeRoot).join(', ')}`)
      await this._extractNodeArchive(destFile, stagingDir, target)
      try { rmSync(destFile, { force: true }) } catch { /* 安装包清理失败可忽略 */ }

      const stagingNodePath = join(stagingDir, nodeExeRelPath)
      const { stdout: verifyOut } = await execAsync(`"${stagingNodePath}" --version`)
      if (verifyOut.trim() !== target) {
        throw new Error(`版本校验失败：期望 ${target}，实际 ${verifyOut.trim()}`)
      }
      this._writeDebugLog(`[UpdateNode] 暂存版本校验通过 ${verifyOut.trim()}`)

      // 切换：旧目录改名备份 → 暂存目录就位；任一步失败都尝试回滚。
      this._progress('Node.js', '正在切换运行时版本...', 85)
      await this._stopRuntimeProcesses()
      try {
        if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true })
      } catch (e: any) {
        this._writeDebugLog(`[UpdateNode] 清理历史备份失败: ${e.message}`)
      }

      const hadOldRuntime = existsSync(runtimeDir)
      let movedOld = false
      try {
        if (hadOldRuntime) {
          await this._renameWithRetry(runtimeDir, backupDir, 'old-to-bak')
          movedOld = true
        }
        await this._renameWithRetry(stagingDir, runtimeDir, 'staging-to-live')

        const { stdout: after } = await execAsync(`"${currentNodePath}" --version`)
        if (after.trim() !== target) throw new Error(`切换后版本异常：${after.trim()}`)
      } catch (e: any) {
        // 回滚：恢复旧目录，丢弃未完成的新目录
        try {
          if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true })
          if (movedOld && existsSync(backupDir)) {
            await this._renameWithRetry(backupDir, runtimeDir, 'rollback')
          }
        } catch (rollbackErr: any) {
          this._writeDebugLog(`[UpdateNode] 回滚失败: ${rollbackErr.message}`)
        }
        throw new Error(`运行时切换失败，已恢复旧版本：${e.message}`)
      }

      // 切换成功后清理旧版本（失败仅记录，.bak 不影响程序运行）
      try {
        if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true })
      } catch (e: any) {
        this._writeDebugLog(`[UpdateNode] 旧版本备份清理失败（不影响使用）: ${e.message}`)
      }

      this._writeDebugLog(`[UpdateNode Success] ${previousVersion ?? '未安装'} -> ${target}`)
      this._progress(
        'Node.js',
        `Node.js 更新成功：${previousVersion ?? '未安装'} → ${target}`,
        100,
        true
      )
      return { success: true, previousVersion, currentVersion: target }
    } catch (err: any) {
      this._writeDebugLog(`[UpdateNode Error] ${err.message}`)
      try {
        if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
      } catch { /* ignore */ }
      this._progressError(err.message)
      return { success: false, error: err.message }
    }
  }

  /**
   * 结束所有正在运行「便携 Node 目录内 node」的进程（OpenClaw 网关、
   * Obsidian 索引器等）。按可执行文件全路径精确匹配，避免误杀系统 Node。
   */
  private async _stopRuntimeProcesses(): Promise<void> {
    const nodePath = this.configManager.getNodePath()
    // 先逐个优雅停止注册表内的常驻子进程（marketing DB Worker 需要
    // wal_checkpoint(TRUNCATE) + close，硬杀会留下 -wal/-shm 残骸）。
    // 顺序：注册表 gracefulStop（上限 3s）→ 再按 ExecutablePath 精确 taskkill 兜底。
    try {
      const stops = await subprocessRegistry.stopAll(3000)
      for (const s of stops) {
        if (!s.ok) {
          this._writeDebugLog(`[UpdateNode] ${s.name}(pid=${s.pid}) 优雅停止未成功: ${s.error}`)
        } else {
          this._writeDebugLog(`[UpdateNode] ${s.name}(pid=${s.pid}) 已优雅停止`)
        }
      }
    } catch (e: any) {
      this._writeDebugLog(`[UpdateNode] 注册表优雅停止出错（可忽略）: ${e.message}`)
    }
    if (!existsSync(nodePath)) return
    try {
      if (process.platform === 'win32') {
        // PowerShell 单引号字符串中用 '' 转义单引号
        const escapedPath = nodePath.replace(/'/g, "''")
        const psScript =
          `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
          `Where-Object { $_.ExecutablePath -ieq '${escapedPath}' } | ` +
          `Select-Object -ExpandProperty ProcessId) -join ','`
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { windowsHide: true, maxBuffer: 1024 * 1024 }
        )
        const pids = stdout
          .trim()
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((n) => parseInt(n, 10))
          .filter((n) => n > 0)
        for (const pid of pids) {
          try {
            await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
              windowsHide: true
            })
          } catch { /* 进程可能已退出 */ }
        }
        if (pids.length) {
          this._writeDebugLog(`[UpdateNode] 已结束占用便携 Node 的进程 PID: ${pids.join(', ')}`)
        }
      } else {
        // macOS / Linux：按可执行文件完整路径匹配命令行
        try {
          await execAsync(`pkill -f "${nodePath.replace(/"/g, '\\"')}"`)
        } catch { /* 无匹配进程时 pkill 返回非零，忽略 */ }
      }
    } catch (e: any) {
      this._writeDebugLog(`[UpdateNode] 检查占用进程时出错（可忽略）: ${e.message}`)
    }
  }
  /**
   * 专用解压：把 Node 压缩包解压到 stagingDir 并校验 node 可执行文件存在。
   * 相比通用 _extractArchive：先解压到唯一临时目录，再带重试地 rename 到
   * stagingDir（Defender/安全软件扫描会瞬时锁定新解压的 node.exe，导致
   * EPERM/EBUSY，重试可绕过），全过程写调试日志，失败时附带目录清单。
   */
  private async _extractNodeArchive(
    archivePath: string,
    stagingDir: string,
    expectedVersion: string
  ): Promise<void> {
    const platform = process.platform
    const parent = dirname(stagingDir)
    const nodeRelPath = platform === 'win32' ? 'node.exe' : join('bin', 'node')
    const tmpExtract = join(parent, `.extract-${Date.now()}`)

    try {
      if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
      mkdirSync(tmpExtract, { recursive: true })

      if (platform === 'win32') {
        const { default: AdmZip } = await import('adm-zip')
        const zip = new AdmZip(archivePath)
        const entries = zip.getEntries()
        const nodeEntry = entries.find((e) =>
          e.entryName.replace(/\\/g, '/').endsWith(`/${nodeRelPath}`)
        )
        this._writeDebugLog(
          `[ExtractNode] zip 条目数 ${entries.length}，node 条目: ${nodeEntry?.entryName ?? '未找到'}`
        )
        if (!nodeEntry) {
          throw new Error('压缩包中未找到 node.exe 条目，下载可能已损坏或被安全软件拦截')
        }
        zip.extractAllTo(tmpExtract, true)
      } else {
        const flag = archivePath.endsWith('.xz') ? 'J' : 'z'
        await execAsync(`tar -x${flag}f "${archivePath}" -C "${tmpExtract}"`)
      }

      // 压缩包内通常有一层 node-vX-platform-arch 顶层目录；定位真正的内容根
      const tops = readdirSync(tmpExtract)
      this._writeDebugLog(`[ExtractNode] 临时解压目录顶层内容: ${tops.join(', ') || '(空)'}`)
      let contentRoot = tmpExtract
      if (tops.length === 1 && statSync(join(tmpExtract, tops[0])).isDirectory()) {
        contentRoot = join(tmpExtract, tops[0])
      }

      const contentNodePath = join(contentRoot, nodeRelPath)
      if (!existsSync(contentNodePath)) {
        // 兜底：深度 3 层内搜索 node 可执行文件，记录其真实位置
        const found = this._findFile(contentRoot, platform === 'win32' ? 'node.exe' : 'node', 3)
        this._writeDebugLog(`[ExtractNode] 预期路径无 node，深度搜索结果: ${found ?? '无'}`)
        throw new Error(
          `解压后未找到 ${nodeRelPath}（临时目录顶层: ${tops.join(', ') || '空'}），可能被安全软件拦截`
        )
      }

      // 带重试地移动到 stagingDir（安全软件扫描会造成瞬时占用）
      await this._renameWithRetry(contentRoot, stagingDir, 'staging')
      if (contentRoot !== tmpExtract) {
        try { rmSync(tmpExtract, { recursive: true, force: true }) } catch { /* ignore */ }
      }

      if (!existsSync(join(stagingDir, nodeRelPath))) {
        throw new Error(
          `移动到暂存目录后 ${nodeRelPath} 丢失，暂存目录内容: ${readdirSync(stagingDir).join(', ')}`
        )
      }
      this._writeDebugLog(`[ExtractNode] 解压校验通过: ${stagingDir} (${expectedVersion})`)
    } catch (e: any) {
      this._writeDebugLog(`[ExtractNode Error] ${e.message}`)
      throw e
    } finally {
      try { if (existsSync(tmpExtract)) rmSync(tmpExtract, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  /** 在 root 下最多 maxDepth 层内按文件名查找（不走软链），找到返回绝对路径。 */
  private _findFile(root: string, targetName: string, maxDepth: number): string | null {
    if (maxDepth < 0 || !existsSync(root)) return null
    for (const name of readdirSync(root)) {
      const full = join(root, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isFile() && name === targetName) return full
      if (st.isDirectory()) {
        const hit = this._findFile(full, targetName, maxDepth - 1)
        if (hit) return hit
      }
    }
    return null
  }

  /**
   * rename 带重试：Windows 上安全软件实时扫描新文件会导致 EPERM/EBUSY/EACCES，
   * 等待锁释放后重试；全部失败则降级为复制。每一步都写日志。
   */
  private async _renameWithRetry(src: string, dest: string, label: string): Promise<void> {
    const transient = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        renameSync(src, dest)
        this._writeDebugLog(`[Rename ${label}] 成功: ${src} -> ${dest}`)
        return
      } catch (e: any) {
        this._writeDebugLog(`[Rename ${label}] 第 ${attempt} 次失败 (${e.code || 'UNKNOWN'}): ${e.message}`)
        if (!transient.has(e.code) || attempt === 8) break
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
    // 降级：复制（同样可能遇到占用，给 3 轮）
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        copyDir(src, dest)
        this._writeDebugLog(`[Rename ${label}] rename 不可用，复制成功: ${src} -> ${dest}`)
        return
      } catch (e: any) {
        this._writeDebugLog(`[Rename ${label}] 复制第 ${attempt} 次失败: ${e.message}`)
        if (attempt === 3) throw e
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  }

  private async _downloadNode(useMirror: boolean, version: string = NODE_VERSION): Promise<void> {
    const dataDir = this.configManager.getDataDir()
    const platform = process.platform
    const arch = process.arch
    const runtimeDir = join(dataDir, 'runtime', `node-${platform}-${arch}`)

    mkdirSync(runtimeDir, { recursive: true })

    const url = getNodeDownloadUrl(useMirror, version)
    const fileName = url.split('/').pop()!
    const destFile = join(dataDir, 'runtime', fileName)

    this._writeDebugLog(`[DownloadNode] 开始下载 Node, URL: ${url}, Dest: ${destFile}`);

    this._progress('Node.js', `正在下载内置 Node.js ${version}...`, 5)

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
        "models": { "timeout": 900000 }
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
