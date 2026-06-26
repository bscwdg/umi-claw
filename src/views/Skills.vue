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

interface SkillInfo {
  id: string; // 对应本地文件夹名 (slug)
  name: string; // SKILL.md 中的 name
  description: string; // SKILL.md 中的 description
  enabled: boolean; // openclaw.json 中的勾选状态
}

const skills = ref<SkillInfo[]>([]);
const loadingMap = ref<Record<string, boolean>>({});
const actionLoading = ref(false);
const toast = ref<{ msg: string; type: "success" | "error" } | null>(null);

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

function showToast(msg: string, type: "success" | "error") {
  toast.value = { msg, type };
  setTimeout(() => (toast.value = null), 2500);
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

onMounted(load);
</script>

<style scoped>
.skills-page {
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