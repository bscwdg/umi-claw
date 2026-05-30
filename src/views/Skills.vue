<template>
  <div class="skills-page">
    <div class="page-header">
      <div>
        <h1>技能管理</h1>
        <p class="text-muted text-sm" style="margin-top:4px">管理 OpenClaw 内置中文技能包</p>
      </div>
      <div class="flex gap-2">
        <button class="btn" @click="installAll" :disabled="actionLoading">
          📦 一键安装全部
        </button>
      </div>
    </div>

    <!-- Stats -->
    <div class="flex gap-3" style="margin-bottom:4px">
      <span class="badge badge-green">已安装 {{ installedCount }}</span>
      <span class="badge badge-blue">共 {{ skills.length }} 个技能</span>
    </div>

    <!-- Skills Grid -->
    <div class="skills-grid">
      <div v-for="skill in skills" :key="skill.id" class="skill-card card">
        <div class="skill-header">
          <div class="skill-name">{{ skill.name }}</div>
          <span :class="skill.installed ? 'badge badge-green' : 'badge badge-yellow'">
            {{ skill.installed ? '已安装' : '未安装' }}
          </span>
        </div>
        <p class="skill-desc text-muted text-sm">{{ skill.description }}</p>
        <div class="skill-footer">
          <span class="badge badge-blue text-sm">内置技能</span>
          <div class="flex gap-2">
            <button
              v-if="!skill.installed"
              class="btn btn-sm btn-success"
              @click="installSkill(skill.id)"
              :disabled="loadingMap[skill.id]"
            >
              {{ loadingMap[skill.id] ? '安装中...' : '安装' }}
            </button>
            <button
              v-else
              class="btn btn-sm btn-danger"
              @click="uninstallSkill(skill.id)"
              :disabled="loadingMap[skill.id]"
            >
              {{ loadingMap[skill.id] ? '卸载中...' : '卸载' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <transition name="slide">
      <div v-if="toast" class="toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface SkillInfo {
  id: string
  name: string
  description: string
  installed: boolean
  builtin: boolean
}

const skills = ref<SkillInfo[]>([])
const loadingMap = ref<Record<string, boolean>>({})
const actionLoading = ref(false)
const toast = ref<{ msg: string; type: 'success' | 'error' } | null>(null)

const installedCount = computed(() => skills.value.filter((s) => s.installed).length)

async function load() {
  skills.value = await window.api.skills.list()
}

async function installSkill(id: string) {
  loadingMap.value[id] = true
  const result = await window.api.skills.install(id)
  if (result.success) {
    showToast('技能安装成功', 'success')
    await load()
  } else {
    showToast(result.error || '安装失败', 'error')
  }
  loadingMap.value[id] = false
}

async function uninstallSkill(id: string) {
  loadingMap.value[id] = true
  const result = await window.api.skills.uninstall(id)
  if (result.success) {
    showToast('技能已卸载', 'success')
    await load()
  } else {
    showToast(result.error || '卸载失败', 'error')
  }
  loadingMap.value[id] = false
}

async function installAll() {
  actionLoading.value = true
  const uninstalled = skills.value.filter((s) => !s.installed)
  for (const skill of uninstalled) {
    await window.api.skills.install(skill.id)
  }
  await load()
  showToast(`已安装 ${uninstalled.length} 个技能`, 'success')
  actionLoading.value = false
}

function showToast(msg: string, type: 'success' | 'error') {
  toast.value = { msg, type }
  setTimeout(() => (toast.value = null), 2500)
}

onMounted(load)
</script>

<style scoped>
.skills-page { display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; }

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
.skill-card:hover { border-color: var(--accent); }
.skill-header { display: flex; align-items: center; justify-content: space-between; }
.skill-name { font-size: 14px; font-weight: 600; }
.skill-desc { line-height: 1.5; }
.skill-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
}

.toast {
  position: fixed; bottom: 24px; right: 24px;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  font-size: 13px; font-weight: 500; z-index: 999;
}
.toast.success { background: rgba(63,185,80,0.9); color: #fff; }
.toast.error   { background: rgba(248,81,73,0.9); color: #fff; }
</style>
