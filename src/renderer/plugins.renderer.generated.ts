// 由 scripts/gen-plugin-entries.mjs 生成，请勿手改（改清单后跑 npm run plugin:gen）

import type { PluginUiModule } from './pluginUi'

export const PLUGIN_UI_ENTRIES: Record<string, () => Promise<PluginUiModule>> = {
  "hello": () => import('../../plugins/hello/renderer').then((m) => m.default),
  "marketing": () => import('../../plugins/marketing/renderer').then((m) => m.default),
  "work": () => import('../../plugins/work/renderer').then((m) => m.default)
}
