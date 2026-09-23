<template>
  <div class="records-page">
    <header class="r-header">
      <h1>🗂 工作记录</h1>
      <div class="header-actions">
        <button class="btn" @click="showMatters = !showMatters">
          {{ showMatters ? '收起事项' : '管理事项' }}
        </button>
        <button class="btn btn-primary" @click="startCreate">＋ 记一件事</button>
      </div>
    </header>

    <!-- 事项管理面板 -->
    <section v-if="showMatters" class="card matters-panel">
      <div class="panel-head">
        <h2>事项</h2>
        <div class="matter-add">
          <input v-model="newMatterName" class="form-input" placeholder="新事项名称" @keydown.enter="addMatter" />
          <div class="color-pick">
            <button
              v-for="c in palette"
              :key="c"
              class="swatch"
              :class="{ active: newMatterColor === c }"
              :style="{ background: c }"
              @click="newMatterColor = c"
            ></button>
          </div>
          <button class="btn btn-sm" :disabled="!newMatterName.trim()" @click="addMatter">添加</button>
        </div>
      </div>

      <ul class="matter-list">
        <li v-for="m in matters" :key="m.id" class="matter-row">
          <span class="dot" :style="{ background: m.color ?? '#6B7280' }"></span>
          <input
            class="matter-name-input"
            :value="m.name"
            @change="renameMatter(m.id, ($event.target as HTMLInputElement).value)"
          />
          <span class="badge" :class="m.status === 'active' ? 'badge-green' : ''">
            {{ m.status === 'active' ? '在跟' : '已归档' }}
          </span>
          <button class="btn btn-sm" @click="toggleMatterStatus(m)">
            {{ m.status === 'active' ? '归档' : '恢复' }}
          </button>
          <button class="btn btn-sm btn-danger" @click="removeMatter(m.id)">删除</button>
        </li>
      </ul>
      <div v-if="!matters.length" class="empty">还没有事项。事项是轻量的「这件事」，用来归拢记录和待办。</div>
    </section>

    <!-- 筛选栏 -->
    <div class="card filter-bar">
      <div class="seg">
        <button
          v-for="t in statusTabs"
          :key="t.id"
          class="seg-btn"
          :class="{ active: statusFilter === t.id }"
          @click="setStatus(t.id)"
        >{{ t.label }}</button>
      </div>
      <input v-model="query" class="form-input search-input" placeholder="检索记录内容…" @keydown.enter="load" />
      <select v-model="matterFilter" class="form-select matter-select" @change="load">
        <option value="">全部事项</option>
        <option v-for="m in matters" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>

    <!-- 新建/编辑表单 -->
    <section v-if="editing" class="card edit-form">
      <div class="form-group">
        <label class="form-label">内容</label>
        <textarea v-model="form.content" class="form-textarea" placeholder="做了什么 / 发生了什么…"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">发生日期</label>
          <input v-model="form.occurredDate" type="date" class="form-input" />
        </div>
        <div class="form-group">
          <label class="form-label">时间（可留空 = 时间未记）</label>
          <input v-model="form.occurredTime" type="time" class="form-input" />
        </div>
        <div class="form-group">
          <label class="form-label">事项</label>
          <select v-model="form.matterId" class="form-select">
            <option value="">不挂事项</option>
            <option v-for="m in matters" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" @click="cancelEdit">取消</button>
        <button class="btn btn-primary" :disabled="!form.content.trim()" @click="save">保存</button>
      </div>
    </section>

    <!-- 记录列表 -->
    <section class="card list-col">
      <div class="list-head">
        <h2>{{ listTitle }}</h2>
        <span class="badge badge-blue">{{ rows.length }}</span>
      </div>

      <ul class="rec-list">
        <li v-for="r in rows" :key="r.id" class="rec-row">
          <div class="rec-main">
            <div class="rec-line1">
              <span class="rec-date">{{ r.occurred_date }}</span>
              <span class="rec-time">{{ r.occurred_time ?? '时间未记' }}</span>
              <span class="badge src-badge">{{ sourceName(r.source) }}</span>
              <span v-if="r.status === 'candidate'" class="badge badge-yellow">候选</span>
              <span v-if="r.filtered_reason" class="badge badge-red">{{ reasonName(r.filtered_reason) }}</span>
              <span v-if="matterName(r.matter_id)" class="matter-tag">
                <span class="dot" :style="{ background: matterColor(r.matter_id) }"></span>
                {{ matterName(r.matter_id) }}
              </span>
            </div>
            <div class="rec-content">{{ r.content }}</div>
          </div>
          <div class="rec-actions">
            <template v-if="r.status === 'candidate'">
              <button class="btn btn-sm btn-success" @click="confirmRec(r.id)">记入</button>
              <button class="btn btn-sm" @click="ignoreRec(r.id)">忽略</button>
            </template>
            <template v-else-if="r.status === 'ignored'">
              <button class="btn btn-sm" @click="restoreRec(r.id)">恢复</button>
            </template>
            <template v-else>
              <button class="btn btn-sm" @click="startEdit(r)">编辑</button>
            </template>
            <button class="btn btn-sm btn-danger" @click="removeRec(r.id)">删除</button>
          </div>
        </li>
      </ul>
      <div v-if="!rows.length" class="empty">{{ emptyText }}</div>
    </section>

    <div v-if="toast" class="toast" :class="toast.type">
      {{ toast.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RecordRow } from '../../electron/main/work/recordManager'
import type { MatterRow } from '../../electron/main/work/matterManager'
import { useToast } from '@/composables/useToast'

const { toast, showToast } = useToast()

const palette = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#6B7280']

const statusTabs = [
  { id: 'confirmed', label: '事实' },
  { id: 'candidate', label: '候选' },
  { id: 'filtered', label: '已过滤' },
  { id: 'all', label: '全部' }
] as const
type StatusFilter = (typeof statusTabs)[number]['id']

const rows = ref<RecordRow[]>([])
const matters = ref<MatterRow[]>([])
const statusFilter = ref<StatusFilter>('confirmed')
const query = ref('')
const matterFilter = ref('')
const showMatters = ref(false)

const newMatterName = ref('')
const newMatterColor = ref(palette[5])

const editing = ref(false)
const editingId = ref<string | null>(null)
const form = ref({ content: '', occurredDate: todayStr(), occurredTime: '', matterId: '' })

function todayStr(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const listTitle = computed(() => {
  return { confirmed: '事实记录', candidate: '候选（待确认）', filtered: '已过滤（被质量门槛挡下）', all: '全部记录' }[
    statusFilter.value
  ]
})
const emptyText = computed(() => {
  if (statusFilter.value === 'candidate') return '没有待确认的候选'
  if (statusFilter.value === 'filtered') return '没有被过滤的记录'
  return '还没有记录，点右上角记一件吧'
})

function sourceName(s: string): string {
  return { manual: '手动', todo: '待办', routine: '例事', ai_output: 'AI 产出' }[s] ?? s
}
function reasonName(r: string): string {
  return {
    empty: '空内容', 'too-short': '过短', 'duplicate-in-batch': '批内重复',
    'similar-to-confirmed': '与既有记录重复'
  }[r] ?? r
}
function matterName(id: string | null): string {
  if (!id) return ''
  return matters.value.find((m) => m.id === id)?.name ?? ''
}
function matterColor(id: string | null): string {
  if (!id) return '#6B7280'
  return matters.value.find((m) => m.id === id)?.color ?? '#6B7280'
}

async function loadMatters(): Promise<void> {
  matters.value = await window.api.work.matters.list({ status: 'all' })
}

async function load(): Promise<void> {
  try {
    if (statusFilter.value === 'filtered') {
      rows.value = await window.api.work.records.listFiltered({ limit: 500 })
    } else {
      rows.value = await window.api.work.records.list({
        status: statusFilter.value,
        query: query.value.trim() || undefined,
        matterId: matterFilter.value || undefined,
        limit: 500
      })
    }
  } catch (e: any) {
    showToast(`加载失败：${e.message}`, 'error')
  }
}

function setStatus(id: StatusFilter): void {
  statusFilter.value = id
  void load()
}

function startCreate(): void {
  editing.value = true
  editingId.value = null
  form.value = { content: '', occurredDate: todayStr(), occurredTime: '', matterId: matterFilter.value }
}
function startEdit(r: RecordRow): void {
  editing.value = true
  editingId.value = r.id
  form.value = {
    content: r.content,
    occurredDate: r.occurred_date,
    occurredTime: r.occurred_time ?? '',
    matterId: r.matter_id ?? ''
  }
}
function cancelEdit(): void {
  editing.value = false
  editingId.value = null
}

async function save(): Promise<void> {
  try {
    const payload = {
      content: form.value.content,
      occurredDate: form.value.occurredDate,
      occurredTime: form.value.occurredTime || null,
      matterId: form.value.matterId || null
    }
    if (editingId.value) {
      await window.api.work.records.update(editingId.value, payload)
      showToast('已保存', 'success')
    } else {
      await window.api.work.records.create(payload)
      showToast('已记下', 'success')
    }
    editing.value = false
    editingId.value = null
    await load()
  } catch (e: any) {
    showToast(`保存失败：${e.message}`, 'error')
  }
}

async function confirmRec(id: string): Promise<void> {
  await window.api.work.records.confirm(id)
  showToast('已记入事实层', 'success')
  await load()
}
async function ignoreRec(id: string): Promise<void> {
  await window.api.work.records.ignore(id)
  await load()
}
async function restoreRec(id: string): Promise<void> {
  await window.api.work.records.restore(id)
  showToast('已恢复为候选', 'success')
  await load()
}
async function removeRec(id: string): Promise<void> {
  await window.api.work.records.delete(id)
  showToast('已删除', 'success')
  await load()
}

async function addMatter(): Promise<void> {
  const name = newMatterName.value.trim()
  if (!name) return
  try {
    await window.api.work.matters.create({ name, color: newMatterColor.value })
    newMatterName.value = ''
    await loadMatters()
    showToast('已添加事项', 'success')
  } catch (e: any) {
    showToast(`添加失败：${e.message}`, 'error')
  }
}
async function renameMatter(id: string, name: string): Promise<void> {
  const v = name.trim()
  if (!v) return
  try {
    await window.api.work.matters.update(id, { name: v })
    await loadMatters()
  } catch (e: any) {
    showToast(`重命名失败：${e.message}`, 'error')
  }
}
async function toggleMatterStatus(m: MatterRow): Promise<void> {
  await window.api.work.matters.update(m.id, { status: m.status === 'active' ? 'archived' : 'active' })
  await loadMatters()
}
async function removeMatter(id: string): Promise<void> {
  await window.api.work.matters.delete(id)
  showToast('事项已删除（挂在其下的记录保留，仅解绑）', 'success')
  await loadMatters()
  await load()
}

onMounted(async () => {
  await loadMatters()
  await load()
})
</script>

<style scoped>
.records-page { display: flex; flex-direction: column; gap: 16px; }
.r-header { display: flex; align-items: center; justify-content: space-between; }
.header-actions { display: flex; gap: 8px; }

.matters-panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.matter-add { display: flex; align-items: center; gap: 8px; }
.color-pick { display: flex; gap: 4px; }
.swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.swatch.active { border-color: var(--text-primary); }

.matter-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.matter-row { display: flex; align-items: center; gap: 10px; }
.matter-name-input {
  flex: 1; background: var(--bg-base); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; padding: 5px 8px;
}
.dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; display: inline-block; }

.filter-bar { display: flex; gap: 10px; align-items: center; padding: 12px 16px; }
.seg { display: flex; gap: 4px; }
.seg-btn {
  padding: 6px 12px; font-size: 12px; border: 1px solid var(--border);
  background: var(--bg-base); color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer;
}
.seg-btn.active { background: var(--accent-muted); color: var(--accent); border-color: var(--accent); }
.search-input { flex: 1; }
.matter-select { width: 160px; }

.edit-form { display: flex; flex-direction: column; gap: 12px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }

.list-col { display: flex; flex-direction: column; gap: 12px; }
.list-head { display: flex; align-items: center; justify-content: space-between; }
.rec-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.rec-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 10px 12px; background: var(--bg-base);
  border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
}
.rec-main { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.rec-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rec-date { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
.rec-time { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.src-badge { background: var(--bg-overlay); color: var(--text-secondary); }
.matter-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-secondary); }
.rec-content { font-size: 13px; line-height: 1.6; word-break: break-word; }
.rec-actions { display: flex; gap: 6px; flex-shrink: 0; }
.empty { color: var(--text-muted); font-size: 13px; padding: 12px 0; text-align: center; }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 100;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
