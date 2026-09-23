<template>
  <div class="settings-page">
    <header class="s-header">
      <h1>⚙️ 工作设置</h1>
    </header>

    <!-- 完整度引导 -->
    <section class="card completeness">
      <div class="c-head">
        <h2>资料完整度</h2>
        <span class="c-percent">{{ completeness.percent }}%</span>
      </div>
      <div class="bar"><div class="bar-fill" :style="{ width: completeness.percent + '%' }"></div></div>
      <div class="c-hint text-sm text-muted">
        <template v-if="completeness.missing.length">
          补上「{{ missingLabels }}」可到 {{ nextPercent }}%
        </template>
        <template v-else>资料已完整，AI 能更好地理解你的工作上下文 ✅</template>
      </div>
    </section>

    <!-- 工作画像 -->
    <section class="card">
      <div class="s-head">
        <h2>工作画像</h2>
        <button class="btn btn-primary btn-sm" :disabled="!dirty" @click="saveProfile">保存</button>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">怎么称呼你</label>
          <input v-model="form.callName" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">岗位</label>
          <input v-model="form.position" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">部门</label>
          <input v-model="form.department" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">公司 / 组织</label>
          <input v-model="form.company" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">向谁汇报</label>
          <input v-model="form.reportTo" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">偏好语气</label>
          <input v-model="form.tone" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">所属行业</label>
          <input v-model="form.industry" class="form-input" @input="dirty = true" />
        </div>
        <div class="form-group">
          <label class="form-label">日报偏好风格</label>
          <input v-model="form.reportStyle" class="form-input" @input="dirty = true" />
        </div>
      </div>
    </section>

    <!-- 提醒开关（两个固定通知，硬规则 22） -->
    <section class="card">
      <div class="s-head">
        <h2>提醒</h2>
        <span class="text-sm text-muted">两个固定本地通知，不依赖网关</span>
      </div>
      <div class="reminder-row">
        <div class="r-info">
          <span class="r-title">早上 9:00 · 今日待办汇总</span>
          <span class="r-desc text-sm text-muted">提醒你打开今天要做的事</span>
        </div>
        <label class="toggle">
          <input type="checkbox" :checked="reminders.morning" @change="toggleReminder('morning', ($event.target as HTMLInputElement).checked)" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="reminder-row">
        <div class="r-info">
          <span class="r-title">18:30 · 生成今日日报</span>
          <span class="r-desc text-sm text-muted">提醒你基于今天的记录生成日报</span>
        </div>
        <label class="toggle">
          <input type="checkbox" :checked="reminders.report" @change="toggleReminder('report', ($event.target as HTMLInputElement).checked)" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </section>

    <!-- 旧数据（可重入） -->
    <section class="card">
      <div class="s-head">
        <h2>旧版本数据</h2>
      </div>
      <template v-if="wizard.oldDb">
        <p class="text-sm text-muted">
          检测到旧库（{{ wizard.oldDb.version }}）。当前选择：
          <strong>{{ decisionLabel }}</strong>。旧数据始终由旧版本拥有，新版只读不写。
        </p>
        <div class="olddb-actions">
          <button class="btn btn-sm" @click="reenter('keep')">沿用（只读）</button>
          <button class="btn btn-sm" @click="reenter('fresh')">另起</button>
          <button class="btn btn-sm" @click="reenter('later')">稍后决定</button>
        </div>
      </template>
      <p v-else class="text-sm text-muted">未检测到旧版本数据。</p>
    </section>

    <!-- Context 快照入口 -->
    <section class="card">
      <div class="s-head">
        <h2>AI 看见什么</h2>
        <button class="btn btn-sm" @click="router.push('/work/context')">查看当前上下文</button>
      </div>
      <p class="text-sm text-muted">只读预览：AI 处理时实际用到的资料组成，以及被裁剪/过滤的条目。</p>
    </section>

    <div v-if="toast.toast.value" class="toast" :class="toast.toast.value.type">
      {{ toast.toast.value.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const { toast, showToast } = useToast()

const form = ref({
  callName: '', position: '', department: '', company: '',
  reportTo: '', tone: '', industry: '', reportStyle: ''
})
const completeness = ref({ filled: 0, total: 6, percent: 0, missing: [] as string[] })
const dirty = ref(false)
const reminders = ref({ morning: true, report: true })
const wizard = ref<{ oldDb: { version: string } | null; oldDbDecision: string | null }>({
  oldDb: null, oldDbDecision: null
})

const FIELD_LABELS: Record<string, string> = {
  call_name: '称呼', position: '岗位', department: '部门',
  company: '公司', report_to: '汇报对象', tone: '偏好语气'
}
const missingLabels = computed(() => completeness.value.missing.map((f) => FIELD_LABELS[f] ?? f).join('、'))
const nextPercent = computed(() => {
  if (!completeness.value.missing.length) return 100
  return Math.round(((completeness.value.filled + 1) / completeness.value.total) * 100)
})
const decisionLabel = computed(() => {
  const d = wizard.value.oldDbDecision
  return { keep: '沿用（只读）', fresh: '另起', later: '稍后决定' }[d ?? ''] ?? '未决定'
})

async function loadProfile(): Promise<void> {
  try {
    const view = await window.api.work.profile.get()
    const p = view.profile
    form.value = {
      callName: p.call_name ?? '', position: p.position ?? '', department: p.department ?? '',
      company: p.company ?? '', reportTo: p.report_to ?? '', tone: p.tone ?? '',
      industry: p.industry ?? '', reportStyle: p.report_style ?? ''
    }
    completeness.value = view.completeness
    dirty.value = false
  } catch (e: any) {
    showToast(`加载画像失败：${e.message}`, 'error')
  }
}

async function saveProfile(): Promise<void> {
  try {
    const view = await window.api.work.profile.update({
      callName: form.value.callName || null,
      position: form.value.position || null,
      department: form.value.department || null,
      company: form.value.company || null,
      reportTo: form.value.reportTo || null,
      tone: form.value.tone || null,
      industry: form.value.industry || null,
      reportStyle: form.value.reportStyle || null
    })
    completeness.value = view.completeness
    dirty.value = false
    showToast('已保存', 'success')
  } catch (e: any) {
    showToast(`保存失败：${e.message}`, 'error')
  }
}

async function loadReminders(): Promise<void> {
  try {
    reminders.value = {
      morning: await window.api.work.reminder.isEnabled('morning'),
      report: await window.api.work.reminder.isEnabled('report')
    }
  } catch (e: any) {
    showToast(`读取提醒设置失败：${e.message}`, 'error')
  }
}

async function toggleReminder(id: 'morning' | 'report', enabled: boolean): Promise<void> {
  try {
    await window.api.work.reminder.setEnabled(id, enabled)
    reminders.value[id] = enabled
    showToast(enabled ? '提醒已开启' : '提醒已关闭', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
  }
}

async function loadWizard(): Promise<void> {
  try {
    const s = await window.api.work.wizard.status()
    wizard.value = { oldDb: s.oldDb, oldDbDecision: s.oldDbDecision }
  } catch (e: any) {
    showToast(`读取旧库状态失败：${e.message}`, 'error')
  }
}

async function reenter(decision: 'keep' | 'fresh' | 'later'): Promise<void> {
  try {
    await window.api.work.wizard.decide(decision)
    await loadWizard()
    showToast('已更新旧库选择', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
  }
}

onMounted(async () => {
  await Promise.all([loadProfile(), loadReminders(), loadWizard()])
})
</script>

<style scoped>
.settings-page { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
.s-header { display: flex; align-items: center; justify-content: space-between; }
.s-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.card { display: flex; flex-direction: column; }

.completeness { gap: 10px; }
.c-head { display: flex; align-items: center; justify-content: space-between; }
.c-percent { font-size: 18px; font-weight: 600; color: var(--accent); }
.bar { height: 6px; background: var(--bg-base); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); transition: width 0.3s; }
.c-hint { line-height: 1.6; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.reminder-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0; border-bottom: 1px solid var(--border-muted);
}
.reminder-row:last-child { border-bottom: none; }
.r-info { display: flex; flex-direction: column; gap: 3px; }
.r-title { font-size: 13px; }

.olddb-actions { display: flex; gap: 8px; margin-top: 10px; }

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 20px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border); z-index: 300;
}
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }
.toast.warning { border-color: var(--yellow); color: var(--yellow); }
</style>
