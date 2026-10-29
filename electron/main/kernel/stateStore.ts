// kernel/stateStore.ts —— 插件启停状态的持久化（宿主设置的一部分，不写插件目录）
//
// PLAN-4.0 §4.3：启停状态持久化在宿主设置中。Phase 0 用一个独立 JSON 文件
// （<dataDir>/plugins-state.json），等宿主 configService 稳定后再并进去。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface PluginStateStore {
  load(): Promise<Record<string, boolean>>
  save(state: Record<string, boolean>): Promise<void>
}

export function createJsonStateStore(filePath: string): PluginStateStore {
  return {
    async load() {
      try {
        if (!existsSync(filePath)) return {}
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
        // 数组也是 object：JSON.parse('[true]') 会被误当成 map（审查 D6），显式排除
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        const out: Record<string, boolean> = {}
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'boolean') out[id] = value
        }
        return out
      } catch {
        // 状态文件坏掉不该阻止启动：按「全部用清单默认值」处理
        return {}
      }
    },
    async save(state) {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
    }
  }
}

/** 测试/内存场景用 */
export function createMemoryStateStore(initial: Record<string, boolean> = {}): PluginStateStore {
  let state = { ...initial }
  return {
    async load() {
      return { ...state }
    },
    async save(next) {
      state = { ...next }
    }
  }
}
