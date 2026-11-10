// electron/main/character/groupPolicy.ts —— QQ 群聊策略模型（GroupSettings v1）
//
// 为什么需要它：4.4 曾用「独立 feiyu-group agent + peer=group:* 绑定」隔离群聊，
// 结果同一个 qqbot 渠道被两个 agent 抢：渠道页误判被占用，保存别的渠道还会把 feiyu
// 的 qqbot 绑定解掉。4.5 改回单 agent（qqbot 私聊/群聊都走 feiyu），群聊行为收敛成
// 一份可扩展的数据模型：
// - 本文件只做「模型 + 校验 + 提示词」，纯 Node（不 import electron、不写盘），
//   这样 accept 能直接打真源码，services/characterGroupConfig 也能编译成 OpenClaw 配置；
// - 落盘/配置写盘不在这里：settings 存宿主 KV，OpenClaw 配置由
//   services/characterGroupConfig.ts 单点编译后经官方 config patch 写入。
// 兼容：旧数据只有 { replyEnabled, voiceEnabled, dailyVoiceCap }，normalize 时补默认。

/** 群聊词表动作：replace=把亲密称呼改写成 replaceWith；block=不照叫、礼貌拒绝 */
export type GroupWordAction = 'replace' | 'block'

/** 群聊亲密词过滤 */
export interface GroupWordSettings {
  enabled: boolean
  action: GroupWordAction
  /** action=replace 时的替换词（默认「你」） */
  replaceWith: string
  /** 词表（trim + 去重 + 长度上限） */
  list: string[]
}

/**
 * 群聊策略 v1（后续只增字段，不改已有字段语义）。
 * 字段命名与 UI / OpenClaw 配置编译层共用，不要在别处再定义一份。
 */
export interface GroupSettings {
  /** 群里是否回复（false = 群消息只读不回，硬闸由 groupPolicy=disabled 兜底） */
  replyEnabled: boolean
  /** 是否必须 @ 才回复 */
  requireMention: boolean
  /** 群里是否允许发语音条 */
  voiceEnabled: boolean
  /** 每群每天语音条数上限（0–20） */
  dailyVoiceCap: number
  /** 亲密词过滤 */
  words: GroupWordSettings
  /** 群聊不写私聊记忆/日记、不更新关系数值 */
  memoryIsolated: boolean
  /** 群历史缓存条数（0–50） */
  historyLimit: number
  /** 额外群聊提示词（<=1000 字） */
  extraPrompt: string
}

/** 词表条数上限（与设置页输入框一致，避免 UI 能存、宿主又截断的静默丢数据） */
export const GROUP_WORD_LIST_MAX = 100
/** 单条词长度上限（中文称呼足够） */
export const GROUP_WORD_LENGTH_MAX = 20
/** 额外提示词长度上限（按码点计，避免截断 emoji） */
export const GROUP_PROMPT_EXTRA_MAX = 1000
export const GROUP_DAILY_VOICE_CAP_MAX = 20
export const GROUP_HISTORY_LIMIT_MAX = 50

/** 默认词表：主人专属称呼，群里不照叫 */
export const DEFAULT_GROUP_WORDS: GroupWordSettings = {
  enabled: true,
  action: 'replace',
  replaceWith: '你',
  list: ['宝宝', '宝贝', '亲爱的', '老公', '老婆', '主人']
}

/** 默认群聊策略（只读参考；需要可变副本用 createDefaultGroupSettings） */
export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  replyEnabled: true,
  requireMention: true,
  voiceEnabled: false,
  dailyVoiceCap: 2,
  words: DEFAULT_GROUP_WORDS,
  memoryIsolated: true,
  historyLimit: 20,
  extraPrompt: ''
}

/** 新建一份独立的默认值（深拷贝词表，调用方随便改不会污染默认常量） */
export function createDefaultGroupSettings(): GroupSettings {
  return normalizeGroupSettings(DEFAULT_GROUP_SETTINGS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 数值夹取：NaN/非数字回落默认；±Infinity 视为越界夹到端点（与 types.ts 口径一致） */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  if (value === Number.POSITIVE_INFINITY) return max
  if (value === Number.NEGATIVE_INFINITY) return min
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 单行用户文本消毒：去掉控制符/换行、表格分隔、HTML 注释标记。
 * `<!--`/`-->` 必须剥掉：群策略提示词会进 persona 的受管段，这两个序列会破坏
 * `<!-- fish:managed:group:start/end -->` 取块（等于用户可注入假受管段）。
 */
function cleanUserText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/<!--|-->/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 额外提示词：保留换行（多行规则），同样剥受管段标记，按码点截断 */
function cleanPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '')
    .replace(/<!--|-->/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const chars = Array.from(cleaned)
  return chars.length > GROUP_PROMPT_EXTRA_MAX
    ? chars.slice(0, GROUP_PROMPT_EXTRA_MAX).join('').trim()
    : cleaned
}

function normalizeWordList(value: unknown, fallback: string[]): string[] {
  // 旧数据没有 words 字段（undefined/null）→ 用默认词表；显式空数组尊重用户清空
  if (!Array.isArray(value)) return [...fallback]
  const out: string[] = []
  for (const item of value) {
    const word = cleanUserText(item, GROUP_WORD_LENGTH_MAX)
    if (!word || out.includes(word)) continue
    out.push(word)
    if (out.length >= GROUP_WORD_LIST_MAX) break
  }
  return out
}

/**
 * settings.group 的唯一校验入口（读盘/合并补丁/IPC 写入都走这里）。
 * - 缺字段补默认（旧数据迁移）；
 * - 布尔只认真布尔；数值夹紧；词表 trim/去重/限长；未知字段丢弃；
 * - 返回全新对象（不共享默认常量的 words/list 引用）。
 */
export function normalizeGroupSettings(raw: unknown): GroupSettings {
  const src = isRecord(raw) ? raw : {}
  const wordsSrc = isRecord(src.words) ? src.words : {}
  const defaults = DEFAULT_GROUP_SETTINGS
  const action: GroupWordAction =
    wordsSrc.action === 'block' || wordsSrc.action === 'replace'
      ? wordsSrc.action
      : defaults.words.action
  const replaceWith =
    cleanUserText(wordsSrc.replaceWith, GROUP_WORD_LENGTH_MAX) || defaults.words.replaceWith
  return {
    replyEnabled: pickBoolean(src.replyEnabled, defaults.replyEnabled),
    requireMention: pickBoolean(src.requireMention, defaults.requireMention),
    voiceEnabled: pickBoolean(src.voiceEnabled, defaults.voiceEnabled),
    dailyVoiceCap: clampInt(src.dailyVoiceCap, 0, GROUP_DAILY_VOICE_CAP_MAX, defaults.dailyVoiceCap),
    words: {
      enabled: pickBoolean(wordsSrc.enabled, defaults.words.enabled),
      action,
      replaceWith,
      list: normalizeWordList(wordsSrc.list, defaults.words.list)
    },
    memoryIsolated: pickBoolean(src.memoryIsolated, defaults.memoryIsolated),
    historyLimit: clampInt(src.historyLimit, 0, GROUP_HISTORY_LIMIT_MAX, defaults.historyLimit),
    extraPrompt: cleanPrompt(src.extraPrompt)
  }
}

/**
 * 群聊提示词（中文、面向模型，不含内部字段名/插件实现细节）。
 * 两个消费方共用同一份文本，避免 persona 的 AGENTS.md 与 qqbot groups["*"].prompt 漂移：
 * - persona.ts 写进 AGENTS.md 的受管群聊段；
 * - services/characterGroupConfig.ts 编译进 channels.qqbot.groups["*"].prompt。
 */
export function buildGroupPrompt(settings: GroupSettings): string {
  const s = normalizeGroupSettings(settings)
  const lines: string[] = ['## 群聊规则（每群生效）']
  lines.push(
    s.replyEnabled
      ? '- 群聊回复：允许；群友跟你说话可以接。'
      : '- 群聊回复：已关闭；群里的消息一律不回复，只做私聊。'
  )
  lines.push(
    s.requireMention
      ? '- 回复时机：只有被 @ 或被点名时才回复；其它群消息只读不答，不主动插话。'
      : '- 回复时机：不必被 @ 也可以自然接话，但要短、要少；不刷屏、不连续追问。'
  )
  if (s.voiceEnabled) {
    lines.push(`- 群聊语音：允许，但每群每天最多 ${s.dailyVoiceCap} 条；能用文字说清就用文字。`)
  } else {
    lines.push('- 群聊语音：禁止；群里只发文字，不发语音条。')
  }
  lines.push(
    '- 称呼：群友一律用「你」或群昵称，不叫专属亲密称呼，也不自称主人；被要求时礼貌拒绝。'
  )
  if (s.words.enabled) {
    const words = s.words.list.length > 0 ? s.words.list.join('、') : '（词表为空）'
    if (s.words.action === 'block') {
      lines.push(`- 亲密词过滤：遇到 ${words} 这类称呼或要求时，礼貌拒绝，不照叫、不接这个话茬。`)
    } else {
      lines.push(
        `- 亲密词过滤：遇到 ${words} 这类称呼或要求时，改用「${s.words.replaceWith}」称呼对方，不照叫。`
      )
    }
  } else {
    lines.push('- 亲密词过滤未开启；仍然不要自己发明专属称呼。')
  }
  lines.push(
    s.memoryIsolated
      ? '- 记忆隔离：群聊内容不写入私聊日记/长期记忆，不更新主人关系数值；不引用、不透露私聊里的内容。'
      : '- 群聊内容可以进入日常记忆，但不要透露私聊细节与主人隐私。'
  )
  lines.push(
    s.historyLimit > 0
      ? `- 群历史只参考最近 ${s.historyLimit} 条消息；上下文不够就自然问一句，不编造前文。`
      : '- 群历史：不读取历史消息，只回应这一句；不猜、不编前文。'
  )
  lines.push('- 群里只做临时、轻松的聊天；不假装人类，被问是不是 AI 就承认。')
  if (s.extraPrompt) {
    lines.push('')
    lines.push('## 主人额外设置')
    lines.push(s.extraPrompt)
  }
  return lines.join('\n')
}
