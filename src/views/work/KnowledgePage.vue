<template>
  <div class="knowledge-page">
    <header class="k-header">
      <h1>📚 工作知识库</h1>
      <div class="header-actions">
        <button class="btn" @click="startCreate('text')">＋ 文本</button>
        <button class="btn" @click="startCreate('faq')">＋ FAQ</button>
        <button class="btn btn-primary" @click="startImport">导入文件 / 网址</button>
      </div>
    </header>

    <!-- 检索 -->
    <div class="card search-bar">
      <input v-model="query" class="form-input" placeholder="检索知识库（标题/正文）…" @keydown.enter="onSearch" />
      <button class="btn" @click="onSearch">检索</button>
      <button v-if="searching" class="btn" @click="clearSearch">清除</button>
    </div>

    <!-- 列表 -->
    <section class="card list-col">
      <div class="list-head">
        <h2>{{ searching ? '检索结果' : '全部资料' }}</h2>
        <span class="badge badge-blue">{{ rows.length }}</span>
      </div>

      <ul class="k-list">
        <li v-for="r in displayRows" :key="r.id" class="k-row">
          <div class="row-top">
            <span class="type-badge" :class="`t-${r.type}`">{{ typeName(r.type) }}</span>
            <span class="k-title">{{ r.title }}</span>
          </div>
          <div class="row-preview">{{ preview(r.content) }}</div>
          <div class="row-actions">
            <button class="btn btn-sm" @click="view(r.id)">查看</button>
            <button class="btn btn-sm btn-danger" @click="askRemove(r)">删除</button>
          </div>
        </li>
      </ul>
      <div v-if="!rows.length" class="empty">
        {{ searching ? '没有匹配资料' : '知识库还是空的，导入或新建一条吧' }}
      </div>
    </section>

    <!-- 详情/编辑弹层 -->
    <div v-if="editing" class="modal-mask" @click.self="closeEditor">
      <div class="card modal">
        <div class="modal-head">
          <h2>{{ editorTitle }}</h2>
          <button class="btn btn-sm" @click="closeEditor">关闭</button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">标题</label>
            <input v-model="editTitle" class="form-input" placeholder="标题" />
          </div>

          <!-- 新建/编辑文本类 -->
          <div v-if="editMode !== 'import'" class="form-group">
            <label class="form-label">内容</label>
            <textarea v-model="editContent" class="form-textarea k-editor" placeholder="内容…"></textarea>
          </div>

          <!-- 导入 -->
          <div v-else class="form-group import-fields">
            <div class="seg">
              <button
                v-for="t in importTypes"
                :key="t.id"
                class="seg-btn"
                :class="{ active: importType === t.id }"
                @click="importType = t.id"
              >{{ t.label }}</button>
            </div>

            <template v-if="importType === 'url'">
              <input v-model="importUrl" class="form-input" placeholder="https://…" />
            </template>
            <template v-else>
              <div class="file-pick">
                <button class="btn" @click="pickFile">选择文件</button>
                <span class="picked">{{ pickedName || '未选择' }}</span>
              </div>
              <input v-model="importTitle" class="form-input" placeholder="标题（可选，默认取文件名）" />
            </template>
          </div>
        </div>

        <div class="modal-foot">
          <button class="btn" @click="closeEditor">取消</button>
          <button class="btn btn-primary" @click="saveEditor">保存</button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-model:visible="confirmVisible"
      icon="⚠️"
      title="删除这条知识资料？"
      :message="`将删除「${pendingTitle}」。此操作不可撤销。`"
      confirm-text="删除"
      danger
      @confirm="doRemove"
    />

    <div v-if="toast" class="toast" :class="toast.type">
      {{ toast.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@/composables/useToast'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'

interface KRow {
  id: string
  title: string
  type: string
  content: string
  status: string
  source_name: string | null
}

const { toast, showToast } = useToast()

const rows = ref<KRow[]>([])
const query = ref('')
const searching = ref(false)
const searchHits = ref<Array<{ id: string; title: string; snippet: string }>>([])

// 弹层状态
const editing = ref(false)
const editMode = ref<'text' | 'faq' | 'import' | 'view'>('text')
const editTitle = ref('')
const editContent = ref('')
const editId = ref<string | null>(null)

// 导入态
const importType = ref<'url' | 'docx' | 'xlsx' | 'pdf'>('url')
const importUrl = ref('')
const importTitle = ref('')
const pickedPath = ref<string | null>(null)
const pickedName = ref('')

const importTypes = [
  { id: 'url', label: '网址' },
  { id: 'docx', label: 'Word' },
  { id: 'xlsx', label: 'Excel' },
  { id: 'pdf', label: 'PDF' }
] as const

const editorTitle = computed(() => {
  if (editMode.value === 'import') return '导入资料'
  if (editMode.value === 'view') return '查看资料'
  return editId.value ? '编辑资料' : '新建资料'
})

function typeName(t: string): string {
  return { text: '文本', markdown: 'Markdown', url: '网址', faq: 'FAQ', docx: 'Word', xlsx: 'Excel', pdf: 'PDF' }[t] ?? t
}
function preview(c: string): string {
  const s = c.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

async function load(): Promise<void> {
  rows.value = await window.api.work.knowledge.list({ limit: 500 })
}

async function onSearch(): Promise<void> {
  const q = query.value.trim()
  if (!q) return
  try {
    searchHits.value = await window.api.work.knowledge.search(q, 50)
    searching.value = true
  } catch (e: any) {
    showToast(`检索失败：${e.message}`, 'error')
  }
}
async function clearSearch(): Promise<void> {
  searching.value = false
  query.value = ''
  searchHits.value = []
}

// 检索时用 hit 构造展示行；未检索时返回真实 rows
const displayRows = computed<KRow[]>(() => {
  if (!searching.value) return rows.value
  return searchHits.value.map((h) => ({
    id: h.id, title: h.title, type: '', content: h.snippet, status: 'ready', source_name: null
  }))
})

function startCreate(type: 'text' | 'faq'): void {
  editMode.value = type
  editId.value = null
  editTitle.value = ''
  editContent.value = ''
  editing.value = true
}
function startImport(): void {
  editMode.value = 'import'
  importType.value = 'url'
  importUrl.value = ''
  importTitle.value = ''
  pickedPath.value = null
  pickedName.value = ''
  editing.value = true
}

async function view(id: string): Promise<void> {
  try {
    const r = await window.api.work.knowledge.get(id)
    editMode.value = 'view'
    editId.value = r.id
    editTitle.value = r.title
    editContent.value = r.content
    editing.value = true
  } catch (e: any) {
    showToast(`加载失败：${e.message}`, 'error')
  }
}

async function pickFile(): Promise<void> {
  try {
    const r = await window.api.work.knowledge.pickFile(importType.value)
    if (r.canceled) return
    pickedPath.value = r.filePath
    pickedName.value = r.name
  } catch (e: any) {
    showToast(`选择文件失败：${e.message}`, 'error')
  }
}

async function saveEditor(): Promise<void> {
  try {
    if (editMode.value === 'import') {
      if (importType.value === 'url') {
        await window.api.work.knowledge.import({ type: 'url', url: importUrl.value, title: importTitle.value || null })
      } else {
        if (!pickedPath.value) { showToast('请先选择文件', 'warning'); return }
        await window.api.work.knowledge.import({
          type: importType.value, filePath: pickedPath.value, title: importTitle.value || null
        })
      }
      showToast('导入成功', 'success')
    } else if (editId.value) {
      await window.api.work.knowledge.update(editId.value, { title: editTitle.value, content: editContent.value })
      showToast('已保存', 'success')
    } else {
      await window.api.work.knowledge.create({
        type: editMode.value === 'faq' ? 'faq' : 'text',
        title: editTitle.value || null,
        content: editContent.value
      })
      showToast('已新建', 'success')
    }
    editing.value = false
    await load()
  } catch (e: any) {
    showToast(`保存失败：${e.message}`, 'error')
  }
}

// 删除二次确认：点删除只弹窗，确认后才真正删
const confirmVisible = ref(false)
const pendingId = ref<string | null>(null)
const pendingTitle = ref('')

function askRemove(r: KRow): void {
  pendingId.value = r.id
  // 标题可能为空（旧数据），兜底用内容摘要
  pendingTitle.value = r.title?.trim()
    || (r.content.length > 30 ? r.content.slice(0, 30) + '…' : r.content)
    || '未命名资料'
  confirmVisible.value = true
}

async function doRemove(): Promise<void> {
  const id = pendingId.value
  pendingId.value = null
  if (!id) return
  try {
    await window.api.work.knowledge.delete(id)
    showToast('已删除', 'success')
    await load()
  } catch (e: any) {
    showToast(`删除失败：${e.message}`, 'error')
  }
}

function closeEditor(): void {
  editing.value = false
}

onMounted(load)
</script>

<style scoped>
.knowledge-page { display: flex; flex-direction: column; gap: 16px; }
.k-header { display: flex; align-items: center; justify-content: space-between; }
.header-actions { display: flex; gap: 8px; }

.search-bar { display: flex; gap: 10px; padding: 12px 16px; align-items: center; }

.list-col { display: flex; flex-direction: column; gap: 12px; }
.list-head { display: flex; align-items: center; justify-content: space-between; }

.k-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.k-row {
  padding: 12px 14px; background: var(--bg-base);
  border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
  display: flex; flex-direction: column; gap: 6px;
}
.row-top { display: flex; align-items: center; gap: 10px; }
.type-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 20px;
  background: var(--bg-overlay); color: var(--text-secondary);
}
.k-title { font-size: 13px; font-weight: 500; }
.row-preview { font-size: 12px; color: var(--text-muted); }
.row-actions { display: flex; gap: 6px; }
.empty { color: var(--text-muted); font-size: 13px; padding: 12px 0; text-align: center; }

.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal { width: 620px; max-height: 86vh; display: flex; flex-direction: column; gap: 14px; }
.modal-head, .modal-foot { display: flex; align-items: center; justify-content: space-between; }
.modal-body { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
.k-editor { min-height: 220px; resize: vertical; line-height: 1.7; }

.seg { display: flex; gap: 4px; }
.seg-btn {
  flex: 1; padding: 6px; font-size: 12px; border: 1px solid var(--border);
  background: var(--bg-base); color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer;
}
.seg-btn.active { background: var(--accent-muted); color: var(--accent); border-color: var(--accent); }
.file-pick { display: flex; align-items: center; gap: 10px; }
.picked { font-size: 12px; color: var(--text-muted); }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 300;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
