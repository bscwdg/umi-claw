// electron/main/claw/qqVoicePatch.ts —— 启动前幂等热修 openclaw-qqbot 语音本地路径误判
//
// 为什么需要：@tencent-connect/openclaw-qqbot 2.0.x 的 resolveVoiceSource /
// resolveVoiceSource2 把 Windows 盘符（D:\...）与 UNC（\\srv\...）本地路径当成
// base64 字符串塞进 /v2/.../files 的 file_data，QQ 回「系统繁忙」，插件静默
// 降级成文件消息，语音条永远发不出去（2026-11-13 网关日志实测，见
// 插件 dist 中 sendVoiceMedia catch 的 warn 文案 sendVoice failed ... falling back to sendFile）。
// 该插件装在 data/ 下、不受 git 管理，重装或升级都会覆盖修复，所以在网关每次
// 启动前做一次幂等锚点补丁：锚点精确命中才改，对不上（上游改了代码）就跳过并
// 告警，绝不硬改未知版本；任何失败都不阻断网关启动（fail-open）。
//
// 覆盖边界（2026-11-13 对抗审查登记，刻意不扩大）：守卫只认盘符绝对路径与 UNC，
// 因为生产语音链路 sendMedia → resolveMediaPath 先经 normalize/path.resolve/realpathSync
// （上游 dist 12299/12329/12339），到达解析器时只剩绝对路径。file://、反斜杠相对
// （.\x、..\x）、盘符相对（D:x）不会从该链路进入；它们即便误判成 base64 也只在
// 裸导出 sendMedia2 被外部直接调用时可达。注意 file:// 不能靠返回 localPath 修：
// readFile 收到 file:// 字符串会 ENOENT，必须先转 URL 对象，硬塞进来只会把
// 「上传 500」换成「读文件失败」。真要支持需改返回值形状，等上游修或有真实需求再做。
//
// 另两条已知边界：① 补丁只改 index.cjs，不同步 index.cjs.map（sourcemap 行号会漂移，
// 仅影响调试堆栈，运行时无影响；改 map 风险高于收益）；② 备份按版本号单份保留，
// 同版本号重发包且未整体替换 dist 时不会另留底（实测重装会整体替换该目录）。

import { promises as fs } from 'fs'
import { join } from 'path'
import { openClawPaths } from '../openClawPaths'
import type { ClawLogger } from './deps'

const PLUGIN_PACKAGE_NAME = '@tencent-connect/openclaw-qqbot'
const PLUGIN_DIST_REL = join('dist', 'index.cjs')
const PATCH_MARKER = 'isWindowsLocalVoicePath'

// 补丁标记名同时是「已补丁」探针：手工热修与本模块产出的文件都带这个函数名，
// 重复执行直接跳过，不会叠加。
const HELPER_BLOCK = String.raw`var WINDOWS_LOCAL_VOICE_PATH_RE = /^[a-zA-Z]:[\\/]|^\\/;
function isWindowsLocalVoicePath(source) {
  return WINDOWS_LOCAL_VOICE_PATH_RE.test(source);
}
`

// 锚点必须与上游 dist 原文逐字一致（含双引号与缩进）；命中数不是 1 就视为
// 未知版本，保持原文件不动。
const V1_ANCHOR = `function resolveVoiceSource(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return { url: source };
  }
`

const V1_GUARD = `  if (isWindowsLocalVoicePath(source)) {
    return { localPath: source };
  }
`

const V2_ANCHOR = `function resolveVoiceSource2(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) return { url: source };
`

const V2_GUARD = '  if (isWindowsLocalVoicePath(source)) return { localPath: source };\n'

export type QqVoicePatchStatus = 'patched' | 'already-patched' | 'unsupported' | 'error'

export interface QqVoicePatchResult {
  file: string
  version: string
  status: QqVoicePatchStatus
  detail?: string
}

export interface QqVoicePatchSummary {
  scanned: number
  patched: number
  alreadyPatched: number
  unsupported: number
  errors: number
  results: QqVoicePatchResult[]
}

export function emptyQqVoicePatchSummary(): QqVoicePatchSummary {
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

interface PluginTarget {
  pluginDir: string
  distFile: string
}

/**
 * 扫描 npm/projects 下所有受管插件安装副本，挑出 openclaw-qqbot。
 * 目录约定与 claw/migrations.ts 的 repairManagedPluginPeerLinks 同口径。
 */
async function listPluginTargets(dataDir: string): Promise<PluginTarget[]> {
  const projectsDir = join(openClawPaths.configDir(dataDir), 'npm', 'projects')
  let projectNames: string[] = []
  try {
    projectNames = await fs.readdir(projectsDir)
  } catch {
    return []
  }
  const targets: PluginTarget[] = []
  for (const project of projectNames) {
    const pluginDir = join(
      projectsDir,
      project,
      'node_modules',
      '@tencent-connect',
      'openclaw-qqbot'
    )
    try {
      const pkgPath = join(pluginDir, 'package.json')
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { name?: unknown }
      if (pkg.name !== PLUGIN_PACKAGE_NAME) continue
      const distFile = join(pluginDir, PLUGIN_DIST_REL)
      await fs.access(distFile)
      targets.push({ pluginDir, distFile })
    } catch {
      // 不是目标插件或 dist 缺失：跳过，不影响其他副本
    }
  }
  return targets
}

async function patchOne(target: PluginTarget): Promise<QqVoicePatchResult> {
  let version = 'unknown'
  try {
    const pkg = JSON.parse(
      await fs.readFile(join(target.pluginDir, 'package.json'), 'utf-8')
    ) as { version?: unknown }
    if (typeof pkg.version === 'string') version = pkg.version
  } catch {
    // 版本只用于备份命名与日志，读不到不拦补丁
  }

  const original = await fs.readFile(target.distFile, 'utf-8')
  if (original.includes(PATCH_MARKER)) {
    return { file: target.distFile, version, status: 'already-patched' }
  }

  const v1AnchorCount = countOccurrences(original, V1_ANCHOR)
  const v2AnchorCount = countOccurrences(original, V2_ANCHOR)
  if (v1AnchorCount !== 1 || v2AnchorCount !== 1) {
    return {
      file: target.distFile,
      version,
      status: 'unsupported',
      detail: `锚点命中异常（v1=${v1AnchorCount}, v2=${v2AnchorCount}），疑似上游已改代码，保持原文件不动`
    }
  }

  const patched = original
    .split(V1_ANCHOR)
    .join(HELPER_BLOCK + V1_ANCHOR + V1_GUARD)
    .split(V2_ANCHOR)
    .join(V2_ANCHOR + V2_GUARD)

  // 写盘前自检：确实改动、标记数 = 1 处声明 + 2 处调用、行尾风格不变
  if (patched === original) {
    return { file: target.distFile, version, status: 'error', detail: '替换后内容无变化' }
  }
  if (countOccurrences(patched, PATCH_MARKER) !== 3) {
    return { file: target.distFile, version, status: 'error', detail: '补丁标记数量不符合预期' }
  }
  if (patched.includes('\r\n') !== original.includes('\r\n')) {
    return { file: target.distFile, version, status: 'error', detail: '补丁会改变行尾风格，拒绝写入' }
  }

  // 备份只留第一份原始文件：已存在且是普通文件说明此前备份过（含手工热修），绝不覆盖。
  // 若同名被目录等非文件占用（损坏环境），换时间戳文件名，保证总有回退底。
  let backupFile = join(target.pluginDir, 'dist', `index.cjs.orig-${version}`)
  try {
    const backupStat = await fs.stat(backupFile)
    if (!backupStat.isFile()) {
      backupFile = join(target.pluginDir, 'dist', `index.cjs.orig-${version}-${Date.now()}`)
      await fs.writeFile(backupFile, original, 'utf-8')
    }
  } catch {
    await fs.writeFile(backupFile, original, 'utf-8')
  }

  // 同目录临时文件 + rename，避免写一半被网关进程读到半截文件。
  // 崩溃/杀软占用可能留下 patch-tmp 残留：写入前先清本模块专属前缀（不会误伤
  // 其他文件），rename 失败时回收自己的 tmp，避免在插件 dist 目录堆积。
  const distDir = join(target.pluginDir, 'dist')
  const tmpFile = join(distDir, `index.cjs.patch-tmp-${process.pid}`)
  try {
    const stale = await fs.readdir(distDir).catch(() => [] as string[])
    await Promise.all(
      stale
        .filter((name) => name.startsWith('index.cjs.patch-tmp-'))
        .map((name) => fs.unlink(join(distDir, name)).catch(() => undefined))
    )
    await fs.writeFile(tmpFile, patched, 'utf-8')
    await fs.rename(tmpFile, target.distFile)
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => undefined)
    throw err
  }

  return { file: target.distFile, version, status: 'patched' }
}

/**
 * 网关启动前调用：扫描并幂等热修所有 openclaw-qqbot 副本。
 * 整体 fail-open——扫描/单文件失败都计入 summary 并打日志，不向外抛。
 */
export async function ensureQqBotVoicePatch(
  deps: { log: ClawLogger },
  dataDir: string
): Promise<QqVoicePatchSummary> {
  const summary = emptyQqVoicePatchSummary()
  let targets: PluginTarget[] = []
  try {
    targets = await listPluginTargets(dataDir)
  } catch (err) {
    summary.errors += 1
    deps.log(`[gateway] QQ 语音补丁扫描失败（不影响启动）：${errMessage(err)}`, 'stderr')
    return summary
  }

  for (const target of targets) {
    summary.scanned += 1
    try {
      const result = await patchOne(target)
      summary.results.push(result)
      if (result.status === 'patched') summary.patched += 1
      else if (result.status === 'already-patched') summary.alreadyPatched += 1
      else if (result.status === 'unsupported') summary.unsupported += 1
      else summary.errors += 1
    } catch (err) {
      summary.errors += 1
      summary.results.push({
        file: target.distFile,
        version: 'unknown',
        status: 'error',
        detail: errMessage(err)
      })
    }
  }
  return summary
}
