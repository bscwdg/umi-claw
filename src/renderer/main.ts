import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from '../App.vue'
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
    { path: '/voice', component: () => import('../views/voice/VoicePage.vue') },
    { path: '/channelsPage', component: () => import('../views/ChannelsPage.vue') },
    { path: '/terminal', component: () => import('../views/TerminalPage.vue') },
    { path: '/about', component: () => import('../views/About.vue') },
    { path: '/obsidian', component: () => import('../views/ObsidianPage.vue') },
    // ── work 域（3.0 UI）──
    { path: '/work', redirect: '/work/today' },
    { path: '/work/today', component: () => import('../views/work/TodayPage.vue') },
    { path: '/work/records', component: () => import('../views/work/RecordsPage.vue') },
    { path: '/work/qa', component: () => import('../views/work/QaPage.vue') },
    { path: '/work/reports', component: () => import('../views/work/ReportsPage.vue') },
    { path: '/work/tools', component: () => import('../views/work/ToolsPage.vue') },
    { path: '/work/knowledge', component: () => import('../views/work/KnowledgePage.vue') },
    { path: '/work/context', component: () => import('../views/work/ContextPage.vue') },
    { path: '/work/settings', component: () => import('../views/work/SettingsPage.vue') },
    // ── marketing 域（2.0 UI）──
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
      meta: { title: 'AI 顾问（AI Advisor）', icon: '💬' }
    },
    {
      path: '/marketing/content',
      component: () => import('../views/marketing/ContentCenter.vue'),
      meta: { title: '内容中心（Content Center）', icon: '✍️' }
    },
    {
      path: '/marketing/hot',
      component: () => import('../views/marketing/HotCenter.vue'),
      meta: { title: '热点雷达', icon: '🔥' }
    }
  ]
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
