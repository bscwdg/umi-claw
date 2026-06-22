<template>
  <div class="setup-page">
    <div class="page-header">
      <div>
        <h1>环境初始化</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          下载并配置 Node.js、OpenClaw 核心以及消息渠道运行环境
        </p>
      </div>
    </div>

    <div class="card env-status">
      <h3 style="margin-bottom: 16px">环境状态</h3>
      <div class="env-items">
        <div class="env-item">
          <div
            class="env-check"
            :class="{ ok: envInfo?.nodeInstalled, loading: envLoading }"
          >
            {{ envLoading ? "⏳" : envInfo?.nodeInstalled ? "✅" : "❌" }}
          </div>
          <div class="env-detail">
            <div class="env-name">Node.js 运行时</div>
            <div class="text-sm text-muted">
              {{
                envInfo?.nodeVersion ||
                (envInfo?.nodeInstalled === false ? "未安装" : "检测中...")
              }}
            </div>
          </div>
        </div>
        <div class="env-item">
          <div
            class="env-check"
            :class="{ ok: envInfo?.openClawInstalled, loading: envLoading }"
          >
            {{ envLoading ? "⏳" : envInfo?.openClawInstalled ? "✅" : "❌" }}
          </div>
          <div class="env-detail">
            <div class="env-name">OpenClaw 核心服务</div>
            <div class="text-sm text-muted">
              {{
                envInfo?.openClawVersion
                  ? `v${envInfo.openClawVersion}`
                  : envInfo?.openClawInstalled === false
                  ? "未安装"
                  : "检测中..."
              }}
            </div>
          </div>
        </div>

        <div class="env-item">
          <div
            class="env-check"
            :class="{ ok: envInfo?.channelsInstalled, loading: envLoading }"
          >
            {{ envLoading ? "⏳" : envInfo?.channelsInstalled ? "✅" : "❌" }}
          </div>
          <div class="env-detail">
            <div class="env-name">官方消息渠道内置插件</div>
            <div class="text-sm text-muted">
              {{
                envInfo?.channelsInstalled
                  ? "微信/飞书/企业微信/钉钉/Slack 已就绪"
                  : envInfo?.channelsInstalled === false
                  ? "未安装或依赖缺失"
                  : "检测中..."
              }}
            </div>
          </div>
        </div>

        <div class="env-item">
          <div class="env-check ok">📁</div>
          <div class="env-detail">
            <div class="env-name">数据目录</div>
            <div
              class="text-sm text-muted mono truncate"
              style="max-width: 400px"
            >
              {{ envInfo?.dataDir || "--" }}
            </div>
          </div>
        </div>
      </div>
      <div class="flex gap-2" style="margin-top: 16px">
        <button class="btn" @click="checkEnv">🔄 重新检测</button>
        <button class="btn" @click="openDataDir">📁 打开数据目录</button>
      </div>
    </div>

    <div
      v-if="
        envInfo?.nodeInstalled &&
        envInfo?.openClawInstalled &&
        envInfo?.channelsInstalled &&
        !initializing
      "
      class="card success-card"
    >
      <div style="font-size: 32px">🎉</div>
      <h3>环境已就绪！</h3>
      <p class="text-muted text-sm">
        所有运行时核心及基础渠道插件包均已内置安装完成
      </p>
      <button class="btn btn-success btn-lg" @click="goToDashboard">
        前往控制台
      </button>
    </div>

    <div v-if="!initializing" class="card init-form">
      <h3 style="margin-bottom: 16px">
        {{
          envInfo?.nodeInstalled &&
          envInfo?.openClawInstalled &&
          envInfo?.channelsInstalled
            ? "重新安装环境"
            : "开始完整初始化"
        }}
      </h3>
      <div class="settings-list">
        <div class="setting-row">
          <div>
            <div class="setting-name">使用国内镜像（推荐）</div>
            <div class="text-sm text-muted">
              开启后使用腾讯云/淘宝 NPM 镜像，极大提升微信等渠道组件的下载速度
            </div>
          </div>
          <label class="toggle">
            <input type="checkbox" v-model="useMirror" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-name">自动同步内置渠道插件</div>
            <div class="text-sm text-muted">
              默认勾选。将自动装配：微信、飞书自建应用、企业微信、钉钉机器人、Slack
              核心插件
            </div>
          </div>
          <div class="text-sm text-success" style="font-weight: 500">
            ✓ 自动捆绑
          </div>
        </div>
      </div>
      <button
        class="btn btn-primary btn-lg"
        style="margin-top: 16px"
        @click="startInit"
      >
        🚀 开始一键全自动初始化
      </button>
    </div>

    <div v-if="initializing" class="card progress-card">
      <h3 style="margin-bottom: 20px">
        {{
          progress?.done && !progress?.error
            ? "✅ 初始化及渠道部署完成！"
            : "⚙️ 正在拼命装配中..."
        }}
      </h3>

      <div class="progress-bar-wrap">
        <div
          class="progress-bar"
          :style="{ width: progress?.percent + '%' }"
        ></div>
      </div>
      <div
        class="flex justify-between text-sm text-muted"
        style="margin-top: 6px"
      >
        <span>{{ progress?.stage }} — {{ progress?.step }}</span>
        <span>{{ progress?.percent?.toFixed(0) }}%</span>
      </div>

      <div class="step-log">
        <div
          v-for="(s, i) in stepLog"
          :key="i"
          class="step-entry"
          :class="{ active: i === stepLog.length - 1 }"
        >
          <span class="step-dot">{{
            i === stepLog.length - 1 && !progress?.done ? "⏳" : "✅"
          }}</span>
          <span>{{ s }}</span>
        </div>
      </div>

      <div v-if="progress?.error" class="error-msg">
        ❌ {{ progress.error }}
        <button
          class="btn btn-sm"
          style="margin-top: 8px"
          @click="initializing = false"
        >
          重新尝试
        </button>
      </div>

      <div
        v-if="progress?.done && !progress?.error"
        class="flex gap-2"
        style="margin-top: 16px"
      >
        <button class="btn btn-success" @click="goToDashboard">
          🎉 全套就绪，进入控制台
        </button>
        <button
          class="btn"
          @click="
            initializing = false;
            checkEnv();
          "
        >
          再次全面检测
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const envInfo = ref<any>(null);
const envLoading = ref(false);
const initializing = ref(false);
const useMirror = ref(true);
const progress = ref<any>(null);
const stepLog = ref<string[]>([]);
let offProgress: (() => void) | null = null;

async function checkEnv() {
  envLoading.value = true;
  // 此时 window.api.env.check() 在主进程返回时，需额外带上 channelsInstalled 字段
  envInfo.value = await window.api.env.check();
  console.log("envInfo updated:", envInfo.value);
  envLoading.value = false;
}

async function startInit() {
  initializing.value = true;
  stepLog.value = [];
  progress.value = {
    stage: "环境准备",
    step: "开始拉取初始化底座...",
    percent: 0,
    done: false,
  };

  // 监听底层管道回传的通知（包含主进程里正在安装的渠道进度）
  offProgress = window.api.env.onProgress((p) => {
    progress.value = p;
    const msg = `[${p.stage}] ${p.step}`;
    const last = stepLog.value[stepLog.value.length - 1];
    if (last !== msg) stepLog.value.push(msg);
  });

  // 调用主进程
  await window.api.env.init({ useMirror: useMirror.value });
  offProgress?.();
  await checkEnv();
}

function openDataDir() {
  window.api.config.openDataDir();
}

function goToDashboard() {
  router.push("/dashboard");
}

onMounted(checkEnv);
onUnmounted(() => offProgress?.());
</script>

<style scoped>
/* 保持原有优秀样式百分百兼容不变 */
.setup-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 700px;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.env-items {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.env-item {
  display: flex;
  align-items: center;
  gap: 14px;
}
.env-check {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.env-name {
  font-size: 14px;
  font-weight: 500;
}
.success-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  padding: 32px;
  border-color: rgba(63, 185, 80, 0.3);
  background: rgba(63, 185, 80, 0.05);
}
.settings-list {
  display: flex;
  flex-direction: column;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-muted);
}
.setting-row:last-child {
  border-bottom: none;
}
.setting-name {
  font-weight: 500;
}
.progress-bar-wrap {
  width: 100%;
  height: 6px;
  background: var(--bg-elevated);
  border-radius: 3px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  border-radius: 3px;
  transition: width 0.4s ease;
}
.step-log {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
  padding: 12px;
  background: var(--bg-base);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
}
.step-entry {
  display: flex;
  gap: 8px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.step-entry.active {
  color: var(--text-primary);
}
.step-dot {
  flex-shrink: 0;
}
.error-msg {
  margin-top: 16px;
  padding: 12px;
  background: rgba(248, 81, 73, 0.1);
  border: 1px solid rgba(248, 81, 73, 0.3);
  border-radius: var(--radius-sm);
  color: var(--red);
  font-size: 13px;
  display: flex;
  flex-direction: column;
}
</style>