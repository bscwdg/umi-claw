// electron/main/claw/openclawJunctionPatch.ts —— 启动前幂等热修 OpenClaw 插件依赖 junction 自检
//
// 为什么需要：OpenClaw 2026.11.x 的插件抓取代码（dist/plugin-generation-artifact-*.mjs）
// 在 Windows 上先 fs.symlinkSync(target, link, 'junction')，再用
// `lstatSync(link).isSymbolicLink()` + 非 native `realpathSync` 做自检。
// 但 Node >=24.16 / >=26 在 Windows 创建的 junction 目标写成 `\??\Global\...`：
// lstat 把它当普通目录、非 native realpathSync 返回链接自身，自检必然失败，
// 网关启动时所有带运行期依赖的插件（微信/QQ 等渠道）都会报
// PluginDependencyLinkError 而拒绝加载（2026-11-15 本机 2026.11.1/2026.11.3 实测）。
// 该问题在上游修复前无法靠配置绕过；openclaw 核心装在 data/ 下不受 git 管理、
// 升级也会整体覆盖，所以在每次网关启动前做一次幂等锚点补丁：只有锚点精确命中
// 1 次才把校验改成 Windows 下比较 realpathSync.native；锚点不匹配（上游改代码）
// 就跳过并告警，绝不硬改未知版本；任何失败都不阻断网关启动（fail-open）。
//
// 覆盖边界（刻意不扩大）：只改这一处「依赖链接是否解析到目标」的自检，不改链接
// 创建方式（仍是 Windows junction），也不碰另一条 openclaw peerDependency 审计
// （那条由 clawManager 的 peer-link 修复处理）。补丁后首次 capture 与之后复用
// capture 的启动都实测可正常加载渠道（2026-11-15 两次冷启动验证）。

import { promises as fs } from 'fs'
import { join } from 'path'
import { openClawPaths } from '../openClawPaths'
import type { ClawLogger } from './deps'

const CORE_DIST_REL = join('node_modules', 'openclaw', 'dist')
const ARTIFACT_FILE_RE = /^plugin-generation-artifact-[^/\\]+\.mjs$/

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

async function patchOne(file: string): Promise<OpenClawJunctionPatchResult> {
  const original = await fs.readFile(file, 'utf-8')
  if (original.includes(PATCHED_VERIFY)) {
    return { file, status: 'already-patched' }
  }

  const anchorCount = countOccurrences(original, ORIGINAL_VERIFY)
  if (anchorCount !== 1) {
    return {
      file,
      status: 'unsupported',
      detail: `锚点命中 ${anchorCount} 次（预期 1），疑似上游已改代码，保持原文件不动`
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
  let backupFile = file + BACKUP_SUFFIX
  try {
    const backupStat = await fs.stat(backupFile)
    if (!backupStat.isFile()) {
      backupFile = `${file}${BACKUP_SUFFIX}-${Date.now()}`
      await fs.writeFile(backupFile, original, 'utf-8')
    }
  } catch {
    await fs.writeFile(backupFile, original, 'utf-8')
  }

  // 同目录临时文件 + rename，避免写一半被网关进程读到半截文件；失败时回收自己的 tmp。
  const tmpFile = `${file}.umi-patch-tmp-${process.pid}`
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
  const distDir = join(openClawPaths.installDir(dataDir), CORE_DIST_REL)
  let names: string[] = []
  try {
    names = await fs.readdir(distDir)
  } catch {
    return []
  }
  return names.filter((name) => ARTIFACT_FILE_RE.test(name)).map((name) => join(distDir, name))
}

/**
 * 网关启动前调用：扫描 openclaw 核心 dist 里的插件抓取产物并幂等补丁。
 * 整体 fail-open——扫描/单文件失败都计入 summary，由调用方写日志，不向外抛。
 */
export async function ensureOpenClawJunctionPatch(
  deps: { log: ClawLogger },
  dataDir: string
): Promise<OpenClawJunctionPatchSummary> {
  const summary = emptyOpenClawJunctionPatchSummary()

  let files: string[] = []
  try {
    files = await listArtifactFiles(dataDir)
  } catch (err) {
    summary.errors += 1
    deps.log(`[gateway] junction 兼容补丁扫描失败（不影响启动）：${errMessage(err)}`, 'stderr')
    return summary
  }

  for (const file of files) {
    summary.scanned += 1
    try {
      const result = await patchOne(file)
      summary.results.push(result)
      if (result.status === 'patched') summary.patched += 1
      else if (result.status === 'already-patched') summary.alreadyPatched += 1
      else if (result.status === 'unsupported') summary.unsupported += 1
      else summary.errors += 1
    } catch (err) {
      summary.errors += 1
      summary.results.push({ file, status: 'error', detail: errMessage(err) })
    }
  }

  return summary
}
