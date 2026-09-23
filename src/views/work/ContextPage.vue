<template>
  <div class="context-page">
    <header class="cx-header">
      <div>
        <h1>🔍 AI 看见什么</h1>
        <span class="text-sm text-muted">
          只读预览：AI 处理时实际用到的资料组成。不含提示词全文与任何凭据。
        </span>
      </div>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
    </header>

    <div v-if="error" class="card error-box">{{ error }}</div>

    <template v-if="view">
      <!-- 概览 -->
      <section class="card">
        <div class="s-head">
          <h2>本次输入</h2>
          <span class="badge badge-blue">{{ view.scope }}</span>
        </div>
        <div class="kv-grid">
          <div class="kv"><span class="k">任务</span><span class="v">{{ view.inputs.task }}</span></div>
          <div class="kv"><span class="k">检索词</span><span class="v">{{ view.inputs.query ?? '—' }}</span></div>
          <div class="kv"><span class="k">会话键</span><span class="v mono">{{ view.inputs.conversationKey ?? '—' }}</span></div>
          <div class="kv"><span class="k">构建时刻</span><span class="v mono">{{ fmtTime(view.builtAt) }}</span></div>
        </div>
      </section>

      <!-- 预算 -->
      <section class="card">
        <div class="s-head">
          <h2>上下文预算</h2>
          <span class="text-sm text-muted">模式：{{ view.memory_snapshot.budget.mode }}</span>
        </div>
        <div class="bar"><div class="bar-fill" :style="{ width: budgetPercent + '%' }"></div></div>
        <div class="text-sm text-muted">
          已用 {{ view.memory_snapshot.budget.usedTokens }} / {{ view.memory_snapshot.budget.budgetTokens }} tokens
          · 知识库纳入 {{ view.memory_snapshot.budget.knowledgeIncluded }}/{{ view.memory_snapshot.budget.knowledgeTotal }}
          · 检索模式 {{ view.memory_snapshot.retrievalMode }}
        </div>
      </section>

      <!-- 资料组成 -->
      <section class="card">
        <div class="s-head">
          <h2>资料组成</h2>
        </div>

        <div v-if="view.memory_snapshot.profileSummary" class="group">
          <div class="group-title">画像</div>
          <div class="group-body">{{ view.memory_snapshot.profileSummary }}</div>
        </div>

        <div class="group">
          <div class="group-title">事项 <span class="count">{{ view.memory_snapshot.matters.length }}</span></div>
          <div v-if="view.memory_snapshot.matters.length" class="chips">
            <span v-for="m in view.memory_snapshot.matters" :key="m.id" class="chip">{{ m.name }}</span>
          </div>
          <div v-else class="text-sm text-muted">无</div>
        </div>

        <div class="group">
          <div class="group-title">待办 <span class="count">{{ view.memory_snapshot.todos.length }}</span></div>
          <ul v-if="view.memory_snapshot.todos.length" class="mini-list">
            <li v-for="t in view.memory_snapshot.todos" :key="t.id">
              {{ t.title }}<span v-if="t.dueDate" class="due">（{{ t.dueDate }}）</span>
            </li>
          </ul>
          <div v-else class="text-sm text-muted">无</div>
        </div>

        <div class="group">
          <div class="group-title">工作记录 <span class="count">{{ view.memory_snapshot.records.length }}</span></div>
          <ul v-if="view.memory_snapshot.records.length" class="mini-list">
            <li v-for="r in view.memory_snapshot.records" :key="r.id">
              <span class="mono date">{{ r.occurredDate }}</span> {{ r.content }}
            </li>
          </ul>
          <div v-else class="text-sm text-muted">无</div>
        </div>

        <div class="group">
          <div class="group-title">知识库 <span class="count">{{ view.memory_snapshot.knowledge.length }}</span></div>
          <ul v-if="view.memory_snapshot.knowledge.length" class="mini-list">
            <li v-for="k in view.memory_snapshot.knowledge" :key="k.id">
              <span class="badge">{{ k.type }}</span> {{ k.title }}
              <span v-if="k.truncated" class="text-sm text-muted">（已截断）</span>
            </li>
          </ul>
          <div v-else class="text-sm text-muted">无</div>
        </div>

        <div class="group">
          <div class="group-title">历史对话 <span class="count">{{ view.memory_snapshot.historyCount }}</span></div>
        </div>
      </section>

      <!-- 被裁剪/过滤 -->
      <section class="card">
        <div class="s-head">
          <h2>被裁剪 / 过滤的条目</h2>
          <span class="badge" :class="view.dropped.length ? 'badge-yellow' : ''">{{ view.dropped.length }}</span>
        </div>
        <ul v-if="view.dropped.length" class="drop-list">
          <li v-for="d in view.dropped" :key="d.id + d.section">
            <span class="badge badge-red">{{ dropReason(d.reason) }}</span>
            <span class="drop-title">{{ d.title }}</span>
            <span class="text-sm text-muted">第 {{ d.section }} 段</span>
          </li>
        </ul>
        <div v-else class="text-sm text-muted">没有被裁剪的条目——本次资料全部装得下。</div>
      </section>
    </template>

    <div v-else-if="!loading && !error" class="card text-muted">暂无快照</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface SnapshotView {
  scope: string
  builtAt: number
  memory_snapshot: {
    profileSummary: string | null
    matters: Array<{ id: string; name: string }>
    todos: Array<{ id: string; title: string; dueDate: string | null }>
    records: Array<{ id: string; occurredDate: string; content: string }>
    knowledge: Array<{ id: string; title: string; type: string; truncated: boolean }>
    historyCount: number
    retrievalMode: string
    budget: {
      mode: string
      usedTokens: number
      budgetTokens: number
      knowledgeIncluded: number
      knowledgeTotal: number
    }
  }
  inputs: { task: string; query: string | null; conversationKey: string | null; anchorDate: string | null }
  dropped: Array<{ id: string; title: string; section: number; reason: string }>
}

const view = ref<SnapshotView | null>(null)
const loading = ref(false)
const error = ref('')

const budgetPercent = computed(() => {
  const b = view.value?.memory_snapshot.budget
  if (!b || !b.budgetTokens) return 0
  return Math.min(100, Math.round((b.usedTokens / b.budgetTokens) * 100))
})

function fmtTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN')
}
function dropReason(r: string): string {
  return {
    'over-budget': '超预算', 'knowledge-limit': '知识库上限', 'not-ready': '未就绪',
    'filtered': '被过滤', 'truncated': '已截断'
  }[r] ?? r
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    view.value = await window.api.work.context.snapshot({ scope: 'latest' })
  } catch (e: any) {
    error.value = `读取上下文快照失败：${e.message}`
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.context-page { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
.cx-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.s-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }

.kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.kv { display: flex; flex-direction: column; gap: 3px; }
.k { font-size: 12px; color: var(--text-muted); }
.v { font-size: 13px; }

.bar { height: 6px; background: var(--bg-base); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
.bar-fill { height: 100%; background: var(--accent); transition: width 0.3s; }

.group { padding: 10px 0; border-bottom: 1px solid var(--border-muted); }
.group:last-child { border-bottom: none; }
.group-title { font-size: 13px; font-weight: 500; margin-bottom: 8px; }
.count { font-size: 12px; color: var(--text-muted); font-weight: 400; margin-left: 4px; }
.group-body { font-size: 13px; line-height: 1.7; white-space: pre-wrap; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font-size: 12px; padding: 3px 10px; border-radius: 20px;
  background: var(--bg-overlay); color: var(--text-secondary);
}

.mini-list { list-style: none; display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.due { color: var(--yellow); font-size: 12px; }
.date { color: var(--text-muted); font-size: 12px; }

.drop-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.drop-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.drop-title { flex: 1; }

.error-box { color: var(--red); border-color: var(--red); }
</style>
