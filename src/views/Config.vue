<template>
  <div class="config-page">
    <div class="page-header">
      <div>
        <h1>模型配置</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          配置 AI 服务商和 API Key
        </p>
      </div>
      <div class="flex gap-2">
        <button class="btn" @click="resetConfig">恢复默认</button>
        <button class="btn btn-primary" @click="saveConfig" :disabled="saving">
          {{ saving ? "保存中..." : "💾 保存配置" }}
        </button>
      </div>
    </div>

    <div v-if="!config" class="text-muted">加载中...</div>

    <template v-else>
      <!-- 当前激活服务商 -->
      <div class="card section">
        <h3 style="margin-bottom: 16px">激活服务商</h3>
        <div class="provider-grid">
          <div
            v-for="p in config.providers"
            :key="p.id"
            class="provider-card"
            :class="{
              active: config.activeProvider === p.id,
              configured: !!p.apiKey,
            }"
            @click="config.activeProvider = p.id"
          >
            <div class="provider-name">{{ p.name }}</div>
            <div class="provider-model text-sm text-muted">{{ p.model }}</div>
            <div class="provider-status">
              <span v-if="p.apiKey" class="badge badge-green">已配置</span>
              <span v-else class="badge badge-yellow">未配置</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 服务商详细配置 -->
      <div class="card section">
        <h3 style="margin-bottom: 16px">{{ currentProvider?.name }} 配置</h3>
        <div v-if="currentProvider" class="form-grid">
          <div class="form-group span-2">
            <label class="form-label">API Base URL</label>
            <input
              class="form-input mono"
              v-model="currentProvider.baseUrl"
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div class="form-group span-2">
            <label class="form-label">API Key</label>
            <div class="input-with-action">
              <input
                class="form-input mono"
                :type="showApiKey ? 'text' : 'password'"
                v-model="currentProvider.apiKey"
                placeholder="sk-xxxxxxxxxxxxxxxx"
              />
              <button class="btn btn-sm" @click="showApiKey = !showApiKey">
                {{ showApiKey ? "🙈" : "👁" }}
              </button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">模型名称</label>
            <div class="input-with-action">
              <input
                class="form-input mono"
                v-model="currentProvider.model"
                placeholder="model-name"
              />
              <button
                class="btn btn-sm"
                @click="openModelPicker(currentProvider)"
                :disabled="!currentProvider.baseUrl"
                title="查看所有模型 / 增加模型"
              >
                📋 模型
              </button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">测试连接</label>
            <button
              class="btn"
              @click="testConnection"
              :disabled="!currentProvider.apiKey || testing"
              style="height: 36px"
            >
              {{ testing ? "测试中..." : testResult || "🔌 测试" }}
            </button>
          </div>
        </div>
      </div>

      <!-- 各服务商快捷填入 -->
      <div class="card section">
        <h3 style="margin-bottom: 12px">所有服务商 API Key</h3>
        <p class="text-sm text-muted" style="margin-bottom: 16px">
          快速配置所有服务商，保存后生效
        </p>
        <div class="all-providers">
          <div v-for="p in config.providers" :key="p.id" class="provider-row">
            <div class="provider-row-name">{{ p.name }}</div>
            <input
              class="form-input mono"
              :type="'password'"
              v-model="p.apiKey"
              :placeholder="p.id === 'custom' ? '可留空' : 'API Key...'"
              style="flex: 1"
            />
            <input
              class="form-input mono"
              v-model="p.model"
              style="width: 200px"
            />
            <button
              class="btn btn-sm"
              @click="openModelPicker(p)"
              :disabled="!p.baseUrl"
              title="查看所有模型 / 增加模型"
            >
              📋
            </button>
          </div>
        </div>
      </div>

      <!-- 应用设置 -->
      <div class="card section">
        <h3 style="margin-bottom: 16px">应用设置</h3>
        <div class="settings-list">
          <div class="setting-row">
            <div>
              <div class="setting-name">服务端口</div>
              <div class="text-sm text-muted">OpenClaw 监听端口</div>
            </div>
            <input
              class="form-input"
              type="number"
              v-model.number="config.port"
              style="width: 120px"
            />
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-name">系统开机自启</div>
              <div class="text-sm text-muted">开机时自动启动本应用（后台驻留托盘）</div>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="config.launchOnBoot" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-name">自动启动服务</div>
              <div class="text-sm text-muted">应用启动时自动运行 OpenClaw 服务</div>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="config.autoStart" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-name">关闭窗口时</div>
              <div class="text-sm text-muted">点击右上角 X 时的行为</div>
            </div>
            <select class="form-input" v-model="config.closeAction" style="width: 200px">
              <option value="ask">每次询问</option>
              <option value="tray">最小化到托盘（后台运行）</option>
              <option value="exit">退出并停止 OpenClaw</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-name">使用国内镜像</div>
              <div class="text-sm text-muted">
                下载时使用 npmmirror 等国内加速源
              </div>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="config.useChineseMirror" />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- 主题外观 -->
      <div class="card section">
        <h3 style="margin-bottom: 4px">主题外观</h3>
        <p class="text-sm text-muted" style="margin-bottom: 16px">
          选择内置主题或自定义颜色，字体颜色会根据背景明暗自动适配
        </p>

        <div class="theme-grid">
          <button
            v-for="preset in themePresets"
            :key="preset.id"
            type="button"
            class="theme-card"
            :class="{ active: config.theme === preset.id }"
            :style="themePreview(preset.base, preset.accent)"
            @click="selectTheme(preset.id)"
          >
            <span class="theme-swatch">
              <span class="theme-dot" :style="{ background: preset.accent }"></span>
              Aa
            </span>
            <span class="theme-card-name">{{ preset.name }}</span>
          </button>

          <button
            type="button"
            class="theme-card"
            :class="{ active: config.theme === 'custom' }"
            :style="themePreview(customBase, customAccent)"
            @click="selectTheme('custom')"
          >
            <span class="theme-swatch">
              <span class="theme-dot" :style="{ background: customAccent }"></span>
              Aa
            </span>
            <span class="theme-card-name">自定义</span>
          </button>
        </div>

        <div v-if="config.theme === 'custom'" class="custom-theme">
          <div class="form-group">
            <label class="form-label">背景主色</label>
            <div class="color-field">
              <input type="color" v-model="customBase" @input="onCustomColorInput" />
              <input class="form-input mono" v-model="customBase" @input="onCustomColorInput" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">强调色</label>
            <div class="color-field">
              <input type="color" v-model="customAccent" @input="onCustomColorInput" />
              <input class="form-input mono" v-model="customAccent" @input="onCustomColorInput" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 模型选择/管理弹窗 -->
    <ModelPickerModal
      v-model:visible="modelPickerVisible"
      :provider="pickerProvider"
      @select="onModelSelected"
      @update-custom="onCustomModelsUpdated"
    />

    <!-- 恢复默认配置确认 -->
    <ConfirmDialog
      v-model:visible="showResetConfirm"
      icon="♻️"
      title="恢复默认配置"
      message="确定要恢复默认配置吗？当前所有服务商配置将被重置。"
      confirm-text="恢复默认"
      danger
      @confirm="doResetConfig"
    />

    <!-- Toast -->
    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useConfigStore } from "@/stores/config";
import ModelPickerModal from "@/views/components/ModelPickerModal.vue";
import ConfirmDialog from "@/views/components/ConfirmDialog.vue";
import type { ModelProvider, PresetModel } from "@/stores/config";
import { useToast } from "@/composables/useToast";
import { THEME_PRESETS } from "@/theme/themes";

const configStore = useConfigStore();
const saving = ref(false);
const showApiKey = ref(false);
const testing = ref(false);
const testResult = ref("");
const { toast, showToast } = useToast();
const modelPickerVisible = ref(false);
const pickerProvider = ref<ModelProvider | null>(null);
const showResetConfirm = ref(false);

function openModelPicker(provider: ModelProvider) {
  pickerProvider.value = provider;
  modelPickerVisible.value = true;
}

function onModelSelected(model: string) {
  if (pickerProvider.value) {
    pickerProvider.value.model = model;
  }
}

function onCustomModelsUpdated(models: PresetModel[]) {
  if (pickerProvider.value) {
    pickerProvider.value.customModels = models;
  }
}

// 进入设置页时重新拉取配置，确保主进程（如关闭对话框“记住选择”）写入的变更能回显
onMounted(() => {
  configStore.load();
});

const config = computed(() => configStore.config);

const currentProvider = computed(() =>
  config.value?.providers.find((p) => p.id === config.value?.activeProvider)
);

watch(
  () => config.value?.activeProvider,
  () => {
    testResult.value = "";
  }
);

/* ── 主题 ─────────────────────────────────────── */
const themePresets = THEME_PRESETS;
const customBase = ref("#0f1117");
const customAccent = ref("#f0883e");

watch(
  config,
  (cfg) => {
    if (!cfg) return;
    if (cfg.theme === "custom") {
      customBase.value = cfg.themeBase || customBase.value;
      customAccent.value = cfg.themeAccent || customAccent.value;
    }
  },
  { immediate: true }
);

function themePreview(base: string, accent: string) {
  return {
    background: base,
    borderColor: accent,
  };
}

function selectTheme(id: string) {
  if (!config.value) return;
  config.value.theme = id;
  if (id === "custom") {
    config.value.themeBase = customBase.value;
    config.value.themeAccent = customAccent.value;
  }
  configStore.applyCurrentTheme();
}

function onCustomColorInput() {
  if (!config.value) return;
  config.value.theme = "custom";
  config.value.themeBase = customBase.value;
  config.value.themeAccent = customAccent.value;
  configStore.applyCurrentTheme();
}

async function saveConfig() {
  if (!config.value) return;
  saving.value = true;
  try {
    const formatValue = JSON.parse(JSON.stringify(config.value));
    await configStore.save(formatValue);
    // 去读取修改配置
    showToast("配置已保存", "success");
  } catch {
    showToast("保存失败", "error");
  } finally {
    saving.value = false;
  }
}

function resetConfig() {
  showResetConfirm.value = true;
}

async function doResetConfig() {
  await configStore.reset();
  showToast("已恢复默认配置", "success");
}

async function testConnection() {
  if (!currentProvider.value) return;
  testing.value = true;
  testResult.value = "";
  try {
    const res = await window.api.config.testConnection({
      apiKey: currentProvider.value.apiKey,
      baseUrl: currentProvider.value.baseUrl,
    });
    console.log("res", res);
    testResult.value = res.success ?  `连接成功，发现 ${res.models.length} 个模型` : `❌ HTTP ${res.error}`;
  } catch (e: any) {
    console.log("res", e);
    testResult.value = "❌ 连接失败";
  } finally {
    testing.value = false;
  }
}
</script>

<style scoped>
.config-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 900px;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.section {
}

/* Provider Grid */
.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.provider-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
  background: var(--bg-elevated);
}
.provider-card:hover {
  border-color: var(--text-muted);
}
.provider-card.active {
  border-color: var(--accent);
  background: var(--accent-muted);
}
.provider-name {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 2px;
}
.provider-status {
  margin-top: 8px;
}

/* Form */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.span-2 {
  grid-column: span 2;
}
.input-with-action {
  display: flex;
  gap: 8px;
}

/* All Providers */
.all-providers {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.provider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.provider-row-name {
  width: 160px;
  font-size: 13px;
  flex-shrink: 0;
}

/* Settings */
.settings-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-muted);
}
.setting-row:last-child {
  border-bottom: none;
}
.setting-name {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 2px;
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
.toast.success {
  background: rgba(63, 185, 80, 0.9);
  color: #fff;
}
.toast.error {
  background: rgba(248, 81, 73, 0.9);
  color: #fff;
}

/* Theme picker */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}
.theme-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
  outline: none;
}
.theme-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}
.theme-card.active {
  box-shadow: 0 0 0 2px var(--accent);
}
.theme-swatch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  mix-blend-mode: difference;
}
.theme-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex-shrink: 0;
}
.theme-card-name {
  font-size: 12px;
  font-weight: 500;
  color: #fff;
  mix-blend-mode: difference;
}
.custom-theme {
  display: flex;
  gap: 16px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.custom-theme .form-group {
  flex: 1;
  min-width: 200px;
}
.color-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.color-field input[type="color"] {
  width: 40px;
  height: 36px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  cursor: pointer;
  flex-shrink: 0;
}
</style>
