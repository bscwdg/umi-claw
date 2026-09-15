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
      component: () => import('../views/marketing/Placeholder.vue'),
      meta: { title: '商家大脑', icon: '🏪', desc: '商家基本盘：定位、客群、语气与行业字段', commit: 'Commit 04' }
    },
    {
      path: '/marketing/knowledge',
      component: () => import('../views/marketing/Placeholder.vue'),
      meta: { title: '知识库', icon: '📚', desc: '商家事实知识：套系、价目、FAQ 等资料入库与检索', commit: 'Commit 05' }
    },
    {
      path: '/marketing/advisor',
      component: () => import('../views/marketing/Placeholder.vue'),
      meta: { title: 'AI Advisor', icon: '💬', desc: '基于 Context Pack 的营销问答', commit: 'Commit 08' }
    },
    {
      path: '/marketing/content',
      component: () => import('../views/marketing/Placeholder.vue'),
      meta: { title: 'Content Center', icon: '✍️', desc: 'AI 生成 → 编辑 → 版本 → 人工审核发布', commit: 'Commit 09' }
    },
    {
      path: '/marketing/hot',
      component: () => import('../views/marketing/Placeholder.vue'),
      meta: { title: '🔥 热点雷达', icon: '🔥', desc: '全网热点榜单 + 商家相关度评分', commit: 'Commit 11/12' }
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
