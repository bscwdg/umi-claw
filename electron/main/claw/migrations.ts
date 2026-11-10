// electron/main/claw/migrations.ts —— 启动前写 OpenClaw 迁移 checkpoint / 修复插件 peer 链接
//
// 为什么单独拆出来：两件事都是「不改数据、只让 OpenClaw 的启动审计通过」的启动前
// 兜底，写盘/建链接失败都不该阻断启动；它们与 ClawManager 的状态机无关，
// 且要处理 exFAT/U 盘等不支持 junction 的卷，纯函数便于单独阅读。

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { openClawPaths } from '../openClawPaths'
import type { ClawLogger } from './deps'

const execFileAsync = promisify(execFile)

/** 迁移 checkpoint / peer 链接修复的依赖 */
export interface StartupMigrationDeps {
  log: ClawLogger
  /** 便携 node 路径（真正执行 node:sqlite 写库的子进程） */
  getNodePath: () => string
}

/**
 * 异步判断路径是否存在。用于启动期热路径，替代同步 existsSync，
 * 避免在主进程事件循环上阻塞（U 盘/exFAT 上单次 stat 延迟较大）。
 */
const pathExists = (p: string): Promise<boolean> =>
  fs.access(p).then(() => true).catch(() => false)

/**
 * 向 OpenClaw 状态库写入“启动迁移已完成”的 checkpoint，以跳过启动时的插件 peer-link 审计。
 *
 * OpenClaw 只有在“状态库里记录的版本 ≠ 当前版本”时，才会跑那段会因
 * missing-openclaw-peer-link 而拒绝启动的迁移逻辑（见 doctor-config-preflight）。
 * 在 U 盘/移动硬盘/网络盘（exFAT/FAT32/UNC）上 junction 永远建不出来，
 * 迁移永远失败 → 永远记录不成功 → 每次启动都被拦（死循环）。
 *
 * 因此启动前直接把 schema_meta 中的 startup-migrations 写成当前核心版本，
 * 让 needsStartupMigrationCheckpoint 返回 false，那段审计逻辑根本不执行。
 * 不依赖任何链接能力，适用任何磁盘/任何格式。
 */
export async function markStartupMigrationsComplete(
  deps: StartupMigrationDeps,
  dataDir: string
): Promise<void> {
  try {
    const corePkgPath = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'package.json')
    if (!existsSync(corePkgPath)) return
    const version = JSON.parse(readFileSync(corePkgPath, 'utf-8')).version
    if (typeof version !== 'string' || !version) return

    const stateDbPath = join(openClawPaths.configDir(dataDir), 'state', 'openclaw.sqlite')
    if (!existsSync(stateDbPath)) {
      // 状态库尚未创建（首次启动）：交给 OpenClaw 自己创建；首次若因链接失败被拦，
      // 下一次启动时本方法就能写入 checkpoint。为了首次就能起，下面也尝试创建。
      try {
        mkdirSync(join(openClawPaths.configDir(dataDir), 'state'), { recursive: true })
      } catch { /* ignore */ }
    }

    // 使用内置 node 的 node:sqlite（与核心一致）直接写入 checkpoint。
    // 放在子进程里执行，避免主进程版本差异（Electron 内 node 未必启用 node:sqlite）。
    const nodePath = deps.getNodePath()
    const now = Date.now()
    const script = [
      'const { DatabaseSync } = require("node:sqlite");',
      'const dbPath = process.argv[1];',
      'const version = process.argv[2];',
      'const now = Number(process.argv[3]);',
      'const db = new DatabaseSync(dbPath);',
      'db.exec("CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);");',
      'db.prepare("INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(meta_key) DO UPDATE SET role=excluded.role, schema_version=excluded.schema_version, agent_id=excluded.agent_id, app_version=excluded.app_version, updated_at=excluded.updated_at").run("startup-migrations", "global", 1, null, version, now, now);',
      'db.close();'
    ].join('\n')

    try {
      // execFile 默认捕获 stderr（失败时挂在 error.stderr 上），无需 stdio 配置；
      // windowsHide 避免闪现控制台窗口；timeout 防止被残留进程锁住状态库时无限等待。
      await execFileAsync(nodePath, ['-e', script, stateDbPath, version, String(now)], {
        windowsHide: true,
        timeout: 20_000
      })
      deps.log(`已写入启动迁移 checkpoint (v${version})，跳过插件链接审计`, 'system')
    } catch (e: any) {
      const errText = e?.stderr ? String(e.stderr).slice(0, 200) : (e?.message || '')
      deps.log(`写入启动迁移 checkpoint 失败: ${errText}`, 'stderr')
    }
  } catch (e: any) {
    deps.log(`写入启动迁移 checkpoint 异常: ${e.message}`, 'stderr')
  }
}

/**
 * 启动前修复受管 npm 插件的 openclaw peerDependency 链接。
 *
 * OpenClaw（2026.7 起）启动时会逐个审计受管插件目录（configDir/npm/projects/<hash>/node_modules/<pkg>），
 * 要求其下的 node_modules/openclaw 是一个 realpath 恰好指向核心包（data/openclaw/node_modules/openclaw）的链接；
 * 否则报 missing-openclaw-peer-link 并拒绝启动。
 *
 * 官方本应在安装时自建该 junction，但在从 U 盘/移动硬盘/旧拷贝过来的目录上经常缺失。
 * 这里主动复刻官方的 relink 逻辑，用绝对路径提前把链接补好（拷贝代替链接无法通过 realpath 审计）。
 *
 * @returns 错误提示字符串；全部成功时返回 null。
 */
export async function repairManagedPluginPeerLinks(
  deps: { log: ClawLogger },
  dataDir: string
): Promise<string | null> {
  const hostRoot = join(dataDir, 'openclaw', 'node_modules', 'openclaw')
  if (!(await pathExists(join(hostRoot, 'package.json')))) {
    // 核心包不在预期位置，交给后续流程处理，不在此拦截。
    return null
  }

  let expectedTarget = hostRoot
  try {
    expectedTarget = await fs.realpath(hostRoot)
  } catch { /* ignore */ }

  const projectsDir = join(openClawPaths.configDir(dataDir), 'npm', 'projects')
  if (!(await pathExists(projectsDir))) return null

  const failures: string[] = []
  /** 本轮实际重建过的链接：用于修复后等文件稳定，避免和 OpenClaw 的插件复制/审计抢时序 */
  const repairedLinks: string[] = []

  const listPluginDirs = async (): Promise<string[]> => {
    const result: string[] = []
    let projectEntries: string[] = []
    try {
      projectEntries = await fs.readdir(projectsDir)
    } catch {
      return result
    }
    for (const project of projectEntries) {
      const nm = join(projectsDir, project, 'node_modules')
      let entries: string[] = []
      try {
        entries = await fs.readdir(nm)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry === '.bin' || entry.startsWith('.')) continue
        const entryPath = join(nm, entry)
        if (entry.startsWith('@')) {
          let scoped: string[] = []
          try {
            scoped = await fs.readdir(entryPath)
          } catch {
            continue
          }
          for (const scopedEntry of scoped) result.push(join(entryPath, scopedEntry))
        } else {
          result.push(entryPath)
        }
      }
    }
    return result
  }

  const declaresOpenClawPeer = async (pluginDir: string): Promise<boolean> => {
    try {
      const pkg = JSON.parse(await fs.readFile(join(pluginDir, 'package.json'), 'utf-8'))
      return Boolean(pkg.peerDependencies && typeof pkg.peerDependencies === 'object' && 'openclaw' in pkg.peerDependencies)
    } catch {
      return false
    }
  }

  for (const pluginDir of await listPluginDirs()) {
    if (!(await declaresOpenClawPeer(pluginDir))) continue

    const nodeModulesDir = join(pluginDir, 'node_modules')
    const linkPath = join(nodeModulesDir, 'openclaw')

    // 已正确指向则跳过（realpath 对不存在/失效链接会抛错，自动落入重建分支）。
    try {
      if (await fs.realpath(linkPath) === expectedTarget) continue
    } catch { /* fallthrough to rebuild */ }

    // 重建：先清掉旧的（拷贝目录/失效链接都清），再建 junction。
    try {
      await fs.mkdir(nodeModulesDir, { recursive: true })
    } catch { /* ignore */ }
    // force:true 让路径不存在时也不报错；recursive 兼容旧的是目录而非链接的情况。
    try {
      await fs.rm(linkPath, { recursive: true, force: true })
    } catch { /* ignore */ }

    try {
      await fs.symlink(hostRoot, linkPath, 'junction')
      repairedLinks.push(linkPath)
    } catch (e: any) {
      failures.push(pluginDir)
      deps.log(`修复插件链接失败: ${linkPath} (${e.message})`, 'stderr')
    }
  }

  if (repairedLinks.length > 0) {
    // 仅记日志：实测 junction 创建后 realpath 立即就绪，额外等待是 no-op；
    // 真正与 OpenClaw 插件复制/审计的交错发生在 spawn 之后，这里等待影响不到它。
    deps.log(`已修复 ${repairedLinks.length} 个插件 peer 链接`, 'system')
  }

  if (failures.length > 0) {
    return (
      `无法为插件创建 node_modules/openclaw 链接（共 ${failures.length} 个）。` +
      `这通常是因为程序所在磁盘卷不支持符号链接/junction（如 U 盘/移动硬盘/网络盘的 exFAT/FAT32/UNC）。` +
      `请将程序移到本地 NTFS 磁盘（如 C:/D:）后重试。`
    )
  }

  return null
}
