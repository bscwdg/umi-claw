// plugin-sdk/src/public.ts —— 插件公开 API（官方与第三方共用；v1-RC）
//
// 为什么在 SDK 里重新定义窄类型，而不是直接 re-export kernel：
// kernel 的 PluginContext 含 host.dataDir/paths、registerChannelIpc、hostOps/legacyDb
// 等 internal 能力，直接递出去等于把 internal 写进公开契约。这里只暴露 v1 allowlist；
// 官方插件需要 internal 时从 ./official 显式引入（A3b 迁移期间）。

import type {
  PluginConfigApi as KernelConfigApi,
  PluginDbApi as KernelDbApi,
  PluginJobs as KernelJobs,
  PluginKvApi as KernelKvApi,
  PluginLogger as KernelLogger,
  PluginModule as KernelPluginModule,
  PluginSecretsApi as KernelSecretsApi,
  NotificationsApi as KernelNotificationsApi,
  OpenClawApi as KernelOpenClawApi
} from '../../electron/main/kernel'

export type PluginLogger = KernelLogger
export type PluginJobs = KernelJobs
export type PluginConfigApi = KernelConfigApi

/** 第三方可见 DB：无 path / request / backup / 裸 SQL */
export type PluginDbApiV1 = Pick<
  KernelDbApi,
  'migrate' | 'list' | 'get' | 'create' | 'update' | 'remove' | 'metaGet' | 'metaSet'
>

/** 第三方可见 KV / Secrets / 通知 / OpenClaw（仅模型） */
export type PluginKvApi = KernelKvApi
export type PluginSecretsApi = KernelSecretsApi
export type NotificationsApi = KernelNotificationsApi

/** 第三方可见状态：不含 port/baseUrl/token */
export interface OpenClawStatusV1 {
  ready: boolean
  endpointsEnabled: boolean
  lastError?: unknown
}

export interface OpenClawProxyApi {
  status(): Promise<OpenClawStatusV1>
  chat(input: Parameters<KernelOpenClawApi['chat']>[0]): ReturnType<KernelOpenClawApi['chat']>
  stream(input: Parameters<KernelOpenClawApi['stream']>[0]): ReturnType<KernelOpenClawApi['stream']>
}

export interface PluginHttpApi {
  fetch(input: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }>
}

export interface PluginDialogApi {
  pickFile(options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>
}

/** v1 公开上下文：allowlist；第三方运行时不存在的字段这里也没有 */
export interface PluginContextV1 {
  readonly id: string
  readonly version: string
  readonly host: { readonly version: string; readonly platform: string }
  readonly logger: PluginLogger
  readonly jobs: PluginJobs
  /** 仅 manifest.inject 含 config 时存在；未声明时为 undefined（与 kernel 一致） */
  readonly config?: PluginConfigApi
  readonly services: {
    db?: PluginDbApiV1
    kv?: PluginKvApi
    secrets?: PluginSecretsApi
    notifications?: NotificationsApi
    openclaw?: OpenClawProxyApi
    http?: PluginHttpApi
    dialog?: PluginDialogApi
  }
  registerIpc(
    method: string,
    // TODO(A3a)：当前 kernel 第二参仍是 Electron IpcMainInvokeEvent；RPC 事件契约落地前
    // 第三方不得依赖 signal/requestId，因此这里先标 unknown，避免类型谎言。
    handler: (payload?: unknown, context?: unknown) => unknown | Promise<unknown>
  ): void
  onDispose(fn: () => void | Promise<void>): void
}

export interface PluginModuleV1 {
  activate(ctx: PluginContextV1): void | (() => void) | Promise<void | (() => void)>
  deactivate?(): void | Promise<void>
}

/** 公开面别名：文档里的 PluginModule / PluginIpcHandler 即这两个 */
export type PluginModule = PluginModuleV1
export type PluginIpcHandler = (
  payload?: unknown,
  context?: unknown
) => unknown | Promise<unknown>

/**
 * 官方/第三方统一入口。
 *
 * 返回 kernel 的 PluginModule 形状，保证宿主入口表类型可赋值；插件作者看到的是
 * PluginContextV1（narrow）。A3a 会把 kernel PluginContext 拆成 public/internal 两份，
 * 届时这里的断言可以删掉。
 */
export function definePlugin(mod: PluginModuleV1): KernelPluginModule {
  return mod as unknown as KernelPluginModule
}
