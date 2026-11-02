// electron/main/ipc/host/skills.ts —— 技能管理 IPC（4.1 WP5-a 第二批：从 index.ts 拆出）
//
// 技能有两套来源：OpenClaw 自带技能走 clawManager；本地/云同步技能走 configManager +
// skillSyncService。deps 用 getter/闭包，保住 registerIpcHandlers 之后才初始化的语义。

import type { HostIpcRegistrar } from './types'

export interface SkillsIpcDeps {
  listSkills: () => unknown
  installSkill: (skillId: unknown) => unknown
  uninstallSkill: (skillId: unknown) => unknown
  getInstalledSkills: () => unknown
  toggleSkillStatus: (id: unknown, enabled: unknown) => Promise<{ ok: boolean; error?: string }>
  removeSkill: (id: string) => Promise<{ success?: boolean } & Record<string, unknown>>
  importSkillZip: () => Promise<unknown>
  dropPendingUpdate: (id: string) => void
  probeFromRemote: () => Promise<unknown>
  installSkills: (ids: string[]) => Promise<unknown>
  applyUpdates: (ids: string[]) => Promise<unknown>
  getPendingUpdates: () => unknown
}

export function registerSkillsIpc(
  ipc: HostIpcRegistrar,
  deps: SkillsIpcDeps
): void {
  const asStringIds = (ids: unknown): string[] =>
    Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []

  // ── OpenClaw 自带技能 ──
  ipc.handle('skills:list', () => deps.listSkills())
  ipc.handle('skills:install', (_e, skillId) => deps.installSkill(skillId))
  ipc.handle('skills:uninstall', (_e, skillId) => deps.uninstallSkill(skillId))

  // ── 本地/云同步技能 ──
  ipc.handle('skills:getInstalledSkills', () => deps.getInstalledSkills())
  ipc.handle('skills:toggleSkillStatus', async (_event, id, enabled) => {
    // 返回 {ok:false} 时转成 reject：前端 Skills.vue 按 try/catch 弹失败提示
    const result = await deps.toggleSkillStatus(id, enabled)
    if (!result.ok) throw new Error(result.error || '技能开关切换失败')
    return result
  })
  ipc.handle('skills:removeSkill', async (_event, id: unknown) => {
    const result = await deps.removeSkill(typeof id === 'string' ? id : '')
    // 移除成功：顺带从云端更新缓存剔除，避免跳页回来又提示更新一个已删的技能
    if (result.success && typeof id === 'string') deps.dropPendingUpdate(id)
    return result
  })
  ipc.handle('skills:importSkillZip', async () => deps.importSkillZip())

  // 拉取改为两阶段：先只读探测（不下载），前端弹窗勾选后再按 ids 下载安装
  ipc.handle('skills:probeRemote', () => deps.probeFromRemote())
  ipc.handle('skills:installSkills', (_e, ids: unknown) => deps.installSkills(asStringIds(ids)))
  // 勾选更新：主进程先过滤非 string 项，service 内再做白名单校验与去重
  ipc.handle('skills:applyUpdates', (_e, ids: unknown) => deps.applyUpdates(asStringIds(ids)))
  ipc.handle('skills:getPendingUpdates', () => deps.getPendingUpdates())
}
