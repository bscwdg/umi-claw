<template>
  <div class="page-container logs-page">
    <div class="page-header">
      <div>
        <h1>运行日志</h1>
        <p class="text-muted text-sm" style="margin-top:4px">OpenClaw 实时输出日志</p>
      </div>
      <div class="flex gap-2">
        <label class="toggle-wrap">
          <label class="toggle">
            <input type="checkbox" v-model="autoScroll" />
            <span class="toggle-slider"></span>
          </label>
          <span class="text-sm text-muted">自动滚动</span>
        </label>
        <select class="form-select" v-model="filterType" style="width:120px">
          <option value="all">全部</option>
          <option value="stdout">标准输出</option>
          <option value="stderr">错误输出</option>
          <option value="system">系统</option>
        </select>
        <button class="btn" @click="clearLogs">🗑 清空</button>
        <button class="btn" @click="exportLogs">⬇ 导出</button>
      </div>
    </div>

    <!-- Stats Bar -->
    <div class="stats-bar">
      <span class="badge badge-blue">共 {{ filteredLogs.length }} 条</span>
      <span class="badge badge-red">错误 {{ errorCount }}</span>
      <span class="badge badge-yellow">系统 {{ systemCount }}</span>
    </div>

    <!-- Log Viewer -->
    <div class="log-viewer" ref="logViewerRef">
      <div
        v-for="(entry, i) in filteredLogs"
        :key="i"
        class="log-entry"
        :class="entry.type"
      >
        <span class="log-num">{{ i + 1 }}</span>
        <span class="log-ts">{{ formatTime(entry.time) }}</span>
        <span class="log-type-badge" :class="`type-${entry.type}`">{{ entry.type }}</span>
        <span class="log-content">{{ entry.line }}</span>
      </div>
      <div v-if="!filteredLogs.length" class="empty-state">
        <div style="font-size:var(--text-hero)">📋</div>
        <p class="text-muted">暂无日志，启动 OpenClaw 后日志将在此显示</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useClawStore } from '@/stores/claw'

const clawStore = useClawStore()
const logViewerRef = ref<HTMLDivElement>()
const autoScroll = ref(true)
const filterType = ref<'all' | 'stdout' | 'stderr' | 'system'>('all')

const filteredLogs = computed(() => {
  if (filterType.value === 'all') return clawStore.logs
  return clawStore.logs.filter((l) => l.type === filterType.value)
})

const errorCount = computed(() => clawStore.logs.filter((l) => l.type === 'stderr').length)
const systemCount = computed(() => clawStore.logs.filter((l) => l.type === 'system').length)

watch(filteredLogs, () => {
  if (autoScroll.value) {
    nextTick(() => {
      if (logViewerRef.value) {
        logViewerRef.value.scrollTop = logViewerRef.value.scrollHeight
      }
    })
  }
})

async function clearLogs() {
  await window.api.log.clearLogs()
  clawStore.clearLogs()
}

function exportLogs() {
  const content = clawStore.logs
    .map((l) => `[${formatTime(l.time)}] [${l.type}] ${l.line}`)
    .join('\n')
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `claw-logs-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

onMounted(async () => {
  // 初次加载历史日志
  const logs = await window.api.log.getLogs()
  logs.forEach((l) => clawStore.addLog(l))
  nextTick(() => {
    if (logViewerRef.value) {
      logViewerRef.value.scrollTop = logViewerRef.value.scrollHeight
    }
  })
})
</script>

<style scoped>
.logs-page { display: flex; flex-direction: column; gap: var(--space-4); height: 100%; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; flex-shrink: 0; }
.toggle-wrap { display: flex; align-items: center; gap: var(--space-2); }
.stats-bar { display: flex; gap: var(--space-2); flex-shrink: 0; }

.log-viewer {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.log-entry {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: 3px var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  transition: background var(--duration-fast);
}
.log-entry:hover { background: var(--bg-elevated); }
.log-entry.stderr { background: var(--danger-muted); }
.log-entry.system { background: var(--warning-muted); }

.log-num {
  color: var(--text-muted);
  font-size: var(--text-xs);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}
.log-ts {
  color: var(--text-muted);
  font-size: var(--text-xs);
  flex-shrink: 0;
  white-space: nowrap;
}
.log-type-badge {
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.type-stdout { background: var(--info-muted); color: var(--info); }
.type-stderr { background: var(--danger-muted); color: var(--danger); }
.type-system { background: var(--warning-muted); color: var(--warning); }
.log-content { color: var(--text-primary); flex: 1; word-break: break-all; }
.log-entry.stderr .log-content { color: var(--danger); }

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  /* 纵向留白刻意大于最大间距档（--space-10=40px），保留空状态的呼吸感 */
  padding: 60px var(--space-5);
  text-align: center;
}
</style>
