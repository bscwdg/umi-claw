<template>
  <div class="page-container">
    <header class="page-head">
      <div>
        <h1>插件管理</h1>
        <p class="text-muted">
          官方内置插件随安装包分发。停用后它的页面、导航与后台任务会立即卸载，数据保留。
        </p>
      </div>
      <button class="btn" :disabled="loading || retryBusy" @click="reload">刷新</button>
    </header>

    <p v-if="retryNotice" class="meta retry-notice">{{ retryNotice }}</p>

    <p v-if="devMode?.plugins" class="dev-banner">
      ⚠️ {{ devMode.warning }}<span v-if="devMode.build"> 已允许源码构建。</span>
    </p>

    <section v-if="isolatedPlugins.length" class="plugin-card">
      <h2 class="section-title">隔离插件（第三方进程）</h2>
      <p v-for="item in isolatedPlugins" :key="item.pluginId" class="meta">
        <strong>{{ item.name }}</strong> {{ item.version }} · {{ item.state }}
      </p>
    </section>

    <section class="plugin-card">
      <h2 class="section-title">第三方插件（.umi-plugin）</h2>
      <p class="meta">安装包需通过 Ed25519 验签；自签包需你明确确认首次安装（TOFU）。</p>
      <div class="actions">
        <p v-if="pendingInspect?.trust === 'self'" class="meta">
          自签指纹：{{ pendingInspect.fingerprint }}（{{ pendingInspect.tofu === 'known' ? '已信任，更新无需再次确认' : '首次安装需确认 TOFU' }}）
        </p>
        <label v-if="pendingInspect?.trust === 'self' && pendingInspect.tofu === 'new'" class="meta">
          <input v-model="selfTrust" type="checkbox" />
          我确认信任该自签密钥（TOFU，首次安装）
        </label>
        <button class="btn" :disabled="installBusy" @click="pickInstall">选择安装包…</button>
        <span v-if="pendingPackage" class="meta">{{ pendingPackage.split(/[\\/]/).pop() }}</span>
        <button
          v-if="pendingPackage"
          class="btn btn-primary"
          :disabled="installBusy || (pendingInspect?.trust === 'self' && pendingInspect.tofu === 'new' && !selfTrust)"
          @click="confirmInstall"
        >
          确认安装{{ pendingInspect?.trust === 'self' ? '（含自签）' : '' }}
        </button>
        <button v-if="pendingPackage" class="btn btn-ghost" :disabled="installBusy" @click="cancelPick">
          取消
        </button>
      </div>
      <p v-if="installNotice" class="meta">{{ installNotice }}</p>
      <p v-if="installError" class="error-line">{{ installError }}</p>
      <div v-for="item in installedList" :key="String(item.id)" class="meta">
        <strong>{{ String(item.name) }}</strong> {{ String(item.version) }} ·
        {{ String(item.trustLevel) }}
        <button v-if="isInstalledRunning(item)" class="btn btn-sm" :disabled="runBusy === String(item.id)" @click="runOnce(item)">
          {{ runBusy === String(item.id) ? '运行中…' : '运行一次' }}
        </button>
        <button v-else class="btn btn-sm" :disabled="startBusy === String(item.id)" @click="startInstalled(item)">
          {{ startBusy === String(item.id) ? '启动中…' : '启动' }}
        </button>
        <button class="btn btn-sm" @click="rollback(item.id)">回滚</button>
        <button class="btn btn-sm" @click="toggleInstalledPermission(item.id)">{{ permissionMap[String(item.id)]?.granted ? '撤销权限' : '授权' }}</button>
        <button class="btn btn-sm btn-danger" @click="uninstall(item.id)">卸载</button>
        <div v-if="schemaFields(item).length" class="config-form">
          <label v-for="field in schemaFields(item)" :key="field.key" class="meta">
            {{ field.label }}（{{ field.type }}）
            <select v-if="field.enumValues.length" v-model="configValues[String(item.id)][field.key]" class="input"><option v-for="v in field.enumValues" :key="String(v)" :value="v">{{ v }}</option></select><input v-else-if="field.type === 'boolean'" v-model="configValues[String(item.id)][field.key]" type="checkbox" /><input v-else v-model="configValues[String(item.id)][field.key]" class="input" :type="field.type === 'number' ? 'number' : 'text'" />
          </label>
          <button class="btn btn-sm" @click="saveConfig(item.id)">保存配置</button>
        </div>
      </div>
    </section>

    <p v-if="loadError" class="error-banner">
      {{ loadError }}
      <button class="btn btn-sm" @click="reload">重试</button>
    </p>

    <div v-if="!plugins.length && !loading && !loadError" class="empty">
      没有已登记的插件。把插件放到 <code>resources/plugins/&lt;id&gt;/</code> 并重新构建即可。
    </div>

    <!-- 宿主模块：内置在宿主里的能力，不参与插件装卸；这里只做统一入口 -->
    <h2 class="section-title">宿主模块</h2>
    <section class="plugin-card host-module-card">
      <div class="card-head">
        <div class="titles">
          <strong>🐟 大肥鱼</strong>
          <span class="text-muted">宿主模块 · 角色 M1</span>
        </div>
        <span class="state" :class="characterEnabled ? 'state-activated' : ''">
          {{ characterStateLabel }}
        </span>
      </div>

      <p class="meta">
        人格 / 聊天 / 关系 / 记忆 / 语音内置在宿主主进程，不随插件启停；
        自检 {{ characterReadyCount }}/{{ CHARACTER_CHECKS.length }} 项就绪。
      </p>

      <p v-if="characterError" class="error-line">{{ characterError }}</p>
      <p v-if="characterNotice" class="meta">{{ characterNotice }}</p>

      <div class="actions">
        <button
          class="btn"
          :class="{ 'btn-danger': characterEnabled, 'btn-primary': !characterEnabled }"
          :disabled="characterBusy || !characterStatus"
          @click="toggleCharacter"
        >
          {{ characterBusy ? '处理中…' : characterEnabled ? '停用' : '启用' }}
        </button>
        <router-link v-if="characterEnabled" class="btn btn-ghost" to="/character">
          打开页面
        </router-link>
        <button
          v-else
          class="btn btn-ghost"
          :disabled="characterBusy || !characterStatus"
          @click="enableAndOpen"
        >
          启用并打开
        </button>
        <button
          class="btn btn-ghost"
          :disabled="characterBusy || !characterStatus || !characterEnabled"
          @click="initCharacter"
        >
          一键初始化
        </button>
      </div>
    </section>

    <section v-for="p in list" :key="p.id" class="plugin-card">
      <div class="card-head">
        <div class="titles">
          <strong>{{ p.name }}</strong>
          <span class="text-muted">{{ p.id }} · v{{ p.version }}</span>
        </div>
        <span class="state" :class="'state-' + p.state">{{ stateLabel(p) }}</span>
      </div>

      <p class="meta">
        通道 {{ p.ipcMethods.length + (p.channels?.length ?? 0) }} 个 · 定时任务 {{ p.jobCount }} 个
        <template v-if="p.contributes?.routes?.length">
          · 页面 {{ p.contributes.routes.join('、') }}
        </template>
      </p>

      <p v-if="p.error" class="error-line">{{ errorSummary(p) }}</p>

      <div v-if="permissionMap[p.id]" class="actions">
        <span class="text-muted">
          权限：{{ permissionMap[p.id].granted ? '已授权' : '未授权' }}
        </span>
        <button class="btn btn-ghost" :disabled="busy === p.id" @click="togglePermission(p)">
          {{ permissionMap[p.id].granted ? '撤销权限' : '授权' }}
        </button>
      </div>

      <div class="actions">
        <button
          class="btn"
          :class="{ 'btn-danger': p.enabled, 'btn-primary': !p.enabled }"
          :disabled="busy === p.id || enableBlocked(p)"
          @click="toggle(p)"
        >
          {{ busy === p.id ? '处理中…' : buttonText(p) }}
        </button>
        <!-- 5.0：运行时失败（如启动时便携 Node 还没就绪）直接给重试入口，
             不再要求用户先停用再启用。尺寸档跟同排「停用/启用」一致（默认档），
             同一按钮区不允许混尺寸（docs/ui-style-guide.md §2.6/§3.1） -->
        <button
          v-if="failedRetryable(p)"
          class="btn"
          :disabled="retryBusy || busy === p.id"
          @click="retryFailedOne(p)"
        >
          {{ retryBusy ? '重试中…' : '重试加载' }}
        </button>
        <router-link v-if="openableRoute(p)" class="btn btn-ghost" :to="openableRoute(p)">
          打开页面
        </router-link>
      </div>
    </section>

    <ConfirmDialog
      v-model:visible="confirmVisible"
      icon="⚠️"
      title="停用插件"
      confirm-text="停用"
      cancel-text="取消"
      danger
      @confirm="confirmDisable"
      @cancel="cancelDisable"
    >
      <p class="modal-message">{{ confirmMessage }}</p>
    </ConfirmDialog>

    <!-- 大肥鱼是宿主模块而不是插件，但它和插件卡片共用同一套宿主交互：
         停用确认也必须走 ConfirmDialog，不能再用原生 window.confirm（样式/层级不一致）。 -->
    <ConfirmDialog
      v-model:visible="characterConfirmVisible"
      icon="⚠️"
      title="停用大肥鱼"
      confirm-text="停用"
      cancel-text="取消"
      danger
      @confirm="confirmDisableCharacter"
      @cancel="cancelDisableCharacter"
    >
      <p class="modal-message">停用后主动消息、日记会自动停止；关系与日记数据保留。确定停用大肥鱼？</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'
import type { PluginStatus } from '../../electron/main/kernel/lifecycle'
import type { CharacterStatus } from '../../electron/main/character/types'
import {
  errorSummary,
  normalizeListPayload,
  openableRoute,
  shouldConfirmDisable,
  sortForDisplay,
  stateLabel
} from '@/renderer/pluginAdmin'

const plugins = ref<PluginStatus[]>([])
const permissionMap = ref<Record<string, { granted: boolean; requested: unknown }>>({})
const loading = ref(false)
const loadError = ref('')
/** 「重试加载」是否在执行（主进程一次重试所有 failed 插件，全局一个 busy） */
const retryBusy = ref(false)
const retryNotice = ref('')
const devMode = ref<{ plugins: boolean; build: boolean; reason: string; warning: string | null } | null>(null)
const isolatedPlugins = ref<Array<{ pluginId: string; name: string; version: string; state: string }>>([])
const installed = ref<{ schema: 1; plugins: Record<string, Record<string, unknown>> }>({ schema: 1, plugins: {} })
const installedList = computed(() => Object.values(installed.value.plugins ?? {}))
const configValues = ref<Record<string, Record<string, unknown>>>({})
/** 「运行一次」正在执行的插件 id（防连点） */
const runBusy = ref('')
/** 「启动/重试」正在执行的插件 id（防连点） */
const startBusy = ref('')
/** 隔离子进程状态表：id 不在表里 = 没有进程（相当于 stopped） */
const isolatedStateById = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const item of isolatedPlugins.value) map[item.pluginId] = item.state
  return map
})
/** running 才给「运行一次」；其它状态给「启动」（恢复入口） */
function isInstalledRunning(item: Record<string, unknown>): boolean {
  return isolatedStateById.value[String(item.id)] === 'running'
}
function schemaFields(item: Record<string, unknown>): Array<{ key: string; label: string; type: string; enumValues: unknown[] }> {
  const schema = item.configSchema as { properties?: Record<string, { type?: string; title?: string; enum?: unknown[] }> } | undefined
  return Object.entries(schema?.properties ?? {}).map(([key, value]) => ({ key, label: value.title ?? key, type: value.type ?? 'string', enumValues: value.enum ?? [] }))
}
async function saveConfig(id: unknown): Promise<void> {
  installError.value = ''
  installNotice.value = ''
  try {
    const saved = await window.api.plugins.setConfig(String(id), configValues.value[String(id)] ?? {})
    // 保存可能把进程停掉（重启失败 / 非 running 不重启）：刷新状态，让卡片切到「启动」恢复入口
    await loadIsolated()
    // warning 可能是「重启失败」或「当前非 running、配置未生效」两种语义，
    // 不能统一写成「重启失败」——后者根本没发起重启。原样拼在「配置已保存：」后面。
    installNotice.value =
      saved?.restarted === false && saved?.warning
        ? `配置已保存：${String(saved.warning)}`
        : '配置已保存'
  } catch (e) {
    installError.value = (e as Error)?.message ?? '保存配置失败'
  }
}

/** 运行结果展示：字符串直出，其余 JSON 截断，避免把整块返回值塞进提示行 */
function formatRunResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

/**
 * 「运行一次」：给无 UI 的第三方插件一个手动触发入口（约定 registerIpc('run', ...)）。
 * 已安装插件都是隔离子进程，方法只能经 plugin:isolated:invoke 调；`plugin:<id>:<method>`
 * 是官方 builtin 插件的 in-process 通道，隔离子进程没有宿主侧 handler。
 *
 * 必须用 invokeIsolatedEnvelope 拿原始信封：contextIsolation 下 contextBridge 跨桥只保留
 * Error 的 message/name，preload 抛出的自定义 e.code 会丢（electron#25596），
 * 按 e.code 分支在真实渲染进程里是死代码。
 */
async function runOnce(item: Record<string, unknown>): Promise<void> {
  const id = String(item.id)
  installNotice.value = ''
  installError.value = ''
  runBusy.value = id
  try {
    const res = await window.api.plugins.invokeIsolatedEnvelope(id, 'run')
    if (res.ok) {
      installNotice.value = `「${String(item.name)}」运行结果：${formatRunResult(res.data)}`
    } else if (res.error?.code === 'PLUGIN_NOT_FOUND') {
      // PLUGIN_NOT_FOUND = 插件没有注册 run 方法
      installError.value = 'PLUGIN_NOT_FOUND：该插件未提供 run 方法'
    } else {
      installError.value = res.error?.code
        ? `${res.error.code}：${res.error.message ?? '运行失败'}`
        : res.error?.message ?? '运行失败'
    }
  } catch (e) {
    // IPC 通道本身失败（主进程异常等）仍兜底；不依赖跨桥后会丢的自定义错误属性
    installError.value = (e as Error)?.message ?? '运行失败'
  } finally {
    runBusy.value = ''
  }
}

/**
 * 「启动/重试」：保存配置重启失败、或 supervisor 熔断后，隔离进程会停在 stopped；
 * 之前只能重启 App 才能恢复，这里给一个宿主侧恢复入口（走 plugin:isolated:start）。
 */
async function startInstalled(item: Record<string, unknown>): Promise<void> {
  const id = String(item.id)
  installNotice.value = ''
  installError.value = ''
  startBusy.value = id
  try {
    // 原始信封：contextBridge 会丢 Error 自定义属性，不能依赖跨桥后的错误属性
    const res = await window.api.plugins.startInstalledEnvelope(id)
    if (!res.ok) {
      const code = res.error?.code
      installError.value = code
        ? `${code}：${res.error.message ?? '启动失败'}`
        : res.error?.message ?? '启动失败'
      return
    }
    await Promise.all([loadInstalled(), loadIsolated()])
    installNotice.value = `「${String(item.name)}」已启动`
  } catch (e) {
    installError.value = (e as Error)?.message ?? '启动失败'
  } finally {
    startBusy.value = ''
  }
}
const pendingPackage = ref('')
const pendingInspect = ref<{ id: string; version: string; trust: string; fingerprint: string; tofu: 'new' | 'known' } | null>(null)
const selfTrust = ref(false)
const installBusy = ref(false)
const installNotice = ref('')
const installError = ref('')
const diagnostics = ref<{ installed: number; backups: number; auditLines: number } | null>(null)
const busy = ref('')
const confirmVisible = ref(false)
const confirmMessage = ref('')
let pendingDisable: PluginStatus | null = null
let unsubscribe: (() => void) | null = null
let disposed = false

const list = computed(() => sortForDisplay(plugins.value))

// ── 宿主模块：大肥鱼（内置在宿主里，不参与插件装卸；复用 character:* 通道） ──
const CHARACTER_CHECKS = [
  { key: 'agentReady', label: 'agent 配置' },
  { key: 'gatewayReady', label: '网关' },
  { key: 'obsidianReady', label: 'Obsidian' },
  { key: 'qqReady', label: '外部渠道' },
  { key: 'ttsReady', label: 'TTS' },
  { key: 'memorySearchReady', label: '记忆检索' }
] as const

const characterStatus = ref<CharacterStatus | null>(null)
const characterBusy = ref(false)
const characterError = ref('')
const characterNotice = ref('')
const characterConfirmVisible = ref(false)
const router = useRouter()
const characterEnabled = computed(() => Boolean(characterStatus.value?.enabled))
const characterStateLabel = computed(() => {
  if (!characterStatus.value) return '状态未知'
  return characterStatus.value.enabled ? '已启用' : '未启用'
})
const characterReadyCount = computed(() => {
  const status = characterStatus.value as Record<string, unknown> | null
  if (!status) return 0
  return CHARACTER_CHECKS.filter((check) => Boolean(status[check.key])).length
})

async function loadCharacter(): Promise<void> {
  try {
    characterStatus.value = await window.api.character.status()
    characterError.value = ''
  } catch (e) {
    characterError.value = `读取大肥鱼状态失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function toggleCharacter(): Promise<void> {
  if (characterBusy.value) return
  if (!characterEnabled.value) {
    await applyCharacterToggle(true)
    return
  }
  // 停用会停掉她的后台主动消息 / 日记任务：破坏性操作走宿主统一的 ConfirmDialog
  characterConfirmVisible.value = true
}

function cancelDisableCharacter(): void {
  characterConfirmVisible.value = false
}

async function confirmDisableCharacter(): Promise<void> {
  characterConfirmVisible.value = false
  await applyCharacterToggle(false)
}

async function applyCharacterToggle(next: boolean): Promise<void> {
  if (characterBusy.value) return
  characterBusy.value = true
  characterError.value = ''
  characterNotice.value = ''
  try {
    await window.api.character.settings.set({ enabled: next } as never)
    await loadCharacter()
    if (!characterStatus.value) {
      characterNotice.value = '已提交，但读取状态失败，请点「刷新」确认'
      return
    }
    characterNotice.value = next ? '已启用；建议点「一键初始化」补齐配置' : '已停用（数据保留）'
  } catch (e) {
    characterError.value = `操作失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    characterBusy.value = false
  }
}

/** 打开角色页：懒加载失败要反馈，不能静默「启用成功但没页面」 */
function openCharacterPage(): void {
  void router.push('/character').catch((e: unknown) => {
    characterError.value = `页面打开失败：${e instanceof Error ? e.message : String(e)}`
  })
}

/** 停用状态下不做「静默打开」：先启用再进页面，语义与侧栏隐藏保持一致 */
async function enableAndOpen(): Promise<void> {
  if (characterBusy.value) return
  if (characterEnabled.value) {
    openCharacterPage()
    return
  }
  characterBusy.value = true
  characterError.value = ''
  try {
    await window.api.character.settings.set({ enabled: true } as never)
    await loadCharacter()
    if (characterStatus.value?.enabled) {
      openCharacterPage()
    } else {
      characterNotice.value = '未能确认启用状态，请点「刷新」后再试'
    }
  } catch (e) {
    characterError.value = `启用失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    characterBusy.value = false
  }
}

async function initCharacter(): Promise<void> {
  characterBusy.value = true
  characterError.value = ''
  characterNotice.value = ''
  try {
    const report = await window.api.character.bootstrap.run()
    const failed = report.steps.filter((step) => !step.ok).length
    characterNotice.value = report.ok
      ? '初始化完成'
      : `初始化有 ${failed} 项未通过，去「大肥鱼」页查看并去配置`
    await loadCharacter()
  } catch (e) {
    characterError.value = `初始化失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    characterBusy.value = false
  }
}

/** 清单级失败不能靠「启用」复活，按钮直接禁用；运行时失败允许重试 */
function enableBlocked(status: PluginStatus): boolean {
  return !status.enabled && status.error?.stage === 'manifest'
}

/**
 * 可手动「重试加载」的失败：启用 + 运行时失败（5.0）。
 * 清单级失败（stage=manifest）要重新构建，重试没有意义（enableBlocked 已挡住启用按钮）。
 */
function failedRetryable(status: PluginStatus): boolean {
  return status.enabled && status.state === 'failed' && status.error?.stage !== 'manifest'
}

/**
 * 重试「启用但加载失败」的插件。
 *
 * 原实现只能先停用再启用；环境初始化（便携 Node 就位）后仍 failed 的插件没有任何重试入口。
 * 主进程 plugin:retryFailed 会先清插件库缓存再重新激活，返回最新全量状态。
 */
async function retryFailedPlugins(preparing?: string): Promise<void> {
  retryBusy.value = true
  retryNotice.value = preparing ?? ''
  try {
    plugins.value = normalizeListPayload(await window.api.plugins.retryFailed())
    const stillFailed = plugins.value.filter(failedRetryable)
    retryNotice.value = stillFailed.length
      ? `已重试加载，仍有 ${stillFailed.length} 个插件失败：${stillFailed.map((p) => p.id).join('、')}`
      : ''
  } catch (e) {
    loadError.value = `重试加载失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    retryBusy.value = false
  }
}

function retryFailedOne(status: PluginStatus): void {
  if (retryBusy.value || busy.value) return
  // 主进程 API 一次重试所有 failed 插件（不区分单卡），提示语不能写成只重试这一张
  void retryFailedPlugins(`正在重试加载失败插件（含「${status.name}」）…`)
}

function buttonText(status: PluginStatus): string {
  if (status.enabled) return '停用'
  return status.state === 'failed' ? '重试启用' : '启用'
}

async function reload(): Promise<void> {
  loading.value = true
  loadError.value = ''
  retryNotice.value = ''
  try {
    plugins.value = normalizeListPayload(await window.api.plugins.list())
  } catch (e) {
    loadError.value = `读取插件列表失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    loading.value = false
  }
  // 5.0：存在「启用但加载失败」的插件时，刷新顺手重试一次激活。
  // 典型场景：启动时便携 Node 未就绪导致 work/marketing failed，完成环境初始化后
  // 旧实现只能重启 App；现在刷新即可恢复（env 任务成功后主进程也会自动重试）。
  if (!loadError.value && plugins.value.some(failedRetryable)) {
    await retryFailedPlugins()
  }
  // 「刷新」同时重载角色状态：初始化慢/刚失败时卡片不能变成永久「状态未知」死路
  await loadCharacter()
}

async function loadPermissions(): Promise<void> {
  try {
    const rows = await window.api.plugins.permissions()
    const next: Record<string, { granted: boolean; requested: unknown }> = {}
    for (const row of rows) {
      if (row.requested) next[row.id] = { granted: row.granted, requested: row.requested }
    }
    permissionMap.value = next
  } catch {
    // 权限读取失败不影响插件列表；默认不展示权限区
    permissionMap.value = {}
  }
}

async function loadDevMode(): Promise<void> {
  try {
    devMode.value = await window.api.plugins.devMode()
  } catch {
    devMode.value = null
  }
}

async function loadIsolated(): Promise<void> {
  try {
    isolatedPlugins.value = await window.api.plugins.isolatedStatuses()
  } catch {
    isolatedPlugins.value = []
  }
}

async function loadInstalled(): Promise<void> {
  try {
    installed.value = await window.api.plugins.installed()
    for (const [id] of Object.entries(installed.value.plugins ?? {})) {
      configValues.value[id] = await window.api.plugins.getConfig(id).catch(() => ({}))
    }
  } catch {
    installed.value = { schema: 1, plugins: {} }
  }
}

async function pickInstall(): Promise<void> {
  if (installBusy.value) return
  installError.value = ''
  installNotice.value = ''
  // 重选/取消时必须把旧待装包一起清掉：否则 pendingPackage 还在、pendingInspect 已清，
  // 确认按钮会绕过 TOFU（自签）或装到没验签的旧包（官方）。
  cancelPick()
  installBusy.value = true
  try {
    const file = await window.api.plugins.pickPackage()
    // 取消是正常路径：IPC 回 {ok:true,data:null}，不弹错误
    if (!file) return
    // 先验签再看安装：自签包必须先把指纹摆到界面上，勾选确认才叫「明确确认」（TOFU）
    pendingInspect.value = await window.api.plugins.inspectPackage(file)
    pendingPackage.value = file
  } catch (e) {
    installError.value = (e as Error)?.message ?? '选择安装包失败'
  } finally {
    installBusy.value = false
  }
}

function cancelPick(): void {
  pendingPackage.value = ''
  pendingInspect.value = null
  selfTrust.value = false
}

async function confirmInstall(): Promise<void> {
  if (installBusy.value) return
  // 两个状态必须同时存在：pendingInspect 缺失说明这包没验签（重选/取消清过），宁可不装
  if (!pendingPackage.value || !pendingInspect.value) return
  const inspect = pendingInspect.value
  const needTrust = inspect.trust === 'self' && inspect.tofu === 'new'
  if (needTrust && !selfTrust.value) {
    installError.value = '自签包需先勾选确认信任该密钥（TOFU）'
    return
  }
  installBusy.value = true
  installError.value = ''
  installNotice.value = ''
  try {
    const result = (await window.api.plugins.install(pendingPackage.value, {
      allowSelfSigned: inspect.trust === 'self' && (inspect.tofu === 'known' || selfTrust.value),
      tofuFingerprint: inspect.fingerprint
    })) as { started?: boolean; warning?: string }
    cancelPick()
    installNotice.value = result?.started === false
      ? '安装完成，但隔离插件启动失败：' + (result.warning ?? '未知原因')
      : '安装完成；隔离插件已按安装态启动。'
    await Promise.all([loadInstalled(), loadIsolated()])
  } catch (e) {
    installError.value = (e as Error)?.message ?? '安装失败'
  } finally {
    installBusy.value = false
  }
}

async function toggleInstalledPermission(id: unknown): Promise<void> {
  try {
    if (permissionMap.value[String(id)]?.granted) await window.api.plugins.revokePermissions(String(id))
    else await window.api.plugins.grantPermissions(String(id))
    await loadPermissions()
  } catch (e) {
    installError.value = (e as Error)?.message ?? '权限操作失败'
  }
}

async function rollback(id: unknown): Promise<void> {
  installError.value = ''
  try {
    await window.api.plugins.rollback(String(id))
    installNotice.value = '已回滚到上一版本。'
    await Promise.all([loadInstalled(), loadIsolated()])
  } catch (e) {
    installError.value = (e as Error)?.message ?? '回滚失败'
  }
}

async function uninstall(id: unknown): Promise<void> {
  installError.value = ''
  try {
    await window.api.plugins.uninstall(String(id), true)
    installNotice.value = '已卸载，数据保留。'
    await Promise.all([loadInstalled(), loadIsolated()])
  } catch (e) {
    installError.value = (e as Error)?.message ?? '卸载失败'
  }
}

async function togglePermission(status: PluginStatus): Promise<void> {
  busy.value = status.id
  try {
    if (permissionMap.value[status.id]?.granted) {
      await window.api.plugins.revokePermissions(status.id)
    } else {
      await window.api.plugins.grantPermissions(status.id)
    }
    await loadPermissions()
  } catch (e) {
    loadError.value = `权限操作失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = ''
  }
}

async function applyToggle(status: PluginStatus, enabled: boolean): Promise<void> {
  busy.value = status.id
  try {
    plugins.value = normalizeListPayload(await window.api.plugins.setEnabled(status.id, enabled))
  } catch (e) {
    loadError.value = `操作失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = ''
  }
}

async function toggle(status: PluginStatus): Promise<void> {
  if (!status.enabled) {
    await applyToggle(status, true)
    return
  }
  if (shouldConfirmDisable(status)) {
    pendingDisable = status
    confirmMessage.value = `「${status.name}」正在运行，停用后它的页面会被关闭。确定停用？`
    confirmVisible.value = true
    return
  }
  await applyToggle(status, false)
}

async function confirmDisable(): Promise<void> {
  confirmVisible.value = false
  const target = pendingDisable
  pendingDisable = null
  if (!target) return
  await applyToggle(target, false)
}

function cancelDisable(): void {
  pendingDisable = null
  confirmVisible.value = false
}

onMounted(async () => {
  unsubscribe = window.api.plugins.onChanged((next: PluginStatus[]) => {    try {
      plugins.value = normalizeListPayload(next)
    } catch {
      // 推送不合法就保持现状，等用户手动刷新
    }
  })
  if (disposed) {
    unsubscribe?.()
    unsubscribe = null
    return
  }
  await reload()
  await loadPermissions()
  await loadDevMode()
  await loadIsolated()
  await loadInstalled()
  diagnostics.value = await window.api.plugins.diagnostics().catch(() => null)
})

onUnmounted(() => {
  disposed = true
  unsubscribe?.()
  unsubscribe = null
})
</script>

<style scoped>
/* .page-head 布局吃全局类，这里只补本页标题与卡片的间距 */
.page-head {
  margin-bottom: var(--space-4);
}
.plugin-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-3);
  background: var(--bg-surface);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.titles {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.meta {
  margin: var(--space-2) 0 var(--space-3);
  color: var(--text-muted);
  font-size: var(--text-sm);
}
/* 重试加载提示用正文色：失败仍在时用户要能注意到（不像普通 meta 那样淡化） */
.retry-notice {
  color: var(--text-primary);
}
/* 状态徽标与全局 .badge 同构；保留 state-* 动态类名（取值来自插件生命周期），色值吃语义 token */
.state {
  font-size: var(--text-xs);
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--info-muted);
  color: var(--info);
}
.state-failed {
  background: var(--danger-muted);
  color: var(--danger);
}
.state-activated {
  background: var(--success-muted);
  color: var(--success);
}
.error-line {
  color: var(--danger);
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
}
.error-banner {
  color: var(--danger);
  margin-bottom: var(--space-3);
}
.dev-banner {
  color: var(--warning, var(--danger));
  margin-bottom: var(--space-3);
}
.empty {
  color: var(--text-muted);
  padding: var(--space-6) 0;
}
.actions {
  display: flex;
  gap: var(--space-2);
}
.section-title {
  margin: var(--space-4) 0 var(--space-3);
  font-size: var(--text-md);
  color: var(--text-muted);
  font-weight: 600;
}
.host-module-card {
  border-style: dashed;
}
</style>
