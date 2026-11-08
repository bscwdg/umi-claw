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
          <input v-model.number="draft.proactive.silenceDays" type="number" min="0" max="14" />
          <label class="lab">每天上限</label>
          <input v-model.number="draft.proactive.dailyCap" type="number" min="0" max="60" />
        </div>
        <div class="row">
          <label class="lab">发送间隔</label>
          <select v-model="draft.proactive.intervalMode">
            <option value="fixed">固定间隔</option>
            <option value="range">随机区间</option>
          </select>
          <template v-if="draft.proactive.intervalMode === 'fixed'">
            <label class="lab">间隔（分钟）</label>
            <input
              v-model.number="draft.proactive.intervalMinutes"
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
              type="number"
              min="1"
              max="720"
              list="proactive-range-presets"
            />
            <label class="lab">最长（分钟）</label>
            <input
              v-model.number="draft.proactive.intervalMaxMinutes"
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
          <input v-model="draft.proactive.quietFrom" type="time" />
          <label class="lab">到</label>
          <input v-model="draft.proactive.quietTo" type="time" />
        </div>
        <div class="row">
          <label class="lab">渠道</label>
          <select v-model="draft.proactive.channel">
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
          <input v-model.number="draft.voice.dailyCap" type="number" min="0" max="100" />
        </div>
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
          <select v-model="draft.pet.size" disabled>
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
          <select v-model="draft.relationship.mode">
            <option value="companion">朋友（搭子）</option>
            <option value="sister">妹妹</option>
            <option value="lover">恋人未满</option>
          </select>
        </div>
        <div class="row">
          <label class="lab">你的名字（可选）</label>
          <input v-model="draft.relationship.userName" maxlength="40" placeholder="留空 = 不称呼名字" />
        </div>
        <div class="row">
          <label class="lab">她怎么称呼你</label>
          <input v-model="draft.relationship.address" maxlength="40" placeholder="默认「你」" />
        </div>
        <div class="row">
          <label class="lab">不能叫的称呼</label>
          <input v-model="tabooText" maxlength="200" placeholder="逗号分隔；留空 = 不限制" />
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
    memory: { autoEnabled: true, confirmImportant: true },
    pet: { visible: true, size: 'medium', clickThrough: false },
    relationship: { mode: 'companion', userName: '', address: '你' }
  }
}

const draft = reactive<DraftSettings>(emptyDraft())
const tabooText = ref('')
const saving = ref(false)
/** 用户改过任何字段 → 不回填，避免 onEvent→refresh 静默覆盖未保存编辑 */
const dirty = ref(false)

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
    base.memory = { ...next.memory }
    base.pet = { ...next.pet }
    base.relationship = {
      mode: next.relationship.mode,
      userName: next.relationship.userName,
      address: next.relationship.address
    }
    tabooText.value = (next.relationship.taboo ?? []).join('，')
  }
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
.settings .group {
  border-top: 1px solid var(--border-muted);
  padding-top: 12px;
  margin-top: 12px;
}
.settings .group:first-of-type {
  border-top: 0;
  margin-top: 0;
}
.settings h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-secondary);
}
.settings .row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.settings .row.wrap {
  align-items: flex-start;
}
.settings .lab {
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 0;
}
.settings .check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-primary);
}
.settings .check-row.inline {
  margin-top: 0;
  margin-right: 12px;
}
.settings .check-row.disabled {
  opacity: 0.65;
  cursor: default;
}
.settings .actions {
  margin-top: 16px;
}
.settings code {
  font-size: 12px;
}
</style>
