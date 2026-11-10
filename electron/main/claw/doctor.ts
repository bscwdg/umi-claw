// electron/main/claw/doctor.ts —— doctor --fix 自愈链路里可独立的部分
//
// 为什么单独拆出来：退出码 78 自愈、更新链路的 doctor 是「状态库独占」这条硬约束
// 的两个入口（半迁移死局的来源），细节最多也最容易踩坑；把「跑一次 doctor」
// 「清僵尸租约」这类纯执行体拆出来，ClawManager 只保留单飞/互斥锁状态机，
// 读代码时能看到锁与执行体各自长什么样。注意：spawn 出的 doctor 进程命令行与
// 网关同特征，任何清理都要显式排除 doctor（见 reclaim.ts）。

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { openClawPaths } from '../openClawPaths'
import type { ClawLogger } from './deps'

const execFileAsync = promisify(execFile)

/**
 * doctor 因状态库被占用而失败的输出特征。
 * 实测文案：`Doctor could not enter maintenance. An agent database is in use.
 * Stop other OpenClaw processes using this state, then retry the update.`
 * 另含其内部错误名 StateDatabaseCoordinatorContentionError / SQLITE_BUSY。
 */
export const DOCTOR_CONTENTION_RE =
  /database is in use|ContentionError|database is locked|SQLITE_BUSY/i

/** 退出码 78 自愈的依赖：维护标记都是 ClawManager 的实例状态，用 getter/setter 读写 */
export interface AutoFixMaintenanceDeps {
  log: ClawLogger
  isInFlight: () => boolean
  isUsed: () => boolean
  setInFlight: (value: boolean) => void
  setUsed: (value: boolean) => void
  runDoctorFix: () => Promise<{ success: boolean; output?: string; error?: string }>
  start: () => Promise<{ success: boolean; error?: string; warning?: string }>
}

/**
 * 网关因状态库 schema 过旧拒绝启动（退出码 78 / maintenance_required）时的自愈：
 * 结束残留进程 -> 独立进程执行 doctor --fix（非交互）-> 自动重启。
 * 每次启动生命周期最多自愈一次，避免迁移失败时无限重启。
 */
export async function autoFixMaintenance(deps: AutoFixMaintenanceDeps): Promise<void> {
  if (deps.isInFlight() || deps.isUsed()) return
  deps.setInFlight(true)
  // 先占标记再干活：重启后若仍报 78，由退出处理分支解除标记并提示用户手动重试，
  // 而不是立刻再跑一轮 doctor（单次 doctor 就要 1~2 分钟，会变成死循环）。
  deps.setUsed(true)
  try {
    deps.log('检测到 OpenClaw 状态库需要升级迁移（退出码 78），正在自动修复...', 'system')
    // 清理残留网关进程由 runDoctorFix 内部保证（prepareForDoctor），这里不再重复
    const result = await deps.runDoctorFix()
    if (result.success) {
      deps.log('状态库迁移完成，正在自动重启 OpenClaw...', 'system')
    } else {
      // doctor 非正常结束（被超时中止 / 退出码非 0）不等于迁移没做：
      // 它完全可能在完成 schema 迁移后，死在后续那些与本问题无关的检查上。
      // 所以照常重启一次，让「其实已经修好」的情况自愈；真的没修好时，
      // 重启后仍会以 78 退出，由退出处理分支兜底提示。
      deps.log(
        `自动迁移未正常结束：${result.error || '未知错误'}。迁移可能已落盘，仍尝试直接重启；` +
          `若依旧无法启动，请点击「启动」重试，或在「环境初始化」页重试更新`,
        'stderr'
      )
    }
    await deps.start()
  } catch (e: any) {
    deps.log(`自动迁移异常：${e?.message || e}`, 'stderr')
  } finally {
    deps.setInFlight(false)
  }
}

/** doctor 前置租约清理的依赖 */
export interface StaleLeaseCleanupDeps {
  log: ClawLogger
  getNodePath: () => string
  /** resources/ 根路径（定位 list-node-starts.ps1）；dev/打包双路径，可选 */
  resourcesRoot?: string
}

/**
 * doctor 前置清理：删除 state 库 agent_database_leases 中「owner 进程已死，
 * 或 PID 已被复用」的僵尸租约，并收尾 gateway_boot_lifecycle 中 owner 已死、
 * completed_at_ms 为空的启动记录。
 *
 * 判据是 owner_start_time 与进程**真实启动时间**是否一致：只查 PID 存活着会被
 * PID 复用骗过（实测一个 24 天前的租约 PID 被系统服务复用）。best-effort：
 * 失败不阻断 doctor，runDoctorFix 命中争用还有一次重试兜底。
 */
export async function cleanStaleAgentLeases(
  deps: StaleLeaseCleanupDeps,
  dataDir: string
): Promise<void> {
  const nodePath = deps.getNodePath()
  const stateDbPath = join(openClawPaths.configDir(dataDir), 'state', 'openclaw.sqlite')
  if (!existsSync(stateDbPath)) return

  // 进程枚举走独立 .ps1 文件（list-node-starts.ps1），避免「node -e 内联
  // → cmd → powershell」多层引号转义。返回行：<pid>|<ISO启动时间>。
  const ps1 = deps.resourcesRoot
    ? join(deps.resourcesRoot, 'database', 'list-node-starts.ps1')
    : ''

  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    'const { execFileSync } = require("node:child_process");',
    'const dbPath = process.argv[1];',
    'const ps1Path = process.argv[2];',
    'const isWin = process.platform === "win32";',
    'function liveProcessStarts() {',
    '  const map = new Map();',
    '  let out = "";',
    '  try {',
    '    if (isWin) {',
    '      out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path], { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });',
    '    } else {',
    '      out = execFileSync("sh", ["-c", "ps -eo pid,lstart"], { encoding: "utf8", stdio: ["ignore","pipe","ignore"] });',
    '    }',
    '  } catch {}',
    '  for (const line of out.split(/\\r?\\n/)) {',
    '    let m;',
    '    if (isWin) {',
    '      m = line.trim().match(/^(\\d+)\\|(.+)$/);',
    '      if (m) map.set(Number(m[1]), Date.parse(m[2]));',
    '    } else {',
    '      m = line.trim().match(/^(\\d+)\\s+(.+)$/);',
    '      if (m) { const t = Date.parse(m[2]); if (Number.isFinite(t)) map.set(Number(m[1]), t); }',
    '    }',
    '  }',
    '  return map;',
    '}',
    'const starts = liveProcessStarts();',
    '// 本脚本自身就跑在 node.exe 里，枚举成功则 map 必含当前进程，size 不可能为 0；',
    '// size===0 只可能是枚举失败（ps1 被拦 / 路径为空）——此时无法证明 owner 已死，',
    '// 绝不能把所有租约当僵尸误删（那会夺走存活网关的租约），中止并以非 0 退出。',
    'if (starts.size === 0) {',
    '  console.error("process enumeration failed; lease cleanup aborted");',
    '  process.exit(3);',
    '}',
    'const db = new DatabaseSync(dbPath);',
    'let leases = [];',
    'try { leases = db.prepare("SELECT lease_id, owner_pid, owner_start_time FROM agent_database_leases").all(); } catch {}',
    'let removedLeases = 0;',
    'const delLease = db.prepare("DELETE FROM agent_database_leases WHERE lease_id = ?");',
    'for (const l of leases) {',
    '  const start = starts.has(l.owner_pid) ? starts.get(l.owner_pid) : null;',
    '  // 进程不存在(null)，或 PID 复用（真实启动时间与租约记录对不上）→ 僵尸租约',
    '  const stale = start === null || (l.owner_start_time && Math.abs(start - l.owner_start_time) > 5000);',
    '  if (stale) removedLeases += delLease.run(l.lease_id).changes;',
    '}',
    'let closedBoots = 0;',
    'try {',
    '  const boots = db.prepare("SELECT boot_id, pid FROM gateway_boot_lifecycle WHERE completed_at_ms IS NULL").all();',
    '  const updBoot = db.prepare("UPDATE gateway_boot_lifecycle SET completed_at_ms = CAST(unixepoch(\'subsec\')*1000 AS INTEGER), outcome = \'interrupted\', reason = \'owner process gone; stale lease cleaned before doctor\' WHERE boot_id = ?");',
    '  for (const b of boots) if (!starts.has(b.pid)) closedBoots += updBoot.run(b.boot_id).changes;',
    '} catch {}',
    'db.close();',
    'console.log(JSON.stringify({ totalLeases: leases.length, removedLeases, closedBoots }));'
  ].join('\n')

  try {
    const res = await execFileAsync(nodePath, ['-e', script, stateDbPath, ps1], {
      windowsHide: true,
      maxBuffer: 1024 *1024
    })
    const summary = String(res.stdout || '').trim()
    deps.log(`doctor 前置租约清理完成：${summary || '无残留'}`, 'system')
  } catch (e: any) {
    const errText = e?.stderr ? String(e.stderr).slice(0, 200) : e?.message || ''
    deps.log(`doctor 前置租约清理失败（可忽略）：${errText}`, 'stderr')
  }
}

/** doctor 单次执行的依赖 */
export interface DoctorRunDeps {
  log: ClawLogger
  getDataDir: () => string
  getNodePath: () => string
}

/**
 * 以独立子进程执行 `openclaw doctor --fix --non-interactive --yes`。
 * --non-interactive 只执行安全迁移，--yes 跳过所有确认提示，避免管道内挂死。
 *
 * 超时给得非常宽松，且只作为兜底：本机实测一次「无事可做」的完整 doctor 就要 105s，
 * 若状态库需要 schema 迁移（如 agent 库 19→24），迁移大库还会额外耗时数分钟，
 * 且全程没有任何输出。曾用 180s 硬超时，结果把迁移到一半的 doctor 直接强杀：
 * 迁移其实已经落盘，却被判定为失败 —— 启动自愈因此放弃重启，
 * 更新流程更会据此回滚刚装好的新版本。宁可等久一点，也不能中途杀迁移。
 *
 * @param env 由调用方用 buildOpenClawEnv 构造（本函数不碰进程环境判定）
 */
export function runDoctorOnce(
  deps: DoctorRunDeps,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ success: boolean; output?: string; error?: string }> {
  const dataDir = deps.getDataDir()
  const nodePath = deps.getNodePath()
  const clawJsPath = openClawPaths.clawJs(dataDir)

  deps.log('正在执行 openclaw doctor --fix（非交互模式）...', 'system')

  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (result: { success: boolean; output?: string; error?: string }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = execFile(
        nodePath,
        [clawJsPath, 'doctor', '--fix', '--non-interactive', '--yes'],
        {
          cwd: openClawPaths.installDir(dataDir),
          env,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024
        }
      )
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((l) => deps.log(`[doctor] ${l}`, 'stdout'))
      })
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((l) => deps.log(`[doctor] ${l}`, 'stderr'))
      })
      const timeoutError = (signal?: string | null) =>
        `doctor 超过 ${Math.round(timeoutMs / 60000)} 分钟仍未结束，已被中止` +
        `（signal=${signal ?? 'unknown'}）。状态库很大时迁移耗时较长属正常，可稍后重试。`
      child.on('error', (err: any) => {
        // 超时兜底触发时 Node 会以 ETIMEDOUT/killed 抛错，给出可读原因而不是裸 err.message
        if (err?.killed || err?.code === 'ETIMEDOUT') {
          finish({ success: false, output, error: timeoutError(err?.signal) })
          return
        }
        finish({ success: false, output, error: err.message })
      })
      child.on('exit', (code, signal) => {
        if (code === 0) {
          deps.log('[doctor] 修复执行完成', 'system')
          finish({ success: true, output })
        } else if (code === null) {
          // code=null 表示被信号终止（即上面的超时兜底），而非 doctor 自己返回的退出码
          finish({ success: false, output, error: timeoutError(signal) })
        } else {
          finish({ success: false, output, error: `doctor 退出码 ${code}` })
        }
      })
    } catch (e: any) {
      finish({ success: false, output, error: e.message })
    }
  })
}
