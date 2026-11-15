// electron/main/claw/openclawJunctionPatch.ts —— 启动前幂等热修 OpenClaw 插件依赖 junction 自检
//
// 为什么需要：OpenClaw 2026.11.x 的插件抓取代码（dist/plugin-generation-artifact-*.mjs）
// 在 Windows 上先 fs.symlinkSync(target, link, 'junction')，再用
// `lstatSync(link).isSymbolicLink()` + 非 native `realpathSync` 做自检。
// 但 Node >=24.16 / >=26 在 Windows 创建的 junction 目标写成 `\??\Global\...`：
// lstat 把它当普通目录、非 native realpathSync 返回链接自身，自检必然失败，
// 网关启动时所有带运行期依赖的插件（微信/QQ 等渠道）都会报
// PluginDependencyLinkError 而拒绝加载（2026-11-15 本机 2026.11.1/2026.11.3 实测）。
// 更新链路（update repair / doctor）与首次启动都可能先于网关跑这些 CLI，所以
// downloadManager / clawManager 在相应命令前也会调用本模块（失败均不阻断）。
//
// 为什么备份放在 dist 外：OpenClaw 用 dist/postinstall-content-inventory.json 记录
// dist 内每个文件的 sha256/size 并在 update/triage/daemon 路径校验。若把 .umi-orig
// 留在 dist，校验会把“多出来的备份文件”当损坏；因此备份统一放
// data/openclaw/.umi-patch-backups/，同时补丁后同步更新 inventory 里该文件中
// 的 sha256/size，让核心包对自身内容保持自洽（inventory 文件本身不在清单内）。
//
// 安全边界：只有锚点精确命中 1 次（旧=1/新=0）才写；上游改代码、锚点重复、
// 新旧标记并存（部分补丁）一律 unsupported 保持原文件不动；任何失败都不阻断
// 调用方（fail-open）。补丁后首次 capture 与复用 capture 的启动都实测可加载渠道
// （2026-11-15 两次冷启动验证）。

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { openClawPaths } from '../openClawPaths'
import type { ClawLogger } from './deps'

const CORE_DIST_REL = join('node_modules', 'openclaw', 'dist')
const ARTIFACT_FILE_RE = /^plugin-generation-artifact-[^/\\]+\.mjs$/
const CONTENT_INVENTORY_NAME = 'postinstall-content-inventory.json'
const BACKUP_DIR_NAME = '.umi-patch-backups'

// 锚点必须与上游 dist 原文逐字一致（含双引号与反引号模板）；命中数不是 1 就视为
// 未知版本，保持原文件不动。
const ORIGINAL_VERIFY =
  'if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target)) throw new Error(`Dependency link does not resolve to its captured target: ${link}`);'

// 补丁后的同一行：Windows 只比较 native realpath（能穿透 `\??\Global\` junction），
// 其他平台保持上游原判断。整行同时充当「已补丁」探针，重复执行直接跳过。
const PATCHED_VERIFY =
  'if (process.platform === "win32" ? (fs.realpathSync.native(link) !== fs.realpathSync.native(target)) : (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target))) throw new Error(`Dependency link does not resolve to its captured target: ${link}`);'

const BACKUP_SUFFIX = '.umi-orig'

export type OpenClawJunctionPatchStatus = 'patched' | 'already-patched' | 'unsupported' | 'error'

export interface OpenClawJunctionPatchResult {
  file: string
  status: OpenClawJunctionPatchStatus
  detail?: string
}

export interface OpenClawJunctionPatchSummary {
  scanned: number
  patched: number
  alreadyPatched: number
  unsupported: number
  errors: number
  results: OpenClawJunctionPatchResult[]
}

export function emptyOpenClawJunctionPatchSummary(): OpenClawJunctionPatchSummary {
  return { scanned: 0, patched: 0, alreadyPatched: 0, unsupported: 0, errors: 0, results: [] }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

function coreDistDir(dataDir: string): string {
  return join(openClawPaths.installDir(dataDir), CORE_DIST_REL)
}

function backupDir(dataDir: string): string {
  return join(openClawPaths.installDir(dataDir), BACKUP_DIR_NAME)
}

/**
 * 补丁会改变 dist 内文件的 size/sha256；OpenClaw 的 update/triage/daemon 路径会拿
 * dist/postinstall-content-inventory.json 校验一致性，所以补丁后把该文件的条目同步
 * 成新值。inventory 文件自身不在清单内，不会形成自引用。失败只返回 'error' 由调用方
 * 写日志，不阻断补丁。
 */
async function syncInventoryEntry(
  distDir: string,
  file: string
): Promise<'updated' | 'unchanged' | 'skipped' | 'error'> {
  const inventoryPath = join(distDir, CONTENT_INVENTORY_NAME)
  if (!(await isFile(inventoryPath))) return 'skipped'
  try {
    const raw = await fs.readFile(inventoryPath, 'utf-8')
    const entries = JSON.parse(raw) as Array<{
      path?: unknown
      sha256?: unknown
      size?: unknown
      mode?: unknown
    }>
    if (!Array.isArray(entries)) return 'error'
    const relativePath = `dist/${basename(file)}`
    const entry = entries.find((item) => item.path === relativePath)
    if (!entry) return 'skipped'

    const bytes = await fs.readFile(file)
    const digest = sha256(bytes)
    if (entry.sha256 === digest && entry.size === bytes.length) return 'unchanged'

    entry.sha256 = digest
    entry.size = bytes.length
    const tmp = join(
      distDir,
      `${CONTENT_INVENTORY_NAME}.umi-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    )
    try {
      await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
      await fs.rename(tmp, inventoryPath)
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined)
      throw err
    }
    return 'updated'
  } catch {
    return 'error'
  }
}

/** 旧版本把 .umi-orig 留在 dist 里，会让 inventory 多出一项；启动时挪到备份目录。 */
async function moveLegacyBackups(distDir: string, targetBackupDir: string): Promise<void> {
  let names: string[] = []
  try {
    names = await fs.readdir(distDir)
  } catch {
    return
  }
  const legacy = names.filter(
    (name) =>
      name.endsWith(BACKUP_SUFFIX) ||
      (name.includes(BACKUP_SUFFIX + '-') && !name.includes('.umi-patch-tmp-'))
  )
  if (legacy.length === 0) return
  await fs.mkdir(targetBackupDir, { recursive: true }).catch(() => undefined)
  for (const name of legacy) {
    const source = join(distDir, name)
    const target = join(targetBackupDir, name)
    try {
      await fs.rename(source, target)
    } catch {
      // 目标已存在/跨卷/占用都只是备份搬家失败，不影响本次补丁主体。
    }
  }
}

/** 清理上一轮进程崩溃/被杀留下的 tmp 文件，避免 dist 目录堆积。 */
async function cleanStaleTmp(distDir: string): Promise<void> {
  let names: string[] = []
  try {
    names = await fs.readdir(distDir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => name.includes('.umi-patch-tmp-'))
      .map((name) => fs.unlink(join(distDir, name)).catch(() => undefined))
  )
}

async function patchOne(
  file: string,
  distDir: string,
  targetBackupDir: string
): Promise<OpenClawJunctionPatchResult> {
  const original = await fs.readFile(file, 'utf-8')
  const anchorCount = countOccurrences(original, ORIGINAL_VERIFY)
  const patchedCount = countOccurrences(original, PATCHED_VERIFY)

  if (anchorCount === 0 && patchedCount === 1) {
    // 已补丁但备份可能缺失（手工热修/旧版本补丁）：补丁本体已生效，只提示不可回退，
    // 不在这里写“备份”，否则会把补丁后内容当成原始文件，回退时反而写坏。
    const backupExists = await isFile(join(targetBackupDir, basename(file) + BACKUP_SUFFIX))
    return {
      file,
      status: 'already-patched',
      detail: backupExists ? undefined : '已补丁但未找到 .umi-orig 回退备份'
    }
  }

  // 只有「旧=1 / 新=0」才是确定的未补丁状态；手工改了一半（旧+新并存）或锚点重复
  // 都按未知版本处理，绝不拿它当 already-patched 放行。
  if (anchorCount !== 1 || patchedCount !== 0) {
    return {
      file,
      status: 'unsupported',
      detail: `锚点命中异常（旧=${anchorCount}, 新=${patchedCount}，预期 1/0），疑似上游已改代码或文件被部分补丁，保持原文件不动`
    }
  }

  const patched = original.replace(ORIGINAL_VERIFY, PATCHED_VERIFY)

  // 写盘前自检：确实改动、旧锚点消失、标记只出现 1 次、行尾风格不变。
  if (patched === original || countOccurrences(patched, PATCHED_VERIFY) !== 1) {
    return { file, status: 'error', detail: '补丁自检失败（替换后内容不符合预期）' }
  }
  if (countOccurrences(patched, ORIGINAL_VERIFY) !== 0) {
    return { file, status: 'error', detail: '补丁后仍残留旧锚点' }
  }
  if (patched.includes('\r\n') !== original.includes('\r\n')) {
    return { file, status: 'error', detail: '补丁会改变行尾风格，拒绝写入' }
  }

  // 备份只留第一份原始文件：已存在且是普通文件说明此前备份过（含手工热修），绝不覆盖；
  // 若同名被目录等非文件占用（损坏环境），换时间戳文件名，保证总有回退底。
  // 备份放 dist 外（见文件头），避免污染 OpenClaw 的 dist 内容清单。
  await fs.mkdir(targetBackupDir, { recursive: true })
  let backupFile = join(targetBackupDir, basename(file) + BACKUP_SUFFIX)
  try {
    const backupStat = await fs.stat(backupFile)
    if (!backupStat.isFile()) {
      backupFile = join(targetBackupDir, `${basename(file)}${BACKUP_SUFFIX}-${Date.now()}`)
      await fs.writeFile(backupFile, original, 'utf-8')
    }
  } catch {
    await fs.writeFile(backupFile, original, 'utf-8')
  }

  // 同目录临时文件 + rename，避免写一半被网关进程读到半截文件；失败时回收自己的 tmp。
  // 文件名带 pid + 时间戳 + 随机段：30s 超时后底层 promise 仍可能继续跑，重试 start 会重叠，
  // 只用 pid 会互相覆盖/rename ENOENT。
  const tmpPrefix = basename(file) + '.umi-patch-tmp-'
  const tmpFile = join(
    distDir,
    `${tmpPrefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  )
  try {
    await fs.writeFile(tmpFile, patched, 'utf-8')
    await fs.rename(tmpFile, file)
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => undefined)
    throw err
  }

  return { file, status: 'patched' }
}

async function listArtifactFiles(dataDir: string): Promise<string[]> {
  const distDir = coreDistDir(dataDir)
  let names: string[] = []
  try {
    names = await fs.readdir(distDir)
  } catch (err) {
    // 核心还没装/已被更新流程挪走是正常状态（ENOENT），其余（EACCES/ENOTDIR…）
    // 必须上抛给调用方记 error，否则补丁静默不生效、渠道失败时也没有诊断。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return names.filter((name) => ARTIFACT_FILE_RE.test(name)).map((name) => join(distDir, name))
}

/**
 * 网关启动 / update repair / doctor 前调用：扫描 openclaw 核心 dist 里的插件抓取
 * 产物并幂等补丁。整体 fail-open——扫描/单文件失败都计入 summary，由调用方写日志，
 * 不向外抛。
 */
export async function ensureOpenClawJunctionPatch(
  deps: { log: ClawLogger },
  dataDir: string
): Promise<OpenClawJunctionPatchSummary> {
  const summary = emptyOpenClawJunctionPatchSummary()
  const distDir = coreDistDir(dataDir)
  const targetBackupDir = backupDir(dataDir)

  let files: string[] = []
  try {
    files = await listArtifactFiles(dataDir)
  } catch (err) {
    summary.errors += 1
    deps.log(`[gateway] junction 兼容补丁扫描失败（不影响启动）：${errMessage(err)}`, 'stderr')
    return summary
  }

  await cleanStaleTmp(distDir)
  await moveLegacyBackups(distDir, targetBackupDir)

  for (const file of files) {
    summary.scanned += 1
    try {
      const result = await patchOne(file, distDir, targetBackupDir)
      summary.results.push(result)
      if (result.status === 'patched') summary.patched += 1
      else if (result.status === 'already-patched') summary.alreadyPatched += 1
      else if (result.status === 'unsupported') summary.unsupported += 1
      else summary.errors += 1

      // 已补丁（含历史手工补丁）的文件也要把 inventory 校正到当前内容；
      // 否则 OpenClaw 的 update/triage 校验仍会判核心包损坏。
      if (result.status === 'patched' || result.status === 'already-patched') {
        const inventory = await syncInventoryEntry(distDir, file)
        if (inventory === 'error') {
          deps.log(
            `[gateway] junction 兼容补丁提示：${basename(file)} 的 dist 内容清单同步失败`,
            'stderr'
          )
        }
      }
    } catch (err) {
      summary.errors += 1
      summary.results.push({ file, status: 'error', detail: errMessage(err) })
    }
  }

  return summary
}
