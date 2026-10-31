// electron/main/character/memoryJob.ts —— 每日记忆（C07，纯逻辑 + 校验）
//
// 窗口：22:00–24:00（23:00 ±60min 宽容）；每天 ≤3 次尝试、间隔 ≥5min；
// 成功后当天不再跑；失败保留错误供设置页展示。
// 双写：workspace `memory/<date>.md` + Obsidian `大肥鱼/日记/<date>.md`。
// 不新增知识库：日记就是既有 Obsidian 里的 markdown 文件。

import type { CharacterSettings } from './types'

export const MEMORY_WINDOW_START_HOUR = 22
export const MEMORY_MAX_ATTEMPTS = 3
export const MEMORY_RETRY_GAP_MS = 5 * 60_000
export const OBSIDIAN_DIARY_DIR = '大肥鱼/日记'
export const DIARY_MAX_CHARS = 8000
const DIARY_MIN_CHARS = 20

export interface MemoryDayState {
  done?: boolean
  attempts?: number
  lastAttemptAt?: number
  lastError?: string
  memoryFile?: string
  obsidianPath?: string
}

export type MemoryGateReason =
  | 'disabled'
  | 'auto-off'
  | 'done'
  | 'not-window'
  | 'attempts'
  | 'cooldown'
  | 'ok'

export interface MemoryGateInput {
  now: number
  day: MemoryDayState
  settings: CharacterSettings
  /** 手动触发：跳过窗口与冷却，但仍受「已完成/尝试上限」约束 */
  manual?: boolean
}

export function isMemoryWindow(now: number): boolean {
  const hour = new Date(now).getHours()
  return hour >= MEMORY_WINDOW_START_HOUR
}

export function shouldRunMemory(input: MemoryGateInput): { run: boolean; reason: MemoryGateReason } {
  const { day, settings, now } = input
  if (!settings.enabled) return { run: false, reason: 'disabled' }
  if (!settings.memory.autoEnabled && !input.manual) return { run: false, reason: 'auto-off' }
  if (day.done) return { run: false, reason: 'done' }
  if (!input.manual && !isMemoryWindow(now)) return { run: false, reason: 'not-window' }
  if ((day.attempts ?? 0) >= MEMORY_MAX_ATTEMPTS) return { run: false, reason: 'attempts' }
  if (!input.manual && day.lastAttemptAt && now - day.lastAttemptAt < MEMORY_RETRY_GAP_MS) {
    return { run: false, reason: 'cooldown' }
  }
  return { run: true, reason: 'ok' }
}

export interface PromptInput {
  date: string
  herName?: string
  address?: string
  stage?: number
  stateDoc?: string
  lifeDoc?: string
  workspaceMemory?: string
  recentEvents?: string[]
  maxChars?: number
}

/** 组装日记 prompt：读 STATE/LIFE/当日记忆，要求先 update workspace 再写 Obsidian */
export function buildMemoryPrompt(input: PromptInput): string {
  const limit = input.maxChars ?? 4000
  const parts: string[] = []
  parts.push(`今天是 ${input.date}。用「${input.herName ?? '大肥鱼'}」的第一人称写今天的日记。`)
  parts.push(
    '要求：只写真实发生过的（聊天/互动/她的一天），不确定就写不确定；不要编造共同经历；' +
      '不要写用户隐私；200–500 字；语气符合她（短句、动作写括号里）。'
  )
  if (input.address) parts.push(`对用户的称呼用「${input.address}」。`)
  if (typeof input.stage === 'number') parts.push(`当前关系阶段：${input.stage}。`)
  if (input.stateDoc) parts.push(`【她的状态】\n${input.stateDoc.slice(0, 1200)}`)
  if (input.lifeDoc) parts.push(`【她的一天】\n${input.lifeDoc.slice(0, 1200)}`)
  if (input.workspaceMemory) {
    parts.push(`【今天的记忆片段】\n${input.workspaceMemory.slice(0, 1200)}`)
  }
  if (input.recentEvents?.length) {
    parts.push(`【今天的事件】\n${input.recentEvents.slice(0, 30).join('\n')}`)
  }
  parts.push(
    '输出格式：先输出完整 markdown 日记（以 --- frontmatter 开头，字段 date/tags/stage/intimacy/mood/source），不要额外解释。'
  )
  return parts.join('\n\n').slice(0, limit)
}

export interface DiaryValidation {
  ok: boolean
  errors: string[]
  frontmatter?: Record<string, string>
  body?: string
}

/** 从模型输出里抽出 markdown 日记正文（去代码围栏 / 前置解释） */
export function extractDiaryText(raw: string): string {
  let text = (raw ?? '').trim()
  text = text.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/i, '')
  const start = text.indexOf('---')
  if (start > 0) text = text.slice(start)
  return text.trim()
}

/** 校验日记：frontmatter 字段齐全、date 匹配、正文长度合理 */
export function validateDiary(text: string, date: string): DiaryValidation {
  const errors: string[] = []
  const raw = (text ?? '').trim()
  if (!raw) return { ok: false, errors: ['日记为空'] }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { ok: false, errors: ['缺少 frontmatter（--- 包裹）'] }
  const frontmatter: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) frontmatter[kv[1]] = kv[2].trim()
  }
  if (frontmatter.date !== date) errors.push(`frontmatter.date 应为 ${date}`)
  if (!/大肥鱼\/日记/.test(frontmatter.tags ?? '')) errors.push('frontmatter.tags 缺少 大肥鱼/日记')
  if (!frontmatter.stage) errors.push('frontmatter.stage 缺失')
  if (!frontmatter.intimacy) errors.push('frontmatter.intimacy 缺失')
  if (!frontmatter.mood) errors.push('frontmatter.mood 缺失')
  if (!frontmatter.source) errors.push('frontmatter.source 缺失')
  const body = (m[2] ?? '').trim()
  if (body.length < DIARY_MIN_CHARS) errors.push('正文太短')
  if (body.length > DIARY_MAX_CHARS) errors.push('正文过长')
  return { ok: errors.length === 0, errors, frontmatter, body }
}

/** 日记在 Obsidian 里的目标相对路径（固定 大肥鱼/日记/，不允许其它目录） */
export function diaryObsidianRelPath(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法日期: ${date}`)
  return `${OBSIDIAN_DIARY_DIR}/${date}.md`
}
