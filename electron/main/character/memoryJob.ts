// electron/main/character/memoryJob.ts —— 每日记忆（C07，纯逻辑 + 校验）
//
// 窗口：22:00–24:00（23:00 ±60min 宽容）；每天 ≤3 次尝试、间隔 ≥5min；
// 成功后当天不再跑；失败保留错误供设置页展示。
// 双写：workspace `memory/<date>.md` + Obsidian `大肥鱼/日记/<date>.md`。
// 不新增知识库：日记就是既有 Obsidian 里的 markdown 文件。

import type { CharacterSettings } from './types'

export const MEMORY_WINDOW_START_HOUR = 23
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
  /** workspace 已写但 Obsidian 未写（重试时复用正文，不重新生成） */
  partial?: boolean
  /** 已生成但未完成双写的正文（仅内存/短期落盘，≤ DIARY_MAX_CHARS） */
  pendingText?: string
}

export type MemoryGateReason =
  | 'disabled'
  | 'auto-off'
  | 'done'
  | 'not-window'
  | 'attempts'
  | 'cooldown'
  | 'in-flight'
  | 'failed'
  | 'age-unconfirmed'
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
  // 23:00–24:00 正常窗口；次日 00:00–06:00 作为迟到补偿（补写前一天，不补多天）
  return hour >= MEMORY_WINDOW_START_HOUR || hour < 6
}

/** 记忆任务对应的「日记日期」：凌晨补偿写前一天 */
export function memoryDateFor(now: number): string {
  const d = new Date(now)
  if (d.getHours() < 6) d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 密钥脱敏：日记/记忆片段里的 key、token、密码一律替换后再落盘（PLAN §13.1-8） */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    // sk-xxx / ak-xxx / API key / token 形值
    .replace(/\b((?:sk|ak|pk|ghp|gho|xox)[-_][A-Za-z0-9_-]{8,})/gi, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|secret|token|password|passwd|pwd|authorization|bearer)\b\s*[:=：]\s*["']?([A-Za-z0-9._\-+/=]{6,})["']?/gi,
      (_m, key: string) => `${key}: [REDACTED]`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
    .replace(
      /(密码|口令|密钥|令牌|秘钥)(是|为|[:：=])\s*[^\s，。；,;]{3,}/g,
      (_m, label: string) => `${label}是 [REDACTED]`
    )
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text
}

export function shouldRunMemory(input: MemoryGateInput): { run: boolean; reason: MemoryGateReason } {
  const { day, settings, now } = input
  if (!settings.enabled) return { run: false, reason: 'disabled' }
  if (!settings.memory.autoEnabled && !input.manual) return { run: false, reason: 'auto-off' }
  if (day.done) return { run: false, reason: 'done' }
  if (!input.manual && !isMemoryWindow(now)) return { run: false, reason: 'not-window' }
  // 手动补救不受尝试上限限制（否则白天失败后当天无法再写）
  if (!input.manual && (day.attempts ?? 0) >= MEMORY_MAX_ATTEMPTS) {
    return { run: false, reason: 'attempts' }
  }
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
  // 格式指令必须永远在末尾可见：先给数据留预算，再拼指令，防止截断把格式要求切掉
  const instruction =
    '输出格式：先输出完整 markdown 日记（以 --- frontmatter 开头，字段 date/tags/stage/intimacy/mood/source），不要额外解释。'
  const head = [instruction]
  const data: string[] = []
  data.push(`今天是 ${input.date}。用「${input.herName ?? '大肥鱼'}」的第一人称写今天的日记。`)
  data.push(
    '要求：只写真实发生过的（聊天/互动/她的一天），不确定就写不确定；不要编造共同经历；' +
      '不要写用户隐私；200–500 字；语气符合她（短句、动作写括号里）。'
  )
  if (input.address) data.push(`对用户的称呼用「${input.address}」。`)
  if (typeof input.stage === 'number') data.push(`当前关系阶段：${input.stage}。`)
  if (input.stateDoc) data.push(`【她的状态】\n${redactSecrets(input.stateDoc).slice(0, 1200)}`)
  if (input.lifeDoc) data.push(`【她的一天】\n${redactSecrets(input.lifeDoc).slice(0, 1200)}`)
  if (input.workspaceMemory) {
    data.push(`【今天的记忆片段】\n${redactSecrets(input.workspaceMemory).slice(0, 1200)}`)
  }
  if (input.recentEvents?.length) {
    data.push(`【今天的事件】\n${redactSecrets(input.recentEvents.join('\n')).slice(0, 1200)}`)
  }
  const headText = head.join('\n\n')
  const dataBudget = Math.max(400, limit - headText.length - 4)
  const dataText = data.join('\n\n').slice(0, dataBudget)
  return `${headText}\n\n${dataText}`.slice(0, limit)
}

export interface DiaryValidation {
  ok: boolean
  errors: string[]
  frontmatter?: Record<string, string>
  body?: string
}

/** 从模型输出里抽出 markdown 日记正文（去代码围栏 / 前置解释 / 结尾客套） */
export function extractDiaryText(raw: string): string {
  let text = (raw ?? '').trim()
  // 优先取完整代码围栏内部（模型常把整篇日记包进 ```markdown ... ```）
  const fenced = /```(?:markdown|md)?\s*\n?([\s\S]*?)```/i.exec(text)
  if (fenced && fenced[1].includes('---')) text = fenced[1].trim()
  // 兜底：去掉残留围栏
  text = text.replace(/```(?:markdown|md)?\s*\n?/gi, '').replace(/\n?```/g, '')
  const start = text.indexOf('---')
  if (start > 0) text = text.slice(start)
  return text.trim()
}

/**
 * 规范化：只保留约定的 frontmatter 字段并重新序列化（防 YAML 键注入），
 * 再对正文做密钥脱敏。校验前必须走这一层。
 */
export function normalizeDiary(text: string, date: string): string {
  const raw = (text ?? '').trim()
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return redactSecrets(raw)
  const allowed = ['date', 'tags', 'stage', 'intimacy', 'mood', 'source']
  const parsed: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv && allowed.includes(kv[1])) parsed[kv[1]] = kv[2].trim()
  }
  parsed.date = date
  if (!parsed.tags) parsed.tags = '[大肥鱼/日记]'
  const body = redactSecrets((m[2] ?? '').trim())
  const head = allowed.filter((k) => parsed[k]).map((k) => `${k}: ${parsed[k]}`)
  return `---\n${head.join('\n')}\n---\n\n${body}\n`
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
