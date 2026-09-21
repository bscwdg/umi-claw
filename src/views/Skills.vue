<template>
  <div class="skills-page">
    <div class="page-header">
      <div>
        <h1>技能管理</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          管理 OpenClaw 便携式本地技能包 (基于子目录自动扫描)
        </p>
      </div>
      <div class="flex gap-2">
        <button
          class="btn"
          @click="handleSyncFromRemote"
          :disabled="actionLoading"
        >
          ☁️ 拉取云端技能
        </button>
        <button
          class="btn btn-primary"
          @click="handleImportZip"
          :disabled="actionLoading"
        >
          📥 导入技能压缩包
        </button>
        <button class="btn" @click="enableAll" :disabled="actionLoading">
          ⚡ 一键启用全部
        </button>
      </div>
    </div>

    <div class="flex gap-3" style="margin-bottom: 4px">
      <span class="badge badge-green">已启用 {{ enabledCount }}</span>
      <span class="badge badge-blue"
        >本地共扫描到 {{ skills.length }} 个技能</span
      >
    </div>

    <!-- 云端可更新技能勾选面板：拉取同步后若有更新则出现 -->
    <div v-if="pendingUpdates.length" class="card update-panel">
      <div class="skill-header">
        <div class="skill-name">🔄 云端有 {{ pendingUpdates.length }} 个技能可更新</div>
        <label class="flex gap-2 text-sm" style="align-items: center; cursor: pointer">
          <input
            type="checkbox"
            :checked="allSelected"
            @change="toggleSelectAll"
          />
          全选
        </label>
      </div>
      <div class="update-list">
        <label
          v-for="u in pendingUpdates"
          :key="u.id"
          class="update-item"
        >
          <input type="checkbox" v-model="selectedUpdates[u.id]" />
          <span class="update-id">{{ u.id }}</span>
          <span class="text-muted text-xs">
            {{ u.localVersion ?? "未记录" }} → {{ u.remoteVersion }}
            <span v-if="!u.localVersion" class="badge badge-yellow">未记录过版本</span>
          </span>
        </label>
      </div>
      <div class="flex gap-2" style="justify-content: flex-end; margin-top: 10px">
        <button class="btn btn-sm" @click="dismissUpdates" title="仅本次忽略，下次拉取同步时会重新提示">
          忽略
        </button>
        <button
          class="btn btn-sm btn-primary"
          @click="handleApplyUpdates"
          :disabled="updating || selectedCount === 0"
        >
          {{ updating ? "更新中..." : `更新所选 (${selectedCount})` }}
        </button>
      </div>
    </div>

    <div class="skills-grid">
      <div v-for="skill in skills" :key="skill.id" class="skill-card card">
        <div class="skill-header">
          <div class="skill-name">{{ skill.name }}</div>
          <span class="text-muted text-xs">ID: {{ skill.id }}</span>
        </div>
        <p class="skill-desc text-muted text-sm">{{ skill.description }}</p>
        <div class="skill-footer">
          <span
            :class="skill.enabled ? 'badge badge-green' : 'badge badge-yellow'"
          >
            {{ skill.enabled ? "运行中" : "已禁用" }}
          </span>
          <div class="flex gap-2">
            <button
              v-if="!skill.enabled"
              class="btn btn-sm btn-success"
              @click="toggleSkill(skill.id, true)"
              :disabled="loadingMap[skill.id]"
            >
              {{ loadingMap[skill.id] ? "请稍候..." : "启用" }}
            </button>
            <button
              v-else
              class="btn btn-sm btn-danger"
              @click="toggleSkill(skill.id, false)"
              :disabled="loadingMap[skill.id]"
            >
              {{ loadingMap[skill.id] ? "请稍候..." : "禁用" }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="skills.length === 0"
      class="text-muted text-center"
      style="padding: 40px 0"
    >
      📂 暂未在 data/config/.openclaw/skills/ 目录下检测到子技能。
    </div>

    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useToast } from "@/composables/useToast";

interface SkillInfo {
  id: string; // 对应本地文件夹名 (slug)
  name: string; // SKILL.md 中的 name
  description: string; // SKILL.md 中的 description
  enabled: boolean; // openclaw.json 中的勾选状态
}

const skills = ref<SkillInfo[]>([]);
const loadingMap = ref<Record<string, boolean>>({});
const actionLoading = ref(false);
const { toast, showToast } = useToast();

// ── 云端技能更新面板状态 ──
interface UpdateCandidate {
  id: string;
  remoteVersion: string;
  localVersion: string | null;
}
const pendingUpdates = ref<UpdateCandidate[]>([]);
const selectedUpdates = ref<Record<string, boolean>>({});
const updating = ref(false);

const selectedCount = computed(
  () => Object.values(selectedUpdates.value).filter(Boolean).length
);
const allSelected = computed(
  () =>
    pendingUpdates.value.length > 0 &&
    pendingUpdates.value.every((u) => selectedUpdates.value[u.id])
);

function toggleSelectAll() {
  const target = !allSelected.value;
  for (const u of pendingUpdates.value) {
    selectedUpdates.value[u.id] = target;
  }
}

function dismissUpdates() {
  pendingUpdates.value = [];
  selectedUpdates.value = {};
}

// 动态计算当前已开启的技能数量
const enabledCount = computed(
  () => skills.value.filter((s) => s.enabled).length
);

// 对应方向 A：全量扫描本地便携式子目录
async function load() {
  // 调用刚才在主进程实现好的 getInstalledSkills
  skills.value = await window.api.skills.getInstalledSkills();
}

// 对应方向 A 核心配套：动态控制启用/禁用
async function toggleSkill(id: string, targetStatus: boolean) {
  loadingMap.value[id] = true;
  try {
    // 调用主进程的 toggleSkillStatus 接口
    await window.api.skills.toggleSkillStatus(id, targetStatus);
    showToast(targetStatus ? "技能已成功启用" : "技能已成功禁用", "success");
    await load(); // 重新加载对齐最新状态
  } catch (err) {
    showToast("操作失败，请查看后台控制台", "error");
  } finally {
    loadingMap.value[id] = false;
  }
}

// 一键打开所有扫描到的本地技能
async function enableAll() {
  actionLoading.value = true;
  const disabledSkills = skills.value.filter((s) => !s.enabled);
  for (const skill of disabledSkills) {
    await window.api.skills.toggleSkillStatus(skill.id, true);
  }
  await load();
  showToast(`已一键启用 ${disabledSkills.length} 个本地技能`, "success");
  actionLoading.value = false;
}

// 🟢 从 Gitee 云端技能仓库同步官方技能（与初始化共用主进程 SkillSyncService）
async function handleSyncFromRemote() {
  actionLoading.value = true;
  try {
    const result = await window.api.skills.syncFromRemote();
    if (result.success) {
      // 可更新列表进勾选面板（默认全选），与「跳过」分开表述
      pendingUpdates.value = result.updates ?? [];
      selectedUpdates.value = {};
      for (const u of pendingUpdates.value) {
        selectedUpdates.value[u.id] = true;
      }
      const updateHint = pendingUpdates.value.length
        ? `、可更新 ${pendingUpdates.value.length} 个（见下方列表）`
        : "";
      if (result.failed.length > 0) {
        // 单槽 toast，成功概览 + 失败明细合并成一条 warning
        showToast(
          `云端同步完成：新装 ${result.installed.length} 个、跳过 ${
            result.skipped.length
          } 个${updateHint}，失败 ${result.failed.length} 个（${result.failed
            .map((f: { file: string; error: string }) => f.file)
            .join("、")}）`,
          "warning"
        );
      } else {
        showToast(
          `云端同步完成：新装 ${result.installed.length} 个，跳过 ${result.skipped.length} 个${updateHint}`,
          "success"
        );
      }
      await load(); // 刷新列表，新技能以「已禁用」状态上架
    } else {
      showToast(result.error || "云端技能拉取失败", "error");
    }
  } catch (err) {
    showToast(`云端拉取发生系统异常${err}`, "error");
  } finally {
    actionLoading.value = false;
  }
}

// 🟢 应用勾选的云端技能更新（staging 覆盖替换，enabled 状态保留）
async function handleApplyUpdates() {
  const ids = pendingUpdates.value
    .filter((u) => selectedUpdates.value[u.id])
    .map((u) => u.id);
  if (ids.length === 0) return;
  updating.value = true;
  try {
    const result = await window.api.skills.applyUpdates(ids);
    const failText = result.failed.length
      ? `，失败 ${result.failed.length} 个（${result.failed
          .map((f: { id: string; error: string }) => f.id)
          .join("、")}）`
      : "";
    showToast(
      `云端技能更新完成：${result.updated.length} 个已更新${failText}`,
      result.failed.length ? "warning" : "success"
    );
    // 已更新项从面板移除，失败的保留可重试；刷新列表
    pendingUpdates.value = pendingUpdates.value.filter(
      (u) => !result.updated.includes(u.id)
    );
    for (const id of result.updated) {
      delete selectedUpdates.value[id];
    }
    await load();
  } catch (err) {
    showToast(`更新发生系统异常${err}`, "error");
  } finally {
    updating.value = false;
  }
}

// 🟢 新增：处理压缩包导入并自动刷新列表
async function handleImportZip() {
  actionLoading.value = true;
  try {
    const result = await window.api.skills.importSkillZip();
    if (result.success) {
      showToast("技能包导入并解压成功！已自动上架。", "success");
      await load(); // 刷新列表，新导入的技能卡片会立刻呈现出来
    } else {
      // 如果是用户取消，不弹错误提示
      if (result.error !== "用户取消了选择") {
        showToast(result.error || "导入失败", "error");
      }
    }
  } catch (err) {
    showToast(`导入发生系统异常${err}`, "error");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(async () => {
  await load();
  // 跳页回来时从主进程缓存恢复勾选面板，避免重新拉远端
  try {
    const cached = await window.api.skills.getPendingUpdates();
    if (Array.isArray(cached) && cached.length && !pendingUpdates.value.length) {
      pendingUpdates.value = cached;
      for (const u of pendingUpdates.value) {
        selectedUpdates.value[u.id] = true;
      }
    }
  } catch {
    /* 恢复失败不影响页面 */
  }
});
</script>

<style scoped>
.skills-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.skill-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  transition: all 0.15s;
}
.skill-card:hover {
  border-color: var(--accent);
}
.skill-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.skill-name {
  font-size: 14px;
  font-weight: 600;
}
.skill-desc {
  line-height: 1.5;
  min-height: 42px;
} /* 保持卡片等高体验 */
.skill-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
}

/* 云端可更新技能勾选面板 */
.update-panel {
  padding: 16px;
}
.update-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.update-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.update-id {
  font-weight: 600;
  font-size: 13px;
}

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
.toast.warning {
  background: rgba(245, 158, 11, 0.9);
  color: #fff;
}
</style>
