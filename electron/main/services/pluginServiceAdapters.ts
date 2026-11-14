// electron/main/services/pluginServiceAdapters.ts —— 插件 ctx.services 的宿主适配器
//
// 为什么单独放：这三个窄接口（hostOps / notifications / openclaw）在 index.ts 里原先各占
// 一段闭包，属于「插件契约怎么接宿主」，不是启动编排。抽出来后 index 只留一句注入，
// 也方便后续给插件服务做行为测试（deps 全部显式传入）。

import { Notification } from 'electron'
import type { HostOpsApi, NotificationsApi, OpenClawApi } from '../kernel'

export interface HostOpsAdapterDeps {
  notify: (id: string, payload: unknown) => void
  push: (id: string, payload: unknown, dest: unknown) => Promise<unknown>
  listPushChannels: () => Promise<unknown> | unknown
  listPushTargets: (channel: string) => Promise<unknown> | unknown
  locateOldDbs: () => unknown
  readOldDb: (info: unknown) => Promise<unknown>
  /** 与网关同源按次读配置：扫描件识别用它做栅格化前预检 */
  isMultimodalConfigured: () => boolean
}

/** 宿主副作用（过渡服务，Phase 4 拆细）：通知 / 渠道外发 / 旧库只读 */
export function createHostOpsService(deps: HostOpsAdapterDeps): HostOpsApi {
  return {
    notify: (id, payload) => deps.notify(id, payload),
    push: async (id, payload, dest) => (await deps.push(id, payload, dest)) as never,
    listPushChannels: async () => (await deps.listPushChannels()) as never,
    listPushTargets: async (channel) => (await deps.listPushTargets(channel)) as never,
    locateOldDbs: () => deps.locateOldDbs() as never,
    readOldDb: async (info) => (await deps.readOldDb(info)) as never,
    // 基座不知道插件 id；pluginRuntime 会按插件替换成真实注册表（A3a）
    registerConversationKeyResolver: () => {
      throw new Error('registerConversationKeyResolver 必须由 pluginRuntime 按插件注入')
    },
    isMultimodalConfigured: () => deps.isMultimodalConfigured()
  }
}

/** 系统通知：插件只能发标题 + 正文 */
export function createNotificationsService(): NotificationsApi {
  return {
    show({ title, body, silent }) {
      try {
        if (!Notification.isSupported()) return
        new Notification({ title, body, silent: silent ?? false }).show()
      } catch (e) {
        console.warn('[plugin] 通知发送失败：', e)
      }
    }
  }
}

/**
 * OpenClaw 能力：包一层唯一的 GatewayClient（单例约束不变）。
 * 插件拿不到 token、拿不到网关进程控制权，只能「问状态 / 聊天 / 流式」。
 */
export function createOpenClawService(getGateway: () => any, pluginId = 'plugin'): OpenClawApi {
  const scope = <T extends { conversationKey?: string }>(input: T): T => {
    const key = String(input.conversationKey ?? '')
    if (!key || key.startsWith('conv:plugin:')) return input
    return { ...input, conversationKey: 'conv:plugin:' + pluginId + ':' + key.replace(/^conv:/, '') }
  }
  return {
    status: () => getGateway().getStatus(),
    ensureReady: () => getGateway().ensureReady(),
    async chat(input) {
      const res = await getGateway().chat({ ...scope(input), stream: false })
      return { text: res.text, model: res.model }
    },
    stream(input) {
      const handle = getGateway().createChatStream({ ...scope(input), stream: true })
      return {
        iterator: handle.iterator,
        result: handle.result.then((r) => ({ text: r.text, chunks: r.chunks, aborted: r.aborted })),
        cancel: () => handle.cancel()
      }
    }
  }
}
