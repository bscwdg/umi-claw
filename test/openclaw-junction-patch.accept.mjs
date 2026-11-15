// test/openclaw-junction-patch.accept.mjs —— OpenClaw 插件依赖 junction 自检热修验收
//
// 打真源码：bundle electron/main/claw/openclawJunctionPatch.ts（纯 Node，无 electron 依赖），
// 在临时 data 目录里搭出 openclaw 核心 dist 树，覆盖：
//   J1 核心未安装：零目标不抛错
//   J2 首次补丁：锚点替换 / 备份 / 自检
//   J3 幂等：重复执行零写入，备份不被覆盖
//   J4 锚点不匹配：unsupported 且原文件不动
//   J5 多 hash 文件全部命中；已有备份不覆盖
//   J6 锚点重复出现：按未知版本处理，不改文件
//   J7 静态接线：clawManager 在 spawn 网关之前调用补丁
//   J8 更新/doctor 链路接线：downloadManager 与 doctor 前都调用
//   J9 已补丁但缺备份：识别 already-patched 并提示不可回退
//   J10 新旧锚点并存（部分补丁）：按未知版本处理，不改文件
//   J11 dist 不可读（是文件）：记 error，不静默跳过
//   J12 补丁后同步 dist/postinstall-content-inventory.json 的 sha256/size
//
// 用法：node test/openclaw-junction-patch.accept.mjs（npm run accept:openclaw-junction-patch）

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, assert, assertEq, bundleEntry, printResult, tmpDir, writeJson } from './_lib.mjs'

const suite = 'OpenClaw 插件依赖 junction 自检热修（幂等锚点补丁）'
const rec = new Recorder(suite)

const runDir = join(tmpDir, `openclaw-junction-patch-${Date.now()}-${process.pid}`)
mkdirSync(runDir, { recursive: true })

// 与上游 dist 逐字一致的「依赖链接自检」行（双引号、反引号模板都保留）。
const ORIGINAL_VERIFY =
  'if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target)) throw new Error(`Dependency link does not resolve to its captured target: ${link}`);'
const PATCHED_VERIFY =
  'if (process.platform === "win32" ? (fs.realpathSync.native(link) !== fs.realpathSync.native(target)) : (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target))) throw new Error(`Dependency link does not resolve to its captured target: ${link}`);'

function artifactSource(verifyLine) {
  return [
    'function linkPluginGenerationDependency(link, target) {',
    '  const entry = fs.lstatSync(link, { throwIfNoEntry: false });',
    '  if (entry && !entry.isSymbolicLink()) return false;',
    '  fs.symlinkSync(target, link, "junction");',
    '  ' + verifyLine,
    '  return true;',
    '}',
    ''
  ].join('\n')
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function coreDist(dataRoot) {
  const dist = join(dataRoot, 'openclaw', 'node_modules', 'openclaw', 'dist')
  mkdirSync(dist, { recursive: true })
  return dist
}

const bundled = bundleEntry(
  'electron/main/claw/openclawJunctionPatch.ts',
  'openclaw-junction-patch.mjs'
)
const { ensureOpenClawJunctionPatch, emptyOpenClawJunctionPatchSummary } = await import(
  pathToFileURL(bundled).href
)
const silentLog = () => {}

// ── J1 核心未安装：零目标，不抛错 ─────────────────────────────────────────────
await rec.check('J1', 'openclaw 核心未安装：scanned=0 且不抛错', async () => {
  const root = join(runDir, 'j1-missing')
  mkdirSync(root, { recursive: true })
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.scanned, 0, '没有核心 dist 时不扫描任何文件')
  assertEq(summary.errors, 0, '缺失核心不算错误')
  assertEq(summary.results.length, 0, '无结果项')
  return '缺失核心安全返回'
})

// ── J2 首次补丁：替换 / 备份 / 自检 ───────────────────────────────────────────
const workRoot = join(runDir, 'j2-work')
const workDist = coreDist(workRoot)
const workFile = join(workDist, 'plugin-generation-artifact-D-V41Nc0.mjs')
const originalText = artifactSource(ORIGINAL_VERIFY)
writeFileSync(workFile, originalText)
const originalHash = sha256(originalText)

await rec.check('J2', '首次执行：patched=1，锚点替换并留存原始备份', async () => {
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, workRoot)
  assertEq(summary.scanned, 1, '扫描到 1 个抓取产物')
  assertEq(summary.patched, 1, '本轮补丁 1 个')
  assertEq(summary.alreadyPatched, 0, '无已补丁副本')
  const patchedText = readFileSync(workFile, 'utf8')
  assert(patchedText.includes(PATCHED_VERIFY), '写入 Windows native realpath 判断')
  assert(!patchedText.includes(ORIGINAL_VERIFY), '旧锚点已消失')
  const backup = join(workRoot, 'openclaw', '.umi-patch-backups', 'plugin-generation-artifact-D-V41Nc0.mjs.umi-orig')
  assert(existsSync(backup), '备份放在 dist 外的 .umi-patch-backups/')
  assert(!existsSync(workFile + '.umi-orig'), 'dist 内不留 .umi-orig（避免污染内容清单）')
  assertEq(sha256(readFileSync(backup, 'utf8')), originalHash, '备份与原文件逐字节一致')
  return '补丁与备份落地'
})

// ── J3 幂等：重复执行零写入 ───────────────────────────────────────────────────
const patchedHash = sha256(readFileSync(workFile, 'utf8'))

await rec.check('J3', '重复执行：already-patched，文件与备份都不再变化', async () => {
  const backupPath = join(
    workRoot,
    'openclaw',
    '.umi-patch-backups',
    'plugin-generation-artifact-D-V41Nc0.mjs.umi-orig'
  )
  const beforeBackupHash = sha256(readFileSync(backupPath, 'utf8'))
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, workRoot)
  assertEq(summary.patched, 0, '不重复补丁')
  assertEq(summary.alreadyPatched, 1, '识别为已补丁')
  assertEq(sha256(readFileSync(workFile, 'utf8')), patchedHash, 'dist 内容不变')
  assertEq(sha256(readFileSync(backupPath, 'utf8')), beforeBackupHash, '备份不被覆盖')
  return '幂等成立'
})

// ── J4 锚点不匹配：原文件不动 ─────────────────────────────────────────────────
await rec.check('J4', '上游改代码（锚点缺失）：unsupported 且原文件逐字节不动', async () => {
  const root = join(runDir, 'j4-unsupported')
  const dist = coreDist(root)
  const file = join(dist, 'plugin-generation-artifact-aaaa1111.mjs')
  const text = 'function linkPluginGenerationDependency(link, target) { return true; }\n'
  writeFileSync(file, text)
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.unsupported, 1, '未知版本标记 unsupported')
  assertEq(summary.patched, 0, '不改未知版本')
  assertEq(readFileSync(file, 'utf8'), text, '文件内容不变')
  assert(!existsSync(file + '.umi-orig'), '不产生备份')
  return '未知版本保持原样'
})

// ── J5 多 hash 文件全部命中；已有备份不覆盖 ───────────────────────────────────
await rec.check('J5', '多个 hash 产物全部补丁；已有手工备份不被覆盖', async () => {
  const root = join(runDir, 'j5-multi')
  const dist = coreDist(root)
  const fileA = join(dist, 'plugin-generation-artifact-D-V41Nc0.mjs')
  const fileB = join(dist, 'plugin-generation-artifact-Z9y8x7.mjs')
  const text = artifactSource(ORIGINAL_VERIFY)
  writeFileSync(fileA, text)
  writeFileSync(fileB, text)
  // 旧版布局把备份留在 dist（属本轮要迁移的历史残留）
  writeFileSync(fileA + '.umi-orig', 'MANUAL-BACKUP')

  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.scanned, 2, '扫描到 2 个产物')
  assertEq(summary.patched, 2, '两个都补丁')
  assert(readFileSync(fileA, 'utf8').includes(PATCHED_VERIFY), 'fileA 已补丁')
  assert(readFileSync(fileB, 'utf8').includes(PATCHED_VERIFY), 'fileB 已补丁')
  assert(!existsSync(fileA + '.umi-orig'), 'dist 内旧备份已移走')
  const backupDir = join(root, 'openclaw', '.umi-patch-backups')
  assertEq(readFileSync(join(backupDir, 'plugin-generation-artifact-D-V41Nc0.mjs.umi-orig'), 'utf8'), 'MANUAL-BACKUP', '已有备份保持原样')
  assertEq(
    sha256(readFileSync(join(backupDir, 'plugin-generation-artifact-Z9y8x7.mjs.umi-orig'), 'utf8')),
    sha256(text),
    'fileB 新建备份与原文件一致'
  )
  return '多产物与备份保护成立'
})

// ── J6 锚点重复出现：按未知版本处理 ───────────────────────────────────────────
await rec.check('J6', '锚点出现 2 次：仍按未知版本处理，不改文件', async () => {
  const root = join(runDir, 'j6-duplicate')
  const dist = coreDist(root)
  const file = join(dist, 'plugin-generation-artifact-dup00001.mjs')
  const text = artifactSource(ORIGINAL_VERIFY) + artifactSource(ORIGINAL_VERIFY)
  writeFileSync(file, text)
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.unsupported, 1, '重复锚点不算可补丁')
  assertEq(summary.patched, 0, '不写入')
  assertEq(readFileSync(file, 'utf8'), text, '文件内容不变')
  return '重复锚点安全跳过'
})

// ── J7 静态接线：clawManager 在 spawn 之前调用 ────────────────────────────────
await rec.check('J7', 'clawManager 接线：启动前调用补丁，且失败不阻断', async () => {
  const source = readFileSync(join(process.cwd(), 'electron', 'main', 'clawManager.ts'), 'utf8')
  const importIndex = source.indexOf("from './claw/openclawJunctionPatch'")
  assert(importIndex > 0, 'clawManager 导入 openclawJunctionPatch')
  assert(source.includes('ensureOpenClawJunctionPatch'), '调用 ensureOpenClawJunctionPatch')
  assert(source.includes('emptyOpenClawJunctionPatchSummary'), '超时兜底复用空 summary 工厂')
  const callIndex = source.indexOf('ensureOpenClawJunctionPatch({ log: this._logSink() }')
  const spawnIndex = source.indexOf('this.process = spawn(nodePath')
  assert(callIndex > 0 && spawnIndex > 0, '调用点与 spawn 都存在')
  assert(callIndex < spawnIndex, '补丁在 spawn 之前执行')
  assertEq(
    JSON.stringify(emptyOpenClawJunctionPatchSummary()),
    JSON.stringify({ scanned: 0, patched: 0, alreadyPatched: 0, unsupported: 0, errors: 0, results: [] }),
    '空 summary 形状稳定'
  )
  return '接线与顺序正确'
})

// ── J8 更新/doctor 链路接线 ──────────────────────────────────────────────────
await rec.check('J8', '更新链路与 doctor 前都调用补丁（B1 回归锁）', async () => {
  const downloadSource = readFileSync(
    join(process.cwd(), 'electron', 'main', 'downloadManager.ts'),
    'utf8'
  )
  assert(
    downloadSource.includes("from './claw/openclawJunctionPatch'"),
    'downloadManager 导入补丁模块'
  )
  const downloadCalls = (downloadSource.match(/await this\._ensureJunctionPatchBeforeCoreCommand\(/g) || []).length
  assert(downloadCalls >= 2, `update repair 前后各补一次（实际 ${downloadCalls} 处）`)

  const clawSource = readFileSync(join(process.cwd(), 'electron', 'main', 'clawManager.ts'), 'utf8')
  const doctorStart = clawSource.indexOf('private async _runDoctorFixLocked')
  assert(doctorStart > 0, '找到 _runDoctorFixLocked 代码块')
  const doctorBlock = clawSource.slice(doctorStart, doctorStart + 6000)
  assert(doctorBlock.includes('ensureOpenClawJunctionPatch'), 'doctor 前调用补丁')
  assert(
    doctorBlock.indexOf('ensureOpenClawJunctionPatch') <
      doctorBlock.indexOf('_prepareForDoctorUnlocked'),
    '补丁在 doctor 准备/执行之前'
  )
  return '更新与 doctor 接线完整'
})

// ── J9 已补丁但缺备份：提示不可回退 ───────────────────────────────────────────
await rec.check('J9', '已补丁但缺 .umi-orig：already-patched 并提示不可回退', async () => {
  const root = join(runDir, 'j9-no-backup')
  const dist = coreDist(root)
  const file = join(dist, 'plugin-generation-artifact-nobk0001.mjs')
  writeFileSync(file, artifactSource(PATCHED_VERIFY))
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.alreadyPatched, 1, '识别为已补丁')
  assertEq(summary.patched, 0, '不重复写')
  assert(
    summary.results[0].detail && summary.results[0].detail.includes('备份'),
    '提示缺少回退备份'
  )
  assert(!existsSync(file + '.umi-orig'), '不会把补丁内容写成备份')
  return '缺备份提示正确'
})

// ── J10 新旧锚点并存：不当作已补丁放行 ───────────────────────────────────────
await rec.check('J10', '新旧锚点并存（部分补丁）：unsupported 且文件不动', async () => {
  const root = join(runDir, 'j10-mixed')
  const dist = coreDist(root)
  const file = join(dist, 'plugin-generation-artifact-mix00001.mjs')
  const text = artifactSource(ORIGINAL_VERIFY) + artifactSource(PATCHED_VERIFY)
  writeFileSync(file, text)
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.unsupported, 1, '部分补丁按未知版本处理')
  assertEq(summary.patched, 0, '不写入')
  assertEq(readFileSync(file, 'utf8'), text, '文件内容不变')
  return '部分补丁安全跳过'
})

// ── J11 dist 不可读：记 error 而不是静默 ─────────────────────────────────────
await rec.check('J11', 'dist 是普通文件（ENOTDIR）：summary 记 error 并落日志', async () => {
  const root = join(runDir, 'j11-not-dir')
  const openclawDir = join(root, 'openclaw', 'node_modules', 'openclaw')
  mkdirSync(openclawDir, { recursive: true })
  writeFileSync(join(openclawDir, 'dist'), 'not a directory')
  const logs = []
  const summary = await ensureOpenClawJunctionPatch(
    { log: (line) => logs.push(line) },
    root
  )
  assertEq(summary.scanned, 0, '没扫到文件')
  assertEq(summary.errors, 1, '错误计数为 1')
  assertEq(logs.length, 1, '扫描失败写一条日志')
  return '不可读目录有诊断'
})

// ── J12 dist 内容清单同步：补丁后 sha256/size 与核心包清单一致 ────────────────
await rec.check('J12', '补丁后同步 postinstall-content-inventory 的 sha256/size', async () => {
  const root = join(runDir, 'j12-inventory')
  const dist = coreDist(root)
  const name = 'plugin-generation-artifact-inv00001.mjs'
  const file = join(dist, name)
  const originalText = artifactSource(ORIGINAL_VERIFY)
  writeFileSync(file, originalText)
  writeFileSync(
    join(dist, 'postinstall-content-inventory.json'),
    JSON.stringify(
      [
        { path: `dist/${name}`, sha256: sha256(originalText), mode: 420, size: originalText.length },
        { path: 'dist/other.mjs', sha256: 'a'.repeat(64), mode: 420, size: 1 }
      ],
      null,
      2
    ) + '\n'
  )
  const summary = await ensureOpenClawJunctionPatch({ log: silentLog }, root)
  assertEq(summary.patched, 1, '补丁成功')
  const patchedText = readFileSync(file, 'utf8')
  const inventory = JSON.parse(
    readFileSync(join(dist, 'postinstall-content-inventory.json'), 'utf8')
  )
  const entry = inventory.find((item) => item.path === `dist/${name}`)
  assertEq(entry.sha256, sha256(patchedText), '清单 sha256 与补丁后文件一致')
  assertEq(entry.size, Buffer.byteLength(patchedText), '清单 size 与补丁后文件一致')
  assertEq(entry.mode, 420, 'mode 保持不变')
  const other = inventory.find((item) => item.path === 'dist/other.mjs')
  assertEq(other.sha256, 'a'.repeat(64), '其他条目不受影响')
  return '内容清单保持一致'
})

// ── 清理与结果 ───────────────────────────────────────────────────────────────
rmSync(runDir, { recursive: true, force: true })

const result = rec.toJSON({ entry: [bundled] })
writeJson(join(process.cwd(), 'test', 'accept-result-openclaw-junction-patch.json'), result)
const ok = printResult(result)
process.exit(ok ? 0 : 1)
