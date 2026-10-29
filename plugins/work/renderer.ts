// plugins/work/renderer.ts —— 工作域 UI（Phase 2 装箱）
//
// 9 个页面从 `src/views/work/*` 搬到这里；路由与导航组由插件贡献，
// 停用插件时由宿主 `pluginUi` 统一摘除（路由 / 导航 / 插槽）。

import type { PluginUiModule } from '../../src/renderer/pluginUi'

const mod: PluginUiModule = {
  routes: [
    { path: '/work', redirect: '/work/today' },
    { path: '/work/today', component: () => import('./ui/pages/TodayPage.vue') },
    { path: '/work/records', component: () => import('./ui/pages/RecordsPage.vue') },
    { path: '/work/qa', component: () => import('./ui/pages/QaPage.vue') },
    { path: '/work/reports', component: () => import('./ui/pages/ReportsPage.vue') },
    { path: '/work/tools', component: () => import('./ui/pages/ToolsPage.vue') },
    { path: '/work/knowledge', component: () => import('./ui/pages/KnowledgePage.vue') },
    { path: '/work/context', component: () => import('./ui/pages/ContextPage.vue') },
    { path: '/work/settings', component: () => import('./ui/pages/SettingsPage.vue') }
  ],
  nav: {
    id: 'work',
    label: '工作',
    order: 10,
    items: [
      { to: '/work/today', icon: '☀️', label: '新的一天' },
      { to: '/work/records', icon: '🗂', label: '工作记录' },
      { to: '/work/qa', icon: '💬', label: '工作问答' },
      { to: '/work/reports', icon: '📊', label: '报告' },
      { to: '/work/tools', icon: '🧰', label: '工具箱' },
      { to: '/work/knowledge', icon: '📚', label: '工作知识库' },
      { to: '/work/context', icon: '🔍', label: 'AI的世界' },
      { to: '/work/settings', icon: '⚙️', label: '工作设置' }
    ]
  },
  slot: {},
  setup() {
    return () => undefined
  }
}

export default mod
