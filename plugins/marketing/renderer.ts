// plugins/marketing/renderer.ts —— 营销域 UI（Phase 3 装箱）
//
// 6 个页面 + 顶栏的 ProjectSwitcher 都从壳里搬进来；路由 / 导航 / 插槽随插件启停。

import type { PluginUiModule } from '../../src/renderer/pluginUi'
import ProjectSwitcher from './ui/components/ProjectSwitcher.vue'

const mod: PluginUiModule = {
  routes: [
    { path: '/marketing', redirect: '/marketing/business' },
    { path: '/marketing/business', component: () => import('./ui/pages/BusinessBrain.vue') },
    { path: '/marketing/knowledge', component: () => import('./ui/pages/KnowledgeBase.vue') },
    { path: '/marketing/advisor', component: () => import('./ui/pages/AdvisorPanel.vue') },
    { path: '/marketing/content', component: () => import('./ui/pages/ContentCenter.vue') },
    { path: '/marketing/hot', component: () => import('./ui/pages/HotCenter.vue') }
  ],
  nav: {
    id: 'marketing',
    label: '营销',
    order: 20,
    items: [
      { to: '/marketing/business', icon: '🏪', label: '商家大脑' },
      { to: '/marketing/knowledge', icon: '📚', label: '知识库' },
      { to: '/marketing/advisor', icon: '💬', label: 'AI 顾问（AI Advisor）' },
      { to: '/marketing/content', icon: '✍️', label: '内容中心（Content Center）' },
      { to: '/marketing/hot', icon: '🔥', label: '热点雷达' }
    ]
  },
  // 顶栏「当前商家」：切项目属于营销域的信息，跟着插件走（D4）
  slot: { topbar: ProjectSwitcher }
}

export default mod
