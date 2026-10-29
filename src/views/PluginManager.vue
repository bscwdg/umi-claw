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

    <p v-if="loadError" class="error-banner">{{ loadError }}</p>

    <div v-if="!plugins.length && !loading" class="empty">
      没有已登记的插件。把插件放到 <code>resources/plugins/&lt;id&gt;/</code> 并重新构建即可。
    </div>

    <section v-for="p in plugins" :key="p.id" class="plugin-card">
      <div class="card-head">
        <div class="titles">
          <strong>{{ p.name }}</strong>
          <span class="text-muted">{{ p.id }} · v{{ p.version }}</span>
        </div>
        <span class="state" :class="'state-' + p.state">{{ stateLabel(p) }}</span>
      </div>

      <p class="meta">
        通道 {{ p.ipcMethods.length }} 个 · 定时任务 {{ p.jobCount }} 个
        <template v-if="p.contributes?.routes?.length">
          · 页面 {{ p.contributes.routes.join('、') }}
        </template>
      </p>

      <p v-if="p.error" class="error-line">{{ errorSummary(p) }}</p>

      <div class="actions">
        <button
          class="btn"
          :class="{ 'btn-danger': p.enabled, 'btn-primary': !p.enabled }"
          :disabled="busy === p.id || p.state === 'failed'"
          @click="toggle(p)"
        >
          {{ busy === p.id ? '处理中…' : p.enabled ? '停用' : '启用' }}
        </button>
        <router-link v-if="firstRoute(p)" class="btn btn-ghost" :to="firstRoute(p)">打开页面</router-link>
      </div>
    </section>

    <ConfirmDialog
      v-model:visible="confirmVisible"
      icon="⚠️"
      title="停用插件"
      confirm-text="停用并离开"
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
import {
  disablingBreaksCurrentPage,
  errorSummary,
  sortForDisplay,
  stateLabel
} from '@/renderer/pluginAdmin'

const router = useRouter()
const plugins = ref<PluginStatus[]>([])
const loading = ref(false)
const loadError = ref('')
const busy = ref('')
const confirmVisible = ref(false)
const confirmMessage = ref('')
let pendingDisable: PluginStatus | null = null
let unsubscribe: (() => void) | null = null

const list = computed(() => sortForDisplay(plugins.value))

async function reload(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    plugins.value = await window.api.plugins.list()
  } catch (e) {
    loadError.value = `读取插件列表失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    loading.value = false
  }
}

function firstRoute(status: PluginStatus): string {
  return status.contributes?.routes?.[0] ?? ''
}

async function applyToggle(status: PluginStatus, enabled: boolean): Promise<void> {
  busy.value = status.id
  try {
    plugins.value = await window.api.plugins.setEnabled(status.id, enabled)
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

  // 停用会拆掉脚下的页面 → 先问一句（D5）
  if (disablingBreaksCurrentPage(status, router.currentRoute.value.path)) {
    pendingDisable = status
    confirmMessage.value = `「${status.name}」正在被当前页面使用，停用后这个页面会关闭。确定停用？`
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
  if (router.currentRoute.value.path !== '/plugins') {
    void router.replace('/dashboard').catch(() => undefined)
  }
}

function cancelDisable(): void {
  pendingDisable = null
  confirmVisible.value = false
}

onMounted(async () => {
  await reload()
  unsubscribe = window.api.plugins.onChanged((next: PluginStatus[]) => {
    plugins.value = next
  })
})

onUnmounted(() => {
  unsubscribe?.()
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
</style>
