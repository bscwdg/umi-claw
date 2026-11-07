// electron/main/portableNpmConfig.ts —— 便携 npm userconfig（<dataDir>/config/.npmrc）
//
// 为什么需要它（2026-11 插件登录排查）：OpenClaw 装插件/依赖时会主动把
// `npm_config_cache` 从子进程 env 里删掉（dist/npm-install-env-*.mjs 的
// NPM_CONFIG_KEYS_TO_RESET 第一项），只靠环境变量覆盖不到真正落盘的 `npm install`；
// 而 npm 的 userconfig 读 HOME（本应用已把 HOME 指向 <dataDir>/config），
// 所以把 cache / registry 写进 .npmrc 才能真正覆盖 OpenClaw 派生的所有 npm 子进程。
//
// 注意：这是**应用受管的便携 HOME**，.npmrc 会被本应用按「国内镜像」开关改写
// （影响 OpenClaw 拉包与终端里基于该 HOME 的 npm 命令）；用户若手工改 registry，
// 下次启动/保存设置会被这里覆盖。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { toPosix } from './openClawPaths'

const MIRROR_REGISTRY = 'https://registry.npmmirror.com'
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

export interface PortableNpmrcResult {
  ok: boolean
  /** 本次是否真的改写了文件（幂等：内容一致时 false） */
  changed: boolean
  path: string
  error?: string
}

/**
 * 幂等维护 `<dataDir>/config/.npmrc` 的 cache / registry 两行。
 *
 * - 只增改这两个键，其余行（含注释、用户其它 npm 设置）原样保留；
 * - cache 固定到 `<dataDir>/config/.npm-cache`（便携隔离，且避开用户级目录的权限问题）；
 * - registry 跟随「国内镜像」开关（该开关本来就是本应用对 npm 拉包源的唯一口径）。
 */
export function ensurePortableNpmrc(
  dataDir: string,
  options: { useChineseMirror?: boolean } = {}
): PortableNpmrcResult {
  const configDir = join(dataDir, 'config')
  const filePath = join(configDir, '.npmrc')
  const managed = new Map<string, string>([
    ['cache', toPosix(join(configDir, '.npm-cache'))],
    ['registry', options.useChineseMirror === false ? OFFICIAL_REGISTRY : MIRROR_REGISTRY]
  ])
  try {
    mkdirSync(configDir, { recursive: true })
    const raw = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const seen = new Set<string>()
    const next: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([^#;\s][^=]*?)\s*=/.exec(line)
      const key = match ? match[1].trim().toLowerCase() : null
      if (key && managed.has(key)) {
        // 同名键只保留第一条并改写；重复行丢掉，避免 npm 取值不确定。
        if (seen.has(key)) continue
        seen.add(key)
        next.push(`${key}=${managed.get(key)}`)
        continue
      }
      next.push(line)
    }
    for (const [key, value] of managed) {
      if (!seen.has(key)) next.push(`${key}=${value}`)
    }
    const content = next.join(eol).replace(/(?:\r?\n)+$/, '') + eol
    if (content === raw) return { ok: true, changed: false, path: filePath }
    // 临时文件 + rename：避免写到一半被 OpenClaw 的 npm 子进程读到半截文件。
    const tmp = `${filePath}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, content, 'utf-8')
      try {
        renameSync(tmp, filePath)
      } catch {
        writeFileSync(filePath, content, 'utf-8')
      }
    } finally {
      // rename 失败回退直写后，tmp 可能仍存在；清理不留垃圾。
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* best-effort */
      }
    }
    return { ok: true, changed: true, path: filePath }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      path: filePath,
      error: (error as Error)?.message || String(error)
    }
  }
}
