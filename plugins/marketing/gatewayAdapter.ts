// plugins/marketing/gatewayAdapter.ts —— openclaw 服务 → GatewayClient 形状
//
// 全应用只有一个 GatewayClient（宿主持有），插件拿的是窄服务。这里只做结构适配：
// 插件既拿不到 token，也控制不了网关进程。

import type { OpenClawApi } from '../../electron/main/kernel'
import type { GatewayClient } from '../../electron/main/gatewayClient'

export function buildOpenClawGateway(openclaw: OpenClawApi): GatewayClient {
  return {
    getStatus: () => openclaw.status(),
    ensureReady: () => openclaw.ensureReady(),
    chat: async (input) => {
      const started = Date.now()
      const res = await openclaw.chat(input)
      return {
        text: res.text,
        chunks: 0,
        usage: null,
        model: res.model ?? null,
        aborted: false,
        ms: Date.now() - started
      }
    },
    createChatStream: (input) => {
      const handle = openclaw.stream(input)
      return {
        iterator: handle.iterator,
        result: handle.result.then((r) => ({
          text: r.text,
          chunks: r.chunks,
          usage: null,
          model: null,
          aborted: r.aborted,
          ms: 0
        })),
        cancel: () => handle.cancel()
      }
    }
  } as unknown as GatewayClient
}
