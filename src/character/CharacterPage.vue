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
    <p v-if="toast" class="toast">{{ toast }}</p>

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
      <div class="row" style="margin-top: 10px">
        <span class="hint">桌宠暂时下线（形象重做后再放出）</span>
      </div>
    </section>

    <section class="card">
      <h3>首启三问</h3>
      <div class="row">
        <label class="lab">怎么称呼你</label>
        <input v-model="addressDraft" maxlength="40" placeholder="默认「你」" />
      </div>
      <div class="row">
        <label class="lab">关系模式</label>
        <select v-model="modeDraft">
          <option value="companion">朋友（搭子）</option>
          <option value="sister">妹妹</option>
          <option value="lover">恋人未满</option>
        </select>
      </div>
      <div class="row">
        <label class="lab">不能叫的称呼</label>
        <input v-model="tabooDraft" placeholder="逗号分隔；留空 = 不限制任何称呼" />
      </div>
      <p class="hint">称呼只来自你；答「没有」或留空 = 空列表 = 什么都能叫（建议项不默认生效）。</p>
      <div class="row">
        <button class="btn primary" :disabled="busy || !status.enabled" @click="saveOnboarding">保存引导设置</button>
        <button class="btn" :disabled="busy || !status.enabled" @click="runBootstrap">一键初始化</button>
      </div>
      <ul v-if="bootstrapReport" class="steps">
        <li v-for="step in bootstrapReport.steps" :key="step.id" :class="{ bad: !step.ok }">
          <span class="dot">{{ step.ok ? '✓' : '×' }}</span>
          <span class="name">{{ step.name }}</span>
          <span class="detail">{{ step.detail }}</span>
        </li>
      </ul>
      <div v-if="failedFlags.length" class="row" style="flex-wrap: wrap; margin-top: 10px">
        <button v-for="f in failedFlags" :key="f.key" class="btn ghost" @click="go(f.to)">
          {{ f.label }}未就绪 · 去配置
        </button>
      </div>
    </section>

    <section class="card">
      <h3>人格</h3>
      <p class="hint">
        人格 = SOUL / IDENTITY / AGENTS / USER 四个文件。导出可备份或换到别的机器；导入会先备份旧人格，
        导入后这些文件视为你手写的内容，不会再被模板覆盖。
      </p>
      <div class="row">
        <button class="btn" :disabled="busy" @click="exportPersona">导出人格包</button>
        <button class="btn" :disabled="busy" @click="pickPersonaFile">导入人格包</button>
        <input
          ref="personaFileInput"
          type="file"
          accept="application/json,.json"
          style="display: none"
          @change="onPersonaFilePicked"
        />
      </div>
      <p v-if="personaHint" class="hint">{{ personaHint }}</p>
    </section>

    <section class="card">
      <h3>知识</h3>
      <p class="hint">
        把世界书/角色卡/约定写进既有 Obsidian 的「大肥鱼」目录（不新增知识库）。导入内容会进她的检索
        上下文：只导入你信任的来源。同名笔记不会覆盖（会加序号）；单文件 ≤512KB、一次 ≤20 个/2MB。
        一般 Obsidian 会自动增量索引；检索不到时再点「重建索引」，并确认「知识库」页的 MCP 已启用。
      </p>
      <div class="row">
        <label class="lab">类别</label>
        <select v-model="knowledgeCategory">
          <option value="世界书">世界书</option>
          <option value="角色卡">角色卡</option>
          <option value="关系/约定">关系 / 约定</option>
        </select>
        <button class="btn" :disabled="busy" @click="pickKnowledgeFiles">选择文件并导入</button>
        <button class="btn ghost" :disabled="busy" @click="rebuildKnowledgeIndex">重建索引</button>
        <input
          ref="knowledgeFileInput"
          type="file"
          accept=".md,.txt,text/markdown,text/plain"
          multiple
          style="display: none"
          @change="onKnowledgeFilesPicked"
        />
      </div>
      <div class="grid health" style="margin-top: 10px">
        <div>
          <span class="k">vault</span>
          <span class="v">{{ knowledgeHealth ? (knowledgeHealth.vaultExists ? '✓ 已配置' : '× 未配置/不存在') : '…' }}</span>
        </div>
        <div>
          <span class="k">MCP</span>
          <span class="v">{{ knowledgeHealth ? (knowledgeHealth.obsidianEnabled ? '✓ 已启用' : '× 未启用') : '…' }}</span>
        </div>
        <div>
          <span class="k">索引</span>
          <span class="v">{{ knowledgeIndexText }}</span>
        </div>
        <div>
          <span class="k">角色笔记</span>
          <span class="v">{{ knowledgeHealth ? knowledgeHealth.characterNotes + (knowledgeHealth.characterNotes >= 500 ? '+ 篇' : ' 篇') : '…' }}</span>
        </div>
      </div>
      <p v-if="knowledgeHealth && !knowledgeHealth.searchable" class="hint" style="color: var(--text-secondary)">
        她当前还检索不到这些知识：{{ knowledgeReasonText }}。按提示处理后点「重新检查」。
      </p>
      <div class="row">
        <button class="btn ghost" :disabled="busy" @click="refreshKnowledgeHealth">重新检查</button>
      </div>
      <p v-if="knowledgeHealth && knowledgeHealth.warnings && knowledgeHealth.warnings.length" class="hint">
        提示：{{ knowledgeWarningText }}（旧索引通常仍可用）
      </p>
      <p v-if="knowledgeHint" class="hint">{{ knowledgeHint }}</p>
    </section>

    <section class="card">
      <h3>连接自检</h3>
      <div class="grid">
        <div>
          <span class="k">agent</span><span class="v">{{ flag(status.agentReady) }}</span>
          <button v-if="!status.agentReady" class="link" @click="go('/config')">去配置</button>
        </div>
        <div>
          <span class="k">网关</span><span class="v">{{ flag(status.gatewayReady) }}</span>
          <button v-if="!status.gatewayReady" class="link" @click="go('/dashboard')">去查看</button>
        </div>
        <div>
          <span class="k">Obsidian</span><span class="v">{{ flag(status.obsidianReady) }}</span>
          <button v-if="!status.obsidianReady" class="link" @click="go('/obsidian')">去配置</button>
        </div>
        <div>
          <span class="k">外部渠道</span><span class="v">{{ flag(status.qqReady) }}</span>
          <button v-if="!status.qqReady" class="link" @click="go('/channelsPage')">去配置</button>
        </div>
        <div>
          <span class="k">TTS</span><span class="v">{{ flag(status.ttsReady) }}</span>
          <button v-if="!status.ttsReady" class="link" @click="go('/voice')">去配置</button>
        </div>
        <div>
          <span class="k">记忆检索</span><span class="v">{{ flag(status.memorySearchReady) }}</span>
          <button v-if="!status.memorySearchReady" class="link" @click="go('/obsidian')">去配置</button>
        </div>
      </div>
      <p class="hint">
        记忆/世界书/日记走既有 Obsidian：在「知识库」页启用 MCP 并重建索引后，她才能检索回忆。
        外部渠道（QQ/飞书/微信）任一配置即可；不配也不影响在应用里聊天。
      </p>
    </section>

    <section class="card">
      <h3>聊天渠道</h3>
      <p class="hint">
        勾选后，这些渠道内被渠道策略放行的会话（含群聊）会路由给大肥鱼（文本）；保存后需重启
        OpenClaw 网关生效。语音条仍需 TTS 与 QQ 凭据，和这里独立。
      </p>
      <p v-if="!status.enabled" class="hint">
        当前已停用：可以先「断开聊天渠道」，或重新启用后再勾选保存。
      </p>
      <p v-if="chatChannelsError" class="err">{{ chatChannelsError }}</p>
      <p v-else-if="!chatChannels.length" class="hint">
        还没有已配置的聊天渠道。
        <button class="link" @click="go('/channelsPage')">去渠道接入</button>
      </p>
      <div v-else class="row" style="flex-direction: column; align-items: flex-start; gap: 6px">
        <label v-for="ch in chatChannels" :key="ch.id" class="check-row">
          <input
            v-model="chatChannelSelection"
            type="checkbox"
            :value="ch.id"
            :disabled="chatChannelsBusy || !status.enabled || Boolean(ch.blockedReason)"
          />
          <span>
            {{ ch.label }}
            <span class="hint">
              （{{ ch.id }}{{ ch.accounts.length ? ' · ' + ch.accounts.join(' / ') : '' }}{{
                ch.blockedReason === 'multi-account'
                  ? ' · 多账号渠道暂不支持自动接管，请用 OpenClaw 逐账号绑定'
                  : ch.blockedReason === 'other-agent'
                    ? ` · 已被 ${ch.blockedBy || '其它 agent'} 的默认账号/peer 规则占用，请先在 OpenClaw 解绑`
                    : ch.boundTo === 'feiyu'
                      ? ' · 已绑定大肥鱼'
                      : ch.boundTo === 'other'
                        ? ' · 其它 agent 仅 wildcard 绑定；保存后默认账号改由大肥鱼接管'
                        : ''
              }}）
            </span>
          </span>
        </label>
      </div>
      <div class="row" style="margin-top: 10px">
        <button
          class="btn primary"
          :disabled="
            chatChannelsBusy ||
            !status.enabled ||
            !chatChannelsLoaded ||
            Boolean(chatChannelsError) ||
            !chatChannels.length
          "
          @click="saveChatChannels"
        >
          {{ chatChannelsBusy ? '保存中…' : '保存聊天渠道' }}
        </button>
        <button
          class="btn ghost"
          :disabled="
            chatChannelsBusy ||
            !chatChannels.some((c) => c.boundTo === 'feiyu')
          "
          @click="clearChatChannelsNow"
        >
          断开聊天渠道
        </button>
        <button class="btn ghost" :disabled="chatChannelsBusy" @click="refreshChatChannels">
          重新检查
        </button>
      </div>
      <p v-if="chatChannelsHint" class="hint">{{ chatChannelsHint }}</p>
    </section>

    <section class="card">
      <h3>聊两句</h3>
      <div class="chat-log">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <span class="who">{{ m.role === 'user' ? '你' : '她' }}</span>
          <span class="text">{{ m.streaming && !m.text ? '正在想…' : m.text }}<span v-if="m.streaming" class="cursor">▍</span></span>
        </div>
        <p v-if="!messages.length" class="hint">还没聊过。说句话试试。</p>
      </div>
      <div class="row">
        <input
          v-model="draft"
          :disabled="streaming"
          placeholder="跟她说点什么（Enter 发送）"
          @keydown.enter="sendMessage"
        />
        <button class="btn primary" :disabled="!draft.trim() || streaming || !status.enabled" @click="sendMessage">
          发送
        </button>
        <button class="btn" :disabled="!streaming" @click="stopStreaming">停止</button>
        <button class="btn ghost" @click="clearChat">清空</button>
      </div>
      <p class="hint">
        清空只轮换会话上下文；日记与关系记忆不受影响。首次或隔很久的回复可能要几十秒（网关/模型冷启动），
        失败会显示在页面上方。
      </p>
    </section>

    <section class="card">
      <h3>她的一天</h3>
      <pre v-if="lifeDoc" class="life-doc">{{ lifeDoc }}</pre>
      <p v-else class="hint">还没生成。启用后她会每天写自己的一天。</p>
      <div class="row" style="margin-top: 10px">
        <button class="btn" :disabled="busy || !status.enabled" @click="toggleProactive">
          {{ proactiveEnabled ? '关闭主动消息' : '开启主动消息' }}
        </button>
        <button class="btn ghost" :disabled="busy || !status.enabled" @click="quietDays">安静三天</button>
        <button class="btn ghost" :disabled="busy || !status.enabled" @click="cancelQuiet">取消安静</button>
      </div>
      <p class="hint">安静期间不发主动消息，不影响聊天与好感；免打扰时段与每日上限在设置里改。</p>
    </section>

    <section class="card">
      <h3>互动</h3>
      <div class="row">
        <button class="btn" :disabled="busy || !status.enabled" @click="interact('pat')">摸摸头</button>
        <button class="btn" :disabled="busy || !status.enabled" @click="interact('feed')">投喂</button>
        <button class="btn" :disabled="busy || !status.enabled" @click="sendVoice">发一条语音</button>
      </div>
      <p class="hint">语音需要 QQ 机器人凭据；没配置会降级成文字，不会报错。</p>
    </section>

    <section class="card">
      <h3>桌宠形象</h3>
      <p class="hint">
        可以直接导入你自己的图片当形象（PNG / JPEG / WebP / GIF，动图会动；≤8MB）。
        不支持 SVG；导入后角色页立即预览，桌宠窗口接线恢复后会自动使用这张图；恢复默认则回到内置小鱼。
      </p>
      <div class="pet-preview">
        <img
          v-if="petAppearance && petAppearance.kind === 'image'"
          class="pet-preview-img"
          :src="petAppearance.dataUrl"
          alt="桌宠形象预览"
        />
        <FishState v-else state="idle" class="pet-preview-art" />
      </div>
      <div class="row">
        <button class="btn" :disabled="busy" @click="pickPetAppearance">导入图片</button>
        <button
          v-if="petAppearance && petAppearance.kind === 'image'"
          class="btn ghost"
          :disabled="busy"
          @click="clearPetAppearance"
        >
          恢复默认
        </button>
        <input
          ref="petAppearanceInput"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style="display: none"
          @change="onPetAppearancePicked"
        />
      </div>
    </section>

    <section class="card">
      <h3>今天的日记</h3>
      <p class="hint">{{ memoryText }}</p>
      <div class="row">
        <button class="btn" :disabled="busy || !status.enabled" @click="runMemory">现在写一篇</button>
      </div>
      <p class="hint">每天 23:00 自动写；先写 workspace，再写 Obsidian 的「大肥鱼/日记」。需要先在「隐私与安全」确认年龄。</p>
      <p class="hint">问起过去时，最近 5 天日记 + 约定/大事记会直接进对话上下文（不依赖 Obsidian 索引）。</p>
    </section>

    <section class="card">
      <h3>记忆与关系</h3>
      <p class="hint">
        查看/修正她的日记、约定与大事记。删除是移到「大肥鱼/归档」或本地 memory-archive，不会物理删除；
        日记保存只改本地记忆（她召回用），Obsidian 原始日记不动。
      </p>
      <div class="row">
        <button class="btn ghost" :disabled="busy" @click="refreshMemoriesGuarded">刷新列表</button>
        <span class="hint">关系：{{ relationshipSummary }}</span>
      </div>
      <div v-if="memoryEditor" class="memo-editor">
        <div class="row">
          <strong>{{ memoryEditor.kind === 'diary' ? memoryEditor.id + ' 的日记' : memoryEditor.id }}</strong>
          <button v-if="memoryEditor.kind === 'diary'" class="btn primary" :disabled="busy || !memoryEditorDirty" @click="saveMemoryEntry">保存</button>
          <span v-if="memoryEditor.kind === 'diary' && memoryEditorDirty" class="hint">未保存</span>
          <button class="btn ghost" :disabled="busy" @click="confirmDiscardEdit(() => { memoryEditor = null })">关闭</button>
        </div>
        <textarea v-if="memoryEditor.kind === 'diary'" v-model="memoryEditor.content" rows="8" class="memo-text"></textarea>
        <pre v-else class="memo-text memo-readonly">{{ memoryEditor.content }}</pre>
        <p v-if="memoryEditor.kind === 'relation'" class="hint">关系笔记在 Obsidian 里编辑（这里只读）；删除会归档。</p>
      </div>
      <h4 class="memo-title">日记（最近 30 天）</h4>
      <ul class="memo-list">
        <li v-for="d in memoryDiaries" :key="d.date" class="memo-item">
          <button class="memo-open" @click="openMemory('diary', d.date)">{{ d.date }}</button>
          <span class="hint">{{ d.excerpt }}</span>
          <button class="btn ghost" :disabled="busy" @click="deleteMemoryEntry('diary', d.date)">删除</button>
        </li>
      </ul>
      <p v-if="!memoryDiaries.length" class="hint">还没有日记；可以点上面「现在写一篇」。</p>
      <h4 class="memo-title">约定 / 大事记</h4>
      <ul class="memo-list">
        <li v-for="r in memoryRelations" :key="r.id" class="memo-item">
          <button class="memo-open" @click="openMemory('relation', r.id)">{{ r.id }}</button>
          <span class="hint">{{ r.excerpt }}</span>
          <button class="btn ghost" :disabled="busy" @click="deleteMemoryEntry('relation', r.id)">删除</button>
        </li>
      </ul>
      <p v-if="!memoryRelations.length" class="hint">还没有约定/大事记；可先在「知识」导入，或让她在聊天里记下约定。</p>
    </section>

    <CharacterSettings
      ref="settingsRef"
      :settings="settingsRaw"
      :enabled="status.enabled"
      @save="saveDetailSettings"
    />

    <section class="card">
      <h3>隐私与安全</h3>
      <label class="check-row">
        <input v-model="ageConfirmed" type="checkbox" @change="saveAgeConfirm" />
        <span>我已满 18 岁（未确认前她不会主动发消息）</span>
      </label>
      <div class="row" style="margin-top: 10px">
        <button class="btn" :disabled="busy" @click="exportData">导出她的档案</button>
        <button class="btn ghost" :disabled="busy" @click="deleteMemory">删除日记与关系</button>
        <button class="btn ghost" :disabled="busy" @click="deleteAll">删除全部</button>
      </div>
      <p class="hint">导出不含密钥；日记会归档到本机 `memory-archive/` 与 Obsidian 的「大肥鱼/归档」，不会直接删除你的笔记。</p>
    </section>

    <section class="card">
      <h3>数据</h3>
      <div class="row">
        <button class="btn ghost" :disabled="busy" @click="resetValues">重置数值</button>
      </div>
      <p class="hint">只清角色数值；记忆与日记在 C07/C09 提供更细的删除与导出。</p>
    </section>

    <!-- 统一二次确认：宿主其它页面用的都是自定义 ConfirmDialog，这里不再用原生 window.confirm -->
    <ConfirmDialog
      v-model:visible="confirmVisible"
      :icon="confirmDanger ? '⚠️' : '❓'"
      :title="confirmTitle"
      :confirm-text="confirmText"
      cancel-text="取消"
      :danger="confirmDanger"
      @confirm="runConfirmedAction"
      @cancel="cancelConfirmedAction"
    >
      <p class="modal-message">{{ confirmMessage }}</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'
import CharacterSettings from './CharacterSettings.vue'
import FishState from './art/FishState.vue'
import type { BootstrapReport } from '../../electron/main/character/bootstrap'
import type { CharacterChatStreamEvent } from '../../electron/main/character/chat'
import type { CharacterSettings as CharacterSettingsShape, CharacterSettingsPatch } from '../../electron/main/character/types'

interface ChatBubble {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

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
  memorySearchReady: false,
  chatGen: 0
})
const state = ref({
  stage: 0,
  familiarity: 0,
  intimacy: 0,
  mood: '',
  addressForm: '你'
})
const addressDraft = ref('')
const modeDraft = ref<'companion' | 'sister' | 'lover'>('companion')
const tabooDraft = ref('')
const settingsRaw = ref<CharacterSettingsShape | null>(null)
const settingsRef = ref<InstanceType<typeof CharacterSettings> | null>(null)
const personaFileInput = ref<HTMLInputElement | null>(null)
const personaHint = ref('')
const knowledgeFileInput = ref<HTMLInputElement | null>(null)
const knowledgeCategory = ref<'世界书' | '角色卡' | '关系/约定'>('世界书')
const knowledgeHint = ref('')
interface KnowledgeHealthView {
  vaultPath: string
  vaultExists: boolean
  obsidianEnabled: boolean
  index: {
    indexing?: boolean
    noteCount?: number
    chunkCount?: number
    lastIndexedAt?: number | string | null
    lastError?: string | null
    vaultPath?: string | null
  } | null
  characterNotes: number
  searchable: boolean
  reasons: string[]
  warnings: string[]
}
const knowledgeHealth = ref<KnowledgeHealthView | null>(null)
const KNOWLEDGE_REASON_TEXT: Record<string, string> = {
  'no-vault': '未配置 Obsidian vault',
  'vault-missing': 'vault 目录不存在',
  'mcp-disabled': '「知识库」页的 Obsidian MCP 未启用',
  'no-notes': '大肥鱼/ 下还没有笔记（先导入知识）',
  'index-empty': '还没建索引',
  'index-other-vault': '索引属于另一个 vault（切换后需重建）',
  'indexing': '正在索引',
  'index-error': '上次索引失败'
}
const knowledgeIndexText = computed(() => {
  const index = knowledgeHealth.value?.index
  if (!index) return '—'
  if (index.indexing) return '… 索引中'
  const count = Number(index.chunkCount ?? 0)
  if (count <= 0) return '× 未建'
  return `✓ ${count} 块`
})
const KNOWLEDGE_WARNING_TEXT: Record<string, string> = {
  'indexing': '正在索引',
  'index-error': '上次索引失败（可能是取消/旧索引仍可用）'
}
const knowledgeWarningText = computed(() => {
  const list = knowledgeHealth.value?.warnings ?? []
  return list.map((w) => KNOWLEDGE_WARNING_TEXT[w] ?? w).join('；')
})
const knowledgeReasonText = computed(() => {
  const reasons = knowledgeHealth.value?.reasons ?? []
  const labels = reasons.map((r) => KNOWLEDGE_REASON_TEXT[r] ?? r)
  return labels.length ? labels.join('；') : '未知原因'
})
const bootstrapReport = ref<BootstrapReport | null>(null)
// 4.3：外部渠道聊天绑定（渠道消息 → 大肥鱼 agent）
interface ChatChannelView {
  id: string
  label: string
  accounts: string[]
  boundTo: 'feiyu' | 'other' | null
  blockedReason: 'multi-account' | 'other-agent' | null
  blockedBy?: string
}
const chatChannels = ref<ChatChannelView[]>([])
const chatChannelSelection = ref<string[]>([])
const chatChannelsBusy = ref(false)
const chatChannelsLoaded = ref(false)
const chatChannelsHint = ref('')
const chatChannelsError = ref('')
const petVisible = ref(false)
const lifeDoc = ref('')
const proactiveEnabled = ref(false)
const memoryStatus = ref({ done: false, attempts: 0, lastError: '' })
const ageConfirmed = ref(false)
const MEMORY_REASON_TEXT: Record<string, string> = {
  'age-unconfirmed': '还没确认年龄（在「隐私与安全」勾选后才会写）',
  'auto-off': '自动记忆已关闭',
  'not-window': '还没到 23:00 窗口',
  'attempts': '今天尝试次数用完了',
  'cooldown': '刚失败过，5 分钟后再试',
  'done': '今天已经写好了',
  'in-flight': '正在写，别催',
  'disabled': '大肥鱼未启用'
}
const VOICE_REASON_TEXT: Record<string, string> = {
  'disabled': '语音条未开启（设置里打开语音）',
  'age-unconfirmed': '还没确认年龄（先到「隐私与安全」勾选）',
  'request-not-allowed': '语音条被设置禁用了',
  'not-unlocked': '还不熟，先多聊几句',
  'quiet': '现在是免打扰时间',
  'daily-cap': '今天的语音条额度用完了',
  'too-long': '这句话太长了，先缩到 120 字内',
  'not-wired': '语音服务未接线（缺 TTS/QQ 配置）'
}

const memoryText = computed(() => {
  if (memoryStatus.value.done) return '今天已经写好了。'
  if (memoryStatus.value.lastError) {
    return `上次失败（第 ${memoryStatus.value.attempts} 次）：${memoryStatus.value.lastError}`
  }
  return '今天还没写。23:00 后会自动写，也可以手动写。'
})
const messages = ref<ChatBubble[]>([])
const draft = ref('')
const runId = ref('')
const activeGen = ref(0)
const streaming = computed(() => Boolean(runId.value))
let cancelPending = false
const busy = ref(false)
const error = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
let slowTimer: ReturnType<typeof setTimeout> | null = null
const slowHintShown = ref(false)
const router = useRouter()

function clearSlowTimer(): void {
  if (slowTimer) {
    clearTimeout(slowTimer)
    slowTimer = null
  }
}

/** 轻提示：保存/启用/导出等操作给明确反馈（3 秒自动消失） */
function showToast(message: string): void {
  toast.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
    toastTimer = null
  }, 3000)
}

/**
 * 统一二次确认：宿主其它页面（插件管理 / 模型配置等）都用自定义 ConfirmDialog，
 * 这里不再用原生 window.confirm，避免样式、层级与交互不一致。
 */
const confirmVisible = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmText = ref('确定')
const confirmDanger = ref(true)
let confirmAction: (() => void | Promise<void>) | null = null

function askConfirm(
  options: { title: string; message: string; confirmText?: string; danger?: boolean },
  action: () => void | Promise<void>
): void {
  confirmTitle.value = options.title
  confirmMessage.value = options.message
  confirmText.value = options.confirmText ?? '确定'
  confirmDanger.value = options.danger ?? true
  confirmAction = action
  confirmVisible.value = true
}

function runConfirmedAction(): void {
  const action = confirmAction
  confirmVisible.value = false
  confirmAction = null
  if (action) void action()
}

function cancelConfirmedAction(): void {
  confirmVisible.value = false
  confirmAction = null
}

/** 自检失败项 → 对应配置页（QQ/飞书/微信都在渠道接入里） */
const FLAG_FIX: Record<string, { label: string; to: string }> = {
  agentReady: { label: '模型', to: '/config' },
  gatewayReady: { label: '网关', to: '/dashboard' },
  obsidianReady: { label: 'Obsidian', to: '/obsidian' },
  qqReady: { label: '渠道', to: '/channelsPage' },
  ttsReady: { label: '语音', to: '/voice' },
  sttReady: { label: '语音识别', to: '/config' },
  memorySearchReady: { label: '记忆检索', to: '/obsidian' }
}
const failedFlags = computed(() => {
  // 用实时 status（而不是上次初始化报告）：配置改完这里立刻反映
  const flags = status.value as Record<string, unknown>
  return Object.entries(FLAG_FIX)
    .filter(([key]) => flags[key] === false)
    .map(([key, meta]) => ({ key, ...meta }))
})

function go(path: string): void {
  void router.push(path)
}

const STAGE_LABELS = ['初识', '眼熟', '熟客', '自己人', '搭子以上']
const stageLabel = computed(() => STAGE_LABELS[state.value.stage] ?? '初识')
const flag = (v: boolean): string => (v ? '✓ 就绪' : '× 未就绪')

let offEvent: (() => void) | null = null
let offStream: (() => void) | null = null

onMounted(async () => {
  offEvent = window.api.character.onEvent((event) => {
    // 主动消息外发失败时会降级成 bubble；桌宠窗口下线期间，这层提示是用户唯一能看到它的地方
    if (event.type === 'bubble') showToast(event.payload.text)
    void refresh()
  })
  offStream = window.api.character.chat.onStream(onStreamEvent)
  await refresh()
  void refreshKnowledgeHealth()
  void refreshMemories()
  void refreshPetAppearance()
  void refreshChatChannels()
})

onBeforeUnmount(() => {
  offEvent?.()
  offEvent = null
  offStream?.()
  offStream = null
})

async function refresh(): Promise<void> {
  try {
    status.value = await window.api.character.status()
    activeGen.value = status.value.chatGen ?? 0
    state.value = await window.api.character.state()
    const settings = await window.api.character.settings.get()
    settingsRaw.value = settings
    addressDraft.value = settings.relationship?.address || '你'
    modeDraft.value = settings.relationship?.mode || 'companion'
    tabooDraft.value = (settings.relationship?.taboo ?? []).join('，')
    proactiveEnabled.value = Boolean(settings.proactive?.enabled)
    ageConfirmed.value = Boolean(settings.safety?.ageConfirmed)
    const life = await window.api.character.life.get()
    lifeDoc.value = life.doc ?? ''
    const memory = await window.api.character.memory.status()
    memoryStatus.value = {
      done: Boolean(memory.done),
      attempts: memory.attempts ?? 0,
      lastError: memory.lastError ?? ''
    }
    bootstrapReport.value = await window.api.character.bootstrap.status()
  } catch (e) {
    error.value = (e as Error)?.message || '读取角色状态失败'
  }
}

async function toggleEnabled(): Promise<void> {
  if (!status.value.enabled) {
    await applyEnabled(true)
    return
  }
  askConfirm(
    {
      title: '停用大肥鱼',
      message: '停用后主动消息、日记都会停止，关系与日记数据会保留。确定停用？',
      confirmText: '停用'
    },
    () => applyEnabled(false)
  )
}

async function applyEnabled(next: boolean): Promise<void> {
  await run(async () => {
    await window.api.character.settings.set({ enabled: next } as never)
    await refresh()
    // 先成功停用、再断开外部渠道：set 失败时不会出现「绑定已断但仍启用」的反序状态。
    // 断开失败要可见（不能静默让外部渠道继续回复），失败后仍可在卡片里重试。
    if (!next) {
      try {
        await window.api.character.chatChannels.clear()
        chatChannelsHint.value = '已断开外部聊天渠道。'
        void refreshChatChannels()
        showToast('已停用（数据保留），外部聊天渠道已断开')
      } catch (e) {
        const message = (e as Error)?.message || '断开外部聊天渠道失败'
        chatChannelsError.value = message
        showToast(message)
      }
    } else {
      void refreshChatChannels()
      showToast('已启用她；建议再点「一键初始化」')
    }
  })
}

/** 读取已配置渠道 + 当前绑定归属（渠道级；群聊白名单仍由渠道自身控制） */
async function refreshChatChannels(): Promise<void> {
  try {
    const list = await window.api.character.chatChannels.list()
    chatChannels.value = list
    chatChannelsError.value = ''
    chatChannelsLoaded.value = true
    chatChannelSelection.value = list
      .filter((c) => c.boundTo === 'feiyu' && !c.blockedReason)
      .map((c) => c.id)
  } catch (e) {
    chatChannels.value = []
    chatChannelsLoaded.value = false
    chatChannelsError.value = (e as Error)?.message || '读取聊天渠道失败'
  }
}

async function saveChatChannels(): Promise<void> {
  if (chatChannelsBusy.value) return
  chatChannelsBusy.value = true
  chatChannelsHint.value = ''
  chatChannelsError.value = ''
  try {
    // ref 数组的 .value 是 Vue 的 reactive Proxy，structuredClone 无法克隆（Electron 会抛
    // DataCloneError: An object could not be cloned），跨 IPC 前必须解包成普通数组。
    const result = await window.api.character.chatChannels.set([...chatChannelSelection.value])
    chatChannels.value = result.channels
    chatChannelSelection.value = result.channels
      .filter((c) => c.boundTo === 'feiyu' && !c.blockedReason)
      .map((c) => c.id)
    chatChannelsHint.value = `已保存（新增 ${result.added.length}、移除 ${result.removed.length}）。重启 OpenClaw 网关后生效。`
    showToast('聊天渠道已保存')
  } catch (e) {
    const message = (e as Error)?.message || '保存聊天渠道失败'
    // 回读真实状态（后端可能已回滚），但保留错误信息（refresh 成功会清空，所以回读后再写回）
    await refreshChatChannels()
    chatChannelsError.value = message
  } finally {
    chatChannelsBusy.value = false
  }
}

async function clearChatChannelsNow(): Promise<void> {
  if (chatChannelsBusy.value) return
  chatChannelsBusy.value = true
  chatChannelsError.value = ''
  try {
    const result = await window.api.character.chatChannels.clear()
    chatChannelsHint.value = `已断开 ${result.removed.length} 个外部渠道。`
    await refreshChatChannels()
    showToast('已断开外部聊天渠道')
  } catch (e) {
    chatChannelsError.value = (e as Error)?.message || '断开聊天渠道失败'
  } finally {
    chatChannelsBusy.value = false
  }
}

/** 详细设置保存：由 CharacterSettings 组件 emit patch；成功后就地刷新并反馈 */
async function saveDetailSettings(patch: CharacterSettingsPatch): Promise<void> {
  settingsRef.value?.setSaving(true)
  await run(async () => {
    await window.api.character.settings.set(patch)
    await refresh()
    settingsRef.value?.markSaved()
    showToast('设置已保存')
  })
  settingsRef.value?.setSaving(false)
}

async function sendVoice(): Promise<void> {
  await run(async () => {
    const result = await window.api.character.voice.send('本鱼在呢。')
    if (!result.delivered) {
      error.value = result.error
        ? `语音条没发出去（已降级文字）：${result.error}`
        : `这次没发语音：${VOICE_REASON_TEXT[result.reason ?? ''] ?? result.reason ?? '未知原因'}`
      return
    }
    await refresh()
    showToast('语音条已发出')
  })
}

async function toggleProactive(): Promise<void> {
  await run(async () => {
    const next = !proactiveEnabled.value
    await window.api.character.settings.set({ proactive: { enabled: next } } as never)
    proactiveEnabled.value = next
    await refresh()
    showToast(next ? '主动消息已开启' : '主动消息已关闭')
  })
}

async function quietDays(): Promise<void> {
  await run(async () => {
    const until = Date.now() + 3 * 86_400_000
    await window.api.character.settings.set({ proactive: { silentUntil: until } } as never)
    await refresh()
    showToast('已安静三天（可点「取消安静」恢复）')
  })
}

async function runMemory(): Promise<void> {
  await run(async () => {
    const result = await window.api.character.memory.runNow()
    await refresh()
    if (result.errors?.length) error.value = result.errors.join('；')
    else if (!result.ran) error.value = `这次没写：${MEMORY_REASON_TEXT[result.reason] ?? result.reason}`
    // 成功提示由 manager 的 bubble 事件统一弹出（「日记写好了（日期）」），这里不再重复 toast
  })
}

type PetAppearanceView =
  | { kind: 'builtin' }
  | { kind: 'image'; dataUrl: string; meta?: { file: string; mime: string; bytes: number } }
const petAppearance = ref<PetAppearanceView | null>(null)
const petAppearanceInput = ref<HTMLInputElement | null>(null)

async function refreshPetAppearance(): Promise<void> {
  try {
    petAppearance.value = await window.api.character.pet.appearance.get()
  } catch {
    petAppearance.value = null
  }
}

function pickPetAppearance(): void {
  petAppearanceInput.value?.click()
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve(String(reader.result ?? '').replace(/^data:[^;]+;base64,/, ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function onPetAppearancePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 8 * 1024 * 1024) {
    error.value = '图片过大（最多 8MB）'
    return
  }
  // 某些 Windows 环境 file.type 为空：交给宿主魔数校验（宿主只认真正的栅格图）
  if (file.type && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    error.value = '只支持 PNG / JPEG / WebP / GIF（不支持 SVG）'
    return
  }
  await run(async () => {
    const dataBase64 = await fileToBase64(file)
    petAppearance.value = await window.api.character.pet.appearance.import(file.name, dataBase64)
    showToast('形象已更新')
  })
}

function clearPetAppearance(): void {
  askConfirm(
    {
      title: '恢复默认形象',
      message: '会删除已导入的图片并回到内置小鱼，确定？',
      confirmText: '恢复默认',
      danger: true
    },
    async () => {
      await run(async () => {
        petAppearance.value = await window.api.character.pet.appearance.clear()
        showToast('已恢复默认形象')
      })
    }
  )
}

interface MemoryDiaryView { date: string; chars: number; excerpt: string; source: string }
interface MemoryRelationView { kind: string; id: string; chars: number; excerpt: string }
const memoryDiaries = ref<MemoryDiaryView[]>([])
const memoryRelations = ref<MemoryRelationView[]>([])
const memoryEditor = ref<{ kind: 'diary' | 'relation'; id: string; content: string; original: string } | null>(
  null
)
const memoryEditorDirty = computed(
  () => Boolean(memoryEditor.value && memoryEditor.value.content !== memoryEditor.value.original)
)
const relationshipSummary = computed(() => {
  const stageLabels = ['初识', '眼熟', '熟客', '自己人', '搭子以上']
  return `${stageLabels[state.value.stage] ?? '初识'} · ${state.value.mood || '平静'} · 连续 ${state.value.streakDays ?? 0} 天`
})

async function refreshMemories(): Promise<void> {
  await run(async () => {
    const list = await window.api.character.memory.list()
    memoryDiaries.value = list.diaries ?? []
    memoryRelations.value = list.relations ?? []
  })
}

function confirmDiscardEdit(action: () => void): void {
  if (!memoryEditorDirty.value) {
    action()
    return
  }
  askConfirm(
    {
      title: '放弃未保存的修改？',
      message: '当前日记有未保存的修改，继续会丢弃这些内容。',
      confirmText: '放弃修改',
      danger: true
    },
    action
  )
}

function refreshMemoriesGuarded(): void {
  confirmDiscardEdit(() => void refreshMemories())
}

function openMemory(kind: 'diary' | 'relation', id: string): void {
  confirmDiscardEdit(() => {
    void (async () => {
      await run(async () => {
        const item = await window.api.character.memory.read(kind, id)
        memoryEditor.value = { kind, id, content: item.content, original: item.content }
      })
    })()
  })
}

async function saveMemoryEntry(): Promise<void> {
  if (!memoryEditor.value) return
  const editor = memoryEditor.value
  if (editor.kind !== 'diary') return
  await run(async () => {
    await window.api.character.memory.save(editor.id, editor.content)
    memoryEditor.value = { ...editor, original: editor.content }
    showToast('日记已保存')
    await refreshMemories()
  })
}

function deleteMemoryEntry(kind: 'diary' | 'relation', id: string): void {
  askConfirm(
    {
      title: '删除这条记忆',
      message: `${id} 会被归档（本地日记进 memory-archive，Obsidian 笔记进「大肥鱼/归档」，可找回），确定删除？`,
      confirmText: '删除',
      danger: true
    },
    async () => {
      await run(async () => {
        await window.api.character.memory.delete(kind, id)
        if (memoryEditor.value && memoryEditor.value.kind === kind && memoryEditor.value.id === id) {
          memoryEditor.value = null
        }
        showToast('已归档')
        await refreshMemories()
      })
    }
  )
}

async function cancelQuiet(): Promise<void> {
  await run(async () => {
    await window.api.character.settings.set({ proactive: { silentUntil: 0 } } as never)
    await refresh()
    showToast('已取消安静，主动消息恢复')
  })
}

async function saveAgeConfirm(): Promise<void> {
  await run(async () => {
    await window.api.character.settings.set({
      safety: { ageConfirmed: ageConfirmed.value }
    } as never)
    await refresh()
    showToast(ageConfirmed.value ? '已确认年龄' : '已取消年龄确认（主动/日记会停）')
  })
}

async function exportData(): Promise<void> {
  await run(async () => {
    const data = await window.api.character.safety.exportData()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fish-character-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('档案已导出（不含密钥）')
  })
}

async function exportPersona(): Promise<void> {
  await run(async () => {
    const pkg = await window.api.character.persona.export()
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fish-persona-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    personaHint.value = `已导出 ${Object.keys(pkg.files ?? {}).length} 个人格文件`
    showToast('人格包已导出')
  })
}

function pickPersonaFile(): void {
  personaHint.value = ''
  personaFileInput.value?.click()
}

/** 导入人格包：先在渲染端做体积/JSON 校验，真正的槽位/内容/备份校验在宿主（persona.ts） */
async function onPersonaFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  // 不在这里按 JSON 文件体积拦截：宿主按解析后的四个槽位校验 512KB/2MB；
  // 导出的 JSON 会因引号/转义比原文大，按文件体积拦会把合法导出包拒收（对抗复核 P2）
  const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
  if (file.size > MAX_PACKAGE_BYTES) {
    error.value = '人格包文件过大（上限 16MB）'
    return
  }
  let pkg: unknown
  try {
    pkg = JSON.parse(await file.text())
  } catch {
    error.value = '人格包不是合法 JSON'
    return
  }
  const files = (pkg as { files?: Record<string, unknown> })?.files
  const KNOWN_SLOTS = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md']
  const slots =
    files && typeof files === 'object'
      ? Object.keys(files).filter((key) => KNOWN_SLOTS.includes(key))
      : []
  if (slots.length === 0) {
    error.value = '人格包里没有文件（需要 SOUL/IDENTITY/AGENTS/USER）'
    return
  }
  askConfirm(
    {
      title: '导入人格',
      message:
        `将导入 ${slots.join('、')}（未知文件会被忽略）。人格文件会成为她的系统提示词：` +
        '请只导入你信任的来源；旧人格会先备份到 workspace 的 .persona-backup。确定导入？',
      confirmText: '导入'
    },
    async () => {
      await run(async () => {
        const result = await window.api.character.persona.import(pkg)
        personaHint.value = `已导入：${result.written.join('、')}；旧人格备份在 ${result.backupDir ?? '（无旧文件）'}`
        await refresh()
        showToast('人格已导入')
      })
    }
  )
}

function pickKnowledgeFiles(): void {
  knowledgeHint.value = ''
  knowledgeFileInput.value?.click()
}

/** 知识导入：渲染端做数量/体积预检，类别/内容/落盘校验在宿主 knowledgeImport.ts */
async function onKnowledgeFilesPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const list = [...(input.files ?? [])]
  input.value = ''
  if (!list.length) return
  if (list.length > 20) {
    error.value = '一次最多导入 20 个文件'
    return
  }
  const MAX_FILE = 512 * 1024
  const MAX_TOTAL = 2 * 1024 * 1024
  const oversize = list.find((file) => file.size > MAX_FILE)
  if (oversize) {
    error.value = `${oversize.name} 超过 512KB，请拆分后再导入`
    return
  }
  const total = list.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_TOTAL) {
    error.value = '本次导入总体积超过 2MB，请分批导入'
    return
  }
  await run(async () => {
    const files = await Promise.all(
      list.map(async (file) => ({ name: file.name, text: await file.text() }))
    )
    const result = await window.api.character.knowledge.import(files, knowledgeCategory.value)
    knowledgeHint.value = `已导入 ${result.written.length} 篇：${result.written.join('、')}；重建索引（或等 Obsidian 增量索引）后她才能检索`
    void refreshKnowledgeHealth()
    showToast('知识已写入 Obsidian')
  })
}

async function refreshKnowledgeHealth(): Promise<void> {
  try {
    knowledgeHealth.value = (await window.api.character.knowledge.status()) as KnowledgeHealthView
  } catch {
    knowledgeHealth.value = null
  }
}

async function rebuildKnowledgeIndex(): Promise<void> {
  await run(async () => {
    const result = (await window.api.obsidian.rebuildIndex()) as {
      success?: boolean
      error?: string
    }
    if (!result?.success) {
      error.value = `重建索引失败：${result?.error ?? '未知原因'}`
      return
    }
    knowledgeHint.value = '索引重建完成；如果她仍检索不到，请确认「知识库」页的 Obsidian MCP 已启用'
    void refreshKnowledgeHealth()
    showToast('索引已重建')
  })
}

async function deleteMemory(): Promise<void> {
  askConfirm(
    {
      title: '删除日记与关系记忆',
      message: '删除日记与关系记忆？日记会归档到本机 memory-archive/ 与 Obsidian「大肥鱼/归档」，可手动找回。',
      confirmText: '删除'
    },
    () => deleteCharacterData('memory')
  )
}

async function deleteAll(): Promise<void> {
  askConfirm(
    {
      title: '删除全部角色数据',
      message: '删除全部角色数据（含设置与人格文件）？此操作不可撤销。',
      confirmText: '删除'
    },
    () => deleteCharacterData('all')
  )
}

async function deleteCharacterData(scope: 'memory' | 'all'): Promise<void> {
  await run(async () => {
    const result = await window.api.character.safety.deleteData(scope)
    await refresh()
    if (result.warnings?.length) error.value = result.warnings.join('；')
    else showToast(scope === 'memory' ? '日记与关系记忆已删除（日记已归档）' : '全部角色数据已删除')
  })
}

async function saveOnboarding(): Promise<void> {
  await run(async () => {
    const address = addressDraft.value.trim() || '你'
    const taboo = tabooDraft.value
      .split(/[，,]/)
      .map((x) => x.trim())
      .filter(Boolean)
    await window.api.character.settings.set({
      relationship: { address, mode: modeDraft.value, taboo }
    } as never)
    await refresh()
    showToast('引导设置已保存')
  })
}

async function runBootstrap(): Promise<void> {
  await run(async () => {
    bootstrapReport.value = await window.api.character.bootstrap.run()
    await refresh()
    if (bootstrapReport.value?.ok) showToast('初始化完成')
    else error.value = '初始化有未通过项，下面列出了要补的配置'
  })
}

function onStreamEvent(event: CharacterChatStreamEvent): void {
  // status.chatGen 缓存未对上时（页面刚打开/清空后）先接纳首个事件的代际，避免整轮事件被丢弃
  if (activeGen.value !== event.gen) {
    if (activeGen.value === 0) activeGen.value = event.gen
    else return
  }
  const current = runId.value
  // 清空/结束后旧 run 的迟到事件必须丢弃
  if (!current) return
  if (current !== 'pending' && event.runId !== current) return
  const last = messages.value[messages.value.length - 1]
  if (event.kind === 'chunk') {
    clearSlowTimer()
    if (slowHintShown.value) {
      slowHintShown.value = false
      error.value = ''
    }
    if (last && last.role === 'assistant') last.text += event.text ?? ''
    return
  }
  if (event.kind === 'done') {
    clearSlowTimer()
    if (slowHintShown.value) {
      slowHintShown.value = false
      error.value = ''
    }
    if (last && last.role === 'assistant') {
      last.streaming = false
      if (!last.text) last.text = '……'
    }
    runId.value = ''
    return
  }
  clearSlowTimer()
  if (last && last.role === 'assistant') last.streaming = false
  error.value = event.error || '聊天出错了'
  runId.value = ''
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim()
  if (!text || streaming.value) return
  busy.value = true
  error.value = ''
  draft.value = ''
  messages.value.push({ role: 'user', text })
  messages.value.push({ role: 'assistant', text: '', streaming: true })
  // 先占位，避免首帧 delta 比 send 的返回值更快到达时被丢弃
  runId.value = 'pending'
  clearSlowTimer()
  slowHintShown.value = false
  slowTimer = setTimeout(() => {
    if (!streaming.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant' && !last.text) {
      slowHintShown.value = true
      error.value = '她还没回。首次/隔久后的回复可能因网关或模型冷启动较慢，可以再等等，或点「停止」重发。'
    }
  }, 45000)
  try {
    const result = await window.api.character.chat.send({ text })
    activeGen.value = result.gen
    runId.value = result.runId
    if (cancelPending) {
      cancelPending = false
      await window.api.character.chat.cancel(result.runId).catch(() => undefined)
      markLastDone()
      clearSlowTimer()
    }
  } catch (e) {
    cancelPending = false
    clearSlowTimer()
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && !last.text) messages.value.pop()
    error.value = (e as Error)?.message || '发送失败'
    runId.value = ''
  } finally {
    busy.value = false
  }
}

async function stopStreaming(): Promise<void> {
  const current = runId.value
  if (!current) return
  if (current === 'pending') {
    cancelPending = true
    markLastDone()
    return
  }
  try {
    await window.api.character.chat.cancel(current)
  } catch {
    /* 忽略：可能已自然结束 */
  }
  markLastDone()
}

function markLastDone(): void {
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') last.streaming = false
  runId.value = ''
}

async function clearChat(): Promise<void> {
  await run(async () => {
    const result = await window.api.character.chat.clear()
    activeGen.value = result.gen
    messages.value = []
    runId.value = ''
  })
}

async function interact(kind: 'pat' | 'feed'): Promise<void> {  await run(async () => {
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
  max-width: 900px;
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
  margin-bottom: 8px;
}
.lab {
  width: 120px;
  flex: 0 0 120px;
  font-size: 13px;
  color: var(--text-secondary, #9aa4b8);
}
input,
select {
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
.life-doc {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-primary, #0d121c);
  color: var(--text-primary, #e8ecf4);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.check-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--text-primary, #e8ecf4);
}
.check-row input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
}
.err {
  margin: 0 0 12px;
  color: #ff6b6b;
  font-size: 13px;
}
.toast {
  position: sticky;
  top: 8px;
  z-index: 20;
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(46, 160, 67, 0.16);
  border: 1px solid rgba(46, 160, 67, 0.45);
  color: #7ee2a8;
  font-size: 13px;
}
.link {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #7aa2ff;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.steps {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.steps li {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-primary, #e8ecf4);
}
.steps li.bad .dot,
.steps li.bad .detail {
  color: #ff6b6b;
}
.steps .dot {
  width: 14px;
  color: #4cd07d;
}
.steps .name {
  flex: 0 0 240px;
  color: var(--text-secondary, #9aa4b8);
}
.steps .detail {
  flex: 1;
  word-break: break-all;
}
.chat-log {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.msg {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
}
.msg .who {
  flex: 0 0 34px;
  color: var(--text-secondary, #9aa4b8);
}
.msg.user .text {
  color: #cfe0ff;
}
.msg.assistant .text {
  color: var(--text-primary, #e8ecf4);
  white-space: pre-wrap;
  word-break: break-word;
}
.cursor {
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.memo-editor {
  margin: 10px 0;
  padding: 10px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
}
.memo-text {
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  font: inherit;
  resize: vertical;
}
.memo-title { margin: 14px 0 6px; font-size: 13px; }
.memo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.memo-item { display: flex; align-items: center; gap: 10px; }
.memo-open { background: none; border: none; color: inherit; cursor: pointer; font: inherit; padding: 0; text-decoration: underline; flex: 0 0 auto; }
.memo-item .hint { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0; }
.memo-readonly { white-space: pre-wrap; max-height: 240px; overflow: auto; margin: 8px 0 0; }

.pet-preview {
  width: 160px;
  height: 176px;
  margin: 8px auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pet-preview-art {
  width: 100%;
  height: 100%;
}
.pet-preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

</style>
