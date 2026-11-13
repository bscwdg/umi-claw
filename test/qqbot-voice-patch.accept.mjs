// test/qqbot-voice-patch.accept.mjs —— openclaw-qqbot 语音本地路径热修验收
//
// 打真源码：bundle electron/main/claw/qqVoicePatch.ts（纯 Node，无 electron 依赖），
// 在临时 data 目录里搭出 npm/projects 的真实目录树，覆盖：
//   Q1 未补丁基线确实把盘符路径误判成 base64（证明测试咬住真实 bug）
//   Q2 首次补丁：计数/标记/备份
//   Q3 补丁后全部分支行为（盘符/UNC/local/data/http/base64/~ 历史差异）
//   Q4 幂等：重复执行零写入
//   Q5 锚点不匹配：unsupported 且原文件不动
//   Q5b v1 锚点失配与 v2 对称处理
//   Q6 无插件目录：零目标不抛错
//   Q7 多副本（重装产生多个 project hash）全部命中
//   Q8 dist 缺失副本被跳过，不影响其他副本
//   Q9 历史 patch-tmp 残留补丁前回收，本轮临时文件不留存
//   Q10 备份同名被目录占用：换时间戳名仍留回退底
//
// 用法：node test/qqbot-voice-patch.accept.mjs（npm run accept:qqbot-voice-patch）

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, assert, assertEq, assertDeepEq, bundleEntry, printResult, tmpDir, writeJson } from './_lib.mjs'

const suite = 'QQ 语音本地路径热修（幂等锚点补丁）'
const rec = new Recorder(suite)

const runDir = join(tmpDir, `qqbot-voice-patch-${Date.now()}-${process.pid}`)
mkdirSync(runDir, { recursive: true })

// 与上游 2.0.4 dist/index.cjs 中两个解析函数逐字一致的最小可执行模块
const ORIGINAL_CJS = `function resolveVoiceSource(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return { url: source };
  }
  if (source.startsWith("data:") || !source.startsWith("/") && !source.startsWith("./") && !source.startsWith("../") && !source.startsWith("~")) {
    const commaIdx = source.indexOf(",");
    return { base64: commaIdx > 0 ? source.slice(commaIdx + 1) : source };
  }
  return { localPath: source };
}
function resolveVoiceSource2(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) return { url: source };
  if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) return { localPath: source };
  if (source.startsWith("data:")) {
    const i = source.indexOf(",");
    return { base64: i > 0 ? source.slice(i + 1) : source };
  }
  return { base64: source };
}
module.exports = { resolveVoiceSource, resolveVoiceSource2 };
`

const PKG_NAME = '@tencent-connect/openclaw-qqbot'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function pluginTree(dataRoot, projectHash, options = {}) {
  const { version = '2.0.4', cjs = ORIGINAL_CJS, includeDist = true } = options
  const pluginDir = join(
    dataRoot,
    'config',
    '.openclaw',
    'npm',
    'projects',
    projectHash,
    'node_modules',
    '@tencent-connect',
    'openclaw-qqbot'
  )
  mkdirSync(join(pluginDir, 'dist'), { recursive: true })
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: PKG_NAME, version }, null, 2)
  )
  const distFile = join(pluginDir, 'dist', 'index.cjs')
  if (includeDist) writeFileSync(distFile, cjs)
  return { pluginDir, distFile }
}

const bundled = bundleEntry('electron/main/claw/qqVoicePatch.ts', 'qqbot-voice-patch.mjs')
const { ensureQqBotVoicePatch } = await import(pathToFileURL(bundled).href)
const silentLog = () => {}

// ── Q1 未补丁基线：盘符路径被误判成 base64 ────────────────────────────────────
await rec.check('Q1', '未补丁基线复现上游 bug：盘符路径落进 base64 分支', async () => {
  const baselineRoot = join(runDir, 'q1-baseline')
  const { distFile } = pluginTree(baselineRoot, 'hash-baseline')
  const mod = await import(pathToFileURL(distFile).href)
  const drive = String.raw`D:\work2026\data\voice\a.wav`
  assertDeepEq(mod.resolveVoiceSource(drive), { base64: drive }, 'v1 必须复现误判，否则 fixture 没咬住 bug')
  assertDeepEq(mod.resolveVoiceSource2(drive), { base64: drive }, 'v2 同样误判')
  return '基线 bug 复现成立'
})

// ── Q2 首次补丁：计数 / 标记 / 备份 ───────────────────────────────────────────
const workRoot = join(runDir, 'q2-work')
const target = pluginTree(workRoot, 'tencent-connect-openclaw-qqbot-a7ec020d86')
const originalText = readFileSync(target.distFile, 'utf8')
const originalHash = sha256(originalText)

await rec.check('Q2', '首次执行：patched=1，写入标记并留存原始备份', async () => {
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, workRoot)
  assertEq(summary.scanned, 1, '扫描到 1 个副本')
  assertEq(summary.patched, 1, '本轮补丁 1 个')
  assertEq(summary.alreadyPatched, 0, '无已补丁副本')
  const patchedText = readFileSync(target.distFile, 'utf8')
  const markerCount = (patchedText.match(/isWindowsLocalVoicePath/g) || []).length
  assertEq(markerCount, 3, '1 处声明 + 2 处调用')
  const backup = join(target.pluginDir, 'dist', 'index.cjs.orig-2.0.4')
  assert(existsSync(backup), '同目录留存 .orig-2.0.4 备份')
  assertEq(sha256(readFileSync(backup, 'utf8')), originalHash, '备份与原文件逐字节一致')
  return '补丁与备份落地'
})

// ── Q3 补丁后全部分支行为 ─────────────────────────────────────────────────────
await rec.check('Q3', '补丁后：盘符/UNC 走 localPath，其余分支与上游行为一致', async () => {
  const mod = await import(pathToFileURL(target.distFile).href)
  const driveBackslash = String.raw`D:\work2026\files\claw-desktop\data\voice\a.wav`
  const driveSlash = 'D:/tmp/a.wav'
  const unc = String.raw`\\srv\share\a.wav`
  const cases = [
    [driveBackslash, 'localPath', driveBackslash],
    [driveSlash, 'localPath', driveSlash],
    [unc, 'localPath', unc],
    ['/tmp/a.wav', 'localPath', '/tmp/a.wav'],
    ['./a.wav', 'localPath', './a.wav'],
    ['data:audio/wav;base64,QUJDRA==', 'base64', 'QUJDRA=='],
    ['https://example.com/a.wav', 'url', 'https://example.com/a.wav'],
    ['QUJDRA==', 'base64', 'QUJDRA==']
  ]
  for (const [input, key, value] of cases) {
    assertDeepEq(mod.resolveVoiceSource(input), { [key]: value }, `v1 分支 ${input}`)
    assertDeepEq(mod.resolveVoiceSource2(input), { [key]: value }, `v2 分支 ${input}`)
  }
  // ~ 的历史差异刻意保留：v1 当本地路径，v2 当 base64
  assertDeepEq(mod.resolveVoiceSource('~/x/a.wav'), { localPath: '~/x/a.wav' }, 'v1 的 ~ 保持 localPath')
  assertDeepEq(mod.resolveVoiceSource2('~/x/a.wav'), { base64: '~/x/a.wav' }, 'v2 的 ~ 保持 base64')
  // 对抗审查 P1-2 登记的已知边界：这些形态生产链路不可达（resolveMediaPath 前置
  // realpath 已把路径绝对化），且 file:// 必须转 URL 对象才能 readFile，硬判 localPath
  // 只会把上传 500 换成 ENOENT。这里用 characterization 断言锁住上游现状，防回归误改。
  const edgeInputs = [
    'file:///D:/tmp/a.wav',
    String.raw`.\voice\a.wav`,
    String.raw`..\a.wav`,
    'D:foo.wav'
  ]
  for (const input of edgeInputs) {
    assertDeepEq(mod.resolveVoiceSource(input), { base64: input }, `v1 边界登记 ${input}`)
    assertDeepEq(mod.resolveVoiceSource2(input), { base64: input }, `v2 边界登记 ${input}`)
  }
  return '分支行为与登记边界全部符合预期'
})

// ── Q4 幂等：重复执行零写入 ───────────────────────────────────────────────────
await rec.check('Q4', '再次执行：already-patched，dist 与备份均不变', async () => {
  const beforeRerun = sha256(readFileSync(target.distFile, 'utf8'))
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, workRoot)
  assertEq(summary.patched, 0, '本轮无新补丁')
  assertEq(summary.alreadyPatched, 1, '识别为已补丁')
  assertEq(sha256(readFileSync(target.distFile, 'utf8')), beforeRerun, 'dist 二次执行前后逐字节不变（非自比）')
  const backup = join(target.pluginDir, 'dist', 'index.cjs.orig-2.0.4')
  assertEq(sha256(readFileSync(backup, 'utf8')), originalHash, '备份不被覆盖')
  return '幂等成立'
})

// ── Q5 锚点不匹配：unsupported 且不动文件 ─────────────────────────────────────
await rec.check('Q5', '上游改了锚点：unsupported，原文件与目录保持不动', async () => {
  const unknownRoot = join(runDir, 'q5-unknown')
  const mutated = ORIGINAL_CJS.replace(
    'function resolveVoiceSource2(source) {',
    'function resolveVoiceSource2(source, extra) {'
  )
  const unknown = pluginTree(unknownRoot, 'hash-unknown', { version: '9.9.9', cjs: mutated })
  const beforeHash = sha256(readFileSync(unknown.distFile, 'utf8'))
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, unknownRoot)
  assertEq(summary.unsupported, 1, '记一次 unsupported')
  assertEq(summary.patched, 0, '不写入补丁')
  assertEq(sha256(readFileSync(unknown.distFile, 'utf8')), beforeHash, 'dist 逐字节不变')
  assert(!existsSync(join(unknown.pluginDir, 'dist', 'index.cjs.orig-9.9.9')), '不产生备份')
  assert(!readFileSync(unknown.distFile, 'utf8').includes('isWindowsLocalVoicePath'), '不留补丁标记')
  return '未知版本安全跳过'
})

// ── Q5b v1 锚点失配：与 v2 对称的独立变异，确认任一锚点漂移都安全跳过 ────────────
await rec.check('Q5b', 'v1 锚点被上游改动：同样 unsupported 且原文件不动', async () => {
  const v1Root = join(runDir, 'q5b-v1-unknown')
  const mutatedV1 = ORIGINAL_CJS.replace(
    'function resolveVoiceSource(source) {',
    'function resolveVoiceSource(source, extra) {'
  )
  const v1Unknown = pluginTree(v1Root, 'hash-v1-unknown', { version: '9.9.8', cjs: mutatedV1 })
  const beforeHash = sha256(readFileSync(v1Unknown.distFile, 'utf8'))
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, v1Root)
  assertEq(summary.unsupported, 1, 'v1 锚点失配记 unsupported')
  assertEq(summary.patched, 0, '不写入补丁')
  assertEq(sha256(readFileSync(v1Unknown.distFile, 'utf8')), beforeHash, 'dist 逐字节不变')
  return 'v1/v2 锚点失配处理对称'
})

// ── Q6 无 projects 目录：零目标不抛错 ─────────────────────────────────────────
await rec.check('Q6', '数据目录下没有 npm/projects：全零返回、不抛异常', async () => {
  const emptyRoot = join(runDir, 'q6-empty')
  mkdirSync(emptyRoot, { recursive: true })
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, emptyRoot)
  assertDeepEq(
    { scanned: summary.scanned, patched: summary.patched, errors: summary.errors },
    { scanned: 0, patched: 0, errors: 0 },
    '空环境零目标零错误'
  )
  return '空环境安全'
})

// ── Q7 多副本：重装产生多个 project hash 全部命中 ──────────────────────────────
await rec.check('Q7', '两个 project hash 目录：两个副本都被补丁', async () => {
  const multiRoot = join(runDir, 'q7-multi')
  const a = pluginTree(multiRoot, 'tencent-connect-openclaw-qqbot-aaaa1111')
  const b = pluginTree(multiRoot, 'tencent-connect-openclaw-qqbot-bbbb2222')
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, multiRoot)
  assertEq(summary.scanned, 2, '扫到两个副本')
  assertEq(summary.patched, 2, '两个都补丁')
  for (const item of [a, b]) {
    assert(readFileSync(item.distFile, 'utf8').includes('isWindowsLocalVoicePath'), `${item.distFile} 已补丁`)
  }
  return '重装场景全覆盖'
})

// ── Q8 dist 缺失副本被跳过，不拖累正常副本 ────────────────────────────────────
await rec.check('Q8', '残缺副本（无 dist）跳过：正常副本照常补丁、不记错误', async () => {
  const mixedRoot = join(runDir, 'q8-mixed')
  pluginTree(mixedRoot, 'hash-broken', { includeDist: false })
  const good = pluginTree(mixedRoot, 'hash-good')
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, mixedRoot)
  // scanned 口径：只统计 dist 完整、通过 package.json 校验的合格副本，残缺者在扫描期过滤
  assertEq(summary.scanned, 1, '只统计 dist 完整的副本')
  assertEq(summary.patched, 1, '正常副本补丁成功')
  assertEq(summary.errors, 0, '残缺副本静默跳过不记错误')
  assert(readFileSync(good.distFile, 'utf8').includes('isWindowsLocalVoicePath'), '正常副本已补丁')
  return 'fail-open 成立'
})

// ── Q9 历史 patch-tmp 残留：补丁前回收，本轮临时文件 rename 后不留存 ─────────────
await rec.check('Q9', 'dist 内 patch-tmp 残留先清理：不阻断本轮补丁且不产生新残留', async () => {
  const staleRoot = join(runDir, 'q9-stale')
  const staleTarget = pluginTree(staleRoot, 'hash-stale')
  const staleFile = join(staleTarget.pluginDir, 'dist', 'index.cjs.patch-tmp-4242')
  writeFileSync(staleFile, 'leftover-from-crashed-run')
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, staleRoot)
  assertEq(summary.patched, 1, '残留不影响正常补丁')
  assert(!existsSync(staleFile), '历史 patch-tmp 残留已清理')
  assert(
    !existsSync(join(staleTarget.pluginDir, 'dist', `index.cjs.patch-tmp-${process.pid}`)),
    '本轮 tmp 已原子 rename，不留存'
  )
  return '临时文件回收成立'
})

// ── Q10 备份同名被非文件占用：时间戳兜底名，回退底不丢 ─────────────────────────
await rec.check('Q10', 'index.cjs.orig-<ver> 同名是目录：换时间戳名备份且补丁照常', async () => {
  const occRoot = join(runDir, 'q10-occupied')
  const occ = pluginTree(occRoot, 'hash-occupied')
  const occupiedName = join(occ.pluginDir, 'dist', 'index.cjs.orig-2.0.4')
  mkdirSync(occupiedName, { recursive: true })
  const summary = await ensureQqBotVoicePatch({ log: silentLog }, occRoot)
  assertEq(summary.patched, 1, '备份名被占用不阻断补丁')
  const distNames = readdirSync(join(occ.pluginDir, 'dist'))
  assert(existsSync(occupiedName), '被占用的同名目录原样保留，未被删除或覆盖')
  const timestampBackups = distNames.filter(
    (name) => name.startsWith('index.cjs.orig-2.0.4-')
  )
  assertEq(timestampBackups.length, 1, '另产生一个带时间戳的备份文件')
  assertEq(
    sha256(readFileSync(join(occ.pluginDir, 'dist', timestampBackups[0]), 'utf8')),
    sha256(ORIGINAL_CJS),
    '时间戳备份内容与原始 dist 逐字节一致'
  )
  return '备份名冲突安全兜底'
})
// ── 清理与结果 ─────────────────────────────────────────────────────────────────
rmSync(runDir, { recursive: true, force: true })

const result = rec.toJSON({ entry: [bundled] })
writeJson(join(process.cwd(), 'test', 'accept-result-qqbot-voice-patch.json'), result)
const ok = printResult(result)
process.exit(ok ? 0 : 1)
