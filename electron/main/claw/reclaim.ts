// electron/main/claw/reclaim.ts —— 启动前的残留进程与插件隔离副本回收
//
// 为什么单独拆出来：这一组都是「删不掉也不能卡住启动」的 best-effort 清理，
// 坑全集中在 Windows 上（生产格式 junction、fs.rm 永久 pending、CIM 查询挂住）。
// 它们与 ClawManager 的启动状态机无关，拆成纯函数后可以脱离 electron 单独阅读与验证。

import { exec, execFile } from 'child_process'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { openClawPaths, toPosix } from '../openClawPaths'
import type { ClawLogger } from './deps'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/**
 * 按命令行精确清理残留网关进程。
 *
 * 为什么不能像 bun/openclaw 那样按镜像名杀：真实网关是 **node.exe**
 * （spawn 的是数据目录里的便携 node + openclaw/dist/index.js），而用户机器上
 * 通常同时跑着别的 node（开发服务、Electron 辅助进程、其它工具），
 * `taskkill /im node.exe` 会把这些一并杀掉。
 *
 * 判据取「命令行里出现本数据目录的 openclaw 入口」：既是残留网关的充要特征，
 * 也天然排除了别的实例和无关 node 进程。
 *
 * 残留网关不清掉的话，它会占住状态目录，新网关起来后会以退出码 78
 * （Another gateway already owns this state directory）自退 —— 而这正是
 * probeStartup 判定「新版本起不来」的正面证据，会把正常的新版本回滚掉。
 */
export async function killGhostNodeGateways(log: ClawLogger, dataDir: string): Promise<void> {
  // 命令行里的路径是反斜杠，统一成正斜杠再比较（Windows 路径不区分大小写）
  const needle = toPosix(openClawPaths.clawJs(dataDir)).toLowerCase()
  // PowerShell 单引号串里只需把 ' 翻倍转义
  const psNeedle = needle.replace(/'/g, "''")

  // 用 execFile 而不是 exec：整段脚本作为一个 argv 传进去，
  // 不经过 cmd.exe，省掉一层引号转义（PS 脚本里 -Filter 的双引号在 cmd 下会被吃掉）。
  // 脚本内部只用单引号，避免与 Node 在 Windows 上的 argv 引号处理打架。
  //
  // 关键：只杀「网关本体」，不能杀同特征的其他子命令进程。真实网关命令行是
  //   node <clawJs> gateway --port ...
  // 而 doctor（node <clawJs> doctor --fix）/ config patch（node <clawJs> config patch）
  // 命令行同样含 clawJs 路径——不排除会把正在跑的 doctor / 用户手动开的维护进程
  // 当僵尸网关 taskkill 掉（这正是并发 doctor 互相残杀、状态库锁来回易手的根源）。
  // 判据收紧为「含 clawJs 且含 gateway 子命令」，显式排除 doctor / config patch。
  const script =
    `$n='${psNeedle}'; ` +
    `Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | ` +
    `Where-Object { $cl=$_.CommandLine; if(-not $cl){$false}else{$cl=$cl.Replace('\\','/').ToLower(); $cl.Contains($n) -and $cl.Contains('gateway') -and -not $cl.Contains('doctor') -and -not $cl.Contains('config patch')} } | ` +
    `ForEach-Object { $_.ProcessId }`

  let stdout: string
  try {
    // 加超时：PowerShell CIM 查询在慢机器/安全软件环境下可能挂住，不能让它卡死启动链。
    const res = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      timeout: 30_000,
      windowsHide: true
    })
    stdout = res.stdout
  } catch (e: any) {
    // 清理是 best-effort：查不到（无 node 进程时 Get-CimInstance 无输出、
    // 或 PowerShell 不可用/超时）都不该阻断启动；但必须让用户看到原因——
    // 否则慢机器上可能带着旧网关继续启动，最终只看到「启动失败」。
    const reason = e?.message || String(e)
    console.warn('清理残留网关进程时发生非预期错误:', reason)
    log(`残留网关清理查询失败/超时，已跳过（可能残留旧实例）：${reason}`, 'stderr')
    return
  }

  const pids = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
  if (!pids.length) return

  // /t 连子进程一起收掉，避免网关的 sidecar 残留
  await Promise.all(
    pids.map(async (pid) => {
      try {
        await execFileAsync('taskkill', ['/f', '/t', '/pid', pid], {
          timeout: 15_000,
          windowsHide: true
        })
        console.log(`🧹 已清理残留网关进程 pid=${pid}`)
      } catch (e: any) {
        const reason = e?.message || String(e)
        console.warn(`清理残留网关进程 pid=${pid} 失败:`, reason)
        log(`清理残留网关进程失败（pid ${pid}，可能占用端口/状态库）：${reason}`, 'stderr')
      }
    })
  )
}

/**
 * 按镜像名结束进程；进程不存在（taskkill 退出码 128）视为正常，不告警。
 * 仅在真正的非预期错误时打印警告。
 */
export async function killByImageName(imageName: string): Promise<void> {
  try {
    await execAsync(`taskkill /f /im ${imageName}`, { timeout: 15_000, windowsHide: true })
  } catch (e: any) {
    // 退出码 128 = 未找到进程，属于正常情况直接忽略
    if (e?.code === 128) return
    console.warn(`清理 ${imageName} 进程时发生非预期错误:`, e?.message)
  }
}

/** 插件隔离副本清理的依赖：日志 + 「维护任务是否在途」的动态判定 */
export interface PluginCaptureCleanupDeps {
  log: ClawLogger
  /**
   * 维护任务（doctor / config patch / 更新链路）是否在途。
   * 用 getter 而不是布尔值：清理与维护可能在不同时刻交错，判定必须发生在调用当刻。
   */
  isMaintenanceBusy: () => boolean
}

/**
 * 清理 OpenClaw 插件隔离副本（tmp/plugin-captures/<uuid>）的历史残留。
 *
 * 背景：OpenClaw 每个新进程启动前都会把渠道插件整体复制到该目录做隔离加载，
 * 而飞书插件自带数千个 node_modules 小文件。短命 CLI（config patch / doctor）
 * 退出后来不及回收，实测堆积十余个副本、占用 1GB+；副本越多，OpenClaw 启动时
 * 自己的目录巡检也越慢，是冷启动从十几秒劣化到数分钟的原因之一。
 *
 * 安全前提（比「杀完幽灵进程」更严格，因为那是必要不充分条件）：
 *  1. `killGhostNodeGateways` 刻意**不杀** doctor / config patch（它们同样会用到
 *     captures 目录），非 Windows 上整个 `_killGhostProcesses` 更是空操作。
 *     `start()` 又不走维护互斥锁——维护任务在途（退出码 78 自愈、更新链路）时
 *     用户完全可能点「启动」。所以这里必须自己看维护闸：维护在途直接跳过。
 *  2. 只处理 UUID 形态（或本方法上一轮改名残留的 `.stale-` 前缀）的直接子目录。
 *  3. **先摘链接、再 rename、最后 rm**：OpenClaw 的隔离副本内部用绝对路径 junction
 *     指向同一 UUID 目录下的兄弟包（如 @larksuiteoapi/node-sdk → <uuid>/package-1/…）。
 *     旧实现直接先 rename 再 rm，rename 后这些 junction 全部悬空；2026-11-07 实测
 *     在这种树上 Electron(Node 20) 的 fs.rm(recursive) 会永久 pending（无报错、无 CPU），
 *     把启动链卡死在 preparing 阶段 20+ 分钟。先按 lstat 只摘链接本身，再改名/删目录。
 *  4. 整个删除带超时（见 `removeTreeWithTimeout`）：清理是启动前优化，best-effort，
 *     绝不允许一个删不掉的目录把启动挂死；超时/占用只记日志，下次启动再试。
 *
 * 仍保留 rename：UUID 目录被 OpenClaw 视为带 owner token 的活跃副本，原地 rm 半途失败
 * 会留下「看起来合法、实际残缺」的副本；摘掉链接后改成 `.stale-` 前缀，即使删除失败
 * 下次也只会被本方法继续清理，不会当成有效副本加载。
 */
export async function cleanStalePluginCaptures(
  deps: PluginCaptureCleanupDeps,
  dataDir: string
): Promise<void> {
  // 维护任务在途时跳过：doctor / config patch / 更新链路都在用同一个 captures 目录，
  // 而 killGhostNodeGateways 不会（也不该）杀它们。
  if (deps.isMaintenanceBusy()) {
    deps.log('维护任务进行中，跳过插件隔离副本清理（避免误删在用副本）', 'system')
    return
  }
  // 非 Windows 上前面的幽灵进程清理是空操作，「已无 openclaw 进程」不成立，
  // 不做无条件删除（该目录堆积是 Windows 便携环境的实测问题）。
  if (process.platform !== 'win32') return

  const STALE_PREFIX = '.stale-'
  try {
    const capturesDir = join(openClawPaths.configDir(dataDir), 'tmp', 'plugin-captures')
    if (!existsSync(capturesDir)) return
    const uuidDirRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const entries = await fs.readdir(capturesDir, { withFileTypes: true })
    const staleNames = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (uuidDirRe.test(entry.name) || entry.name.startsWith(STALE_PREFIX))
      )
      .map((entry) => entry.name)

    let removed = 0
    let skipped = 0
    let tooFresh = 0
    // 活跃保护：OpenClaw 的 install/login 等短命 CLI 也会往 captures 里写副本。
    // 清理若与它们并发，先摘链接会破坏活副本（旧实现靠 rename 占用失败侥幸安全）。
    // 用 mtime 做粗护栏：10 分钟内动过的目录视为可能在用，本轮不动。
    const FRESH_GUARD_MS = 10 * 60 * 1000
    // 串行处理：Windows 上数万小文件的递归删除本身就慢，并发只会加剧磁盘争用。
    // 全部走异步 fs：同步 rmSync 会冻结事件循环，期间所有 IPC 与「启动中」UI 全部卡死。
    for (const name of staleNames) {
      const original = join(capturesDir, name)
      // 已是上一轮改名残留的目录直接删；UUID 目录先摘链接、再改名。
      const target = name.startsWith(STALE_PREFIX) ? original : join(capturesDir, STALE_PREFIX + name)
      try {
        let mtimeMs = 0
        try {
          mtimeMs = (await fs.stat(original)).mtimeMs
        } catch {
          continue
        }
        if (Date.now() - mtimeMs < FRESH_GUARD_MS) {
          tooFresh++
          continue
        }

        const unlinked = await unlinkJunctionsInTree(original)
        if (unlinked.failed > 0) {
          skipped++
          deps.log(
            `插件隔离副本 ${name} 内有 ${unlinked.failed} 个链接无法摘除，保留原状（下次启动再试）`,
            'stderr'
          )
          continue
        }
        if (target !== original) await fs.rename(original, target)
        const removal = await removeTreeWithTimeout(deps.log, target, 10_000)
        if (!removal.ok) {
          skipped++
          continue
        }
        removed++
      } catch (e: any) {
        // 占用 / 权限 / 超时：保留原状（UUID 目录名字不变，下次启动仍会被识别为待清理候选）
        skipped++
        console.warn(`[ClawManager] 清理插件隔离副本失败（跳过）: ${name}`, e?.message || e)
      }
    }
    if (removed > 0) {
      deps.log(`已清理 ${removed} 个插件隔离副本残留（tmp/plugin-captures）`, 'system')
    }
    if (tooFresh > 0) {
      deps.log(
        `有 ${tooFresh} 个插件隔离副本在 10 分钟内仍有改动（可能在用），本轮跳过`,
        'system'
      )
    }
    if (skipped > 0) {
      deps.log(
        `${skipped} 个插件隔离副本仍被占用/删除超时，已跳过（不影响本次启动，下次启动会重试）`,
        'system'
      )
    }
  } catch (e: any) {
    deps.log(`插件隔离副本清理失败（可忽略）：${e?.message || e}`, 'stderr')
  }
}

/**
 * 递归摘除目录树里的 junction / symlink（只删链接本身，不跟随目标）。
 *
 * 为什么必须先摘：见 `cleanStalePluginCaptures` 注释第 3 条。这里有个 Windows 坑：
 * OpenClaw 生成的 junction 替身名是 `\??\Global\<abs>`（不是普通 `\??\<abs>`），
 * 对这种链接：
 *  - `fs.rm(force)` 在目标存在时抛 ERR_FS_EISDIR，在目标已悬空时**返回成功但链接仍在**
 *    （readdir 仍能看到；existsSync 会因悬空而误判为不存在）；
 *  - 目录型链接必须用 `fs.rmdir` 摘除（只删重解析点，不跟随目标）。
 * 因此每次删除后用 readdir 复核，仍在则回退 rmdir，仍在本轮计入 failed。
 */
async function unlinkJunctionsInTree(root: string): Promise<{ links: number; failed: number }> {
  let links = 0
  let failed = 0
  const removeLink = async (parentDir: string, name: string): Promise<boolean> => {
    const full = join(parentDir, name)
    const stillPresent = async (): Promise<boolean> => {
      try {
        return (await fs.readdir(parentDir)).includes(name)
      } catch {
        return false
      }
    }
    try {
      await fs.rm(full, { force: true })
    } catch {
      /* 目录型链接（Global junction）会 EISDIR，交给 rmdir */
    }
    if (!(await stillPresent())) return true
    try {
      await fs.rmdir(full)
    } catch {
      /* fall through to verification */
    }
    return !(await stillPresent())
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    // 防御异常深的目录结构（正常 captures 层级 < 8；到 16 层就放弃并记失败，
    // 否则深树里的链接可能被留下，随后的 rm 又回到「悬空 junction 永久 pending」）
    if (depth > 16) {
      failed++
      return
    }
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        links++
        if (!(await removeLink(dir, entry.name))) failed++
        continue
      }
      if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return { links, failed }
}

/** 递归删除 + 超时兜底：删不掉/卡住时只记日志，绝不让启动链永久 pending。 */
async function removeTreeWithTimeout(
  log: ClawLogger,
  target: string,
  timeoutMs: number
): Promise<{ ok: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`删除超时（${Math.round(timeoutMs / 1000)}s）`)),
          timeoutMs
        )
      })
    ])
    return { ok: true }
  } catch (e: any) {
    const error = e?.message || String(e)
    log(`删除插件隔离副本失败（已跳过，下次再试）：${error}`, 'stderr')
    return { ok: false, error }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
