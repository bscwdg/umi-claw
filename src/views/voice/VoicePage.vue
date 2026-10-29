<template>
  <div class="voice-page">
    <header class="page-head">
      <div>
        <h1>🔊 语音设置</h1>
        <p class="page-sub">预设音色与授权克隆音色共用一套本地缓存、预算和 Key 管理。</p>
      </div>
      <span class="state-pill" :class="{ ready: settings?.hasTtsKey }">
        {{ settings?.hasTtsKey ? '预设 TTS 已配置' : '预设 TTS 未配置' }}
      </span>
      <button v-if="currentJobId" class="btn btn-sm" @click="cancelSpeak">
        取消合成 {{ progressDone }}/{{ progressTotal }}
      </button>
    </header>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <div v-else-if="notice" class="notice">{{ notice }}</div>

    <section v-if="activeTab === 'overview'" class="tab-panel">
      <div class="stats-grid">
        <article class="card stat-card">
          <span class="stat-label">Agent Plan TTS Key</span>
          <strong>{{ settings?.hasTtsKey ? settings.ttsKeyTail : '未配置' }}</strong>
          <span class="stat-hint">负责精选音色合成</span>
        </article>
        <article class="card stat-card">
          <span class="stat-label">语音服务 Key</span>
          <strong>{{ settings?.hasCloneKey ? settings.cloneKeyTail : '未配置' }}</strong>
          <span class="stat-hint">负责克隆管理和克隆音色合成</span>
        </article>
        <article class="card stat-card">
          <span class="stat-label">今日字符 / 请求</span>
          <strong>{{ budget?.chars ?? 0 }} / {{ budget?.requests ?? 0 }}</strong>
          <span class="stat-hint">
            {{ settings?.dailyCharLimit ? `上限 ${settings.dailyCharLimit}` : '当前不限字符' }}
          </span>
        </article>
        <article class="card stat-card">
          <span class="stat-label">默认音色</span>
          <strong>{{ selectedVoice?.name ?? '未加载' }}</strong>
          <span class="stat-hint">{{ selectedVoice?.scene ?? '' }}</span>
        </article>
      </div>

      <article class="card">
        <div class="section-head">
          <div>
            <h2>快捷试听</h2>
            <p>试听会使用默认音色，并计入字符统计。</p>
          </div>
          <button class="btn btn-primary" :disabled="busy || !settings?.hasTtsKey" @click="previewText">
            {{ busy ? '合成中…' : '播放试听' }}
          </button>
        </div>
        <textarea
          v-model="quickText"
          class="form-input text-area"
          maxlength="800"
          placeholder="输入要朗读的短句"
        />
      </article>

      <article class="card">
        <div class="section-head">
          <div>
            <h2>调用边界</h2>
            <p>主进程按音色类型自动选路，页面不直接接触 Key。</p>
          </div>
        </div>
        <div class="route-grid">
          <div>
            <span>精选音色</span>
            <code>/api/v3/plan/tts/unidirectional</code>
            <small>Agent Plan Key · seed-tts-2.0</small>
          </div>
          <div>
            <span>克隆音色</span>
            <code>/api/v3/tts/unidirectional</code>
            <small>语音服务 Key · seed-icl-2.0</small>
          </div>
        </div>
      </article>
    </section>

    <section v-else-if="activeTab === 'keys'" class="tab-panel">
      <div v-if="settings && !settings.encryptionAvailable" class="notice notice-error">
        系统安全存储不可用，API Key 无法持久化。请检查系统凭据服务后重试。
      </div>

      <article class="card key-card">
        <div class="section-head">
          <div>
            <h2>Agent Plan TTS Key</h2>
            <p>用于精选音色，走 Agent Plan 语音接口。</p>
          </div>
          <span class="key-state">{{ settings?.hasTtsKey ? settings.ttsKeyTail : '未保存' }}</span>
        </div>
        <div class="key-row">
          <input
            v-model="ttsKeyInput"
            class="form-input"
            type="password"
            autocomplete="off"
            placeholder="输入后保存，明文不会回传到页面"
          />
          <button class="btn" :disabled="busy || !ttsKeyInput.trim()" @click="saveKey('tts')">保存</button>
          <button class="btn" :disabled="busy || !settings?.hasTtsKey" @click="testKey('tts')">测试</button>
          <button class="btn btn-danger" :disabled="busy || !settings?.hasTtsKey" @click="clearKey('tts')">清除</button>
        </div>
      </article>

      <article class="card key-card">
        <div class="section-head">
          <div>
            <h2>语音服务 Key</h2>
            <p>用于克隆管理和克隆音色合成，不能复用 Agent Plan Key。</p>
          </div>
          <span class="key-state">{{ settings?.hasCloneKey ? settings.cloneKeyTail : '未保存' }}</span>
        </div>
        <div class="key-row">
          <input
            v-model="cloneKeyInput"
            class="form-input"
            type="password"
            autocomplete="off"
            placeholder="输入语音控制台 API Key"
          />
          <button class="btn" :disabled="busy || !cloneKeyInput.trim()" @click="saveKey('clone')">保存</button>
          <button class="btn" :disabled="busy || !settings?.hasCloneKey" @click="testKey('clone')">测试</button>
          <button class="btn btn-danger" :disabled="busy || !settings?.hasCloneKey" @click="clearKey('clone')">清除</button>
        </div>
      </article>

      <article class="card">
        <h2>固定接口</h2>
        <dl class="endpoint-list">
          <div><dt>预设 TTS</dt><dd>{{ settings?.ttsEndpoint }}</dd></div>
          <div><dt>克隆音色合成</dt><dd>{{ settings?.cloneEndpoint }}</dd></div>
          <div><dt>预设 Resource</dt><dd>{{ settings?.ttsResourceId }}</dd></div>
          <div><dt>克隆 Resource</dt><dd>{{ settings?.cloneResourceId }}</dd></div>
        </dl>
      </article>
    </section>

    <section v-else-if="activeTab === 'voices'" class="tab-panel">
      <article class="card">
        <div class="section-head">
          <div>
            <h2>精选音色</h2>
            <p>只展示随应用归档的精选子集，不拉取供应商全量音色。</p>
          </div>
          <button class="btn btn-primary" :disabled="busy || !settings?.hasTtsKey" @click="previewText">
            试听当前音色
          </button>
        </div>

        <div class="voice-form">
          <div class="form-group">
            <label class="form-label">音色</label>
            <select v-model="voiceForm.defaultSpeaker" class="form-input">
              <option
                v-if="voiceForm.defaultSpeaker && !(catalog?.voices ?? []).some(v => v.voiceType === voiceForm.defaultSpeaker)"
                :value="voiceForm.defaultSpeaker"
              >
                克隆音色 · {{ cloneRecords.find(r => r.speakerId === voiceForm.defaultSpeaker)?.displayName || voiceForm.defaultSpeaker }}
              </option>
              <option v-for="voice in catalog?.voices ?? []" :key="voice.voiceType" :value="voice.voiceType">
                {{ voice.name }} · {{ voice.scene }}
              </option>
            </select>
            <p class="field-hint">{{ selectedVoice?.languageSummary }}</p>
          </div>
          <div class="form-group">
            <label class="form-label">语速 {{ voiceForm.speedRatio.toFixed(2) }}</label>
            <input v-model.number="voiceForm.speedRatio" class="range" type="range" min="0.2" max="3" step="0.05" />
          </div>
          <div class="form-group">
            <label class="form-label">情绪（可选）</label>
            <input v-model="voiceForm.emotion" class="form-input" maxlength="64" placeholder="留空使用音色默认情绪" />
          </div>
          <div class="form-group">
            <label class="form-label">自动朗读</label>
            <select v-model="voiceForm.autoSpeak" class="form-input">
              <option value="off">关闭</option>
              <option value="tagged">仅标记事件</option>
              <option value="always">所有短提示</option>
            </select>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-primary" :disabled="busy" @click="saveVoiceSettings">保存语音设置</button>
        </div>
      </article>

      <article class="card">
        <h2>试听文本</h2>
        <textarea v-model="previewInput" class="form-input text-area" maxlength="800" />
      </article>

      <article class="card">
        <div class="section-head">
          <div>
            <h2>克隆音色</h2>
            <p>样本与 Key 只在主进程处理；删除只清理本地记录，不承诺删除供应商侧音色。</p>
          </div>
          <button class="btn btn-primary" :disabled="busy || !settings?.hasCloneKey" @click="openCloneWizard">
            新建克隆音色
          </button>
        </div>

        <div v-if="cloneRecords.length" class="clone-list">
          <div v-for="record in cloneRecords" :key="record.speakerId" class="clone-row">
            <div class="clone-main">
              <div class="clone-title">
                <strong>{{ record.displayName }}</strong>
                <span class="clone-status" :class="record.status">{{ cloneStatusLabel(record) }}</span>
              </div>
              <span class="clone-meta">
                {{ languageLabel(record.language) }} · {{ record.speakerId }}
              </span>
              <span class="clone-meta">
                {{ record.activated ? '已转正，可正常朗读' : cloneExpiryText(record) }}
              </span>
              <span v-if="record.lastError" class="clone-error">{{ record.lastError }}</span>
            </div>
            <div class="clone-actions">
              <button
                v-if="record.demos.length"
                class="btn btn-sm"
                :disabled="busy"
                @click="playCloneDemo(record)"
              >
                试听样本
              </button>
              <button
                v-if="record.activated"
                class="btn btn-sm"
                :disabled="busy"
                @click="previewClone(record)"
              >
                朗读测试
              </button>
              <button
                v-if="record.activated && settings?.defaultSpeaker !== record.speakerId"
                class="btn btn-sm"
                :disabled="busy"
                @click="setCloneAsDefault(record)"
              >
                设为默认
              </button>
              <button
                v-else-if="record.status === 'success' && !isCloneExpired(record)"
                class="btn btn-sm btn-primary"
                :disabled="busy"
                @click="activateClone(record)"
              >
                确认并转正
              </button>
              <button class="btn btn-sm" :disabled="busy" @click="refreshClone(record)">刷新</button>
              <button class="btn btn-sm btn-danger" :disabled="busy" @click="deleteClone(record)">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="empty-clone">
          还没有克隆音色。准备 15–30 秒清晰、单人、无背景音乐的样本后开始。
        </div>
      </article>
    </section>

    <section v-else class="tab-panel">
      <div class="stats-grid">
        <article class="card stat-card">
          <span class="stat-label">今日字符</span>
          <strong>{{ budget?.chars ?? 0 }}</strong>
          <span class="stat-hint">上限 {{ settings?.dailyCharLimit || '不限' }}</span>
        </article>
        <article class="card stat-card">
          <span class="stat-label">请求 / 失败</span>
          <strong>{{ budget?.requests ?? 0 }} / {{ budget?.failures ?? 0 }}</strong>
          <span class="stat-hint">失败请求不减少已用字符</span>
        </article>
        <article class="card stat-card">
          <span class="stat-label">缓存上限</span>
          <strong>{{ settings?.cacheLimitMB ?? 0 }} MB</strong>
          <span class="stat-hint">按最近使用时间清理</span>
        </article>
      </div>

      <article class="card">
        <div class="section-head">
          <div>
            <h2>每日字符预算</h2>
            <p>0 表示只统计、不限制。超过上限时语音请求会被主进程拒绝。</p>
          </div>
          <button class="btn btn-primary" :disabled="busy" @click="saveBudget">保存</button>
        </div>
        <div class="budget-row">
          <input v-model.number="budgetLimit" class="form-input" type="number" min="0" step="100" />
          <span>字符 / 日</span>
        </div>
      </article>

      <article class="card">
        <div class="section-head">
          <div>
            <h2>音频缓存</h2>
            <p>清理后，相同文本下次需要重新调用供应商合成。</p>
          </div>
          <button class="btn btn-danger" :disabled="busy" @click="clearCache">清理缓存</button>
        </div>
      </article>
    </section>

    <Teleport to="body">
      <div v-if="cloneWizardOpen" class="modal-mask" @click.self="closeCloneWizard">
        <div class="clone-modal">
          <div class="modal-head">
            <div>
              <h2>新建克隆音色</h2>
              <p>训练成功后先试听；首次正式合成会收取槽位费。</p>
            </div>
            <button class="btn btn-sm" :disabled="cloneBusy" @click="closeCloneWizard">关闭</button>
          </div>

          <div class="clone-form">
            <div class="form-group">
              <label class="form-label">音色名称</label>
              <input v-model="cloneForm.displayName" class="form-input" maxlength="40" placeholder="例如：我的工作声线" />
            </div>
            <div class="form-group">
              <label class="form-label">样本语种</label>
              <select v-model.number="cloneForm.language" class="form-input">
                <option :value="0">中文</option>
                <option :value="1">英文</option>
                <option :value="2">日语</option>
                <option :value="3">西班牙语</option>
                <option :value="4">印尼语</option>
                <option :value="5">葡萄牙语</option>
                <option :value="6">德语</option>
                <option :value="7">法语</option>
                <option :value="8">韩语</option>
              </select>
            </div>
            <div class="form-group form-span">
              <label class="form-label">样本对应文字（可选，越准确越稳）</label>
              <textarea v-model="cloneForm.text" class="form-input text-area" maxlength="2000" />
            </div>
          </div>

          <div class="sample-box">
            <div>
              <strong>{{ cloneSample ? cloneSample.fileName : '尚未选择样本' }}</strong>
              <span v-if="cloneSample">{{ formatBytes(cloneSample.sizeBytes) }} · {{ cloneSample.format.toUpperCase() }}</span>
            </div>
            <button class="btn" :disabled="cloneBusy" @click="pickCloneSample">选择音频</button>
          </div>
          <div v-if="cloneValidation?.warnings.length" class="notice">
            <div v-for="warning in cloneValidation.warnings" :key="warning">{{ warning }}</div>
          </div>

          <label class="consent-row">
            <input v-model="cloneForm.consent" type="checkbox" />
            <span>我确认样本为本人声音，或已取得声音权利人的明确授权，仅用于本次音色复刻。</span>
          </label>

          <div v-if="cloneWizardRecord" class="wizard-status">
            <strong>{{ cloneStatusLabel(cloneWizardRecord) }}</strong>
            <span>{{ cloneWizardRecord.speakerId }}</span>
            <span v-if="cloneWizardRecord.lastError" class="clone-error">{{ cloneWizardRecord.lastError }}</span>
            <span v-else-if="cloneWizardRecord.status === 'success'">
              已训练成功。请先试听；确认效果满意后再转正。
            </span>
          </div>

          <div class="modal-foot">
            <button
              class="btn btn-primary"
              :disabled="cloneBusy || !cloneSample || !cloneForm.consent || !cloneForm.displayName.trim() || !!cloneWizardRecord"
              @click="startCloneTraining"
            >
              {{ cloneBusy ? '提交中…' : cloneWizardRecord?.status === 'training' ? '训练中…' : '开始训练' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  VoiceCatalogFile,
  VoiceCatalogVoice,
  VoiceCloneRecord,
  VoiceCloneSample,
  VoiceCloneValidation,
  VoiceKeyKind,
  VoiceSettingsView,
  VoiceUsageDay
} from '../../../electron/main/fish/voice/core/types'

type TabId = 'overview' | 'keys' | 'voices' | 'budget'

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'keys', label: '供应商与密钥' },
  { id: 'voices', label: '音色' },
  { id: 'budget', label: '预算与缓存' }
]

const api = window.api.fish.voice
const activeTab = ref<TabId>('overview')
const settings = ref<VoiceSettingsView | null>(null)
const catalog = ref<VoiceCatalogFile | null>(null)
const budget = ref<VoiceUsageDay | null>(null)
const cloneRecords = ref<VoiceCloneRecord[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const ttsKeyInput = ref('')
const cloneKeyInput = ref('')
const quickText = ref('你好，我是大肥鱼。今天也一起把事情推进一点。')
const previewInput = ref('你好，我是大肥鱼。今天也一起把事情推进一点。')
const budgetLimit = ref(0)
const cloneWizardOpen = ref(false)
const cloneBusy = ref(false)
const cloneSample = ref<VoiceCloneSample | null>(null)
const cloneValidation = ref<VoiceCloneValidation | null>(null)
const cloneWizardRecord = ref<VoiceCloneRecord | null>(null)
const cloneForm = reactive({
  displayName: '',
  language: 0,
  text: '',
  consent: false
})
let currentAudio: HTMLAudioElement | null = null
let objectUrl = ''
let clonePollTimer: ReturnType<typeof setTimeout> | null = null
const currentJobId = ref('')
const progressDone = ref(0)
const progressTotal = ref(0)
let progressCleanup: (() => void) | null = null

const voiceForm = reactive({
  defaultSpeaker: '',
  speedRatio: 1,
  emotion: '',
  autoSpeak: 'off' as 'off' | 'tagged' | 'always'
})

const selectedVoice = computed<VoiceCatalogVoice | undefined>(() => {
  const id = voiceForm.defaultSpeaker || settings.value?.defaultSpeaker
  return catalog.value?.voices.find((voice) => voice.voiceType === id)
})

function showError(e: unknown): void {
  notice.value = ''
  error.value = e instanceof Error ? e.message : String(e)
}

function showNotice(message: string): void {
  error.value = ''
  notice.value = message
}

async function refreshSettings(): Promise<void> {
  const next = await api.settings.get()
  settings.value = next
  voiceForm.defaultSpeaker = next.defaultSpeaker
  voiceForm.speedRatio = next.speedRatio
  voiceForm.emotion = next.emotion
  voiceForm.autoSpeak = next.autoSpeak
  budgetLimit.value = next.dailyCharLimit
}

async function refreshBudget(): Promise<void> {
  budget.value = await api.budget.get()
}

async function refreshClones(): Promise<void> {
  cloneRecords.value = await api.clone.list()
  if (cloneWizardRecord.value?.status === 'training') {
    const updated = cloneRecords.value.find(
      (record) => record.speakerId === cloneWizardRecord.value?.speakerId
    )
    if (updated) cloneWizardRecord.value = updated
  }
  const hasTraining = cloneRecords.value.some((record) => record.status === 'training')
  if (hasTraining && !clonePollTimer) {
    clonePollTimer = setTimeout(() => {
      clonePollTimer = null
      void refreshClones().catch(() => undefined)
    }, 3000)
  }
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [nextSettings, nextCatalog, nextBudget, nextClones] = await Promise.all([
      api.settings.get(),
      api.catalog.get(),
      api.budget.get(),
      api.clone.list()
    ])
    settings.value = nextSettings
    catalog.value = nextCatalog
    budget.value = nextBudget
    cloneRecords.value = nextClones
    voiceForm.defaultSpeaker = nextSettings.defaultSpeaker
    voiceForm.speedRatio = nextSettings.speedRatio
    voiceForm.emotion = nextSettings.emotion
    voiceForm.autoSpeak = nextSettings.autoSpeak
    budgetLimit.value = nextSettings.dailyCharLimit
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function saveKey(kind: VoiceKeyKind): Promise<void> {
  const value = kind === 'tts' ? ttsKeyInput.value : cloneKeyInput.value
  busy.value = true
  try {
    settings.value = await api.key.set(kind, value)
    if (kind === 'tts') ttsKeyInput.value = ''
    else cloneKeyInput.value = ''
    showNotice(kind === 'tts' ? 'TTS Key 已安全保存' : '语音服务 Key 已安全保存')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function clearKey(kind: VoiceKeyKind): Promise<void> {
  busy.value = true
  try {
    settings.value = await api.key.clear(kind)
    showNotice(kind === 'tts' ? 'TTS Key 已清除' : '语音服务 Key 已清除')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

function releaseAudio(): void {
  currentAudio?.pause()
  currentAudio = null
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}

async function playPayload(payload: { mime: string; bytes: Uint8Array }, mime?: string): Promise<void> {
  releaseAudio()
  const bytes = new Uint8Array(payload.bytes)
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime || payload.mime }))
  currentAudio = new Audio(objectUrl)
  currentAudio.onended = releaseAudio
  await currentAudio.play()
}

async function playAudio(audioId: string, mime: string): Promise<void> {
  await playPayload(await api.audio(audioId), mime)
}

async function testKey(kind: VoiceKeyKind): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const result = await api.test(kind)
    if (result.audio) await playAudio(result.audio.audioId, result.audio.mime)
    await refreshBudget()
    showNotice(result.message)
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function previewText(): Promise<void> {
  const text = activeTab.value === 'overview' ? quickText.value : previewInput.value
  const jobId = crypto.randomUUID()
  currentJobId.value = jobId
  progressDone.value = 0
  progressTotal.value = 0
  busy.value = true
  error.value = ''
  try {
    const result = await api.speak({
      text,
      jobId,
      options: {
        speaker: voiceForm.defaultSpeaker || settings.value?.defaultSpeaker,
        speedRatio: voiceForm.speedRatio,
        emotion: voiceForm.emotion
      }
    })
    await playAudio(result.audioId, result.mime)
    await refreshBudget()
    showNotice(result.cached ? '已命中本地缓存' : `已合成 ${result.chars} 字`)
  } catch (e) {
    showError(e)
  } finally {
    currentJobId.value = ''
    busy.value = false
  }
}

async function saveVoiceSettings(): Promise<void> {
  busy.value = true
  try {
    settings.value = await api.settings.set({
      defaultSpeaker: voiceForm.defaultSpeaker,
      speedRatio: voiceForm.speedRatio,
      emotion: voiceForm.emotion,
      autoSpeak: voiceForm.autoSpeak
    })
    showNotice('语音设置已保存')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function saveBudget(): Promise<void> {
  busy.value = true
  try {
    settings.value = await api.budget.set(Math.max(0, Number(budgetLimit.value) || 0))
    showNotice('每日字符预算已保存')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function clearCache(): Promise<void> {
  busy.value = true
  try {
    const result = await api.cache.clear()
    showNotice(`已清理 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB 音频缓存`)
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

function openCloneWizard(): void {
  cloneWizardOpen.value = true
  cloneWizardRecord.value = null
  cloneSample.value = null
  cloneValidation.value = null
  cloneForm.displayName = ''
  cloneForm.language = 0
  cloneForm.text = ''
  cloneForm.consent = false
  error.value = ''
  notice.value = ''
}

function closeCloneWizard(): void {
  if (cloneBusy.value) return
  cloneWizardOpen.value = false
  if (clonePollTimer) {
    clearTimeout(clonePollTimer)
    clonePollTimer = null
  }
  void refreshClones().catch(() => undefined)
}

async function pickCloneSample(): Promise<void> {
  cloneBusy.value = true
  try {
    const sample = await api.clone.pickSample()
    if (!sample) return
    cloneSample.value = sample
    cloneValidation.value = await api.clone.validate(sample.token)
  } catch (e) {
    showError(e)
  } finally {
    cloneBusy.value = false
  }
}

async function startCloneTraining(): Promise<void> {
  if (!cloneSample.value) return
  cloneBusy.value = true
  error.value = ''
  try {
    const record = await api.clone.train({
      token: cloneSample.value.token,
      consent: cloneForm.consent,
      displayName: cloneForm.displayName.trim(),
      text: cloneForm.text.trim() || undefined,
      language: cloneForm.language
    })
    cloneWizardRecord.value = record
    await refreshClones()
    if (record.status === 'training') {
      clonePollTimer = setTimeout(() => {
        clonePollTimer = null
        void refreshClones().catch(() => undefined)
      }, 2500)
      showNotice('训练任务已提交，关闭页面后主进程仍会继续轮询')
    } else {
      showNotice('音色训练任务已返回')
    }
  } catch (e) {
    showError(e)
    await refreshClones().catch(() => undefined)
  } finally {
    cloneBusy.value = false
  }
}

const cloneStatusLabels: Record<VoiceCloneRecord['status'], string> = {
  training: '训练中',
  success: '待转正',
  failed: '训练失败',
  active: '已启用',
  not_found: '未找到'
}

function cloneStatusLabel(record: VoiceCloneRecord): string {
  return cloneStatusLabels[record.status] || record.status
}

function languageLabel(language: number): string {
  return ['中文', '英文', '日语', '西班牙语', '印尼语', '葡萄牙语', '德语', '法语', '韩语'][language] || '中文'
}

function cloneExpiryText(record: VoiceCloneRecord): string {
  if (!record.expiresAt || record.activated) return '已转正'
  const days = Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 86_400_000))
  return days > 0 ? `${days} 天后未转正将自动删除` : '已过 7 天保留期，请刷新状态后重新训练'
}

function isCloneExpired(record: VoiceCloneRecord): boolean {
  return !record.activated && !!record.expiresAt && record.expiresAt < Date.now()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function playCloneDemo(record: VoiceCloneRecord): Promise<void> {
  const demo = record.demos.find((item) => item.modelType === 5) || record.demos[0]
  if (!demo) return
  busy.value = true
  try {
    await playPayload(await api.clone.demoAudio(record.speakerId, demo.modelType))
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function setCloneAsDefault(record: VoiceCloneRecord): Promise<void> {
  busy.value = true
  try {
    settings.value = await api.settings.set({ defaultSpeaker: record.speakerId })
    voiceForm.defaultSpeaker = record.speakerId
    showNotice(`已将「${record.displayName}」设为默认音色`)
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function previewClone(record: VoiceCloneRecord): Promise<void> {
  const jobId = crypto.randomUUID()
  currentJobId.value = jobId
  progressDone.value = 0
  progressTotal.value = 0
  busy.value = true
  try {
    const result = await api.speak({
      text: previewInput.value,
      jobId,
      options: { speaker: record.speakerId }
    })
    await playAudio(result.audioId, result.mime)
    await refreshBudget()
    showNotice(result.cached ? '已命中本地缓存' : `已合成 ${result.chars} 字`)
  } catch (e) {
    showError(e)
  } finally {
    currentJobId.value = ''
    busy.value = false
  }
}

async function cancelSpeak(): Promise<void> {
  if (!currentJobId.value) return
  const jobId = currentJobId.value
  try {
    await api.cancel(jobId)
    showNotice('已取消本次合成')
  } catch (e) {
    showError(e)
  } finally {
    currentJobId.value = ''
  }
}

async function activateClone(record: VoiceCloneRecord): Promise<void> {
  if (
    !window.confirm(
      `确认使用「${record.displayName}」进行首次正式合成？\n\n这一步会让供应商将音色转正并收取音色槽位费，之后该 ID 不能再次复刻。`
    )
  ) {
    return
  }
  busy.value = true
  try {
    const result = await api.clone.activate({
      speakerId: record.speakerId,
      confirmSlotFee: true,
      text: previewInput.value
    })
    await playAudio(result.audioId, result.mime)
    await refreshClones()
    await refreshBudget()
    showNotice('克隆音色已转正并启用')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function refreshClone(record: VoiceCloneRecord): Promise<void> {
  busy.value = true
  try {
    await api.clone.status(record.speakerId)
    await refreshClones()
    showNotice('克隆状态已刷新')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function deleteClone(record: VoiceCloneRecord): Promise<void> {
  if (
    !window.confirm(
      `删除本地克隆记录「${record.displayName}」？\n\n只会清理本地样本、试听和启用状态，供应商侧音色可能仍保留。`
    )
  ) {
    return
  }
  busy.value = true
  try {
    await api.clone.remove(record.speakerId)
    await refreshClones()
    showNotice('本地克隆记录已删除')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
  progressCleanup = api.onProgress((event) => {
    if (event.jobId === currentJobId.value) {
      progressDone.value = event.index
      progressTotal.value = event.total
    }
  })
})

onBeforeUnmount(() => {
  releaseAudio()
  if (clonePollTimer) clearTimeout(clonePollTimer)
  progressCleanup?.()
})
</script>

<style scoped>
.voice-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
}

.page-head,
.section-head,
.key-row,
.budget-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.page-head h1,
.section-head h2 {
  margin: 0;
}

.page-sub,
.section-head p,
.field-hint,
.stat-hint {
  margin: 4px 0 0;
  color: var(--text-muted, #7d8590);
  font-size: 13px;
}

.state-pill,
.key-state {
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted, #7d8590);
  font-size: 13px;
  white-space: nowrap;
}

.state-pill.ready {
  color: #5ee29a;
  background: rgba(45, 190, 110, 0.12);
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 10px;
}

.tab {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted, #7d8590);
  cursor: pointer;
  padding: 8px 14px;
}

.tab.active {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}

.tab-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stat-label {
  color: var(--text-muted, #7d8590);
  font-size: 13px;
}

.stat-card strong {
  font-size: 22px;
}

.notice {
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(78, 158, 255, 0.12);
  color: #8ec5ff;
}

.notice-error {
  background: rgba(255, 86, 86, 0.12);
  color: #ff8d8d;
}

.text-area {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  margin-top: 12px;
}

.route-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.route-grid > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
}

.route-grid code,
.endpoint-list dd {
  overflow-wrap: anywhere;
}

.route-grid small {
  color: var(--text-muted, #7d8590);
}

.key-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.key-row {
  justify-content: flex-start;
}

.key-row .form-input {
  flex: 1;
  min-width: 220px;
}

.endpoint-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0 0;
}

.endpoint-list > div {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 12px;
}

.endpoint-list dt {
  color: var(--text-muted, #7d8590);
}

.endpoint-list dd {
  margin: 0;
}

.voice-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.range {
  width: 100%;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.budget-row {
  justify-content: flex-start;
  margin-top: 14px;
}

.budget-row .form-input {
  width: 180px;
}

.clone-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.clone-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
}

.clone-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.clone-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.clone-status {
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 12px;
}

.clone-status.training {
  color: #ffd479;
}

.clone-status.success,
.clone-status.active {
  color: #5ee29a;
}

.clone-status.failed {
  color: #ff8d8d;
}

.clone-meta,
.empty-clone {
  color: var(--text-muted, #7d8590);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.clone-error {
  color: #ff8d8d;
  font-size: 13px;
}

.clone-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.empty-clone {
  margin-top: 14px;
  padding: 24px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  text-align: center;
}

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 6, 14, 0.72);
  backdrop-filter: blur(6px);
}

.clone-modal {
  width: min(720px, 100%);
  max-height: min(86vh, 900px);
  overflow: auto;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  background: #151923;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
}

.modal-head,
.sample-box,
.consent-row,
.wizard-status,
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.modal-head {
  align-items: flex-start;
}

.modal-head h2 {
  margin: 0;
}

.modal-head p {
  margin: 5px 0 0;
  color: var(--text-muted, #7d8590);
  font-size: 13px;
}

.clone-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 18px;
}

.form-span {
  grid-column: 1 / -1;
}

.sample-box,
.consent-row,
.wizard-status {
  justify-content: flex-start;
  margin-top: 14px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
}

.sample-box {
  justify-content: space-between;
}

.sample-box > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.sample-box span {
  color: var(--text-muted, #7d8590);
  font-size: 13px;
}

.consent-row {
  align-items: flex-start;
  line-height: 1.5;
}

.wizard-status {
  flex-direction: column;
  align-items: flex-start;
}

.modal-foot {
  justify-content: flex-end;
  margin-top: 18px;
}

@media (max-width: 720px) {
  .page-head,
  .section-head,
  .key-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .key-row .form-input {
    width: 100%;
    min-width: 0;
  }

  .endpoint-list > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .clone-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .clone-actions {
    justify-content: flex-start;
  }

  .clone-form {
    grid-template-columns: 1fr;
  }
}
</style>
