<template>
  <div v-if="visible" class="modal-overlay" @click.self="close">
    <div class="modal-card">
      <div class="modal-header">
        <div class="title-group">
          <span>🧩</span>
          <h4>{{ provider?.name }} 模型管理</h4>
        </div>
        <span class="close-btn" @click="close">✕</span>
      </div>

      <div class="modal-body">
        <div class="add-panel">
          <div class="add-head" @click="showAddForm = !showAddForm">
            <span>{{ editingId ? `✏️ 编辑模型：${editingId}` : `➕ ${showAddForm ? "收起" : "新增自定义模型"}` }}</span>
            <span class="hint-icon" @click.stop>ℹ️<span class="hint-pop">提示：增加模型建议先搜索模型参数（上下文窗口、最大输出、输入模态、是否支持推理等），参数不准可能限制模型能力。</span></span>
          </div>
          <div v-if="showAddForm" class="add-form">
            <div class="add-row">
              <label>模型 ID<span class="req">*</span></label>
              <input class="form-input mono" v-model="form.id" placeholder="如 gpt-4o-mini" />
            </div>
            <div class="add-row">
              <label>显示名称</label>
              <input class="form-input" v-model="form.name" placeholder="留空则同 ID" />
            </div>
            <div class="add-grid">
              <div class="add-row">
                <label>上下文窗口 <span class="unit">(最大输入长度，如 128K / 1M / 128000)</span></label>
                <input class="form-input mono" v-model="form.contextWindowRaw" placeholder="如 128K 或 128000" />
                <span v-if="parsedContextWindow != null" class="converted-hint">= {{ parsedContextWindow.toLocaleString() }} tokens</span>
              </div>
              <div class="add-row">
                <label>最大输出 <span class="unit">(单次回复上限，如 16K / 1M / 16384)</span></label>
                <input class="form-input mono" v-model="form.maxTokensRaw" placeholder="如 16K 或 16384" />
                <span v-if="parsedMaxTokens != null" class="converted-hint">= {{ parsedMaxTokens.toLocaleString() }} tokens</span>
              </div>
            </div>
            <div class="add-grid">
              <div class="add-row">
                <label>输入模态</label>
                <div class="checks">
                  <label class="chk"><input type="checkbox" value="text" v-model="form.input" />文本</label>
                  <label class="chk"><input type="checkbox" value="image" v-model="form.input" />图片</label>
                  <label class="chk"><input type="checkbox" value="audio" v-model="form.input" />音频</label>
                </div>
              </div>
              <div class="add-row">
                <label>能力</label>
                <label class="chk"><input type="checkbox" v-model="form.reasoning" />支持推理</label>
              </div>
            </div>
            <div class="add-actions">
              <button v-if="editingId" class="btn btn-sm" @click="cancelEdit">取消编辑</button>
              <button class="btn btn-sm" @click="resetForm">{{ editingId ? "清空重填" : "重置" }}</button>
              <button class="btn btn-primary btn-sm" @click="saveModel" :disabled="!form.id.trim()">
                {{ editingId ? "💾 保存修改" : "➕ 添加" }}
              </button>
            </div>
          </div>
        </div>

        <div class="toolbar">
          <div class="text-sm text-muted">
            {{ loading ? "正在拉取在线模型..." : `预设 ${presetCount} · 自定义 ${customCount} · 在线 ${remoteCount} · 共 ${models.length}` }}
          </div>
          <button class="btn btn-sm" @click="fetchRemote" :disabled="loading">
            {{ loading ? "刷新中..." : "🔄 拉取在线模型" }}
          </button>
        </div>

        <div v-if="error" class="error-box">❌ {{ error }}</div>

        <div class="model-list">
          <div
            v-for="m in models"
            :key="m.id"
            class="model-item"
            :class="{ selected: m.id === current }"
            @click="select(m.id)"
          >
            <div class="model-main">
              <div class="model-line">
                <span class="model-id mono">{{ m.id }}</span>
                <span v-if="m.name && m.name !== m.id" class="model-name">{{ m.name }}</span>
              </div>
              <div class="model-meta">
                <span v-if="m.source === 'preset'" class="badge badge-blue">预设</span>
                <span v-else-if="m.source === 'custom'" class="badge badge-orange">自定义</span>
                <span v-else class="badge badge-gray">在线</span>
                <span v-if="m.reasoning" class="badge badge-purple">推理</span>
                <span v-if="m.contextWindow" class="tag">ctx {{ fmt(m.contextWindow) }}</span>
                <span v-if="m.maxTokens" class="tag">out {{ fmt(m.maxTokens) }}</span>
                <span v-if="m.input && m.input.length" class="tag">{{ m.input.join("/") }}</span>
              </div>
            </div>
            <div class="model-actions">
              <span v-if="m.id === current" class="badge badge-green">当前</span>
              <button
                v-if="m.source === 'remote'"
                class="btn btn-sm"
                title="添加到自定义模型列表"
                @click.stop="addRemoteModel(m)"
              >
                ➕ 添加
              </button>
              <button
                class="icon-btn edit"
                :title="editTitle(m)"
                @click.stop="startEdit(m)"
              >
                ✏️
              </button>
              <button
                v-if="m.source === 'custom'"
                class="icon-btn danger"
                title="删除该自定义模型"
                @click.stop="removeModel(m)"
              >
                🗑
              </button>
            </div>
          </div>
          <div v-if="!loading && !models.length && !error" class="text-muted text-sm empty">
            暂无模型，可点击「拉取在线模型」或在上方新增
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <span class="text-sm text-muted footer-hint">改动保存后需点页面「💾 保存配置」生效</span>
        <button class="btn btn-sm" @click="close">关闭</button>
      </div>
    </div>

    <ConfirmDialog
      v-model:visible="showDeleteConfirm"
      icon="🗑"
      title="删除自定义模型"
      :message="`确定删除自定义模型「${pendingDelete?.id}」？此操作不可撤销。`"
      confirm-text="删除"
      danger
      @confirm="confirmRemoveModel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import type { ModelProvider, PresetModel } from "@/stores/config";
import ConfirmDialog from "@/views/components/ConfirmDialog.vue";

interface ModelRow {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  source: "preset" | "remote" | "custom";
}

const props = defineProps<{
  visible: boolean;
  provider: ModelProvider | null;
}>();

const emit = defineEmits<{
  (e: "update:visible", value: boolean): void;
  (e: "select", model: string): void;
  (e: "update-custom", models: PresetModel[]): void;
}>();

const remoteModels = ref<ModelRow[]>([]);
const presetModels = ref<ModelRow[]>([]);
const loading = ref(false);
const error = ref("");
const current = ref("");
const showAddForm = ref(false);
const showDeleteConfirm = ref(false);
const pendingDelete = ref<ModelRow | null>(null);
/** 正在编辑的自定义模型 id（表单处于编辑模式）；null = 新增模式 */
const editingId = ref<string | null>(null);

const DEFAULT_REMOTE_MODEL = {
  contextWindow: 8192,
  maxTokens: 4096,
  input: ["text"] as string[],
  reasoning: false,
};

const createForm = () => ({
  id: "",
  name: "",
  contextWindowRaw: "",
  maxTokensRaw: "",
  input: [] as string[],
  reasoning: false,
});
const form = reactive(createForm());

/**
 * 解析用户输入的 token 数量，支持三种写法（大小写不限）：
 *   - "128K" / "1.5M" 等带单位缩写
 *   - "128000" 原始数字
 *   - 空串返回 undefined（走默认值）
 * 无法解析返回 null（用于提示输入有误）。
 */
function parseTokens(raw: string): number | undefined | null {
  const s = (raw || "").trim();
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const value = unit === "m" ? n * 1_000_000 : unit === "k" ? n * 1_000 : n;
  return Math.round(value);
}

const parsedContextWindow = computed(() => parseTokens(form.contextWindowRaw));
const parsedMaxTokens = computed(() => parseTokens(form.maxTokensRaw));
const hasTokenInputError = computed(
  () => parsedContextWindow.value === null || parsedMaxTokens.value === null
);

const customModels = computed<ModelRow[]>(() =>
  (props.provider?.customModels || []).map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    source: "custom" as const,
  }))
);

const models = computed<ModelRow[]>(() => {
  const seen = new Set<string>();
  const out: ModelRow[] = [];
  for (const list of [customModels.value, presetModels.value, remoteModels.value]) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
});

const presetCount = computed(() => models.value.filter((m) => m.source === "preset").length);
const customCount = computed(() => models.value.filter((m) => m.source === "custom").length);
const remoteCount = computed(() => models.value.filter((m) => m.source === "remote").length);

watch(
  () => props.visible,
  async (open) => {
    if (open && props.provider) {
      current.value = props.provider.model;
      remoteModels.value = [];
      error.value = "";
      showAddForm.value = true;
      editingId.value = null;
      resetForm();
      await loadPresets();
    }
  }
);

async function loadPresets() {
  presetModels.value = [];
  const configName = props.provider?.configName;
  if (!configName) return;
  try {
    const presets = await window.api.config.getPresetModels(configName);
    presetModels.value = (presets || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      source: "preset" as const,
    }));
  } catch (e: any) {
    error.value = e?.message || "读取预设模型失败";
  }
}

async function fetchRemote() {
  if (!props.provider) return;
  loading.value = true;
  error.value = "";
  try {
    const res = await window.api.config.testConnection({
      apiKey: props.provider.apiKey,
      baseUrl: props.provider.baseUrl,
      modelsListUrl: props.provider.modelsListUrl,
      timeoutSeconds: props.provider.timeoutSeconds,
    });
    if (res.success) {
      remoteModels.value = (res.models || []).map((id: string) => ({
        id,
        source: "remote" as const,
      }));
    } else {
      error.value = res.error || "获取在线模型失败";
    }
  } catch (e: any) {
    error.value = e?.message || "获取在线模型失败";
  } finally {
    loading.value = false;
  }
}

function select(model: string) {
  current.value = model;
  emit("select", model);
}

/**
 * 把 token 数量转回表单友好写法（128000 -> "128K"，1048576 -> "1M"），
 * 用于编辑模型时预填表单。不能整除的保留原始数字。
 */
function toRawTokens(n?: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1_000 === 0) return `${n / 1_000}K`;
  return String(n);
}

function editTitle(m: ModelRow): string {
  if (m.source === "custom") return "编辑该自定义模型";
  if (m.source === "preset") return "编辑（保存为自定义模型，覆盖预设参数）";
  return "编辑参数并添加为自定义模型";
}

/** 打开编辑：预填表单并展开。编辑预设/在线模型时保存为同 id 的自定义模型（覆盖预设参数）。 */
function startEdit(m: ModelRow) {
  editingId.value = m.id;
  form.id = m.id;
  form.name = m.name && m.name !== m.id ? m.name : "";
  form.contextWindowRaw = toRawTokens(m.contextWindow);
  form.maxTokensRaw = toRawTokens(m.maxTokens);
  form.input = m.input && m.input.length ? [...m.input] : [];
  form.reasoning = !!m.reasoning;
  showAddForm.value = true;
  error.value = "";
}

/** 取消编辑：退出编辑模式，清空表单回到新增状态 */
function cancelEdit() {
  editingId.value = null;
  resetForm();
}

/**
 * 保存模型（新增 / 编辑统一入口）。
 * 编辑自定义模型时原位替换（id 可改）；编辑预设/在线模型时保存为自定义模型，
 * 与预设同 id 的自定义条目会在合并时覆盖预设参数。
 */
function saveModel() {
  const id = form.id.trim();
  if (!id) return;
  if (hasTokenInputError.value) {
    error.value = "上下文窗口 / 最大输出格式有误：请填写 128K、1.5M 或 128000 这类写法";
    return;
  }
  const list = [...(props.provider?.customModels || [])];
  // 编辑时定位原条目（原 id 可能已被修改）
  const selfIdx = editingId.value ? list.findIndex((m) => m.id === editingId.value) : -1;
  // 冲突检查：与已有自定义模型重名（编辑时排除自身原条目）；
  // 仅「新增模式」禁止与预设重名。编辑预设/在线模型（editingId 有值但不在
  // customModels 中，selfIdx 为 -1）允许保留/使用预设同 id 保存--
  // 这正是"自定义覆盖预设"的能力，不能误判为重名冲突。
  const clash =
    list.some((m, i) => m.id === id && i !== selfIdx) ||
    (!editingId.value && models.value.some((m) => m.id === id && m.source === "preset"));
  if (clash) {
    error.value = `模型 ID「${id}」已存在`;
    return;
  }
  const entry: PresetModel = { id };
  entry.name = form.name.trim() || id;
  // 与 main 层 schema 兜底保持一致：始终写完整字段，避免用户未填时写入缺字段模型。
  entry.contextWindow = parsedContextWindow.value ?? DEFAULT_REMOTE_MODEL.contextWindow;
  entry.maxTokens = parsedMaxTokens.value ?? DEFAULT_REMOTE_MODEL.maxTokens;
  entry.input = form.input.length ? [...form.input] : [...DEFAULT_REMOTE_MODEL.input];
  if (form.reasoning) entry.reasoning = true;
  if (selfIdx >= 0) {
    list[selfIdx] = entry; // 编辑：原位替换
  } else {
    list.push(entry); // 新增，或编辑预设/在线模型（保存为自定义覆盖）
  }
  emit("update-custom", list);
  select(id);
  resetForm();
  error.value = "";
}

function addRemoteModel(row: ModelRow) {
  const id = row.id?.trim();
  if (!id) return;
  const list = [...(props.provider?.customModels || [])];
  if (list.some((m) => m.id === id)) {
    select(id);
    return;
  }
  const entry: PresetModel = { id };
  entry.name = row.name && row.name !== id ? row.name : id;
  entry.contextWindow = typeof row.contextWindow === "number" ? row.contextWindow : DEFAULT_REMOTE_MODEL.contextWindow;
  entry.maxTokens = typeof row.maxTokens === "number" ? row.maxTokens : DEFAULT_REMOTE_MODEL.maxTokens;
  entry.input = row.input && row.input.length ? [...row.input] : [...DEFAULT_REMOTE_MODEL.input];
  entry.reasoning = row.reasoning ?? DEFAULT_REMOTE_MODEL.reasoning;
  list.push(entry);
  emit("update-custom", list);
  select(id);
  error.value = "";
}

function removeModel(row: ModelRow) {
  pendingDelete.value = row;
  showDeleteConfirm.value = true;
}

function confirmRemoveModel() {
  const row = pendingDelete.value;
  if (!row) return;
  const list = (props.provider?.customModels || []).filter((m) => m.id !== row.id);
  emit("update-custom", list);
  if (current.value === row.id) {
    const fallback = list[0]?.id || presetModels.value[0]?.id || "";
    if (fallback) select(fallback);
  }
  // 删掉的正是编辑中的模型：退出编辑模式，避免表单指向已不存在的条目
  if (editingId.value === row.id) {
    resetForm();
  }
  pendingDelete.value = null;
}

function resetForm() {
  Object.assign(form, createForm());
  // 回到新增模式：清空/重置都意味着放弃当前编辑
  editingId.value = null;
}

function fmt(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}

function close() {
  emit("update:visible", false);
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 22, 26, 0.5);
  backdrop-filter: blur(5px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2000;
}
.modal-card {
  background: var(--bg-elevated, #fff);
  border: 1px solid var(--border, #eef0f2);
  border-radius: var(--radius, 12px);
  width: 580px;
  max-width: 94vw;
  max-height: 88vh;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.modal-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border, #edeef0);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-group h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.close-btn {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 16px;
}
.close-btn:hover {
  color: var(--text-primary);
}
.modal-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  min-height: 0;
  flex: 1 1 auto;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.error-box {
  padding: 8px 12px;
  border-radius: var(--radius-sm, 6px);
  background: rgba(248, 81, 73, 0.12);
  color: #f85149;
  font-size: 13px;
}
.model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--border-muted, #edeef0);
  border-radius: var(--radius-sm, 6px);
  padding: 8px;
  flex-shrink: 0;
}
.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  border: 1px solid transparent;
}
.model-item:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.08));
}
.model-item.selected {
  border-color: var(--accent);
  background: var(--accent-muted, rgba(56, 139, 253, 0.1));
}
.model-main {
  min-width: 0;
  flex: 1;
}
.model-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.model-id {
  font-size: 13px;
  font-weight: 500;
  word-break: break-all;
}
.model-name {
  font-size: 12px;
  color: var(--text-secondary, var(--text-muted));
}
.model-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.model-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.icon-btn {
  border: 1px solid rgba(248, 81, 73, 0.4);
  background: rgba(248, 81, 73, 0.12);
  color: #ff6b64;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.icon-btn.danger::after {
  content: "删除";
}
.icon-btn:hover {
  background: rgba(248, 81, 73, 0.22);
  border-color: #f85149;
  color: #ff8781;
}
/* 编辑按钮：中性蓝色调，与删除（红色）区分 */
.icon-btn.edit {
  border-color: rgba(56, 139, 253, 0.4);
  background: rgba(56, 139, 253, 0.12);
  color: #388bfd;
}
.icon-btn.edit::after {
  content: "编辑";
}
.icon-btn.edit:hover {
  background: rgba(56, 139, 253, 0.22);
  border-color: #388bfd;
  color: #58a6ff;
}
.tag {
  font-size: 11px;
  color: var(--text-secondary, var(--text-muted));
  background: var(--bg-overlay, rgba(127, 127, 127, 0.15));
  padding: 1px 6px;
  border-radius: 4px;
}
.badge-blue {
  background: rgba(56, 139, 253, 0.15);
  color: #388bfd;
}
.badge-gray {
  background: rgba(127, 127, 127, 0.15);
  color: var(--text-muted);
}
.badge-orange {
  background: rgba(219, 109, 40, 0.15);
  color: #db6d28;
}
.badge-purple {
  background: rgba(163, 113, 247, 0.15);
  color: #a371f7;
}
.empty {
  text-align: center;
  padding: 16px 0;
}
.add-panel {
  border: 1px solid var(--accent, #388bfd);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--accent-muted, rgba(56, 139, 253, 0.06));
}
.add-head {
  padding: 10px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent, #388bfd);
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
/* 表单头部的提示图标：悬停弹出说明气泡 */
.hint-icon {
  position: relative;
  cursor: help;
  font-size: 13px;
  font-weight: 400;
  color: var(--text-muted, #8b949e);
  flex-shrink: 0;
}
.hint-icon:hover {
  color: var(--accent, #388bfd);
}
.hint-pop {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 250px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-elevated, #22272e);
  border: 1px solid var(--border, #eef0f2);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  color: var(--text-primary, #e6edf3);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  white-space: normal;
  text-align: left;
  z-index: 10;
  cursor: default;
}
.hint-icon:hover .hint-pop {
  display: block;
}
.add-head:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.08));
}
.add-form {
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border-muted, #edeef0);
}
.add-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.add-row label {
  font-size: 12px;
  color: var(--text-secondary, var(--text-muted));
}
.unit {
  color: var(--text-secondary, #8b949e);
  font-weight: 400;
}
.converted-hint {
  font-size: 12px;
  color: var(--accent, #388bfd);
}
.req {
  color: #f85149;
  margin-left: 2px;
}
.add-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.checks {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.chk {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-primary, var(--text-secondary));
  cursor: pointer;
}
.add-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-footer {
  padding: 12px 18px;
  border-top: 1px solid var(--border, #edeef0);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.footer-hint {
  font-size: 12px;
}
</style>
