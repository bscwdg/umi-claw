<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>插件管理</h1>
        <p class="text-muted">
          官方内置插件随安装包分发。停用后它的页面、导航与后台任务会立即卸载，数据保留。
        </p>
      </div>
      <button class="btn" :disabled="loading" @click="reload">刷新</button>
    </header>

    <p v-if="loadError" class="error-banner">
      {{ loadError }}
      <button class="btn btn-sm" @click="reload">重试</button>
    </p>

    <div v-if="!plugins.length && !loading && !loadError" class="empty">
      没有已登记的插件。把插件放到 <code>resources/plugins/&lt;id&gt;/</code> 并重新构建即可。
    </div>

    <!-- 宿主模块：内置在宿主里的能力，不参与插件装卸；这里只做统一入口 -->
    <h2 class="section-title">宿主模块</h2>
    <section class="plugin-card host-module-card">
      <div class="card-head">
        <div class="titles">
          <strong>🐟 大肥鱼</strong>
          <span class="text-muted">宿主模块 · 角色 M1</span>
        </div>
        <span class="state" :class="characterEnabled ? 'state-activated' : ''">
          {{ characterStateLabel }}
        </span>
      </div>

      <p class="meta">
        人格 / 聊天 / 关系 / 记忆 / 语音内置在宿主主进程，不随插件启停；
        自检 {{ characterReadyCount }}/{{ CHARACTER_CHECKS.length }} 项就绪。
      </p>

      <p v-if="characterError" class="error-line">{{ characterError }}</p>
      <p v-if="characterNotice" class="meta">{{ characterNotice }}</p>

      <div class="actions">
        <button
          class="btn"
          :class="{ 'btn-danger': characterEnabled, 'btn-primary': !characterEnabled }"
          :disabled="characterBusy || !characterStatus"
          @click="toggleCharacter"
        >
          {{ characterBusy ? '处理中…' : characterEnabled ? '停用' : '启用' }}
        </button>
        <router-link v-if="characterEnabled" class="btn btn-ghost" to="/character">
          打开页面
        </router-link>
        <button
          v-else
          class="btn btn-ghost"
          :disabled="characterBusy || !characterStatus"
          @click="enableAndOpen"
        >
          启用并打开
        </button>
        <button
          class="btn btn-ghost"
          :disabled="characterBusy || !characterStatus || !characterEnabled"
          @click="initCharacter"
        >
          一键初始化
        </button>
      </div>
    </section>

    <section v-for="p in list" :key="p.id" class="plugin-card">
      <div class="card-head">
        <div class="titles">
          <strong>{{ p.name }}</strong>
          <span class="text-muted">{{ p.id }} · v{{ p.version }}</span>
        </div>
        <span class="state" :class="'state-' + p.state">{{ stateLabel(p) }}</span>
      </div>

      <p class="meta">
        通道 {{ p.ipcMethods.length + (p.channels?.length ?? 0) }} 个 · 定时任务 {{ p.jobCount }} 个
        <template v-if="p.contributes?.routes?.length">
          · 页面 {{ p.contributes.routes.join('、') }}
        </template>
      </p>

      <p v-if="p.error" class="error-line">{{ errorSummary(p) }}</p>

      <div class="actions">
        <button
          class="btn"
          :class="{ 'btn-danger': p.enabled, 'btn-primary': !p.enabled }"
          :disabled="busy === p.id || enableBlocked(p)"
          @click="toggle(p)"
        >
          {{ busy === p.id ? '处理中…' : buttonText(p) }}
        </button>
        <router-link v-if="openableRoute(p)" class="btn btn-ghost" :to="openableRoute(p)">
          打开页面
        </router-link>
      </div>
    </section>

    <ConfirmDialog
      v-model:visible="confirmVisible"
      icon="⚠️"
      title="停用插件"
      confirm-text="停用"
      cancel-text="取消"
      danger
      @confirm="confirmDisable"
      @cancel="cancelDisable"
    >
      <p class="modal-message">{{ confirmMessage }}</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'
import type { PluginStatus } from '../../electron/main/kernel/lifecycle'
import type { CharacterStatus } from '../../electron/main/character/types'
import {
  errorSummary,
  normalizeListPayload,
  openableRoute,
  shouldConfirmDisable,
  sortForDisplay,
  stateLabel
} from '@/renderer/pluginAdmin'

const plugins = ref<PluginStatus[]>([])
const loading = ref(false)
const loadError = ref('')
const busy = ref('')
const confirmVisible = ref(false)
const confirmMessage = ref('')
let pendingDisable: PluginStatus | null = null
let unsubscribe: (() => void) | null = null
let disposed = false

const list = computed(() => sortForDisplay(plugins.value))

// ── 宿主模块：大肥鱼（内置在宿主里，不参与插件装卸；复用 character:* 通道） ──
const CHARACTER_CHECKS = [
  { key: 'agentReady', label: 'agent 配置' },
  { key: 'gatewayReady', label: '网关' },
  { key: 'obsidianReady', label: 'Obsidian' },
  { key: 'qqReady', label: '外部渠道' },
  { key: 'ttsReady', label: 'TTS' },
  { key: 'memorySearchReady', label: '记忆检索' }
] as const

const characterStatus = ref<CharacterStatus | null>(null)
const characterBusy = ref(false)
const characterError = ref('')
const characterNotice = ref('')
const router = useRouter()
const characterEnabled = computed(() => Boolean(characterStatus.value?.enabled))
const characterStateLabel = computed(() => {
  if (!characterStatus.value) return '状态未知'
  return characterStatus.value.enabled ? '已启用' : '未启用'
})
const characterReadyCount = computed(() => {
  const status = characterStatus.value as Record<string, unknown> | null
  if (!status) return 0
  return CHARACTER_CHECKS.filter((check) => Boolean(status[check.key])).length
})

async function loadCharacter(): Promise<void> {
  try {
    characterStatus.value = await window.api.character.status()
    characterError.value = ''
  } catch (e) {
    characterError.value = `读取大肥鱼状态失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function toggleCharacter(): Promise<void> {
  const next = !characterEnabled.value
  if (
    !next &&
    !window.confirm('停用后主动消息、日记会自动停止；关系与日记数据保留。确定停用大肥鱼？')
  ) {
    return
  }
  characterBusy.value = true
  characterError.value = ''
  characterNotice.value = ''
  try {
    await window.api.character.settings.set({ enabled: next } as never)
    await loadCharacter()
    if (!characterStatus.value) {
      characterNotice.value = '已提交，但读取状态失败，请点「刷新」确认'
      return
    }
    characterNotice.value = next ? '已启用；建议点「一键初始化」补齐配置' : '已停用（数据保留）'
  } catch (e) {
    characterError.value = `操作失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    characterBusy.value = false
  }
}

/** 停用状态下不做「静默打开」：先启用再进页面，语义与侧栏隐藏保持一致 */
async function enableAndOpen(): Promise<void> {
  if (characterEnabled.value) {
    void router.push('/character')
    return
  }
  characterBusy.value = true
  characterError.value = ''
  try {
    await window.api.character.settings.set({ enabled: true } as never)
    await loadCharacter()
    if (characterStatus.value?.enabled) {
      void router.push('/character')
    } else {
      characterNotice.value = '未能确认启用状态，请点「刷新」后再试'
    }
  } catch (e) {
    characterError.value = `启用失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    characterBusy.value = false
  }
}

async function initCharacter(): Promise<void> {
  characterBusy.value = true
  characterError.value = ''
  characterNotice.value = ''
  try {
    const report = await window.api.character.bootstrap.run()
    const failed = report.steps.filter((step) => !step.ok).length
    characterNotice.value = report.ok
      ? '初始化完成'
      : `初始化有 ${failed} 项未通过，去「大肥鱼」页查看并去配置`
    await loadCharacter()
  } catch (e) {
    characterError.value = `初始化失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    characterBusy.value = false
  }
}

/** 清单级失败不能靠「启用」复活，按钮直接禁用；运行时失败允许重试 */
function enableBlocked(status: PluginStatus): boolean {
  return !status.enabled && status.error?.stage === 'manifest'
}

function buttonText(status: PluginStatus): string {
  if (status.enabled) return '停用'
  return status.state === 'failed' ? '重试启用' : '启用'
}

async function reload(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    plugins.value = normalizeListPayload(await window.api.plugins.list())
  } catch (e) {
    loadError.value = `读取插件列表失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    loading.value = false
  }
}

async function applyToggle(status: PluginStatus, enabled: boolean): Promise<void> {
  busy.value = status.id
  try {
    plugins.value = normalizeListPayload(await window.api.plugins.setEnabled(status.id, enabled))
  } catch (e) {
    loadError.value = `操作失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = ''
  }
}

async function toggle(status: PluginStatus): Promise<void> {
  if (!status.enabled) {
    await applyToggle(status, true)
    return
  }
  if (shouldConfirmDisable(status)) {
    pendingDisable = status
    confirmMessage.value = `「${status.name}」正在运行，停用后它的页面会被关闭。确定停用？`
    confirmVisible.value = true
    return
  }
  await applyToggle(status, false)
}

async function confirmDisable(): Promise<void> {
  confirmVisible.value = false
  const target = pendingDisable
  pendingDisable = null
  if (!target) return
  await applyToggle(target, false)
}

function cancelDisable(): void {
  pendingDisable = null
  confirmVisible.value = false
}

onMounted(async () => {
  // 先订阅再拉列表：否则首屏加载期间的 plugin:changed 会丢（审查 P2-9）
  unsubscribe = window.api.plugins.onChanged((next: PluginStatus[]) => {
    try {
      plugins.value = normalizeListPayload(next)
    } catch {
      // 推送不合法就保持现状，等用户手动刷新
    }
  })
  if (disposed) {
    unsubscribe?.()
    unsubscribe = null
    return
  }
  await reload()
  await loadCharacter()
})

onUnmounted(() => {
  disposed = true
  unsubscribe?.()
  unsubscribe = null
})
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.plugin-card {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 12px;
  background: var(--card-bg, #fff);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.titles {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.meta {
  margin: 6px 0 10px;
  color: var(--text-muted, #6b7280);
  font-size: 13px;
}
.state {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #eef2ff;
  color: #4338ca;
}
.state-failed {
  background: #fef2f2;
  color: #b91c1c;
}
.state-activated {
  background: #ecfdf5;
  color: #047857;
}
.error-line {
  color: #b91c1c;
  font-size: 13px;
  margin: 0 0 10px;
}
.error-banner {
  color: #b91c1c;
  margin-bottom: 12px;
}
.empty {
  color: var(--text-muted, #6b7280);
  padding: 24px 0;
}
.actions {
  display: flex;
  gap: 8px;
}
.section-title {
  margin: 18px 0 10px;
  font-size: 15px;
  color: var(--text-muted, #6b7280);
  font-weight: 600;
}
.host-module-card {
  border-style: dashed;
}
</style>
