<template>
  <div class="dashboard">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>控制台</h1>
        <p class="text-muted text-sm" style="margin-top:4px">管理 OpenClaw 服务状态</p>
      </div>
      <div class="flex gap-2">
        <button class="btn" @click="openWeb" :disabled="!clawStore.running">
          🌐 打开 Web 界面
        </button>
      </div>
    </div>

    <!-- Status Card -->
    <div class="status-card" :class="{ running: clawStore.running }">
      <div class="status-main">
        <div class="status-icon">{{ clawStore.running ? '🟢' : '🔴' }}</div>
        <div class="status-info">
          <div class="status-title">
            OpenClaw {{ clawStore.running ? '运行中' : '已停止' }}
          </div>
          <div class="status-sub text-muted text-sm">
            <template v-if="clawStore.running">
              PID: {{ clawStore.pid }} · 端口: {{ clawStore.port }} · 运行时长: {{ clawStore.uptime || '--' }}
            </template>
            <template v-else>
              服务未运行，点击「启动」开始使用
            </template>
          </div>
        </div>
      </div>

      <div class="status-actions flex gap-2">
        <button
        v-if="!clawStore.running"
        class="btn btn-success btn-lg"
        @click="handleStart"
        :disabled="actionLoading"
        >
        {{ actionLoading ? '启动中...' : '▶ 启动' }}
      </button>
      <template v-else>
          <button class="btn btn-success btn-lg" @click="handleFetchToken" :disabled="loading && actionLoading">
            {{ loading ? '正在获取...' : '获取 Token(网关令牌)' }}
          </button>
          <button class="btn btn-danger" @click="handleStop" :disabled="actionLoading">
            {{ actionLoading ? '停止中...' : '⏹ 停止' }}
          </button>
          <button class="btn" @click="handleRestart" :disabled="actionLoading">
            🔄 重启
          </button>
        </template>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="errorMsg" class="error-banner">
      ⚠️ {{ errorMsg }}
    </div>

    <!-- 2.0 营销卡（Commit 01 占位，数据接入见 Commit 03/04） -->
    <div class="marketing-grid">
      <div class="card marketing-card">
        <div class="marketing-head">
          <span class="marketing-icon">🏪</span>
          <div>
            <div class="marketing-title">当前商家</div>
            <div class="text-sm text-muted">Business Brain</div>
          </div>
          <span v-if="marketing.currentProject" class="badge badge-green">进行中</span>
        </div>

        <div v-if="marketing.currentProject" class="marketing-body">
          <div class="biz-name">
            {{ marketing.currentProject.name }}
            <span v-if="marketing.currentProject.industry" class="badge">
              {{ marketing.currentProject.industry }}
            </span>
          </div>
          <div class="text-sm text-muted">
            {{ marketing.currentProject.description || '还没有描述 —— 去商家大脑补充定位与客群，AI 才会更懂你' }}
          </div>
          <div class="text-sm text-muted" style="margin-top:6px">
            共 {{ marketing.projects.length }} 个商家 · 创建于 {{ formatDate(marketing.currentProject.created_at) }}
          </div>
        </div>
        <div v-else class="marketing-body text-sm text-muted">
          还没有选择商家。每个商家 = 一个独立工作空间（资料 / 知识库 / 内容互相隔离）。
        </div>

        <div class="marketing-actions">
          <button class="btn btn-sm btn-primary" @click="switcher.show()">
            {{ marketing.currentProject ? '切换 / 新建商家' : '＋ 新建商家' }}
          </button>
          <button
            class="btn btn-sm"
            :disabled="!marketing.currentProject"
            @click="router.push('/marketing/business')"
          >
            打开商家大脑
          </button>
        </div>
      </div>

      <div class="card marketing-card">
        <div class="marketing-head">
          <span class="marketing-icon">✨</span>
          <div>
            <div class="marketing-title">AI 营销</div>
            <div class="text-sm text-muted">AI 顾问 / 内容中心 / 🔥 热点雷达</div>
          </div>
        </div>
        <div class="marketing-body text-sm text-muted">
          已上线：AI 顾问问答、内容中心三版生成、热点雷达与 AI 商家匹配评分。
        </div>
        <div class="marketing-actions">
          <button class="btn btn-sm" @click="router.push('/marketing/advisor')">AI 顾问</button>
          <button class="btn btn-sm" @click="router.push('/marketing/content')">内容中心</button>
          <button class="btn btn-sm" @click="router.push('/marketing/hot')">🔥 热点雷达</button>
        </div>
      </div>
    </div>

    <!-- Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card card">
        <div class="stat-icon">🤖</div>
        <div class="stat-value">{{ activeProviderName }}</div>
        <div class="stat-label text-muted text-sm">当前模型</div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">🧩</div>
        <div class="stat-value">{{ skillCount }}</div>
        <div class="stat-label text-muted text-sm">已安装技能</div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">🔌</div>
        <div class="stat-value">:{{ clawStore.port }}</div>
        <div class="stat-label text-muted text-sm">服务端口</div>
      </div>
      <div class="stat-card card" style="cursor:pointer" @click="router.push('/logs')">
        <div class="stat-icon">📋</div>
        <div class="stat-value">{{ clawStore.logs.length }}</div>
        <div class="stat-label text-muted text-sm">日志条数 →</div>
      </div>
    </div>

    <!-- Recent Logs Preview -->
    <div class="card" style="margin-top:24px">
      <div class="flex items-center justify-between" style="margin-bottom:12px">
        <h3>最新日志</h3>
        <button class="btn btn-sm" @click="router.push('/logs')">查看全部</button>
      </div>
      <div class="log-preview" ref="logPreviewRef">
        <div
          v-for="(entry, i) in recentLogs"
          :key="i"
          class="log-line"
          :class="entry.type"
        >
          <span class="log-time">{{ formatTime(entry.time) }}</span>
          <span class="log-text">{{ entry.line }}</span>
        </div>
        <div v-if="!recentLogs.length" class="text-muted text-sm" style="padding:12px">
          暂无日志
        </div>
      </div>
    </div>

    <!-- Quick Links -->
    <div class="quick-links">
      <a class="quick-link card" @click="shell.openExternal('http://localhost:' + clawStore.port)">
        <span>🌐</span><span>Web 控制台</span>
      </a>
      <a class="quick-link card" @click="router.push('/config')">
        <span>⚙️</span><span>模型配置</span>
      </a>
      <a class="quick-link card" @click="router.push('/skills')">
        <span>🧩</span><span>技能管理</span>
      </a>
      <a class="quick-link card" @click="api.config.openDataDir()">
        <span>📁</span><span>数据目录</span>
      </a>
    </div>
    <!-- Toast -->
    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useClawStore } from '@/stores/claw'
import { useConfigStore } from '@/stores/config'
import { useMarketingStore } from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const clawStore = useClawStore()
const configStore = useConfigStore()
const marketing = useMarketingStore()
const switcher = useProjectSwitcher()
const api = window.api
const shell = window.api.shell
const loading = ref(false)

const actionLoading = ref(false)
const errorMsg = ref('')
const skillCount = ref(0)
const logPreviewRef = ref<HTMLDivElement>()
const { toast, showToast } = useToast()

const activeProviderName = computed(() => {
  const p = configStore.config?.providers.find(
    (p) => p.id === configStore.config?.activeProvider
  )
  return p ? p.name : '--'
})

const recentLogs = computed(() => clawStore.logs.slice(-20))

watch(recentLogs, () => {
  nextTick(() => {
    if (logPreviewRef.value) {
      logPreviewRef.value.scrollTop = logPreviewRef.value.scrollHeight
    }
  })
})

async function handleStart() {
  // 先去读取激活的模型api看是否存在不存在则失败
  const activeApi = configStore.config?.providers.find(
    (p) => p.id === configStore.config?.activeProvider
  )?.apiKey
  if(!activeApi){
    errorMsg.value = '启动失败,请先初始化环境并到模型配置配置激活模型的apiKey'
    return
  }
  actionLoading.value = true
  errorMsg.value = ''
  const result = await clawStore.start()
  if (!result.success) errorMsg.value = result.error || '启动失败'
  else if (result.warning) showToast(result.warning, 'warning')
  actionLoading.value = false
}

async function handleStop() {
  actionLoading.value = true
  const result = await clawStore.stop()
  if (!result.success) errorMsg.value = result.error || '停止失败'
  actionLoading.value = false
}

async function handleRestart() {
  actionLoading.value = true
  errorMsg.value = ''
  const result = await clawStore.restart()
  if (!result.success) errorMsg.value = result.error || '重启失败'
  else if (result.warning) showToast(result.warning, 'warning')
  actionLoading.value = false
}

function openWeb() {
  api.claw.openWeb()
}
async function handleFetchToken() {
  loading.value = true
  try {
    // 调用 Electron 桥接 API
    const res = await window.api.claw.getToken()
    
    if (res.success && res.token) {
      
      
      // ⚡️ 4. 核心新增：自动将 Token 写入系统剪贴板
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(res.token)
        showToast('Token 自动同步成功，并已直接复制到剪贴板！📋','success')
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = res.token
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        showToast('Token 自动同步成功，并已复制到剪贴板！📋','success')
      }
      // showToast('Token 自动同步并保存成功！', 'success')
    } else {
      errorMsg.value = `获取失败: ${res.error || '未知错误'}`
    }
  } catch (error: any) {
    errorMsg.value = `通信异常: ${error.message}`
  } finally {
    loading.value = false
  }
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDate(ts: number) {
  if (!ts) return '--'
  return new Date(ts).toLocaleDateString('zh-CN')
}

// Commit 03：当前商家卡片读真实数据（侧边栏切换器挂载时也会 load，这里只补空数据兜底）
onMounted(() => {
  if (!marketing.projects.length) marketing.load()
})

// 加载技能数量：与「技能管理」页同源，统计便携式 skills 目录下扫描到的技能总数
window.api.skills.getInstalledSkills().then((s) => (skillCount.value = s.length))
</script>

<style scoped>
.dashboard { display: flex; flex-direction: column; gap: 20px; width: 100%; }

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

/* Status Card */
.status-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px;
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  transition: all 0.3s;
}
.status-card.running {
  border-color: rgba(63,185,80,0.35);
  background: linear-gradient(135deg, rgba(63,185,80,0.06) 0%, var(--bg-surface) 60%);
}
.status-main { display: flex; align-items: center; gap: 16px; }
.status-icon { font-size: 36px; }
.status-title { font-size: 18px; font-weight: 600; }

/* Error */
.error-banner {
  padding: 10px 16px;
  background: rgba(248,81,73,0.1);
  border: 1px solid rgba(248,81,73,0.3);
  border-radius: var(--radius-sm);
  color: var(--red);
  font-size: 13px;
}

/* Stats */
.marketing-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.marketing-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
}
.marketing-head { display: flex; align-items: center; gap: 10px; }
.marketing-icon { font-size: 22px; }
.marketing-title { font-size: 15px; font-weight: 600; }
.marketing-body { line-height: 1.6; flex: 1; }
.biz-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}
.marketing-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px;
  text-align: center;
  transition: all 0.15s;
}
.stat-card:hover { border-color: var(--accent); }
.stat-icon { font-size: 20px; }
.stat-value { font-size: 16px; font-weight: 600; }

/* Log Preview */
.log-preview {
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  height: 160px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
}
.log-line {
  display: flex;
  gap: 10px;
  padding: 3px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.log-line:last-child { border-bottom: none; }
.log-line.stderr .log-text { color: var(--red); }
.log-line.system .log-text { color: var(--yellow); }
.log-time { color: var(--text-muted); flex-shrink: 0; }
.log-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Quick Links */
.quick-links {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.quick-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
  font-weight: 500;
  text-decoration: none;
  color: var(--text-primary);
}
.quick-link:hover {
  border-color: var(--accent);
  background: var(--accent-muted);
}
/* Toast */
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  z-index: 999;
}
.toast.success { background: rgba(63,185,80,0.9); color: #fff; }
.toast.error   { background: rgba(248,81,73,0.9); color: #fff; }
.toast.warning { background: rgba(230,162,60,0.95); color: #fff; }
</style>
