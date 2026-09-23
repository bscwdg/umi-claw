<template>
  <div class="tools-page">
    <header class="tools-header">
      <h1>🧰 AI 工具箱</h1>
      <span class="text-muted text-sm">只处理你已有的文本；加工型不落记录，产出型进候选</span>
    </header>

    <div class="tools-layout">
      <!-- 左：工具列表 -->
      <section class="card tool-col">
        <ul class="tool-list">
          <li
            v-for="t in tools"
            :key="t.id"
            class="tool-row"
            :class="{ active: selectedId === t.id }"
            @click="selectTool(t.id)"
          >
            <div class="tool-main">
              <span class="tool-label">{{ t.label }}</span>
              <span class="badge" :class="t.kind === 'productive' ? 'badge-blue' : ''">
                {{ t.kind === 'productive' ? '产出型' : '加工型' }}
              </span>
            </div>
            <span class="tool-desc">{{ t.description }}</span>
          </li>
        </ul>
      </section>

      <!-- 右：操作区 -->
      <section class="card work-col">
        <div class="work-head">
          <h2>{{ current?.label }}</h2>
          <span class="text-muted text-sm">{{ current?.description }}</span>
        </div>

        <!-- 输入素材 -->
        <div class="source-block" v-if="!stream.running.value">
          <label class="form-label">原文 / 要点</label>
          <textarea
            v-model="sourceText"
            class="form-textarea source-area"
            :placeholder="placeholder"
          ></textarea>
        </div>

        <!-- 流式生成中 -->
        <div v-if="stream.running.value" class="stream-block">
          <div class="stream-text">{{ stream.text.value }}<span class="caret">▍</span></div>
        </div>

        <!-- 结果（加工型直接展示） -->
        <div v-if="resultText && !stream.running.value && current?.kind === 'processing'" class="result-block">
          <label class="form-label">结果（可复制）</label>
          <div class="result-text">{{ resultText }}</div>
        </div>

        <!-- 产出型提示 -->
        <div v-if="productiveDone" class="info-box">
          ✅ 结果已作为候选记录进入「待确认」，可在今日页确认；若提取出待办也会一并进入队列。
        </div>

        <div v-if="stream.error.value" class="error-box">
          处理失败：{{ stream.error.value.message }}
        </div>

        <!-- 操作 -->
        <div class="actions">
          <template v-if="stream.running.value">
            <button class="btn btn-danger" @click="abort">停止</button>
          </template>
          <template v-else>
            <button class="btn btn-primary" :disabled="!canRun" @click="run">运行</button>
            <button v-if="resultText" class="btn" @click="copy">复制结果</button>
          </template>
        </div>
      </section>
    </div>

    <div v-if="toast" class="toast" :class="toast.type">
      {{ toast.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useWorkStream } from '@/composables/useWorkStream'
import { useToast } from '@/composables/useToast'

interface ToolInfo {
  id: string
  label: string
  kind: 'productive' | 'processing'
  needsSource: boolean
  description: string
}

const route = useRoute()
const { toast, showToast } = useToast()
const stream = useWorkStream()

const tools = ref<ToolInfo[]>([])
const selectedId = ref<string | null>(null)
const sourceText = ref('')
const resultText = ref('')
const productiveDone = ref(false)

const current = computed(() => tools.value.find((t) => t.id === selectedId.value) ?? null)

const placeholder = computed(() => {
  if (!current.value) return ''
  if (current.value.id === 'email_draft') return '输入邮件要点…'
  if (current.value.needsSource) return '粘贴或输入待处理文本…'
  return '输入要点…'
})

const canRun = computed(() => {
  if (!current.value) return false
  if (current.value.needsSource) return sourceText.value.trim().length > 0
  return sourceText.value.trim().length > 0
})

function selectTool(id: string): void {
  selectedId.value = id
  resultText.value = ''
  productiveDone.value = false
}

async function run(): Promise<void> {
  if (!current.value) return
  resultText.value = ''
  productiveDone.value = false
  try {
    const res = await window.api.work.tools.run({ toolId: current.value.id, text: sourceText.value })
    stream.bind(res.runId)
    const done = await stream.done
    if (current.value?.kind === 'processing') {
      resultText.value = done.text || stream.text.value
    } else {
      productiveDone.value = true
    }
    if (done.aborted) showToast('已停止', 'warning')
  } catch (e: any) {
    showToast(`运行失败：${e.message}`, 'error')
  } finally {
    stream.reset()
  }
}

async function abort(): Promise<void> {
  if (stream.runId.value) await window.api.work.tools.abortRun(stream.runId.value)
}

// 路由切走：在途流先中止（避免白烧 token），再移除 IPC 监听器
onBeforeUnmount(() => {
  const rid = stream.runId.value
  if (rid) void window.api.work.tools.abortRun(rid)
  stream.unsubscribe()
})

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(resultText.value)
    showToast('已复制', 'success')
  } catch {
    showToast('复制失败，请手动选择', 'error')
  }
}

onMounted(async () => {
  tools.value = await window.api.work.tools.list()
  // 从今日页/路由预填
  const preTarget = typeof route.query.target === 'string' ? route.query.target : null
  const preText = typeof route.query.text === 'string' ? route.query.text : ''
  const idMap: Record<string, string> = {
    tool_minutes: 'minutes', tool_summary: 'summary', tool_translate: 'translate',
    tool_polish: 'polish', email_draft: 'email_draft'
  }
  selectedId.value = preTarget ? idMap[preTarget] ?? 'polish' : tools.value[0]?.id ?? null
  if (preText) sourceText.value = preText
})
</script>

<style scoped>
.tools-page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.tools-header { display: flex; flex-direction: column; gap: 4px; }

.tools-layout { display: grid; grid-template-columns: 280px 1fr; gap: 16px; flex: 1; min-height: 0; }

.tool-col { overflow-y: auto; }
.tool-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.tool-row {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px; background: var(--bg-base); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); cursor: pointer;
}
.tool-row.active { border-color: var(--accent); background: var(--accent-muted); }
.tool-main { display: flex; align-items: center; justify-content: space-between; }
.tool-label { font-size: 13px; font-weight: 500; }
.tool-desc { font-size: 12px; color: var(--text-muted); }

.work-col { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.work-head { display: flex; flex-direction: column; gap: 4px; }

.source-block { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 120px; }
.source-area { flex: 1; resize: none; line-height: 1.7; min-height: 200px; }

.stream-block { flex: 1; overflow-y: auto; }
.stream-text { font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.caret { color: var(--accent); animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.result-block { display: flex; flex-direction: column; gap: 8px; }
.result-text {
  background: var(--bg-base); border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
  padding: 12px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; max-height: 240px; overflow-y: auto;
}
.info-box {
  font-size: 13px; color: var(--blue); background: rgba(88,166,250,0.08);
  border: 1px solid rgba(88,166,250,0.3); border-radius: var(--radius-sm); padding: 10px 12px;
}
.error-box { color: var(--red); font-size: 13px; padding: 8px; border: 1px solid var(--red); border-radius: var(--radius-sm); }

.actions { display: flex; gap: 8px; }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 100;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
