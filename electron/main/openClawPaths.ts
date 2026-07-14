import { join } from 'path'

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

  /** 便携式技能目录（config/.openclaw/skills/） */
  portableSkillsDir: (dataDir: string) =>
    join(dataDir, 'config', '.openclaw', 'skills'),

  /** OpenClaw 数据目录（data/） */
  openClawData: (dataDir: string) => join(dataDir, 'data')
}

/** 把 Windows 反斜杠统一成正斜杠，兼容 OpenClaw / Node 内部处理 */
export const toPosix = (p: string) => p.replace(/\\/g, '/')
