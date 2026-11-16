// electron/main/dataDirBootstrap.ts —— 数据目录覆盖（data-location.json）的纯 Node 读写与校验
//
// 为什么单独一层：数据目录优先级由 configManager 决定，但「用户手动指定数据目录」
// 需要一个**不 import electron、可在纯 Node 下验收**的持久化入口。userData 由调用方
// 注入（Electron 的 app.getPath('userData')），所以本模块只做三件事：
//   1. 候选优先级解析：CLAW_DATA_DIR > 覆盖文件 > 便携模式 > appData 默认 > dev；
//   2. 路径校验：非空、绝对路径、不存在则创建、目录可写（写探针文件后删除）；
//   3. 覆盖文件原子读写（临时文件 + rename），坏文件/坏内容一律按「没有覆盖」处理。
//
// 踩过的坑：不能在这里 import electron —— dataDirBootstrap 的断言要在纯 Node 里跑真源码。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 覆盖文件名（位于 Electron userData 目录，不随 dataDir 变化） */
export const DATA_LOCATION_FILE = 'data-location.json'
/** 覆盖文件格式版本：不认识的一律忽略，避免新版本写的东西被旧版本误读 */
const DATA_LOCATION_SCHEMA = 1

/** 数据目录来源，按优先级从高到低 */
export type DataDirSource = 'env' | 'override' | 'portable' | 'appData' | 'dev'

export interface DataDirCandidates {
  /** CLAW_DATA_DIR 环境变量（开发/排障时与安装版共享数据） */
  env?: string | null
  /** <userData>/data-location.json 里用户选择的目录 */
  override?: string | null
  /** 便携模式：exe 同级存在 data 文件夹时的目录 */
  portable?: string | null
  /** 普通安装默认：%APPDATA%\UmiClaw\data */
  appData?: string | null
  /** 开发环境默认：<cwd>/data */
  dev?: string | null
}

export interface ResolvedDataDir {
  dataDir: string
  source: DataDirSource
}

export type DataDirResult = { ok: true; dataDir: string } | { ok: false; error: string }

export function dataLocationFilePath(userDataDir: string): string {
  return join(userDataDir, DATA_LOCATION_FILE)
}

/**
 * 规范化候选路径：只接受「非空字符串 + 绝对路径」，返回 resolve 后的绝对路径。
 * 读覆盖文件时**不碰磁盘**：目录被删/盘符消失时启动不能因此抛错，按无覆盖回落即可。
 */
export function normalizeDataDirCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!isAbsolute(trimmed)) return null
  return resolve(trimmed)
}

/**
 * 纯函数：按优先级从候选里取第一个可用目录。
 *
 * 调用方（configManager）负责把各分支算出来传进来；本函数不做 IO，便于断言
 * 「去掉 env 后覆盖胜出」「覆盖缺失时回落便携/默认」这类顺序问题。
 */
export function resolveDataDirOverride(candidates: DataDirCandidates): ResolvedDataDir {
  const ordered: Array<[DataDirSource, string | null | undefined]> = [
    ['env', candidates.env],
    ['override', candidates.override],
    ['portable', candidates.portable],
    ['appData', candidates.appData],
    ['dev', candidates.dev]
  ]
  for (const [source, value] of ordered) {
    const dataDir = normalizeDataDirCandidate(value)
    if (dataDir) return { dataDir, source }
  }
  // 类型兜底：正常调用一定命中 dev/appData（configManager 总会传一个默认值），
  // 这里与 ConfigManager 的历史行为保持一致，避免返回空路径。
  return { dataDir: resolve(process.cwd(), 'data'), source: 'dev' }
}

/**
 * 在 `resolveDataDirOverride` 之上加一层「覆盖目录当前可用吗」的判定。
 *
 * 为什么需要：override 指向 D 盘/移动硬盘时，盘符可能暂时消失（拔盘、断电、盘符变化）。
 * 只按路径优先级取 override 会让 ConfigManager 构造期 mkdir 抛出、应用直接起不来。
 * 这里把「不可用的 override」降级成「没有 override」再走原优先级，并带上原因供 UI 提示；
 * 不删除 override 文件：磁盘恢复后重启即可回到用户选定的目录。
 */
export function resolveDataDirWithUsableOverride(
  candidates: DataDirCandidates,
  isUsable: (dir: string) => boolean
): ResolvedDataDir & { overrideUnusable?: string } {
  if (candidates.override) {
    const normalized = normalizeDataDirCandidate(candidates.override)
    if (normalized && !isUsable(normalized)) {
      return {
        ...resolveDataDirOverride({ ...candidates, override: null }),
        overrideUnusable: normalized
      }
    }
  }
  return resolveDataDirOverride(candidates)
}

/** 读覆盖文件；文件不存在 / 坏 JSON / 版本不符 / 非法路径一律返回 null（= 没有覆盖） */
export function readDataDirOverride(userDataDir: string): string | null {
  try {
    const raw = readFileSync(dataLocationFilePath(userDataDir), 'utf8')
    const parsed = JSON.parse(raw) as { schema?: unknown; dataDir?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.schema !== DATA_LOCATION_SCHEMA) return null
    return normalizeDataDirCandidate(parsed.dataDir)
  } catch {
    return null
  }
}

/**
 * 校验候选目录：非空、绝对路径、不存在则创建、必须是目录、可写（探针写后删）。
 *
 * 为什么先创建再写探针：用户常见的坑是选了只读盘 / 受控目录，直到重启后
 * 数据库建库失败才发现。这里在「更改数据目录」当场给出可诊断的失败。
 */
export function validateDataDir(candidate: unknown): DataDirResult {
  const normalized = normalizeDataDirCandidate(candidate)
  if (!normalized) {
    const empty = typeof candidate !== 'string' || !candidate.trim()
    return { ok: false, error: empty ? '数据目录不能为空' : '数据目录必须是绝对路径' }
  }
  try {
    if (existsSync(normalized)) {
      if (!statSync(normalized).isDirectory()) {
        return { ok: false, error: `目标不是目录：${normalized}` }
      }
    } else {
      mkdirSync(normalized, { recursive: true })
    }
    const probe = join(normalized, `.umi-data-dir-probe-${process.pid}-${Date.now()}`)
    writeFileSync(probe, 'ok', 'utf8')
    unlinkSync(probe)
    return { ok: true, dataDir: normalized }
  } catch (e) {
    return { ok: false, error: `数据目录不可写：${(e as Error)?.message ?? String(e)}` }
  }
}

/** 校验并原子写入覆盖文件（先写 .tmp 再 rename，避免半个文件让下次启动读坏） */
export function writeDataDirOverride(userDataDir: string, candidate: unknown): DataDirResult {
  const validated = validateDataDir(candidate)
  if (!validated.ok) return validated
  try {
    mkdirSync(userDataDir, { recursive: true })
    const file = dataLocationFilePath(userDataDir)
    const tmp = `${file}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        { schema: DATA_LOCATION_SCHEMA, dataDir: validated.dataDir, updatedAt: Date.now() },
        null,
        2
      ),
      'utf8'
    )
    renameSync(tmp, file)
    return { ok: true, dataDir: validated.dataDir }
  } catch (e) {
    return { ok: false, error: `保存数据目录失败：${(e as Error)?.message ?? String(e)}` }
  }
}

/** 清除覆盖（回到便携/默认规则；UI 目前没开放入口，保留给排障与后续设置项） */
export function clearDataDirOverride(userDataDir: string): { ok: boolean; error?: string } {
  try {
    rmSync(dataLocationFilePath(userDataDir), { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `清除数据目录配置失败：${(e as Error)?.message ?? String(e)}` }
  }
}
