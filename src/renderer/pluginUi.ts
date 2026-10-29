// src/renderer/pluginUi.ts —— 渲染端插件注册表（PLAN-4.0 §5.2 / §7）
//
// v1.1 的加载方式：插件 UI 在**构建期**打进 renderer 产物（plugins.renderer.generated.ts），
// 运行期只做三件事：按启用状态注册/注销路由与导航、挂插槽、执行 setup 返回的清理函数。
// 所以这里不碰 import map / 自定义协议，Vue 单实例天然成立。

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
  /** 插件 id（用于日志/错误上报） */
  id: string
  /** 把组件挂到宿主插槽（Phase 0 仅登记，Phase 1 起由宿主任一页面消费） */
  addSlot(name: string, component: Component): void
}

export interface PluginUiModule {
  routes?: RouteRecordRaw[]
  nav?: PluginNavGroup
  slot?: Record<string, Component>
  /** 返回清理函数；停用时执行（在路由/导航/插槽撤销之后） */
  setup?(host: PluginUiHost): void | (() => void)
}

/** 当前已安装的插件导航组（响应式，App.vue 直接消费） */
export const pluginNavGroups = shallowRef<PluginNavGroup[]>([])

/** 已安装的插槽组件（Phase 1 的页面按 name 取用） */
export const pluginSlots = shallowRef<Record<string, Component[]>>({})

interface AppliedPlugin {
  routeRemovers: Array<() => void>
  nav?: PluginNavGroup
  slots: string[]
  dispose?: () => void
}

export class PluginUiRegistry {
  private readonly applied = new Map<string, AppliedPlugin>()

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

    const routeRemovers: Array<() => void> = []
    try {
      for (const route of mod.routes ?? []) {
        routeRemovers.push(this.router.addRoute(route))
      }

      const slotNames: string[] = []
      if (mod.slot) {
        for (const [name, component] of Object.entries(mod.slot)) {
          this.pushSlot(name, component)
          slotNames.push(name)
        }
      }

      const record: AppliedPlugin = { routeRemovers, nav: mod.nav, slots: slotNames }
      if (mod.nav) this.pushNav(mod.nav)

      this.applied.set(id, record)

      if (mod.setup) {
        const cleanup = mod.setup({
          id,
          addSlot: (name, component) => {
            this.pushSlot(name, component)
            record.slots.push(name)
          }
        })
        if (typeof cleanup === 'function') record.dispose = cleanup
      }
    } catch (e) {
      // 安装失败：把已经加进去的路由撤掉，绝不留下「半装」状态
      for (const remove of routeRemovers) remove()
      this.remove(id)
      logger?.(`[plugin:${id}] UI 安装失败：${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }

  /** 卸载：先跑插件清理，再撤导航/插槽/路由（顺序与 apply 相反） */
  remove(id: string): void {
    const record = this.applied.get(id)
    if (!record) return
    try {
      record.dispose?.()
    } catch {
      // 清理抛错不阻止卸载
    }
    if (record.nav) this.dropNav(record.nav.id)
    for (const name of record.slots) this.dropSlot(name)
    for (const remove of record.routeRemovers.splice(0).reverse()) {
      try {
        remove()
      } catch {
        // 路由可能已被外层移除
      }
    }
    this.applied.delete(id)
  }

  clear(): void {
    for (const id of [...this.applied.keys()]) this.remove(id)
  }

  private pushNav(group: PluginNavGroup): void {
    const next = pluginNavGroups.value.filter((g) => g.id !== group.id)
    next.push(group)
    next.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label))
    pluginNavGroups.value = next
  }

  private dropNav(groupId: string): void {
    pluginNavGroups.value = pluginNavGroups.value.filter((g) => g.id !== groupId)
  }

  private pushSlot(name: string, component: Component): void {
    const current = pluginSlots.value[name] ?? []
    pluginSlots.value = { ...pluginSlots.value, [name]: [...current, component] }
  }

  private dropSlot(name: string): void {
    const next = { ...pluginSlots.value }
    delete next[name]
    pluginSlots.value = next
  }
}
