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

    <!-- 待办速记：只专注记待办，回车/记下永不跳页；问答走独立按钮 -->
    <div class="card quick-input">
      <div class="qi-row">
        <input
          v-model="quickText"
          class="form-input"
          placeholder="加个待办，回车记下…"
          @keydown.enter="onQuick"
        />
        <button class="btn btn-primary" :disabled="!quickText.trim()" @click="onQuick">记下</button>
        <button class="btn" @click="goQa">💬 去工作问答</button>
      </div>
      <div class="qi-options">
        <label class="qi-due">
          <span>📅 到期</span>
          <input
            v-model="dueTime"
            class="form-input qi-time"
            type="datetime-local"
          />
        </label>
        <label class="qi-check">
          <input
            type="checkbox"
            :checked="pushChecked"
            @change="onTogglePush(($event.target as HTMLInputElement).checked)"
          />
          <span>⏰ 到点提醒我</span>
        </label>
        <input
          v-if="pushChecked"
          v-model="remindTime"
          class="form-input qi-time"
          type="datetime-local"
        />
        <template v-if="pushChecked && !channelReady">
          <span class="qi-warn">{{ pushBlockLabel }}</span>
          <button class="btn btn-sm" @click="router.push('/work/settings#push')">
            {{ pushBlocked === 'disabled' ? '去开启' : '去配置' }}
          </button>
        </template>
      </div>
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
              <span v-else-if="t.dueDate === view.date" class="badge badge-yellow">
                今天{{ t.dueAt ? ' ' + clockTime(t.dueAt) : '' }}
              </span>
              <span v-else-if="!t.dueDate" class="badge">随时</span>
              <span v-if="t.remindAt" class="badge badge-green">⏰ {{ formatRemind(t.remindAt) }}</span>
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

/** 到期时间（v3：精确到分钟；默认今天 18:00，已过点则顺延明天 18:00） */
const dueTime = ref(defaultDue())

// 到点提醒（v2 起，v0.17 口径）：勾选 + 时间 → **本机通知必达**，外发到渠道是加成
const pushChecked = ref(false)
const remindTime = ref('')
/**
 * 外发是否就绪 = **总开关开着** + 首选通道与目标都配好。
 *
 * 只决定「到点能不能顺带外发到渠道」，**不决定要不要提醒**：未就绪也照样调度，
 * 到点仍会在本机弹通知（主进程同口径，见 reminderManager.processTodoReminders）。
 */
const channelReady = ref(false)
/** 外发未就绪的原因：none=就绪 / unconfigured=没配通道 / disabled=总开关关着 */
const pushBlocked = ref<'none' | 'unconfigured' | 'disabled'>('none')
const pushBlockLabel = computed(() =>
  pushBlocked.value === 'disabled'
    ? '外发开关未开启（到点仍会本机通知）'
    : '未配置外发渠道（到点仍会本机通知）'
)

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

  if (!dueTime.value) {
    showToast('请选择到期时间', 'warning')
    return
  }
  let dueAt = new Date(dueTime.value).getTime()
  if (!Number.isFinite(dueAt)) {
    showToast('到期时间格式无效', 'warning')
    return
  }
  // 先解析提醒选项；它不影响待办本体的创建（这里只专注记录，任何情况都不跳页）
  let remindAt: number | null = null
  let note: string | null = null
  if (pushChecked.value) {
    if (!remindTime.value) {
      showToast('勾选了到点提醒，请选择提醒时间', 'warning')
      return
    }
    const ts = new Date(remindTime.value).getTime()
    if (!Number.isFinite(ts)) {
      showToast('提醒时间格式无效', 'warning')
      return
    }
    if (ts <= Date.now()) {
      note = '提醒时间已过，本次不设提醒'
    } else {
      // 外发未就绪也照样调度：到点本机通知必达，只是不会外发到渠道
      remindAt = ts
      if (!channelReady.value) {
        note =
          pushBlocked.value === 'disabled'
            ? '外发开关未开启，到点只在本机通知'
            : '外发渠道未配置，到点只在本机通知'
      }
    }
  }

  try {
    // B3：router.route 永不失败。这里调它仅为 best-effort 提取标题/日期，
    // 任何 target（含 qa/工具/报告）都只落待办，绝不导航。
    const r = await window.api.work.router.route(text)
    const title = r.target === 'todo_extract' ? r.draft?.title ?? r.text : r.text
    let dueDate = dueTime.value.slice(0, 10) // datetime-local 值的日期段
    if (r.target === 'todo_extract' && r.draft?.dueDate) {
      // 自然语言里提到的日期覆盖日期部分；具体时刻仍以选择器为准
      const hhmm = dueTime.value.slice(11, 16)
      const merged = new Date(`${r.draft.dueDate}T${hhmm}`).getTime()
      // 拼不出来（draft 日期非 YYYY-MM-DD 等）就退回选择器原值：
      // 绝不让 NaN 落到主进程——那会被判 VALIDATION_ERROR，整条速记白丢
      if (Number.isFinite(merged)) {
        dueAt = merged
        dueDate = r.draft.dueDate
      }
    }
    await window.api.work.todos.create({ title, dueDate, dueAt, remindAt })
    quickText.value = ''
    pushChecked.value = false
    remindTime.value = ''
    dueTime.value = defaultDue()
    showToast(
      note
        ? `已加待办；${note}`
        : remindAt !== null
          ? '已加待办，到点本机通知 + 外发到渠道'
          : '已加待办',
      note ? 'warning' : 'success'
    )
    await refresh()
  } catch (e: any) {
    showToast(`操作失败：${e.message}`, 'error')
  }
}

/** 独立的工作问答入口：输入框文字带过去作为问题 */
function goQa(): void {
  const text = quickText.value.trim()
  router.push(text ? { path: '/work/qa', query: { q: text } } : { path: '/work/qa' })
  quickText.value = ''
}

/** 勾选到点提醒：首次勾选预填下一整点作为默认提醒时间 */
function onTogglePush(checked: boolean): void {
  pushChecked.value = checked
  if (checked && !remindTime.value) {
    const d = new Date()
    d.setHours(d.getHours() + 1, 0, 0, 0)
    remindTime.value = toDatetimeLocal(d.getTime())
  }
}

/** 默认到期时间：今天 18:00（下班点）；若已过 18:00 则顺延明天，避免一建就逾期 */
function defaultDue(): string {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return toDatetimeLocal(d.getTime())
}

/** epoch ms → `HH:mm`（今日徽标上的到期时刻） */
function clockTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** epoch ms → datetime-local 控件值（本地时区 `YYYY-MM-DDTHH:mm`） */
function toDatetimeLocal(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 外发时刻徽标：`MM-DD HH:mm` */
function formatRemind(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 读外发就绪状态（失败按未就绪处理；只影响外发，不影响本机提醒） */
async function loadPushReady(): Promise<void> {
  try {
    const cfg = await window.api.work.reminder.getPushConfig()
    const configured = !!(cfg.channel && cfg.target)
    channelReady.value = configured && cfg.enabled
    pushBlocked.value = !configured ? 'unconfigured' : cfg.enabled ? 'none' : 'disabled'
  } catch {
    channelReady.value = false
    pushBlocked.value = 'unconfigured'
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
  // 页面长开着跨过默认时刻（今天 18:00）后重算，避免「一建就逾期」
  dueTime.value = defaultDue()
  void refresh()
  void loadCompleteness()
  void loadPushReady()
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

.quick-input { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
.qi-row { display: flex; gap: 10px; align-items: center; }
/* 外发选项行：弱样式，不抢待办输入的视觉焦点 */
.qi-options { display: flex; gap: 10px; align-items: center; }
.qi-due { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
.qi-check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); cursor: pointer; user-select: none; }
.qi-check input { cursor: pointer; }
.qi-time { width: 210px; padding: 5px 10px; font-size: 13px; }
.qi-warn { font-size: 12px; color: var(--yellow); }

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
