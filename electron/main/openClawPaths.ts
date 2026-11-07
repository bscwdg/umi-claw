import { join, dirname } from 'path'

/**
 * OpenClaw 网关鉴权 token。
 * 之前散落在 clawManager/configManager/downloadManager 三处硬编码，
 * 现统一到此处，避免出现不一致。
 */
export const GATEWAY_TOKEN = 'https://github.com/bscwdg/umi-claw'

/**
 * 统一的 OpenClaw 目录/文件路径解析。
 * 所有主进程模块都应通过这里派生路径，避免多处重复拼接
 * 'openclaw/node_modules/openclaw/dist/index.js' 之类的长字符串。
 */
export const openClawPaths = {
  /** OpenClaw 运行时安装目录（即 spawn 时的 cwd） */
  installDir: (dataDir: string) => join(dataDir, 'openclaw'),

  /** OpenClaw 核心库入口 index.js */
  clawJs: (dataDir: string) =>
    join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js'),

  /** 随包安装的绿色 Node 可执行文件（config patch / doctor 等子进程统一走它） */
  nodeBinary: (dataDir: string) => {
    const nodeDir = join(dataDir, 'runtime', 'node-' + process.platform + '-' + process.arch)
    return process.platform === 'win32'
      ? join(nodeDir, 'node.exe')
      : join(nodeDir, 'bin', 'node')
  },

  /** 内置技能所在目录 */
  builtinSkillsDir: (dataDir: string) =>
    join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'skills'),

  /** 便携式 HOME 目录（config/） */
  portableHome: (dataDir: string) => join(dataDir, 'config'),

  /** OpenClaw 配置目录（config/.openclaw/） */
  configDir: (dataDir: string) => join(dataDir, 'config', '.openclaw'),

  /** openclaw.json 完整路径 */
  openClawConfig: (dataDir: string) =>
    join(dataDir, 'config', '.openclaw', 'openclaw.json'),

  /**
   * 插件在 OpenClaw 状态目录下的私有数据目录（config/.openclaw/<pluginId>/）。
   * 插件用 `resolveStateDir()/openclaw-weixin` 这类路径存登录态，而 resolveStateDir()
   * 取 HOME/.openclaw —— 网关的 HOME 被设为 config/，因此落点就在这里。
   */
  pluginStateDir: (dataDir: string, pluginId: string) =>
    join(dataDir, 'config', '.openclaw', pluginId),

  /** 便携式技能目录（config/.openclaw/skills/） */
  portableSkillsDir: (dataDir: string) =>
    join(dataDir, 'config', '.openclaw', 'skills'),

  /** 技能版本 manifest（config/.openclaw/skill-manifest.json），云端同步/更新时记录已装版本 */
  skillManifest: (dataDir: string) =>
    join(dataDir, 'config', '.openclaw', 'skill-manifest.json'),

  /** OpenClaw 数据目录（data/） */
  openClawData: (dataDir: string) => join(dataDir, 'data'),

  /** Obsidian 集成数据目录（向量库 + 状态文件） */
  obsidianDir: (dataDir: string) => join(dataDir, 'config', '.openclaw', 'obsidian'),

  /** Obsidian 向量库文件 */
  obsidianDb: (dataDir: string) => join(dataDir, 'config', '.openclaw', 'obsidian', 'index.db')
}

/** 把 Windows 反斜杠统一成正斜杠，兼容 OpenClaw / Node 内部处理 */
export const toPosix = (p: string) => p.replace(/\\/g, '/')

/**
 * 构建 OpenClaw 子进程共享的基础环境变量。
 *
 * 收敛此前散落在 index.ts / clawManager.ts / channelManager.ts 三处的重复拼装，
 * 统一 HOME/USERPROFILE/OPENCLAW_CONFIG_DIR/OPENCLAW_DATA_DIR、PATH 隔离（绿色 Node 顶到最前）
 * 以及 NODE_ENV。调用方可在此基础上 spread 自己的特有变量（如 PORT、GATEWAY_MODE 等）。
 *
 * npm_config_cache 也在这里统一落到 `<dataDir>/config/.npm-cache`：OpenClaw 子进程
 * 在插件缺失时会自己拉起 npm，不能让它写宿主机用户级缓存（可能只读，实测 EPERM）。
 *
 * @param dataDir  数据目录（configManager.getDataDir()）
 * @param nodePath 绿色 node 可执行文件绝对路径（用于把其 bin 目录顶到 PATH 最前）
 * @param extra    额外覆盖的环境变量
 */
export function buildOpenClawEnv(
  dataDir: string,
  nodePath: string,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const configDir = toPosix(openClawPaths.configDir(dataDir))
  const portableHome = toPosix(openClawPaths.portableHome(dataDir))
  const openClawData = toPosix(openClawPaths.openClawData(dataDir))

  const nodeBinDir = dirname(nodePath)
  const pathDelimiter = process.platform === 'win32' ? ';' : ':'
  const isolatedPath = `${nodeBinDir}${pathDelimiter}${process.env.PATH || ''}`

  // npm 子进程统一用便携目录里的缓存（与 downloadManager.buildNpmRuntimeEnv 同口径）。
  // 从低权限/沙箱/管理员环境继承来的用户级 %LOCALAPPDATA%\npm-cache 可能不可写：
  // OpenClaw 在插件缺失时会自己拉起 npm（`channels login` 的兜底安装、`plugins install`），
  // 写用户级 cache 直接 EPERM → npm view 超时 → 渠道插件装不上（实测见 runtime-debug.log）。
  // Windows 环境变量不区分大小写，必须清掉旧 cache 的所有大小写变体，否则 npm 可能
  // 优先采用继承来的 NPM_CONFIG_CACHE。
  const baseEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'npm_config_cache') continue
    if (value !== undefined) baseEnv[key] = value
  }

  return {
    ...baseEnv,
    PATH: isolatedPath,
    HOME: portableHome,
    USERPROFILE: portableHome,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_DATA_DIR: openClawData,
    npm_config_cache: toPosix(join(dataDir, 'config', '.npm-cache')),
    NODE_ENV: 'production',
    ...extra
  }
}
