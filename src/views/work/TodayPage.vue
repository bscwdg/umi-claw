<template>
  <div class="today-page">
    <!-- 头部问候 + 日期 -->
    <header class="today-header">
      <div>
        <h1>{{ view.greeting }}<span class="date-text"> · {{ view.date }} · {{ weekdayName }}</span></h1>
        <!-- 完整度弱存在感引导（§八 Day1 第2条）：不弹窗、不阻断，点一下去补 -->
        <button
          v-if="completenessHint"
          class="completeness-nudge"
          @click="router.push('/work/settings')"
        >{{ completenessHint }}</button>
      </div>
      <!-- 日报入口 -->
      <div class="report-entry">
        <button
          class="btn"
          :class="{ 'btn-primary': view.report.canGenerate && !view.report.exists }"
          @click="openReport"
        >
          {{ reportLabel }}
        </button>
      </div>
    </header>

    <!-- 一句话入口 -->
    <div class="card quick-input">
      <input
        v-model="quickText"
        class="form-input"
        placeholder="记一件事 / 加个待办…（回车）"
        @keydown.enter="onQuick"
      />
      <button class="btn btn-primary" :disabled="!quickText.trim()" @click="onQuick">记下</button>
    </div>

    <div class="today-grid">
      <!-- 左列：待办 -->
      <section class="card col">
        <div class="col-head">
          <h2>📌 待办</h2>
          <span class="badge badge-blue">{{ view.todos.length }}</span>
        </div>

        <div v-if="!view.todos.length" class="empty">暂无待办</div>
        <ul class="item-list">
          <li v-for="t in view.todos" :key="t.id" class="item">
            <label class="check">
              <input type="checkbox" @change="onComplete(t.id)" />
              <span class="item-title">{{ t.title }}</span>
            </label>
            <div class="item-meta">
              <span v-if="t.overdue" class="badge badge-red">逾期</span>
              <span v-else-if="t.dueDate === view.date" class="badge badge-yellow">今天</span>
              <span v-else-if="!t.dueDate" class="badge">随时</span>
            </div>
          </li>
        </ul>

        <!-- AI 提取待办 -->
        <div v-if="view.candidateTodos.length" class="candidate-block">
          <div class="col-head">
            <h3>🤖 AI 提取待办</h3>
            <div class="batch-btns">
              <button class="btn btn-sm btn-success" @click="confirmTodos">全部记入</button>
              <button class="btn btn-sm" @click="ignoreTodos">忽略</button>
            </div>
          </div>
          <ul class="item-list">
            <li v-for="t in view.candidateTodos" :key="t.id" class="item candidate">
              <span class="item-title">{{ t.title }}</span>
              <span v-if="t.dueDate" class="badge badge-yellow">{{ t.dueDate }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- 右列：今日记录 -->
      <section class="card col">
        <div class="col-head">
          <h2>📝 今日记录</h2>
          <span class="badge badge-blue">{{ view.records.length }}</span>
        </div>

        <div v-if="!view.records.length" class="empty">今天还没记录，记一件吧</div>
        <ul class="item-list">
          <li v-for="r in view.records" :key="r.id" class="item record">
            <span class="record-time">{{ r.occurredTime ?? '时间未记' }}</span>
            <span class="item-title">{{ r.content }}</span>
          </li>
        </ul>

        <!-- AI 候选记录 -->
        <div v-if="view.candidateRecords.length" class="candidate-block">
          <div class="col-head">
            <h3>🔍 待确认记录</h3>
            <div class="batch-btns">
              <button class="btn btn-sm btn-success" @click="confirmRecords">记入</button>
              <button class="btn btn-sm" @click="ignoreRecords">忽略</button>
            </div>
          </div>
          <ul class="item-list">
            <li v-for="r in view.candidateRecords" :key="r.id" class="item candidate">
              <span class="item-title">{{ r.content }}</span>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <!-- toast -->
    <div v-if="toast" class="toast" :class="toast.type">
      {{ toast.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { TodayView } from '../../electron/main/work/todayManager'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const { toast, showToast } = useToast()

const view = ref<TodayView>({
  date: '',
  weekday: 0,
  greeting: '',
  todos: [],
  candidateTodos: [],
  records: [],
  candidateRecords: [],
  report: { exists: false, reportId: null, status: null, canGenerate: false },
  counts: { todos: 0, candidateTodos: 0, records: 0, candidateRecords: 0 }
})

const weekdayName = computed(() => ['周日','周一','周二','周三','周四','周五','周六'][view.value.weekday])
const quickText = ref('')

// 完整度弱存在感引导（§八 Day1）
const completeness = ref<{ filled: number; total: number; percent: number; missing: string[] } | null>(null)
const FIELD_LABELS: Record<string, string> = {
  call_name: '称呼', position: '岗位', department: '部门',
  company: '公司', report_to: '汇报对象', tone: '偏好语气'
}
const completenessHint = computed(() => {
  const c = completeness.value
  if (!c || !c.missing.length) return ''
  const next = Math.round(((c.filled + 1) / c.total) * 100)
  const label = FIELD_LABELS[c.missing[0]] ?? c.missing[0]
  return `补上「${label}」可到 ${next}%`
})

const reportLabel = computed(() => {
  if (view.value.report.exists) {
    return view.value.report.status === 'confirmed' ? '查看日报' : '日报草稿'
  }
  return view.value.report.canGenerate ? '生成今日日报' : '今日日报'
})

async function refresh(): Promise<void> {
  try {
    view.value = await window.api.work.today.get()
  } catch (e: any) {
    showToast(`加载失败：${e.message}`, 'error')
  }
}

/** 读完整度（失败不影响今日页主流程） */
async function loadCompleteness(): Promise<void> {
  try {
    const v = await window.api.work.profile.get()
    completeness.value = v?.completeness ?? null
  } catch {
    completeness.value = null
  }
}

async function onQuick(): Promise<void> {
  const text = quickText.value.trim()
  if (!text) return
  try {
    // B3：route 永不失败，返回 {target, reason, text, draft}
    const r = await window.api.work.router.route(text)
    if (r.target === 'todo_extract') {
      await window.api.work.todos.create({
        title: r.draft?.title ?? r.text,
        dueDate: r.draft?.dueDate ?? view.value.date
      })
      quickText.value = ''
      showToast('已加待办', 'success')
      await refresh()
    } else if (r.target === 'qa') {
      // 问答兜底：跳工作问答页并带上原句
      quickText.value = ''
      router.push({ path: '/work/qa', query: { q: r.text } })
    } else {
      // 工具/报告/邮件类 target：跳对应页并预填原文
      quickText.value = ''
      const targetPath: Record<string, string> = {
        tool_minutes: '/work/tools', tool_summary: '/work/tools', tool_translate: '/work/tools',
        tool_polish: '/work/tools', email_draft: '/work/tools', report: '/work/reports'
      }
      router.push({ path: targetPath[r.target] ?? '/work/qa', query: { text: r.text, target: r.target } })
    }
  } catch (e: any) {
    showToast(`操作失败：${e.message}`, 'error')
  }
}

async function onComplete(id: string): Promise<void> {
  try {
    await window.api.work.todos.complete(id)
    showToast('已完成，已自动记入', 'success')
    await refresh()
  } catch (e: any) {
    showToast(`操作失败：${e.message}`, 'error')
  }
}

async function confirmTodos(): Promise<void> {
  const ids = view.value.candidateTodos.map((t) => t.id)
  await window.api.work.todos.confirmBatch(ids)
  showToast('AI 待办已记入', 'success')
  await refresh()
}
async function ignoreTodos(): Promise<void> {
  const ids = view.value.candidateTodos.map((t) => t.id)
  await window.api.work.todos.ignoreBatch(ids)
  await refresh()
}
async function confirmRecords(): Promise<void> {
  const ids = view.value.candidateRecords.map((r) => r.id)
  await window.api.work.records.confirmBatch(ids)
  showToast('候选已记入', 'success')
  await refresh()
}
async function ignoreRecords(): Promise<void> {
  const ids = view.value.candidateRecords.map((r) => r.id)
  await window.api.work.records.ignoreBatch(ids)
  await refresh()
}

function openReport(): void {
  if (view.value.report.reportId) {
    router.push({ path: '/work/reports', query: { id: view.value.report.reportId } })
  } else {
    router.push('/work/reports')
  }
}

onMounted(() => {
  void refresh()
  void loadCompleteness()
})
</script>

<style scoped>
.today-page { display: flex; flex-direction: column; gap: 16px; }
.today-header { display: flex; align-items: center; justify-content: space-between; }
.date-text { font-size: 13px; color: var(--text-secondary); font-weight: 400; }

/* 完整度弱存在感引导：低调不打扰，点一下去补 */
.completeness-nudge {
  margin-top: 6px; padding: 0;
  background: none; border: none; cursor: pointer;
  font-size: 12px; color: var(--text-muted);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  transition: color 0.15s;
}
.completeness-nudge:hover { color: var(--accent); }

.quick-input { display: flex; gap: 10px; padding: 12px 16px; align-items: center; }

.today-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.col { display: flex; flex-direction: column; gap: 12px; }
.col-head { display: flex; align-items: center; justify-content: space-between; }
.batch-btns { display: flex; gap: 6px; }

.item-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; background: var(--bg-base);
  border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
}
.check { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.check input { cursor: pointer; }
.item-title { font-size: 13px; }
.item-meta { display: flex; gap: 6px; }
.item.candidate { border-style: dashed; }
.record { gap: 12px; }
.record-time {
  font-family: var(--font-mono); font-size: 12px; color: var(--accent);
  flex-shrink: 0; min-width: 64px;
}
.empty { color: var(--text-muted); font-size: 13px; padding: 8px 0; }
.candidate-block {
  margin-top: 8px; padding-top: 12px;
  border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 10px;
}

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 100;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
