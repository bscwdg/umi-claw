// 启动耗时历史统计（纯函数，便于验收）
//
// 目的：让 UI 在长启动时能给出「预计还需 N 秒」的估算，而不是只显示已等时长。
// 数据只存最近若干次「spawn→health」耗时，不涉及任何用户内容。

/** 最多保留多少次历史样本 */
export const MAX_STARTUP_SAMPLES = 5
/** 估算时取最近多少次的中位数（历史越长越稳，但太久以前的可能不准） */
const ESTIMATE_WINDOW = 3

/** 把文件里的任意 JSON 规范成「正数毫秒数组」；坏数据一律当空 */
export function normalizeStartupDurations(raw: unknown): number[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { durations?: unknown }).durations)
      ? (raw as { durations: unknown[] }).durations
      : []
  return list
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(-MAX_STARTUP_SAMPLES)
}

/** 追加一次样本（保留最近 MAX_STARTUP_SAMPLES 次） */
export function appendStartupDuration(existing: unknown, durationMs: number): number[] {
  const normalized = normalizeStartupDurations(existing)
  if (!Number.isFinite(durationMs) || durationMs <= 0) return normalized
  return [...normalized, Math.round(durationMs)].slice(-MAX_STARTUP_SAMPLES)
}

/** 中位数（空数组返回 undefined） */
export function medianOf(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * 估算本次启动总耗时：取最近 ESTIMATE_WINDOW 次的中位数。
 * 样本不足 2 次时返回单次值（1 次也给出参考，不更差）。
 */
export function estimateStartupMs(durations: number[]): number | undefined {
  const normalized = normalizeStartupDurations(durations)
  if (!normalized.length) return undefined
  return medianOf(normalized.slice(-ESTIMATE_WINDOW))
}

/** 解析落盘内容（JSON 字符串） */
export function parseStartupStats(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    return normalizeStartupDurations(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 序列化落盘内容 */
export function serializeStartupStats(durations: number[]): string {
  return `${JSON.stringify({ version: 1, durations: normalizeStartupDurations(durations) }, null, 2)}\n`
}
