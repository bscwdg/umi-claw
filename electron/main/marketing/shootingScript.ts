// shootingScript.ts —— 分镜脚本契约（二阶段：shooting_script 产物）
//
// 纯函数 + 纯数据：不 import electron、不发 HTTP、不落库（与 platformRules.ts 同精神），
// esbuild bundle 后可在纯 Node 验收（test/shooting.accept.mjs）。
//
// 契约（二阶段评审）：
//   - contents.content_type='shooting_script' 的生成走**单路 SSE 流 + 严格 JSON 契约**
//     （post 仍是 09 的三路角度），temperature 0.4；content_type 创建后不可改。
//   - 版本行 content_versions.content = **原始 JSON 字符串**（忠实快照、可重渲染、可复盘）；
//     contents.content 由「采用」写回 renderScriptText 的渲染文本（人工可编辑交付物）。
//   - JSON 解析失败：抛 VALIDATION_ERROR（reason='shooting-script-unparsable'）→ 不落版本行；
//     已上屏的原始流文本由渲染端保留可复制（软失败，不删已见文本）。
//   - businessLine（photography/fashion）：生成参数不落 schema，进 prompt 快照；
//     预选由 project.industry 经 deriveBusinessLine 推导，UI 可改。
//   - 防护：shots 1-30、durationSec 1-300（坏条目丢弃/越界夹紧，防垃圾 JSON 撑爆渲染）。
//   - 本期只做分镜脚本；AI 视频提示词（video_prompt）走枚举+模板扩展，下一轮。

import { AppError, ERROR_CODES } from '../database/errors'
import { extractJsonObject } from './jsonExtract'

// ── 产物类型 / 业务线常量 ──────────────────────────────────────────────────────

export const CONTENT_TYPES = ['post', 'shooting_script'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

export const BUSINESS_LINES = ['photography', 'fashion'] as const
export type BusinessLine = (typeof BUSINESS_LINES)[number]

export const BUSINESS_LINE_LABELS: Record<BusinessLine, string> = {
  photography: '摄影',
  fashion: '服饰'
}

// ── JSON 契约字段上限（防垃圾 JSON 撑爆渲染/存储） ─────────────────────────────

export const SCRIPT_TITLE_MAX = 120
export const SCRIPT_COVER_MAX = 300
export const SCRIPT_HOOK_MAX = 300
export const SCRIPT_CTA_MAX = 300
export const SCRIPT_HASHTAG_MAX = 30
export const SCRIPT_HASHTAGS_MAX = 10
export const SCRIPT_SHOT_MAX = 200
export const SCRIPT_VOICEOVER_MAX = 600
export const SCRIPT_SUBTITLE_MAX = 200
export const SCRIPT_CAMERA_TIP_MAX = 300
export const SCRIPT_SHOTS_MIN = 1
export const SCRIPT_SHOTS_MAX = 30
export const SCRIPT_DURATION_MIN = 1
export const SCRIPT_DURATION_MAX = 300
export const SCRIPT_DURATION_DEFAULT = 5

// ── 数据形状 ───────────────────────────────────────────────────────────────────

export interface ShootingShot {
  index: number
  shot: string
  durationSec: number
  voiceover: string
  subtitle: string
  cameraTip: string
}

export interface ShootingScript {
  title: string
  cover: string
  hook: string
  cta: string
  hashtags: string[]
  shots: ShootingShot[]
}

// ── JSON 提取（裸对象 / markdown 围栏 / 解释文字里夹对象均可） ──
// 实现收在 jsonExtract.ts：平衡扫描，解释文字里带花括号也不会切错（09 与 advisor/hotScore 同口径）

export { extractJsonObject } from './jsonExtract'

function unparsable(message: string): AppError {
  return new AppError(ERROR_CODES.VALIDATION_ERROR, message, { reason: 'shooting-script-unparsable' })
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const t = value.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max) : t
}

function cleanMultiline(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const t = String(value).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!t) return ''
  return t.length > max ? t.slice(0, max) : t
}

function clampDuration(value: unknown): number {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim()) n = Number(value)
  else return SCRIPT_DURATION_DEFAULT
  if (!Number.isFinite(n)) return SCRIPT_DURATION_DEFAULT
  n = Math.round(n)
  if (n < SCRIPT_DURATION_MIN) return SCRIPT_DURATION_MIN
  if (n > SCRIPT_DURATION_MAX) return SCRIPT_DURATION_MAX
  return n
}

function parseHashtags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const entry of value) {
    const tag = cleanString(entry, SCRIPT_HASHTAG_MAX).replace(/^#+/, '')
    if (!tag || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= SCRIPT_HASHTAGS_MAX) break
  }
  return tags
}

function parseShots(value: unknown): ShootingShot[] {
  if (!Array.isArray(value)) {
    throw unparsable('分镜脚本 JSON 的 shots 必须是数组')
  }
  const shots: ShootingShot[] = []
  for (const entry of value) {
    const obj = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null
    const shot = cleanString(obj?.shot, SCRIPT_SHOT_MAX)
    const voiceover = cleanMultiline(obj?.voiceover, SCRIPT_VOICEOVER_MAX)
    // 缺画面或缺口播的坏条目直接丢弃（同评分批量 parseScoreItems 的坏条目口径）
    if (!shot || !voiceover) continue
    shots.push({
      index: shots.length + 1,
      shot,
      durationSec: clampDuration(obj?.durationSec),
      voiceover,
      subtitle: cleanString(obj?.subtitle, SCRIPT_SUBTITLE_MAX),
      cameraTip: cleanString(obj?.cameraTip, SCRIPT_CAMERA_TIP_MAX)
    })
    if (shots.length >= SCRIPT_SHOTS_MAX) break
  }
  if (shots.length < SCRIPT_SHOTS_MIN) {
    throw unparsable('分镜脚本 JSON 没有可用分镜（shots 至少 1 条，需含 shot/voiceover）')
  }
  return shots
}

/**
 * 解析+校验模型返回。结构性必填（title/hook/shots）缺失即抛 VALIDATION_ERROR
 * （调用方据此不落版本行）；坏 shot 条目丢弃、数量封顶、时长夹紧。
 */
export function parseShootingScript(raw: string): ShootingScript {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) {
    throw unparsable('分镜脚本返回不含 JSON 对象')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw unparsable('分镜脚本 JSON 解析失败')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unparsable('分镜脚本返回不是 JSON 对象')
  }
  const obj = parsed as Record<string, unknown>
  const title = cleanString(obj.title, SCRIPT_TITLE_MAX)
  if (!title) throw unparsable('分镜脚本 JSON 缺少 title')
  const hook = cleanMultiline(obj.hook, SCRIPT_HOOK_MAX)
  if (!hook) throw unparsable('分镜脚本 JSON 缺少 hook（前 3 秒钩子）')
  return {
    title,
    cover: cleanMultiline(obj.cover, SCRIPT_COVER_MAX),
    hook,
    cta: cleanMultiline(obj.cta, SCRIPT_CTA_MAX),
    hashtags: parseHashtags(obj.hashtags),
    shots: parseShots(obj.shots)
  }
}

/** 规范化序列化（版本行存的「原始 JSON」——忠实快照、可重渲染） */
export function serializeShootingScript(script: ShootingScript): string {
  return JSON.stringify(script, null, 2)
}

/** 渲染为老板可读可复制的分镜清单（contents.content 的交付文本由「采用」写回它） */
export function renderScriptText(script: ShootingScript): string {
  const lines: string[] = [`【分镜脚本】${script.title}`, '']
  if (script.cover) lines.push(`封面建议：${script.cover}`, '')
  lines.push(`开头钩子：${script.hook}`, '')
  for (const shot of script.shots) {
    lines.push(`镜头 ${shot.index}（${shot.durationSec}s）：${shot.shot}`)
    lines.push(`  口播：${shot.voiceover}`)
    if (shot.subtitle) lines.push(`  字幕：${shot.subtitle}`)
    if (shot.cameraTip) lines.push(`  机位：${shot.cameraTip}`)
    lines.push('')
  }
  if (script.cta) lines.push(`行动引导：${script.cta}`, '')
  if (script.hashtags.length) {
    lines.push(`话题：${script.hashtags.map((t) => '#' + t).join(' ')}`, '')
  }
  return lines.join('\n').trim()
}

// ── 业务线推导 / 校验 ──────────────────────────────────────────────────────────

/**
 * 从 project.industry 推导预选业务线（产品原则「他填过的，AI 必须用上」）：
 * 含「摄」→ photography；含「服/衣」→ fashion；其余/空 → null（通用模板）。
 */
export function deriveBusinessLine(industry: unknown): BusinessLine | null {
  const s = String(industry ?? '')
  if (!s) return null
  if (s.includes('摄')) return 'photography'
  if (s.includes('服') || s.includes('衣')) return 'fashion'
  return null
}

/** 校验产物类型；空/缺省 → 'post'；非法值不静默归一 */
export function normalizeContentType(value: unknown): ContentType {
  if (value === undefined || value === null || value === '') return 'post'
  const v = String(value).trim().toLowerCase()
  if (!(CONTENT_TYPES as readonly string[]).includes(v)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `产物类型只支持 ${CONTENT_TYPES.join(' / ')}（实际 ${v}）`, {
      field: 'contentType',
      allowed: [...CONTENT_TYPES]
    })
  }
  return v as ContentType
}

/** 校验业务线；空 → null（通用）；非法值 → VALIDATION_ERROR */
export function normalizeBusinessLine(value: unknown): BusinessLine | null {
  if (value === undefined || value === null) return null
  const v = String(value).trim().toLowerCase()
  if (!v) return null
  if (!(BUSINESS_LINES as readonly string[]).includes(v)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `业务线只支持 ${BUSINESS_LINES.join(' / ')} / 空（实际 ${v}）`, {
      field: 'businessLine',
      allowed: [...BUSINESS_LINES]
    })
  }
  return v as BusinessLine
}

/** prompt 用业务线说明（快照复盘可辨识） */
export function businessLineText(line: BusinessLine | null): string {
  return line
    ? `业务线：${BUSINESS_LINE_LABELS[line]}（${line}）——分镜与口播贴合该业态。`
    : '业务线：通用（未指定行业预设，按商家资料本身处理）。'
}

// ── JSON 契约文本（注入请求 + prompt 快照） ───────────────────────────────────

export function shootingScriptContractText(): string {
  return [
    '严格只输出一个 JSON 对象（不要 markdown 围栏、不要解释文字），结构：',
    '{',
    '  "title": "成片标题，≤120 字",',
    '  "cover": "封面画面/文字建议（只给老板自拍的建议，不假装图已存在），≤300 字",',
    '  "hook": "前 3 秒口播钩子，≤300 字",',
    '  "cta": "结尾行动引导，≤300 字",',
    '  "hashtags": ["话题词，不带 #，≤10 个"],',
    '  "shots": [',
    '    {',
    '      "index": 1,',
    '      "shot": "本镜头拍什么（画面/动作），≤200 字",',
    `      "durationSec": ${SCRIPT_DURATION_DEFAULT},`,
    '      "voiceover": "本镜头口播文案，≤600 字",',
    '      "subtitle": "屏幕字幕，≤200 字",',
    '      "cameraTip": "机位/运镜建议，≤300 字"',
    '    }',
    '  ]',
    '}',
    `约束：shots 数量 ${SCRIPT_SHOTS_MIN}-${SCRIPT_SHOTS_MAX}；durationSec 取 ${SCRIPT_DURATION_MIN}-${SCRIPT_DURATION_MAX} 的整数；`,
    '所有事实只能引用商家资料里出现过的信息，资料没有的不编。'
  ].join('\n')
}
