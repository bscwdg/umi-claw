/**
 * openClawConfigWriter 验收测试（node:test）。
 *
 * 覆盖：
 *   - buildJsonMergePatch：RFC 7396 最小补丁（相等→null、删键→null 值、嵌套删除、
 *     改值、数组整体替换/相等、新增、混合、真实场景剥离退役键）
 *   - summarizePatchError：从 CLI 输出挑出有效拒绝原因（装饰框线过滤）
 *
 * 运行：node --test test/openclaw-config-writer.accept.mjs
 * （被测 TS 由 build 脚本经 esbuild 打到 test/.tmp/openclaw-config-writer.mjs）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const bundled = join(repoRoot, 'test', '.tmp', 'openclaw-config-writer.mjs')

if (!existsSync(bundled)) {
  // 由 npm 脚本先 bundle；这里也兜底自构建一次。
  // Windows 下 .cmd 不能直接 execFile（EINVAL），必须 shell:true；*nix 直接走二进制。
  const esbuild = join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
  )
  execFileSync(esbuild, [
    join(repoRoot, 'electron', 'main', 'openClawConfigWriter.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=node20',
    `--outfile=${bundled}`
  ], { stdio: 'inherit', shell: process.platform === 'win32' })
}

const {
  buildJsonMergePatch,
  collectLossyIdArrayReplacePaths,
  summarizePatchError,
  isConfigRejectionOutput,
  applyOpenClawConfigPatch
} = await import(pathToFileURL(bundled).href)

test('完全相等（含嵌套/数组）→ null，触发无变更跳过', () => {
  const a = { a: 1, b: { c: 2, d: [1, 2], e: { f: 'x' } } }
  assert.equal(buildJsonMergePatch(a, structuredClone(a)), null)
})

test('删除键 → null 值保留', () => {
  assert.deepEqual(buildJsonMergePatch({ a: 1, b: 2 }, { a: 1 }), { b: null })
})

test('嵌套删除键 → 仅输出该 null，中间层不为空对象', () => {
  assert.deepEqual(
    buildJsonMergePatch(
      { meta: { x: 1, lastTouchedAt: 2 } },
      { meta: { x: 1 } }
    ),
    { meta: { lastTouchedAt: null } }
  )
})

test('深层删除不空转中间层', () => {
  assert.deepEqual(
    buildJsonMergePatch(
      { q: { w: { keep: 1, drop: 2 } } },
      { q: { w: { keep: 1 } } }
    ),
    { q: { w: { drop: null } } }
  )
})

test('改值 → 目标值', () => {
  assert.deepEqual(buildJsonMergePatch({ a: 1, b: 2 }, { a: 1, b: 9 }), { b: 9 })
})

test('数组不相等 → 整体替换', () => {
  assert.deepEqual(buildJsonMergePatch({ a: [1, 2] }, { a: [1, 2, 3] }), { a: [1, 2, 3] })
})

test('数组相等 → null', () => {
  assert.equal(buildJsonMergePatch({ a: [1, 2] }, { a: [1, 2] }), null)
})

test('删改混合 → 各自正确表达（与键顺序无关）', () => {
  assert.deepEqual(
    buildJsonMergePatch({ a: 1, b: 2, c: 3 }, { a: 1, b: 9 }),
    { b: 9, c: null }
  )
})

test('新增键', () => {
  assert.deepEqual(buildJsonMergePatch({ a: 1 }, { a: 1, b: 2 }), { b: 2 })
})

test('真实场景：只剥离 meta.lastTouchedAt，其余完全不动', () => {
  const real = {
    agents: { defaults: { model: { primary: 'm' } } },
    meta: { lastTouchedVersion: '2026.10.2', lastTouchedAt: 'X', migrations: { a: true } },
    plugins: { entries: { x: { enabled: true } } }
  }
  const clean = structuredClone(real)
  delete clean.meta.lastTouchedAt
  assert.deepEqual(buildJsonMergePatch(real, clean), { meta: { lastTouchedAt: null } })
})

test('null 删除 vs 值为 null 的标量：desired 缺键才删，显式 null 同语义', () => {
  // desired 里没有 x → 删除
  assert.deepEqual(buildJsonMergePatch({ x: 1 }, {}), { x: null })
})

test('summarizePatchError：剥掉 TQ 框线装饰，保留尾部有效信息', () => {
  const stdout = [
    'T OpenClaw config patch',
    '|',
    '+---',
    'Config validation failed: meta: Unrecognized key: "lastTouchedAt"',
    'Run "openclaw doctor --fix" to repair the config, then retry.',
    'o  '
  ].join('\n')
  const msg = summarizePatchError(stdout, '', 1)
  assert.match(msg, /exit 1/)
  assert.match(msg, /Unrecognized key/)
  assert.match(msg, /doctor --fix/)
  // 框线装饰行不应作为独立片段出现
  assert.doesNotMatch(msg, /[；|^]\|[；|]/)
})

test('summarizePatchError：无有效输出时给出稳定前缀', () => {
  const msg = summarizePatchError('', '', 1)
  assert.match(msg, /被官方校验拒绝/)
})

test('isConfigRejectionOutput：官方非法配置诊断面 → true（可走 doctor）', () => {
  assert.equal(
    isConfigRejectionOutput(
      'OpenClaw config is invalid\n- meta: Unrecognized key: "lastTouchedAt"\nRun "openclaw doctor --fix" to repair the config, then retry.',
      ''
    ),
    true,
    '官方 Invalid config + doctor 提示应归为配置拒绝'
  )
  assert.equal(isConfigRejectionOutput('', 'Error: Invalid config at /x/openclaw.json: ...'), true)
  assert.equal(isConfigRejectionOutput('', 'CONFIG_READ_FAILED'), true)
})

test('isConfigRejectionOutput：崩溃/无输出 → false（不触发 doctor）', () => {
  assert.equal(isConfigRejectionOutput('', ''), false, '空输出不能当作配置非法的证据')
  assert.equal(
    isConfigRejectionOutput('', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'),
    false,
    'OOM/崩溃不是配置非法'
  )
  assert.equal(isConfigRejectionOutput('', 'Error: spawn ENOENT'), false)
})

test('collectLossyIdArrayReplacePaths：模型数组会丢掉既有 id → 返回 replace 路径', () => {
  const original = {
    models: { providers: { deepseek: { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-flash' }] } } }
  }
  const desired = {
    models: { providers: { deepseek: { models: [{ id: 'deepseek-flash' }] } } }
  }
  assert.deepEqual(collectLossyIdArrayReplacePaths(original, desired), [
    'models.providers.deepseek.models'
  ])
})

test('collectLossyIdArrayReplacePaths：只新增/同集 → 空（不传 --replace-path，兼容老版本 CLI）', () => {
  const original = { models: { providers: { p: { models: [{ id: 'a' }] } } } }
  const grown = { models: { providers: { p: { models: [{ id: 'a' }, { id: 'b' }] } } } }
  assert.deepEqual(collectLossyIdArrayReplacePaths(original, grown), [])
  // 仅条目参数变化（id 集合不变）也不算移除
  const retuned = { models: { providers: { p: { models: [{ id: 'a', contextWindow: 999 }] } } } }
  assert.deepEqual(collectLossyIdArrayReplacePaths(original, retuned), [])
})

test('collectLossyIdArrayReplacePaths：原配置缺该数组/非按 id 数组 → 空', () => {
  const original = { models: { providers: { p: {} } } }
  const desired = { models: { providers: { p: { models: [{ id: 'a' }] } } } }
  assert.deepEqual(collectLossyIdArrayReplacePaths(original, desired), [])
  // 字符串数组、缺 id 的数组不在官方「按 id 数组」校验面内
  assert.deepEqual(
    collectLossyIdArrayReplacePaths(
      { agents: { defaults: { modelPolicy: { allow: ['x/*', 'y/*'] } } } },
      { agents: { defaults: { modelPolicy: { allow: ['x/*'] } } } }
    ),
    []
  )
  assert.deepEqual(
    collectLossyIdArrayReplacePaths(
      { models: { providers: { p: { models: [{ name: '无 id' }, { id: 'a' }] } } } },
      { models: { providers: { p: { models: [{ id: 'a' }] } } } }
    ),
    []
  )
})

test('collectLossyIdArrayReplacePaths：含点号的 provider 键走括号形式（可被官方路径解析回原键）', () => {
  const original = { models: { providers: { 'a.b': { models: [{ id: 'm1' }, { id: 'm2' }] } } } }
  const desired = { models: { providers: { 'a.b': { models: [{ id: 'm1' }] } } } }
  assert.deepEqual(collectLossyIdArrayReplacePaths(original, desired), ['models.providers["a.b"].models'])
})

test('applyOpenClawConfigPatch：运行时未安装 → 立即 ok:false，不 spawn', async () => {
  // 用一个空的临时 dataDir：node.exe / clawJs 均不存在，应命中 early-return，
  // 不去 spawn 不存在的二进制（否则会抛 ENOENT）。
  const emptyDir = mkdtempSync(join(tmpdir(), 'ocw-no-runtime-'))
  const res = await applyOpenClawConfigPatch(emptyDir, { a: 1 })
  assert.equal(res.ok, false)
  assert.match(res.error || '', /运行时未安装/)
})

test('applyOpenClawConfigPatch：同一 dataDir 并发补丁串行执行，不交错', async () => {
  // 两个补丁同时提交：serializePatch 必须排队（第二个等第一个 settle 后才开始），
  // 最终两个都各自得到结果而不是互相抢锁/丢失。运行时缺失时两者都会走 early-return，
  // 但仍能验证「并发调用都能 resolve、且结果一致」这一串行化契约不挂死、不reject。
  const emptyDir = mkdtempSync(join(tmpdir(), 'ocw-serialize-'))
  const [r1, r2] = await Promise.all([
    applyOpenClawConfigPatch(emptyDir, { x: 1 }),
    applyOpenClawConfigPatch(emptyDir, { y: 2 })
  ])
  assert.equal(r1.ok, false)
  assert.equal(r2.ok, false)
  assert.match(r1.error || '', /运行时未安装/)
  assert.match(r2.error || '', /运行时未安装/)
})
