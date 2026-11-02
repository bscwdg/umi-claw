// electron/main/ipc/host/env.ts —— 环境初始化 / OpenClaw 更新 / Node 更新 IPC（4.1 WP5-a 第六批）
//
// 这批从 index.ts 整体搬出，包含三个大任务（init / update / updateNode）与它们的
// **全局单飞闸**（runExclusiveEnvTask）。三条硬约束原样保留：
//   1) init/update/updateNode 互相不能并发，也不能与手动启动并发（envUpdateInFlight）；
//   2) 更新前先停网关并 prepareForDoctor，doctor/探针独占状态库；
//   3) 回滚判据保守：探针 ok 才丢快照；数据已迁移/待迁移时拒绝回滚（decideRollback）。
// 依赖全部注入，便于后续把该文件直接做行为测试（无 electron import）。

import type { StartupProbeResult } from '../../clawManager'

export interface EnvInitOptions {
  useMirror?: boolean
}
export interface EnvIdOptions {
  id?: string
}
export interface NodeUpdateOptions extends EnvInitOptions {
  version?: string
}

export interface EnvOpResult {
  success: boolean
  error?: string
  warning?: string
}

export interface UpdateResult extends EnvOpResult {
  /** 更新在动手前就中止（Node 预检未过）：环境没动过 */
  unchanged?: boolean
  rolledBack?: boolean
  currentVersion?: string
}

export interface EnvIpcDeps {
  download: {
    checkEnvironment: () => Promise<unknown>
    initEnvironment: (options: EnvInitOptions) => Promise<EnvOpResult>
    updateOpenClaw: (options: EnvInitOptions) => Promise<UpdateResult>
    restoreOpenClawBackup: () => Promise<{ restored: boolean; version?: string }>
    discardOpenClawBackup: () => void
    checkLatestVersion: (options: EnvIdOptions) => Promise<unknown>
    getEnvInfo: () => unknown
    getNodeVersions: (options: EnvIdOptions) => Promise<unknown>
    updateNodeRuntime: (options: NodeUpdateOptions) => Promise<UpdateResult>
  }
  claw: {
    getStatus: () => { running: boolean }
    start: () => Promise<{ success: boolean; error?: string }>
    stop: () => Promise<unknown>
    prepareForDoctor: () => Promise<unknown>
    readSchemaVersions: () => Promise<unknown>
    runDoctorFix: () => Promise<{ success: boolean; error?: string }>
    probeStartup: (isReady: () => Promise<boolean>) => Promise<StartupProbeResult>
  }
  /** 只读探测网关是否真正就绪（/health 200），喂给启动探针 */
  gatewayReady: () => Promise<boolean>
  /** 更新在途标记：claw:start/restart 与网关自动拉起都会读它 */
  setUpdateInFlight: (value: boolean) => void
  /** 回滚判据（纯函数，注入以便本文件保持无 electron 依赖、可做行为测试） */
  decideRollback: (probe: StartupProbeResult, dataMigrated: boolean) => { rollback: boolean; reason: string }
}

const ENV_TASK_BUSY_ERROR = '已有环境任务在进行中，请等待当前任务完成'

// 注意：单飞闸作用域在 registerEnvIpc 内；当前宿主只注册一次，等价于旧模块级全局闸。
// 若未来重复注册（例如测试多实例），每个实例各有一把闸，需要再上提。
export function registerEnvIpc(
  ipc: {
    handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
  },
  deps: EnvIpcDeps
): void {
  /**
   * 三个环境任务的**全局**单飞 promise：任意两个都不能并发（写同一安装目录 /
   * 替换正在被 npm 使用的运行时）。第二次调用直接返回 inFlight 回执，不排队。
   * 用户切页/重复点击时主进程兜底；进度仍由 env:progress 广播，页面重挂载可见。
   */
  let envTaskInFlight: Promise<unknown> | null = null
  const runExclusiveEnvTask = <T>(
    task: () => Promise<T>
  ): Promise<T> | { success: false; error: string; inFlight: true } => {
    if (envTaskInFlight) {
      return { success: false, error: ENV_TASK_BUSY_ERROR, inFlight: true }
    }
    const run = task().finally(() => {
      if (envTaskInFlight === run) envTaskInFlight = null
    })
    envTaskInFlight = run
    return run
  }

  ipc.handle('env:check', () => deps.download.checkEnvironment())

  // 初始化/重装会替换 node_modules，且 Node 不满足新核心要求时还会自动升级运行时
  // （升级会结束占用便携 Node 的进程）——所以先停网关，结束后按原状态恢复。
  const envInitImpl = async (options: EnvInitOptions): Promise<EnvOpResult> => {
    const wasRunning = deps.claw.getStatus().running
    if (wasRunning) {
      await deps.claw.stop()
    }
    let result: EnvOpResult = await deps.download.initEnvironment(options)
    if (wasRunning) {
      try {
        const restarted = await deps.claw.start()
        // start() 自己吞异常、以 {success:false} 返回；'已在运行中' 也会返回
        // success:false 但进程确实在跑，所以以「是否真的有进程」为准。
        if (!restarted.success && !deps.claw.getStatus().running) {
          throw new Error(restarted.error || '未知原因')
        }
      } catch (e) {
        // 网关重启失败不改变初始化结果本身：成功转 warning，失败拼进 error，
        // 否则 UI 在失败分支只显示 error，这条信息会被吞掉。
        const restartWarning = `网关重启失败：${(e as Error)?.message ?? String(e)}`
        result = result.success
          ? { ...result, warning: restartWarning }
          : { ...result, error: `${result.error ?? '初始化失败'}；${restartWarning}` }
      }
    }
    return result
  }
  ipc.handle('env:init', (_e, options: EnvInitOptions) =>
    runExclusiveEnvTask(async () => {
      // 与 update / updateNode 共用同一把启动闸：安装期间手动「启动」或网关客户端
      // 自动拉起会抢同一个安装目录与状态库，必须挡在外面。
      deps.setUpdateInFlight(true)
      try {
        return await envInitImpl(options)
      } finally {
        deps.setUpdateInFlight(false)
      }
    })
  )

  const envUpdateImpl = async (options: EnvInitOptions): Promise<UpdateResult> => {
    // 更新期间状态库不能被占用：先停网关，然后 update repair 收敛插件、
    // doctor 迁移 schema、启动探针裁决，最后按需重启（全程由 envUpdateInFlight 闸住外部启动）
    const wasRunning = deps.claw.getStatus().running
    if (wasRunning) {
      await deps.claw.stop()
    }
    // stop() 只收直接子进程，网关派生的 worker 与 DB 应用级租约可能残留；
    // update repair 内的 doctor 必须独占状态库，先清残留进程与僵尸租约。
    await deps.claw.prepareForDoctor()
    const result = await deps.download.updateOpenClaw(options)
    /** 探针跑完后网关是否已经处于运行中（避免下方再 start 一次） */
    let gatewayRunning = false
    if (result.success) {
      // 回滚快照里只有二进制（node_modules / lock / npm），**没有数据库**。
      // 所以先量一遍各库的 schema 版本，doctor 跑完再量一遍：变了就说明数据
      // 已被迁移，此后回滚旧二进制会让它读不了新库。
      const before = await deps.claw.readSchemaVersions()

      // 状态库独占由 runDoctorFix 内部保证：先清残留网关，命中争用再重试一次。
      // doctor 只作参考，不再单独决定回滚：它在完成 schema 迁移**之后**，
      // 仍可能因为与迁移无关的检查（插件白名单过期、memory provider 没配 key 等）
      // 非 0 退出。拿它的退出码当回滚判据，会把迁移其实成功、版本完全可用的新包误回滚。
      const doctor = await deps.claw.runDoctorFix()
      const after = await deps.claw.readSchemaVersions()
      // 比的是「变没变」而不是绝对值，所以半迁移（state 升了、agent 没升）也能检出
      const dataMigrated = JSON.stringify(before) !== JSON.stringify(after)
      if (!doctor.success) {
        result.warning =
          `数据库迁移（doctor --fix）未正常结束：${doctor.error || '未知错误'}；` +
          '已改用实际启动校验判断新版本是否可用'
      }

      // 真判据：用新版本实际启动一次，看它能不能真的起来。
      // 探针无持久化副作用 —— 网关遇到旧 schema 是「拒绝启动」而非自己去迁移。
      // 单一 client（work 域创建，marketing 同源）——这里只借它探存活
      const probe = await deps.claw.probeStartup(() => deps.gatewayReady())

      // 回滚是单向的（_restoreOpenClawSnapshot 会先删掉新版本的 node_modules），
      // 滚错就没有再滚回来的机会 —— 判据必须偏保守，详见 deps.decideRollback 的注释。
      const { rollback: canRollback, reason: rollbackRefusedReason } = deps.decideRollback(probe, dataMigrated)

      if (probe.ok) {
        // 新版本确实可用：候选版本正式生效，此前保留的回滚快照可以删除
        // （清理失败仅留调试日志，残留快照不影响运行，下次更新会自动清理）。
        deps.download.discardOpenClawBackup()
        gatewayRunning = true
        if (!wasRunning) {
          // 探针是为了验证才把网关拉起来的，更新前它并没在跑 —— 恢复原状
          await deps.claw.stop()
          gatewayRunning = false
        }
      } else if (canRollback) {
        // 拿到「进程自己退出」的正面证据，且数据没被动过 —— 回滚是干净的环境恢复。
        // 快照缺失时降级为警告。注意探针此时已经把进程跑挂了，gatewayRunning 保持 false。
        const rollback = await deps.download.restoreOpenClawBackup()
        if (rollback.restored) {
          result.success = false
          result.rolledBack = true
          result.currentVersion = rollback.version
          result.error =
            `新版本无法启动（${probe.reason}），已自动回滚到 v${rollback.version ?? '原版本'}，` +
            '旧环境可继续使用，可稍后重试更新。'
        } else {
          result.warning = [
            result.warning,
            `新版本无法启动（${probe.reason}），且回滚快照不可用，请重新执行更新`
          ]
            .filter(Boolean)
            .join('；')
        }
      } else if (probe.refused) {
        // 进程自退，但回滚不安全（数据已迁移 / 数据待迁移）—— 只能保留新版本。
        // 把补救动作说清楚：重新执行更新会再跑一次迁移。
        result.warning = [
          result.warning,
          `新版本启动后自退（${probe.reason}）。${rollbackRefusedReason}，` +
            '故保留新版本；请重新执行更新以再次尝试迁移，或点击「启动」触发自动修复。'
        ]
          .filter(Boolean)
          .join('；')
      } else {
        // 进程还在跑但迟迟没就绪：证据不足以判定新版本不可用，不贸然回滚。
        result.warning = [
          result.warning,
          `新版本启动后未在预期时间内就绪（${probe.reason}），已保留新版本；如异常持续请重新执行更新`
        ]
          .filter(Boolean)
          .join('；')
        gatewayRunning = true
        if (!wasRunning) {
          await deps.claw.stop()
          gatewayRunning = false
        }
      }
    }
    // 恢复网关运行（旧版本回滚后重启可做到更新不中断工作）；
    // 更新本身就没成功且没回滚时环境不确定，不贸然重启。
    // unchanged：更新在动手前就中止（Node 预检未过）——环境没动过，照常重启。
    if (
      wasRunning &&
      !gatewayRunning &&
      (result.success || result.rolledBack || result.unchanged)
    ) {
      try {
        const restarted = await deps.claw.start()
        // start() 自己吞掉异常、以 {success:false} 返回，只 try/catch 的话
        // 重启失败会完全静默（原实现就是这个毛病）。'已在运行中' 会返回
        // success:false 但进程确实在跑，故以「是否真的有进程」为准，不匹配错误文案。
        if (!restarted.success && !deps.claw.getStatus().running) {
          throw new Error(restarted.error || '未知原因')
        }
      } catch (e) {
        // 网关重启失败不改变更新结果本身，附加警告由 UI 展示
        const restartWarning = `网关重启失败：${(e as Error)?.message ?? String(e)}`
        if (result.success) {
          result.warning = [result.warning, restartWarning].filter(Boolean).join('；')
        } else {
          result.error = `${result.error}；${restartWarning}，请稍后在控制台手动启动`
        }
      }
    }
    return result
  }
  ipc.handle('env:update', (_e, options: EnvInitOptions) =>
    runExclusiveEnvTask(async () => {
      // 全程闸住外部启动（claw:start/restart、网关客户端自动拉起），
      // 防止 doctor 迁移 / update repair 与手动启动抢同一个状态库
      deps.setUpdateInFlight(true)
      try {
        return await envUpdateImpl(options)
      } finally {
        deps.setUpdateInFlight(false)
      }
    })
  )
  ipc.handle('env:checkLatest', async (_e, options: EnvIdOptions) =>
    deps.download.checkLatestVersion(options)
  )
  ipc.handle('env:getInfo', () => deps.download.getEnvInfo())
  // 查询可安装的 Node 版本列表（LTS + 当前版本，标记 OpenClaw 兼容性）
  ipc.handle('env:nodeVersions', async (_e, options: EnvIdOptions) =>
    deps.download.getNodeVersions(options)
  )

  // 更新内置便携 Node：先停网关释放文件锁，结束后（无论成败）恢复原运行状态。
  // 单飞由 runExclusiveEnvTask 保证（与 init/update 共享同一把闸，防止并发改安装目录）。
  const updateNodeImpl = async (options: NodeUpdateOptions): Promise<UpdateResult> => {
    const wasRunning = deps.claw.getStatus().running
    if (wasRunning) {
      await deps.claw.stop()
    }
    let result = await deps.download.updateNodeRuntime(options)
    if (wasRunning) {
      try {
        await deps.claw.start()
      } catch (e) {
        // 网关重启失败不改变更新结果本身，附加警告由 UI 展示
        result = { ...result, warning: `网关重启失败：${(e as Error)?.message ?? String(e)}` }
      }
    }
    return result
  }
  ipc.handle('env:updateNode', (_e, options: NodeUpdateOptions) =>
    runExclusiveEnvTask(async () => {
      // Node 更新会替换正在使用的运行时并停/起网关，同样要闸住外部启动，
      // 否则手动「启动」可能在 node_modules 被替换到一半时拉起进程。
      deps.setUpdateInFlight(true)
      try {
        return await updateNodeImpl(options)
      } finally {
        deps.setUpdateInFlight(false)
      }
    })
  )
}
