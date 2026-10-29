<template>
  <div class="placeholder">
    <div class="page-header">
      <div>
        <h1>{{ title }}</h1>
        <p class="text-muted text-sm" style="margin-top:4px">{{ desc }}</p>
      </div>
      <span class="badge">占位 · 待接入</span>
    </div>

    <div class="card empty-card">
      <div class="empty-icon">{{ icon }}</div>
      <h3>{{ title }}</h3>
      <p class="text-muted text-sm">
        该模块的页面骨架已就位，功能将在对应的 2.0 版本提交中替换本占位页。
      </p>
      <div class="empty-meta text-sm text-muted">
        <span>路由：<code>{{ route.path }}</code></span>
        <span v-if="commit">计划提交：{{ commit }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const title = computed(() => (route.meta.title as string) || '营销模块')
const icon = computed(() => (route.meta.icon as string) || '🧩')
const desc = computed(() => (route.meta.desc as string) || '')
const commit = computed(() => (route.meta.commit as string) || '')
</script>

<style scoped>
.placeholder { display: flex; flex-direction: column; gap: 20px; width: 100%; }

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.badge {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  white-space: nowrap;
}

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
}
.empty-icon { font-size: 40px; }
.empty-meta {
  display: flex;
  gap: 20px;
  margin-top: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.empty-meta code {
  font-family: var(--font-mono);
  color: var(--text-secondary);
}
</style>
