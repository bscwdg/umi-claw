<template>
  <div class="obsidian-page">
    <div class="page-header">
      <div>
        <h1>知识库</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          接入 Obsidian 笔记库：语义检索 + MCP 工具，按需喂片段，省 token
        </p>
      </div>
      <button class="btn btn-primary" @click="save" :disabled="saving">
        {{ saving ? '保存中...' : '💾 保存配置' }}
      </button>
    </div>

    <!-- 启用 + vault 路径 -->
    <div class="card section">
      <div class="row">
        <div style="flex: 1">
          <div class="label">启用 Obsidian 集成</div>
          <div class="text-muted text-sm">
            启用后写入 openclaw.json 的 mcp.servers.obsidian，需重启 OpenClaw 生效
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" v-model="cfg.enabled" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="form-group" style="margin-top: 16px">
        <span class="form-label">Vault 路径</span>
        <div class="flex gap-2">
          <input class="form-input" v-model="cfg.vaultPath" placeholder="选择 Obsidian 笔记库根目录" />
          <button class="btn" @click="selectVault">📁 选择文件夹</button>
        </div>
        <div v-if="cfg.vaultPath && !cfg.enabled" class="text-sm" style="color: var(--yellow); margin-top: 6px">
          ⚠ 已配置 vault 但未启用集成，开启后才会注入到 openclaw.json 的 mcp.servers.obsidian
        </div>
      </div>

      <!-- 主动检索开关 -->
      <div class="row" style="margin-top: 8px">
        <div style="flex: 1">
          <div class="label">主动检索</div>
          <div class="text-muted text-sm">
            开启后模型无需点名，问题可能涉及笔记内容时自动调用 search_notes 先检索再回答；
            关闭后仅在明确要求查知识库时才检索。改动保存并重启 OpenClaw 后生效。
          </div>
        </div>
        <label class="toggle">
          <input type="checkbox" v-model="cfg.proactiveSearch" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- embedding 配置 -->
    <div class="card section">
      <div class="form-group">
        <span class="form-label">Embedding 来源</span>
        <div class="source-tabs">
          <button class="source-tab" :class="{ active: cfg.embeddingSource === 'preset' }" @click="setSource('preset')">
            预设模型
          </button>
          <button class="source-tab" :class="{ active: cfg.embeddingSource === 'custom' }" @click="setSource('custom')">
            自定义
          </button>
        </div>
      </div>

      <!-- preset 模式：复用模型配置的 provider -->
      <div v-if="cfg.embeddingSource === 'preset'" class="form-group">
        <span class="form-label">Embedding 模型</span>
        <div class="flex gap-2">
          <select class="form-select" v-model="embeddingPresetId" @change="onPresetChange">
            <option value="">-- 选择预设 --</option>
            <optgroup v-for="g in groupedPresets" :key="g.id" :label="g.label">
              <option v-for="p in g.items" :key="p.id" :value="p.id">{{ p.name }}</option>
            </optgroup>
          </select>
          <button class="btn" @click="testEmbedding" :disabled="testing">
            {{ testing ? '测试中...' : '🔌 测试连通' }}
          </button>
        </div>
        <div v-if="embeddingTestResult" class="text-sm" :style="{ color: embeddingTestResult.success ? 'var(--green)' : 'var(--red)' }">
          {{ embeddingTestResult.success ? `✓ 连通，维度 ${embeddingTestResult.dim}` : `✗ ${embeddingTestResult.error}` }}
        </div>
        <div v-if="unavailableProviders.length" class="text-muted text-sm unavailable-tip">
          以下服务商不提供 embedding 接口：{{ unavailableProviders.join('、') }}
        </div>
        <span class="text-muted text-sm">
          凭据复用「模型配置」里该服务商的 API Key，需先在那里配好。
        </span>
      </div>

      <!-- custom 模式：直填凭据，接任意 OpenAI 兼容或 Cohere 服务 -->
      <div v-else class="form-group">
        <span class="form-label">自定义 Embedding 服务</span>
        <div class="flex gap-2" style="margin-bottom: 8px">
          <select class="form-select" v-model="cfg.customEmbedding!.adapter" style="max-width: 200px">
            <option value="openai">OpenAI 兼容</option>
            <option value="cohere">Cohere 格式</option>
          </select>
          <button class="btn" @click="testEmbedding" :disabled="testing">
            {{ testing ? '测试中...' : '🔌 测试连通' }}
          </button>
        </div>
        <div class="custom-grid">
          <input class="form-input" v-model="cfg.customEmbedding!.baseUrl" placeholder="Base URL，如 https://api.mistral.ai/v1" />
          <input class="form-input" v-model="cfg.customEmbedding!.model" placeholder="模型 id，如 mistral-embed" />
          <input class="form-input" type="password" v-model="cfg.customEmbedding!.apiKey" placeholder="API Key" />
          <input class="form-input" type="number" v-model.number="cfg.customEmbedding!.dim" placeholder="向量维度，如 1024" />
        </div>
        <div v-if="embeddingTestResult" class="text-sm" :style="{ color: embeddingTestResult.success ? 'var(--green)' : 'var(--red)' }">
          {{ embeddingTestResult.success ? `✓ 连通，维度 ${embeddingTestResult.dim}` : `✗ ${embeddingTestResult.error}` }}
        </div>
        <span class="text-muted text-sm">
          不依赖模型配置，直填即可。可接 Mistral / Jina / Voyage 等任意 OpenAI 兼容服务，或 Cohere。
        </span>
      </div>
    </div>

    <!-- 索引状态 -->
    <div class="card section">
      <div class="flex justify-between items-center" style="margin-bottom: 14px">
        <span class="label">索引状态</span>
        <div class="flex gap-2">
          <button v-if="status.indexing" class="btn btn-danger" @click="cancel">
            ⏹ 停止
          </button>
          <button class="btn btn-primary" @click="rebuild" :disabled="status.indexing">
            {{ status.indexing ? '⏳ 索引中...' : '🔄 重建索引' }}
          </button>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat">
          <div class="stat-num">{{ status.noteCount }}</div>
          <div class="stat-label">笔记</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ status.chunkCount }}</div>
          <div class="stat-label">文本块</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ status.embeddingDim || '-' }}</div>
          <div class="stat-label">向量维度</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ formatSize(status.dbSizeBytes) }}</div>
          <div class="stat-label">库大小</div>
        </div>
      </div>
      <div class="text-muted text-sm" style="margin-top: 12px">
        最后索引：{{ status.lastIndexedAt ? formatTime(status.lastIndexedAt) : '尚未索引' }}
        <span v-if="status.vaultPath"> · {{ status.vaultPath }}</span>
      </div>
      <div v-if="status.lastError" class="text-sm" style="color: var(--red); margin-top: 6px">
        ⚠ {{ status.lastError }}
      </div>
      <div v-if="truncatedFiles.length" class="truncated-tip">
        <div class="text-sm" style="color: var(--yellow); margin-bottom: 4px">
          ⚠ {{ truncatedFiles.length }} 篇笔记超出切块上限被截断（仅索引前 {{ cfg.maxChunksPerNote || 50 }} 块）
        </div>
        <div class="text-muted text-sm truncated-list">
          {{ truncatedFiles.join('、') }}
        </div>
      </div>
      <div v-if="embedErrorFiles.length" class="truncated-tip">
        <div class="text-sm" style="color: var(--red); margin-bottom: 4px">
          ⚠ {{ embedErrorFiles.length }} 篇笔记 embedding 失败（这些笔记只有文本索引，语义检索搜不到）
        </div>
        <div class="text-muted text-sm truncated-list">
          <div v-for="e in embedErrorFiles" :key="e.file">{{ e.file }}：{{ e.error }}</div>
        </div>
      </div>

      <!-- 进度条 -->
      <div v-if="progress" class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="text-muted text-sm">
          {{ progress.message || progress.phase }}<template v-if="progress.total"> ({{ progress.processed }}/{{ progress.total }})</template>
        </div>
      </div>
    </div>

    <!-- 检索测试 -->
    <div class="card section">
      <div class="flex justify-between items-center" style="margin-bottom: 10px">
        <div>
          <span class="label">检索测试</span>
          <div class="text-muted text-sm">
            与 OpenClaw 调用 <span class="mono">mcp__obsidian__search_notes</span> 同一条链路，输入问题直接看命中效果
          </div>
        </div>
      </div>
      <div class="search-bar">
        <input
          class="form-input"
          v-model="searchQuery"
          placeholder="输入自然语言问题，如：上次关于部署方案的笔记写了什么"
          @keyup.enter="runSearch"
        />
        <input class="form-input" v-model="searchTag" placeholder="#标签(可选)" style="max-width: 130px" />
        <select class="form-select" v-model.number="searchLimit" style="max-width: 90px">
          <option :value="3">3 条</option>
          <option :value="5">5 条</option>
          <option :value="10">10 条</option>
          <option :value="20">20 条</option>
        </select>
        <button class="btn btn-primary" @click="runSearch" :disabled="searching">
          {{ searching ? '检索中...' : '🔍 检索' }}
        </button>
      </div>

      <div v-if="searchError" class="text-sm" style="color: var(--red); margin-top: 8px">
        ⚠ {{ searchError }}
      </div>

      <div v-if="searchResult" class="search-meta text-muted text-sm">
        {{ searchResult.hits.length ? `${searchResult.hits.length} 条结果 · 耗时 ${searchResult.tookMs} ms` : '无命中结果' }}
      </div>
      <div v-if="searchResult && searchResult.hits.length" class="hit-list">
        <div v-for="(h, i) in searchResult.hits" :key="i" class="hit">
          <div class="hit-head">
            <span class="hit-score" :title="'相似度 ' + h.score">{{ h.score.toFixed(3) }}</span>
            <span class="hit-path mono">{{ h.filePath }}<template v-if="h.headingPath"> › {{ h.headingPath }}</template></span>
            <span v-for="t in h.tags" :key="t" class="tag-chip">#{{ t }}</span>
          </div>
          <div class="hit-score-bar"><div class="hit-score-fill" :style="{ width: hitPct(h.score) + '%' }"></div></div>
          <div class="hit-content">{{ h.content }}</div>
        </div>
      </div>
    </div>

    <!-- 使用说明 -->
    <div class="card section">
      <div class="label" style="margin-bottom: 8px">使用步骤</div>
      <ol class="text-sm steps">
        <li>在「模型配置」为某服务商填好 API Key（通义千问 / 智谱 / 硅基流动 / 豆包 / OpenAI）</li>
        <li>选择 Vault 路径（你的 Obsidian 笔记库目录）</li>
        <li>选择 Embedding 模型并测试连通</li>
        <li>点击「重建索引」（首次较慢，后续增量）</li>
        <li>启用集成并保存配置</li>
        <li>重启 OpenClaw，模型即可调用 <span class="mono">mcp__obsidian__search_notes</span> 等工具</li>
      </ol>
    </div>

    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useToast } from '@/composables/useToast'

const { toast, showToast } = useToast()

interface CustomEmbedding {
  baseUrl: string
  apiKey: string
  model: string
  dim: number
  adapter: 'openai' | 'cohere'
}
interface ObsidianConfig {
  enabled: boolean
  vaultPath: string
  embeddingSource: 'preset' | 'custom'
  embeddingProviderId: string
  embeddingModel: string
  embeddingAdapter: 'openai' | 'cohere'
  customEmbedding?: CustomEmbedding
  chunkSize?: number
  maxChunksPerNote?: number
  proactiveSearch?: boolean
}
interface IndexStatus {
  indexing: boolean
  noteCount: number
  chunkCount: number
  lastIndexedAt: number | null
  dbSizeBytes: number
  embeddingModel: string | null
  embeddingDim: number | null
  vaultPath: string | null
  lastError: string | null
  truncatedFiles: string[]
  embedErrors: Array<{ file: string; error: string }>
}
interface EmbeddingPreset {
  id: string
  name: string
  providerId: string
  modelId: string
  dim: number
  adapter: 'openai' | 'cohere'
}

// 与后端 PROVIDERS_WITHOUT_EMBEDDING 对应：这些 provider 无 embedding 接口
const PROVIDERS_WITHOUT_EMBEDDING = ['deepseek', 'kimi', 'minimax', 'longCat', 'anthropic', 'bailian-token-plan']

const cfg = ref<ObsidianConfig>({
  enabled: false,
  vaultPath: '',
  embeddingSource: 'preset',
  embeddingProviderId: '',
  embeddingModel: '',
  embeddingAdapter: 'openai',
  customEmbedding: { baseUrl: '', apiKey: '', model: '', dim: 1024, adapter: 'openai' },
  chunkSize: 800,
  maxChunksPerNote: 50,
  proactiveSearch: true
})
const presets = ref<EmbeddingPreset[]>([])
const embeddingPresetId = ref('')
const status = ref<IndexStatus>({
  indexing: false,
  noteCount: 0,
  chunkCount: 0,
  lastIndexedAt: null,
  dbSizeBytes: 0,
  embeddingModel: null,
  embeddingDim: null,
  vaultPath: null,
  lastError: null,
  truncatedFiles: [],
  embedErrors: []
})
const progress = ref<{ phase: string; processed: number; total: number; message?: string } | null>(null)
const saving = ref(false)
const testing = ref(false)
const embeddingTestResult = ref<{ success: boolean; dim?: number; error?: string } | null>(null)

const progressPct = computed(() => {
  const p = progress.value
  if (!p) return 0
  if (p.phase === 'done') return 100
  if (!p.total) return 0
  return Math.round((p.processed / p.total) * 100)
})

/** 可用预设：排除不提供 embedding 的 provider */
const availablePresets = computed(() =>
  presets.value.filter((p) => !PROVIDERS_WITHOUT_EMBEDDING.includes(p.providerId))
)

/** providerId -> 人类可读分组名（火山方舟两套必须分开） */
const PROVIDER_LABELS: Record<string, string> = {
  bailian: '阿里云百炼',
  zhipu: '智谱 AI',
  siliconflow: '硅基流动',
  volcengine: '豆包·火山方舟（旧版 /api/v3）',
  'volcengine-agent-plan': '豆包·火山方舟（套餐 /api/plan/v3）',
  openai: 'OpenAI',
  custom: '本地（Ollama 等 OpenAI 兼容端点）'
}
// 固定显示顺序；未列入的 provider 字典序拼到末尾
const PROVIDER_ORDER: readonly string[] = [
  'bailian', 'zhipu', 'siliconflow', 'volcengine', 'volcengine-agent-plan', 'openai', 'custom'
]
const groupedPresets = computed(() => {
  const grouped = new Map<string, typeof availablePresets.value>()
  for (const p of availablePresets.value) {
    const arr = grouped.get(p.providerId) ?? []
    arr.push(p)
    grouped.set(p.providerId, arr)
  }
  const ordered: { id: string; label: string; items: typeof availablePresets.value }[] = []
  for (const id of PROVIDER_ORDER) {
    const items = grouped.get(id)
    if (items && items.length) {
      ordered.push({ id, label: PROVIDER_LABELS[id] || id, items })
      grouped.delete(id)
    }
  }
  for (const [id, items] of grouped) {
    ordered.push({ id, label: PROVIDER_LABELS[id] || id, items })
  }
  return ordered
})

/** 已填了 API Key 但不提供 embedding 接口的服务商名（供提示）。
 * 数据源是「模型配置」里的 providers（而不是预设列表）——预设列表里根本
 * 不会收录这些 provider，从预设筛永远为空，提示永远不显示。 */
const configuredProviderIds = ref<string[]>([])
const unavailableProviders = computed(() => {
  const names: Record<string, string> = {
    deepseek: 'DeepSeek', kimi: 'Kimi', minimax: 'MiniMax',
    longCat: '美团', anthropic: 'Anthropic', 'bailian-token-plan': '千问百炼(套餐)'
  }
  return configuredProviderIds.value
    .filter((id) => PROVIDERS_WITHOUT_EMBEDDING.includes(id))
    .map((id) => names[id] || id)
})

function setSource(s: 'preset' | 'custom') {
  cfg.value.embeddingSource = s
  if (s === 'custom') {
    // 切到自定义时清空 preset 字段，避免来回切时保存了 stale 的旧预设值
    cfg.value.embeddingProviderId = ''
    cfg.value.embeddingModel = ''
    cfg.value.embeddingAdapter = 'openai'
    embeddingPresetId.value = ''
  }
  embeddingTestResult.value = null
}

/** 上次索引被截断的笔记列表（来自 status） */
const truncatedFiles = computed(() => status.value.truncatedFiles || [])
/** 上次索引 embedding 失败的笔记及错误（来自 status） */
const embedErrorFiles = computed(() => status.value.embedErrors || [])

let offProgress: (() => void) | null = null

async function load() {
  try {
    cfg.value = await window.api.obsidian.getConfig()
    presets.value = await window.api.obsidian.getEmbeddingPresets()
    status.value = await window.api.obsidian.getIndexStatus()
    // 取已配置（填了 API Key）的 provider id，供「无 embedding 接口」提示
    try {
      const appCfg = await window.api.config.get()
      configuredProviderIds.value = (appCfg.providers || [])
        .filter((p: any) => p && p.apiKey && String(p.apiKey).trim())
        .map((p: any) => p.id)
    } catch { /* providers 拿不到不影响主流程 */ }
  } catch (e: any) {
    showToast('加载配置失败：' + e.message, 'error')
    return
  }
  // customEmbedding 兜底（旧配置可能没有）
  if (!cfg.value.customEmbedding) {
    cfg.value.customEmbedding = { baseUrl: '', apiKey: '', model: '', dim: 1024, adapter: 'openai' }
  }
  // proactiveSearch 兜底：后端 getObsidianConfig 已合并默认值，这里防手改配置
  // 写入 null 等异常值导致 checkbox 显示与实际行为（=== false 才算关）不一致
  if (typeof cfg.value.proactiveSearch !== 'boolean') {
    cfg.value.proactiveSearch = true
  }
  // 匹配当前配置对应的预设
  const m = presets.value.find(
    (p) => p.providerId === cfg.value.embeddingProviderId && p.modelId === cfg.value.embeddingModel
  )
  embeddingPresetId.value = m ? m.id : ''
}

function onPresetChange() {
  const p = presets.value.find((x) => x.id === embeddingPresetId.value)
  if (p) {
    cfg.value.embeddingProviderId = p.providerId
    cfg.value.embeddingModel = p.modelId
    cfg.value.embeddingAdapter = p.adapter
    embeddingTestResult.value = null
  }
}

async function selectVault() {
  const res = await window.api.obsidian.selectVault()
  if (!res) return
  cfg.value.vaultPath = res.path
  if (res.warning) showToast(res.warning, 'error')
}

async function save() {
  if (cfg.value.enabled && !cfg.value.vaultPath) {
    showToast('启用前请先选择 Vault 路径', 'error')
    return
  }
  // 自定义模式校验凭据完整，否则 mcp-server 启动后 fetch 必失败
  if (cfg.value.embeddingSource === 'custom' && cfg.value.customEmbedding) {
    const c = cfg.value.customEmbedding
    if (!c.baseUrl || !c.model || !c.apiKey) {
      showToast('自定义 embedding 凭据不完整（baseUrl / model / apiKey 必填）', 'error')
      return
    }
  }
  saving.value = true
  try {
    // 深拷贝脱掉 Vue 响应式 Proxy，否则 IPC 结构化克隆会报 "An object could not be cloned"
    await window.api.obsidian.saveConfig(JSON.parse(JSON.stringify(cfg.value)))
    showToast('配置已保存，重启 OpenClaw 后生效', 'success')
  } catch (e: any) {
    showToast('保存失败：' + e.message, 'error')
  } finally {
    saving.value = false
  }
}

async function rebuild() {
  if (!cfg.value.vaultPath) {
    showToast('请先选择 Vault 路径', 'error')
    return
  }
  // 重建前自动保存配置，避免用户改了路径未保存导致 rebuildIndex 读到旧空值
  try {
    await window.api.obsidian.saveConfig(JSON.parse(JSON.stringify(cfg.value)))
  } catch (e: any) {
    showToast('保存配置失败，无法重建索引：' + e.message, 'error')
    return
  }
  progress.value = { phase: 'scanning', processed: 0, total: 0, message: '启动索引...' }
  try {
    const r = await window.api.obsidian.rebuildIndex()
    if (r.success) {
      showToast('索引完成', 'success')
    } else if (r.error === '索引已取消') {
      // 取消时不重复提示，cancel() 已经 toast 过「已停止索引」
    } else {
      showToast('索引失败：' + (r.error || '未知错误'), 'error')
    }
  } catch (e: any) {
    showToast('索引异常：' + e.message, 'error')
  }
  status.value = await window.api.obsidian.getIndexStatus()
}

async function cancel() {
  try {
    await window.api.obsidian.cancelIndex()
    showToast('已停止索引', 'success')
  } catch (e: any) {
    showToast('停止失败：' + e.message, 'error')
  }
  status.value = await window.api.obsidian.getIndexStatus()
}

async function testEmbedding() {
  testing.value = true
  embeddingTestResult.value = null
  try {
    const arg =
      cfg.value.embeddingSource === 'custom' && cfg.value.customEmbedding
        ? {
            baseUrl: cfg.value.customEmbedding.baseUrl,
            apiKey: cfg.value.customEmbedding.apiKey,
            model: cfg.value.customEmbedding.model,
            adapter: cfg.value.customEmbedding.adapter
          }
        : { providerId: cfg.value.embeddingProviderId, model: cfg.value.embeddingModel }
    if (cfg.value.embeddingSource === 'preset' && (!arg.providerId || !arg.model)) {
      showToast('请先选择 embedding 模型', 'error')
      testing.value = false
      return
    }
    if (cfg.value.embeddingSource === 'custom' && (!arg.baseUrl || !arg.model)) {
      showToast('请填完 baseUrl 和模型', 'error')
      testing.value = false
      return
    }
    const r = await window.api.obsidian.testEmbedding(arg)
    embeddingTestResult.value = { success: true, dim: r.dim }
  } catch (e: any) {
    embeddingTestResult.value = { success: false, error: e.message }
  } finally {
    testing.value = false
  }
}

// ── 检索测试面板 ──
interface SearchHit {
  filePath: string
  headingPath: string | null
  content: string
  tags: string[]
  score: number
}
const searchQuery = ref('')
const searchTag = ref('')
const searchLimit = ref(5)
const searching = ref(false)
const searchResult = ref<{ hits: SearchHit[]; tookMs: number } | null>(null)
const searchError = ref('')

async function runSearch() {
  if (!searchQuery.value.trim()) {
    showToast('请输入检索内容', 'error')
    return
  }
  searching.value = true
  searchError.value = ''
  searchResult.value = null
  try {
    const r = await window.api.obsidian.testSearch({
      query: searchQuery.value,
      limit: searchLimit.value,
      tag: searchTag.value.trim() || undefined
    })
    searchResult.value = r
  } catch (e: any) {
    searchError.value = e.message
  } finally {
    searching.value = false
  }
}

/** cosine 相似度 -> 分数条宽度（0.3 以下太弱不展示满格） */
function hitPct(score: number): number {
  return Math.max(2, Math.min(100, Math.round(((score - 0.3) / 0.7) * 100)))
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

onMounted(() => {
  load()
  offProgress = window.api.obsidian.onIndexProgress((data: any) => {
    progress.value = data
    if (data.phase === 'done' || data.phase === 'error') {
      window.api.obsidian.getIndexStatus().then((s) => (status.value = s))
    }
  })
})
onUnmounted(() => {
  offProgress?.()
})
</script>

<style scoped>
.obsidian-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.stat {
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 14px;
  text-align: center;
}
.stat-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
}
.stat-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.progress-wrap {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress-bar {
  height: 6px;
  background: var(--bg-overlay);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s ease;
}
.steps {
  padding-left: 20px;
  line-height: 1.9;
  color: var(--text-secondary);
}
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  z-index: 999;
}
.toast.success {
  background: rgba(63, 185, 80, 0.9);
  color: #fff;
}
.toast.error {
  background: rgba(248, 81, 73, 0.9);
  color: #fff;
}
.source-tabs {
  display: flex;
  gap: 0;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 3px;
}
.source-tab {
  flex: 1;
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}
.source-tab.active {
  background: var(--accent);
  color: #fff;
}
.source-tab:not(.active):hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}
.custom-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.unavailable-tip {
  padding: 6px 10px;
  background: rgba(210, 153, 34, 0.08);
  border: 1px solid rgba(210, 153, 34, 0.25);
  border-radius: var(--radius-sm);
  color: var(--yellow) !important;
}
.truncated-tip {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(210, 153, 34, 0.08);
  border: 1px solid rgba(210, 153, 34, 0.25);
  border-radius: var(--radius-sm);
}
.truncated-list {
  max-height: 60px;
  overflow-y: auto;
  word-break: break-all;
  line-height: 1.6;
}
/* ── 检索测试 ── */
.search-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.search-bar .form-input {
  flex: 1;
}
.search-meta {
  margin-top: 10px;
}
.hit-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hit {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.hit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hit-score {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-muted, rgba(56, 139, 253, 0.12));
  padding: 1px 8px;
  border-radius: 4px;
}
.hit-path {
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}
.tag-chip {
  font-size: 11px;
  color: var(--text-secondary, var(--text-muted));
  background: var(--bg-overlay, rgba(127, 127, 127, 0.15));
  padding: 1px 6px;
  border-radius: 4px;
}
.hit-score-bar {
  height: 3px;
  background: var(--bg-overlay);
  border-radius: 2px;
  margin: 6px 0;
  overflow: hidden;
}
.hit-score-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
}
.hit-content {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
}
</style>
