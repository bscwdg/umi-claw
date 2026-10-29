// 由 scripts/gen-plugin-entries.mjs 生成，请勿手改（改清单后跑 npm run plugin:gen）
//
// 这是「构建期装配」的落点：插件代码在这里被静态引用，随之进 dist-electron 产物。
// 运行时只按启用状态决定是否 import + 激活，不做磁盘/网络的代码加载。

import type { PluginModule } from './plugin'

export const PLUGIN_MAIN_ENTRIES: Record<string, () => Promise<PluginModule>> = {
  "hello": () => import('../../../plugins/hello/main').then((m) => m.default)
}
