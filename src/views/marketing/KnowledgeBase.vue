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

        <div v-if="importError" class="err">
          {{ importError }}
          <!-- 05b：扫描件/资料图的「用 AI 识别」——**用户显式触发**，识别结果人工确认后才入库 -->
          <div v-if="canRecognize" class="rec-actions">
            <button class="btn btn-primary btn-sm" :disabled="marketing.scanStreaming" @click="startRecognize()">
              用 AI 识别
            </button>
            <span class="text-sm text-muted">（{{ recognizeHint }}）</span>
          </div>
        </div>

        <!-- 05b：识别进行中 / 待确认 -->
        <div v-if="marketing.scanTask && (marketing.scanStreaming || marketing.scanCleanText || marketing.scanErrorMessage)" class="rec-box">
          <div class="rec-head">
            <span class="text-sm">AI 识别：{{ marketing.scanTask.suggestedTitle || marketing.scanTask.filePath }}</span>
            <span class="badge">{{ marketing.scanTask.kind === 'pdf' ? `扫描 PDF · ${marketing.scanTask.images.length} 页` : '资料图' }}</span>
            <span v-if="marketing.scanTask.images.some((i) => i.downscaled)" class="text-sm text-muted">部分页已降采样</span>
            <span v-if="marketing.scanStreaming" class="text-sm text-muted">逐页识别中…</span>
            <span v-else-if="marketing.scanAborted" class="text-sm" style="color: var(--yellow)">已停止（保留已识别部分）</span>
          </div>
          <div v-if="marketing.scanErrorCode" class="err" style="margin-top: 6px">
            {{ scanErrorText }}
            <div v-if="scanErrorNeedsSetup" class="rec-actions">
              <button class="btn btn-sm" :disabled="gatewayStarting" @click="ensureGatewayReady()">
                {{ gatewayStarting ? '启动中…' : '启动 OpenClaw 后重试' }}
              </button>
            </div>
          </div>
          <pre v-if="marketing.scanCleanText" class="preview rec-preview">{{ marketing.scanCleanText }}</pre>
          <div class="rec-actions">
            <button v-if="marketing.scanStreaming" class="btn" @click="marketing.stopRecognize()">停止识别</button>
            <button v-else-if="hasUsefulScanText" class="btn btn-primary" @click="openConfirmDialog()">确认识别结果…</button>
            <button v-if="!marketing.scanStreaming" class="btn btn-sm" @click="marketing.clearScan()">忽略</button>
          </div>
        </div>
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

    <!-- 05b：识别结果人工确认弹窗（硬规则 10：确认后才入库，内容可就地校对） -->
    <div v-if="confirmOpen" class="modal-mask" @click.self="closeConfirmDialog()">
      <div class="modal">
        <h3>确认识别结果</h3>
        <p v-if="confirmPriceSuspected" class="price-warn">
          ⚠️ 识别内容疑似包含价格：**价格数字请人工核对**后再入库（模型识别可能错读/串行）！
        </p>
        <p class="text-sm text-muted" style="margin: 4px 0 10px">
          下方文本由 AI 从图像转录，尚未入库。可直接修改后确认；取消则不落库。
        </p>
        <input class="form-input" style="margin-bottom: 8px" placeholder="标题（默认用文件名）" v-model="confirmTitle" />
        <textarea class="form-textarea" rows="12" v-model="confirmContent"></textarea>
        <div class="rec-actions" style="justify-content: flex-end; margin-top: 12px">
          <button class="btn" :disabled="confirmSaving" @click="closeConfirmDialog()">取消</button>
          <button class="btn btn-primary" :disabled="confirmSaving || !confirmContent.trim()" @click="doCommitRecognized()">
            {{ confirmSaving ? '入库中…' : '确认入库' }}
          </button>
        </div>
        <div v-if="confirmError" class="err" style="margin-top: 8px">{{ confirmError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMarketingStore, MarketingIpcError, PRICE_SUSPECT_REGEX } from '@/stores/marketing'
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
  if (mode.value === 'file') {
    // 资料图（png/jpg/webp）不走确定性导入（没文字层可抽），由「用 AI 识别」按钮承接
    return !!filePath.value && !SCAN_IMAGE_EXTS.includes(extOf(filePath.value))
  }
  if (mode.value === 'url') return /^https?:\/\/.+/.test(url.value.trim())
  return !!text.value.trim()
})

/** 文件扩展名 → 导入类型（txt/md 走 text/markdown 文本文件路径，不是文档解析链路） */
const FILE_IMPORT_TYPE_BY_EXT: Record<string, string> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
  txt: 'text',
  md: 'markdown'
}

/** 05b：可走「用 AI 识别」的扩展名（扫描 PDF + 带文字资料图；客片/商品图属二期 Assets，不在本功能范围） */
const SCAN_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp']

function scanKindOf(p: string): 'pdf' | 'image' | null {
  const ext = extOf(p)
  if (ext === 'pdf') return 'pdf'
  if (SCAN_IMAGE_EXTS.includes(ext)) return 'image'
  return null
}

/**
 * 「用 AI 识别」按钮的出现条件（显式触发入口）：
 *   - 刚导入了扫描 PDF（撞 scanned-pdf 报错，filePath 仍在手上），或
 *   - 选的是资料图文件（png/jpg/webp，本就走不了确定性导入）
 */
const canRecognize = computed(() => {
  if (!marketing.currentProjectId || !filePath.value) return false
  if (marketing.scanStreaming) return false
  const kind = scanKindOf(filePath.value)
  if (!kind) return false
  if (kind === 'image') return true
  // PDF：只在「扫描件/无文字层」报错后出现（正常文字层 PDF 应直接导入）
  return scannedPdfHit.value
})

const recognizeHint = computed(() => {
  const kind = scanKindOf(filePath.value)
  return kind === 'image' ? '资料图无文字层，走 AI 转录，结果需人工确认' : '未检测到文字层（扫描件），走 AI 转录，结果需人工确认'
})

/** 撞过 scanned-pdf / empty-text 类解析错误的标记（记住本次文件路径，导入前重置） */
const scannedPdfHit = ref(false)

/** 识别错误的「人话」：multimodal 未配置按 07 口径翻成配置引导，绝不静默降级纯文本 */
const scanErrorText = computed(() => {
  if (marketing.scanErrorReason === 'multimodal-model-not-configured') {
    return '当前模型不支持图片输入（多模态未配置）：请到「配置」选择支持图片的模型后重试。AI 不会在看不见图的情况下假装识别。'
  }
  if (marketing.scanErrorCode === 'OPENCLAW_NOT_READY' || marketing.scanErrorCode === 'SETUP_REQUIRED') {
    return marketing.scanErrorMessage || 'OpenClaw 尚未就绪，无法识别。'
  }
  return marketing.scanErrorMessage || '识别失败'
})

const scanErrorNeedsSetup = computed(
  () => marketing.scanErrorCode === 'OPENCLAW_NOT_READY' || marketing.scanErrorCode === 'SETUP_REQUIRED'
)
const gatewayStarting = ref(false)

async function ensureGatewayReady() {
  gatewayStarting.value = true
  try {
    const res = await window.api.marketing.gateway.ensureReady()
    if (res?.ok && res.data?.ready) {
      showToast('OpenClaw 已就绪，请重新点「用 AI 识别」', 'success')
      marketing.clearScan()
    } else {
      showToast('OpenClaw 仍未就绪，可到环境初始化检查', 'error')
    }
  } catch {
    showToast('启动 OpenClaw 失败，请到环境初始化检查', 'error')
  } finally {
    gatewayStarting.value = false
  }
}

/** 有可用文本（剥掉进度标记后≥ 2 字）才能进确认弹窗 */
const hasUsefulScanText = computed(() => marketing.scanCleanText.length >= 2)

async function startRecognize() {
  const projectId = marketing.currentProjectId
  if (!projectId || !filePath.value) return
  const kind = scanKindOf(filePath.value)
  if (!kind) return
  importError.value = ''
  try {
    // 返回 null = await 期间切了商家/按了停止（代际守卫），静默收场
    await marketing.recognizeScan(projectId, { filePath: filePath.value, type: kind })
  } catch (e) {
    // 错误详情已由 store 填进 scanErrorCode/Reason/Text，面板内展示；这里不另弹 toast
    void e
  }
}

// ── 确认弹窗（硬规则 10：人工校对后才落库） ──
const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmContent = ref('')
const confirmSaving = ref(false)
const confirmError = ref('')
const confirmPriceSuspected = ref(false)

function openConfirmDialog() {
  // 以**剥掉进度标记的干净文本**为基准（中止态没有 done 的权威汇总替换，这里是最后兜底）
  confirmTitle.value = marketing.scanTask?.suggestedTitle || ''
  confirmContent.value = marketing.scanCleanText
  confirmPriceSuspected.value = PRICE_SUSPECT_REGEX.test(marketing.scanCleanText)
  confirmError.value = ''
  confirmOpen.value = true
}

function closeConfirmDialog() {
  // 取消≠删除识别结果：面板里的文本保留，可再次点「确认」
  confirmOpen.value = false
  confirmSaving.value = false
  confirmError.value = ''
}

async function doCommitRecognized() {
  const projectId = marketing.currentProjectId
  const task = marketing.scanTask
  if (!projectId || !task) return
  const content = confirmContent.value.trim()
  if (!content) {
    confirmError.value = '识别文本为空，不能入库'
    return
  }
  confirmSaving.value = true
  confirmError.value = ''
  try {
    await marketing.commitRecognized(projectId, {
      filePath: task.filePath,
      type: task.kind,
      title: confirmTitle.value.trim() || null,
      content
    })
    confirmOpen.value = false
    filePath.value = ''
    scannedPdfHit.value = false
    showToast('已确认识别结果并入库', 'success')
  } catch (e) {
    confirmError.value =
      e instanceof MarketingIpcError && e.code === 'FILE_NOT_FOUND'
        ? '原始文件已不在（可能被移动），无法入库；请重新选择文件再识别'
        : (e as Error)?.message || '确认入库失败'
  } finally {
    confirmSaving.value = false
  }
}

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
  scannedPdfHit.value = false
  try {
    if (mode.value === 'file') {
      const ext = extOf(filePath.value)
      const importType = FILE_IMPORT_TYPE_BY_EXT[ext]
      if (!importType) {
        if (SCAN_IMAGE_EXTS.includes(ext)) {
          // 资料图：不进确定性导入，直接引导到显式触发的 AI 识别
          importError.value = '图片没有文字层可本地抽取，请用下方「用 AI 识别」（识别结果需人工确认后才入库）'
        } else {
          importError.value = '仅支持 docx / xlsx / pdf / txt / md 文件（doc、xls 旧格式请先另存为新格式）'
        }
        return
      }
      await marketing.importKnowledge(projectId, {
        type: importType,
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
    // 记住扫描件事实：撞 FILE_PARSE_ERROR + reason=scanned-pdf 才亮「用 AI 识别」
    const details = (e as { details?: { reason?: unknown } } | undefined)?.details
    scannedPdfHit.value =
      e instanceof MarketingIpcError &&
      e.code === 'FILE_PARSE_ERROR' &&
      details?.reason === 'scanned-pdf'
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
    // 05b 四路中止之二：切换商家 → 中止在途识别并清空待确认文本（未入库的丢弃，防串到别家）
    marketing.clearScan()
    confirmOpen.value = false
    reload()
  }
)

onBeforeUnmount(() => {
  // 05b 四路中止之三：组件卸载 → 断上游 + 注销全局订阅（退出那路在主进程 before-quit）
  marketing.clearScan()
  marketing.disposeScan()
})
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

/* 05b 扫描件识别 */
.rec-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.rec-box {
  margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted); background: var(--bg-base);
}
.rec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rec-preview { margin-top: 8px; max-height: 220px; }
.price-warn {
  margin: 0 0 8px; padding: 8px 10px; border-radius: var(--radius-sm);
  background: rgba(227, 179, 65, 0.15); border: 1px solid rgba(227, 179, 65, 0.55);
  color: var(--yellow); font-size: 13px; font-weight: 600;
}
.modal-mask {
  position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: min(720px, 94vw); max-height: 88vh; overflow: auto; padding: 18px 20px;
  border-radius: var(--radius); background: var(--bg-elevated); border: 1px solid var(--border-muted);
}
.modal .form-textarea { width: 100%; resize: vertical; }

.toast {
  position: fixed; bottom: 24px; right: 24px; padding: 10px 18px;
  border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; z-index: 999;
}
.toast.success { background: rgba(63, 185, 80, 0.9); color: #fff; }
.toast.error { background: rgba(248, 81, 73, 0.9); color: #fff; }
</style>
