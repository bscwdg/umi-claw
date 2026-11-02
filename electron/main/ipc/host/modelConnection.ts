// electron/main/ipc/host/modelConnection.ts —— 模型连通性测试 IPC（4.1 WP5-a 第四批）
//
// 纯 HTTP：把 baseUrl/modelsListUrl 拼成模型列表地址，带 Bearer 探测；
// 超时默认 900s（与模型配置默认一致），失败时把「超时」与一般错误分开提示。

export interface ModelConnectionIpcDeps {
  /** fetch 实现（仅测试注入；生产用全局 fetch，注册时取一次） */
  fetchImpl?: typeof fetch
}

export function registerModelConnectionIpc(
  ipc: {
    handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
  },
  deps: ModelConnectionIpcDeps = {}
): void {
  const doFetch = deps.fetchImpl ?? fetch
  ipc.handle('test-connection', async (_e, config: Record<string, unknown>) => {
    try {
      // 模型列表接口：modelsListUrl 支持完整 URL 或路径，留空默认 {baseUrl}/models
      const customListUrl = String(config.modelsListUrl || '').trim()
      const base = String(config.baseUrl || '').replace(/\/+$/, '')
      const listUrl = customListUrl
        ? /^https?:\/\//i.test(customListUrl)
          ? customListUrl
          : `${base}${customListUrl.startsWith('/') ? customListUrl : `/${customListUrl}`}`
        : `${base}/models`
      // 超时：未配置时默认 900 秒（15 分钟），与模型配置的默认超时保持一致
      const rawTimeout = Number(config.timeoutSeconds)
      const timeoutSeconds =
        Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(Math.round(rawTimeout), 86400) : 900
      const response = await doFetch(listUrl, {
        headers: { Authorization: `Bearer ${String(config.apiKey ?? '')}` },
        signal: AbortSignal.timeout(timeoutSeconds * 1000)
      })
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }
      const data = (await response.json()) as { data?: Array<{ id?: string }> }
      const models = Array.isArray(data?.data) ? data.data.map((m) => m.id) : []
      return { success: true, models }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isTimeout = (error as { name?: string })?.name === 'TimeoutError' || /timeout/i.test(msg)
      return {
        success: false,
        error: isTimeout ? '请求超时，国内模型卡顿可在配置中调大超时时间' : msg
      }
    }
  })
}
