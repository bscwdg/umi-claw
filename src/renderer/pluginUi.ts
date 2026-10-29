// src/renderer/pluginUi.ts —— 渲染端插件注册表（PLAN-4.0 §5.2 / §7）
//
// v1.1 的加载方式：插件 UI 在**构建期**打进 renderer 产物（plugins.renderer.generated.ts），
// 运行期只做三件事：按启用状态注册/注销路由与导航、挂插槽、执行 setup 返回的清理函数。
// 所以这里不碰 import map / 自定义协议，Vue 单实例天然成立。
//
// 归属（owner）原则（审查 P1）：导航组与插槽都是**按插件归属**记录的，多个插件可以
// 往同一个导航组合并条目、往同一个插槽追加组件；停用一个插件只撤它自己的那一份。

import { shallowRef, type Component } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'

export interface PluginNavItem {
  to: string
  icon: string
  label: string
}

export interface PluginNavGroup {
  id: string
  label: string
  order?: number
  items: PluginNavItem[]
}

export interface PluginUiHost {
  id: string
  addSlot(name: string, component: Component): void
}

export interface PluginUiModule {
  routes?: RouteRecordRaw[]
  nav?: PluginNavGroup
  slot?: Record<string, Component>
  setup?(host: PluginUiHost): void | (() => void)
}

/** 当前生效的插件导航组（已按 order 排序、同 id 合并） */
export const pluginNavGroups = shallowRef<PluginNavGroup[]>([])
/** 当前生效的插槽组件（name → 各插件贡献的组件，按安装顺序） */
export const pluginSlots = shallowRef<Record<string, Component[]>>({})

interface AppliedPlugin {
  routeRemovers: Array<() => void>
  routePaths: string[]
  dispose?: () => void
}

const byOrder = (a: PluginNavGroup, b: PluginNavGroup): number =>
  (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label)

export class PluginUiRegistry {
  private readonly applied = new Map<string, AppliedPlugin>()
  /** pluginId → 该插件贡献的导航组 */
  private readonly navByPlugin = new Map<string, PluginNavGroup>()
  /** slot name → (pluginId → 该插件贡献的组件) */
  private readonly slotsByPlugin = new Map<string, Map<string, Component[]>>()

  constructor(private readonly router: Router) {}

  has(id: string): boolean {
    return this.applied.has(id)
  }

  ids(): string[] {
    return [...this.applied.keys()].sort()
  }

  /** 安装一个插件 UI；重复安装幂等（先卸载再装） */
  apply(id: string, mod: PluginUiModule, logger?: (line: string) => void): void {
    if (this.applied.has(id)) this.remove(id)

    const record: AppliedPlugin = { routeRemovers: [], routePaths: [] }
    try {
      for (const route of mod.routes ?? []) this.addRoute(id, route, record)

      if (mod.nav) this.navByPlugin.set(id, mod.nav)

      for (const [name, component] of Object.entries(mod.slot ?? {})) {
        this.addSlot(id, name, component)
      }

      this.applied.set(id, record)
      this.recompute()

      if (mod.setup) {
        const cleanup = mod.setup({
          id,
          addSlot: (name, component) => {
            this.addSlot(id, name, component)
            this.recompute()
          }
        })
        if (typeof cleanup === 'function') record.dispose = cleanup
      }
    } catch (e) {
      // 安装失败：撤掉已经加进去的东西，绝不留下「半装」状态
      this.remove(id)
      logger?.(`[plugin:${id}] UI 安装失败：${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }

  /** 卸载：先跑插件清理，再撤自己的导航/插槽/路由 */
  remove(id: string): void {
    const record = this.applied.get(id)
    try {
      record?.dispose?.()
    } catch {
      // 清理抛错不阻止卸载
    }

    this.navByPlugin.delete(id)
    for (const [name, owners] of this.slotsByPlugin) {
      owners.delete(id)
      if (owners.size === 0) this.slotsByPlugin.delete(name)
    }

    const removedPaths = record?.routePaths ?? []
    for (const remove of (record?.routeRemovers ?? []).splice(0).reverse()) {
      try {
        remove()
      } catch {
        // 路由可能已被外层移除
      }
    }
    this.applied.delete(id)
    this.recompute()

    // 当前页面属于被卸掉的插件 → 回退到控制台，避免「IPC 已撤、页面还挂着」
    const current = (this.router as { currentRoute?: { value?: { matched?: Array<{ path: string }> } } })
      .currentRoute?.value
    const matchedPaths = current?.matched?.map((m) => m.path) ?? []
    if (matchedPaths.some((p) => removedPaths.includes(p)) && typeof this.router.replace === 'function') {
      void this.router.replace('/dashboard').catch(() => undefined)
    }
  }

  clear(): void {
    for (const id of [...this.applied.keys()]) this.remove(id)
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private addRoute(id: string, route: RouteRecordRaw, record: AppliedPlugin): void {
    const router = this.router as Router & {
      hasRoute?: (name: string) => boolean
      getRoutes?: () => Array<{ path: string }>
    }
    if (route.name && router.hasRoute?.(String(route.name))) {
      throw new Error(`插件 ${id} 的路由名与既有路由冲突：${String(route.name)}`)
    }
    if (router.getRoutes?.().some((r) => r.path === route.path)) {
      throw new Error(`插件 ${id} 的路由路径与既有路由冲突：${route.path}`)
    }
    record.routeRemovers.push(this.router.addRoute(route))
    record.routePaths.push(route.path)
  }

  private addSlot(id: string, name: string, component: Component): void {
    const owners = this.slotsByPlugin.get(name) ?? new Map<string, Component[]>()
    const mine = owners.get(id) ?? []
    mine.push(component)
    owners.set(id, mine)
    this.slotsByPlugin.set(name, owners)
  }

  /** 由归属表重算对外可见的导航组与插槽 */
  private recompute(): void {
    const groups = new Map<string, PluginNavGroup>()
    for (const group of [...this.navByPlugin.values()].sort(byOrder)) {
      const existing = groups.get(group.id)
      if (!existing) {
        groups.set(group.id, { ...group, items: [...group.items] })
        continue
      }
      for (const item of group.items) {
        if (!existing.items.some((i) => i.to === item.to)) existing.items.push(item)
      }
    }
    pluginNavGroups.value = [...groups.values()].sort(byOrder)

    const slots: Record<string, Component[]> = {}
    for (const [name, owners] of this.slotsByPlugin) {
      const components: Component[] = []
      for (const list of owners.values()) components.push(...list)
      if (components.length) slots[name] = components
    }
    pluginSlots.value = slots
  }
}
