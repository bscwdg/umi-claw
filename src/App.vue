<template>
  <div class="app-shell">
    <!-- 自定义标题栏 -->
    <div class="titlebar drag-region">
      <div class="titlebar-left no-drag">
        <span class="app-logo">🦞</span>
        <span class="app-name">Umi Claw</span>
      </div>
      <div class="titlebar-right no-drag">
        <button class="title-btn" @click="api.window.minimize()">
          <svg width="10" height="1" viewBox="0 0 10 1"><line x1="0" y1="0.5" x2="10" y2="0.5" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="title-btn" @click="api.window.maximize()">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="title-btn close-btn" @click="api.window.close()">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>

    <!-- 主体 -->
    <div class="app-body">
      <!-- 侧边栏 -->
      <aside class="sidebar">
        <!-- 状态指示器 -->
        <div class="status-pill" :class="{ active: clawStore.running }">
          <span class="status-dot"></span>
          {{ clawStore.running ? 'OpenClaw 运行中' : 'OpenClaw 已停止' }}
        </div>

        <!-- 导航 -->
        <nav class="nav">
          <router-link v-for="item in navItems" :key="item.to" :to="item.to" class="nav-item">
            <span class="nav-icon">{{ item.icon }}</span>
            <span class="nav-label">{{ item.label }}</span>
          </router-link>
        </nav>

        <!-- 底部信息 -->
        <div class="sidebar-footer">
          <div class="text-sm text-muted">v{{ version }}</div>
          <div v-if="clawStore.uptime" class="text-sm text-muted">
            运行 {{ clawStore.uptime }}
          </div>
        </div>
      </aside>

      <!-- 内容区 -->
      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- 关闭窗口确认 -->
    <ConfirmDialog
      v-model:visible="showCloseConfirm"
      icon="⚠️"
      title="关闭 Umi Claw"
      confirm-text="退出应用"
      cancel-text="最小化到托盘"
      danger
      @confirm="onCloseConfirmExit"
      @cancel="onCloseConfirmTray"
    >
      <p class="modal-message">关闭窗口后希望如何处理？</p>
      <label class="close-remember">
        <input type="checkbox" v-model="rememberCloseChoice" />
        <span>记住我的选择，不再询问</span>
      </label>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useClawStore } from '@/stores/claw'
import { useConfigStore } from '@/stores/config'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'

const api = window.api
const clawStore = useClawStore()
const configStore = useConfigStore()
const version = ref('')

const navItems = [
  { to: '/dashboard', icon: '🏠', label: '控制台' },
  { to: '/config',    icon: '⚙️', label: '模型配置' },
  { to: '/skills',    icon: '🧩', label: '技能管理' },
  { to: '/logs',      icon: '📋', label: '运行日志' },
  { to: '/setup',     icon: '🔧', label: '环境初始化' },
  { to: '/channelsPage',     icon: '📩', label: '渠道接入' },
  { to: '/terminal',     icon: '💻', label: 'OpenClaw终端' },
  { to: '/about',     icon: 'ℹ️', label: '关于' }
]

let cleanup: (() => void) | null = null
let closeCleanup: (() => void) | null = null

// 关闭确认对话框状态
const showCloseConfirm = ref(false)
const rememberCloseChoice = ref(false)

function onCloseConfirmExit() {
  api.window.resolveClose('exit', rememberCloseChoice.value)
}

function onCloseConfirmTray() {
  api.window.resolveClose('tray', rememberCloseChoice.value)
}

onMounted(async () => {
  await Promise.all([configStore.load(), clawStore.fetchStatus()])
  version.value = await api.app.getVersion()
  cleanup = clawStore.setupListeners()
  // 主进程请求关闭时弹出确认框
  closeCleanup = api.window.onCloseRequest(() => {
    rememberCloseChoice.value = false
    showCloseConfirm.value = true
  })
})

onUnmounted(() => {
  cleanup?.()
  closeCleanup?.()
})
</script>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-base);
}

/* Titlebar */
.titlebar {
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.titlebar-left { display: flex; align-items: center; gap: 8px; }
.app-logo { font-size: 16px; }
.app-name { font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.titlebar-right { display: flex; align-items: center; gap: 2px; }
.title-btn {
  width: 32px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.title-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
.close-btn:hover { background: var(--red); color: #fff; }

/* Body */
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Sidebar */
.sidebar {
  width: var(--sidebar-w);
  background: var(--bg-surface);
  border-right: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  gap: 16px;
  flex-shrink: 0;
}
.status-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  transition: all 0.3s;
}
.status-pill.active {
  background: rgba(63,185,80,0.08);
  border-color: rgba(63,185,80,0.3);
  color: var(--green);
}
.status-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
  transition: all 0.3s;
}
.status-pill.active .status-dot {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Nav */
.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
}
.nav-item:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}
.nav-item.router-link-active {
  background: var(--accent-muted);
  color: var(--accent);
}
.nav-icon { font-size: 15px; width: 20px; text-align: center; }

.sidebar-footer {
  padding-top: 8px;
  border-top: 1px solid var(--border-muted);
  display: flex;
  justify-content: space-between;
}

/* Content */
.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

/* 关闭确认对话框：记住选择 */
.close-remember {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.close-remember input {
  cursor: pointer;
}
</style>
