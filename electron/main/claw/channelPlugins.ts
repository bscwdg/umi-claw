// electron/main/claw/channelPlugins.ts —— 渠道插件注册表：包名 / 插件 id / 受管目录 + 磁盘判定
//
// 为什么单独抽出来：渠道插件的安装与判定以前散在三处——ChannelManager 的飞书/QQ 前缀表、
// downloadManager 的微信哈希目录、ChannelsPage 保存时的按渠道分支。新增一个渠道要改三处，
// 而且「受管目录存在但包不完整」会被误判成已安装（用户点了安装却什么都没发生）。
// 现在所有渠道共用这一张表和同一套判定：包名、OpenClaw 插件 id、受管项目前缀都在这里。
//
// 注意 openclaw 插件 id 既不等于 npm 包名，也不等于 UI 的渠道 key（如 qqbot →
// openclaw-qqbot、wecom → wecom-openclaw-plugin），调用 `plugins enable` 时必须用本表的 id。

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ChannelPluginKey, ChannelPluginPresence } from '../../../src/types/channels'

export interface ChannelPluginSpec {
  key: ChannelPluginKey
  /** 展示名（与渠道卡片文案保持一致） */
  label: string
  /** npm 包名，也是 `openclaw plugins install` 的 spec */
  packageName: string
  /** openclaw.json 里 plugins.entries 的插件 id */
  openclawPluginId: string
  /** 受管项目目录名前缀：<prefix>-<hash>，hash 由 openclaw 的 safePathSegmentHashed 生成 */
  projectPrefix: string
}

/**
 * 唯一真源：只列 OpenClaw 2026.11.x 真实支持的渠道插件。
 * 钉钉 / 微信公众号在 OpenClaw 里没有渠道插件（docs/channels 与 dist/extensions 均无），
 * 所以不在这张表里，UI 也不能给它们画「安装」按钮。
 */
export const CHANNEL_PLUGINS: Record<ChannelPluginKey, ChannelPluginSpec> = {
  weixin: {
    key: 'weixin',
    label: '微信',
    packageName: '@tencent-weixin/openclaw-weixin',
    openclawPluginId: 'openclaw-weixin',
    projectPrefix: 'tencent-weixin-openclaw-weixin'
  },
  qqbot: {
    key: 'qqbot',
    label: 'QQ 机器人',
    packageName: '@tencent-connect/openclaw-qqbot',
    openclawPluginId: 'openclaw-qqbot',
    projectPrefix: 'tencent-connect-openclaw-qqbot'
  },
  feishu: {
    key: 'feishu',
    label: '飞书',
    packageName: '@openclaw/feishu',
    openclawPluginId: 'feishu',
    projectPrefix: 'openclaw-feishu'
  },
  wecom: {
    key: 'wecom',
    label: '企业微信',
    packageName: '@wecom/wecom-openclaw-plugin',
    openclawPluginId: 'wecom-openclaw-plugin',
    projectPrefix: 'wecom-wecom-openclaw-plugin'
  },
  slack: {
    key: 'slack',
    label: 'Slack',
    packageName: '@openclaw/slack',
    openclawPluginId: 'slack',
    projectPrefix: 'openclaw-slack'
  }
}

/** 展示顺序：与渠道页/Setup 的排列一致 */
export const CHANNEL_PLUGIN_KEYS: ChannelPluginKey[] = ['weixin', 'qqbot', 'feishu', 'wecom', 'slack']

export function isChannelPluginKey(value: unknown): value is ChannelPluginKey {
  return typeof value === 'string' && (CHANNEL_PLUGIN_KEYS as string[]).includes(value)
}

/** 按 npm 包名反查 spec（安装命令失败回查受管目录时用） */
export function channelPluginByPackage(packageName: string): ChannelPluginSpec | undefined {
  return CHANNEL_PLUGIN_KEYS.map((key) => CHANNEL_PLUGINS[key]).find(
    (spec) => spec.packageName === packageName
  )
}

/** <dataDir>/config/.openclaw/npm/projects —— OpenClaw 受管插件项目根目录 */
export function managedProjectsDir(openClawConfigDir: string): string {
  return join(openClawConfigDir, 'npm', 'projects')
}

/**
 * 受管项目目录名是否属于该渠道插件。
 *
 * 目录名 = safePathSegmentHashed(包名) = `<prefix>-<10 位 hex>`；
 * 生成型项目还可能带 `__openclaw-generation__g-` 标记。
 * 不能只 startsWith：`openclaw-slack-huddles-<hash>` 也会匹配 `openclaw-slack` 前缀，
 * 一旦该项目的依赖里恰好有目标包，就会被误判为「已安装」。
 */
function matchesManagedProjectName(name: string, prefix: string): boolean {
  if (name === prefix) return true
  if (!name.startsWith(`${prefix}-`)) return false
  const suffix = name.slice(prefix.length + 1)
  return /^[0-9a-f]{10}$/i.test(suffix) || suffix.includes('__openclaw-generation__')
}

/** 列出属于该渠道插件的受管项目目录（绝对路径）；目录读失败返回空数组 */
export function listManagedProjectDirs(
  openClawConfigDir: string,
  key: ChannelPluginKey
): string[] {
  const projectsDir = managedProjectsDir(openClawConfigDir)
  if (!existsSync(projectsDir)) return []
  try {
    return readdirSync(projectsDir)
      .filter((name) => matchesManagedProjectName(name, CHANNEL_PLUGINS[key].projectPrefix))
      .map((name) => join(projectsDir, name))
  } catch {
    return []
  }
}

/**
 * 是否存在「上次安装留下、但不能用」的受管项目（空目录 / 半拷贝 / 包名不符）。
 *
 * 为什么需要它：OpenClaw 的 `plugins install` 遇到已存在的目标 package 目录会直接报
 * `plugin already exists ... (delete it first)`，只有加 `--force` 才覆盖。所以
 * ensurePlugin 在这种状态下必须强制重装，否则「点安装」永远失败（历史坑）。
 */
export function hasStaleManagedProject(
  openClawConfigDir: string,
  key: ChannelPluginKey
): boolean {
  if (listManagedProjectDirs(openClawConfigDir, key).length === 0) return false
  return !isChannelPluginInstalled(openClawConfigDir, key)
}

/**
 * 组装 `plugins install` 的 argv（纯函数，便于断言 --force 真的传给了 CLI）。
 * @param clawJsPath openclaw 入口 index.js
 */
export function buildPluginInstallArgs(
  clawJsPath: string,
  packageName: string,
  options: { force?: boolean } = {}
): string[] {
  const args = [clawJsPath, 'plugins', 'install', packageName]
  if (options.force) args.push('--force')
  return args
}

/**
 * 单个受管项目里插件包是否真的存在。
 * 只看目录名会把「安装回滚后残留的空目录」误判成已安装（历史 bug），
 * 因此必须要求 package.json 可解析且 name 与目标包一致。
 */
function readManagedPackage(
  openClawConfigDir: string,
  spec: ChannelPluginSpec
): { installed: boolean; version?: string } {
  for (const projectDir of listManagedProjectDirs(openClawConfigDir, spec.key)) {
    const pkgPath = join(projectDir, 'node_modules', ...spec.packageName.split('/'), 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown; version?: unknown }
      if (parsed && parsed.name === spec.packageName) {
        return {
          installed: true,
          version: typeof parsed.version === 'string' ? parsed.version : undefined
        }
      }
    } catch {
      // 残缺/半拷贝的包按未安装处理，交给 ensurePlugin 强制重装
    }
  }
  return { installed: false }
}

export function isChannelPluginInstalled(
  openClawConfigDir: string,
  key: ChannelPluginKey
): boolean {
  return readManagedPackage(openClawConfigDir, CHANNEL_PLUGINS[key]).installed
}

/** 全部渠道插件的安装态快照（渠道页/Setup 一次取完，避免逐渠道 IPC） */
export function getChannelPluginPresence(openClawConfigDir: string): ChannelPluginPresence[] {
  return CHANNEL_PLUGIN_KEYS.map((key) => {
    const spec = CHANNEL_PLUGINS[key]
    const found = readManagedPackage(openClawConfigDir, spec)
    return {
      key,
      label: spec.label,
      installed: found.installed,
      ...(found.version ? { version: found.version } : {})
    }
  })
}
