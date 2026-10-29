import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from '../App.vue'
import '../assets/style.css'
import { PluginUiRegistry } from './pluginUi'
import { PLUGIN_UI_ENTRIES } from './plugins.renderer.generated'
import type { PluginStatus } from '../../electron/main/kernel/lifecycle'

// 路由
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: () => import('../views/Dashboard.vue') },
    { path: '/config', component: () => import('../views/Config.vue') },
    { path: '/skills', component: () => import('../views/Skills.vue') },
    { path: '/logs', component: () => import('../views/Logs.vue') },
    { path: '/setup', component: () => import('../views/Setup.vue') },
    { path: '/voice', component: () => import('../views/voice/VoicePage.vue') },
    { path: '/channelsPage', component: () => import('../views/ChannelsPage.vue') },
    { path: '/terminal', component: () => import('../views/TerminalPage.vue') },
    { path: '/about', component: () => import('../views/About.vue') },
    { path: '/obsidian', component: () => import('../views/ObsidianPage.vue') },
    // 插件管理（宿主页面，不是插件页面）
    { path: '/plugins', component: () => import('../views/PluginManager.vue') },
    // work 域路由由 plugins/work/renderer.ts 贡献（Phase 2 装箱）

    // marketing 域路由由 plugins/marketing/renderer.ts 贡献（Phase 3 装箱）

  ]
})


const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
// ── 插件 UI 同步（构建期装配 + 运行期注册/注销）─────────────────────────────
//
// 只对「已启用且已激活」的插件安装 UI；停用后路由、导航组、插槽一起撤掉。
// 安装失败只影响该插件（控制台留痕），不影响壳。
const pluginUi = new PluginUiRegistry(router)

async function syncPluginUi(statuses: PluginStatus[]): Promise<void> {
  for (const status of statuses) {
    const entry = PLUGIN_UI_ENTRIES[status.id]
    const shouldApply = status.enabled && status.state === 'activated' && Boolean(entry)

    if (shouldApply && !pluginUi.has(status.id)) {
      try {
        pluginUi.apply(status.id, await entry(), (line) => console.warn(line))
      } catch (e) {
        console.warn(`[plugin:${status.id}] UI 安装失败`, e)
      }
    } else if (!shouldApply && pluginUi.has(status.id)) {
      pluginUi.remove(status.id)
    }
  }
}

void (async () => {
  try {
    const statuses = await window.api.plugins.list()
    await syncPluginUi(statuses)
    window.api.plugins.onChanged((next) => {
      void syncPluginUi(next)
    })
  } catch (e) {
    // 插件子系统不可用不该挡住界面
    console.warn('[plugin] 同步插件 UI 失败', e)
  }
})()