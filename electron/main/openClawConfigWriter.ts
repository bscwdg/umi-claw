/**
 * OpenClaw 官方配置写入通道。
 *
 * 架构原则：openclaw.json 的唯一合法写入方式是官方 CLI `openclaw config patch`，
 * 本模块之外不允许再直接重写该文件。官方写入器提供三重保证（见运行时 docs/cli/config.md）：
 *   1. 落盘前按当前版本 schema 校验整份配置，非法补丁整单拒绝、原文件不动（旁路存 .rejected.*）；
 *   2. 对象递归合并、数组/标量整体替换、null 删除路径（RFC 7396 风格），一次原子写；
 *   3. meta（lastTouchedVersion / migrations 钉）由官方自动盖戳，显式写反而会被拒绝。
 *
 * 这样上游未来再退役/改名任何键，都由已安装版本的官方写入器自己吸收，应用无需逐键跟进。
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { openClawPaths, buildOpenClawEnv } from './openClawPaths'

export interface OpenClawPatchResult {
  ok: boolean
  /** 失败原因（已裁剪为适合直接展示给用户的 CLI 错误尾部） */
  error?: string
  stdout: string
  stderr: string
}

/** 单次 config patch 的超时：本机冷启动 spawn 约 2~12s，60s 仅作兜底 */
const PATCH_TIMEOUT_MS = 60_000

/**
 * 按配置路径串行化所有写入：config patch 内部要开 state 库事务，
 * 并发写互相抢锁会让其中一方失败（SQLITE_BUSY）。
 *
 * 说明：队列 key 用的是「解析后的 configPath」而非 dataDir——在本项目里一个 dataDir
 * 对应唯一一个 openclaw.json 路径，二者等价；仅口径以实际隔离粒度（配置文件）为准。
 */
const patchChains = new Map<string, Promise<unknown>>()

function serializePatch<T>(configPath: string, task: () => Promise<T>): Promise<T> {
  const previous = patchChains.get(configPath) ?? Promise.resolve()
  const current = previous.then(task, task)
  patchChains.set(configPath, current)
  void current.finally(() => {
    if (patchChains.get(configPath) === current) patchChains.delete(configPath)
  })
  return current
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 由「原配置 → 目标配置」生成最小 RFC 7396 merge patch：
 * - 两边都是纯对象：递归；只在原值存在、目标已删除的键输出 null；其余递归结果；
 * - 数组 / 标量 / null：不相等时整体输出目标值（即数组整体替换）；
 * - 完全相等：不出现在补丁里。
 *
 * 约束说明：本工具用 `null` 表达「删除该键」，因此**无法向 openclaw.json 写入一个字面值
 * `null`**（schema 允许 null 的字段也不例外）——目标值为 null 会被静默当作删除处理。
 * 当前所有调用方都以 null 表删除，行为符合预期；若未来确需写字面 null，需另行设计哨兵值。
 *
 * @returns null 表示无任何差异（调用方跳过 spawn；官方对 no-op 也会刷一次写）
 */
export function buildJsonMergePatch(original: unknown, desired: unknown): Record<string, unknown> | null {
  const diff = diffValue(original, desired)
  return isPlainObject(diff) && Object.keys(diff).length > 0 ? diff : null
}

function diffValue(original: unknown, desired: unknown): unknown {
  if (isPlainObject(original) && isPlainObject(desired)) {
    const patch: Record<string, unknown> = {}
    for (const key of Object.keys(original)) {
      if (!(key in desired)) patch[key] = null
    }
    for (const key of Object.keys(desired)) {
      if (!(key in original)) {
        patch[key] = desired[key]
        continue
      }
      const child = diffValue(original[key], desired[key])
      if (child !== undefined) patch[key] = child
    }
    // 嵌套对象内部无任何差异时必须归约为 undefined：否则空对象 {} 会一路冒泡，
    // 让「完全相等」的配置也生成非空补丁，导致每次启动都白跑一次 config patch。
    // 注意：含删除键（值为 null）时 patch 非空，会正常返回，不受此归约影响。
    return Object.keys(patch).length > 0 ? patch : undefined
  }
  return JSON.stringify(original) === JSON.stringify(desired) ? undefined : desired
}

/**
 * 通过官方 CLI 把 merge patch 应用到 openclaw.json（--stdin 喂 JSON，避免临时文件编码问题）。
 * 运行时（绿色 Node + openclaw 包）缺失时直接失败，不去 spawn 不存在的二进制。
 */
export function applyOpenClawConfigPatch(
  dataDir: string,
  patch: Record<string, unknown>,
  timeoutMs: number = PATCH_TIMEOUT_MS
): Promise<OpenClawPatchResult> {
  const configPath = openClawPaths.openClawConfig(dataDir)
  return serializePatch(configPath, () => runPatchProcess(dataDir, patch, timeoutMs))
}

function runPatchProcess(
  dataDir: string,
  patch: Record<string, unknown>,
  timeoutMs: number
): Promise<OpenClawPatchResult> {
  return new Promise((resolve) => {
    const nodePath = openClawPaths.nodeBinary(dataDir)
    const clawJsPath = openClawPaths.clawJs(dataDir)
    if (!existsSync(nodePath) || !existsSync(clawJsPath)) {
      resolve({ ok: false, error: 'OpenClaw 运行时未安装，请先完成环境初始化', stdout: '', stderr: '' })
      return
    }

    const child = spawn(
      nodePath,
      [clawJsPath, 'config', 'patch', '--stdin'],
      {
        cwd: openClawPaths.installDir(dataDir),
        env: buildOpenClawEnv(dataDir, nodePath),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      }
    )

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // 只杀顶层 node：config patch 派生的 sqlite readonly worker 可能短时成为孤儿，
      // 但其无写锁、会随 stdin 断开自行退出，影响可忽略，不值得为此引入进程树遍历。
      try { child.kill() } catch { /* ignore */ }
      resolve({
        ok: false,
        error: 'openclaw config patch 超过 ' + Math.round(timeoutMs / 1000) + 's 未结束，已中止',
        stdout,
        stderr
      })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: '调用 openclaw config patch 失败: ' + err.message, stdout, stderr })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ ok: true, stdout, stderr })
        return
      }
      resolve({ ok: false, error: summarizePatchError(stdout, stderr, code), stdout, stderr })
    })

    // 官方只吃 JSON5，JSON 是其子集；写完即关 stdin 触发执行。
    // stdin 挂空 error 监听：子进程提前退出（如 patch 被秒拒、crash）时，向已关闭的 stdin
    // 写入会触发 EPIPE——不监听会变成未处理的 'error' 事件抛异常。结果本就由 close/error 覆盖，
    // 这里只需吞掉，避免掩盖真正的退出原因。
    child.stdin.on('error', () => { /* EPIPE：子进程已退出，忽略 */ })
    child.stdin.end(JSON.stringify(patch))
  })
}

/** 从 CLI 输出里挑出真正的拒绝原因（去掉 TQ 框线装饰，保留最后几行有效信息） */
export function summarizePatchError(stdout: string, stderr: string, code: number | null): string {
  const combined = (stderr || '') + (stdout || '')
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[+|o\-]{1,3}\s*$/.test(line))
  const tail = lines.slice(-4).join('；')
  const prefix = 'openclaw config patch 被官方校验拒绝（exit ' + (code ?? 'unknown') + '）'
  return tail ? prefix + '：' + tail : prefix
}
