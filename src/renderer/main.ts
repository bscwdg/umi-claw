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
    { path: '/channelsPage', component: () => import('../views/ChannelsPage.vue') },
    { path: '/terminal', component: () => import('../views/TerminalPage.vue') },
    { path: '/about', component: () => import('../views/About.vue') },
    { path: '/obsidian', component: () => import('../views/ObsidianPage.vue') }
  ]
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
