<template>
  <div class="reports-page">
    <header class="reports-header">
      <h1>📊 报告</h1>
      <div class="header-actions">
        <button class="btn" @click="generate('daily')">生成日报</button>
        <button class="btn" @click="generate('weekly')">生成周报</button>
      </div>
    </header>

    <div class="reports-layout">
      <!-- 左：报告列表 -->
      <section class="card list-col">
        <div class="tabs">
          <button
            v-for="t in tabs"
            :key="t.id"
            class="tab"
            :class="{ active: filter === t.id }"
            @click="setFilter(t.id)"
          >
            {{ t.label }}
            <span v-if="counts[t.id]" class="tab-count">{{ counts[t.id] }}</span>
          </button>
        </div>

        <ul class="report-list">
          <li
            v-for="r in filteredList"
            :key="r.id"
            class="report-row"
            :class="{ active: currentId === r.id }"
            @click="select(r.id)"
          >
            <div class="row-main">
              <span class="type-tag">{{ r.type === 'daily' ? '日报' : '周报' }}</span>
              <span class="period">{{ r.period }}</span>
            </div>
            <span class="badge" :class="r.status === 'confirmed' ? 'badge-green' : 'badge-yellow'">
              {{ r.status === 'confirmed' ? '已确认' : '草稿' }}
            </span>
          </li>
        </ul>
        <div v-if="!list.length" class="empty">暂无报告，点右上角生成</div>
      </section>

      <!-- 右：报告详情 -->
      <section class="card detail-col">
        <div v-if="!detail" class="empty detail-empty">选择一份报告查看，或生成新报告</div>

        <template v-else>
          <div class="detail-head">
            <div class="detail-title">
              <h2>{{ detail.type === 'daily' ? '日报' : '周报' }} · {{ detail.period }}</h2>
            </div>
            <div class="version-tabs" v-if="detail.versions.length > 1">
              <button
                v-for="v in [...detail.versions].reverse()"
                :key="v.version"
                class="version-btn"
                :class="{ active: selectedVersion === v.version }"
                @click="selectVersion(v.version)"
              >v{{ v.version }}</button>
            </div>
          </div>

          <!-- 流式生成中 -->
          <div v-if="stream.running.value" class="generating">
            <div class="stream-text">{{ stream.text.value }}<span class="caret">▍</span></div>
          </div>

          <template v-else>
            <textarea
              v-if="detail.status === 'draft'"
              v-model="editingContent"
              class="form-textarea editor"
              placeholder="报告内容…"
            ></textarea>
            <div v-else class="readonly-content">{{ versionContent }}</div>
          </template>

          <!-- 操作 -->
          <div class="detail-actions" v-if="!stream.running.value">
            <template v-if="detail.status === 'draft'">
              <button class="btn" @click="saveDraft">保存草稿</button>
              <button class="btn btn-primary" @click="confirm">确认报告</button>
              <button class="btn" @click="regenerate">重生成</button>
            </template>
            <template v-else>
              <button class="btn" @click="regenerate">重生成（新版本）</button>
            </template>
          </div>
          <div class="detail-actions" v-else>
            <button class="btn btn-danger" @click="abort">停止生成</button>
          </div>

          <div v-if="stream.error.value" class="error-box">
            生成失败：{{ stream.error.value.message }}
          </div>
        </template>
      </section>
    </div>

    <div v-if="toast.toast.value" class="toast" :class="toast.toast.value.type">
      {{ toast.toast.value.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ReportDetail, ReportSummary } from '../../electron/main/work/reportManager'
import { useWorkStream } from '@/composables/useWorkStream'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const { toast, showToast } = useToast()
const stream = useWorkStream()

const list = ref<ReportSummary[]>([])
const detail = ref<ReportDetail | null>(null)
const currentId = ref<string | null>(null)
const filter = ref<'all' | 'daily' | 'weekly'>('all')
const selectedVersion = ref<number | null>(null)
const editingContent = ref('')

const tabs = [
  { id: 'all', label: '全部' },
  { id: 'daily', label: '日报' },
  { id: 'weekly', label: '周报' }
] as const

const filteredList = computed(() =>
  filter.value === 'all' ? list.value : list.value.filter((r) => r.type === filter.value)
)
const counts = computed<Record<string, number>>(() => ({
  all: list.value.length,
  daily: list.value.filter((r) => r.type === 'daily').length,
  weekly: list.value.filter((r) => r.type === 'weekly').length
}))

const versionContent = computed(() => {
  if (!detail.value) return ''
  const v = detail.value.versions.find((x) => x.version === selectedVersion.value)
  return v?.content ?? detail.value.content ?? ''
})

async function loadList(): Promise<void> {
  list.value = await window.api.work.reports.list({ limit: 200 })
}

async function select(id: string): Promise<void> {
  currentId.value = id
  try {
    detail.value = await window.api.work.reports.get(id)
    selectedVersion.value = detail.value.versions[detail.value.versions.length - 1]?.version ?? null
    editingContent.value = detail.value.content ?? ''
  } catch (e: any) {
    showToast(`加载失败：${e.message}`, 'error')
  }
}

function setFilter(id: 'all' | 'daily' | 'weekly'): void {
  filter.value = id
}

async function generate(type: 'daily' | 'weekly'): Promise<void> {
  try {
    const res = await window.api.work.reports.generate({ type })
    stream.bind(res.runId)
    detail.value = null
    currentId.value = res.reportId
    await stream.done
    await loadList()
    await select(res.reportId)
    showToast(type === 'daily' ? '日报草稿已生成' : '周报草稿已生成', 'success')
  } catch (e: any) {
    showToast(`生成失败：${e.message}`, 'error')
  } finally {
    stream.reset()
  }
}

async function abort(): Promise<void> {
  if (stream.runId.value) await window.api.work.reports.abortGenerate(stream.runId.value)
}

async function saveDraft(): Promise<void> {
  if (!detail.value) return
  await window.api.work.reports.saveDraft(detail.value.id, editingContent.value)
  showToast('草稿已保存', 'success')
  await select(detail.value.id)
}

async function confirm(): Promise<void> {
  if (!detail.value) return
  // 先保存编辑内容，再确认
  await window.api.work.reports.saveDraft(detail.value.id, editingContent.value)
  await window.api.work.reports.confirm(detail.value)
  await loadList()
  await select(detail.value.id)
  showToast('报告已确认', 'success')
}

async function regenerate(): Promise<void> {
  if (!detail.value) return
  const res = await window.api.work.reports.regenerate(detail.value.id)
  stream.bind(res.runId)
  await stream.done
  await loadList()
  await select(res.reportId)
  showToast('新版本已生成', 'success')
  stream.reset()
}

function selectVersion(v: number): void {
  selectedVersion.value = v
}

onMounted(async () => {
  await loadList()
  const qid = typeof route.query.id === 'string' ? route.query.id : null
  if (qid) await select(qid)
  // 从今日页/路由带过来的生成意图
  if (route.query.target === 'report') await generate('daily')
})
</script>

<style scoped>
.reports-page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.reports-header { display: flex; align-items: center; justify-content: space-between; }
.header-actions { display: flex; gap: 8px; }

.reports-layout { display: grid; grid-template-columns: 280px 1fr; gap: 16px; flex: 1; min-height: 0; }

.list-col { display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.tabs { display: flex; gap: 4px; }
.tab {
  flex: 1; padding: 6px; border: 1px solid var(--border); background: var(--bg-base);
  color: var(--text-secondary); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer;
}
.tab.active { background: var(--accent-muted); color: var(--accent); border-color: var(--accent); }
.tab-count { margin-left: 4px; opacity: 0.7; }

.report-list { list-style: none; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
.report-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px; background: var(--bg-base); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); cursor: pointer;
}
.report-row.active { border-color: var(--accent); background: var(--accent-muted); }
.row-main { display: flex; align-items: center; gap: 8px; }
.type-tag { font-size: 12px; color: var(--accent); }
.period { font-size: 13px; }
.empty { color: var(--text-muted); font-size: 13px; padding: 8px 0; }

.detail-col { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.detail-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.detail-head { display: flex; align-items: center; justify-content: space-between; }
.version-tabs { display: flex; gap: 4px; }
.version-btn {
  padding: 3px 10px; font-size: 12px; border: 1px solid var(--border);
  background: var(--bg-base); color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer;
}
.version-btn.active { border-color: var(--accent); color: var(--accent); }

.editor { flex: 1; min-height: 200px; resize: none; line-height: 1.7; }
.readonly-content { flex: 1; overflow-y: auto; white-space: pre-wrap; line-height: 1.7; font-size: 13px; }
.generating { flex: 1; overflow-y: auto; }
.stream-text { font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.caret { color: var(--accent); animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.detail-actions { display: flex; gap: 8px; }
.error-box { color: var(--red); font-size: 13px; padding: 8px; border: 1px solid var(--red); border-radius: var(--radius-sm); }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 100;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
