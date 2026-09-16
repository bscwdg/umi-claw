// test/_lib.mjs —— 验收脚本共享工具（零 npm 依赖；esbuild 只作为 CLI 被调用）
//
// 提供：断言语义、结果记录器、运行时解析（便携 Node / worker 脚本）、
// esbuild bundle（把 TS 真源码打成临时 ESM 供纯 Node import）、结果落盘。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const __dirname = dirname(fileURLToPath(import.meta.url))
export const repoRoot = join(__dirname, '..')
export const tmpDir = join(__dirname, '.tmp')

/** 便携 Node（data/runtime/node-<platform>-<arch>）优先，缺失时回退当前 node */
export function resolveNodePath() {
  const platform = process.platform
  const arch = process.arch
  const name = platform === 'win32' ? 'node.exe' : join('bin', 'node')
  const portable = join(repoRoot, 'data', 'runtime', `node-${platform}-${arch}`, name)
  return existsSync(portable) ? portable : process.execPath
}

export const workerScriptPath = join(repoRoot, 'resources', 'database', 'db-worker.mjs')

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
 */
export function bundleEntry(entryRelPath, outName, options = {}) {
  mkdirSync(tmpDir, { recursive: true })
  const outfile = join(tmpDir, outName)
  const bin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  if (!existsSync(bin)) {
    throw new Error(`未找到 esbuild CLI: ${bin}（应由 vite 依赖提供）`)
  }
  const externals = Array.isArray(options.externals) ? options.externals : []
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
