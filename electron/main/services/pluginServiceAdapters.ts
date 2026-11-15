// electron/main/services/pluginServiceAdapters.ts —— 插件 ctx.services 的宿主适配器
//
// 为什么单独放：这三个窄接口（hostOps / notifications / openclaw）在 index.ts 里原先各占
// 一段闭包，属于「插件契约怎么接宿主」，不是启动编排。抽出来后 index 只留一句注入，
// 也方便后续给插件服务做行为测试（deps 全部显式传入）。

import { Notification } from 'electron'
import type { HostOpsApi, NotificationsApi, OpenClawApi } from '../kernel'
import { ERROR_CODES, errorCodeOf } from './errors'

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
 * 第三方可见的就绪摘要（与 plugin-sdk `OpenClawStatusV1` 同形）。
 *
 * 为什么单独映射：宿主 getStatus 返回 GatewayStatusSnapshot，带 port/baseUrl，
 * lastError.details 里还可能带宿主路径/端口；这些都不该进第三方进程。
 */
export interface OpenClawStatusSummary {
  ready: boolean
  endpointsEnabled: boolean
  lastError?: { code: string; message: string }
}

/**
 * 第三方可见的网关错误文案：固定映射，**不拼原始 message**。
 * gatewayClient 的 message 会把 http://127.0.0.1:3213、内网 IP、UNC/盘符路径拼进去，
 * 任何「清洗原始串」的写法都容易漏（引号/等号/IPv6 变体），所以直接按 code 给安全文案。
 */
function safeOpenClawErrorMessage(code: string | null): string {
  switch (code) {
    case 'OPENCLAW_NOT_READY':
      return '网关未就绪'
    case 'OPENCLAW_AUTH_ERROR':
      return '网关鉴权失败'
    case 'OPENCLAW_TIMEOUT':
      return '网关超时'
    case 'VALIDATION_ERROR':
      return '参数不合法'
    default:
      return '网关异常'
  }
}

function toOpenClawStatusSummary(status: {
  ready?: unknown
  endpointsEnabled?: unknown
  lastError?: { code?: unknown; message?: unknown } | null
}): OpenClawStatusSummary {
  const summary: OpenClawStatusSummary = {
    ready: status.ready === true,
    endpointsEnabled: status.endpointsEnabled === true
  }
  if (status.lastError) {
    const code = String(status.lastError.code ?? 'OPENCLAW_NOT_READY')
    summary.lastError = { code, message: safeOpenClawErrorMessage(code) }
  }
  return summary
}

/**
 * OpenClaw 能力：包一层唯一的 GatewayClient（单例约束不变）。
 * 插件拿不到 token、拿不到网关进程控制权，只能「问状态 / 聊天 / 流式」。
 * isolated=true（第三方）时 status/ensureReady 只回公开摘要，官方 builtin 行为不变。
 *
 * 兼容两种注入形状（生产/测试都真实存在）：
 * - GatewayClient：有 getStatus / createChatStream（index.ts 的直接注入、单测）；
 * - OpenClawApi：只有 status / ensureReady / chat / stream（生产 pluginRuntime 会把
 *   index.ts 的 `openclaw: () => createOpenClawService(getWorkGatewayClient)` 再包一层，
 *   此时外层 getGateway() 拿到的就是这种形状；写死 getStatus/createChatStream 会 TypeError）。
 */
export function createOpenClawService(getGateway: () => any, pluginId = 'plugin', isolated = false): OpenClawApi {
  // 第三方强制会话隔离：GatewayClient.resolveConversationUser 在无显式 conversationKey
  // 时会用 projectId 拼 conv:<projectId>:*（宿主/其它插件会话），所以 isolated 时必须
  // 剥掉 projectId，并保证键一定落在 conv:plugin:<id>:*（没有键也要合成 default，
  // 否则 inner 可能退回 projectId/默认解析）。
  const scope = <T extends { conversationKey?: string; projectId?: string }>(input: T): T => {
    if (!isolated) return input
    const { projectId: _drop, ...rest } = input
    const key = String(rest.conversationKey ?? '')
    const own = 'conv:plugin:' + pluginId + ':'
    const conversationKey = !key ? own + 'default' : key.startsWith(own) ? key : own + key.replace(/^conv:(plugin:[^:]+:)?/, '')
    return { ...rest, conversationKey } as T
  }
  // 官方（builtin）是宿主自己调的，保留全量；第三方只拿公开摘要。
  const summarize = (status: unknown): unknown => (isolated ? toOpenClawStatusSummary(status as never) : status)
  return {
    status: async () => {
      const gateway = getGateway()
      const status =
        typeof gateway.getStatus === 'function' ? await gateway.getStatus() : await gateway.status()
      return summarize(status) as never
    },
    async ensureReady() {
      // 双保险：bridge 已对第三方禁掉 ensureReady（会触发网关拉起并返回全量状态），
      // 这里仍脱敏一次，防止将来绕过 bridge 直接拿到 adapter 对象。
      const status = await getGateway().ensureReady()
      return summarize(status) as never
    },
    async chat(input) {
      try {
        // scope() 也放进 try：chat(undefined/null) 的 TypeError 也要变成固定安全文案，
        // 不能漏出原始异常口径。
        const scoped = { ...scope(input), stream: false }
        const res = await getGateway().chat(scoped)
        return { text: res.text, model: res.model }
      } catch (e) {
        if (!isolated) throw e
        // 第三方只拿 code + 固定安全文案：原始 message 可能含 URL/内网 IP/宿主路径。
        const code = errorCodeOf(e)
        const wrapped = new Error(safeOpenClawErrorMessage(code)) as Error & { code: string }
        wrapped.code = code ?? ERROR_CODES.PLUGIN_OPERATION_FAILED
        throw wrapped
      }
    },
    stream(input) {
      if (isolated) {
        // 流式 handle 含 AsyncGenerator/Promise/函数，过 service bridge 的 JSON/structured
        // clone 会失败（第三方实际拿不到可用流）；v1 事件流 RPC 未实现，直接安全拒绝。
        const err = new Error('第三方插件暂不支持流式调用（事件流 RPC 未实现）') as Error & { code: string }
        err.code = ERROR_CODES.PLUGIN_OPERATION_FAILED
        throw err
      }
      // builtin 保持原逻辑：GatewayClient 用 createChatStream，inner OpenClawApi 只有 stream。
      const gateway = getGateway()
      const scoped = { ...scope(input), stream: true }
      const handle =
        typeof gateway.createChatStream === 'function'
          ? gateway.createChatStream(scoped)
          : gateway.stream(scoped)
      return {
        iterator: handle.iterator,
        result: handle.result.then((r: { text: string; chunks?: number; aborted?: boolean }) => ({
          text: r.text,
          chunks: r.chunks ?? 0,
          aborted: r.aborted === true
        })),
        cancel: () => handle.cancel()
      }
    }
  }
}
