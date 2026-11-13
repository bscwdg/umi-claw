// test/_lib.mjs —— 验收脚本共享工具（零 npm 依赖；esbuild 只作为 CLI 被调用）
//
// 提供：断言语义、结果记录器、运行时解析（便携 Node / worker 脚本）、
// esbuild bundle（把 TS 真源码打成临时 ESM 供纯 Node import）、结果落盘。

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const __dirname = dirname(fileURLToPath(import.meta.url))
export const repoRoot = join(__dirname, '..')
export const tmpDir = join(__dirname, '.tmp')

// 插件 main 打包时 electron 会被 alias 到 .tmp/electron-stub.mjs；把它作为受版本管理的
// 源文件（test/electron-stub.mjs）在每次加载时补到 .tmp，避免临时目录被清理后全量验收失败。
try {
  const electronStubSrc = join(__dirname, 'electron-stub.mjs')
  const electronStubDest = join(tmpDir, 'electron-stub.mjs')
  if (!existsSync(electronStubDest) && existsSync(electronStubSrc)) {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(electronStubDest, readFileSync(electronStubSrc, 'utf8'))
  }
} catch {
  /* 补桩失败就让具体套件报错，不吞掉真正的问题 */
}

/**
 * 页面源码定位：`src/views/<rel>` ↔ `plugins/<id>/ui/<rel>`。
 * 返回**仓库相对路径**（与 `bundleEntry()` 的入参约定一致）。
 */
export function domainUiSrc(pluginId, relPath) {
  const migrated = join('plugins', pluginId, 'ui', relPath)
  if (existsSync(join(repoRoot, migrated))) return migrated
  return join('src', 'views', relPath)
}

/**
 * 域源码（main 侧）定位（D3）：`electron/main/<rel>` ↔ `plugins/<id>/main/<rel>`。
 *
 * 两个硬限制：
 *   1. 表达不了「新位置在一棵树、旧位置在另一棵树」（那两个候选里只有第二个是自由的）；
 *   2. 返回**绝对路径**，而 `bundleEntry()` 要仓库相对路径——直接传会拼成 `D:\repo\D:\repo\...`。
 *
 * 需要多候选回落，或需要仓库相对路径时，用 `anySrc()`。
 */
export function domainSrc(pluginId, relPath) {
  const migrated = join(repoRoot, 'plugins', pluginId, 'main', relPath)
  if (existsSync(migrated)) return migrated
  return join(repoRoot, 'electron', 'main', relPath)
}

/**
 * 多候选源码定位（PLAN-4.1-DEBT G7）：按顺序返回**第一个存在的仓库相对路径**。
 *
 * 为什么要有它：
 *   - `domainSrc()` 只能表达 `plugins/<id>/main/<rel>` ↔ `electron/main/<rel>` 这一对，
 *     表达不了「新位置在 services/、旧位置在某域」这种一对多回落；
 *   - `bundleEntry()` / `join(repoRoot, ...)` 收的是**仓库相对路径**，而 `domainSrc()` 返回绝对路径。
 *
 * 一个候选都不存在时返回第一个（让 esbuild/readFileSync 报出真实缺失路径，而不是静默取错）。
 */
/**
 * 域源码的仓库相对路径（WP3 搬家前后都可用）。
 *
 * 与 domainSrc() 的区别：domainSrc 返回**绝对路径**，而 bundleEntry/readFileSync(join(repoRoot,...))
 * 要**仓库相对路径**——两者混用会拼成 `D:\repo\D:\repo\...`（实测过）。
 *
 * 候选顺序：搬家后的 plugins/<id>/main/<rel> → 搬家前的 electron/main/<rel>。
 */
export function workSrc(rel) {
  return anySrc([`plugins/work/domain/${rel}`, `electron/main/work/${rel}`])
}

export function mkSrc(rel) {
  return anySrc([`plugins/marketing/domain/${rel}`, `electron/main/marketing/${rel}`])
}

export function anySrc(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('anySrc 需要非空候选数组')
  }
  for (const rel of candidates) {
    const abs = join(repoRoot, rel)
    // 只认文件：目录同名时 existsSync 也会为 true，会把「候选其实不存在」掩盖成
    // esbuild 的 "is a directory"，而不是回落到下一个候选。
    try {
      if (statSync(abs).isFile()) return rel
    } catch {
      /* 不存在就试下一个 */
    }
  }
  return candidates[0]
}

/**
 * 便携 Node 解析（生产同款优先）。
 *
 * 为什么需要写探针（2026-11-02 本机实测）：便携 Node 可能被下载/放置成**低完整性标签**
 * （`data/runtime/node-win32-x64/node.exe` 以 Low Mandatory Level 运行，只能写 Low IL 目录），
 * 而 `test/.tmp` 是 Medium —— 直接用它跑 db-worker 会报 `SQLITE_ERROR 14 unable to open database file`
 * （文件写探针则是 EPERM）。做法：探针失败时把便携 Node 复制到系统临时目录（继承 Medium）再用，
 * 保持与生产同样的 Node 版本；只有便携 Node 不存在（如 CI）才退回当前进程 Node。
 *
 * 可用 `UMI_ACCEPT_NODE` 显式覆盖。
 */
let resolvedNodeCache = null

export function resolveNodePath() {
  if (resolvedNodeCache) return resolvedNodeCache
  const override = process.env.UMI_ACCEPT_NODE
  if (override && existsSync(override)) {
    resolvedNodeCache = override
    return override
  }
  const platform = process.platform
  const arch = process.arch
  const name = platform === 'win32' ? 'node.exe' : join('bin', 'node')
  const portable = join(repoRoot, 'data', 'runtime', `node-${platform}-${arch}`, name)
  if (!existsSync(portable)) {
    resolvedNodeCache = process.execPath
    return resolvedNodeCache
  }
  if (canWriteFrom(portable)) {
    resolvedNodeCache = portable
    return resolvedNodeCache
  }
  resolvedNodeCache = copyPortableToTemp(portable) ?? process.execPath
  return resolvedNodeCache
}

/** 用便携 Node 自身写一个探针文件，判断它能否在 test/.tmp 落盘（低完整性标签会失败） */
function canWriteFrom(nodePath) {
  try {
    mkdirSync(tmpDir, { recursive: true })
    const probe = join(tmpDir, `.node-write-probe-${process.pid}`)
    const res = spawnSync(
      nodePath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1], 'ok')", probe],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    )
    const ok = res.status === 0 && existsSync(probe)
    try {
      rmSync(probe, { force: true })
    } catch {
      /* 探针清理失败不影响判断 */
    }
    return ok
  } catch {
    return false
  }
}

/** 复制便携 Node 到系统临时目录（脱离 Low IL 目录；复用同大小/时间的副本） */
function copyPortableToTemp(nodePath) {
  try {
    const info = statSync(nodePath)
    const key = `umi-accept-node-${info.size}-${Math.floor(info.mtimeMs)}`
    const dir = join(tmpdir(), key)
    // Windows 下必须保持文件名为 node.exe：db-client 的「单例/重启」断言按
    // Win32_Process Name='node.exe' + 命令行里的 db 路径来数进程；换文件名会让计数恒为 0
    // （2026-11-02 实测踩过）。
    const fileName = process.platform === 'win32' ? 'node.exe' : 'node'
    const dest = join(dir, fileName)

    // 已存在且大小一致 → 直接复用；大小不一致说明上次复制被中断，重建
    if (existsSync(dest) && statSync(dest).size === info.size) return dest

    mkdirSync(dir, { recursive: true })
    const partial = dest + '.incomplete'
    copyFileSync(nodePath, partial)
    if (statSync(partial).size !== info.size) {
      throw new Error('复制的 Node 大小与原文件不一致')
    }
    renameSync(partial, dest)
    if (process.platform !== 'win32') chmodSync(dest, 0o755)

    // 清理其它版本副本（只保留当前 key）：每个副本约 100MB，不清理会越积越多；
    // 失败（例如副本正被其它进程占用）不影响本次使用。
    try {
      for (const name of readdirSync(tmpdir())) {
        if (name.startsWith('umi-accept-node-') && name !== key) {
          rmSync(join(tmpdir(), name), { recursive: true, force: true })
        }
      }
    } catch {
      /* 清理失败忽略 */
    }
    console.log(
      `[accept] 便携 Node 在 test/.tmp 不可写（低完整性标签，SQLite/EPERM 会失败），` +
        `已复制到临时目录使用：${dest}`
    )
    return dest
  } catch (e) {
    console.log(`[accept] 复制便携 Node 到临时目录失败，回退当前进程 Node：${e?.message ?? e}`)
    return null
  }
}

export const workerScriptPath = join(repoRoot, 'resources', 'database', 'db-worker.mjs')

/**
 * 营销域专用 worker（11 表 schema：projects / businesses / knowledge_items / contents / hot_* …）。
 *
 * 4.0 合并（MERGE-INVENTORY R2）：work 与 marketing 是**两套互斥 schema**，只有 app_meta
 * 重叠，所以两域各带一个 worker 文件，而不是把两套 DDL 拼成一份白名单。
 * 插件化后这一步会收敛为「每插件一套 schema + 参数化 worker」。
 */
export const marketingWorkerScriptPath = join(repoRoot, 'resources', 'database', 'db-worker-marketing.mjs')

export function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message)
}

export function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`断言失败: ${message} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

export function assertDeepEq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`断言失败: ${message} — 期望 ${b}，实际 ${a}`)
}

/**
 * esbuild bundle 一个 TS 入口 → test/.tmp/<outName> 的 ESM，返回可 import 的绝对路径
 *
 * `options.externals`：需要**运行时**从 node_modules 解析的包（不 bundle）。
 * 适用场景：包里有「动态 require 内置模块」的写法（如 mammoth 的 `require('fs')`），
 * 被打进 ESM bundle 后会变成 `Dynamic require of "fs" is not supported`；
 * 把它们标成 external 后，由 Node 自己按 CJS 加载（生产构建是 CJS，不受影响）。
 * `options.alias`：把某个模块名换成另一个文件（esbuild `--alias:`）。
 * 适用场景：被测模块**顶层** `import { app } from 'electron'`（如 configManager），
 * 而纯 Node 解析 'electron' 得到的是「指向 exe 的字符串路径」，named import 会直接炸。
 * 在 electron 这个边界上打桩，被测逻辑本身仍然是真源码。
 */
export function bundleEntry(entryRelPath, outName, options = {}) {
  mkdirSync(tmpDir, { recursive: true })
  const outfile = join(tmpDir, outName)
  const bin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  if (!existsSync(bin)) {
    throw new Error(`未找到 esbuild CLI: ${bin}（应由 vite 依赖提供）`)
  }
  const externals = Array.isArray(options.externals) ? options.externals : []
  const alias = Array.isArray(options.alias) ? options.alias : []
  const res = spawnSync(
    bin,
    [
      join(repoRoot, entryRelPath),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      '--external:electron',
      ...externals.map((name) => `--external:${name}`),
      ...alias.map((entry) => `--alias:${entry}`),
      '--log-level=warning',
      `--outfile=${outfile}`
    ],
    { encoding: 'utf-8', shell: process.platform === 'win32', cwd: repoRoot }
  )
  if (res.status !== 0) {
    throw new Error(`esbuild 失败（${entryRelPath}）:\n${res.stdout || ''}${res.stderr || ''}`)
  }
  if (!existsSync(outfile)) throw new Error(`esbuild 未产出 ${outfile}`)
  return outfile
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

/**
 * 轮询等待条件成立（替代固定 sleep）。
 *
 * 固定 sleep 在并发/负载下会偶发假失败：被测代码在 `await stream.result` **之后**
 * 才落库，sleep 时长无法保证覆盖写入延迟。轮询到条件成立才继续。
 * 返回最后一次 fn 的返回值（真值）；超时抛错（带 label 便于定位）。
 */
export async function waitFor(fn, { timeout = 5000, interval = 25, label = '条件' } = {}) {
  const t0 = Date.now()
  let lastError = null
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
      lastError = null
    } catch (e) {
      // 瞬时错误（行尚未写入/恰好读不到）继续轮询；但保留最后一次错误用于超时诊断
      lastError = e
    }
    if (Date.now() - t0 >= timeout) {
      const detail = lastError ? `；最后一次错误：${lastError?.message ?? String(lastError)}` : ''
      throw new Error(`waitFor 超时（${timeout}ms）：${label}${detail}`)
    }
    await sleep(interval)
  }
}

/** 结果记录器：每个 check 独立捕获异常，绝不因单点失败中断整轮 */
export class Recorder {
  constructor(suite) {
    this.suite = suite
    this.checks = []
    this.t0 = Date.now()
  }

  async check(id, name, fn) {
    const started = Date.now()
    try {
      const detail = await fn()
      this.checks.push({
        id,
        name,
        ok: true,
        detail: detail === undefined || detail === null ? '' : String(detail),
        ms: Date.now() - started
      })
    } catch (e) {
      this.checks.push({
        id,
        name,
        ok: false,
        detail: (e && e.stack) || String(e),
        ms: Date.now() - started
      })
    }
  }

  /** 显式跳过：不计入 passed，但仍算已执行；验收汇总必须显示 SKIP，不能假装 PASS */
  skip(id, name, reason) {
    this.checks.push({
      id,
      name,
      ok: true,
      skipped: true,
      detail: `SKIPPED：${reason}`,
      ms: 0
    })
  }

  get passed() {
    return this.checks.filter((c) => c.ok && !c.skipped).length
  }

  get skipped() {
    return this.checks.filter((c) => c.skipped).length
  }

  get failed() {
    return this.checks.filter((c) => !c.ok).length
  }

  toJSON(extra = {}) {
    return {
      suite: this.suite,
      startedAt: new Date(this.t0).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.t0,
      total: this.checks.length,
      passed: this.passed,
      skipped: this.skipped,
      failed: this.failed,
      env: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        workerScript: workerScriptPath,
        runtimeNode: resolveNodePath()
      },
      ...extra,
      checks: this.checks
    }
  }
}

export function printResult(result) {
  console.log('')
  console.log(`===== ${result.suite} =====`)
  for (const c of result.checks) {
    const tag = c.skipped ? '[SKIP]' : c.ok ? '[PASS]' : '[FAIL]'
    console.log(`${tag} ${c.id} ${c.name}  (${c.ms}ms)`)
    if (!c.ok) {
      for (const line of String(c.detail).split('\n')) console.log('        ' + line)
    } else if (c.detail) {
      console.log('        -> ' + c.detail)
    }
  }
  console.log(
    `----- ${result.suite}: ${result.passed}/${result.total} 通过，跳过 ${result.skipped ?? 0}，失败 ${result.failed}，用时 ${result.durationMs}ms -----`
  )
  // total=0 不是绿：套件在注册断言前就抛异常时 failed 也是 0，
  // 只看 failed 会把「什么都没跑」判成通过（2026-11-02 实测 platform 假绿）。
  if (result.total === 0) {
    console.log('⚠️ 本套件没有任何断言（total=0）：判为失败，不允许「什么都没跑」算绿')
  }
  return result.failed === 0 && result.total > 0
}

export function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8')
}
