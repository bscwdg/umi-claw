// electron/main/claw/gatewayRuntime.ts —— 「后台网关」运行时描述与 detached 日志 tail
//
// 为什么单独拆出来：退出保留网关（keepGatewayOnQuit）时，日志不再走管道而是写文件，
// 面板靠从文件增量 tail 取日志；运行时描述则是下次启动复用的唯一凭据。
// 两者都只是文件读写 + 文本格式转换，与 ClawManager 的启动状态机解耦。

import { closeSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ClawLogger } from './deps'

/** 一条文件日志 tail 的状态（偏移 + 未成行的半行） */
export interface GatewayLogTail {
  file: string
  type: 'stdout' | 'stderr'
  offset: number
  carry: string
}

/** 写运行时描述需要的实例状态（全部动态读取：写入时刻才取当前值） */
export interface GatewayRuntimeDeps {
  getDataDir: () => string
  getPid: () => number | undefined
  getPort: () => number
  getStartedAt: () => number | undefined
  isDetached: () => boolean
  readOpenClawVersion: (dataDir: string) => string | undefined
}

/** 运行时描述的固定文件名（data/cache/gateway-runtime.json） */
function gatewayRuntimeFile(dataDir: string): string {
  return join(dataDir, 'cache', 'gateway-runtime.json')
}

/** 记录「后台网关」描述（供下次启动复用）；普通模式下写了也无害 */
export function writeGatewayRuntime(deps: GatewayRuntimeDeps, logFile: string): void {
  try {
    const dataDir = deps.getDataDir()
    const file = gatewayRuntimeFile(dataDir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          pid: deps.getPid(),
          port: deps.getPort(),
          startedAt: deps.getStartedAt(),
          detached: deps.isDetached(),
          openclawVersion: deps.readOpenClawVersion(dataDir),
          logFile
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
  } catch {
    /* 运行时描述只是便利文件，失败不影响启动 */
  }
}

/** 清掉运行时描述（停止/冷启动前） */
export function clearGatewayRuntime(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* ignore */
  }
}

/** 把 pino JSON 行还原成可读文本（兼容 msg 字段；解析失败原样输出） */
function formatGatewayLogLine(line: string): string {
  const text = line.trim()
  if (!text.startsWith('{')) return text
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const msg = parsed['1'] ?? parsed.msg
    if (typeof msg === 'string') return msg
    if (msg && typeof msg === 'object') return JSON.stringify(msg)
    return text
  } catch {
    return text
  }
}

/**
 * 增量读取（stat 判增长 + read(offset)，不再整文件 readFileSync）。
 * 直接改写传入的 tail 状态（offset/carry），每读出一整行就交给 onLine 落日志/推事件。
 *
 * onLine 必须在本函数的 per-tail try 内调用：旧实现的 try 同时包住 `_addLog` 与
 * `emit`，监听器抛错只中断当前这个 tail、下个 tick 继续；若把回调挪到 try 外，
 * 事件监听抛错会冒到 400ms 的 interval 定时器上（未捕获异常可能直接崩主进程）。
 */
export function drainGatewayLogTails(
  tails: GatewayLogTail[],
  onLine: (text: string, type: 'stdout' | 'stderr') => void
): void {
  for (const tail of tails) {
    try {
      const size = statSync(tail.file).size
      // 文件被截断/轮转：从头重读，丢弃半个旧行
      if (size < tail.offset) {
        tail.offset = 0
        tail.carry = ''
      }
      if (size <= tail.offset) continue
      const want = Math.min(size - tail.offset, 1024 * 1024)
      const fd = openSync(tail.file, 'r')
      try {
        const buf = Buffer.alloc(want)
        const read = readSync(fd, buf, 0, want, tail.offset)
        tail.offset += read
        const chunk = tail.carry + buf.subarray(0, read).toString('utf-8')
        const lines = chunk.split('\n')
        tail.carry = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          onLine(formatGatewayLogLine(line), tail.type)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      /* 文件暂不可读 / 下游日志回调抛错：本 tail 本轮放弃，下个 tick 继续 */
    }
  }
}

/** V8 编译缓存无上限；启动后后台做一次上限清理（超过 512MB 清空） */
export function scheduleNodeCompileCacheCleanup(log: ClawLogger, dataDir: string): void {
  const timer = setTimeout(() => {
    try {
      const dir = join(dataDir, 'cache', 'node-compile')
      let total = 0
      const walk = (p: string, depth: number): void => {
        if (depth > 6) return
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          const full = join(p, entry.name)
          if (entry.isDirectory()) walk(full, depth + 1)
          else {
            try {
              total += statSync(full).size
            } catch {
              /* ignore */
            }
          }
        }
      }
      walk(dir, 0)
      if (total > 512 * 1024 * 1024) {
        rmSync(dir, { recursive: true, force: true })
        log(`[gateway] 已清理过大的 V8 编译缓存（${Math.round(total / 1024 / 1024)}MB）`, 'system')
      }
    } catch {
      /* 清理 best-effort */
    }
  }, 5000)
  ;(timer as { unref?: () => void }).unref?.()
}
