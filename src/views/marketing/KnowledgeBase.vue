<template>
  <div class="kb">
    <div class="page-header">
      <div>
        <h1>知识库</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          {{
            marketing.currentProject
              ? `${marketing.currentProject.name} · 商家事实知识（套系 / 价目 / FAQ 等）`
              : '知识库按 Project 隔离，先选一个商家'
          }}
        </p>
      </div>
      <div class="flex gap-2" v-if="marketing.currentProjectId">
        <button class="btn" :disabled="knowledgeLoading" @click="reload()">
          {{ knowledgeLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!marketing.currentProjectId" class="card empty-card">
      <div style="font-size: 32px">📚</div>
      <h3>还没有选择商家</h3>
      <p class="text-muted text-sm" style="max-width: 460px; line-height: 1.7">
        导入的资料属于某个商家：AI 生成内容、回答问题时会把它们当作事实依据。
      </p>
      <button class="btn btn-primary" @click="switcher.show()">打开商家切换器</button>
    </div>

    <template v-else>
      <!-- 完整度小条 -->
      <div class="card comp-strip">
        <span class="comp-label">资料完整度</span>
        <div class="comp-bar"><div class="comp-bar-fill" :style="{ width: overall.percent + '%' }"></div></div>
        <span class="text-sm text-muted">
          合计 {{ overall.filled }}/{{ overall.total }} 项 · 知识库
          {{ knowledgeComp.ready }}/{{ knowledgeComp.total }}
        </span>
      </div>

      <!-- 导入 -->
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom: 12px">
          <h3>导入资料</h3>
          <span class="text-sm text-muted">本地解析一次后入库，运行时不再重解析</span>
        </div>

        <div class="tabs">
          <button
            v-for="t in MODES"
            :key="t.key"
            class="tab"
            :class="{ on: mode === t.key }"
            @click="mode = t.key"
          >
            {{ t.icon }} {{ t.label }}
          </button>
        </div>

        <div class="imp-body" :class="{ dropping }" @dragover.prevent="dropping = true" @dragleave="dropping = false" @drop.prevent="onDrop">
          <!-- 文件 -->
          <template v-if="mode === 'file'">
            <div class="file-row">
              <button class="btn" @click="pickFile()">选择文件…</button>
              <span class="text-sm" :class="{ muted: !filePath }">
                {{ filePath || '支持 docx / xlsx / pdf / txt / md（doc、xls 旧格式请另存为新格式）' }}
              </span>
            </div>
            <p class="text-sm text-muted" style="margin: 6px 0 0">
              也可以把文件直接拖到这块区域。
            </p>
          </template>

          <!-- 文本 / FAQ -->
          <template v-else-if="mode === 'text' || mode === 'faq'">
            <textarea
              class="form-textarea"
              rows="6"
              :placeholder="mode === 'faq' ? '例：\nQ: 拍完多久能选片？\nA: 一般 3-5 个工作日。' : '把资料内容粘贴进来…'"
              :value="text"
              @input="text = ($event.target as HTMLTextAreaElement).value"
            ></textarea>
          </template>

          <!-- 网址 -->
          <template v-else>
            <input
              class="form-input"
              placeholder="https://…（只做正文/HTML 轻量抽取）"
              :value="url"
              @input="url = ($event.target as HTMLInputElement).value"
            />
          </template>

          <div class="imp-footer">
            <input
              class="form-input"
              style="max-width: 260px"
              placeholder="标题（可选，默认取文件名/首行）"
              :value="title"
              @input="title = ($event.target as HTMLInputElement).value"
            />
            <button class="btn btn-primary" :disabled="importing || !canImport" @click="doImport()">
              {{ importing ? '解析中…' : '导入' }}
            </button>
          </div>
        </div>

        <div v-if="importError" class="err">{{ importError }}</div>
      </div>

      <!-- 检索 -->
      <div class="card">
        <div class="search-row">
          <input
            class="form-input"
            placeholder="在知识库里搜（LIKE 关键词，支持中文）"
            :value="query"
            @input="query = ($event.target as HTMLInputElement).value"
            @keyup.enter="doSearch()"
          />
          <button class="btn" :disabled="!query.trim()" @click="doSearch()">搜索</button>
          <button v-if="hits" class="btn btn-sm" @click="clearSearch()">清除</button>
        </div>
        <div v-if="hits" class="hits">
          <div v-if="!hits.length" class="text-sm text-muted">没有命中</div>
          <div v-for="h in hits" :key="h.id" class="hit">
            <span class="hit-title">{{ h.title }}</span>
            <span class="hit-snippet">{{ h.snippet }}</span>
          </div>
        </div>
      </div>

      <!-- 列表 -->
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom: 12px">
          <h3>已入库资料</h3>
          <span class="badge">{{ marketing.knowledge.length }} 条</span>
        </div>

        <div v-if="knowledgeLoading && !marketing.knowledge.length" class="text-sm text-muted">加载中…</div>
        <div v-else-if="!marketing.knowledge.length" class="text-sm text-muted">
          还没有资料。先导入一份价目表或套系单试试。
        </div>
        <div v-else class="items">
          <div
            v-for="k in marketing.knowledge"
            :key="k.id"
            class="item"
            :class="{ failed: k.status === 'error' }"
          >
            <div class="item-head" @click="toggleExpand(k.id)">
              <span class="badge">{{ TYPE_LABELS[k.type] || k.type }}</span>
              <span class="item-title">{{ k.title }}</span>
              <span v-if="k.status !== 'ready'" class="badge badge-red">{{ k.status }}</span>
              <span class="item-time text-sm text-muted">{{ formatTime(k.updated_at) }}</span>
              <button class="btn btn-sm" @click.stop="removeItem(k)">删除</button>
            </div>
            <div v-if="expanded === k.id" class="item-body">
              <div v-if="k.source_name" class="text-sm text-muted" style="margin-bottom: 6px">
                来源：{{ k.source_name }}
              </div>
              <pre class="preview">{{ preview(k) }}</pre>
            </div>
          </div>
        </div>
      </div>
    </template>

    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useMarketingStore } from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import { useToast } from '@/composables/useToast'

const marketing = useMarketingStore()
const switcher = useProjectSwitcher()
const { toast, showToast } = useToast()

const MODES = [
  { key: 'file', icon: '📄', label: '文件' },
  { key: 'text', icon: '📝', label: '文本' },
  { key: 'url', icon: '🔗', label: '网址' },
  { key: 'faq', icon: '❓', label: 'FAQ' }
] as const

const TYPE_LABELS: Record<string, string> = {
  text: '文本',
  markdown: 'Markdown',
  url: '网址',
  faq: 'FAQ',
  docx: 'Word',
  xlsx: 'Excel',
  pdf: 'PDF',
  doc: 'Word(旧)',
  xls: 'Excel(旧)'
}

const mode = ref<'file' | 'text' | 'url' | 'faq'>('file')
const filePath = ref('')
const text = ref('')
const url = ref('')
const title = ref('')
const importing = ref(false)
const importError = ref('')
const dropping = ref(false)
const query = ref('')
const hits = ref<Array<{ id: string; title: string; snippet: string }> | null>(null)
const expanded = ref<string | null>(null)

const knowledgeLoading = computed(() => marketing.knowledgeLoading)
const knowledgeComp = computed(() => marketing.knowledgeCompleteness)
const overall = computed(() => marketing.overallCompleteness)

const canImport = computed(() => {
  if (mode.value === 'file') return !!filePath.value
  if (mode.value === 'url') return /^https?:\/\/.+/.test(url.value.trim())
  return !!text.value.trim()
})

function extOf(p: string) {
  const m = /\.([a-z0-9]+)$/i.exec(p.trim())
  return m ? m[1].toLowerCase() : ''
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function preview(k: { content: string | null }) {
  const c = (k.content || '').trim()
  if (!c) return '（无正文）'
  return c.length > 2000 ? c.slice(0, 2000) + '\n…（已截断，仅预览）' : c
}

async function reload() {
  if (marketing.currentProjectId) await marketing.loadKnowledge(marketing.currentProjectId)
}

async function pickFile() {
  try {
    const res = await window.api.marketing.knowledge.pickFile()
    const p = res?.data?.filePath
    if (p) filePath.value = p
  } catch (e) {
    importError.value = (e as Error)?.message || '打开文件选择器失败'
  }
}

function onDrop(e: DragEvent) {
  dropping.value = false
  const f = e.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined
  const p = f?.path
  if (p) {
    mode.value = 'file'
    filePath.value = p
  } else {
    showToast('没能拿到文件路径，请用「选择文件」按钮', 'error')
  }
}

async function doImport() {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  importing.value = true
  importError.value = ''
  const t = title.value.trim()
  try {
    if (mode.value === 'file') {
      await marketing.importKnowledge(projectId, {
        type: extOf(filePath.value),
        title: t || undefined,
        filePath: filePath.value
      })
    } else if (mode.value === 'url') {
      await marketing.importKnowledge(projectId, { type: 'url', title: t || undefined, url: url.value.trim() })
    } else if (mode.value === 'faq') {
      await marketing.importKnowledge(projectId, { type: 'faq', title: t || undefined, text: text.value })
    } else {
      await marketing.importKnowledge(projectId, { type: 'text', title: t || undefined, text: text.value })
    }
    filePath.value = ''
    text.value = ''
    url.value = ''
    title.value = ''
    showToast('导入成功', 'success')
  } catch (e) {
    importError.value = (e as Error)?.message || marketing.error || '导入失败'
  } finally {
    importing.value = false
  }
}

async function doSearch() {
  const projectId = marketing.currentProjectId
  const q = query.value.trim()
  if (!projectId || !q) return
  try {
    hits.value = await marketing.searchKnowledge(projectId, q)
  } catch (e) {
    showToast((e as Error)?.message || '搜索失败', 'error')
  }
}

function clearSearch() {
  hits.value = null
  query.value = ''
}

function toggleExpand(id: string) {
  expanded.value = expanded.value === id ? null : id
}

async function removeItem(k: { id: string; title: string }) {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  try {
    await marketing.removeKnowledge(projectId, k.id)
    if (hits.value) hits.value = hits.value.filter((h) => h.id !== k.id)
    showToast(`已删除「${k.title}」`, 'success')
  } catch (e) {
    showToast((e as Error)?.message || '删除失败', 'error')
  }
}

onMounted(async () => {
  if (!marketing.projects.length) await marketing.load()
  await reload()
})

watch(
  () => marketing.currentProjectId,
  () => {
    hits.value = null
    expanded.value = null
    reload()
  }
)
</script>

<style scoped>
.kb { display: flex; flex-direction: column; gap: 20px; width: 100%; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; }

.empty-card {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px 24px; text-align: center;
}

/* 完整度小条 */
.comp-strip { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
.comp-label { font-size: 13px; font-weight: 600; white-space: nowrap; }
.comp-bar {
  flex: 1; height: 8px; border-radius: 999px; background: var(--bg-base);
  border: 1px solid var(--border-muted); overflow: hidden;
}
.comp-bar-fill {
  height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transition: width 0.3s ease;
}

/* tabs */
.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tab {
  padding: 5px 12px; font-size: 13px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted); background: var(--bg-base);
  color: var(--text-secondary); cursor: pointer; transition: all 0.12s;
}
.tab:hover { border-color: var(--accent); color: var(--accent); }
.tab.on { background: var(--accent-muted); border-color: var(--accent); color: var(--accent); }

/* 导入区 */
.imp-body {
  border: 1px dashed var(--border-muted); border-radius: var(--radius-sm);
  padding: 14px; transition: all 0.15s;
}
.imp-body.dropping { border-color: var(--accent); background: var(--accent-muted); }
.file-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.muted { color: var(--text-muted); }
.imp-footer { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }

/* 检索 */
.search-row { display: flex; gap: 8px; }
.hits { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.hit {
  display: flex; flex-direction: column; gap: 2px; padding: 8px 10px;
  border-radius: var(--radius-sm); background: var(--bg-base); border: 1px solid var(--border-muted);
}
.hit-title { font-size: 13px; font-weight: 600; }
.hit-snippet { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }

/* 列表 */
.items { display: flex; flex-direction: column; gap: 6px; }
.item { border: 1px solid var(--border-muted); border-radius: var(--radius-sm); background: var(--bg-elevated); }
.item.failed { border-color: rgba(248, 81, 73, 0.4); }
.item-head {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer;
}
.item-title { flex: 1; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-time { white-space: nowrap; }
.item-body { padding: 0 12px 12px; }
.preview {
  margin: 0; max-height: 260px; overflow: auto; padding: 10px;
  background: var(--bg-base); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); font-family: var(--font-mono);
  font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}
.err { margin-top: 10px; font-size: 13px; color: var(--red); }

.toast {
  position: fixed; bottom: 24px; right: 24px; padding: 10px 18px;
  border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; z-index: 999;
}
.toast.success { background: rgba(63, 185, 80, 0.9); color: #fff; }
.toast.error { background: rgba(248, 81, 73, 0.9); color: #fff; }
</style>
