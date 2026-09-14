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
            <div
              v-if="envInfo?.nodeVersion && !isNodeCompatible(envInfo.nodeVersion)"
              class="text-sm"
              style="margin-top: 2px; color: var(--red)"
            >
              ⚠️ 版本过低，OpenClaw 2026.9+ 需要 Node v24.16+ / v26.1+，请更新
            </div>
          </div>
          <div
            v-if="envInfo?.nodeInstalled && !initializing"
            class="flex gap-2"
            style="margin-left: auto"
          >
            <button class="btn btn-sm" @click="toggleNodePanel">
              {{ showNodePanel ? "收起" : "🆙 更新 Node" }}
            </button>
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
            <div class="text-sm" style="color: var(--text-primary); font-weight: 500">
              {{
                envInfo?.openClawVersion
                  ? `v${envInfo.openClawVersion}`
                  : envInfo?.openClawInstalled === false
                  ? "未安装"
                  : "检测中..."
              }}
            </div>
            <div
              v-if="updateInfo && !updateInfo.error"
              class="text-sm"
              :style="{ marginTop: '2px', color: updateInfo.hasUpdate ? 'var(--yellow)' : 'var(--green)' }"
            >
              {{
                updateInfo.hasUpdate
                  ? `🆙 有新版本 v${updateInfo.latestVersion} 可用`
                  : `✓ 已是最新版本 v${updateInfo.latestVersion}`
              }}
            </div>
            <div
              v-else-if="updateInfo?.error"
              class="text-sm"
              style="margin-top: 2px; color: var(--red)"
            >
              检查更新失败：{{ updateInfo.error }}
            </div>
          </div>
          <div
            v-if="envInfo?.openClawInstalled && !initializing"
            class="flex gap-2"
            style="margin-left: auto"
          >
            <button
              class="btn btn-sm"
              :disabled="checkingUpdate"
              @click="checkUpdate"
            >
              {{ checkingUpdate ? "检查中..." : "🔍 检查更新" }}
            </button>
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

    <div v-if="showNodePanel && !initializing" class="card node-update-card">
      <h3 style="margin-bottom: 8px">更新 Node.js 运行时</h3>
      <p class="text-muted text-sm">
        更新前会自动停止 OpenClaw 服务，完成后自动重启。当前版本：{{
          envInfo?.nodeVersion || "未知"
        }}
      </p>
      <div
        class="flex gap-2"
        style="margin-top: 12px; align-items: center; flex-wrap: wrap"
      >
        <select
          v-model="selectedNodeVersion"
          class="form-input"
          style="width: 320px"
          :disabled="loadingNodeVersions"
        >
          <option v-for="item in nodeVersions" :key="item.version" :value="item.version">
            {{
              item.version +
              (item.lts ? "（LTS " + item.lts + "）" : "（当前版本线）") +
              (item.recommended ? " ✅ 推荐稳定版" : "") +
              (item.compatible ? "" : " · 不满足 OpenClaw 要求")
            }}
          </option>
          <option value="__custom__">自定义版本…</option>
        </select>
        <input
          v-if="selectedNodeVersion === '__custom__'"
          v-model="customNodeVersion"
          class="form-input"
          style="width: 160px"
          placeholder="如 v24.21.0"
        />
        <button
          class="btn btn-primary btn-sm"
          :disabled="nodeUpdating"
          @click="startNodeUpdate"
        >
          {{ nodeUpdating ? "更新中..." : "确认更新" }}
        </button>
      </div>
      <div
        v-if="nodeVersionsError"
        class="text-sm"
        style="margin-top: 8px; color: var(--red)"
      >
        {{ nodeVersionsError }}，可选择「自定义版本」直接填写，例如 v24.21.0。
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

    <!-- 发现新版本时的确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showUpdateDialog"
      icon="🆙"
      title="发现新版本"
      confirm-text="立即更新"
      @confirm="confirmUpdate"
    >
      <p style="margin: 0 0 14px">检测到 OpenClaw 有新版本可用，是否立即更新？</p>
      <div class="version-compare">
        <span class="ver-old">当前 v{{ updateInfo?.currentVersion || "未知" }}</span>
        <span class="ver-arrow">→</span>
        <span class="ver-new">最新 v{{ updateInfo?.latestVersion }}</span>
      </div>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import ConfirmDialog from "@/views/components/ConfirmDialog.vue";

const router = useRouter();
const envInfo = ref<any>(null);
const envLoading = ref(false);
const initializing = ref(false);
const useMirror = ref(true);
const progress = ref<any>(null);
const stepLog = ref<string[]>([]);
let offProgress: (() => void) | null = null;
const checkingUpdate = ref(false);
const showUpdateDialog = ref(false);
const updateInfo = ref<{
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  error?: string;
} | null>(null);

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
  const res = await window.api.env.init({ useMirror: useMirror.value });
  offProgress?.();
  // 主进程回执与 env:progress 通知走不同通道，最终“完成”通知可能在 invoke
  // 回执之后才到达，却被 offProgress 提前摘除而丢失，导致 UI 停在 98%。
  // 此处以 invoke 回执为准兜底刷新完成态，保证进度条走到 100% 并退出“正在拼命装配”。
  if (res?.success) {
    progress.value = {
      stage: "完成",
      step: "恭喜，全套环境初始化部署成功！",
      percent: 100,
      done: true,
    };
  } else if (res?.error && !progress.value?.error) {
    progress.value = {
      stage: "错误",
      step: res.error,
      percent: 0,
      done: true,
      error: res.error,
    };
  }
  await checkEnv();
}

async function startUpdate() {
  initializing.value = true;
  stepLog.value = [];
  progress.value = {
    stage: "检查更新",
    step: "正在准备更新 OpenClaw...",
    percent: 0,
    done: false,
  };

  offProgress = window.api.env.onProgress((p) => {
    progress.value = p;
    const msg = `[${p.stage}] ${p.step}`;
    const last = stepLog.value[stepLog.value.length - 1];
    if (last !== msg) stepLog.value.push(msg);
  });

  const res = await window.api.env.update({ useMirror: useMirror.value }).catch((e: any) => ({
    success: false,
    error: e?.message || "更新请求失败",
  }));
  offProgress?.();
  // 同 startInit：以 invoke 回执为准兜底刷新完成态，避免最终通知丢失卡在 98%。
  if (res?.success) {
    const upToDate =
      res.previousVersion && res.currentVersion === res.previousVersion;
    progress.value = {
      stage: "完成",
      step:
        (upToDate
          ? `已是最新版本 v${res.currentVersion}`
          : `更新成功：v${res.previousVersion ?? "未知"} → v${res.currentVersion ?? "未知"}`) +
        (res.warning ? `（${res.warning}）` : ""),
      percent: 100,
      done: true,
    };
  } else if (res?.error && !progress.value?.error) {
    progress.value = {
      stage: "错误",
      step: res.error,
      percent: 0,
      done: true,
      error: res.error,
    };
  }
  await checkEnv();
  updateInfo.value = null;
}

async function checkUpdate() {
  checkingUpdate.value = true;
  updateInfo.value = null;
  try {
    const res = await window.api.env.checkLatest({ useMirror: useMirror.value });
    updateInfo.value = res.success
      ? {
          currentVersion: res.currentVersion,
          latestVersion: res.latestVersion,
          hasUpdate: res.hasUpdate,
        }
      : { error: res.error };
    if (res.success && res.hasUpdate) {
      showUpdateDialog.value = true;
    }
  } catch (e: any) {
    updateInfo.value = { error: e?.message || "检查更新失败" };
  } finally {
    checkingUpdate.value = false;
  }
}

function confirmUpdate() {
  showUpdateDialog.value = false;
  startUpdate();
}

function openDataDir() {
  window.api.config.openDataDir();
}

function goToDashboard() {
  router.push("/dashboard");
}

// ---- Node 运行时更新 ----
const showNodePanel = ref(false);
const nodeUpdating = ref(false);
const loadingNodeVersions = ref(false);
const nodeVersions = ref<
  Array<{
    version: string;
    lts: string | false;
    compatible: boolean;
    recommended: boolean;
  }>
>([]);
const selectedNodeVersion = ref("");
const customNodeVersion = ref("");
const nodeVersionsError = ref("");

function isNodeCompatible(v: string): boolean {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\./);
  if (!m) return true;
  const maj = Number(m[1]);
  const min = Number(m[2]);
  if (maj === 24) return min >= 16;
  if (maj === 25) return false;
  if (maj === 26) return min >= 1;
  return maj > 26;
}

async function toggleNodePanel() {
  showNodePanel.value = !showNodePanel.value;
  if (showNodePanel.value && nodeVersions.value.length === 0) {
    loadingNodeVersions.value = true;
    nodeVersionsError.value = "";
    try {
      const res = await window.api.env.getNodeVersions({
        useMirror: useMirror.value,
      });
      if (res?.success) {
        nodeVersions.value = res.versions;
        const recommended =
          res.versions.find((x: any) => x.recommended) ||
          res.versions.find((x: any) => x.compatible) ||
          res.versions[0];
        selectedNodeVersion.value = recommended
          ? recommended.version
          : "__custom__";
        if (!recommended) customNodeVersion.value = "v24.21.0";
      } else {
        nodeVersionsError.value = res?.error || "获取推荐版本失败";
        selectedNodeVersion.value = "__custom__";
        customNodeVersion.value = "v24.21.0";
      }
    } catch (e: any) {
      nodeVersionsError.value = e?.message || "获取推荐版本失败";
      selectedNodeVersion.value = "__custom__";
      customNodeVersion.value = "v24.21.0";
    } finally {
      loadingNodeVersions.value = false;
    }
  }
}

async function startNodeUpdate() {
  const version =
    selectedNodeVersion.value === "__custom__"
      ? customNodeVersion.value.trim()
      : selectedNodeVersion.value;
  if (!version) return;

  nodeUpdating.value = true;
  initializing.value = true;
  stepLog.value = [];
  progress.value = {
    stage: "Node.js",
    step: `准备更新 Node 到 ${version}...`,
    percent: 0,
    done: false,
  };

  offProgress = window.api.env.onProgress((p) => {
    progress.value = p;
    const msg = `[${p.stage}] ${p.step}`;
    const last = stepLog.value[stepLog.value.length - 1];
    if (last !== msg) stepLog.value.push(msg);
  });

  const res = await window.api.env.updateNode({
    version,
    useMirror: useMirror.value,
  }).catch((e: any) => ({
    success: false,
    error: e?.message || "更新请求失败",
  }));
  offProgress?.();

  if (res?.success) {
    progress.value = {
      stage: "完成",
      step: `Node.js 更新成功：${res.previousVersion ?? "旧版"} → ${res.currentVersion}${res.warning ? `（${res.warning}）` : ""}`,
      percent: 100,
      done: true,
    };
  } else if (res?.error && !progress.value?.error) {
    progress.value = {
      stage: "错误",
      step: res.error,
      percent: 0,
      done: true,
      error: res.error,
    };
  }

  nodeUpdating.value = false;
  showNodePanel.value = false;
  await checkEnv();
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
  width: 100%;
}
.node-update-card {
  margin-top: -8px;
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
.version-compare {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  font-family: var(--font-mono, monospace);
  font-size: 13px;
}
.ver-old {
  color: var(--text-muted);
}
.ver-arrow {
  color: var(--text-muted);
}
.ver-new {
  color: var(--green);
  font-weight: 600;
}
</style>
