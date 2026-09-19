import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from '../App.vue'
import { createSetupGuard } from './setupGuard'
import '../assets/style.css'

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
    { path: '/channelsPage', component: () => import('../views/ChannelsPage.vue') },
    { path: '/terminal', component: () => import('../views/TerminalPage.vue') },
    { path: '/about', component: () => import('../views/About.vue') },
    { path: '/obsidian', component: () => import('../views/ObsidianPage.vue') },
    // 2.0 营销模块（Commit 01 全占位，后续提交逐页替换；内部路由/表名/文件名一律维持 hot*）
    {
      path: '/marketing/business',
      component: () => import('../views/marketing/BusinessBrain.vue'),
      meta: { title: '商家大脑', icon: '🏪' }
    },
    {
      path: '/marketing/knowledge',
      component: () => import('../views/marketing/KnowledgeBase.vue'),
      meta: { title: '知识库', icon: '📚' }
    },
    {
      path: '/marketing/advisor',
      component: () => import('../views/marketing/AdvisorPanel.vue'),
      meta: { title: 'AI Advisor', icon: '💬' }
    },
    {
      path: '/marketing/content',
      // Commit 09：占位页换真页（一次 3 版供选 → 编辑 → 版本 → 人工审核/发布标记）
      component: () => import('../views/marketing/ContentCenter.vue'),
      meta: { title: 'Content Center', icon: '✍️' }
    },
    {
      path: '/marketing/hot',
      // Commit 11：占位页换真页（近 24h 榜单 + 节点日历 + 数据源状态条；评分归 12）
      component: () => import('../views/marketing/HotCenter.vue'),
      meta: { title: '🔥 热点雷达', icon: '🔥' }
    }
  ]
})

/**
 * 首启 Setup 守卫（Commit 01 新增）——实现与判定口径见 `src/renderer/setupGuard.ts`
 */
router.beforeEach(createSetupGuard({ check: () => window.api.env.check() }))

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
