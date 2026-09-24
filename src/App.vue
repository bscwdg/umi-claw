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
          <!-- 工作域导航（3.0） -->
        <div class="nav-group-label">工作</div>
        <router-link v-for="item in workNavItems" :key="item.to" :to="item.to" class="nav-item">
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </router-link>

        <div class="nav-group-label">管理</div>
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

    <!-- 用户协议弹窗（全局唯一实例）：首启为阻断模式，设置页打开为复核模式 -->
    <UserAgreementModal
      v-model:visible="agreementVisible"
      :blocking="agreementBlocking"
      :agreed="consentGranted"
      :agreed-at="consentAt"
      @agreed="onAgreementAgreed"
    />

    <!-- 冷启动向导（弹窗形态；走完或逐步跳过才关，只出现一次） -->
    <WizardModal v-model:visible="wizardVisible" @done="onWizardDone" />

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
import { useRouter } from 'vue-router'
import { useClawStore } from '@/stores/claw'
import { useConfigStore } from '@/stores/config'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'
import UserAgreementModal from '@/views/components/UserAgreementModal.vue'
import WizardModal from '@/views/components/WizardModal.vue'
import { wizardVisible } from '@/composables/useWizardGate'
import {
  agreementVisible,
  agreementBlocking,
  consentGranted,
  consentAt,
  openAgreementBlocking,
  syncConsent
} from '@/composables/useAgreementGate'

const api = window.api
const router = useRouter()
const clawStore = useClawStore()
const configStore = useConfigStore()
const version = ref('')

const workNavItems = [
  { to: '/work/today', icon: '☀️', label: '新的一天' },
  { to: '/work/records', icon: '🗂', label: '工作记录' },
  { to: '/work/qa', icon: '💬', label: '工作问答' },
  { to: '/work/reports', icon: '📊', label: '报告' },
  { to: '/work/tools', icon: '🧰', label: '工具箱' },
  { to: '/work/knowledge', icon: '📚', label: '工作知识库' },
  { to: '/work/context', icon: '🔍', label: 'AI的世界' },
  { to: '/work/settings', icon: '⚙️', label: '工作设置' }
]

const navItems = [
  { to: '/dashboard', icon: '🏠', label: '控制台' },
  { to: '/config',    icon: '⚙️', label: '模型配置' },
  { to: '/skills',    icon: '🧩', label: '技能管理' },
  { to: '/logs',      icon: '📋', label: '运行日志' },
  { to: '/setup',     icon: '🔧', label: '环境初始化' },
  { to: '/channelsPage',     icon: '📩', label: '渠道接入' },
  { to: '/terminal',     icon: '💻', label: 'OpenClaw终端' },
  { to: '/obsidian',     icon: '📚', label: '知识库' },
  { to: '/about',     icon: 'ℹ️', label: '关于' }
]

let cleanup: (() => void) | null = null
let closeCleanup: (() => void) | null = null

// 关闭确认对话框状态
const showCloseConfirm = ref(false)
const rememberCloseChoice = ref(false)

// 首启用户协议（阻断式）—— 状态在 useAgreementGate 里共享（设置页也读同一份）
const agreementBusy = ref(false)

function onCloseConfirmExit() {
  api.window.resolveClose('exit', rememberCloseChoice.value)
}

function onCloseConfirmTray() {
  api.window.resolveClose('tray', rememberCloseChoice.value)
}

onMounted(async () => {
  // §八 Day1：首启先过用户协议（阻断式，只出现一次）。
  // 不 await：弹窗在状态回来后自己弹，绝不阻塞应用启动（硬规则 17）。
  void ensureFirstRunWizard()
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

/**
 * 首启流程（北 2026-09-24 定）：
 * 1. 未同意用户协议 → 弹**阻断式**弹窗，必须同意才能用应用（只出现一次）
 * 2. 已同意但向导未完成 → 进向导补齐其余可选步骤
 *
 * 硬规则 17：读取失败不阻断启动（按已同意处理，绝不把用户锁在门外）。
 */
async function ensureFirstRunWizard(): Promise<void> {
  try {
    const status = await api.work.wizard.status()
    syncConsent(status.consent, status.consentAt ?? null)
    if (!status.consent) {
      // 阻断：不同意就不能用
      openAgreementBlocking()
      return
    }
    if (!status.completed) {
      // 向导改为弹窗（北 2026-09-24）：不再跳路由，只开弹窗
      wizardVisible.value = true
    }
  } catch {
    // 读取失败不阻断：按原流程进控制台
  }
}

/** 向导弹窗关闭（完成态）：进「今日」 */
function onWizardDone(): void {
  router.push('/work/today')
}

/** 同意用户协议：落库 → 关弹窗 → 继续首启向导（如未完成） */
async function onAgreementAgreed(): Promise<void> {
  if (agreementBusy.value) return
  agreementBusy.value = true
  try {
    const res = await api.work.wizard.grantConsent()
    syncConsent(true, res?.consentAt ?? Date.now())
    agreementVisible.value = false
    // 同意后继续走完向导其余步骤（弹窗，不跳路由）
    const status = await api.work.wizard.status()
    if (!status.completed) wizardVisible.value = true
  } catch {
    // 保存失败：弹窗保持打开，用户可重试
  } finally {
    agreementBusy.value = false
  }
}
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
  /* 让内部 .nav 自己滚，状态胶囊与底部按钮固定可见 */
  overflow: hidden;
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
/* 导航项多于一屏时必须可滚动：父级 .app-body 是 overflow:hidden，
   缺 overflow-y 会被直接裁掉（无滚动条）。min-height:0 是 flex 子项能收缩出
   滚动区的前提（默认 min-height:auto 会撑破容器）。 */
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 滚动条不挤压内容，避免导航文字在出现滚动条时换行 */
  scrollbar-gutter: stable;
}
.nav-group-label {
  font-size: 11px; color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.06em; padding: 10px 12px 4px;
}
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
