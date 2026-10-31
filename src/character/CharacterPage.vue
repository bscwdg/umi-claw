<template>
  <div class="character-page">
    <header class="page-head">
      <div>
        <h2>大肥鱼</h2>
        <p class="sub">住在 Umi Claw 里的鱼。默认关闭；启用后她会带着自己的生活和记忆陪你。</p>
      </div>
      <button class="btn" :class="status.enabled ? 'ghost' : 'primary'" :disabled="busy" @click="toggleEnabled">
        {{ status.enabled ? '停用她' : '启用她' }}
      </button>
    </header>

    <p v-if="error" class="err">{{ error }}</p>

    <section class="card">
      <h3>当前状态</h3>
      <div class="grid">
        <div><span class="k">功能</span><span class="v">{{ status.enabled ? '已启用' : '未启用' }}</span></div>
        <div><span class="k">模块</span><span class="v">{{ status.storeReady ? '已就绪' : '未就绪' }}</span></div>
        <div><span class="k">阶段</span><span class="v">{{ stageLabel }}</span></div>
        <div><span class="k">熟悉度</span><span class="v">{{ state.familiarity }} / 100</span></div>
        <div><span class="k">亲密度</span><span class="v">{{ state.intimacy }} / 100</span></div>
        <div><span class="k">心情</span><span class="v">{{ state.mood || '平静' }}</span></div>
      </div>
      <div class="row" style="margin-top: 10px">
        <button class="btn" :disabled="busy || !status.enabled" @click="togglePetVisible">
          {{ petVisible ? '收起桌宠' : '显示桌宠' }}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>首启三问</h3>
      <div class="row">
        <label class="lab">怎么称呼你</label>
        <input v-model="addressDraft" maxlength="40" placeholder="默认「你」" />
      </div>
      <div class="row">
        <label class="lab">关系模式</label>
        <select v-model="modeDraft">
          <option value="companion">朋友（搭子）</option>
          <option value="sister">妹妹</option>
          <option value="lover">恋人未满</option>
        </select>
      </div>
      <div class="row">
        <label class="lab">不能叫的称呼</label>
        <input v-model="tabooDraft" placeholder="逗号分隔；留空 = 不限制任何称呼" />
      </div>
      <p class="hint">称呼只来自你；答「没有」或留空 = 空列表 = 什么都能叫（建议项不默认生效）。</p>
      <div class="row">
        <button class="btn primary" :disabled="busy || !status.enabled" @click="saveOnboarding">保存引导设置</button>
        <button class="btn" :disabled="busy || !status.enabled" @click="runBootstrap">一键初始化</button>
      </div>
      <ul v-if="bootstrapReport" class="steps">
        <li v-for="step in bootstrapReport.steps" :key="step.id" :class="{ bad: !step.ok }">
          <span class="dot">{{ step.ok ? '✓' : '×' }}</span>
          <span class="name">{{ step.name }}</span>
          <span class="detail">{{ step.detail }}</span>
        </li>
      </ul>
    </section>

    <section class="card">
      <h3>连接自检</h3>
      <div class="grid">
        <div><span class="k">agent</span><span class="v">{{ flag(status.agentReady) }}</span></div>
        <div><span class="k">网关</span><span class="v">{{ flag(status.gatewayReady) }}</span></div>
        <div><span class="k">Obsidian</span><span class="v">{{ flag(status.obsidianReady) }}</span></div>
        <div><span class="k">QQ</span><span class="v">{{ flag(status.qqReady) }}</span></div>
        <div><span class="k">TTS</span><span class="v">{{ flag(status.ttsReady) }}</span></div>
        <div><span class="k">记忆检索</span><span class="v">{{ flag(status.memorySearchReady) }}</span></div>
      </div>
      <p class="hint">记忆/世界书/日记只走既有 Obsidian 知识库，不新增知识库。</p>
    </section>

    <section class="card">
      <h3>聊两句</h3>
      <div class="chat-log">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <span class="who">{{ m.role === 'user' ? '你' : '她' }}</span>
          <span class="text">{{ m.text }}<span v-if="m.streaming" class="cursor">▍</span></span>
        </div>
        <p v-if="!messages.length" class="hint">还没聊过。说句话试试。</p>
      </div>
      <div class="row">
        <input
          v-model="draft"
          :disabled="streaming"
          placeholder="跟她说点什么（Enter 发送）"
          @keydown.enter="sendMessage"
        />
        <button class="btn primary" :disabled="!draft.trim() || streaming || !status.enabled" @click="sendMessage">
          发送
        </button>
        <button class="btn" :disabled="!streaming" @click="stopStreaming">停止</button>
        <button class="btn ghost" @click="clearChat">清空</button>
      </div>
      <p class="hint">清空只轮换会话上下文；日记与关系记忆不受影响。</p>
    </section>

    <section class="card">
      <h3>互动</h3>
      <div class="row">
        <button class="btn" :disabled="busy || !status.enabled" @click="interact('pat')">摸摸头</button>
        <button class="btn" :disabled="busy || !status.enabled" @click="interact('feed')">投喂</button>
      </div>
      <p class="hint">C05 才接关系规则与每日上限；现在只验证状态读写。</p>
    </section>

    <section class="card">
      <h3>数据</h3>
      <div class="row">
        <button class="btn ghost" :disabled="busy" @click="resetValues">重置数值</button>
      </div>
      <p class="hint">只清角色数值；记忆与日记在 C07/C09 提供更细的删除与导出。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BootstrapReport } from '../../electron/main/character/bootstrap'
import type { CharacterChatStreamEvent } from '../../electron/main/character/chat'

interface ChatBubble {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

const status = ref({
  enabled: false,
  ready: false,
  storeReady: false,
  agentReady: false,
  gatewayReady: false,
  obsidianReady: false,
  qqReady: false,
  ttsReady: false,
  sttReady: false,
  memorySearchReady: false,
  chatGen: 0
})
const state = ref({
  stage: 0,
  familiarity: 0,
  intimacy: 0,
  mood: '',
  addressForm: '你'
})
const addressDraft = ref('')
const modeDraft = ref<'companion' | 'sister' | 'lover'>('companion')
const tabooDraft = ref('')
const bootstrapReport = ref<BootstrapReport | null>(null)
const petVisible = ref(false)
const messages = ref<ChatBubble[]>([])
const draft = ref('')
const runId = ref('')
const activeGen = ref(0)
const streaming = computed(() => Boolean(runId.value))
let cancelPending = false
const busy = ref(false)
const error = ref('')

const STAGE_LABELS = ['初识', '眼熟', '熟客', '自己人', '搭子以上']
const stageLabel = computed(() => STAGE_LABELS[state.value.stage] ?? '初识')
const flag = (v: boolean): string => (v ? '✓ 就绪' : '× 未就绪')

let offEvent: (() => void) | null = null
let offStream: (() => void) | null = null

onMounted(async () => {
  offEvent = window.api.character.onEvent(() => {
    void refresh()
  })
  offStream = window.api.character.chat.onStream(onStreamEvent)
  await refresh()
})

onBeforeUnmount(() => {
  offEvent?.()
  offEvent = null
  offStream?.()
  offStream = null
})

async function refresh(): Promise<void> {
  try {
    status.value = await window.api.character.status()
    activeGen.value = status.value.chatGen ?? 0
    state.value = await window.api.character.state()
    const settings = await window.api.character.settings.get()
    addressDraft.value = settings.relationship?.address || '你'
    modeDraft.value = settings.relationship?.mode || 'companion'
    tabooDraft.value = (settings.relationship?.taboo ?? []).join('，')
    petVisible.value = Boolean(settings.pet?.visible)
    bootstrapReport.value = await window.api.character.bootstrap.status()
  } catch (e) {
    error.value = (e as Error)?.message || '读取角色状态失败'
  }
}

async function toggleEnabled(): Promise<void> {
  await run(async () => {
    const next = !status.value.enabled
    await window.api.character.settings.set({ enabled: next } as never)
    await refresh()
  })
}

async function togglePetVisible(): Promise<void> {
  await run(async () => {
    const next = !petVisible.value
    await window.api.character.settings.set({ pet: { visible: next } } as never)
    petVisible.value = next
    await refresh()
  })
}

async function saveOnboarding(): Promise<void> {
  await run(async () => {
    const address = addressDraft.value.trim() || '你'
    const taboo = tabooDraft.value
      .split(/[，,]/)
      .map((x) => x.trim())
      .filter(Boolean)
    await window.api.character.settings.set({
      relationship: { address, mode: modeDraft.value, taboo }
    } as never)
    await refresh()
  })
}

async function runBootstrap(): Promise<void> {
  await run(async () => {
    bootstrapReport.value = await window.api.character.bootstrap.run()
    await refresh()
  })
}

function onStreamEvent(event: CharacterChatStreamEvent): void {
  // 旧代际的迟到事件（清空/重置后）一律丢弃
  if (event.gen !== activeGen.value) return
  const current = runId.value
  // 清空/结束后旧 run 的迟到事件必须丢弃
  if (!current) return
  if (current !== 'pending' && event.runId !== current) return
  const last = messages.value[messages.value.length - 1]
  if (event.kind === 'chunk') {
    if (last && last.role === 'assistant') last.text += event.text ?? ''
    return
  }
  if (event.kind === 'done') {
    if (last && last.role === 'assistant') {
      last.streaming = false
      if (!last.text) last.text = '……'
    }
    runId.value = ''
    return
  }
  if (last && last.role === 'assistant') last.streaming = false
  error.value = event.error || '聊天出错了'
  runId.value = ''
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim()
  if (!text || streaming.value) return
  busy.value = true
  error.value = ''
  draft.value = ''
  messages.value.push({ role: 'user', text })
  messages.value.push({ role: 'assistant', text: '', streaming: true })
  // 先占位，避免首帧 delta 比 send 的返回值更快到达时被丢弃
  runId.value = 'pending'
  try {
    const result = await window.api.character.chat.send({ text })
    activeGen.value = result.gen
    runId.value = result.runId
    if (cancelPending) {
      cancelPending = false
      await window.api.character.chat.cancel(result.runId).catch(() => undefined)
      markLastDone()
    }
  } catch (e) {
    cancelPending = false
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && !last.text) messages.value.pop()
    error.value = (e as Error)?.message || '发送失败'
    runId.value = ''
  } finally {
    busy.value = false
  }
}

async function stopStreaming(): Promise<void> {
  const current = runId.value
  if (!current) return
  if (current === 'pending') {
    cancelPending = true
    markLastDone()
    return
  }
  try {
    await window.api.character.chat.cancel(current)
  } catch {
    /* 忽略：可能已自然结束 */
  }
  markLastDone()
}

function markLastDone(): void {
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') last.streaming = false
  runId.value = ''
}

async function clearChat(): Promise<void> {
  await run(async () => {
    const result = await window.api.character.chat.clear()
    activeGen.value = result.gen
    messages.value = []
    runId.value = ''
  })
}

async function interact(kind: 'pat' | 'feed'): Promise<void> {  await run(async () => {
    state.value = await window.api.character.interact({ kind })
  })
}

async function resetValues(): Promise<void> {
  await run(async () => {
    await window.api.character.reset({ scope: 'values' })
    await refresh()
  })
}

async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error)?.message || '操作失败'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.character-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 24px 40px;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
h2 {
  margin: 0 0 6px;
  font-size: 20px;
  color: var(--text-primary, #e8ecf4);
}
.sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary, #9aa4b8);
}
.card {
  border: 1px solid var(--border-color, #2a3244);
  border-radius: 10px;
  background: var(--bg-secondary, #141a26);
  padding: 16px 18px;
  margin-bottom: 14px;
}
.card h3 {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--text-primary, #e8ecf4);
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 16px;
}
.grid > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.k {
  color: var(--text-secondary, #9aa4b8);
}
.v {
  color: var(--text-primary, #e8ecf4);
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.lab {
  width: 120px;
  flex: 0 0 120px;
  font-size: 13px;
  color: var(--text-secondary, #9aa4b8);
}
input,
select {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #2a3244);
  background: var(--bg-primary, #0d121c);
  color: var(--text-primary, #e8ecf4);
}
.btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #2a3244);
  background: var(--bg-primary, #0d121c);
  color: var(--text-primary, #e8ecf4);
  cursor: pointer;
}
.btn.primary {
  border-color: var(--accent, #4c8dff);
  background: var(--accent, #4c8dff);
  color: #fff;
}
.btn.ghost {
  background: transparent;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-secondary, #9aa4b8);
}
.err {
  margin: 0 0 12px;
  color: #ff6b6b;
  font-size: 13px;
}
.steps {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.steps li {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-primary, #e8ecf4);
}
.steps li.bad .dot,
.steps li.bad .detail {
  color: #ff6b6b;
}
.steps .dot {
  width: 14px;
  color: #4cd07d;
}
.steps .name {
  flex: 0 0 240px;
  color: var(--text-secondary, #9aa4b8);
}
.steps .detail {
  flex: 1;
  word-break: break-all;
}
.chat-log {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.msg {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
}
.msg .who {
  flex: 0 0 34px;
  color: var(--text-secondary, #9aa4b8);
}
.msg.user .text {
  color: #cfe0ff;
}
.msg.assistant .text {
  color: var(--text-primary, #e8ecf4);
  white-space: pre-wrap;
  word-break: break-word;
}
.cursor {
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
