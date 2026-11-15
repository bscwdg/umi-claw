// electron/main/claw/feishuChannelConfig.ts —— 飞书渠道配置补丁（纯函数：写 / 删 / 跳过）
//
// 为什么单独抽出来：这段决策原来埋在 configManager._syncOpenClawConfig 的 1300+ 行里，
// 只能用「读源码字符串」做验收，分支正确性没有行为级断言。抽成纯函数后可以逐分支测：
//   1) 插件没安装却写 channels.feishu → OpenClaw 以 unknown channel id 拒绝整份配置（网关起不来）；
//   2) app.json 没有飞书条目时旧逻辑会删掉向导写入的 channels.feishu（用户配置被静默抹掉）；
//   3) 群白名单（groupAllowFrom）在 UI 里不可配，重装后 allowlist 为空 = 所有群静默不回复。
//
// 决策表（ui = app.json 的 channels.feishu）：
//   ui 不存在                         → leave（不动 openclaw.json；仅当旧字段 allowGroups 需要迁移时写回）
//   ui.enabled !== true               → delete（用户显式关闭）
//   enabled 但缺 AppID/AppSecret      → skip(missing-credentials)（表单没填齐，不写半份配置）
//   enabled 但插件未安装              → skip(plugin-missing)（与 QQ 同口径，等插件装好后的下次同步再写）
//   其它                              → write（含 groupAllowFrom 归一化）

export type FeishuChannelPatch =
  | { action: 'leave' }
  | { action: 'delete' }
  | { action: 'skip'; reason: 'missing-credentials' | 'plugin-missing' }
  | { action: 'write'; channel: Record<string, unknown>; enablePlugin: boolean }

export interface BuildFeishuChannelPatchInput {
  /** app.json 里的 channels.feishu（UI 表单副本） */
  ui: Record<string, unknown> | undefined
  /** openclaw.json 里现有的 channels.feishu（网关真实配置） */
  existing: Record<string, unknown> | undefined
  /** 受管目录里 @openclaw/feishu 是否完整安装 */
  pluginInstalled: boolean
}
function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 群白名单归一化：UI 用逗号/空白分隔的字符串，openclaw.json 要字符串数组。
 * 显式传空数组表示「清空白名单」，不能回落到 existing（否则用户清不掉）。
 */
function normalizeGroupAllowFrom(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : String(value).split(/[,，\s]+/)
  const out: string[] = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * 旧版飞书插件的群白名单字段是 allowGroups，v2026.6.x 起改名 groupAllowFrom。
 * 残留 allowGroups 会被新版 schema（additionalProperties:false）当非法属性拒绝（exit 78），
 * 所以即使应用不管这份配置（ui 不存在），也要把旧字段迁移掉。
 */
function migrateLegacyGroupAllowFrom(existing: Record<string, unknown> | undefined): {
  channel: Record<string, unknown> | undefined
  migrated: boolean
} {
  if (!existing || !Array.isArray(existing.allowGroups)) {
    return { channel: existing, migrated: false }
  }
  const channel: Record<string, unknown> = { ...existing }
  if (channel.groupAllowFrom === undefined) {
    channel.groupAllowFrom = normalizeGroupAllowFrom(existing.allowGroups) ?? []
  }
  delete channel.allowGroups
  return { channel, migrated: true }
}

export function buildFeishuChannelPatch(
  input: BuildFeishuChannelPatchInput
): FeishuChannelPatch {
  const { ui, pluginInstalled } = input
  const { channel: existing, migrated } = migrateLegacyGroupAllowFrom(input.existing)

  // app.json 没有飞书条目：这份配置不归应用管（可能来自 channels login 向导），不能删。
  // 仅当旧字段需要迁移、且插件已安装时才写回：插件缺失时写 channels.feishu 会被
  // OpenClaw 以 unknown channel id 拒绝整份配置（原配置本来就带旧字段属于既有故障，
  // 应用不能在这个时机把它变成新的写盘失败）。
  if (!ui || typeof ui !== 'object') {
    if (migrated && existing && pluginInstalled) {
      return { action: 'write', channel: existing, enablePlugin: false }
    }
    return { action: 'leave' }
  }

  if (ui.enabled !== true) return { action: 'delete' }

  const appId = nonEmptyString(ui.appId)
  const appSecret = nonEmptyString(ui.appSecret)
  if (!appId || !appSecret) return { action: 'skip', reason: 'missing-credentials' }
  if (!pluginInstalled) return { action: 'skip', reason: 'plugin-missing' }

  const channel: Record<string, unknown> = {
    ...(existing || {}),
    appId,
    appSecret,
    dmPolicy: nonEmptyString(ui.dmPolicy) || 'pairing',
    groupPolicy: nonEmptyString(ui.groupPolicy) || 'allowlist',
    requireMention: ui.requireMention === undefined ? true : Boolean(ui.requireMention)
  }

  const encryptKey = nonEmptyString(ui.encryptKey)
  if (encryptKey) channel.encryptKey = encryptKey
  const verificationToken = nonEmptyString(ui.verificationToken)
  if (verificationToken) channel.verificationToken = verificationToken

  // 只有表单显式带了 groupAllowFrom 才覆盖，避免 UI 没这个字段时把已有白名单抹掉。
  if (Object.prototype.hasOwnProperty.call(ui, 'groupAllowFrom')) {
    channel.groupAllowFrom = normalizeGroupAllowFrom(ui.groupAllowFrom) ?? []
  }

  return { action: 'write', channel, enablePlugin: true }
}
