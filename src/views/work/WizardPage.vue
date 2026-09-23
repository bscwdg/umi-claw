<template>
  <div class="wizard-page">
    <div class="wizard-card card">
      <!-- 步骤指示 -->
      <div class="steps">
        <div
          v-for="(s, i) in visibleSteps"
          :key="s.id"
          class="step-dot"
          :class="{ active: i === stepIndex, done: i < stepIndex }"
        >
          <span class="dot-num">{{ i < stepIndex ? '✓' : i + 1 }}</span>
          <span class="dot-label">{{ s.label }}</span>
        </div>
      </div>

      <!-- ① 隐私告知（必过） -->
      <div v-if="current.id === 'consent'" class="step-body">
        <h2>开始前，先说清楚资料怎么用</h2>
        <div class="notice">
          <p>
            资料默认仅保存在本地；当你主动执行需要 AI 处理的操作时，被选中的上下文内容
            可能随请求发送至你所选的模型服务商。
          </p>
          <ul class="notice-list">
            <li>不点 AI 动作，就不会有任何内容外发</li>
            <li>外发范围只有你本次操作选中的上下文，不是整库</li>
            <li>模型服务商在「模型配置」里选，随时可改</li>
          </ul>
        </div>
        <label class="agree">
          <input type="checkbox" v-model="consented" />
          <span>我已阅读并同意上述说明</span>
        </label>
        <div class="actions">
          <button class="btn btn-primary" :disabled="!consented" @click="onConsent">同意并继续</button>
        </div>
      </div>

      <!-- ② 旧库三分支 -->
      <div v-else-if="current.id === 'olddb'" class="step-body">
        <h2>检测到旧版本的数据</h2>
        <p class="hint">
          发现旧库（{{ status?.oldDb?.version }}）。旧数据始终由旧版本自己拥有，
          新版本<strong>只读不写</strong>，绝不迁移、绝不覆盖。
        </p>
        <div class="branch-list">
          <button
            v-for="b in branches"
            :key="b.id"
            class="branch"
            :class="{ active: oldDbChoice === b.id }"
            @click="oldDbChoice = b.id"
          >
            <span class="branch-title">{{ b.title }}<span v-if="b.id === 'later'" class="badge">默认</span></span>
            <span class="branch-desc">{{ b.desc }}</span>
          </button>
        </div>

        <!-- 沿用：展示只读映射 -->
        <div v-if="oldDbChoice === 'keep' && mapping" class="mapping">
          <div class="mapping-title">可从旧库预填（只读，不会改动旧文件）：</div>
          <ul class="mapping-list">
            <li v-for="m in mappingRows" :key="m.k">{{ m.k }}：<strong>{{ m.v }}</strong></li>
          </ul>
          <div v-if="!mappingRows.length" class="text-muted text-sm">旧库中没有可安全映射的字段。</div>
          <div v-if="mapping.displayOnlyCount" class="text-muted text-sm">
            另有 {{ mapping.displayOnlyCount }} 项旧数据仅作展示，不写入新库。
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-primary" @click="decideOldDb">继续</button>
        </div>
      </div>

      <!-- ③ 画像三步 -->
      <div v-else-if="current.id === 'profile'" class="step-body">
        <h2>让 AI 认识你（可跳过，之后随时补）</h2>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">怎么称呼你</label>
            <input v-model="profileForm.callName" class="form-input" placeholder="例如：小北" />
          </div>
          <div class="form-group">
            <label class="form-label">岗位</label>
            <input v-model="profileForm.position" class="form-input" placeholder="例如：产品经理" />
          </div>
          <div class="form-group">
            <label class="form-label">部门</label>
            <input v-model="profileForm.department" class="form-input" placeholder="例如：增长部" />
          </div>
          <div class="form-group">
            <label class="form-label">公司 / 组织</label>
            <input v-model="profileForm.company" class="form-input" placeholder="例如：某某科技" />
          </div>
          <div class="form-group">
            <label class="form-label">向谁汇报</label>
            <input v-model="profileForm.reportTo" class="form-input" placeholder="例如：李总" />
          </div>
          <div class="form-group">
            <label class="form-label">偏好语气</label>
            <input v-model="profileForm.tone" class="form-input" placeholder="例如：简洁直接" />
          </div>
        </div>
        <div class="actions">
          <button class="btn" @click="next">跳过</button>
          <button class="btn btn-primary" @click="saveProfile">保存并继续</button>
        </div>
      </div>

      <!-- ④ 导入知识库（可跳过） -->
      <div v-else-if="current.id === 'knowledge'" class="step-body">
        <h2>导入工作知识库（可跳过）</h2>
        <p class="hint">把你常用的资料放进本地知识库，AI 处理时才能引用到。</p>
        <div class="kb-actions">
          <button class="btn" @click="importNow('url')">从网址导入</button>
          <button class="btn" @click="importNow('file')">从文件导入</button>
          <button class="btn" @click="importNow('text')">粘贴文本</button>
        </div>
        <div v-if="kbImported" class="info-box">已导入 {{ kbImported }} 条资料 ✅</div>
        <div class="actions">
          <button class="btn" @click="next">跳过</button>
          <button class="btn btn-primary" @click="next">继续</button>
        </div>
      </div>

      <!-- ⑤ 第一条待办 -->
      <div v-else-if="current.id === 'todo'" class="step-body">
        <h2>加第一条待办</h2>
        <p class="hint">明天早上 9:00 会把今日待办推给你；18:30 提醒生成日报。</p>
        <div class="todo-input">
          <input
            v-model="firstTodo"
            class="form-input"
            placeholder="例如：整理本周周报素材"
            @keydown.enter="finish"
          />
        </div>
        <div class="actions">
          <button class="btn" @click="finish">跳过</button>
          <button class="btn btn-primary" @click="finish">完成</button>
        </div>
      </div>

      <!-- 完成 -->
      <div v-else class="step-body done-body">
        <div class="done-icon">🎉</div>
        <h2>可以开始了</h2>
        <p class="hint">从「今日」页开始你的一天。随时可在设置里改画像和提醒。</p>
        <div class="actions">
          <button class="btn btn-primary" @click="goToday">进入今日</button>
        </div>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
    </div>

    <div v-if="toast" class="toast" :class="toast.type">
      {{ toast.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'

interface OldDbMapping {
  callName?: string
  position?: string
  department?: string
  company?: string
  tone?: string
  displayOnlyCount: number
}

const router = useRouter()
const { toast, showToast } = useToast()

const status = ref<{ consent: boolean; completed: boolean; oldDb: { version: string } | null; oldDbDecision: string | null } | null>(null)
const stepIndex = ref(0)
const consented = ref(false)
const error = ref('')

// 旧库
const oldDbChoice = ref<'keep' | 'fresh' | 'later'>('later')
const mapping = ref<OldDbMapping | null>(null)

// 画像
const profileForm = ref({
  callName: '', position: '', department: '', company: '', reportTo: '', tone: ''
})

// 知识库 / 待办
const kbImported = ref(0)
const firstTodo = ref('')

const branches = [
  { id: 'keep', title: '沿用', desc: '读旧库做只读展示，能映射的字段预填到新库；不写入、不改动旧文件' },
  { id: 'fresh', title: '另起', desc: '开全新库，不碰旧数据；旧库原样保留，随时可回旧版本打开' },
  { id: 'later', title: '稍后决定', desc: '不做任何处理，直接进新库；下次启动不再追问（可在设置里手动进入）' }
] as const

// 步骤序列：有旧库才插入「旧库」步
const visibleSteps = computed(() => {
  const base = [
    { id: 'consent', label: '隐私说明' },
    { id: 'profile', label: '工作画像' },
    { id: 'knowledge', label: '知识库' },
    { id: 'todo', label: '第一条待办' }
  ]
  if (status.value?.oldDb) base.splice(1, 0, { id: 'olddb', label: '旧数据' })
  return base
})

const current = computed(() => visibleSteps.value[stepIndex.value] ?? { id: 'done', label: '完成' })

const mappingRows = computed(() => {
  const m = mapping.value
  if (!m) return []
  const out: Array<{ k: string; v: string }> = []
  if (m.company) out.push({ k: '公司 / 组织', v: m.company })
  if (m.tone) out.push({ k: '偏好语气', v: m.tone })
  if (m.callName) out.push({ k: '称呼', v: m.callName })
  if (m.position) out.push({ k: '岗位', v: m.position })
  if (m.department) out.push({ k: '部门', v: m.department })
  return out
})

function next(): void {
  error.value = ''
  if (stepIndex.value < visibleSteps.value.length - 1) stepIndex.value += 1
  else void finish()
}

async function onConsent(): Promise<void> {
  try {
    await window.api.work.wizard.grantConsent()
    consented.value = true
    next()
  } catch (e: any) {
    error.value = `记录同意状态失败：${e.message}`
  }
}

async function decideOldDb(): Promise<void> {
  error.value = ''
  try {
    const res = await window.api.work.wizard.decide(oldDbChoice.value)
    if (oldDbChoice.value === 'keep' && res.mapping) {
      mapping.value = res.mapping
      // 预填到画像表单（不直接写库，用户可在画像步确认）
      profileForm.value.callName = res.mapping.callName ?? profileForm.value.callName
      profileForm.value.position = res.mapping.position ?? profileForm.value.position
      profileForm.value.department = res.mapping.department ?? profileForm.value.department
      profileForm.value.company = res.mapping.company ?? profileForm.value.company
      profileForm.value.tone = res.mapping.tone ?? profileForm.value.tone
    }
    next()
  } catch (e: any) {
    error.value = `处理旧库选择失败：${e.message}`
  }
}

async function saveProfile(): Promise<void> {
  error.value = ''
  try {
    await window.api.work.profile.update({
      callName: profileForm.value.callName || null,
      position: profileForm.value.position || null,
      department: profileForm.value.department || null,
      company: profileForm.value.company || null,
      reportTo: profileForm.value.reportTo || null,
      tone: profileForm.value.tone || null
    })
    next()
  } catch (e: any) {
    error.value = `保存画像失败：${e.message}`
  }
}

async function importNow(kind: 'url' | 'file' | 'text'): Promise<void> {
  error.value = ''
  try {
    if (kind === 'url') {
      const url = window.prompt('输入网址')
      if (!url) return
      await window.api.work.knowledge.import({ type: 'url', url })
    } else if (kind === 'file') {
      const picked = await window.api.work.knowledge.pickFile()
      if (picked.canceled) return
      // 合法类型仅 text/markdown/url/faq/docx/xlsx/pdf —— 按扩展名推导
      await window.api.work.knowledge.import({
        type: typeFromName(picked.name),
        filePath: picked.filePath
      })
    } else {
      const text = window.prompt('粘贴文本内容')
      if (!text) return
      await window.api.work.knowledge.create({ type: 'text', content: text })
    }
    kbImported.value += 1
    showToast('导入成功', 'success')
  } catch (e: any) {
    error.value = `导入失败：${e.message}`
  }
}

function typeFromName(name: string): 'docx' | 'xlsx' | 'pdf' | 'text' | 'markdown' {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return 'text'
}

async function finish(): Promise<void> {
  error.value = ''
  try {
    if (firstTodo.value.trim()) {
      await window.api.work.todos.create({ title: firstTodo.value.trim() })
    }
    await window.api.work.wizard.complete()
    stepIndex.value = visibleSteps.value.length // 进完成态
  } catch (e: any) {
    error.value = `完成向导失败：${e.message}`
  }
}

function goToday(): void {
  router.push('/work/today')
}

onMounted(async () => {
  try {
    status.value = await window.api.work.wizard.status()
    consented.value = status.value.consent
    if (status.value.oldDbDecision) oldDbChoice.value = status.value.oldDbDecision as any
    // 已同意过则直接从画像开始
    if (status.value.consent && status.value.completed) stepIndex.value = visibleSteps.value.length
  } catch (e: any) {
    error.value = `读取向导状态失败：${e.message}`
  }
})
</script>

<style scoped>
.wizard-page {
  display: flex; align-items: flex-start; justify-content: center;
  padding: 24px; min-height: 100%;
}
.wizard-card { width: 660px; max-width: 100%; display: flex; flex-direction: column; gap: 20px; }

.steps { display: flex; gap: 8px; flex-wrap: wrap; }
.step-dot {
  display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  border-radius: 20px; background: var(--bg-base); border: 1px solid var(--border-muted);
  font-size: 12px; color: var(--text-muted);
}
.step-dot.active { border-color: var(--accent); color: var(--accent); }
.step-dot.done { border-color: var(--green); color: var(--green); }
.dot-num {
  width: 16px; height: 16px; border-radius: 50%; background: var(--bg-overlay);
  display: inline-flex; align-items: center; justify-content: center; font-size: 10px;
}

.step-body { display: flex; flex-direction: column; gap: 14px; }
.hint { font-size: 13px; color: var(--text-secondary); line-height: 1.7; }

.notice {
  background: var(--bg-base); border: 1px solid var(--border);
  border-left: 3px solid var(--accent); border-radius: var(--radius-sm);
  padding: 14px 16px; font-size: 13px; line-height: 1.8;
}
.notice-list { margin: 10px 0 0 18px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px; }
.agree { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }

.branch-list { display: flex; flex-direction: column; gap: 8px; }
.branch {
  display: flex; flex-direction: column; gap: 5px; text-align: left;
  padding: 12px 14px; background: var(--bg-base); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); cursor: pointer; color: var(--text-primary);
}
.branch.active { border-color: var(--accent); background: var(--accent-muted); }
.branch-title { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.branch-desc { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }

.mapping {
  background: var(--bg-base); border: 1px dashed var(--border);
  border-radius: var(--radius-sm); padding: 12px 14px; font-size: 13px;
}
.mapping-title { color: var(--text-secondary); margin-bottom: 8px; }
.mapping-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.kb-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.info-box {
  font-size: 13px; color: var(--blue); background: rgba(88,166,250,0.08);
  border: 1px solid rgba(88,166,250,0.3); border-radius: var(--radius-sm); padding: 10px 12px;
}

.todo-input { display: flex; }

.actions { display: flex; justify-content: flex-end; gap: 8px; }
.done-body { align-items: center; text-align: center; padding: 20px 0; }
.done-icon { font-size: 44px; }
.error-box {
  color: var(--red); font-size: 13px; padding: 8px;
  border: 1px solid var(--red); border-radius: var(--radius-sm);
}

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 300;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
