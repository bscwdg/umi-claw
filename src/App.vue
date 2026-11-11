<template>
  <!-- 桌宠窗口：只渲染裸页面，不套主壳（透明、无标题栏、无侧栏） -->
  <template v-if="isPetWindow">
    <router-view />
  </template>
  <div v-else class="app-shell">
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

    <!-- 4.0.2 P2：旧库导入失败横幅（可见 + 一键重试；成功后自动消失） -->
    <div v-for="f in importFailures" :key="f.pluginId" class="alert alert-warning app-banner">
      <span class="import-banner-text">
        旧数据导入失败（{{ f.pluginId }}）：{{ f.error || '未知错误' }}
      </span>
      <button class="btn btn-sm" :disabled="importRetrying === f.pluginId" @click="retryImport(f.pluginId)">
        {{ importRetrying === f.pluginId ? '重试中…' : '重试导入' }}
      </button>
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

        <!-- 顶栏插件插槽：营销域的「当前商家」切换器随插件启停（Phase 3 装箱） -->
        <template
          v-for="(slotComp, slotIndex) in pluginSlots.topbar ?? []"
          :key="'topbar-' + (slotComp?.name || slotComp?.__name || slotIndex)"
        >
          <component :is="slotComp" />
        </template>

        <!-- 导航（分组：工作 / 控制台 / 营销 / OpenClaw / 系统） -->
        <nav class="nav">
          <template v-for="group in allNavGroups" :key="group.id">
            <div class="nav-group-label">{{ group.title }}</div>
            <router-link
              v-for="item in group.items"
              :key="item.to"
              :to="item.to"
              class="nav-item"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span class="nav-label">{{ item.label }}</span>
            </router-link>
          </template>
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

    <!-- 4.2 B2：便携 Node 写入探针失败横幅（低完整性/目录只读时数据库会写不进去 -->
    <div v-if="runtimeProbeBanner" class="alert alert-warning app-banner">
      <span class="import-banner-text">
        {{ runtimeProbeBanner.message }}
      </span>
      <button
        class="btn btn-sm"
        :disabled="runtimeReinstalling"
        @click="reinstallRuntime"
      >
        {{ runtimeReinstalling ? '重装中…' : '重装运行环境' }}
      </button>
    </div>

    <!-- 冷启动向导（弹窗形态；走完或逐步跳过才关，只出现一次） -->
    <WizardModal v-if="workPluginEnabled" v-model:visible="wizardVisible" @done="onWizardDone" />

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
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useClawStore } from '@/stores/claw'
import { useConfigStore } from '@/stores/config'
import { pluginNavGroups, pluginSlots, isPluginEnabled } from '@/renderer/pluginUi'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'
import UserAgreementModal from '@/views/components/UserAgreementModal.vue'
import WizardModal from '@/views/components/WizardModal.vue'
import { wizardVisible } from '@/composables/useWizardGate'
import { useToast } from '@/composables/useToast'
import {
  agreementVisible,
  agreementBlocking,
  consentGranted,
  consentAt,
  openAgreementBlocking,
  syncConsent
} from '@/composables/useAgreementGate'

const api = window.api
const { toast: appToast, showToast } = useToast()
// work 插件是否已启用且已激活：决定向导弹窗能否挂载（停用/激活失败时 work:* 通道不存在）
const workPluginEnabled = computed(() => isPluginEnabled('work'))
const router = useRouter()
// 桌宠窗口复用同一个渲染端入口：按路由切成裸页面，不加载主壳（工具栏/侧栏/弹窗都不该出现在透明窗口里）
const isPetWindow = computed(() => router.currentRoute.value.path === '/character-pet')
const clawStore = useClawStore()
const configStore = useConfigStore()
const version = ref('')
// 4.0.2 P2：旧库导入失败可见 + 重试入口（宿主壳全局横幅）
type ImportFailure = { pluginId: string; error?: string; at: number }
const importFailures = ref<ImportFailure[]>([])
// 4.2 B2：便携 Node 写入探针失败时的横幅（低完整性 / 目录只读 → 数据库写不进去）
const runtimeProbeBanner = ref<{ message: string } | null>(null)
const runtimeReinstalling = ref(false)

/** 读一次探针结果；失败才显示横幅（成功静默） */
async function refreshRuntimeProbe(): Promise<void> {
  try {
    const probe = await api.env.runtimeProbe()
    if (!probe || probe.ok) {
      runtimeProbeBanner.value = null
      return
    }
    const reason =
      probe.reason === 'timeout'
        ? '运行环境探测超时（可能是安全软件或慢盘）'
        : '运行环境可能被限制写入（低完整性/目录只读），数据将无法保存'
    runtimeProbeBanner.value = {
      message: `${reason}。${probe.detail ? `（${probe.detail}）` : ''}`
    }
  } catch {
    // 探测本身失败不打扰用户：横幅是增强提示，不是主流程
  }
}

/** 一键重装运行环境：复用既有的 env:update（会先停网关、装完恢复） */
async function reinstallRuntime(): Promise<void> {
  if (runtimeReinstalling.value) return
  runtimeReinstalling.value = true
  try {
    const res = await api.env.update({})
    if (res?.success) {
      showToast('运行环境已重装，重启应用后生效', 'success')
      runtimeProbeBanner.value = null
    } else {
      showToast(`重装失败：${res?.error ?? '未知错误'}`, 'error')
    }
  } catch (e: any) {
    showToast(`重装失败：${e?.message ?? e}`, 'error')
  } finally {
    runtimeReinstalling.value = false
  }
}
const importRetrying = ref('')
let importPollTimer: ReturnType<typeof setInterval> | null = null

async function refreshImportStatus(): Promise<void> {
  try {
    const rows = await (window.api as { pluginImports?: { status?: () => Promise<ImportFailure[]> } })
      .pluginImports?.status?.()
    if (!Array.isArray(rows)) return
    importFailures.value = rows
      .filter((r) => r && r.state === 'failed')
      .map((r) => ({ pluginId: r.pluginId, error: r.error, at: r.at }))
  } catch {
    // 横幅是增强提示，读不到状态不影响主流程
  }
}

async function retryImport(pluginId: string): Promise<void> {
  importRetrying.value = pluginId
  try {
    await (window.api as { pluginImports?: { retry?: (id: string) => Promise<boolean> } })
      .pluginImports?.retry?.(pluginId)
  } catch (e) {
    console.warn('[App] 旧库导入重试失败：', e)
  } finally {
    importRetrying.value = ''
    void refreshImportStatus()
  }
}

// 分组导航：work 组来自 3.0，营销组来自 2.0；`/dashboard` 标签已拍板为「控制台」，
// `/skills` 标签已拍板为「能力中心」（2026-10-30）。
// 大肥鱼停用后自动隐藏侧栏入口（仍可从「插件管理 → 宿主模块」重新启用）。
const characterNavKnown = ref(false)
const characterNavEnabled = ref(true)
const navGroups = computed(() => [
  // 工作域导航由 plugins/work/renderer.ts 贡献（Phase 2 装箱）

  {
    title: '控制台',
    items: [{ to: '/dashboard', icon: '🏠', label: '控制台' }]
  },
  // 营销域导航由 plugins/marketing/renderer.ts 贡献（Phase 3 装箱）
  {
    title: 'OpenClaw',
    items: [
      { to: '/config', icon: '⚙️', label: '模型配置' },
      { to: '/voice', icon: '🔊', label: '语音设置' },
      ...(characterNavKnown.value && !characterNavEnabled.value
        ? []
        : [{ to: '/character', icon: '🐟', label: '大肥鱼' }]),
      { to: '/skills', icon: '🧩', label: '能力中心' },
      { to: '/channelsPage', icon: '📩', label: '渠道接入' },
      { to: '/terminal', icon: '💻', label: 'OpenClaw终端' },
      { to: '/obsidian', icon: '📚', label: '知识库' },
      { to: '/setup', icon: '🔧', label: '环境初始化' }
    ]
  },
  {
    title: '系统',
    items: [
      { to: '/plugins', icon: '🧩', label: '插件管理' },
      { to: '/logs', icon: '📋', label: '运行日志' },
      { to: '/about', icon: 'ℹ️', label: '关于' }
    ]
  }
])

// 插件导航组排在内核导航之后。两组来源字段不同（内核只有 title，插件有 id/label），
// 这里统一成 { id, title, items }：key 用 id（多个插件组不会撞 key），显示用 title。
const allNavGroups = computed(() => [
  ...navGroups.value.map((g) => ({ id: `core:${g.title}`, title: g.title, items: g.items })),
  ...pluginNavGroups.value.map((g) => ({ id: `plugin:${g.id}`, title: g.label, items: g.items }))
])

let cleanup: (() => void) | null = null
let closeCleanup: (() => void) | null = null
let autoSpeakCleanup: (() => void) | null = null
let characterCleanup: (() => void) | null = null
let characterNavCleanup: (() => void) | null = null

/** 大肥鱼启用状态 → 侧栏入口显隐（停用后隐藏；仍可从插件管理卡片重新启用） */
async function refreshCharacterNav(): Promise<void> {
  try {
    const status = await api.character.status()
    characterNavKnown.value = true
    characterNavEnabled.value = Boolean(status.enabled)
  } catch {
    // 模块未就绪/未注册：保持默认显示，让用户能进页面看到具体错误
  }
}

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
  // 桌宠窗口走裸布局：主壳副作用（协议/向导/监听）一律不跑
  if (isPetWindow.value) return
  // 桌宠右键菜单「聊两句/设置」→ 主窗跳到大肥鱼页
  characterCleanup = api.character.onOpenPage(() => {
    void router.push('/character')
  })
  // 侧栏「🐟 大肥鱼」入口跟随启用状态：停用后自动隐藏（插件管理卡片仍可启用）
  void refreshCharacterNav()
  // 4.0.2 P2：启动时检查旧库导入是否失败；导入是后台跑，短轮询到失败出现或 16s 后停
  void refreshImportStatus()
  // 4.2 B2：便携 Node 写入探针在宿主启动后异步跑，这里短轮询两次把结果取回来
  void refreshRuntimeProbe()
  setTimeout(() => void refreshRuntimeProbe(), 3000)
  let importPolls = 0
  importPollTimer = setInterval(() => {
    importPolls += 1
    if (importFailures.value.length > 0 || importPolls >= 8) {
      if (importPollTimer) clearInterval(importPollTimer)
      importPollTimer = null
      return
    }
    void refreshImportStatus()
  }, 2000)
  // 初始化慢/失败时 status 可能读不到：短轮询直到拿到结果，避免停用入口一直显示
  const navRetryTimer = setInterval(() => {
    if (characterNavKnown.value) {
      clearInterval(navRetryTimer)
      return
    }
    void refreshCharacterNav()
  }, 2000)
  const onFocusRefresh = (): void => {
    void refreshCharacterNav()
  }
  window.addEventListener('focus', onFocusRefresh)
  const offNavEvent = api.character.onEvent((event) => {
    if (event.type === 'settings' || event.type === 'reset') void refreshCharacterNav()
  })
  characterNavCleanup = () => {
    offNavEvent()
    clearInterval(navRetryTimer)
    window.removeEventListener('focus', onFocusRefresh)
    characterNavCleanup = null
  }
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
  autoSpeakCleanup = api.fish.voice.autoSpeak.on(async (event) => {
    try {
      const payload = await api.fish.voice.audio(event.audioId)
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(payload.bytes)], { type: event.mime || payload.mime })
      )
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      await audio.play()
    } catch {
      // 自动朗读失败不能影响通知和主流程
    }
  })
})

onUnmounted(() => {
  if (importPollTimer) clearInterval(importPollTimer)
  importPollTimer = null
  cleanup?.()
  closeCleanup?.()
  autoSpeakCleanup?.()
  characterCleanup?.()
  characterNavCleanup?.()
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
    // 协议状态走**宿主通道**：work 停用时 `work:wizard:status` 没有 handler，
    // 盲调会抛 No handler registered，且协议弹窗会静默不弹（真实缺陷）。
    const status = await api.consent.status()
    syncConsent(status.consent, status.consentAt ?? null)
    if (!status.consent) {
      // 阻断：不同意就不能用
      openAgreementBlocking()
      return
    }
    // 向导属于 work 插件：未启用/未激活时不查询（否则同样是 No handler registered）。
    // 4.2 复核补修：不读共享 ref（plugins.list 是独立 IIFE，首启可能还没回来），
    // 直接查一次状态，避免首启竞态导致向导要等下次启动。
    if (!(await isWorkPluginActive())) return
    const wizard = await api.work.wizard.status()
    if (!wizard.completed) {
      // 向导改为弹窗（北 2026-09-24）：不再跳路由，只开弹窗
      wizardVisible.value = true
    }
  } catch {
    // 读取失败不阻断：按原流程进控制台
  }
}

/** work 是否真的可调：启用 + 已激活（激活失败时通道不存在） */
async function isWorkPluginActive(): Promise<boolean> {
  try {
    const statuses = await api.plugins.list()
    return statuses.some((p) => p.id === 'work' && p.enabled && p.state === 'activated')
  } catch {
    // 插件子系统异常时退回共享状态（有 v-if 挂载兜底，不会盲调）
    return isPluginEnabled('work')
  }
}

/** 向导弹窗关闭（完成态）：进「今日」 */
function onWizardDone(): void {
  // work 是插件：停用/激活失败时该路由不存在，跳宿主控制台更稳（审查 P2-11）
  router.push('/dashboard')
}

/** 同意用户协议：落库 → 关弹窗 → 继续首启向导（如未完成） */
async function onAgreementAgreed(): Promise<void> {
  if (agreementBusy.value) return
  agreementBusy.value = true
  try {
    const res = await api.consent.grant()
    syncConsent(true, res?.consentAt ?? Date.now())
    agreementVisible.value = false
    // 同意后继续走完向导其余步骤（弹窗，不跳路由）；work 未启用则只落协议
    if (!(await isWorkPluginActive())) return
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
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.titlebar-left { display: flex; align-items: center; gap: var(--space-2); }
.app-logo { font-size: var(--text-lg); }
.app-name { font-size: var(--text-sm); font-weight: 600; color: var(--text-secondary); }
.titlebar-right { display: flex; align-items: center; gap: 2px; }
/* 标题栏窗口控制钮属全局 .btn 体系之外的特例，保留 .title-btn 类名 */
.title-btn {
  width: 32px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.title-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
.close-btn:hover { background: var(--danger); color: var(--text-on-accent); }

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
  padding: var(--space-4) var(--space-3);
  gap: var(--space-4);
  flex-shrink: 0;
  /* 让内部 .nav 自己滚，状态胶囊与底部按钮固定可见 */
  overflow: hidden;
}
.status-pill {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  transition: all var(--duration-normal);
}
.status-pill.active {
  background: var(--success-muted);
  border-color: var(--success-border);
  color: var(--success);
}
.status-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
  transition: all var(--duration-normal);
}
.status-pill.active .status-dot {
  background: var(--success);
  box-shadow: 0 0 6px var(--success);
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
  font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.06em; padding: var(--space-3) var(--space-3) var(--space-1);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 9px var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: var(--text-sm);
  font-weight: 500;
  transition: all var(--duration-fast);
}
.nav-item:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}
.nav-item.router-link-active {
  background: var(--accent-muted);
  color: var(--accent);
}
.nav-icon { font-size: var(--text-md); width: 20px; text-align: center; }

.sidebar-footer {
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-muted);
  display: flex;
  justify-content: space-between;
}

/* Content */
.content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-6);
}

/* 4.0.2 P2：全局横幅吃 .alert.alert-warning；.app-banner 仅补「贴边全宽、无圆角」形态 */
.app-banner {
  border-radius: 0;
  justify-content: space-between;
}
.import-banner-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 关闭确认对话框：记住选择 */
.close-remember {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  font-size: var(--text-sm);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.close-remember input {
  cursor: pointer;
}
</style>