<template>
  <div class="page-container about-page">
    <div class="hero card">
      <div class="hero-icon">🦞</div>
      <h1>Umi Claw</h1>
      <p class="text-muted">OpenClaw 便携管理工具 · 基于 Electron + Vue3 + Vite</p>
      <div class="version-badges">
        <span class="badge badge-blue">v{{ version }}</span>
        <span class="badge badge-green">Electron 30</span>
        <span class="badge badge-purple">Vue 3</span>
      </div>
    </div>

    <div class="grid-2">
      <div class="card info-card">
        <h3>🚀 核心特性</h3>
        <ul class="feature-list">
          <li>零配置启动，开箱即用</li>
          <li>图形化 OpenClaw 进程管理</li>
          <li>支持 10+ 国内外 AI 服务商</li>
          <li>实时日志监控</li>
          <li>系统托盘后台运行</li>
          <li>便携模式（U 盘）支持</li>
          <li>国内镜像加速下载</li>
        </ul>
      </div>

      <div class="card info-card">
        <h3>🛠 技术栈</h3>
        <div class="tech-list">
          <div v-for="t in techStack" :key="t.name" class="tech-row">
            <span class="tech-name">{{ t.name }}</span>
            <span class="text-muted text-sm">{{ t.desc }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card links-card">
      <h3 style="margin-bottom:14px">🔗 相关链接</h3>
      <div class="grid-3">
        <button class="btn" @click="open('https://github.com/openclaw/openclaw')">
          <span>📦</span> OpenClaw 项目
        </button>
        <button class="btn" @click="open('https://github.com/uxiaohan/vh-claw')">
          <span>🦞</span> VH-Claw 原项目
        </button>
        <button class="btn" @click="open('https://github.com/dongsheng123132/u-claw')">
          <span>💾</span> U-Claw 原项目
        </button>
        <button class="btn" @click="open('https://electronjs.org')">
          <span>⚡</span> Electron
        </button>
        <button class="btn" @click="open('https://vuejs.org')">
          <span>💚</span> Vue 3
        </button>
        <button class="btn" @click="open('https://vitejs.dev')">
          <span>⚡</span> Vite
        </button>
      </div>
    </div>

    <div class="card consent-card">
      <h3 style="margin-bottom:14px">📜 用户协议与隐私</h3>
      <p class="consent-status">
        <template v-if="consentGranted">
          ✅ 你已于 {{ consentAtLabel }} 同意用户协议
        </template>
        <template v-else>
          ⚠️ 尚未同意用户协议，OpenClaw 无法启动
        </template>
      </p>
      <div class="consent-actions">
        <button class="btn" @click="openAgreementReview">
          <span>📄</span> 查看用户协议
        </button>
        <button
          v-if="consentGranted"
          class="btn btn-danger"
          :disabled="revoking"
          @click="revokeConfirmVisible = true"
        >
          <span>⚠️</span> 撤销同意
        </button>
      </div>
      <ConfirmDialog
        v-model:visible="revokeConfirmVisible"
        icon="⚠️"
        title="撤销用户协议？"
        message="撤销后 OpenClaw 将无法启动，AI 相关能力停用；你的本地数据不会被删除，随时可以重新同意恢复。"
        confirm-text="撤销同意"
        danger
        @confirm="confirmRevokeConsent"
      />
    </div>

    <div class="card" style="text-align:center; padding:var(--space-5); color:var(--text-muted); font-size:var(--text-sm)">
      MIT License · 基于 OpenClaw 开源项目重构 · Made with 🦞
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useToast } from '@/composables/useToast'
import ConfirmDialog from '@/views/components/ConfirmDialog.vue'
import {
  consentGranted,
  consentAt,
  openAgreementReview,
  syncConsent
} from '@/composables/useAgreementGate'

const version = ref('')
const { showToast } = useToast()
const revokeConfirmVisible = ref(false)
const revoking = ref(false)

const consentAtLabel = computed(() => {
  const t = consentAt.value
  if (!t) return ''
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

onMounted(async () => {
  version.value = await window.api.app.getVersion()
  // 宿主页主动同步一次协议状态：work 插件停用时这里仍是可靠的查看/撤销入口
  try {
    const status = await window.api.consent.status()
    syncConsent(status.consent, status.consentAt ?? null)
  } catch (e: any) {
    showToast(`读取协议状态失败：${e?.message ?? '未知错误'}`, 'error')
  }
})

/** 撤销同意：宿主页直接走 consent:revoke 单源通道，二次确认在模板的 ConfirmDialog 里完成。 */
async function confirmRevokeConsent(): Promise<void> {
  revokeConfirmVisible.value = false
  revoking.value = true
  try {
    await window.api.consent.revoke()
    syncConsent(false, null)
    showToast('已撤销用户协议，OpenClaw 相关能力已停用', 'warning')
  } catch (e: any) {
    showToast(`撤销失败：${e?.message ?? '未知错误'}`, 'error')
  } finally {
    revoking.value = false
  }
}

const techStack = [
  { name: 'Electron 30', desc: '跨平台桌面应用框架' },
  { name: 'Vue 3.4', desc: '渐进式前端框架' },
  { name: 'Vite 5', desc: '极速构建工具' },
  { name: 'TypeScript', desc: '类型安全的 JavaScript' },
  { name: 'Pinia', desc: '状态管理' },
  { name: 'Vue Router 4', desc: '前端路由' },
  { name: 'electron-vite', desc: 'Electron + Vite 集成' }
]

function open(url: string) {
  window.api.shell.openExternal(url)
}
</script>

<style scoped>
.about-page { display: flex; flex-direction: column; gap: var(--space-5); width: 100%; }

.hero {
  display: flex; flex-direction: column; align-items: center;
  gap: var(--space-3); text-align: center; padding: var(--space-10);
}
.hero-icon { font-size: var(--text-hero); }
.version-badges { display: flex; gap: var(--space-2); margin-top: var(--space-1); }
/* 紫色为品牌点缀色（静态 token --purple），muted 底用 color-mix 派生以随浅深主题适配 */
.badge-purple { background: color-mix(in srgb, var(--purple) 15%, transparent); color: var(--purple); }

/* 两列网格吃全局 .grid-2（含 1100/720px 断点降级），.info-card 只补标题间距 */
.info-card h3 { margin-bottom: var(--space-4); }

.feature-list {
  list-style: none;
  display: flex; flex-direction: column; gap: var(--space-2);
}
.feature-list li {
  font-size: var(--text-sm); color: var(--text-secondary);
  padding-left: var(--space-4); position: relative;
}
.feature-list li::before {
  content: '›'; position: absolute; left: 0;
  color: var(--accent); font-weight: 700;
}

.tech-list { display: flex; flex-direction: column; gap: var(--space-3); }
.tech-row { display: flex; justify-content: space-between; align-items: center; }
.tech-name { font-size: var(--text-sm); font-weight: 500; }

/* 三列网格吃全局 .grid-3（含断点降级），链接按钮吃全局 .btn/.btn-danger，本页不再自定义 */
.consent-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.consent-status { margin: 0 0 var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
</style>
