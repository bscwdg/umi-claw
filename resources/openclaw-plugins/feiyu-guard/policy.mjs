// resources/openclaw-plugins/feiyu-guard/policy.mjs —— feiyu-guard 的纯策略函数（零依赖）
//
// 为什么单独一层：accept 测试要直接 import 纯函数（不拖 Gateway / fs），hook 注册层
// （guard.mjs）与判定规则解耦后，同一条规则能在 message_sending 与 before_tool_call 复用，
// 也方便对「配置解析 / 群判定 / 词过滤 / 语音计数 / 跨天」逐条给负向断言。
//
// 语义权威是宿主 electron/main/character/groupPolicy.ts（GroupSettings v1）与
// services/characterGroupConfig.ts（buildGuardConfig）。本文件的默认值必须与之一致；
// 两边漂移会被 test/guard-plugin.accept.mjs 的 G0/P1 断言直接打红。
//
// 约定：
// - 全部导出是纯函数/冻结常量，不读环境变量、不碰文件系统、不抛异常；
// - 只认配置版本 1；未知版本由 guard.mjs 判为「不执行任何策略」（fail-open）。

/** 唯一支持的配置版本（与宿主 buildGuardConfig 的 version 对齐） */
export const GUARD_CONFIG_VERSION = 1

/** 默认亲密词表（与 groupPolicy.ts DEFAULT_GROUP_WORDS 一致） */
export const DEFAULT_WORD_LIST = Object.freeze([
  '宝宝',
  '宝贝',
  '亲爱的',
  '老公',
  '老婆',
  '主人'
])

/** 词表/词长/语音上限/历史条数上限（与 groupPolicy.ts 的常量一致） */
export const GROUP_WORD_LIST_MAX = 100
export const GROUP_WORD_LENGTH_MAX = 20
export const GROUP_DAILY_VOICE_CAP_MAX = 20
export const GROUP_HISTORY_LIMIT_MAX = 50

/** QQ 群出站目标：qqbot:group:<groupId>（qqbot 插件的 target.ts 口径） */
export const QQBOT_GROUP_TO_RE = /^qqbot:group:/i

/** 群语音上传：POST /v2/groups/<groupId>/files（file_type=3 即 VOICE，见 qqbot 插件 MediaFileType） */
export const GROUP_VOICE_UPLOAD_PATH_RE = /^\/v2\/groups\/([^/]+)\/files\/?$/

/** 拒绝/取消原因码：稳定标识，宿主与测试都按它匹配（不改文案） */
export const GUARD_REASONS = Object.freeze({
  REPLY_DISABLED: 'group-reply-disabled',
  WORD_BLOCKED: 'group-word-blocked',
  VOICE_DISABLED: 'group-voice-disabled',
  VOICE_DAILY_CAP: 'group-voice-daily-cap',
  MEMORY_ISOLATED: 'group-memory-isolated',
  WILD_VOICE_PATH_BLOCKED: 'wild-voice-path-blocked'
})

/** 群记忆隔离要拦的写入类工具（OpenClaw 标准 tool id；不含 exec/其他写路径） */
export const GROUP_MEMORY_TOOLS = Object.freeze(['write', 'edit', 'apply_patch'])

/** before_tool_call 的 matcher：语音上传网关 + 三个写入类工具 + exec（野链路阻断） */
export const GUARD_TOOL_MATCHERS = Object.freeze([
  'qqbot_platform_api',
  'write',
  'edit',
  'apply_patch',
  'exec'
])

/**
 * 本插件只服务 feiyu agent：野链路规则按会话键 `agent:feiyu...` 门控，
 * main 等其它 agent 的 exec 不受影响（最小爆炸半径，也满足非目标会话 fail-open）。
 */
export function isFeiyuAgentSession(sessionKey) {
  return typeof sessionKey === 'string' && /^agent:feiyu(?=:|$)/i.test(sessionKey)
}

/**
 * 子串特征（名字足够特殊，碰撞概率极低）：
 * - edge-tts / edge_tts：被禁的 edge TTS 包名、模块名与 CLI（pip 安装 / python -m /
 *   npx / 内联 import 都靠它识别）；
 * - qqbot-voice-send / qqbot-voice-make-silk：绕过渠道投递的手工 QQ 语音脚本；
 * - probe-upload：工作区里直传 QQ 富媒体（file_type=3）的探测/投递脚本，与
 *   qqbot-voice-send 是零改名等效投递路径，必须同口径拦（它在 data/ 运行时目录，不进 git）。
 * 注意这是「特征摩擦层」而非绝对阻断：变量拼接/编码/改名等混淆仍可绕过，
 * 真正减面靠归档工作区野工具（见 PROGRESS 已知边界）。
 * 连带取舍（已知并接受）：feiyu 会话内即便只是排查/整改，命令里出现这些串也会被拦，
 * 例如 `rg edge-tts`、`pip show edge_tts`、`pip uninstall edge-tts`——通道合规优先于
 * 会话内排查便利，宿主侧人工排障不受影响（那是 main/人工进程，不是 agent:feiyu 会话）。
 */
export const WILD_VOICE_SUBSTRING_MARKERS = Object.freeze([
  'edge-tts',
  'edge_tts',
  'qqbot-voice-send',
  'qqbot-voice-make-silk',
  'probe-upload'
])

/**
 * 端点级特征（2026-11-13 实测绕过补面）：野脚本改名 probe2.cjs/probe3.cjs 后，
 * 上面的名字 marker 全部失效，但手搓 QQ OpenAPI 的命令里必然出现平台域名或
 * 取 app access token 的端点。feiyu 会话的合规语音只走网关 tts 工具，
 * exec 直连 QQ OpenAPI 没有合法用途，命中即拦。
 * 域名清单：sgroup 正式/沙箱（sandbox. 是前者子串自动覆盖）、bots.qq.com 凭证端点、
 * api.bot.qq.com（现 wiki 的新主机族，与 sgroup 等价的 OpenAPI 基座）。
 * 连带取舍与名字 marker 一致：feiyu 会话内排查/文档命令只要含这些串也会 block，
 * 宿主人工排障走 main 会话，不受影响。
 */
export const WILD_VOICE_ENDPOINT_MARKERS = Object.freeze([
  'api.sgroup.qq.com',
  'bots.qq.com/app/getappaccesstoken',
  'api.bot.qq.com'
])

/**
 * 媒体 files 路径特征：host 被变量拆走时的补面（/v2/users|groups/<id>/files）。
 * 只在 exec 命令文本里匹配；qqbot_platform_api 工具的正规调用不经本函数，
 * 群语音日上限等群策略由 guard.mjs 的另一条分支负责，互不影响。
 */
const WILD_VOICE_FILES_PATH_RE = /\/v2\/(?:users|groups)\/[^/\s"'`]+\/files\/?/i

/**
 * say.py 边界特征：工作区 edge-tts 本地合成脚本的固定入口。
 * 要求 say.py 前是行首/路径分隔符/引号/空白/反引号，避免误伤 essay.py 这类
 * 「名字里恰好含 say.py」的正常脚本（实测 `python essay.py` 必须放行）。
 */
const WILD_VOICE_SAY_PY_RE = /(?:^|[\\/"'\s`])say\.py/

/**
 * 检测 exec 工具调用是否在跑语音野链路（纯函数，零依赖，不抛异常）。
 * 命中返回 marker 字符串（稳定标识，供日志与断言使用），未命中或形状不可判返回 null。
 * 三层 fail-open，把「判不出就放行」固化在函数边界上：
 * 1) 非 feiyu 会话（含 sessionKey 缺失/其它 agent）→ null，不越界管别的 agent；
 * 2) 非 exec 工具 / params 非对象 / command 非字符串 → null；
 * 3) 命令里没有明确野链路特征 → null（普通排查、ffmpeg 转码等照常放行）。
 */
export function detectWildVoiceCommand(toolName, params, sessionKey) {
  if (!isFeiyuAgentSession(sessionKey)) return null
  if (typeof toolName !== 'string' || toolName.trim().toLowerCase() !== 'exec') return null
  if (!isRecord(params) || typeof params.command !== 'string' || !params.command) return null
  const command = params.command.toLowerCase()
  if (WILD_VOICE_SAY_PY_RE.test(command)) return 'say.py'
  const hit = WILD_VOICE_SUBSTRING_MARKERS.find((marker) => command.includes(marker))
  if (hit) return hit
  const endpointHit = WILD_VOICE_ENDPOINT_MARKERS.find((marker) => command.includes(marker))
  if (endpointHit) return endpointHit
  if (WILD_VOICE_FILES_PATH_RE.test(command)) return 'qq-openapi-files-path'
  return null
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pickBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 数值夹取：非数字/NaN 回落默认；±Infinity 夹到端点；有限值四舍五入后夹紧。
 * 与 groupPolicy.ts clampInt 同口径（避免宿主与插件对同一边界值判不同）。
 */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  if (value === Number.POSITIVE_INFINITY) return max
  if (value === Number.NEGATIVE_INFINITY) return min
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 单行短文本消毒：控制符/换行压成空格，trim + 按码点截断（replaceWith 用） */
function cleanShortText(value, max) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(cleaned)
  return chars.length > max ? chars.slice(0, max).join('').trim() : cleaned
}

/** 词表归一：trim/去重/限长/限量；非数组 → 默认词表（显式 [] 尊重用户清空） */
function cleanWordList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const out = []
  for (const item of value) {
    const word = cleanShortText(item, GROUP_WORD_LENGTH_MAX)
    if (!word || out.includes(word)) continue
    out.push(word)
    if (out.length >= GROUP_WORD_LIST_MAX) break
  }
  return out
}

/** 配置版本：缺省/非法 → 1；合法正整数原样保留（>1 由 guard.mjs 判为不支持） */
function normalizeVersion(value) {
  if (value === undefined || value === null) return GUARD_CONFIG_VERSION
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return GUARD_CONFIG_VERSION
  }
  return value
}

/** 默认群策略（与 groupPolicy.ts DEFAULT_GROUP_SETTINGS 的 fields 一一对应） */
export function createDefaultGuardPolicy() {
  return {
    replyEnabled: true,
    requireMention: true,
    voice: { enabled: false, dailyCap: 2 },
    words: { enabled: true, action: 'replace', replaceWith: '你', list: [...DEFAULT_WORD_LIST] },
    memoryIsolated: true,
    historyLimit: 20
  }
}

/**
 * v1 配置解析：未知字段丢弃、缺省补默认、非法值回落/夹紧。
 * 形状（宿主 buildGuardConfig 写什么就收什么）：
 * { version, statePath, timezone, policy: { replyEnabled, requireMention,
 *   voice: { enabled, dailyCap }, words: { enabled, action, replaceWith, list },
 *   memoryIsolated, historyLimit } }
 */
export function parseGuardConfig(raw) {
  const src = isRecord(raw) ? raw : {}
  const policySrc = isRecord(src.policy) ? src.policy : {}
  const voiceSrc = isRecord(policySrc.voice) ? policySrc.voice : {}
  const wordsSrc = isRecord(policySrc.words) ? policySrc.words : {}
  const defaults = createDefaultGuardPolicy()

  // 只认 replace/block；其它值按 replace 处理（更温和，且不会静默变成「取消整条消息」）
  const action = wordsSrc.action === 'block' ? 'block' : 'replace'
  const replaceWith =
    cleanShortText(wordsSrc.replaceWith, GROUP_WORD_LENGTH_MAX) || defaults.words.replaceWith

  return {
    version: normalizeVersion(src.version),
    statePath: typeof src.statePath === 'string' ? src.statePath.trim() : '',
    timezone:
      typeof src.timezone === 'string' && src.timezone.trim() ? src.timezone.trim() : 'UTC',
    policy: {
      replyEnabled: pickBoolean(policySrc.replyEnabled, defaults.replyEnabled),
      requireMention: pickBoolean(policySrc.requireMention, defaults.requireMention),
      voice: {
        enabled: pickBoolean(voiceSrc.enabled, defaults.voice.enabled),
        dailyCap: clampInt(
          voiceSrc.dailyCap,
          0,
          GROUP_DAILY_VOICE_CAP_MAX,
          defaults.voice.dailyCap
        )
      },
      words: {
        enabled: pickBoolean(wordsSrc.enabled, defaults.words.enabled),
        action,
        replaceWith,
        list: cleanWordList(wordsSrc.list, defaults.words.list)
      },
      memoryIsolated: pickBoolean(policySrc.memoryIsolated, defaults.memoryIsolated),
      historyLimit: clampInt(
        policySrc.historyLimit,
        0,
        GROUP_HISTORY_LIMIT_MAX,
        defaults.historyLimit
      )
    }
  }
}

/**
 * 群/私聊判定（fail-open：拿不到证据就当私聊）。
 * - `to` 命中 `^qqbot:group:` → 群；
 * - `sessionKey` 含 `:qqbot:group:` → 群（`agent:<agent>:qqbot:group:<openid>`，与 OpenClaw
 *   `classifySessionKind` 的 `:group:` 口径一致，但限定 qqbot 渠道，避免误伤 telegram/discord 群）；
 * - `channelId` 明确是 qqbot 且 sessionKey 含 `:group:` → 群（老宿主 sessionKey 可能没有
 *   渠道段，用 ctx.channelId 补证）；
 * - `channelId` 显式给了且不是 qqbot → 直接 false（只拦 QQ 群）；
 * - 其余（私聊 / 字段缺失 / 非法值）→ false。
 */
export function isGroupTarget(target) {
  const src = isRecord(target) ? target : {}
  const channelId = typeof src.channelId === 'string' ? src.channelId.trim().toLowerCase() : ''
  if (channelId && channelId !== 'qqbot') return false
  const to = typeof src.to === 'string' ? src.to.trim() : ''
  if (QQBOT_GROUP_TO_RE.test(to)) return true
  const sessionKey = typeof src.sessionKey === 'string' ? src.sessionKey : ''
  if (sessionKey.includes(':qqbot:group:')) return true
  if (channelId === 'qqbot' && sessionKey.includes(':group:')) return true
  return false
}

/** qqbot 群 sessionKey 里的群 openid：`agent:<agent>:qqbot:group:<id>` */
export const QQBOT_GROUP_SESSION_KEY_RE = /:qqbot:group:([^:]+)/i
/** 兜底：任何 `...:group:<id>`（老宿主 sessionKey 可能没有渠道段） */
export const GENERIC_GROUP_SESSION_KEY_RE = /(?:^|:)group:([^:]+)/i

/**
 * 从 sessionKey 取「计数键」——必须与 `qqbot_platform_api` 的 path 里 `/v2/groups/<id>/files`
 * 的 `<id>` 同源，否则两条发送路径会各算一份额度（群语音日上限被绕过）。
 */
export function groupKeyFromSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string' || !sessionKey) return ''
  const exact = QQBOT_GROUP_SESSION_KEY_RE.exec(sessionKey)
  if (exact) return exact[1]
  const generic = GENERIC_GROUP_SESSION_KEY_RE.exec(sessionKey)
  return generic ? generic[1] : ''
}

/**
 * 媒体项是不是音频：兼容 `type`（ReplyMediaAttachment 的权威字段）、`kind`、
 * `mimeType` / `contentType`（audio/*）。认不出 → false（宁可保留，不误删图片/文件）。
 */
export function isAudioAttachment(attachment) {
  if (!isRecord(attachment)) return false
  const type = typeof attachment.type === 'string' ? attachment.type.trim().toLowerCase() : ''
  if (type === 'audio') return true
  const kind = typeof attachment.kind === 'string' ? attachment.kind.trim().toLowerCase() : ''
  if (kind === 'audio') return true
  const mimeCandidates = [attachment.mimeType, attachment.contentType]
  for (const candidate of mimeCandidates) {
    if (typeof candidate === 'string' && candidate.trim().toLowerCase().startsWith('audio/')) {
      return true
    }
  }
  return false
}

/**
 * 从 ReplyPayload 里识别并剥离语音（纯函数，不改原对象）。
 * - 语音信号：`audioAsVoice === true`，或 attachments 里 mediaUrls 同下标项是音频；
 * - attachments 与 mediaUrls 按下标对齐（docs 口径）；没有 attachments 时 audioAsVoice
 *   视为「mediaUrls 全是语音候选」；
 * - 返回 { isVoice, changed, payload, removedMedia }；isVoice=false 时 payload 原样引用。
 * 只剥语音：text / 非音频 media / 其它字段（presentation/delivery/replyToId…）都保留。
 */
export function payloadVoiceInfo(payload) {
  const src = isRecord(payload) ? payload : null
  if (!src) return { isVoice: false, changed: false, payload: src, removedMedia: 0 }
  const audioAsVoice = src.audioAsVoice === true
  const originalMediaUrls = Array.isArray(src.mediaUrls)
    ? src.mediaUrls.filter((url) => typeof url === 'string' && url)
    : null
  const singleMediaUrl = typeof src.mediaUrl === 'string' && src.mediaUrl ? src.mediaUrl : ''
  const mediaUrls = originalMediaUrls && originalMediaUrls.length > 0
    ? originalMediaUrls
    : singleMediaUrl
      ? [singleMediaUrl]
      : []
  const attachments = Array.isArray(src.attachments) ? src.attachments : []
  const attachmentVoice = attachments.map((attachment) => isAudioAttachment(attachment))

  const voiceFlags = mediaUrls.map((_url, index) => {
    // 有 attachments 元数据时按音频类型判定；没有元数据才退回 audioAsVoice（audioAsVoice 可伴随图片）
    if (isRecord(attachments[index])) return attachmentVoice[index]
    return audioAsVoice
  })
  // attachments-only（mediaUrls 为空）也是真实出站路径：qqbot deliver-pipeline 会回落到
  // attachments[].path/url 并按下标推断语音，必须识别，否则语音开关/上限可被绕过。
  const isVoice = audioAsVoice || voiceFlags.some(Boolean) || attachmentVoice.some(Boolean)
  if (!isVoice) return { isVoice: false, changed: false, payload: src, removedMedia: 0 }

  // 没有 mediaUrls：只剥 audio attachments（以及 audioAsVoice 标记）
  if (mediaUrls.length === 0) {
    const keptAttachments = attachments.filter((_attachment, index) => !attachmentVoice[index])
    const attachmentsChanged = keptAttachments.length !== attachments.length
    const changed = audioAsVoice || attachmentsChanged
    const stripped = changed ? { ...src, audioAsVoice: false } : src
    if (changed && Array.isArray(src.attachments)) stripped.attachments = keptAttachments
    return { isVoice: true, changed, payload: stripped, removedMedia: 0 }
  }

  const keptMedia = []
  const keptAttachments = []
  let removedMedia = 0
  for (let index = 0; index < mediaUrls.length; index += 1) {
    if (voiceFlags[index]) {
      removedMedia += 1
      continue
    }
    keptMedia.push(mediaUrls[index])
    if (index < attachments.length) keptAttachments.push(attachments[index])
  }
  // attachments 可能比 mediaUrls 多：多出来的音频附件同样剥掉，非音频保留
  for (let index = mediaUrls.length; index < attachments.length; index += 1) {
    if (attachmentVoice[index]) removedMedia += 1
    else keptAttachments.push(attachments[index])
  }

  const stripped = { ...src, audioAsVoice: false }
  if (originalMediaUrls && originalMediaUrls.length > 0) {
    stripped.mediaUrls = keptMedia
  }
  // 单/多 media 字段都可能同时存在：保留下来的媒体同步到 mediaUrl，剥空则删掉
  if (keptMedia.length > 0) {
    stripped.mediaUrl = keptMedia[0]
  } else {
    delete stripped.mediaUrl
  }
  if (Array.isArray(src.attachments)) {
    stripped.attachments = keptAttachments
  }
  return { isVoice: true, changed: true, payload: stripped, removedMedia }
}

/** 剥离后还有没有可投递内容（text / fallbackText / media / presentation 任一即可） */
export function payloadHasVisibleContent(payload) {
  const src = isRecord(payload) ? payload : {}
  const text = typeof src.text === 'string' ? src.text.trim() : ''
  if (text) return true
  const fallback = isRecord(src.fallbackText) && typeof src.fallbackText.text === 'string'
    ? src.fallbackText.text.trim()
    : ''
  if (fallback) return true
  if (Array.isArray(src.mediaUrls) && src.mediaUrls.length > 0) return true
  if (typeof src.mediaUrl === 'string' && src.mediaUrl) return true
  if (Array.isArray(src.attachments) && src.attachments.length > 0) return true
  if (isRecord(src.presentation)) return true
  return false
}

/**
 * 亲密词过滤（纯函数）。
 * - action=replace：把所有命中词替换为 replaceWith，返回 { content, changed, matched }；
 * - action=block：命中即返回 { cancel: true, reason, matched }，不改写内容；
 * - 未启用 / 词表空 / 文本空 / 未命中：原样返回且 changed=false。
 */
export function filterWords(text, words) {
  const source = typeof text === 'string' ? text : ''
  const cfg = isRecord(words) ? words : {}
  const list = Array.isArray(cfg.list)
    ? cfg.list.filter((word) => typeof word === 'string' && word.length > 0)
    : []
  if (!source || cfg.enabled === false || list.length === 0) {
    return { content: source, changed: false, matched: [] }
  }
  if (cfg.action === 'block') {
    const matched = list.filter((word) => source.includes(word))
    if (matched.length === 0) return { content: source, changed: false, matched: [] }
    return { content: source, changed: false, cancel: true, reason: 'word-blocked', matched }
  }
  const replaceWith =
    typeof cfg.replaceWith === 'string' && cfg.replaceWith ? cfg.replaceWith : '你'
  let content = source
  const matched = []
  for (const word of list) {
    if (!content.includes(word)) continue
    matched.push(word)
    content = content.split(word).join(replaceWith)
  }
  return { content, changed: content !== source, matched }
}

/**
 * 按天日期键（YYYY-MM-DD）。timezone 非法 → 回落 UTC；now 非法 → 当前时间。
 * 用 formatToParts 拼，不依赖 Intl 的 locale 输出格式（en-CA 是否带前导零随 ICU 变）。
 */
export function dayKey(now, timezone) {
  const timestamp = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC'
  const format = (zone) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(timestamp))
  let parts
  try {
    parts = format(tz)
  } catch {
    parts = format('UTC')
  }
  const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * 状态归一：只保留「当天、非负整数计数」；损坏/跨天/未知版本 → 空计数。
 * 跨天清零在这里收口（不依赖调用方记得比较日期）。
 */
export function normalizeState(raw, day) {
  const target = typeof day === 'string' && day ? day : 'unknown'
  if (!isRecord(raw)) return { version: GUARD_CONFIG_VERSION, day: target, counts: {} }
  if (raw.version !== undefined && raw.version !== GUARD_CONFIG_VERSION) {
    return { version: GUARD_CONFIG_VERSION, day: target, counts: {} }
  }
  if (raw.day !== target) return { version: GUARD_CONFIG_VERSION, day: target, counts: {} }
  const counts = {}
  if (isRecord(raw.counts)) {
    for (const [groupId, value] of Object.entries(raw.counts)) {
      if (!groupId) continue
      const count =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
      if (count > 0) counts[groupId] = count
    }
  }
  return { version: GUARD_CONFIG_VERSION, day: target, counts }
}

/** 状态 JSON 的初始值（写盘形状固定：{version, day, counts}） */
export function emptyState(day) {
  return normalizeState(null, day)
}

/**
 * 语音条计数（纯函数 + 状态读写分离）：
 * - decide：只看状态与策略，不改状态，返回 { allow, reason, count }；
 * - record：返回计数 +1 的新状态（不可变，便于调用方先判定后落盘）；
 * - countOf：读单个群的当天计数。
 * 计数按群 openid 隔离；cap<=0 视为「当天一条都不允许」。
 */
export const voiceCounter = {
  countOf(state, groupId) {
    if (!isRecord(state) || !isRecord(state.counts)) return 0
    const value = state.counts[groupId]
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0
  },

  decide(state, { groupId, enabled, dailyCap } = {}) {
    const count = voiceCounter.countOf(state, groupId)
    if (enabled !== true) {
      return { allow: false, reason: GUARD_REASONS.VOICE_DISABLED, count }
    }
    const cap = typeof dailyCap === 'number' && Number.isFinite(dailyCap) ? Math.floor(dailyCap) : 0
    if (cap <= 0 || count >= cap) {
      return { allow: false, reason: GUARD_REASONS.VOICE_DAILY_CAP, count }
    }
    return { allow: true, reason: null, count }
  },

  record(state, groupId) {
    const day = isRecord(state) && typeof state.day === 'string' ? state.day : 'unknown'
    const base = normalizeState(state, day)
    return {
      version: GUARD_CONFIG_VERSION,
      day,
      counts: { ...base.counts, [groupId]: voiceCounter.countOf(base, groupId) + 1 }
    }
  }
}

function parseBody(body) {
  if (isRecord(body)) return body
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 从 `qqbot_platform_api` 的参数里认出「群语音上传」，返回群 openid；认不出返回 null。
 * 判据：path 命中 `/v2/groups/<id>/files` 且 body.file_type === 3（qqbot 插件 MediaFileType.VOICE）。
 * 只认这一条硬信号：图片(1)/视频(2)/文件(4) 与其它 path 一律放行。
 */
export function voiceUploadGroupId(params) {
  const src = isRecord(params) ? params : {}
  const path = typeof src.path === 'string' ? src.path.trim() : ''
  const match = GROUP_VOICE_UPLOAD_PATH_RE.exec(path)
  if (!match) return null
  const body = parseBody(src.body)
  if (!body) return null
  const rawType = body.file_type
  const fileType =
    typeof rawType === 'number'
      ? rawType
      : typeof rawType === 'string' && rawType.trim() !== ''
        ? Number(rawType)
        : Number.NaN
  if (fileType !== 3) return null
  return match[1]
}

/** C2C 语音上传路径：POST /v2/users/<openid>/files（与群路径同构，仅段名不同） */
const QQBOT_USER_VOICE_UPLOAD_PATH_RE = /^\/v2\/users\/([^/]+)\/files\/?$/

/**
 * 从 `qqbot_platform_api` 的参数里认出「C2C 语音上传」，返回用户 openid；认不出返回 null。
 * 判据与 voiceUploadGroupId 同口径：path 命中 `/v2/users/<id>/files` 且 body.file_type === 3。
 * 用途是 feiyu 通道合规（guard.mjs 按 feiyu 会话门控）：agent 经平台 API 直传私聊语音
 * 与 exec 野链路等效，必须收口到网关 tts；非语音 file_type 与其它 path 一律 null。
 */
export function voiceUploadUserId(params) {
  const src = isRecord(params) ? params : {}
  const path = typeof src.path === 'string' ? src.path.trim() : ''
  const match = QQBOT_USER_VOICE_UPLOAD_PATH_RE.exec(path)
  if (!match) return null
  const body = parseBody(src.body)
  if (!body) return null
  const rawType = body.file_type
  const fileType =
    typeof rawType === 'number'
      ? rawType
      : typeof rawType === 'string' && rawType.trim() !== ''
        ? Number(rawType)
        : Number.NaN
  if (fileType !== 3) return null
  return match[1]
}
