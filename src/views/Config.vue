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
              <div class="setting-name">开机自启</div>
              <div class="text-sm text-muted">应用启动时自动启动 OpenClaw</div>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="config.autoStart" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-name">最小化到托盘</div>
              <div class="text-sm text-muted">关闭窗口时隐藏到系统托盘</div>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="config.minimizeToTray" />
              <span class="toggle-slider"></span>
            </label>
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
    </template>

    <!-- 模型选择/管理弹窗 -->
    <ModelPickerModal
      v-model:visible="modelPickerVisible"
      :provider="pickerProvider"
      @select="onModelSelected"
      @update-custom="onCustomModelsUpdated"
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
import type { ModelProvider, PresetModel } from "@/stores/config";

const configStore = useConfigStore();
const saving = ref(false);
const showApiKey = ref(false);
const testing = ref(false);
const testResult = ref("");
const toast = ref<{ msg: string; type: "success" | "error" } | null>(null);
const modelPickerVisible = ref(false);
const pickerProvider = ref<ModelProvider | null>(null);

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

async function saveConfig() {
  if (!config.value) return;
  saving.value = true;
  try {
    const formatValue = JSON.parse(JSON.stringify(config.value));
    console.log("config.value", formatValue);
    await configStore.save(formatValue);
    // 去读取修改配置
    showToast("配置已保存", "success");
  } catch {
    showToast("保存失败", "error");
  } finally {
    saving.value = false;
  }
}

async function resetConfig() {
  if (confirm("确定要恢复默认配置吗？")) {
    await configStore.reset();
    showToast("已恢复默认配置", "success");
  }
}

async function testConnection() {
  if (!currentProvider.value) return;
  testing.value = true;
  testResult.value = "";
  try {
    // const res = await fetch(`${currentProvider.value.baseUrl}/models`, {
    //   headers: { Authorization: `Bearer ${currentProvider.value.apiKey}` }
    // })
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
function showToast(msg: string, type: "success" | "error") {
  toast.value = { msg, type };
  setTimeout(() => (toast.value = null), 2500);
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
</style>
