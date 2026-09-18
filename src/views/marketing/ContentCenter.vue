<template>
  <div class="cc">
    <div class="page-header">
      <div>
        <h1>Content Center</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          {{
            marketing.currentProject
              ? `${marketing.currentProject.name} · AI 生成 → 编辑 → 版本 → 人工审核发布`
              : '内容按 Project 隔离，先选一个商家'
          }}
        </p>
      </div>
      <div class="flex gap-2" v-if="marketing.currentProjectId">
        <button class="btn" :disabled="listLoading" @click="reload()">
          {{ listLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!marketing.currentProjectId" class="card empty-card">
      <div style="font-size: 32px">✍️</div>
      <h3>还没有选择商家</h3>
      <p class="text-muted text-sm" style="max-width: 460px; line-height: 1.7">
        内容与商家资料绑定：AI 只会用这位老板知识库里的价格与卖点写稿，资料里没有的不编。
      </p>
      <button class="btn btn-primary" @click="switcher.show()">打开商家切换器</button>
    </div>

    <template v-else>
      <!-- 热点 payload 带入提示（11 上线前的接收端；手工路径不会出现） -->
      <div v-if="prefill" class="card prefill-strip">
        <span class="text-sm">
          来自热点雷达：<b>{{ prefill.title }}</b>
          <span class="text-muted">（来源 {{ prefill.sourcePlatform || '未知平台' }}）</span>
          <template v-if="prefill.contentAngle"> · 建议角度：{{ prefill.contentAngle }}</template>
          <template v-if="prefill.lifecycleAdvice"> · {{ prefill.lifecycleAdvice }}</template>
        </span>
        <button class="btn btn-sm" @click="prefill = null">清除</button>
      </div>

      <!-- 生成 -->
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom: 12px">
          <h3>AI 生成（一次 3 版供选）</h3>
          <span class="text-sm text-muted">产出一律人工采纳，永不自动发布</span>
        </div>

        <div class="gen-form">
          <div class="gen-row">
            <span class="gen-label">发布平台</span>
            <div class="tabs">
              <button
                v-for="p in CONTENT_PLATFORM_OPTIONS"
                :key="p.key"
                class="tab"
                :class="{ on: platform === p.key }"
                @click="platform = p.key"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
          <div class="gen-row">
            <span class="gen-label">选题</span>
            <input
              class="form-input"
              style="flex: 1"
              placeholder="想写什么？（留空 = AI 从资料里挑最能打的点）"
              v-model="topic"
            />
          </div>
          <div class="gen-row">
            <span class="gen-label">补充</span>
            <input class="form-input" style="flex: 1" placeholder="面向的具体客户/场景（可选）" v-model="customer" />
          </div>
          <div class="gen-footer">
            <button
              class="btn btn-primary"
              :disabled="marketing.contentGenStreaming || !platform"
              @click="doGenerate()"
            >
              {{ marketing.contentGenStreaming ? '生成中…' : '生成 3 个版本' }}
            </button>
            <button v-if="marketing.contentGenStreaming" class="btn" @click="marketing.stopGenerate()">停止生成</button>
            <span v-if="genError" class="err" style="margin-top: 0">{{ genError }}</span>
          </div>
        </div>

        <!-- 三路流式面板（按 streamId 归并；store 里已是全局单次订阅） -->
        <div v-if="marketing.contentGen" class="gen-slots">
          <div class="pack-hint text-sm text-muted">
            AI 看见了：资料 {{ marketing.contentGen.pack?.knowledgeIncluded ?? 0 }}/{{ marketing.contentGen.pack?.knowledgeTotal ?? 0 }} 条注入（{{ marketing.contentGen.pack?.mode === 'truncated' ? '超预算已裁剪' : '全量' }}）
            <template v-if="marketing.contentGen.pack?.businessCompleteness.missing.length">
              · 缺口：{{ marketing.contentGen.pack.businessCompleteness.missing.map((f: string) => BUSINESS_FIELD_LABELS[f] || f).join('、') }}
            </template>
          </div>
          <div v-for="slot in marketing.contentGen.angles" :key="slot.streamId" class="slot">
            <div class="slot-head">
              <span class="badge">{{ slot.label }}</span>
              <span v-if="slot.streaming" class="text-sm text-muted">生成中…</span>
              <span v-else-if="slot.aborted" class="text-sm" style="color: var(--yellow)">已停止（此版不落库）</span>
              <span v-else-if="slot.errorCode" class="text-sm" style="color: var(--red)">{{ errorText(slot) }}</span>
              <span v-else-if="slot.done" class="text-sm text-muted">完成</span>
              <span style="flex: 1"></span>
              <button
                v-if="slot.done && !slot.aborted && !slot.errorCode && slot.text.trim() && adopted[slot.streamId] !== true"
                class="btn btn-sm btn-primary"
                @click="adoptSlot(slot)"
              >
                采用为正文
              </button>
              <span v-if="adopted[slot.streamId] === true" class="text-sm" style="color: var(--green)">已采用 ✓</span>
            </div>
            <pre class="slot-body">{{ slot.text || '…' }}</pre>
          </div>
          <div class="gen-actions">
            <button class="btn btn-sm" :disabled="marketing.contentGenStreaming" @click="closeGen()">
              完成（收起面板）
            </button>
          </div>
        </div>
      </div>

      <!-- 内容列表 -->
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom: 12px">
          <h3>内容</h3>
          <div class="tabs">
            <button class="tab" :class="{ on: filterStatus === '' }" @click="setFilter('')">全部</button>
            <button
              v-for="s in CONTENT_STATUSES"
              :key="s"
              class="tab"
              :class="{ on: filterStatus === s }"
              @click="setFilter(s)"
            >
              {{ CONTENT_STATUS_LABELS[s] }}
            </button>
          </div>
        </div>
        <div v-if="listLoading && !marketing.contents.length" class="text-sm text-muted">加载中…</div>
        <div v-else-if="!marketing.contents.length" class="text-sm text-muted">
          还没有内容。点上方「生成 3 个版本」试试，或先想一个选题。
        </div>
        <div v-else class="items">
          <div
            v-for="c in marketing.contents"
            :key="c.id"
            class="item"
            :class="{ on: editor?.id === c.id }"
            @click="openEditor(c)"
          >
            <span class="badge">{{ CONTENT_STATUS_LABELS[c.status] || c.status }}</span>
            <span class="badge badge-plain">{{ PLATFORM_LABELS[c.platform || ''] || '未选平台' }}</span>
            <span class="item-title">{{ c.title || c.topic || '（无标题草稿）' }}</span>
            <span v-if="c.published_at" class="text-sm text-muted">发布于 {{ formatTime(c.published_at) }}</span>
            <span class="item-time text-sm text-muted">{{ formatTime(c.updated_at) }}</span>
            <button class="btn btn-sm" @click.stop="removeItem(c)">删除</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 编辑弹窗：成稿编辑 + 状态推进 + 版本历史 -->
    <div v-if="editor" class="modal-mask" @click.self="closeEditor()">
      <div class="modal">
        <div class="flex items-center justify-between">
          <h3>编辑内容</h3>
          <span class="badge">{{ CONTENT_STATUS_LABELS[editor.status] || editor.status }}</span>
        </div>
        <div class="edit-grid">
          <input class="form-input" placeholder="标题" v-model="editor.title" />
          <input class="form-input" placeholder="选题/主题" v-model="editor.topic" />
          <div class="gen-row">
            <span class="gen-label">平台</span>
            <div class="tabs">
              <button
                v-for="p in CONTENT_PLATFORM_OPTIONS"
                :key="p.key"
                class="tab"
                :class="{ on: editor.platform === p.key }"
                @click="editor.platform = p.key"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
          <textarea class="form-textarea" rows="12" placeholder="正文…" v-model="editor.content"></textarea>
          <div v-if="editorPriceWarn" class="price-warn">
            ⚠️ 正文疑似包含价格：发布前请人工核对数字（资料与成稿都要对得上）。
          </div>
        </div>

        <div class="edit-actions">
          <button class="btn btn-primary" :disabled="saving" @click="saveDraftEdit()">保存修改</button>
          <button v-if="editor.status === 'draft'" class="btn" :disabled="saving" @click="setStatus('review')">提交审核</button>
          <button v-if="editor.status === 'review'" class="btn" :disabled="saving" @click="setStatus('approved')">审核通过</button>
          <button v-if="editor.status === 'approved' || editor.status === 'draft'" class="btn" :disabled="saving" @click="markPublished()">标记已发布</button>
          <button v-if="editor.status !== 'archived'" class="btn btn-sm" :disabled="saving" @click="setStatus('archived')">归档</button>
          <button class="btn btn-sm" @click="regenOnEditor()" :disabled="marketing.contentGenStreaming">在此草稿上再生成 3 版</button>
        </div>
        <div v-if="editor.status === 'published'" class="gen-row" style="margin-top: 10px">
          <span class="gen-label">效果</span>
          <input
            class="form-input"
            style="flex: 1"
            placeholder="发布效果备注（可选，例：爆了 / 一般 / 没动静）——这是三期学习唯一的真实标签来源"
            v-model="editor.effect_note"
            @change="saveEffectNote()"
          />
        </div>
        <div v-if="editError" class="err" style="margin-top: 8px">{{ editError }}</div>

        <!-- 版本历史 -->
        <div class="versions">
          <div class="flex items-center justify-between" style="margin-bottom: 6px">
            <h4 style="margin: 0">版本历史</h4>
            <button class="btn btn-sm" :disabled="!dirty" @click="saveAsUserVersion()">把当前编辑存为新版本</button>
          </div>
          <div v-if="!versions.length" class="text-sm text-muted">暂无版本（AI 采纳/手动改稿后会有）</div>
          <div v-for="v in versions" :key="v.id" class="ver">
            <div class="ver-head">
              <span class="badge" :class="v.source === 'ai' ? 'badge-ai' : 'badge-user'">v{{ v.version }} · {{ v.source === 'ai' ? 'AI' : '手改' }}</span>
              <span class="text-sm text-muted">{{ formatTime(v.created_at) }}</span>
              <span style="flex: 1"></span>
              <button class="btn btn-sm" @click="useVersion(v)">用这版</button>
              <button class="btn btn-sm" @click="showPrompt(v)" v-if="v.source === 'ai'">当时提示词</button>
            </div>
            <pre v-if="expandedVersion === v.id" class="ver-body">{{ v.content }}</pre>
          </div>
          <pre v-if="promptText" class="ver-body prompt-box">{{ promptText }}</pre>
        </div>
      </div>
    </div>

    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  useMarketingStore,
  MarketingIpcError,
  ERROR_TEXT,
  BUSINESS_FIELD_LABELS,
  CONTENT_STATUSES,
  CONTENT_STATUS_LABELS,
  PRICE_SUSPECT_REGEX,
  type ContentItem,
  type ContentAngleSlot,
  type ContentVersion
} from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import { useToast } from '@/composables/useToast'
import { consumeContentPrefill, type HotTopicPayload } from '@/composables/useContentPrefill'

const marketing = useMarketingStore()
const switcher = useProjectSwitcher()
const { toast, showToast } = useToast()

const CONTENT_PLATFORM_OPTIONS = [
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'douyin', label: '抖音' }
] as const

const PLATFORM_LABELS: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音'
}

// ── 生成表单 ──
const platform = ref<string>('xiaohongshu')
const topic = ref('')
const customer = ref('')
const genError = ref('')
const adopted = reactive<Record<string, boolean>>({})
const prefill = ref<HotTopicPayload | null>(null)

// ── 列表 ──
const filterStatus = ref('')
const listLoading = computed(() => marketing.contentsLoading)

// ── 编辑器 ──
interface EditorState {
  id: string
  title: string
  topic: string
  platform: string
  content: string
  status: string
  effect_note: string
  published_at: number | null
}
const editor = ref<EditorState | null>(null)
const editorSnapshot = ref('')
const versions = ref<ContentVersion[]>([]) as { value: ContentVersion[] }
const expandedVersion = ref<string | null>(null)
const promptText = ref('')
const saving = ref(false)
const editError = ref('')

const dirty = computed(() => {
  const e = editor.value
  if (!e) return false
  return editorSnapshot.value !== JSON.stringify([e.title, e.topic, e.platform, e.content])
})
const editorPriceWarn = computed(() => PRICE_SUSPECT_REGEX.test(editor.value?.content || ''))

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function errorText(slot: ContentAngleSlot): string {
  if (!slot.errorCode) return ''
  if (slot.errorCode === 'OPENCLAW_NOT_READY' || slot.errorCode === 'SETUP_REQUIRED') {
    return `${ERROR_TEXT[slot.errorCode]}（可在「环境初始化」检查 OpenClaw 后重试）`
  }
  return slot.errorMessage || ERROR_TEXT[slot.errorCode] || '生成失败'
}

async function reload() {
  const pid = marketing.currentProjectId
  if (!pid) return
  await marketing.loadContents(pid, filterStatus.value ? { status: filterStatus.value } : {})
}

function setFilter(s: string) {
  filterStatus.value = s
  reload()
}

async function doGenerate() {
  const pid = marketing.currentProjectId
  if (!pid) return
  genError.value = ''
  for (const k of Object.keys(adopted)) delete adopted[k]
  try {
    const res = await marketing.generateContent(pid, {
      platform: platform.value,
      topic: topic.value.trim() || null,
      customer: customer.value.trim() || null,
      // 热点 payload 只跟第一次生成（新建草稿）绑定
      sourceTopicId: prefill.value?.topicId ?? null
    })
    prefill.value = null
    if (res) showToast('3 个版本生成中，完成一个可用一个', 'success')
  } catch (e) {
    genError.value = e instanceof MarketingIpcError ? humanize(e) : (e as Error)?.message || '生成失败'
  }
}

function humanize(e: MarketingIpcError): string {
  if (e.code === 'OPENCLAW_NOT_READY' || e.code === 'SETUP_REQUIRED') {
    return `${e.message}（可到「环境初始化」检查 OpenClaw）`
  }
  return e.message
}

function closeGen() {
  marketing.clearGenerate()
}

async function adoptSlot(slot: ContentAngleSlot) {
  const gen = marketing.contentGen
  if (!gen) return
  const pid = marketing.currentProjectId
  if (!pid) return
  try {
    // 只发 content：带 title:undefined 会被白名单层的 hasOwnProperty 当成「显式要改」→ 抹成 null
    await marketing.updateContent(pid, gen.contentId, { content: slot.text })
    adopted[slot.streamId] = true
    showToast('已采用为正文（草稿），可继续编辑与审核', 'success')
    await reload()
    if (editor.value?.id === gen.contentId) await refreshEditorFromDb(gen.contentId)
  } catch (e) {
    showToast((e as Error)?.message || '采用失败', 'error')
  }
}

// ── 列表 → 编辑 ──
async function openEditor(c: ContentItem) {
  const pid = marketing.currentProjectId
  if (!pid) return
  editor.value = {
    id: c.id,
    title: c.title ?? '',
    topic: c.topic ?? '',
    platform: c.platform ?? '',
    content: c.content ?? '',
    status: c.status,
    effect_note: c.effect_note ?? '',
    published_at: c.published_at
  }
  editorSnapshot.value = snapshotOf(editor.value)
  editError.value = ''
  promptText.value = ''
  expandedVersion.value = null
  try {
    versions.value = await marketing.loadContentVersions(pid, c.id)
  } catch (e) {
    versions.value = []
    editError.value = (e as Error)?.message || '版本加载失败'
  }
}

function snapshotOf(e: EditorState): string {
  return JSON.stringify([e.title, e.topic, e.platform, e.content])
}

function closeEditor() {
  editor.value = null
  versions.value = []
}

async function refreshEditorFromDb(id: string) {
  const pid = marketing.currentProjectId
  if (!pid) return
  const row = marketing.contents.find((c) => c.id === id)
  if (row && editor.value?.id === id) {
    editor.value.content = row.content ?? ''
    editor.value.status = row.status
    editorSnapshot.value = snapshotOf(editor.value)
    versions.value = await marketing.loadContentVersions(pid, id)
  }
}

async function persistEditor(patch: Record<string, unknown>, okMsg: string, opts?: { keepSnapshot?: boolean }) {
  const pid = marketing.currentProjectId
  const e = editor.value
  if (!pid || !e) return false
  saving.value = true
  editError.value = ''
  try {
    const item = await marketing.updateContent(pid, e.id, patch as never)
    e.status = item.status
    e.published_at = item.published_at
    if (!opts?.keepSnapshot) editorSnapshot.value = snapshotOf(e)
    showToast(okMsg, 'success')
    versions.value = await marketing.loadContentVersions(pid, e.id)
    return true
  } catch (err) {
    editError.value = err instanceof MarketingIpcError ? err.message : (err as Error)?.message || '保存失败'
    return false
  } finally {
    saving.value = false
  }
}

async function saveDraftEdit() {
  const e = editor.value
  if (!e) return
  await persistEditor(
    {
      title: e.title.trim() || null,
      topic: e.topic.trim() || null,
      platform: e.platform || null,
      content: e.content
    },
    '已保存',
    { keepSnapshot: false }
  )
  await reload()
}

function setStatus(status: string) {
  const e = editor.value
  if (!e) return
  void persistEditor({ status }, `状态已更新为「${CONTENT_STATUS_LABELS[status] || status}」`).then(async (ok) => {
    if (ok) {
      e.status = status
      await reload()
    }
  })
}

function markPublished() {
  const e = editor.value
  if (!e) return
  if (!e.content.trim()) {
    editError.value = '还没有正文，不能标记为已发布（发布 = 人工对成稿的确认动作）'
    return
  }
  void persistEditor({ status: 'published' }, '已标记发布 —— 复制发布由你完成，我们不自动发').then((ok) => {
    if (ok) {
      e.published_at = Date.now()
      void reload()
    }
  })
}

function saveEffectNote() {
  const e = editor.value
  if (!e) return
  void persistEditor({ effect_note: e.effect_note.trim() || null }, '效果备注已保存（给三期的真实标签）', {
    keepSnapshot: true
  })
}

async function saveAsUserVersion() {
  const pid = marketing.currentProjectId
  const e = editor.value
  if (!pid || !e) return
  if (!e.content.trim()) {
    editError.value = '正文为空，不存版本'
    return
  }
  saving.value = true
  editError.value = ''
  try {
    await marketing.saveContentVersion(
      pid,
      e.id,
      { content: e.content, source: 'user' },
      { activate: true }
    )
    editorSnapshot.value = snapshotOf(e)
    versions.value = await marketing.loadContentVersions(pid, e.id)
    showToast('已存为新版本', 'success')
  } catch (err) {
    editError.value = (err as Error)?.message || '保存版本失败'
  } finally {
    saving.value = false
  }
}

function useVersion(v: ContentVersion) {
  const e = editor.value
  if (!e) return
  e.content = v.content
  editError.value = ''
  showToast('已载入该版本到编辑框（保存修改后生效）', 'success')
}

function showPrompt(v: ContentVersion) {
  promptText.value = promptText.value === (v.prompt ?? '') ? '' : String(v.prompt ?? '（无快照）')
}

async function regenOnEditor() {
  const pid = marketing.currentProjectId
  const e = editor.value
  if (!pid || !e) return
  genError.value = ''
  for (const k of Object.keys(adopted)) delete adopted[k]
  try {
    await marketing.generateContent(pid, {
      contentId: e.id,
      platform: e.platform || platform.value,
      topic: e.topic.trim() || null,
      customer: null
    })
    showToast('3 个新版本生成中（同角度并行，完成一个可用一个）', 'success')
  } catch (err) {
    genError.value = err instanceof MarketingIpcError ? humanize(err) : (err as Error)?.message || '生成失败'
  }
}

async function removeItem(c: ContentItem) {
  const pid = marketing.currentProjectId
  if (!pid) return
  try {
    await marketing.removeContent(pid, c.id)
    if (editor.value?.id === c.id) closeEditor()
    showToast('已删除（版本一并清除）', 'success')
  } catch (e) {
    showToast((e as Error)?.message || '删除失败', 'error')
  }
}

onMounted(async () => {
  if (!marketing.projects.length) await marketing.load()
  // 热点 payload 一次性消费（11 未上线前不会有真值；路径先行）
  const p = consumeContentPrefill()
  if (p) {
    prefill.value = p
    topic.value = p.title
    if (p.platform) platform.value = p.platform
  }
  await reload()
})

watch(
  () => marketing.currentProjectId,
  () => {
    // 四路中止之二：切商家 → 停生成 + 收面板（未采纳的流式文本丢弃，防串到别家）
    marketing.clearGenerate()
    closeEditor()
    prefill.value = null
    reload()
  }
)

onBeforeUnmount(() => {
  // 四路中止之三：组件卸载 → 停生成 + 注销订阅（退出那路在主进程 before-quit）
  marketing.clearGenerate()
  marketing.disposeContent()
})
</script>

<style scoped>
.cc { display: flex; flex-direction: column; gap: 20px; width: 100%; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; }

.empty-card {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 48px 24px; text-align: center;
}

.prefill-strip { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px; }

/* 生成表单 */
.gen-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.gen-label { font-size: 13px; color: var(--text-muted); width: 56px; flex-shrink: 0; }
.gen-footer { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; }
.tab {
  padding: 5px 12px; font-size: 13px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted); background: var(--bg-base);
  color: var(--text-secondary); cursor: pointer; transition: all 0.12s;
}
.tab:hover { border-color: var(--accent); color: var(--accent); }
.tab.on { background: var(--accent-muted); border-color: var(--accent); color: var(--accent); }

/* 三路槽位 */
.gen-slots { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.pack-hint { margin-bottom: 2px; }
.slot { border: 1px solid var(--border-muted); border-radius: var(--radius-sm); background: var(--bg-elevated); }
.slot-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; flex-wrap: wrap; }
.slot-body {
  margin: 0; padding: 0 12px 12px; max-height: 280px; overflow: auto;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.gen-actions { display: flex; justify-content: flex-end; }

/* 列表 */
.items { display: flex; flex-direction: column; gap: 6px; }
.item {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer;
  border: 1px solid var(--border-muted); border-radius: var(--radius-sm); background: var(--bg-elevated);
}
.item.on { border-color: var(--accent); }
.item-title { flex: 1; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-time { white-space: nowrap; }
.badge-plain { background: var(--bg-base); border: 1px solid var(--border-muted); }

/* 编辑弹窗 */
.modal-mask {
  position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: min(860px, 96vw); max-height: 90vh; overflow: auto; padding: 18px 20px;
  border-radius: var(--radius); background: var(--bg-elevated); border: 1px solid var(--border-muted);
}
.edit-grid { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.edit-grid .form-textarea { width: 100%; resize: vertical; }
.edit-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.price-warn {
  margin: 6px 0 0; padding: 8px 10px; border-radius: var(--radius-sm);
  background: rgba(227, 179, 65, 0.15); border: 1px solid rgba(227, 179, 65, 0.55);
  color: var(--yellow); font-size: 13px; font-weight: 600;
}

/* 版本 */
.versions { margin-top: 16px; border-top: 1px solid var(--border-muted); padding-top: 10px; }
.ver { border: 1px solid var(--border-muted); border-radius: var(--radius-sm); margin-bottom: 6px; background: var(--bg-base); }
.ver-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap; }
.ver-body {
  margin: 0; padding: 8px 12px; max-height: 220px; overflow: auto;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
.prompt-box { border-top: 1px dashed var(--border-muted); color: var(--text-muted); }
.badge-ai { background: rgba(122, 82, 255, 0.18); }
.badge-user { background: rgba(63, 185, 80, 0.16); }

.err { font-size: 13px; color: var(--red); }

.toast {
  position: fixed; bottom: 24px; right: 24px; padding: 10px 18px;
  border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; z-index: 1100;
}
.toast.success { background: rgba(63, 185, 80, 0.9); color: #fff; }
.toast.error { background: rgba(248, 81, 73, 0.9); color: #fff; }
</style>
