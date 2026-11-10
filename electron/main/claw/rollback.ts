// electron/main/claw/rollback.ts —— 更新流程「要不要回滚」的决策
//
// 为什么单独拆出来：这条判断出过一次代价很大的错（见 decideRollback 注释），
// 它必须能被纯 Node 单独验证；同时也让 clawManager 只负责采集探针结果。

/**
 * `probeStartup` 的结论。三态而非布尔，是为了让调用方区分
 * 「拿到起不来的正面证据」和「压根没测出结论」—— 只有前者才允许触发回滚。
 */
export interface StartupProbeResult {
  /** 进程活着且就绪 */
  ok: boolean
  /** 进程自己退出了：这是「新版本起不来」的正面证据，可用于回滚决策 */
  refused: boolean
  /** 既没退出也没就绪：结论不确定，**不要**据此回滚 */
  inconclusive: boolean
  exitCode?: number | null
  /**
   * `refused` 的**限定词**（不是并列的第四态）：自退原因是「状态库需要迁移」
   * （退出码 78 / 打印过迁移提示）。它把「数据条件」从「新版本有缺陷」里分出来，
   * 供调用方选文案与补救动作（重跑 doctor vs 重试更新）。
   *
   * 注意它**不**参与回滚安全性判断 —— 那只看数据有没有真被迁移过
   * （见 ClawManager.readSchemaVersions 与 env:update）。
   */
  maintenanceRequired: boolean
  reason: string
}

/**
 * 更新流程「要不要回滚」的决策。
 *
 * 抽成纯函数是因为这条判断出过一次代价很大的错：最初拿「本次 doctor 有没有改动
 * schema」当唯一判据（dataMigrated），它只在**第一次**失败时成立 —— 环境若已被
 * 上一次失败迁到一半（state 库升到 19、旧二进制只支持 17），再跑一次会因为
 * 「这次没变化」被判成安全，回滚后新旧版本都起不来，且备份已被消费，应用再也
 * 救不回来。所以 maintenanceRequired 也必须单独挡住。
 *
 * 注意回滚是**单向**的（_restoreOpenClawSnapshot 会先 rmSync 掉新版本的
 * node_modules），一旦滚错就没有「再滚回来」的机会，判据必须偏保守。
 */
export function decideRollback(
  probe: StartupProbeResult,
  dataMigrated: boolean
): { rollback: boolean; reason: string } {
  if (probe.ok) return { rollback: false, reason: '新版本已就绪' }
  if (!probe.refused) return { rollback: false, reason: '证据不足（进程未自行退出）' }
  if (dataMigrated)
    return { rollback: false, reason: '本次更新迁移过数据库，旧版本将无法读取当前数据' }
  if (probe.maintenanceRequired)
    return {
      rollback: false,
      reason: '数据待迁移：无法确认旧版本能读当前库（可能已被历史更新迁移过），回滚风险过高'
    }
  return { rollback: true, reason: '进程自行退出，且数据未被动过' }
}
