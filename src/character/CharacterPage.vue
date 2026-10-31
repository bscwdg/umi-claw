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
      <p class="hint">C01 骨架：形象、聊天、语音会按计划逐包接上。</p>
    </section>

    <section class="card">
      <h3>称呼</h3>
      <div class="row">
        <input v-model="addressDraft" maxlength="40" placeholder="她怎么称呼你（默认「你」）" />
        <button class="btn" :disabled="busy" @click="saveAddress">保存</button>
      </div>
      <p class="hint">不写死人名；改完立即生效。禁忌称呼留空 = 不限制。</p>
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
  memorySearchReady: false
})
const state = ref({
  stage: 0,
  familiarity: 0,
  intimacy: 0,
  mood: '',
  addressForm: '你'
})
const addressDraft = ref('')
const busy = ref(false)
const error = ref('')

const STAGE_LABELS = ['初识', '眼熟', '熟客', '自己人', '搭子以上']
const stageLabel = computed(() => STAGE_LABELS[state.value.stage] ?? '初识')

let offEvent: (() => void) | null = null

onMounted(async () => {
  offEvent = window.api.character.onEvent(() => {
    void refresh()
  })
  await refresh()
})

onBeforeUnmount(() => {
  offEvent?.()
  offEvent = null
})

async function refresh(): Promise<void> {
  try {
    status.value = await window.api.character.status()
    state.value = await window.api.character.state()
    const settings = await window.api.character.settings.get()
    addressDraft.value = settings.relationship?.address || '你'
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

async function saveAddress(): Promise<void> {
  await run(async () => {
    const address = addressDraft.value.trim() || '你'
    await window.api.character.settings.set({ relationship: { address } } as never)
    await refresh()
  })
}

async function interact(kind: 'pat' | 'feed'): Promise<void> {
  await run(async () => {
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
  max-width: 860px;
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
}
input {
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
</style>
