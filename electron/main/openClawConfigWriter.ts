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
  /**
   * 失败类别，供调用方决定后续动作：
   * - rejected：CLI 非 0 退出**且**输出命中官方非法配置诊断面（见
   *   isConfigRejectionOutput），是可交给 doctor --fix 收敛的确定性失败；
   * - timeout：CLI 在预算内没跑完。短命 CLI 冷启动也要复制插件隔离副本，
   *   Windows 下数千小文件 + fs-safe 逐文件准入可达数分钟，这不是配置非法的证据，
   *   绝不能据此触发 doctor；
   * - process：spawn / 管道层面的进程错误，或非 0 退出但没有配置非法的证据
   *   （崩溃 / OOM / 被信号杀死），同样不代表配置非法。
   */
  kind?: 'rejected' | 'timeout' | 'process'
  /** 失败原因（已裁剪为适合直接展示给用户的 CLI 错误尾部） */
  error?: string
  stdout: string
  stderr: string
}

/**
 * 单次 config patch 的超时预算。
 * config patch 是短命 CLI 进程，冷启动也要走一遍 OpenClaw 插件隔离副本复制
 * （渠道插件自带数千个 node_modules 文件，实测可达数分钟）。曾用 60s，慢环境下
 * 补丁还没执行进程就被中止，被上层误判为「配置非法」触发 doctor --fix，而 doctor
 * 复制量更大、还要逐文件哈希，20 分钟都跑不完，网关于是永远起不来。放宽到 5 分钟，
 * 串行队列保证同一时刻只有一次写入。
 */
const PATCH_TIMEOUT_MS = 300_000

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

/**
 * 在「同一 openclaw.json 路径」的官方写入串行队列里执行一次任务。
 *
 * 官方 patch 已用 serializePatch 串行化；任何**必须直接改 openclaw.json** 的维护动作
 * （例如补齐 meta 迁移标记）也必须进同一队列，否则会与 config patch 的
 * read→modify→write 形成 lost update：patch 可能覆盖标记，或标记覆盖用户刚保存的配置。
 */
export function runSerializedOpenClawConfigWrite<T>(
  configPath: string,
  task: () => Promise<T> | T
): Promise<T> {
  return serializePatch(configPath, async () => task())
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

/** 按 id 索引的数组：全部元素都是带非空字符串 id 的对象时返回 id 集合，否则 null。 */
function idKeyedArrayIds(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null
  const ids = new Set<string>()
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return null
    ids.add(entry.id.trim())
  }
  return ids
}

/** 与官方 `formatConcreteConfigPath` 同口径：普通键走点号，其余键走 ["..."] 括号形式。 */
function formatConcretePath(segments: string[]): string {
  return segments.reduce((path, segment) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(segment)) return `${path}[${JSON.stringify(segment)}]`
    return path ? `${path}.${segment}` : segment
  }, '')
}

/**
 * 计算「需要显式整体替换」的按 id 数组路径（供 `--replace-path` 使用）。
 *
 * 背景（OpenClaw 2026.10.x 起）：`config patch` 对按 id 的数组（如
 * `models.providers.<id>.models`）做**非破坏性**校验——若补丁里的数组会丢掉既有条目，
 * 整单被拒（exit 1，`Refusing to replace ...; it would remove existing entries: ...`），
 * 必须显式 `--replace-path <path>` 才允许替换。本项目是这些模型数组的唯一作者
 * （预设 + 用户自定义模型 + 激活模型补录），目标列表就是权威列表，因此对确实会移除
 * 条目的数组带上该开关；否则（例如老版本 CLI 没有该选项）不传，保持兼容。
 *
 * 只在「原数组与新数组都是按 id 数组」时判定：非按 id 数组（字符串数组、缺 id 的数组）
 * 不在官方校验范围内，传了反而可能因路径不匹配被判为无效参数。
 *
 * @returns 相对 openclaw.json 根的点号路径列表，可直接作为 `--replace-path` 参数
 */
export function collectLossyIdArrayReplacePaths(original: unknown, desired: unknown): string[] {
  const paths: string[] = []
  const walk = (base: unknown, next: unknown, path: string[]): void => {
    if (!isPlainObject(next)) return
    for (const [key, value] of Object.entries(next)) {
      const childPath = [...path, key]
      const baseValue = isPlainObject(base) ? (base as Record<string, unknown>)[key] : undefined
      if (Array.isArray(value)) {
        const nextIds = idKeyedArrayIds(value)
        const baseIds = idKeyedArrayIds(baseValue)
        if (nextIds && baseIds && [...baseIds].some((id) => !nextIds.has(id))) {
          paths.push(formatConcretePath(childPath))
        }
        continue
      }
      walk(baseValue, value, childPath)
    }
  }
  walk(original, desired, [])
  return paths
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

export interface OpenClawPatchOptions {
  /** 覆盖默认超时预算（毫秒） */
  timeoutMs?: number
  /**
   * 允许「整体替换」的按 id 数组路径（见 collectLossyIdArrayReplacePaths）。
   * 逐条转成官方 `config patch --replace-path <path>`（可重复）。
   */
  replacePaths?: string[]
}

/**
 * 通过官方 CLI 把 merge patch 应用到 openclaw.json（--stdin 喂 JSON，避免临时文件编码问题）。
 * 运行时（绿色 Node + openclaw 包）缺失时直接失败，不去 spawn 不存在的二进制。
 */
export function applyOpenClawConfigPatch(
  dataDir: string,
  patch: Record<string, unknown>,
  options: OpenClawPatchOptions = {}
): Promise<OpenClawPatchResult> {
  const configPath = openClawPaths.openClawConfig(dataDir)
  return serializePatch(configPath, () => runPatchProcess(dataDir, patch, options))
}

function runPatchProcess(
  dataDir: string,
  patch: Record<string, unknown>,
  options: OpenClawPatchOptions
): Promise<OpenClawPatchResult> {
  const timeoutMs = options.timeoutMs ?? PATCH_TIMEOUT_MS
  const replacePaths = Array.isArray(options.replacePaths) ? options.replacePaths.filter((p) => typeof p === 'string' && p.trim()) : []
  return new Promise((resolve) => {
    const nodePath = openClawPaths.nodeBinary(dataDir)
    const clawJsPath = openClawPaths.clawJs(dataDir)
    if (!existsSync(nodePath) || !existsSync(clawJsPath)) {
      resolve({
        ok: false,
        kind: 'process',
        error: 'OpenClaw 运行时未安装，请先完成环境初始化',
        stdout: '',
        stderr: ''
      })
      return
    }

    const child = spawn(
      nodePath,
      [
        clawJsPath,
        'config',
        'patch',
        '--stdin',
        // 官方 2026.10.x：按 id 数组若会移除既有条目，必须显式声明整体替换意图；
        // 否则整单被拒（Refusing to replace ...）。老版本 CLI 无此选项时不该出现这些路径
        // （见 collectLossyIdArrayReplacePaths 的注释），所以这里不会给老版本传未知参数。
        ...replacePaths.flatMap((p) => ['--replace-path', p])
      ],
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
        kind: 'timeout',
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
      resolve({
        ok: false,
        kind: 'process',
        error: '调用 openclaw config patch 失败: ' + err.message,
        stdout,
        stderr
      })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ ok: true, stdout, stderr })
        return
      }
      // 非 0 退出并不都是「配置非法」：崩溃 / OOM / 被信号杀死同样非 0。
      // 只有命中官方 CLI 自己的非法配置诊断面才算 rejected；其余归 process，
      // 避免因为一次 CLI 崩溃白跑一轮最长 20 分钟的 doctor --fix。
      // 若上游改了文案导致漏判，网关会以 exit 78 自退，由既有退出码自愈兜底。
      const rejected = isConfigRejectionOutput(stdout, stderr)
      resolve({
        ok: false,
        kind: rejected ? 'rejected' : 'process',
        error: rejected
          ? summarizePatchError(stdout, stderr, code)
          : summarizePatchError(
              stdout,
              stderr,
              code,
              'openclaw config patch 非正常退出（exit ' + (code ?? 'unknown') + '）'
            ),
        stdout,
        stderr
      })
    })

    // 官方只吃 JSON5，JSON 是其子集；写完即关 stdin 触发执行。
    // stdin 挂空 error 监听：子进程提前退出（如 patch 被秒拒、crash）时，向已关闭的 stdin
    // 写入会触发 EPIPE——不监听会变成未处理的 'error' 事件抛异常。结果本就由 close/error 覆盖，
    // 这里只需吞掉，避免掩盖真正的退出原因。
    child.stdin.on('error', () => { /* EPIPE：子进程已退出，忽略 */ })
    child.stdin.end(JSON.stringify(patch))
  })
}

/**
 * 识别「官方 CLI 明确判定配置非法」的输出特征。
 *
 * 官方在 src/config/io.invalid-config.ts 里把非法配置统一渲染成
 * `Invalid config at <path>:` / `Config could not be read at <path>:`，并在非交互模式
 * 追加 `Run "openclaw doctor --fix" to repair the config, then retry.`；错误码为
 * INVALID_CONFIG / CONFIG_READ_FAILED。命中这些才是可交给 doctor 收敛的确定性失败。
 *
 * 只做**收窄**，不做扩张：漏判时降到 process（告警并继续拉起），网关遇到非法配置
 * 仍会 exit 78，由既有退出码自愈链路触发 doctor，不会带病长期运行。
 */
export function isConfigRejectionOutput(stdout: string, stderr: string): boolean {
  const combined = (stderr || '') + '\n' + (stdout || '')
  return /(?:invalid config|config is invalid|config could not be read|INVALID_CONFIG|CONFIG_READ_FAILED|doctor --fix)/i.test(
    combined
  )
}

/**
 * 从 CLI 输出里挑出真正的拒绝原因（去掉 TQ 框线装饰，保留最后几行有效信息）。
 * @param prefix 失败前缀；调用方在「非配置拒绝」场景可传入不同措辞
 */
export function summarizePatchError(
  stdout: string,
  stderr: string,
  code: number | null,
  prefix = 'openclaw config patch 被官方校验拒绝（exit ' + (code ?? 'unknown') + '）'
): string {
  const combined = (stderr || '') + (stdout || '')
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[+|o\-]{1,3}\s*$/.test(line))
  const tail = lines.slice(-4).join('；')
  return tail ? prefix + '：' + tail : prefix
}
