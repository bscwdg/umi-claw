// plugins/shared/hostBridge.ts —— 插件 UI 访问宿主 API 的**唯一**入口
//
// 为什么要有这一层：插件页面/Store 之前直接写 `window.api.work.*` / `window.api.marketing.*`
// （共 80+ 处）。直接依赖 window.api 意味着插件能摸到宿主全部通道，PluginUiHost 承诺的
// 「窄接口」形同虚设，也没法做权限审计。
//
// 现在：所有插件 UI 只 import 这里的函数；`window.api` 只在这个文件里出现一次。
// 后续要换成 `host.invoke`（Phase 4 权限收窄的第二步）时，只改这一个文件。

type AnyApi = Record<string, any>

function root(): AnyApi {
  const api = (globalThis as { window?: { api?: AnyApi } }).window?.api
  if (!api) {
    throw new Error('宿主 API 不可用：插件 UI 必须在 Electron 渲染进程里运行')
  }
  return api
}

/** work 域通道（work:*） */
export function workApi(): AnyApi {
  return root().work ?? {}
}

/** marketing 域通道（marketing:* / advisor / scan / content / hot） */
export function marketingApi(): AnyApi {
  return root().marketing ?? {}
}

/** OpenClaw 进程与状态（宿主通道，非工作/营销域） */
export function clawApi(): AnyApi {
  return root().claw ?? {}
}

/** 外壳能力（打开外链等） */
export function shellApi(): AnyApi {
  return root().shell ?? {}
}

/** 插件管理（列表 / 启停 / 状态订阅） */
export function pluginsApi(): AnyApi {
  return root().plugins ?? {}
}
