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
        <span class="text-sm text-muted">两个固定本地通知，时刻可改，不依赖网关</span>
      </div>
      <div class="reminder-row">
        <div class="r-info">
          <span class="r-title">早上 {{ reminderTimes.morning }} · 今日待办汇总</span>
          <span class="r-desc text-sm text-muted">提醒你打开今天要做的事</span>
        </div>
        <div class="r-actions">
          <input
            class="form-input time-input"
            type="time"
            :value="reminderTimes.morning"
            @change="saveReminderTime('morning', ($event.target as HTMLInputElement).value)"
          />
          <label class="toggle">
            <input type="checkbox" :checked="reminders.morning" @change="toggleReminder('morning', ($event.target as HTMLInputElement).checked)" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="reminder-row">
        <div class="r-info">
          <span class="r-title">{{ reminderTimes.report }} · 生成今日日报</span>
          <span class="r-desc text-sm text-muted">提醒你基于今天的记录生成日报</span>
        </div>
        <div class="r-actions">
          <input
            class="form-input time-input"
            type="time"
            :value="reminderTimes.report"
            @change="saveReminderTime('report', ($event.target as HTMLInputElement).value)"
          />
          <label class="toggle">
            <input type="checkbox" :checked="reminders.report" @change="toggleReminder('report', ($event.target as HTMLInputElement).checked)" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </section>

    <!-- 外发（方案 A：只推短提示，不推正文）。id 供今日页「去配置」跳来定位 -->
    <section id="push" class="card">
      <div class="s-head">
        <h2>外发提醒到渠道</h2>
        <label class="toggle">
          <input type="checkbox" :checked="push.enabled" @change="togglePush(($event.target as HTMLInputElement).checked)" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="text-sm text-muted">
        到点时把<strong>同一条短提示</strong>发到渠道（如「日报草稿已就绪，去确认」）。
        <strong>不推送日报正文</strong>——正文仍需你在「报告」页确认后才外传。
      </p>
      <p class="text-sm text-muted">
        这是<strong>总开关</strong>，只管<strong>外发到渠道</strong>：关掉后「新的一天」页逐条设的
        待办到点提醒<strong>仍会在本机弹通知</strong>，只是不再外发到渠道（到点即消费，不补发）。
      </p>

      <p class="text-sm push-hint">
        下拉只列出<strong>已在「渠道接入」配置好</strong>的渠道
        <template v-if="unconfiguredLabels.length">
          ；{{ unconfiguredLabels }} 尚未配置或暂不支持，配好后才会出现
        </template>。
        <button class="btn btn-sm push-goto" @click="router.push('/channelsPage')">去配置渠道</button>
      </p>

      <template v-if="pushChannelOptions.length">
        <div class="push-grid">
          <div class="form-group">
            <label class="form-label">首选渠道</label>
            <select
              class="form-input"
              :value="push.channel ?? ''"
              @change="savePushChannel(($event.target as HTMLSelectElement).value)"
            >
              <option value="">未选择</option>
              <option v-for="o in selectableChannels" :key="o.channel" :value="o.channel">{{ o.label }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">发给谁（自动识别）</label>
            <select
              class="form-input"
              :value="push.target ?? ''"
              :disabled="!push.channel"
              @change="savePushTarget(($event.target as HTMLSelectElement).value)"
            >
              <option value="">未选择</option>
              <option v-for="t in primaryTargets" :key="t.target" :value="t.target">{{ t.label }}</option>
            </select>
            <p class="text-sm text-muted push-note">
              由 OpenClaw 自动识别（它记得谁跟它说过话），无需手填。
            </p>
          </div>
        </div>

        <div class="push-grid">
          <div class="form-group">
            <label class="form-label">次选渠道（兜底，可选）</label>
            <select
              class="form-input"
              :value="push.fallbackChannel ?? ''"
              @change="saveFallbackChannel(($event.target as HTMLSelectElement).value)"
            >
              <option value="">不设兜底</option>
              <option v-for="o in fallbackChannels" :key="o.channel" :value="o.channel">{{ o.label }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">次选发给谁</label>
            <select
              class="form-input"
              :value="push.fallbackTarget ?? ''"
              :disabled="!push.fallbackChannel"
              @change="saveFallbackTarget(($event.target as HTMLSelectElement).value)"
            >
              <option value="">未选择</option>
              <option v-for="t in fallbackTargets" :key="t.target" :value="t.target">{{ t.label }}</option>
            </select>
          </div>
        </div>
        <p class="text-sm text-muted">首选推送失败时，会自动接着试次选渠道。</p>

        <div class="push-actions">
          <button class="btn btn-sm" :disabled="testing || !push.channel || !push.target" @click="runTestPush">
            {{ testing ? '测试中…' : '发送测试消息' }}
          </button>
          <span v-if="testResult" class="text-sm" :class="testResult.ok ? 'push-ok' : 'push-fail'">
            {{ testResult.ok ? '✅' : '❌' }} {{ testResult.message }}
          </span>
        </div>
        <p v-if="needStartClaw" class="text-sm push-warn push-startline">
          ⚠️ 推送测试需要 OpenClaw 处于运行中。
          <button class="btn btn-sm" @click="router.push('/dashboard')">去控制台启动</button>
        </p>
      </template>

      <p v-else class="text-sm push-warn">
        ⚠️ 还没有任何已配置的渠道，请先到「渠道接入」完成配置。
      </p>

      <p v-if="push.enabled && (!push.channel || !push.target)" class="text-sm push-warn">
        ⚠️ 还未配置首选通道与目标，无法开启外发。
      </p>

      <!-- 失败提示：最近一次外发结果 -->
      <p v-if="pushStatus && !pushStatus.ok" class="text-sm push-fail">
        ❌ 上次外发失败（{{ pushStatusLabel }}）：{{ pushStatus.message || '未知原因' }}
      </p>
      <p v-else-if="pushStatus && pushStatus.ok" class="text-sm push-ok">
        ✅ 上次外发成功（{{ pushStatusLabel }}）
      </p>
    </section>

    <!-- 用户协议（勾选状态与弹窗联动：同意后此处自动打勾） -->
    <section class="card">
      <div class="s-head">
        <h2>用户协议</h2>
      </div>
      <label class="agree-row">
        <input type="checkbox" :checked="consentGranted" disabled />
        <span>
          是否同意
          <button class="link-btn" @click="openAgreement">用户协议</button>
          <template v-if="consentAtLabel">（已于 {{ consentAtLabel }} 同意）</template>
        </span>
      </label>
      <p v-if="!consentGranted" class="text-sm push-warn">
        ⚠️ 未同意用户协议，OpenClaw 无法启动。点「用户协议」完成同意。
      </p>
      <p v-else class="text-sm text-muted">
        点「用户协议」可重新查看，并会反显你之前的同意记录。
      </p>
      <div class="agreement-actions">
        <button class="btn btn-sm" @click="openWizard">开始向导</button>
        <button class="btn btn-sm" @click="revokeAgreement">撤销同意（重新测试）</button>
      </div>
      <p class="text-sm text-muted agreement-hint">
        「开始向导」随时可重跑（画像 / 知识库 / 第一条待办，均可跳过）；
        「撤销同意」会立即重弹协议弹窗，便于验证首启流程。
      </p>
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

    <!-- 用户协议弹窗由 App.vue 渲染全局唯一实例（此处不再重复渲染，避免双遮罩） -->

    <!-- Context 快照入口 -->
    <section class="card">
      <div class="s-head">
        <h2>AI的世界</h2>
        <button class="btn btn-sm" @click="router.push('/work/context')">查看当前上下文</button>
      </div>
      <p class="text-sm text-muted">只读预览：AI 处理时实际用到的资料组成，以及被裁剪/过滤的条目。</p>
    </section>

    <div v-if="toast" class="toast" :class="toast.type">
      {{ toast.msg }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useToast } from '@/composables/useToast'
import {
  consentGranted,
  consentAt,
  openAgreementReview,
  openAgreementBlocking,
  syncConsent
} from '@/composables/useAgreementGate'
import { openWizard } from '@/composables/useWizardGate'

const router = useRouter()
const route = useRoute()
const { toast, showToast } = useToast()

const form = ref({
  callName: '', position: '', department: '', company: '',
  reportTo: '', tone: '', industry: '', reportStyle: ''
})
const completeness = ref({ filled: 0, total: 6, percent: 0, missing: [] as string[] })
const dirty = ref(false)
const reminders = ref({ morning: true, report: true })
const reminderTimes = ref({ morning: '09:00', report: '18:30' })
type PushChannelKey = 'feishu' | 'wecom' | 'openclaw-weixin' | 'dingtalk'
interface PushChannelOption {
  channel: PushChannelKey
  label: string
  configured: boolean
  supported: boolean
}

interface PushTargetOption {
  target: string
  label: string
  kind: 'direct' | 'group'
  updatedAt: number
}

const push = ref<{
  enabled: boolean
  channel: PushChannelKey | null
  fallbackChannel: PushChannelKey | null
  target: string | null
  fallbackTarget: string | null
}>({ enabled: false, channel: null, fallbackChannel: null, target: null, fallbackTarget: null })
const pushChannelOptions = ref<PushChannelOption[]>([])
const pushStatus = ref<{ at: number; channel: string | null; ok: boolean; message: string | null } | null>(null)
/** 首选/次选渠道下 OpenClaw 已知的目标 */
const primaryTargetOptions = ref<PushTargetOption[]>([])
const fallbackTargetOptions = ref<PushTargetOption[]>([])
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

/** 下拉只展示已配置的渠道（北：没配置肯定不能推） */
const selectableChannels = computed(() =>
  pushChannelOptions.value.filter((o) => o.configured && o.supported)
)
/** 次选不能与首选相同 */
const fallbackChannels = computed(() =>
  selectableChannels.value.filter((o) => o.channel !== push.value.channel)
)
/** 提示里点名的「未出现」渠道 */
const unconfiguredLabels = computed(() =>
  pushChannelOptions.value.filter((o) => !(o.configured && o.supported)).map((o) => o.label).join('、')
)
const pushStatusLabel = computed(() => {
  const s = pushStatus.value
  if (!s) return ''
  const t = new Date(s.at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
})

/** 目标展示：OpenClaw 给的原生标签优先，否则按 kind 给友好名 */
function fmtTarget(t: PushTargetOption): string {
  const name = t.label && !/^(openclaw-weixin|feishu|wecom):/.test(t.label) ? t.label : ''
  const kindText = t.kind === 'group' ? '群聊' : '私聊'
  return name ? `${name}（${kindText}）` : kindText
}
/** 首选目标下拉：把已保存但已不在清单里的目标也显示，避免选中项丢失 */
const primaryTargets = computed(() => withCurrent(primaryTargetOptions.value, push.value.target))
const fallbackTargets = computed(() => withCurrent(fallbackTargetOptions.value, push.value.fallbackTarget))
function withCurrent(list: PushTargetOption[], current: string | null): PushTargetOption[] {
  if (!current) return list
  if (list.some((t) => t.target === current)) return list
  return [{ target: current, label: current, kind: 'direct', updatedAt: 0 }, ...list]
}
const wizard = ref<{ oldDb: { version: string } | null; oldDbDecision: string | null }>({
  oldDb: null, oldDbDecision: null
})

// 用户协议：同意状态在 useAgreementGate 里与弹窗共享（北：这个要和那个弹窗关联）
const consentAtLabel = computed(() => {
  const t = consentAt.value
  if (!t) return ''
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})
/** 推送测试前置：OpenClaw 未运行 */
const needStartClaw = ref(false)

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
    const times = await window.api.work.reminder.getTimes()
    reminderTimes.value = {
      morning: fmtTime(times.morning),
      report: fmtTime(times.report)
    }
    push.value = await window.api.work.reminder.getPushConfig()
    pushChannelOptions.value = await window.api.work.reminder.availablePushChannels()
    pushStatus.value = await window.api.work.reminder.getPushStatus()
    await loadPushTargets()
  } catch (e: any) {
    showToast(`读取提醒设置失败：${e.message}`, 'error')
  }
}

/** 拉取首选/次选渠道下 OpenClaw 已知的目标（用户不需手填） */
async function loadPushTargets(): Promise<void> {
  try {
    primaryTargetOptions.value = push.value.channel
      ? await window.api.work.reminder.availablePushTargets(push.value.channel)
      : []
    fallbackTargetOptions.value = push.value.fallbackChannel
      ? await window.api.work.reminder.availablePushTargets(push.value.fallbackChannel)
      : []
  } catch {
    primaryTargetOptions.value = []
    fallbackTargetOptions.value = []
  }
}

/** 开关外发；未配好通道/目标时后端会拒，前端回滚到真实状态 */
async function togglePush(enabled: boolean): Promise<void> {
  try {
    push.value = await window.api.work.reminder.setPushConfig({ enabled })
    showToast(enabled ? '外发已开启' : '外发已关闭', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
  }
}

async function savePushChannel(value: string): Promise<void> {
  const channel = selectableChannels.value.some((o) => o.channel === value)
    ? (value as PushChannelKey)
    : null
  const changed = channel !== push.value.channel
  try {
    // 换首选时：与次选撞车则清掉次选；换渠道则旧目标失效，一并清空
    const patch: {
      channel: PushChannelKey | null
      fallbackChannel?: PushChannelKey | null
      target?: string | null
    } = { channel }
    if (channel !== null && channel === push.value.fallbackChannel) patch.fallbackChannel = null
    if (changed) patch.target = null
    push.value = await window.api.work.reminder.setPushConfig(patch)
    await loadPushTargets()
    showToast('首选渠道已保存', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
  }
}

async function saveFallbackChannel(value: string): Promise<void> {
  const channel = fallbackChannels.value.some((o) => o.channel === value)
    ? (value as PushChannelKey)
    : null
  const changed = channel !== push.value.fallbackChannel
  try {
    push.value = await window.api.work.reminder.setPushConfig({
      fallbackChannel: channel,
      ...(changed ? { fallbackTarget: null } : {})
    })
    await loadPushTargets()
    showToast(channel ? '次选渠道已保存' : '已取消兜底', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
  }
}

/** 首选目标：从 OpenClaw 已发现的目标里选（下拉，不手填） */
async function savePushTarget(value: string): Promise<void> {
  const target = value || null
  try {
    push.value = await window.api.work.reminder.setPushConfig({ target })
    testResult.value = null
    showToast('已保存发给谁', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
  }
}

async function saveFallbackTarget(value: string): Promise<void> {
  const target = value || null
  try {
    push.value = await window.api.work.reminder.setPushConfig({ fallbackTarget: target })
    showToast('次选目标已保存', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
  }
}

/** 推送测试：按已配置的首选→次选发一条探针消息（不含任何工作内容） */
async function runTestPush(): Promise<void> {
  needStartClaw.value = false
  testing.value = true
  testResult.value = null
  try {
    // 前置：推送由 OpenClaw 投递，未运行就没法测（北 2026-09-24）
    // 直接问主进程（不依赖 pinia store：本页在组件级验收里需能独立挂载）
    const clawStatus = await window.api.claw.status()
    if (!clawStatus?.running) {
      needStartClaw.value = true
      showToast('请先启动 OpenClaw 再测试推送', 'error')
      return
    }
    const res = await window.api.work.reminder.testPush()
    testResult.value = { ok: res.ok, message: res.message }
    pushStatus.value = await window.api.work.reminder.getPushStatus()
    showToast(res.ok ? '测试推送成功' : `测试推送失败：${res.message}`, res.ok ? 'success' : 'error')
  } catch (e: any) {
    testResult.value = { ok: false, message: e.message }
    showToast(`测试失败：${e.message}`, 'error')
  } finally {
    testing.value = false
  }
}

function fmtTime(t: { hour: number; minute: number }): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`
}

/** 改「两个固定通知」各自的时刻（不是调度系统：仍只有两个通知） */
async function saveReminderTime(id: 'morning' | 'report', value: string): Promise<void> {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) {
    showToast('时间格式应为 HH:mm', 'error')
    await loadReminders()
    return
  }
  const hour = Number(m[1])
  const minute = Number(m[2])
  try {
    await window.api.work.reminder.setTime(id, hour, minute)
    reminderTimes.value[id] = fmtTime({ hour, minute })
    showToast('提醒时间已保存', 'success')
  } catch (e: any) {
    showToast(`设置失败：${e.message}`, 'error')
    await loadReminders()
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
    syncConsent(s.consent, s.consentAt ?? null)
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
  // 从今日页「去配置」带 #push 跳来：滚动定位到外发段落
  if (route.hash === '#push') {
    await nextTick()
    document.getElementById('push')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})

/** 复核用户协议：弹窗会反显之前填的（已同意则默认打勾）。弹窗实例在 App.vue。 */
function openAgreement(): void {
  openAgreementReview()
}

/** 撤销同意：清库 → 同步状态 → **立即**重弹阻断式弹窗（无需重启即可验证首启流程） */
async function revokeAgreement(): Promise<void> {
  try {
    await window.api.work.wizard.revokeConsent()
    syncConsent(false, null)
    openAgreementBlocking()
    showToast('已撤销同意，请重新同意', 'success')
  } catch (e: any) {
    showToast(`撤销失败：${e.message}`, 'error')
  }
}
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
.r-actions { display: flex; align-items: center; gap: 12px; }
.time-input { width: 96px; padding: 4px 8px; font-size: 13px; }
.push-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 12px; margin-top: 12px; }
.push-warn { color: var(--yellow); margin-top: 8px; }
.push-hint { margin: 8px 0 0; line-height: 1.7; }
.push-goto { margin-left: 6px; }
.push-fail { color: var(--red); margin-top: 8px; }
.push-ok { color: var(--green); margin-top: 8px; }
.push-note { margin: 4px 0 0; }
.push-startline { display: flex; align-items: center; gap: 8px; }
.agree-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.agreement-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.agreement-hint { margin: 8px 0 0; line-height: 1.7; }
.link-btn {
  background: none; border: none; padding: 0;
  color: var(--accent); cursor: pointer; font-size: 13px;
  text-decoration: underline;
}
.push-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }

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
