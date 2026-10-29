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

    <div v-if="error" class="notice notice-error">
      <span>{{ error }}</span>
      <button class="notice-close" type="button" @click="showError('')">×</button>
    </div>
    <div v-else-if="notice" class="notice">
      <span>{{ notice }}</span>
      <button class="notice-close" type="button" @click="dismissNotice">×</button>
    </div>

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
        <div class="section-head">
          <div>
            <h2>接口与模型（高级）</h2>
            <p>升级模型只改 Resource 即可，不必等发版；接口域名固定为火山官方，避免 Key 被发到别处。</p>
          </div>
          <button class="btn btn-sm" :disabled="busy" @click="resetAdvanced">恢复默认</button>
        </div>

        <div class="advanced-form">
          <div class="form-group">
            <label class="form-label">预设 TTS 接口</label>
            <input v-model="advancedForm.ttsEndpoint" class="form-input" :placeholder="VOICE_DEFAULTS.ttsEndpoint" />
          </div>
          <div class="form-group">
            <label class="form-label">预设 Resource</label>
            <input v-model="advancedForm.ttsResourceId" class="form-input" list="presetResourceList" :placeholder="VOICE_DEFAULTS.ttsResourceId" />
            <datalist id="presetResourceList">
              <option v-for="opt in VOICE_RESOURCE_SUGGESTIONS.preset" :key="opt" :value="opt" />
            </datalist>
          </div>
          <div class="form-group">
            <label class="form-label">克隆音色合成接口</label>
            <input v-model="advancedForm.cloneEndpoint" class="form-input" :placeholder="VOICE_DEFAULTS.cloneEndpoint" />
          </div>
          <div class="form-group">
            <label class="form-label">克隆 Resource</label>
            <input v-model="advancedForm.cloneResourceId" class="form-input" list="cloneResourceList" :placeholder="VOICE_DEFAULTS.cloneResourceId" />
            <datalist id="cloneResourceList">
              <option v-for="opt in VOICE_RESOURCE_SUGGESTIONS.cloned" :key="opt" :value="opt" />
            </datalist>
          </div>
          <div class="form-group">
            <label class="form-label">克隆训练接口（voice_clone）</label>
            <input v-model="advancedForm.cloneTrainEndpoint" class="form-input" :placeholder="VOICE_DEFAULTS.cloneTrainEndpoint" />
            <p class="field-hint">上传样本、训练音色。只需 X-Api-Key，不带 Resource。</p>
          </div>
          <div class="form-group">
            <label class="form-label">克隆状态查询接口（get_voice）</label>
            <input v-model="advancedForm.cloneStatusEndpoint" class="form-input" :placeholder="VOICE_DEFAULTS.cloneStatusEndpoint" />
            <p class="field-hint">轮询训练进度、取试听地址。只需 X-Api-Key。</p>
          </div>
        </div>

        <p class="field-hint">
          接口只接受 https + openspeech.bytedance.com 的 /api/v3/ 路径；Resource 是计费与效果版本，切换后试听与合成立即生效。
          改动会与「音色」页的保存互不影响。
        </p>
        <div class="actions">
          <button class="btn btn-primary" :disabled="busy || !advancedDirty" @click="saveAdvanced">保存接口与模型</button>
        </div>
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
              <!-- 当前值不在任何分组里（如已删除的克隆音色）：保留回显，避免下拉显示空白 -->
              <option
                v-if="voiceForm.defaultSpeaker && !selectableSpeakers.includes(voiceForm.defaultSpeaker)"
                :value="voiceForm.defaultSpeaker"
              >
                （不可用）{{ voiceForm.defaultSpeaker }}
              </option>
              <optgroup v-if="activatedClones.length" label="克隆音色">
                <option v-for="clone in activatedClones" :key="clone.speakerId" :value="clone.speakerId">
                  {{ clone.displayName }} · 克隆
                </option>
              </optgroup>
              <optgroup label="预设音色">
                <option v-for="voice in catalog?.voices ?? []" :key="voice.voiceType" :value="voice.voiceType">
                  {{ voice.name }} · {{ voice.scene }}
                </option>
              </optgroup>
            </select>
            <p class="field-hint">{{ selectedVoice?.languageSummary }}</p>
          </div>
          <div class="form-group">
            <label class="form-label">语速 {{ voiceForm.speedRatio.toFixed(2) }}</label>
            <input v-model.number="voiceForm.speedRatio" class="range" type="range" min="0.2" max="3" step="0.05" />
          </div>
          <div class="form-group">
            <label class="form-label">情绪（可选）</label>
            <select
              v-model="voiceForm.emotion"
              class="form-input"
              :disabled="!isPresetSelected"
            >
              <option value="">不指定（用音色默认）</option>
              <optgroup v-for="group in EMOTION_GROUPS" :key="group.label" :label="group.label">
                <option v-for="item in group.options" :key="item.value" :value="item.value">
                  {{ item.label }}（{{ item.value }}）
                </option>
              </optgroup>
            </select>
            <p class="field-hint" v-if="!isPresetSelected">
              克隆音色不支持情绪，只使用你提供的样本自身音色（官方限制）。
            </p>
            <p class="field-hint" v-else>
              官方取值分中/英文两组，仅部分音色支持且范围不同；以语音指令方式下发。
            </p>
          </div>
          <div class="form-group">
            <label class="form-label">自动朗读</label>
            <select v-model="voiceForm.autoSpeak" class="form-input">
              <option value="off">关闭</option>
              <option value="tagged">仅标记事件</option>
              <option value="always">所有短提示</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">对话内语音（OpenClaw）</label>
            <select v-model="voiceForm.conversationTts" class="form-input">
              <option value="off">关闭</option>
              <option value="tagged">仅在回复里带语音标记时</option>
              <option value="inbound">只在你发语音时回语音</option>
              <option value="always">每条回复都发语音</option>
            </select>
            <p class="field-hint">
              走 OpenClaw 自带的语音通道；改完需重启网关生效（密钥只走环境变量，不写进配置文件）。
            </p>
          </div>
          <div class="form-group">
            <label class="form-label">对话内语音通道</label>
            <select v-model="voiceForm.conversationChannel" class="form-input">
              <option value="auto">自动（有语音控制台 Key 优先标准接口）</option>
              <option value="bridge">本地桥接（Agent Plan Key）</option>
              <option value="volcengine">标准接口（语音控制台 Key）</option>
            </select>
            <p class="field-hint">{{ openclawStatusText }}</p>
            <div class="actions">
              <button class="btn btn-sm" :disabled="busy" @click="testOpenClaw">
                测试通道
              </button>
              <button class="btn btn-sm" :disabled="busy" @click="restartOpenClaw">
                重启网关
              </button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">复刻模型（仅克隆音色）</label>
            <select
              v-model="voiceForm.cloneModel"
              class="form-input"
              :disabled="!isCloneSelected"
            >
              <option value="seed-tts-2.0-standard">标准版 seed-tts-2.0-standard</option>
              <option value="seed-tts-2.0-expressive">表现力增强版 seed-tts-2.0-expressive</option>
            </select>
            <p class="field-hint" v-if="isCloneSelected">
              官方只有这两个枚举。选定后不再支持语音指令（context_texts），情感风格由你训练时提供的样本音频决定；
              表现力增强版更适合需要情绪起伏的场景。
            </p>
            <p class="field-hint" v-else>只有选中克隆音色时才可设置（预设音色不传 model）。</p>
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
          <div class="head-actions">
            <button
              class="btn"
              :disabled="busy || !settings?.hasCloneKey || reconcileBusy"
              @click="reconcileClones"
            >
              {{ reconcileBusy ? '核对中…' : '核对远端' }}
            </button>
            <button class="btn btn-primary" :disabled="busy || !settings?.hasCloneKey" @click="openCloneWizard">
              新建克隆音色
            </button>
          </div>
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
              <span
                v-if="reconcileOf(record)"
                class="clone-reconcile"
                :class="reconcileOf(record)!.verdict"
              >
                远端核对：{{ reconcileOf(record)!.message }}
              </span>
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
                <option v-for="lang in VOICE_CLONE_LANGUAGES" :key="lang.value" :value="lang.value">
                  {{ lang.label }}
                </option>
              </select>
            </div>
            <div class="form-group form-span">
              <label class="form-label">样本对应文字（可选，越准确越稳）</label>
              <textarea v-model="cloneForm.text" class="form-input text-area" maxlength="2000" />
            </div>
            <div class="form-group">
              <label class="form-label">试听文本（4–300 字，需与语种一致）</label>
              <input v-model="cloneForm.demoText" class="form-input" maxlength="300" :placeholder="defaultDemoTextPlaceholder" />
            </div>
            <div class="form-group">
              <label class="form-label">音频降噪</label>
              <select v-model="cloneForm.enableAudioDenoise" class="form-input">
                <option :value="false">关闭（样本干净时推荐）</option>
                <option :value="true">开启（样本有底噪时推荐）</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">音量归一化</label>
              <select v-model="cloneForm.disableVolumeNormalization" class="form-input">
                <option :value="false">开启（默认，多音色音量统一）</option>
                <option :value="true">关闭（更贴近样本音量，相似度更高）</option>
              </select>
              <p class="field-hint">
                关闭后合成音量随你的样本走，适合在意音色相似度的场景；日常播报建议保持开启。
              </p>
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
  VoiceReconcileItem,
  VoiceCloneRecord,
  VoiceCloneSample,
  VoiceCloneValidation,
  VoiceKeyKind,
  VoiceSettingsView,
  VoiceUsageDay,
  VoiceOpenClawStatus
} from '../../../electron/main/fish/voice/core/types'
import {
  VOICE_ENDPOINTS,
  VOICE_RESOURCES,
  VOICE_RESOURCE_SUGGESTIONS
} from '../../../electron/main/fish/voice/core/settings'
import {
  VOICE_CLONE_LANGUAGES,
  defaultDemoText
} from '../../../electron/main/fish/voice/core/cloneLanguage'
import {
  EMOTION_GROUPS
} from '../../../electron/main/fish/voice/core/emotionOptions'

const VOICE_DEFAULTS = {
  ttsEndpoint: VOICE_ENDPOINTS.presetTts,
  ttsResourceId: VOICE_RESOURCES.preset,
  cloneEndpoint: VOICE_ENDPOINTS.clonedTts,
  cloneResourceId: VOICE_RESOURCES.cloned,
  cloneTrainEndpoint: VOICE_ENDPOINTS.cloneTrain,
  cloneStatusEndpoint: VOICE_ENDPOINTS.cloneStatus
} as const

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
const openclawStatus = ref<VoiceOpenClawStatus | null>(null)
const cloneRecords = ref<VoiceCloneRecord[]>([])
/** 最近一次远端对账结果，按 speakerId 索引。 */
const reconcileItems = ref<VoiceReconcileItem[]>([])
const reconcileBusy = ref(false)
function reconcileOf(record: VoiceCloneRecord): VoiceReconcileItem | undefined {
  return reconcileItems.value.find((item) => item.speakerId === record.speakerId)
}
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
  demoText: '',
  enableAudioDenoise: false,
  disableVolumeNormalization: false,
  consent: false
})
let currentAudio: HTMLAudioElement | null = null
let objectUrl = ''
let clonePollTimer: ReturnType<typeof setTimeout> | null = null
// 状态提示自动消失；错误提示不自动消失（错误通常需要用户看完再处理）。
let noticeTimer: ReturnType<typeof setTimeout> | null = null
const currentJobId = ref('')
const progressDone = ref(0)
const progressTotal = ref(0)
let progressCleanup: (() => void) | null = null

const voiceForm = reactive({
  defaultSpeaker: '',
  speedRatio: 1,
  emotion: '',
  autoSpeak: 'off' as 'off' | 'tagged' | 'always',
  conversationTts: 'off' as 'off' | 'always' | 'inbound' | 'tagged',
  conversationChannel: 'auto' as 'auto' | 'bridge' | 'volcengine',
  cloneModel: 'seed-tts-2.0-standard' as 'seed-tts-2.0-standard' | 'seed-tts-2.0-expressive'
})

/** 接口/模型高级配置的编辑态：与 settings 分开，取消不脏数据。 */
const advancedForm = reactive({
  ttsEndpoint: '',
  ttsResourceId: '',
  cloneEndpoint: '',
  cloneResourceId: '',
  cloneTrainEndpoint: '',
  cloneStatusEndpoint: ''
})
const advancedDirty = computed(() => {
  const s = settings.value
  if (!s) return false
  return (
    advancedForm.ttsEndpoint.trim() !== s.ttsEndpoint ||
    advancedForm.ttsResourceId.trim() !== s.ttsResourceId ||
    advancedForm.cloneEndpoint.trim() !== s.cloneEndpoint ||
    advancedForm.cloneResourceId.trim() !== s.cloneResourceId ||
    advancedForm.cloneTrainEndpoint.trim() !== s.cloneTrainEndpoint ||
    advancedForm.cloneStatusEndpoint.trim() !== s.cloneStatusEndpoint
  )
})

const defaultDemoTextPlaceholder = computed(() => defaultDemoText(cloneForm.language))

/** 已转正的克隆音色：只有转正后才能被选为默认（转正收槽位费，需用户明确确认）。 */
const activatedClones = computed(() =>
  cloneRecords.value.filter((record) => record.activated)
)

/** 下拉里所有可选项，用于判断当前默认值是否已失效。 */
/** 当前默认音色是否为预设音色：只有预设（豆包 2.0 音色）支持情绪指令。 */
const isPresetSelected = computed(() => {
  const id = voiceForm.defaultSpeaker || settings.value?.defaultSpeaker
  return (catalog.value?.voices ?? []).some((voice) => voice.voiceType === id)
})

const selectableSpeakers = computed(() => [
  ...(catalog.value?.voices ?? []).map((voice) => voice.voiceType),
  ...activatedClones.value.map((clone) => clone.speakerId)
])

const selectedVoice = computed<VoiceCatalogVoice | undefined>(() => {
  const id = voiceForm.defaultSpeaker || settings.value?.defaultSpeaker
  return catalog.value?.voices.find((voice) => voice.voiceType === id)
})

/** 清掉提示与其计时器（切换消息、卸载、手动关闭都要走这里）。 */
function clearNoticeTimer(): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
}

function showError(e: unknown): void {
  clearNoticeTimer()
  notice.value = ''
  error.value = e instanceof Error ? e.message : String(e)
}

/**
 * 显示一条状态提示，并在一段时间后自动消失。
 *
 * 旧实现只赋值不回收，于是「已命中本地缓存」这类一次性的成功提示会一直挂在
 * 页面上，连点若干次试听后还留着最后一条，用户无法判断当前是否还在进行。
 */
const NOTICE_AUTO_HIDE_MS = 4000
function showNotice(message: string): void {
  clearNoticeTimer()
  error.value = ''
  notice.value = message
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    notice.value = ''
  }, NOTICE_AUTO_HIDE_MS)
}

/** 手动关闭提示（模板上的「×」按钮用）。 */
function dismissNotice(): void {
  clearNoticeTimer()
  notice.value = ''
}

async function refreshSettings(): Promise<void> {
  const next = await api.settings.get()
  settings.value = next
  voiceForm.defaultSpeaker = next.defaultSpeaker
  voiceForm.speedRatio = next.speedRatio
  voiceForm.emotion = next.emotion
  voiceForm.autoSpeak = next.autoSpeak
  voiceForm.conversationTts = next.conversationTts
  voiceForm.cloneModel = next.cloneModel
  budgetLimit.value = next.dailyCharLimit
  syncAdvancedForm(next)
}

const openclawStatusText = computed(() => {
  const s = openclawStatus.value
  if (!s) return '正在检测对话内语音通道…'
  if (s.effective === 'bridge') return `当前生效：本地桥接 · ${s.reason}`
  if (s.effective === 'volcengine') return `当前生效：OpenClaw 标准接口 · ${s.reason}`
  return `当前不可用：${s.reason}`
})

async function refreshOpenClawStatus(): Promise<void> {
  try {
    openclawStatus.value = await api.openclaw.status()
  } catch {
    openclawStatus.value = null
  }
}

async function testOpenClaw(): Promise<void> {
  busy.value = true
  try {
    const result = await api.openclaw.test()
    if (result.audio) await playAudio(result.audio.audioId, result.audio.mime)
    showNotice(`${result.message}（通道：${result.channel ?? '无'}）`)
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function restartOpenClaw(): Promise<void> {
  if (!window.confirm('重启 OpenClaw 网关？当前对话会短暂中断。')) return
  busy.value = true
  try {
    await window.api.claw.restart()
    showNotice('网关已重启；对话内语音配置已生效')
    await refreshOpenClawStatus()
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function refreshBudget(): Promise<void> {
  budget.value = await api.budget.get()
}

/** 逐条核对本地记录与远端实际状态（只调 get_voice，不需要 AK/SK）。 */
async function reconcileClones(): Promise<void> {
  reconcileBusy.value = true
  error.value = ''
  try {
    reconcileItems.value = await api.clone.reconcile()
    const changed = reconcileItems.value.filter((i) => i.verdict !== 'remote-ok').length
    showNotice(
      changed
        ? `核对完成：${changed} 条与远端不一致，详见列表`
        : '核对完成：本地记录与远端全部一致'
    )
  } catch (e) {
    showError(e)
  } finally {
    reconcileBusy.value = false
  }
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
    voiceForm.conversationTts = nextSettings.conversationTts
    voiceForm.conversationChannel = nextSettings.conversationChannel
    voiceForm.cloneModel = nextSettings.cloneModel
    budgetLimit.value = nextSettings.dailyCharLimit
    syncAdvancedForm(nextSettings)
    void refreshOpenClawStatus()
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
      autoSpeak: voiceForm.autoSpeak,
      conversationTts: voiceForm.conversationTts,
      conversationChannel: voiceForm.conversationChannel,
      cloneModel: voiceForm.cloneModel
    })
    await refreshOpenClawStatus()
    showNotice(
      voiceForm.conversationTts === 'off'
        ? '语音设置已保存'
        : '已保存；对话内语音需重启网关生效'
    )
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

function syncAdvancedForm(from: VoiceSettingsView): void {
  advancedForm.ttsEndpoint = from.ttsEndpoint
  advancedForm.ttsResourceId = from.ttsResourceId
  advancedForm.cloneEndpoint = from.cloneEndpoint
  advancedForm.cloneResourceId = from.cloneResourceId
  advancedForm.cloneTrainEndpoint = from.cloneTrainEndpoint
  advancedForm.cloneStatusEndpoint = from.cloneStatusEndpoint
}

async function saveAdvanced(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    settings.value = await api.settings.set({
      ttsEndpoint: advancedForm.ttsEndpoint.trim(),
      ttsResourceId: advancedForm.ttsResourceId.trim(),
      cloneEndpoint: advancedForm.cloneEndpoint.trim(),
      cloneResourceId: advancedForm.cloneResourceId.trim(),
      cloneTrainEndpoint: advancedForm.cloneTrainEndpoint.trim(),
      cloneStatusEndpoint: advancedForm.cloneStatusEndpoint.trim()
    })
    syncAdvancedForm(settings.value)
    showNotice('接口与模型已更新，后续合成立即生效')
  } catch (e) {
    showError(e)
  } finally {
    busy.value = false
  }
}

async function resetAdvanced(): Promise<void> {
  advancedForm.ttsEndpoint = VOICE_DEFAULTS.ttsEndpoint
  advancedForm.ttsResourceId = VOICE_DEFAULTS.ttsResourceId
  advancedForm.cloneEndpoint = VOICE_DEFAULTS.cloneEndpoint
  advancedForm.cloneResourceId = VOICE_DEFAULTS.cloneResourceId
  advancedForm.cloneTrainEndpoint = VOICE_DEFAULTS.cloneTrainEndpoint
  advancedForm.cloneStatusEndpoint = VOICE_DEFAULTS.cloneStatusEndpoint
  await saveAdvanced()
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
  cloneForm.demoText = ''
  cloneForm.enableAudioDenoise = false
  cloneForm.disableVolumeNormalization = false
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
      language: cloneForm.language,
      demoText: cloneForm.demoText.trim() || undefined,
      enableAudioDenoise: cloneForm.enableAudioDenoise,
      disableVolumeNormalization: cloneForm.disableVolumeNormalization
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
  clearNoticeTimer()
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(78, 158, 255, 0.12);
  color: #8ec5ff;
}

.notice-close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  opacity: 0.65;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.notice-close:hover {
  opacity: 1;
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

.route-grid code {
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

/* 接口与模型高级区：固定两列。三项自适应会把输入框压得太窄，长 URL 读不全。 */
.advanced-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.advanced-form .form-input {
  width: 100%;
  min-width: 0;
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

/* 对账结论：按判定结果着色，一眼看出哪条和远端不一致 */
.clone-reconcile {
  font-size: 13px;
  color: var(--text-muted, #7d8590);
}

.clone-reconcile.remote-ok {
  color: #5ee29a;
}

.clone-reconcile.remote-missing,
.clone-reconcile.remote-failed {
  color: #ff8d8d;
}

.clone-reconcile.remote-changed {
  color: #ffd479;
}

/* 卡片标题右侧的动作组 */
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
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

  /* 窄屏回落单列，避免两列输入框被压到读不全 URL */
  .advanced-form {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
