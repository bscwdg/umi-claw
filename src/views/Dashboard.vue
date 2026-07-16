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
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useClawStore } from '@/stores/claw'
import { useConfigStore } from '@/stores/config'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const clawStore = useClawStore()
const configStore = useConfigStore()
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

// 加载技能数量
window.api.skills.list().then((s) => (skillCount.value = s.filter((x) => x.installed).length))
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
</style>
