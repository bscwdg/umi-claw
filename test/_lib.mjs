// test/_lib.mjs —— 验收脚本共享工具（零 npm 依赖；esbuild 只作为 CLI 被调用）
//
// 提供：断言语义、结果记录器、运行时解析（便携 Node / worker 脚本）、
// esbuild bundle（把 TS 真源码打成临时 ESM 供纯 Node import）、结果落盘。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

/** 便携 Node（data/runtime/node-<platform>-<arch>）优先，缺失时回退当前 node */
export function resolveNodePath() {
  const platform = process.platform
  const arch = process.arch
  const name = platform === 'win32' ? 'node.exe' : join('bin', 'node')
  const portable = join(repoRoot, 'data', 'runtime', `node-${platform}-${arch}`, name)
  return existsSync(portable) ? portable : process.execPath
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
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      // 瞬时错误（如行尚未写入导致的读取异常）不应中断轮询
    }
    if (Date.now() - t0 >= timeout) throw new Error(`waitFor 超时（${timeout}ms）：${label}`)
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

  get passed() {
    return this.checks.filter((c) => c.ok).length
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
    console.log(`${c.ok ? '[PASS]' : '[FAIL]'} ${c.id} ${c.name}  (${c.ms}ms)`)
    if (!c.ok) {
      for (const line of String(c.detail).split('\n')) console.log('        ' + line)
    } else if (c.detail) {
      console.log('        -> ' + c.detail)
    }
  }
  console.log(
    `----- ${result.suite}: ${result.passed}/${result.total} 通过，失败 ${result.failed}，用时 ${result.durationMs}ms -----`
  )
  return result.failed === 0
}

export function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8')
}
