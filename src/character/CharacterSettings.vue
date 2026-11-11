<template>
  <section class="card settings">
    <h3>详细设置</h3>
    <p class="hint">
      这里改的是她自己的行为参数（对应 <code>fish:v2:settings</code>）。保存后立即生效；称呼/关系模式在「首启三问」也能改。
    </p>

    <!-- dirty：用户改过就不被 onEvent→refresh 的回填覆盖；保存后由父组件 markSaved() 复位 -->
    <div class="settings-body" @input="dirty = true" @change="dirty = true">
      <div class="group">
        <h4>主动消息</h4>
        <label class="check-row">
          <input v-model="draft.proactive.enabled" type="checkbox" />
          <span>允许她主动找你（需先确认年龄与外部渠道）</span>
        </label>
        <div class="row">
          <label class="lab">静默几天后才可以主动</label>
          <input v-model.number="draft.proactive.silenceDays" class="form-input" type="number" min="0" max="14" />
          <label class="lab">每天上限</label>
          <input v-model.number="draft.proactive.dailyCap" class="form-input" type="number" min="0" max="60" />
        </div>
        <div class="row">
          <label class="lab">发送间隔</label>
          <select v-model="draft.proactive.intervalMode" class="form-select">
            <option value="fixed">固定间隔</option>
            <option value="range">随机区间</option>
          </select>
          <template v-if="draft.proactive.intervalMode === 'fixed'">
            <label class="lab">间隔（分钟）</label>
            <input
              v-model.number="draft.proactive.intervalMinutes"
              class="form-input"
              type="number"
              min="1"
              max="720"
              list="proactive-fixed-presets"
            />
            <datalist id="proactive-fixed-presets">
              <option v-for="m in [10, 20, 30, 60]" :key="m" :value="m">{{ m }} 分钟</option>
            </datalist>
          </template>
          <template v-else>
            <label class="lab">最短（分钟）</label>
            <input
              v-model.number="draft.proactive.intervalMinMinutes"
              class="form-input"
              type="number"
              min="1"
              max="720"
              list="proactive-range-presets"
            />
            <label class="lab">最长（分钟）</label>
            <input
              v-model.number="draft.proactive.intervalMaxMinutes"
              class="form-input"
              type="number"
              min="1"
              max="720"
              list="proactive-range-presets"
            />
            <datalist id="proactive-range-presets">
              <option v-for="m in [10, 30, 60, 180, 360]" :key="m" :value="m">
                {{ m >= 60 ? `${m / 60} 小时` : `${m} 分钟` }}
              </option>
            </datalist>
          </template>
        </div>
        <p class="hint">
          常用固定间隔：10 / 20 / 30 / 60 分钟；随机区间示例：1–10、10–30、30–60 分钟，
          1–3（60–180）、3–6 小时（180–360）。免打扰期间不发，结束后最多补一条。
        </p>
        <div class="row">
          <label class="lab">免打扰从</label>
          <input v-model="draft.proactive.quietFrom" class="form-input" type="time" />
          <label class="lab">到</label>
          <input v-model="draft.proactive.quietTo" class="form-input" type="time" />
        </div>
        <div class="row">
          <label class="lab">渠道</label>
          <select v-model="draft.proactive.channel" class="form-select">
            <option value="external">外部渠道（优先最近聊天）</option>
            <option value="app">应用内</option>
          </select>
        </div>
        <p class="hint">外部渠道 = 角色页「聊天渠道」里勾选并保存的渠道；优先发到最近跟她聊过的那个。没绑定或发送失败时只在本页提示。</p>
        <div class="row wrap">
          <span class="lab">消息类型</span>
          <label v-for="item in CONTENT_TYPES" :key="item.value" class="check-row inline disabled">
            <input v-model="draft.proactive.contentTypes" type="checkbox" :value="item.value" disabled />
            <span>{{ item.label }}</span>
          </label>
        </div>
        <p class="hint">消息类型暂时固定：每次从「她的一天」里挑一条。</p>
      </div>

      <div class="group">
        <h4>语音</h4>
        <label class="check-row">
          <input v-model="draft.voice.enabled" type="checkbox" />
          <span>允许发送语音条</span>
        </label>
        <label class="check-row">
          <input v-model="draft.voice.requestAllowed" type="checkbox" />
          <span>她说「发条语音」时允许直接发</span>
        </label>
        <label class="check-row disabled">
          <input v-model="draft.voice.sttEnabled" type="checkbox" disabled />
          <span>接收语音消息时转文字（入站语音尚未接线，暂不生效）</span>
        </label>
        <div class="row">
          <label class="lab">每天语音条上限</label>
          <input v-model.number="draft.voice.dailyCap" class="form-input" type="number" min="0" max="100" />
        </div>
      </div>

      <div class="group">
        <h4>群聊</h4>
        <label class="check-row">
          <input v-model="draft.group.replyEnabled" type="checkbox" />
          <span>允许她在 QQ 群里回复</span>
        </label>
        <label class="check-row">
          <input v-model="draft.group.requireMention" type="checkbox" />
          <span>群里必须 @ 她才回复（关掉=她可自主接话）</span>
        </label>
        <label class="check-row">
          <input v-model="draft.group.voiceEnabled" type="checkbox" />
          <span>允许群聊语音（默认关；只放开私聊更安全）</span>
        </label>
        <div class="row">
          <label class="lab">每个群每天语音上限</label>
          <input v-model.number="draft.group.dailyVoiceCap" class="form-input" type="number" min="0" max="20" />
          <label class="lab">群历史缓存条数</label>
          <input v-model.number="draft.group.historyLimit" class="form-input" type="number" min="0" max="50" />
        </div>
        <label class="check-row">
          <input v-model="draft.group.memoryIsolated" type="checkbox" />
          <span>群聊不写入私聊日记/长期记忆（群聊记忆隔离）</span>
        </label>
        <div class="row">
          <label class="lab">亲密词过滤</label>
          <select v-model="draft.group.words.action" class="form-select" :disabled="!draft.group.words.enabled">
            <option value="replace">替换</option>
            <option value="block">整条拦截</option>
          </select>
          <input
            v-if="draft.group.words.action === 'replace'"
            v-model="draft.group.words.replaceWith"
            class="form-input short"
            :disabled="!draft.group.words.enabled"
            placeholder="替换成"
          />
          <label class="check-row">
            <input v-model="draft.group.words.enabled" type="checkbox" />
            <span>启用</span>
          </label>
        </div>
        <div class="row column">
          <label class="lab">亲密词列表（逗号/换行分隔，只在群聊生效）</label>
          <textarea
            v-model="wordsText"
            class="form-textarea words"
            :disabled="!draft.group.words.enabled"
            rows="3"
            placeholder="宝宝，宝贝，亲爱的，老公，老婆，主人"
          />
        </div>
        <div class="row column">
          <label class="lab">额外群聊提示词（可选，≤1000 字）</label>
          <textarea v-model="draft.group.extraPrompt" class="form-textarea" rows="3" maxlength="1000" />
        </div>
        <p class="hint">群聊称呼只用群昵称/「你」；过滤、语音上限、记忆隔离只对群聊生效，私聊不受影响。</p>
      </div>

      <div class="group">
        <h4>记忆</h4>
        <label class="check-row">
          <input v-model="draft.memory.autoEnabled" type="checkbox" />
          <span>每天 23:00 自动写日记</span>
        </label>
        <label class="check-row disabled">
          <input v-model="draft.memory.confirmImportant" type="checkbox" disabled />
          <span>重要约定在写入前问她一句（尚未接线，暂不生效）</span>
        </label>
      </div>

      <div class="group">
        <h4>桌宠</h4>
        <p class="hint">桌宠暂时下线（形象重做后再放出），下面选项先保留，恢复后生效。</p>
        <label class="check-row disabled">
          <input v-model="draft.pet.visible" type="checkbox" disabled />
          <span>显示桌宠</span>
        </label>
        <div class="row">
          <label class="lab">尺寸</label>
          <select v-model="draft.pet.size" class="form-select" disabled>
            <option value="small">小</option>
            <option value="medium">中</option>
            <option value="large">大</option>
          </select>
          <label class="check-row inline disabled">
            <input v-model="draft.pet.clickThrough" type="checkbox" disabled />
            <span>点击穿透</span>
          </label>
        </div>
      </div>

      <div class="group">
        <h4>关系</h4>
        <div class="row">
          <label class="lab">关系模式</label>
          <select v-model="draft.relationship.mode" class="form-select">
            <option value="companion">朋友（搭子）</option>
            <option value="sister">妹妹</option>
            <option value="lover">恋人未满</option>
          </select>
        </div>
        <div class="row">
          <label class="lab">你的名字（可选）</label>
          <input v-model="draft.relationship.userName" class="form-input" maxlength="40" placeholder="留空 = 不称呼名字" />
        </div>
        <div class="row">
          <label class="lab">她怎么称呼你</label>
          <input v-model="draft.relationship.address" class="form-input" maxlength="40" placeholder="默认「你」" />
        </div>
        <div class="row">
          <label class="lab">不能叫的称呼</label>
          <input v-model="tabooText" class="form-input" maxlength="200" placeholder="逗号分隔；留空 = 不限制" />
        </div>
      </div>

      <p class="hint">
        安全行为（诚实承认 AI、危机话题转求助）始终开启，不提供关闭入口。
      </p>
    </div>

    <div class="row actions">
      <button class="btn btn-primary" :disabled="saving || !enabled || !settings" @click="save">
        保存设置
      </button>
      <span v-if="dirty" class="hint">有未保存的修改</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { CharacterSettings, CharacterSettingsPatch } from '../../electron/main/character/types'

const props = defineProps<{
  settings: CharacterSettings | null
  enabled: boolean
}>()

const emit = defineEmits<{
  save: [patch: CharacterSettingsPatch]
}>()

interface DraftSettings {
  proactive: {
    enabled: boolean
    silenceDays: number
    dailyCap: number
    intervalMode: 'fixed' | 'range'
    intervalMinutes: number
    intervalMinMinutes: number
    intervalMaxMinutes: number
    quietFrom: string
    quietTo: string
    contentTypes: string[]
    channel: 'external' | 'app'
  }
  voice: { enabled: boolean; requestAllowed: boolean; dailyCap: number; sttEnabled: boolean }
  group: {
    replyEnabled: boolean
    requireMention: boolean
    voiceEnabled: boolean
    dailyVoiceCap: number
    words: { enabled: boolean; action: 'replace' | 'block'; replaceWith: string; list: string[] }
    memoryIsolated: boolean
    historyLimit: number
    extraPrompt: string
  }
  memory: { autoEnabled: boolean; confirmImportant: boolean }
  pet: { visible: boolean; size: 'small' | 'medium' | 'large'; clickThrough: boolean }
  relationship: { mode: 'companion' | 'sister' | 'lover'; userName: string; address: string }
}

const CONTENT_TYPES = [
  { value: 'morning', label: '早安' },
  { value: 'thinkingOfYou', label: '想你了' },
  { value: 'herDay', label: '她的一天' },
  { value: 'anniversary', label: '纪念日' }
] as const

function emptyDraft(): DraftSettings {
  return {
    proactive: {
      enabled: false,
      silenceDays: 3,
      dailyCap: 2,
      intervalMode: 'fixed',
      intervalMinutes: 60,
      intervalMinMinutes: 30,
      intervalMaxMinutes: 60,
      quietFrom: '23:30',
      quietTo: '08:00',
      contentTypes: CONTENT_TYPES.map((x) => x.value),
      channel: 'external'
    },
    voice: { enabled: true, requestAllowed: true, dailyCap: 10, sttEnabled: true },
    group: {
      replyEnabled: true,
      requireMention: true,
      voiceEnabled: false,
      dailyVoiceCap: 2,
      words: {
        enabled: true,
        action: 'replace',
        replaceWith: '你',
        list: ['宝宝', '宝贝', '亲爱的', '老公', '老婆', '主人']
      },
      memoryIsolated: true,
      historyLimit: 20,
      extraPrompt: ''
    },
    memory: { autoEnabled: true, confirmImportant: true },
    pet: { visible: true, size: 'medium', clickThrough: false },
    relationship: { mode: 'companion', userName: '', address: '你' }
  }
}

const draft = reactive<DraftSettings>(emptyDraft())
const tabooText = ref('')
/** 亲密词用文本框编辑（逗号/换行分隔），保存时拆成数组 */
const wordsText = ref('')
const saving = ref(false)
/** 用户改过任何字段 → 不回填，避免 onEvent→refresh 静默覆盖未保存编辑 */
const dirty = ref(false)

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 旧数据没有 4.5 新字段时补默认值（GroupSettings v1 迁移在宿主侧也会做一次） */
function normalizeGroupDraft(raw: DraftSettings['group'] | undefined): DraftSettings['group'] {
  const d = emptyDraft().group
  if (!raw) return d
  return {
    replyEnabled: raw.replyEnabled ?? d.replyEnabled,
    requireMention: raw.requireMention ?? d.requireMention,
    voiceEnabled: raw.voiceEnabled ?? d.voiceEnabled,
    dailyVoiceCap: clampNumber(raw.dailyVoiceCap ?? d.dailyVoiceCap, 0, 20),
    words: {
      enabled: raw.words?.enabled ?? d.words.enabled,
      action: raw.words?.action === 'block' ? 'block' : 'replace',
      replaceWith: (raw.words?.replaceWith ?? d.words.replaceWith).trim() || '你',
      list: [...(raw.words?.list ?? d.words.list)].slice(0, 100)
    },
    memoryIsolated: raw.memoryIsolated ?? d.memoryIsolated,
    historyLimit: clampNumber(raw.historyLimit ?? d.historyLimit, 0, 50),
    extraPrompt: (raw.extraPrompt ?? d.extraPrompt).slice(0, 1000)
  }
}

function parseWords(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[，,\n]/)) {
    const word = piece.trim().slice(0, 20)
    if (word && !out.includes(word)) out.push(word)
    if (out.length >= 100) break
  }
  return out
}

function applySettings(next: CharacterSettings | null): void {
  const base = emptyDraft()
  if (next) {
    base.proactive = {
      enabled: next.proactive.enabled,
      silenceDays: next.proactive.silenceDays,
      dailyCap: next.proactive.dailyCap,
      intervalMode: next.proactive.intervalMode,
      intervalMinutes: next.proactive.intervalMinutes,
      intervalMinMinutes: next.proactive.intervalMinMinutes,
      intervalMaxMinutes: next.proactive.intervalMaxMinutes,
      quietFrom: next.proactive.quietFrom,
      quietTo: next.proactive.quietTo,
      contentTypes: [...next.proactive.contentTypes],
      channel: next.proactive.channel
    }
    base.voice = { ...next.voice }
    base.group = normalizeGroupDraft(next.group)
    base.memory = { ...next.memory }
    base.pet = { ...next.pet }
    base.relationship = {
      mode: next.relationship.mode,
      userName: next.relationship.userName,
      address: next.relationship.address
    }
    tabooText.value = (next.relationship.taboo ?? []).join('，')
  }
  wordsText.value = base.group.words.list.join('，')
  Object.assign(draft, base)
}

watch(
  () => props.settings,
  (next) => {
    if (dirty.value) return
    applySettings(next)
  },
  { immediate: true }
)

function save(): void {
  const taboo = tabooText.value
    .split(/[，,]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 30)
  emit('save', {
    proactive: {
      enabled: draft.proactive.enabled,
      silenceDays: draft.proactive.silenceDays,
      dailyCap: draft.proactive.dailyCap,
      intervalMode: draft.proactive.intervalMode,
      intervalMinutes: draft.proactive.intervalMinutes,
      intervalMinMinutes: draft.proactive.intervalMinMinutes,
      intervalMaxMinutes: draft.proactive.intervalMaxMinutes,
      quietFrom: draft.proactive.quietFrom,
      quietTo: draft.proactive.quietTo,
      channel: draft.proactive.channel
    },
    voice: {
      enabled: draft.voice.enabled,
      requestAllowed: draft.voice.requestAllowed,
      dailyCap: draft.voice.dailyCap
    },
    group: {
      replyEnabled: draft.group.replyEnabled,
      requireMention: draft.group.requireMention,
      voiceEnabled: draft.group.voiceEnabled,
      dailyVoiceCap: draft.group.dailyVoiceCap,
      words: {
        enabled: draft.group.words.enabled,
        action: draft.group.words.action,
        replaceWith: draft.group.words.replaceWith.trim() || '你',
        list: parseWords(wordsText.value)
      },
      memoryIsolated: draft.group.memoryIsolated,
      historyLimit: draft.group.historyLimit,
      extraPrompt: draft.group.extraPrompt.trim()
    },
    memory: { autoEnabled: draft.memory.autoEnabled },
    relationship: {
      mode: draft.relationship.mode,
      userName: draft.relationship.userName,
      // merge 只在非空时应用 address：空值按「恢复默认」发「你」
      address: draft.relationship.address.trim() || '你',
      taboo
    }
  })
}

/** 父组件保存成功后调用：复位 dirty 并用最新 props 回填 */
function markSaved(): void {
  dirty.value = false
  applySettings(props.settings)
}

function setSaving(next: boolean): void {
  saving.value = next
}

defineExpose({ setSaving, markSaved, dirty })
</script>

<style scoped>
/* 表单控件吃全局 .form-input/.form-select/.form-textarea；这里只留设置页布局节奏 */
.settings h3 {
  margin: 0 0 var(--space-2);
}
.settings .hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.settings h3 + .hint,
.settings h4 + .hint,
.settings .row .hint {
  margin-top: 0;
}
.settings-body {
  margin-top: var(--space-4);
}
.settings .group {
  border-top: 1px solid var(--border-muted);
  padding-top: var(--space-3);
  margin-top: var(--space-3);
}
.settings .group:first-of-type {
  border-top: 0;
  margin-top: 0;
}
.settings h4 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.settings .group > h4 + .check-row,
.settings .group > h4 + .row {
  margin-top: 0;
}
.settings .row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
  flex-wrap: wrap;
}
.settings .row.wrap {
  align-items: flex-start;
}
.settings .lab {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  min-width: 0;
}
.settings .check-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-primary);
}
.settings .check-row.inline {
  margin-top: 0;
  margin-right: var(--space-3);
}
.settings .check-row.disabled {
  opacity: 0.65;
  cursor: default;
}
.settings .row.column {
  align-items: stretch;
  flex-direction: column;
  gap: var(--space-2);
}
.settings .row .short {
  width: 96px;
}
/* 全局 form-textarea min-height 96px，本页紧凑场景压到 56px */
.settings textarea {
  min-height: 56px;
  font-size: var(--text-xs);
}
.settings .actions {
  margin-top: var(--space-4);
}
.settings code {
  font-size: var(--text-xs);
}
</style>
