<template>
  <transition name="fade">
    <div v-if="visible" class="modal-overlay wizard-overlay">
      <div class="modal-card modal-lg wizard-card">
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

        <!-- ① 隐私告知（兜底：正常已由用户协议弹窗先过） -->
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

        <!-- ③ 画像 -->
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
          <p class="hint">从「新的一天」页开始你的一天。随时可在设置里改画像和提醒。</p>
          <div class="actions">
            <button class="btn btn-primary" @click="close">进入新的一天</button>
          </div>
        </div>

        <div v-if="error" class="error-box">{{ error }}</div>
      </div>

      <transition name="slide">
        <div v-if="toast" class="toast-container">
          <div class="toast" :class="toast.type">{{ toast.msg }}</div>
        </div>
      </transition>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useToast } from '@/composables/useToast'

interface OldDbMapping {
  callName?: string
  position?: string
  department?: string
  company?: string
  tone?: string
  displayOnlyCount: number
}

/**
 * 冷启动向导（**弹窗形态**，北 2026-09-24 定）。
 *
 * 不再走路由：此前是 `/work/wizard` 页面，侧边栏还能点别的路由、向导形同虚设。
 * 现在与用户协议弹窗同构：**不可关闭**（无 ✕、点遮罩不关），走完（或逐步跳过）
 * 才 `complete()` 并关闭——**只出现一次**，完成后永不再弹。
 */
const props = withDefaults(
  defineProps<{ visible?: boolean }>(),
  { visible: true }
)

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'done'): void
}>()

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
    // 同意写**宿主库**（唯一权威）：work 停用时也能落，且与启动闸门同源
    await window.api.consent.grant()
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

/** 关闭弹窗（仅完成态可点）：通知外层收口并跳「今日」 */
function close(): void {
  emit('update:visible', false)
  emit('done')
}

/**
 * 读状态并定位到起点。
 *
 * 同意只在用户协议弹窗里出现一次（北 2026-09-24）：已同意就跳过「隐私说明」步，
 * 直接从画像开始；未同意则回到第 0 步兜底。
 */
async function initState(): Promise<void> {
  error.value = ''
  try {
    status.value = await window.api.work.wizard.status()
    // 同意状态以宿主为准（宿主单源）；读取失败则回落向导返回值
    const consent = await window.api.consent.status().catch(() => null)
    consented.value = consent ? consent.consent : status.value.consent
    if (status.value.oldDbDecision) oldDbChoice.value = status.value.oldDbDecision as any
    stepIndex.value = status.value.consent ? 1 : 0
  } catch (e: any) {
    error.value = `读取向导状态失败：${e.message}`
  }
}

onMounted(() => {
  void initState()
})

// 每次打开都重新初始化：弹窗常驻挂载（v-if 在内部），若只在 onMounted 初始化，
// 完成后再次从「开始向导」进入会停在完成态、看不到步骤（北 2026-09-24）。
watch(
  () => props.visible,
  (v) => {
    if (v) void initState()
  }
)
</script>

<style scoped>
/* 遮罩骨架吃全局 .modal-overlay；本修饰类只补向导两个特例：
   ① 从标题栏下方开始，保证窗口最小化/关闭按钮始终可用（用户必须能退出）；
   ② 层级取 --z-banner(1900)，低于 ModelPicker(--z-modal 2000) 与 ConfirmDialog(--z-toast 2100)，
   否则「关闭 Umi Claw」确认框会被本遮罩盖住、用户无法退出 */
.wizard-overlay {
  top: var(--titlebar-h, 0);
  z-index: var(--z-banner);
  /* 全局遮罩默认不滚动；向导五步内容可能高于视口，恢复遮罩自身滚动 */
  overflow-y: auto;
}

/* 卡片骨架吃全局 .modal-card.modal-lg（原 660px 归并到全局 lg=720 档）；
   向导内容无 modal-body 包裹，这里补内边距与纵向节奏；
   内容超高时由遮罩自身滚动（margin:auto 保证顶部不被裁切），故解除全局 max-height/overflow 裁切 */
.wizard-card {
  max-height: none;
  overflow: visible;
  margin: auto;
  padding: var(--space-5);
  gap: var(--space-5);
}

.steps { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.step-dot {
  display: flex; align-items: center; gap: var(--space-1); padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-pill); background: var(--bg-base); border: 1px solid var(--border-muted);
  font-size: var(--text-xs); color: var(--text-muted);
}
.step-dot.active { border-color: var(--accent); color: var(--accent); }
.step-dot.done { border-color: var(--success); color: var(--success); }
.dot-num {
  width: 16px; height: 16px; border-radius: 50%; background: var(--bg-overlay);
  display: inline-flex; align-items: center; justify-content: center; font-size: var(--text-xs);
}

.step-body { display: flex; flex-direction: column; gap: var(--space-4); }
.hint { font-size: var(--text-sm); color: var(--text-secondary); line-height: var(--leading-relaxed); }

.notice {
  background: var(--bg-base); border: 1px solid var(--border);
  border-left: 3px solid var(--accent); border-radius: var(--radius-sm);
  padding: var(--space-4); font-size: var(--text-sm); line-height: var(--leading-relaxed);
}
.notice-list { margin: var(--space-3) 0 0 var(--space-4); color: var(--text-secondary); display: flex; flex-direction: column; gap: var(--space-1); }
.agree { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); cursor: pointer; }

.branch-list { display: flex; flex-direction: column; gap: var(--space-2); }
.branch {
  display: flex; flex-direction: column; gap: var(--space-1); text-align: left;
  padding: var(--space-3) var(--space-4); background: var(--bg-base); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); cursor: pointer; color: var(--text-primary);
}
.branch.active { border-color: var(--accent); background: var(--accent-muted); }
.branch-title { font-size: var(--text-sm); font-weight: 500; display: flex; align-items: center; gap: var(--space-2); }
.branch-desc { font-size: var(--text-xs); color: var(--text-secondary); line-height: var(--leading-normal); }

.mapping {
  background: var(--bg-base); border: 1px dashed var(--border);
  border-radius: var(--radius-sm); padding: var(--space-3) var(--space-4); font-size: var(--text-sm);
}
.mapping-title { color: var(--text-secondary); margin-bottom: var(--space-2); }
.mapping-list { list-style: none; display: flex; flex-direction: column; gap: var(--space-1); }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }

.kb-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.info-box {
  font-size: var(--text-sm); color: var(--info); background: var(--info-muted);
  border: 1px solid var(--info-border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3);
}

.todo-input { display: flex; }

.actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.done-body { align-items: center; text-align: center; padding: var(--space-5) 0; }
.done-icon { font-size: var(--text-hero); }
.error-box {
  color: var(--danger); font-size: var(--text-sm); padding: var(--space-2);
  border: 1px solid var(--danger); border-radius: var(--radius-sm);
}
/* Toast 收编全局 .toast-container/.toast，本组件不再自定义 */
</style>
