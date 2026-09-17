<template>
  <div class="adv">
    <div class="page-header">
      <div>
        <h1>AI Advisor</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          {{
            marketing.currentProject
              ? `${marketing.currentProject.name} · 只依据这个商家的资料回答（资料里没有的，AI 会明说）`
              : 'AI Advisor 按商家隔离，先选一个商家'
          }}
        </p>
      </div>
      <div class="flex gap-2" v-if="marketing.currentProjectId">
        <select v-model="marketing.advisorPlatform" class="input" style="width: auto">
          <option :value="null">不指定发布平台</option>
          <option v-for="p in ADVISOR_PLATFORMS" :key="p.key" :value="p.key">{{ p.label }}</option>
        </select>
        <button class="btn" :disabled="marketing.advisorStreaming" @click="onClear">清空对话</button>
      </div>
    </div>

    <!-- 空态：没有当前商家 -->
    <div v-if="!marketing.currentProjectId" class="card empty-card">
      <div style="font-size: 32px">💬</div>
      <h3>还没有选择商家</h3>
      <p class="text-muted text-sm" style="max-width: 460px; line-height: 1.7">
        Advisor 会先把「这个商家是谁、手里有什么资料」组装成上下文，再回答问题。
      </p>
      <button class="btn btn-primary" @click="switcher.show()">打开商家切换器</button>
    </div>

    <template v-else>
      <!-- 「AI 看见了什么」摘要：不暴露资料正文，只给数量/模式/预算，避免把内部结构搬到界面上 -->
      <div class="card pack-strip" v-if="pack">
        <span class="text-sm">AI 看见了：</span>
        <span class="text-sm text-muted">
          资料 {{ pack.knowledgeIncluded }}/{{ pack.knowledgeTotal }} 条
        </span>
        <span class="text-sm" :class="pack.mode === 'truncated' ? 'text-warn' : 'text-muted'">
          {{
            pack.mode === 'full'
              ? '全部注入'
              : `超预算已裁剪（${pack.knowledgeDropped} 条未注入）`
          }}
        </span>
        <span class="text-sm text-muted">
          资料完整度 {{ pack.businessCompleteness.percent }}%
          <template v-if="pack.businessCompleteness.missing.length">
            （缺 {{ pack.businessCompleteness.missing.length }} 项）
          </template>
        </span>
        <span class="text-sm text-muted">{{ pack.usedTokens }}/{{ pack.budgetTokens }} tokens</span>
        <span class="text-sm text-muted" v-if="pack.watchlistCount">关注词 {{ pack.watchlistCount }} 个</span>
      </div>

      <!-- 缺口：把锅甩回可行动的事（§一 产品智能原则） -->
      <div class="card gap-hint" v-if="missingFields.length">
        <span class="text-sm">补上这些，AI 会更懂你：</span>
        <span class="text-sm text-muted">{{ missingFields.join('、') }}</span>
        <button class="btn" @click="router.push('/marketing/business')">去补商家资料</button>
      </div>

      <!-- 对话 -->
      <div class="card chat">
        <div v-if="!messages.length" class="text-muted text-sm" style="line-height: 1.9">
          试着问：「客户嫌贵怎么回？」「给我三个适合小红书的选题角度」「我的套系怎么讲卖点？」
        </div>
        <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
          <div class="msg-role">{{ m.role === 'user' ? '你' : 'AI' }}</div>
          <div class="msg-body">
            <pre class="msg-text">{{ m.content }}<span v-if="m.streaming" class="cursor">▍</span></pre>
            <div v-if="m.errorCode" class="msg-error">
              <span>⚠ {{ errorText(m.errorCode) }}</span>
              <button
                v-if="m.errorCode === 'OPENCLAW_NOT_READY' || m.errorCode === 'SETUP_REQUIRED'"
                class="btn"
                :disabled="startingGateway"
                @click="onStartGateway"
              >
                {{ startingGateway ? '启动中…' : '去启动 OpenClaw' }}
              </button>
            </div>
            <div v-else-if="m.aborted" class="text-sm text-muted">已停止生成（上游已断开，不再继续耗 token）</div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="card">
        <textarea
          v-model="draft"
          class="input"
          rows="3"
          style="width: 100%; resize: vertical"
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          :disabled="marketing.advisorStreaming"
          @keydown.enter.exact.prevent="onSend"
        ></textarea>
        <div class="flex items-center justify-between" style="margin-top: 8px">
          <span class="text-sm text-muted">回答只依据你的商家资料；资料里没有的，AI 会明说并建议补充。</span>
          <div class="flex gap-2">
            <button v-if="marketing.advisorStreaming" class="btn" @click="onStop">停止生成</button>
            <button
              class="btn btn-primary"
              :disabled="marketing.advisorStreaming || !draft.trim()"
              @click="onSend"
            >
              发送
            </button>
          </div>
        </div>
        <div v-if="marketing.advisorError" class="text-sm text-warn" style="margin-top: 8px">
          ⚠ {{ marketing.advisorError }}
        </div>
      </div>

      <!-- Watchlist AI 扩词候选（不自动写库：勾选后经 addWatch 写入） -->
      <div class="card">
        <div class="flex items-center justify-between">
          <div>
            <h3>AI 扩词建议</h3>
            <span class="text-sm text-muted">
              选中后加入关注词（上限 {{ WATCHLIST_MAX }} 个）；关注词只喂给 AI 上下文，不触发任何采集
            </span>
          </div>
          <div class="flex gap-2">
            <button class="btn" :disabled="marketing.advisorCandidatesLoading" @click="onSuggest">
              {{ marketing.advisorCandidatesLoading ? '生成中…' : '生成候选词' }}
            </button>
            <button
              v-if="candidates.length"
              class="btn btn-primary"
              :disabled="!selected.length"
              @click="onAddSelected"
            >
              加入关注词（{{ selected.length }}）
            </button>
          </div>
        </div>
        <div v-if="candidates.length" class="cand-list">
          <label v-for="c in candidates" :key="c.keyword" class="cand" :class="{ off: c.existing }">
            <input type="checkbox" :value="c.keyword" v-model="selected" :disabled="c.existing" />
            <span>{{ c.keyword }}</span>
            <span class="text-sm text-muted">
              {{ typeLabel(c.type) }}<template v-if="c.reason"> · {{ c.reason }}</template
              ><template v-if="c.existing"> · 已在列表里</template>
            </span>
          </label>
        </div>
        <div v-else class="text-sm text-muted" style="margin-top: 8px">
          还没生成候选词。点「生成候选词」让 AI 按你的资料想几个值得关注的方向。
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// AI Advisor 面板（Commit 08）：grounded 问答 + 流式 + 停止生成 + 扩词候选。
//
// 与主进程的分工：本组件**只做展示与交互**；上下文组装、事实护栏、模型调用全在主进程
// （advisorManager）。错误一律按 `error.code` 分支（§五），不解析 message。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ADVISOR_PLATFORMS, ERROR_TEXT, WATCHLIST_MAX, WATCHLIST_PRESET_TYPES, useMarketingStore } from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import { useToast } from '@/composables/useToast'

const marketing = useMarketingStore()
const switcher = useProjectSwitcher()
const router = useRouter()
const { showToast } = useToast()

const draft = ref('')
const selected = ref<string[]>([])
const startingGateway = ref(false)

const messages = computed(() => marketing.advisorMessages)
const candidates = computed(() => marketing.advisorCandidates)
const pack = computed(() => marketing.advisorPack)

/** 缺口字段名 → 人话（面板只展示，不决定口径） */
const FIELD_LABELS: Record<string, string> = {
  name: '商家名称',
  brand: '品牌',
  city: '城市',
  positioning: '定位',
  target_customer: '目标客群',
  tone: '语气'
}
const missingFields = computed(() =>
  (pack.value?.businessCompleteness.missing ?? []).map((f) => FIELD_LABELS[f] ?? f)
)

function errorText(code: string): string {
  return ERROR_TEXT[code] ?? '出错了，请重试'
}

function typeLabel(type: string | null): string {
  const map: Record<string, string> = { industry: '行业', product: '产品', audience: '受众', region: '地域' }
  return type ? map[type] ?? '未分类' : '未分类'
}

/** 切换商家：先中止在途流（否则旧商家的回答会继续生成＝白烧 token，还会串进新商家面板） */
watch(
  () => marketing.currentProjectId,
  async () => {
    if (marketing.advisorStreaming) await marketing.stopAdvisor()
    marketing.clearAdvisor()
    marketing.clearWatchCandidates()
    selected.value = []
  }
)

onMounted(() => {
  if (marketing.currentProjectId) void marketing.loadWatchlist(marketing.currentProjectId)
})

// 卸载（例如切到别的页面）＝必须中止上游：组件都走了，没人再消费增量
onBeforeUnmount(() => {
  void marketing.stopAdvisor()
  marketing.disposeAdvisor()
})

async function onSend(): Promise<void> {
  const projectId = marketing.currentProjectId
  const question = draft.value.trim()
  if (!projectId || !question) return
  draft.value = ''
  try {
    await marketing.askAdvisor(projectId, question, marketing.advisorPlatform)
  } catch (e) {
    showToast((e as Error)?.message || '提问失败', 'error')
  }
}

async function onStop(): Promise<void> {
  await marketing.stopAdvisor()
}

function onClear(): void {
  marketing.clearAdvisor()
}

/** 未就绪时的「去启动 OpenClaw」：只调 07 的只读就绪面（探活→按需拉起→就绪轮询） */
async function onStartGateway(): Promise<void> {
  startingGateway.value = true
  try {
    const res = (await window.api.marketing.gateway.ensureReady()) as
      | { ok: true; data: { ready: boolean; port: number } }
      | { ok: false; error: { code: string; message: string } }
    if (res?.ok && res.data?.ready) {
      showToast(`OpenClaw 已就绪（端口 ${res.data.port}），再试一次吧`, 'success')
    } else {
      const code = res && res.ok === false ? res.error.code : 'OPENCLAW_TIMEOUT'
      showToast(ERROR_TEXT[code] ?? 'OpenClaw 还没起来，稍后再试', 'error')
    }
  } catch (e) {
    showToast((e as Error)?.message || '启动 OpenClaw 失败', 'error')
  } finally {
    startingGateway.value = false
  }
}

async function onSuggest(): Promise<void> {
  const projectId = marketing.currentProjectId
  if (!projectId) return
  selected.value = []
  try {
    await marketing.loadWatchCandidates(projectId)
    if (!marketing.advisorCandidates.length) showToast('这次没给出可用候选，稍后再试', 'warning')
  } catch (e) {
    showToast((e as Error)?.message || '生成候选词失败', 'error')
  }
}

/** 勾选的候选词经 04 的 addWatch 写入（上限/去重/CONFLICT 语义全部复用，不在面板里另造规则） */
async function onAddSelected(): Promise<void> {
  const projectId = marketing.currentProjectId
  if (!projectId || !selected.value.length) return
  let ok = 0
  let skipped = 0
  for (const keyword of selected.value) {
    const candidate = marketing.advisorCandidates.find((c) => c.keyword === keyword)
    const type = candidate?.type && WATCHLIST_PRESET_TYPES.includes(candidate.type) ? candidate.type : null
    try {
      await marketing.addWatch(projectId, keyword, type)
      ok += 1
    } catch {
      skipped += 1
    }
  }
  selected.value = []
  await marketing.loadWatchlist(projectId)
  if (ok && !skipped) showToast(`已加入 ${ok} 个关注词`, 'success')
  else if (ok) showToast(`加入 ${ok} 个，${skipped} 个未加入（可能已达上限或已存在）`, 'warning')
  else showToast('没能加入关注词（可能已达 10 个上限）', 'error')
}
</script>

<style scoped>
.adv :deep(.page-header),
.adv .page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.pack-strip,
.gap-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.chat {
  max-height: 52vh;
  overflow-y: auto;
}
.msg {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--border, rgba(127, 127, 127, 0.2));
}
.msg:last-child {
  border-bottom: none;
}
.msg-role {
  flex: 0 0 32px;
  font-size: 12px;
  color: var(--muted, #888);
  padding-top: 2px;
}
.msg-body {
  flex: 1;
  min-width: 0;
}
.msg-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.75;
}
.msg.assistant .msg-text {
  color: var(--text-strong, inherit);
}
.cursor {
  animation: adv-blink 1s step-end infinite;
}
@keyframes adv-blink {
  50% {
    opacity: 0;
  }
}
.msg-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  color: var(--warn, #d97706);
  font-size: 13px;
}
.text-warn {
  color: var(--warn, #d97706);
}
.cand-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.cand {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.cand.off {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
