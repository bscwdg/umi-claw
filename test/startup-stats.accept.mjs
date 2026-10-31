/**
 * startupStats 验收测试（node:test）
 *
 * 覆盖 4.0 启动 ETA 采样规则（含 91e3b0b 的修正确则）：
 *   - normalize/append：只保留正数毫秒，最多 5 次
 *   - medianOf：奇偶/空数组
 *   - estimateStartupMs：0 次→undefined；≤2 次用**最近一次**；≥3 次取最近 3 次中位数
 *   - parse/serialize：坏 JSON 当空、落盘格式可往返
 *
 * 运行：node --test test/startup-stats.accept.mjs
 * （被测 TS 由 build 脚本经 esbuild 打到 test/.tmp/startup-stats.mjs）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const bundled = join(repoRoot, 'test', '.tmp', 'startup-stats.mjs')

if (!existsSync(bundled)) {
  const esbuild = join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
  )
  execFileSync(
    esbuild,
    [
      join(repoRoot, 'electron', 'main', 'startupStats.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      `--outfile=${bundled}`
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  )
}

const {
  MAX_STARTUP_SAMPLES,
  normalizeStartupDurations,
  appendStartupDuration,
  medianOf,
  estimateStartupMs,
  parseStartupStats,
  serializeStartupStats
} = await import(pathToFileURL(bundled).href)

test('normalize：过滤非正数/非数字，只留最近 5 次', () => {
  assert.equal(MAX_STARTUP_SAMPLES, 5)
  assert.deepEqual(normalizeStartupDurations([1000, 0, -5, 'abc', 2000, null]), [1000, 2000])
  assert.deepEqual(normalizeStartupDurations([1, 2, 3, 4, 5, 6, 7]), [3, 4, 5, 6, 7])
  // 落盘格式 {version, durations}
  assert.deepEqual(normalizeStartupDurations({ version: 1, durations: [1200, '800'] }), [1200, 800])
  assert.deepEqual(normalizeStartupDurations(null), [])
  assert.deepEqual(normalizeStartupDurations('nope'), [])
})

test('append：追加并保留最近 5 次；非法耗时忽略', () => {
  assert.deepEqual(appendStartupDuration([1000, 2000], 3000), [1000, 2000, 3000])
  assert.deepEqual(appendStartupDuration([1, 2, 3, 4, 5], 6), [2, 3, 4, 5, 6])
  assert.deepEqual(appendStartupDuration([1000], 0), [1000])
  assert.deepEqual(appendStartupDuration([1000], Number.NaN), [1000])
  assert.deepEqual(appendStartupDuration([1000], 1500.6), [1000, 1501])
})

test('medianOf：奇数取中位、偶数取中间两数平均并取整、空为 undefined', () => {
  assert.equal(medianOf([]), undefined)
  assert.equal(medianOf([3000]), 3000)
  assert.equal(medianOf([5000, 1000, 3000]), 3000)
  assert.equal(medianOf([1000, 2000]), 1500)
  assert.equal(medianOf([1000, 2001]), 1501)
})

test('estimate：无历史 → undefined', () => {
  assert.equal(estimateStartupMs([]), undefined)
  assert.equal(estimateStartupMs([0, -1]), undefined)
})

test('estimate：≤2 次用最近一次（避免一次性异常值带偏）', () => {
  assert.equal(estimateStartupMs([42_000]), 42_000)
  // 91e3b0b 修正点：两次时不再取中位数，直接取最近一次
  assert.equal(estimateStartupMs([300_000, 60_000]), 60_000)
})

test('estimate：≥3 次取最近 3 次中位数（忽略更早样本）', () => {
  assert.equal(estimateStartupMs([5000, 1000, 3000]), 3000)
  // 更早的 999999 不参与（窗口只看最近 3 次）
  assert.equal(estimateStartupMs([999_999, 5000, 1000, 3000]), 3000)
  // 5 次：窗口 = 最近 3 次 [1000, 2000, 60_000] → 中位数 2000
  assert.equal(estimateStartupMs([8000, 9000, 1000, 2000, 60_000]), 2000)
})

test('estimate：窗口内偶数个时取平均（最近 3 次固定奇数，不触发）', () => {
  // 仅保留最近 3 次的规则下，3 个样本的中位数就是中间值
  assert.equal(estimateStartupMs([2000, 4000, 3000]), 3000)
})

test('parse：坏 JSON / 空 → []，合法对象 → 数组', () => {
  assert.deepEqual(parseStartupStats(null), [])
  assert.deepEqual(parseStartupStats(''), [])
  assert.deepEqual(parseStartupStats('{oops'), [])
  assert.deepEqual(parseStartupStats('{"version":1,"durations":[1200,800]}'), [1200, 800])
})

test('serialize/parse 往返一致，且带 version 与结尾换行', () => {
  const text = serializeStartupStats([1200, 800])
  assert.match(text, /"version": 1/)
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(parseStartupStats(text), [1200, 800])
  // 序列化也会裁剪到最近 5 次
  assert.deepEqual(parseStartupStats(serializeStartupStats([1, 2, 3, 4, 5, 6])), [2, 3, 4, 5, 6])
})
