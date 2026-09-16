<template>
  <div class="bb">
    <div class="page-header">
      <div>
        <h1>商家大脑</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          {{
            marketing.currentProject
              ? `${marketing.currentProject.name} · 商家基本盘`
              : '商家资料按 Project 隔离，先选一个商家'
          }}
        </p>
      </div>
      <div class="flex gap-2" v-if="marketing.currentProjectId">
        <span v-if="dirty" class="badge badge-yellow">有未保存修改</span>
        <button class="btn" :disabled="saving || !dirty" @click="resetForm()">恢复</button>
        <button class="btn btn-primary" :disabled="saving || !dirty" @click="save()">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!marketing.currentProjectId" class="card empty-card">
      <div style="font-size: 32px">🏪</div>
      <h3>还没有选择商家</h3>
      <p class="text-muted text-sm" style="max-width: 460px; line-height: 1.7">
        每个商家 = 一个独立工作空间。新建一个（或切换一个）之后，这里会记录它的定位、客群与语气 ——
        这些是 AI 写内容、做问答时最先用到的上下文。
      </p>
      <button class="btn btn-primary" @click="switcher.show()">打开商家切关器</button>
    </div>

    <template v-else>
      <!-- 资料完整度（Business 维度） -->
      <div class="card comp-card">
        <div class="comp-head">
          <div>
            <div class="comp-title">资料完整度 · Business</div>
            <div class="text-sm text-muted">
              填得越全，AI 越不需要你重复解释自己的店
              <span class="text-muted">（Knowledge 维度随知识库接入）</span>
            </div>
          </div>
          <div class="comp-score">{{ comp.percent }}<span>%</span></div>
        </div>
        <div class="comp-bar">
          <div class="comp-bar-fill" :style="{ width: comp.percent + '%' }"></div>
        </div>
        <div class="comp-foot">
          <span class="text-sm text-muted">已填 {{ comp.filled }} / {{ comp.total }} 项</span>
          <span v-if="comp.missing.length" class="comp-missing text-sm">
            还缺：{{ comp.missing.map(labelOfField).join('、') }}
          </span>
          <span v-else class="text-sm" style="color: var(--green)">已填齐 ✅</span>
        </div>
      </div>

      <!-- 商家基本盘 -->
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom: 14px">
          <h3>商家基本盘</h3>
          <span class="text-sm text-muted">留空的项不会瞎编，AI 会主动问你</span>
        </div>

        <div class="form-grid">
          <div v-for="f in FIELDS" :key="f.key" class="form-group" :class="{ wide: f.multiline }">
            <label class="form-label">
              {{ f.label }}
              <span v-if="f.hint" class="text-muted">· {{ f.hint }}</span>
            </label>
            <textarea
              v-if="f.multiline"
              class="form-textarea"
              rows="2"
              :value="form[f.key]"
              :placeholder="f.placeholder"
              @input="onInput(f.key, $event)"
            ></textarea>
            <input
              v-else
              class="form-input"
              :value="form[f.key]"
              :placeholder="f.placeholder"
              @input="onInput(f.key, $event)"
            />
            <div v-if="f.presets && f.presets.length" class="chip-row">
              <button
                v-for="p in f.presets"
                :key="p"
                class="chip"
                :class="{ on: form[f.key] === p }"
                @click="fillField(f.key, p)"
              >
                {{ p }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="formError" class="err">{{ formError }}</div>
        <div v-if="marketing.businessLoading" class="text-sm text-muted" style="margin-top: 10px">
          正在读取商家资料…
        </div>
      </div>

      <!-- Watchlist -->
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom: 12px">
          <div>
            <h3>关注词 · Watchlist</h3>
            <p class="text-sm text-muted" style="margin: 4px 0 0">
              只作为「我关心什么」喂给 AI 当上下文 —— <strong>不会触发任何采集</strong>
            </p>
          </div>
          <span class="badge" :class="{ 'badge-red': atLimit }">
            {{ marketing.watchlist.length }} / {{ WATCHLIST_MAX }}
          </span>
        </div>

        <div class="wl-add">
          <input
            class="form-input"
            :value="newKeyword"
            :disabled="atLimit"
            placeholder="加一个关注词（如 婚纱摄影）"
            @input="newKeyword = ($event.target as HTMLInputElement).value"
            @keyup.enter="add()"
          />
          <select
            class="form-select"
            :value="newType"
            :disabled="atLimit"
            @change="newType = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="t in WATCHLIST_PRESET_TYPES" :key="t" :value="t">
              {{ WATCHLIST_TYPE_LABELS[t] || t }}
            </option>
          </select>
          <button class="btn btn-primary" :disabled="atLimit || !newKeyword.trim()" @click="add()">
            添加
          </button>
        </div>

        <div v-if="atLimit" class="hint-warn">
          已达上限 {{ WATCHLIST_MAX }} 个词，先删掉不用的再加。
        </div>

        <div class="wl-presets">
          <span class="text-sm text-muted">行业预设词：</span>
          <button
            v-for="p in WATCHLIST_INDUSTRY_PRESETS"
            :key="p"
            class="chip"
            :disabled="atLimit || hasWord(p)"
            @click="addPreset(p)"
          >
            {{ p }}
          </button>
          <button class="btn btn-sm" :disabled="atLimit" @click="addAllPresets()">一键补齐</button>
        </div>

        <div class="wl-list">
          <div v-if="marketing.watchlistLoading && !marketing.watchlist.length" class="text-sm text-muted">
            加载中…
          </div>
          <div v-else-if="!marketing.watchlist.length" class="text-sm text-muted">
            还没有关注词。加几个行业词，AI 就能顺着你的关注点说话。
          </div>
          <div
            v-for="w in marketing.watchlist"
            :key="w.keyword"
            class="wl-item"
            :class="{ off: !w.enabled }"
          >
            <label class="wl-toggle" :title="w.enabled ? '已启用' : '已停用'">
              <input type="checkbox" :checked="!!w.enabled" @change="toggle(w)" />
            </label>
            <span class="wl-word">{{ w.keyword }}</span>
            <span v-if="w.type" class="badge">{{ WATCHLIST_TYPE_LABELS[w.type] || w.type }}</span>
            <button class="btn btn-sm" @click="removeWord(w.keyword)">删除</button>
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
import {
  useMarketingStore,
  WATCHLIST_MAX,
  WATCHLIST_PRESET_TYPES
} from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import { useToast } from '@/composables/useToast'
import {
  BUSINESS_FIELD_LABELS,
  BUSINESS_POSITIONING_PRESETS,
  BUSINESS_TARGET_CUSTOMER_PRESETS,
  BUSINESS_TONE_PRESETS,
  WATCHLIST_INDUSTRY_PRESETS,
  WATCHLIST_TYPE_LABELS
} from '@/constants/photographyPresets'

const marketing = useMarketingStore()
const switcher = useProjectSwitcher()
const { toast, showToast } = useToast()

/** 表单字段（与 businesses 表白名单一致） */
const FIELDS = [
  {
    key: 'name',
    label: '商家名称',
    hint: '对外叫的名字',
    placeholder: '如 XX 摄影工作室',
    presets: [] as string[]
  },
  { key: 'brand', label: '品牌名', hint: '有品牌就填', placeholder: '如 XX STUDIO', presets: [] as string[] },
  { key: 'city', label: '城市', placeholder: '如 成都', presets: [] as string[] },
  { key: 'address', label: '门店地址', placeholder: '如 XX 区 XX 路 88 号', presets: [] as string[] },
  { key: 'phone', label: '联系电话', placeholder: '如 028-88888888', presets: [] as string[] },
  {
    key: 'positioning',
    label: '业务定位',
    hint: '你主要靠什么挣钱',
    placeholder: '如 婚纱摄影 + 个人写真',
    presets: BUSINESS_POSITIONING_PRESETS,
    multiline: true
  },
  {
    key: 'target_customer',
    label: '目标客群',
    hint: '你想服务谁',
    placeholder: '如 25-35 岁备婚女性',
    presets: BUSINESS_TARGET_CUSTOMER_PRESETS,
    multiline: true
  },
  {
    key: 'tone',
    label: '沟通语气',
    hint: 'AI 写文案的口吻',
    placeholder: '如 温暖亲切、不油腻',
    presets: BUSINESS_TONE_PRESETS,
    multiline: true
  }
] as Array<{ key: string; label: string; hint?: string; placeholder?: string; presets: string[]; multiline?: boolean }>

type FormState = Record<string, string>
const emptyForm = (): FormState => ({
  name: '',
  brand: '',
  city: '',
  address: '',
  phone: '',
  positioning: '',
  target_customer: '',
  tone: ''
})

const form = ref<FormState>(emptyForm())
const saved = ref<FormState>(emptyForm())
const saving = ref(false)
const formError = ref('')
const newKeyword = ref('')
const newType = ref<string>(WATCHLIST_PRESET_TYPES[0] || 'industry')

const comp = computed(() => marketing.completeness)
const atLimit = computed(() => marketing.watchlist.length >= WATCHLIST_MAX)
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(saved.value))

function labelOfField(key: string) {
  return BUSINESS_FIELD_LABELS[key] || key
}

function syncFromStore() {
  const b = marketing.business
  const next: FormState = emptyForm()
  if (b) {
    for (const k of Object.keys(next)) {
      next[k] = ((b as unknown as Record<string, string | null>)[k] ?? '') as string
    }
  }
  form.value = next
  saved.value = { ...next }
  formError.value = ''
}

function onInput(key: string, e: Event) {
  const target = e.target as HTMLInputElement | HTMLTextAreaElement
  form.value[key] = target.value
}

function fillField(key: string, value: string) {
  form.value[key] = form.value[key] === value ? '' : value
}

function resetForm() {
  form.value = { ...saved.value }
  formError.value = ''
}

async function refresh(projectId: string | null) {
  if (!projectId) return
  await Promise.all([marketing.loadBusiness(projectId), marketing.loadWatchlist(projectId)])
  syncFromStore()
}

async function save() {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  saving.value = true
  formError.value = ''
  try {
    await marketing.saveBusiness(projectId, { ...form.value })
    syncFromStore()
    showToast('商家资料已保存', 'success')
  } catch (e) {
    formError.value = (e as Error)?.message || marketing.error || '保存失败'
  } finally {
    saving.value = false
  }
}

function hasWord(keyword: string) {
  return marketing.watchlist.some((w) => w.keyword === keyword)
}

async function add() {
  const projectId = marketing.currentProjectId
  const keyword = newKeyword.value.trim()
  if (!projectId || !keyword) return
  try {
    await marketing.addWatch(projectId, keyword, newType.value)
    newKeyword.value = ''
  } catch (e) {
    showToast((e as Error)?.message || marketing.error || '添加失败', 'error')
  }
}

async function addPreset(keyword: string) {
  const projectId = marketing.currentProjectId
  if (!projectId || hasWord(keyword)) return
  try {
    await marketing.addWatch(projectId, keyword, 'industry')
  } catch (e) {
    showToast((e as Error)?.message || marketing.error || '添加失败', 'error')
  }
}

async function addAllPresets() {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  for (const p of WATCHLIST_INDUSTRY_PRESETS) {
    if (atLimit.value) break
    if (hasWord(p)) continue
    try {
      await marketing.addWatch(projectId, p, 'industry')
    } catch {
      break
    }
  }
}

async function removeWord(keyword: string) {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  try {
    await marketing.removeWatch(projectId, keyword)
  } catch (e) {
    showToast((e as Error)?.message || marketing.error || '删除失败', 'error')
  }
}

async function toggle(w: { keyword: string; enabled: number }) {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  try {
    await marketing.setWatchEnabled(projectId, w.keyword, !w.enabled)
  } catch (e) {
    showToast((e as Error)?.message || marketing.error || '操作失败', 'error')
  }
}

onMounted(async () => {
  if (!marketing.projects.length) await marketing.load()
  await refresh(marketing.currentProjectId)
})

// 切换商家 → 重新拉这一家的资料（store 里 current 变了就跟着换）
watch(
  () => marketing.currentProjectId,
  (id) => {
    refresh(id)
  }
)
</script>

<style scoped>
.bb {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
}

/* 完整度 */
.comp-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.comp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.comp-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.comp-score {
  font-size: 26px;
  font-weight: 700;
  color: var(--accent);
  line-height: 1;
}
.comp-score span {
  font-size: 13px;
  margin-left: 2px;
}
.comp-bar {
  height: 8px;
  border-radius: 999px;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  overflow: hidden;
}
.comp-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transition: width 0.3s ease;
}
.comp-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.comp-missing {
  color: var(--yellow);
}

/* 表单 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.form-group.wide {
  grid-column: 1 / -1;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.chip {
  padding: 3px 9px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.12s;
}
.chip:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.chip.on {
  background: var(--accent-muted);
  border-color: var(--accent);
  color: var(--accent);
}
.chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Watchlist */
.wl-add {
  display: grid;
  grid-template-columns: 1fr 130px auto;
  gap: 8px;
}
.hint-warn {
  margin-top: 8px;
  font-size: 12px;
  color: var(--yellow);
}
.wl-presets {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0;
  padding: 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
}
.wl-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
}
.wl-item.off {
  opacity: 0.5;
}
.wl-toggle input {
  cursor: pointer;
}
.wl-word {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
}
.err {
  margin-top: 10px;
  font-size: 13px;
  color: var(--red);
}

/* Toast（与工作台一致） */
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
</style>
