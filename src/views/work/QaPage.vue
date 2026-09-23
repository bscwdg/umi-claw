<template>
  <div class="qa-page">
    <header class="qa-header">
      <h1>💬 工作问答</h1>
      <span class="text-muted text-sm">基于你的工作记忆，没有依据会明说，不编造</span>
    </header>

    <!-- 对话区 -->
    <div ref="listRef" class="card conversation">
      <div v-if="!messages.length" class="empty">
        <p>问我关于你工作的事，比如「我今天推进了什么？」</p>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="bubble">
          <span v-if="m.role === 'user'">🧑</span><span v-else>🤖</span>
          <span class="msg-text">{{ m.text || (m.role === 'assistant' && stream.running.value ? '…' : '') }}</span>
        </div>
      </div>

      <div v-if="stream.error.value" class="error-box">
        出错了：{{ stream.error.value.message }}
      </div>
    </div>

    <!-- 输入区 -->
    <div class="card qa-input">
      <input
        v-model="question"
        class="form-input"
        placeholder="问点什么…（回车发送）"
        :disabled="stream.running.value"
        @keydown.enter="ask"
      />
      <button
        v-if="stream.running.value"
        class="btn btn-danger"
        @click="stop"
      >停止</button>
      <button v-else class="btn btn-primary" :disabled="!question.trim()" @click="ask">发送</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onActivated, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useWorkStream } from '@/composables/useWorkStream'
import { useToast } from '@/composables/useToast'

interface Msg {
  role: 'user' | 'assistant'
  text: string
}

const route = useRoute()
const { showToast } = useToast()
const stream = useWorkStream()

const messages = ref<Msg[]>([])
const question = ref('')
const listRef = ref<HTMLElement | null>(null)

async function scrollBottom(): Promise<void> {
  await nextTick()
  if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
}

async function ask(): Promise<void> {
  const q = question.value.trim()
  if (!q || stream.running.value) return

  messages.value.push({ role: 'user', text: q })
  messages.value.push({ role: 'assistant', text: '' })
  question.value = ''
  await scrollBottom()

  // 增量实时写进最后一条 assistant
  const stopWatch = watchDelta((d: string) => {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') {
      last.text = stream.text.value
      void scrollBottom()
    }
  })

  try {
    const res = await window.api.work.qa.ask({ question: q })
    stream.bind(res.runId)
    const done = await stream.done
    const last = messages.value[messages.value.length - 1]
    if (last) last.text = done.text || stream.text.value
    if (done.aborted) showToast('已停止', 'warning')
  } catch (e: any) {
    // 启动失败：移除空 assistant 气泡
    messages.value.pop()
    showToast(`发送失败：${e.message}`, 'error')
  } finally {
    stopWatch()
    stream.reset()
    await scrollBottom()
  }
}

// 简单的 delta 轮询订阅（stream.text 是 ref；用 watch 更地道，这里直接 watch）
import { watch } from 'vue'
function watchDelta(cb: (d: string) => void): () => void {
  return watch(stream.text, (v) => cb(v))
}

async function stop(): Promise<void> {
  try {
    if (stream.runId.value) await window.api.work.qa.abortAsk(stream.runId.value)
  } catch (e: any) {
    showToast(`停止失败：${e.message}`, 'error')
  }
}

onMounted(async () => {
  // 从今日页/路由带过来的预填问题
  const pre = route.query.q
  if (typeof pre === 'string' && pre.trim()) {
    question.value = pre
    await ask()
  }
})
onActivated(() => {})
</script>

<style scoped>
.qa-page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.qa-header { display: flex; flex-direction: column; gap: 4px; }

.conversation {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
  min-height: 240px;
}
.empty { color: var(--text-muted); font-size: 13px; text-align: center; padding: 40px 0; }

.msg.user { display: flex; justify-content: flex-end; }
.msg.assistant { display: flex; justify-content: flex-start; }
.bubble {
  display: inline-flex; gap: 8px; align-items: flex-start;
  max-width: 78%; padding: 10px 14px; border-radius: var(--radius-md);
  font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}
.msg.user .bubble { background: var(--accent-muted); color: var(--text-primary); }
.msg.assistant .bubble { background: var(--bg-base); border: 1px solid var(--border-muted); }
.msg-text { flex: 1; }
.error-box { color: var(--red); font-size: 13px; padding: 8px; border: 1px solid var(--red); border-radius: var(--radius-sm); }

.qa-input { display: flex; gap: 10px; padding: 12px 16px; align-items: center; }
</style>
