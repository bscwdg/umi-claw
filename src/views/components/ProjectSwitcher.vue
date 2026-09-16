<template>
  <div class="project-switcher">
    <!-- 当前商家（点击展开） -->
    <button class="ps-current" :class="{ active: store.currentProject }" @click="switcher.toggle()">
      <span class="ps-avatar">🏪</span>
      <span class="ps-info">
        <span class="ps-label">当前商家</span>
        <span class="ps-name">{{ store.currentProject?.name || '未选择商家' }}</span>
      </span>
      <span class="ps-caret">{{ open ? '▲' : '▼' }}</span>
    </button>

    <!-- 展开面板 -->
    <div v-if="open" class="ps-backdrop" @click="switcher.close()"></div>
    <div v-if="open" class="ps-panel">
      <div class="ps-section-title">我的商家</div>

      <div class="ps-list">
        <div v-if="store.loading && !store.projects.length" class="ps-empty">加载中…</div>
        <div v-else-if="!store.projects.length" class="ps-empty">
          还没有商家。每个商家 = 一个独立工作空间。
        </div>
        <button
          v-for="p in store.projects"
          :key="p.id"
          class="ps-item"
          :class="{ active: p.id === store.currentProjectId }"
          @click="onSelect(p.id)"
        >
          <span class="ps-item-main">
            <span class="ps-item-name">{{ p.name }}</span>
            <span v-if="p.industry" class="ps-item-meta">{{ p.industry }}</span>
          </span>
          <span v-if="p.id === store.currentProjectId" class="ps-item-check">✓</span>
        </button>
      </div>

      <div class="ps-actions">
        <button class="btn btn-sm" @click="startCreate">＋ 新建</button>
        <button v-if="store.currentProject" class="btn btn-sm" @click="startRename">重命名</button>
        <button
          v-if="store.currentProject"
          class="btn btn-sm btn-danger"
          @click="showDelete = true"
        >
          删除
        </button>
      </div>

      <!-- 新建 / 重命名 内联表单 -->
      <div v-if="mode" class="ps-form">
        <input
          v-model="form.name"
          class="form-input"
          placeholder="商家名称（必填）"
          @keyup.enter="submit"
        />
        <input
          v-model="form.industry"
          class="form-input"
          placeholder="行业（如 摄影 / 女装）"
          @keyup.enter="submit"
        />
        <textarea
          v-model="form.description"
          class="form-textarea"
          rows="2"
          placeholder="一句话描述（可选）"
        ></textarea>
        <div v-if="errorMsg" class="ps-error">{{ errorMsg }}</div>
        <div class="ps-form-actions">
          <button class="btn btn-sm" :disabled="busy" @click="reset()">取消</button>
          <button class="btn btn-sm btn-primary" :disabled="busy" @click="submit">
            {{ busy ? '处理中…' : mode === 'create' ? '创建' : '保存' }}
          </button>
        </div>
      </div>

      <div v-else-if="errorMsg" class="ps-error">{{ errorMsg }}</div>
    </div>

    <!-- 删除确认（§十 v1.10：物理删除、先目录后行） -->
    <ConfirmDialog
      v-model:visible="showDelete"
      icon="🗑️"
      title="删除商家"
      :confirm-text="deleting ? '删除中…' : '确认删除'"
      cancel-text="取消"
      danger
      @confirm="doDelete"
    >
      <p class="ps-del-line">
        将删除商家「<strong>{{ store.currentProject?.name }}</strong>」：
      </p>
      <ul class="ps-del-list">
        <li>商家资料 / 知识库 / 内容等结构化数据（级联清空）</li>
        <li>本地文件目录 <code>data/projects/&lt;id&gt;/</code></li>
      </ul>
      <p class="ps-del-note">物理删除，不可恢复；若目录被占用会中止并提示重试。</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMarketingStore } from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import ConfirmDialog from './ConfirmDialog.vue'

const store = useMarketingStore()
const switcher = useProjectSwitcher()
const { open } = switcher

const mode = ref<'create' | 'rename' | null>(null)
const form = ref({ name: '', industry: '', description: '' })
const busy = ref(false)
const errorMsg = ref('')
const showDelete = ref(false)
const deleting = ref(false)

onMounted(() => {
  store.load()
})

function reset() {
  mode.value = null
  errorMsg.value = ''
  form.value = { name: '', industry: '', description: '' }
}

function startCreate() {
  mode.value = 'create'
  errorMsg.value = ''
  form.value = { name: '', industry: '', description: '' }
}

function startRename() {
  const p = store.currentProject
  mode.value = 'rename'
  errorMsg.value = ''
  form.value = {
    name: p?.name || '',
    industry: p?.industry || '',
    description: p?.description || ''
  }
}

function failText(e: unknown, fallback: string) {
  const msg = (e as { message?: string })?.message
  return msg || store.error || fallback
}

async function submit() {
  if (busy.value) return
  const name = form.value.name.trim()
  if (!name) {
    errorMsg.value = '商家名称不能为空'
    return
  }
  busy.value = true
  errorMsg.value = ''
  try {
    const industry = form.value.industry.trim()
    const description = form.value.description.trim()
    if (mode.value === 'create') {
      await store.create({ name, industry, description })
    } else {
      const id = store.currentProjectId
      if (!id) throw new Error('没有选中的商家')
      await store.rename(id, { name, industry, description })
    }
    reset()
  } catch (e) {
    errorMsg.value = failText(e, mode.value === 'create' ? '创建失败' : '保存失败')
  } finally {
    busy.value = false
  }
}

async function onSelect(id: string) {
  if (id === store.currentProjectId) {
    switcher.close()
    return
  }
  errorMsg.value = ''
  try {
    await store.select(id)
    switcher.close()
  } catch (e) {
    errorMsg.value = failText(e, '切换失败')
  }
}

async function doDelete() {
  const id = store.currentProjectId
  if (!id) return
  deleting.value = true
  errorMsg.value = ''
  try {
    await store.remove(id)
    reset()
  } catch (e) {
    // §十：删行/删目录失败时不声称成功 —— 把面板留在打开状态让用户重试
    errorMsg.value = failText(e, '删除失败，可重试')
    switcher.show()
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.project-switcher {
  position: relative;
}

/* 当前商家按钮 */
.ps-current {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
}
.ps-current:hover {
  border-color: var(--border);
  color: var(--text-primary);
}
.ps-current.active {
  border-color: var(--accent-muted);
  background: var(--accent-muted);
}
.ps-avatar {
  font-size: 16px;
  flex-shrink: 0;
}
.ps-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.ps-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.ps-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-caret {
  font-size: 9px;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* 展开面板 */
.ps-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.ps-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 70vh;
  overflow-y: auto;
}
.ps-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.06em;
}
.ps-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ps-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 4px;
  line-height: 1.5;
}
.ps-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 9px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  text-align: left;
  transition: all 0.12s;
}
.ps-item:hover {
  background: var(--bg-overlay);
  color: var(--text-primary);
}
.ps-item.active {
  background: var(--accent-muted);
  color: var(--accent);
}
.ps-item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ps-item-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-item-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.ps-item-check {
  font-size: 12px;
  flex-shrink: 0;
}
.ps-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px solid var(--border-muted);
}
.ps-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-muted);
}
.ps-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.ps-error {
  font-size: 12px;
  color: var(--red);
  line-height: 1.5;
  word-break: break-word;
}

/* 删除确认内容 */
.ps-del-line {
  margin: 0 0 8px;
  line-height: 1.6;
}
.ps-del-list {
  margin: 0 0 8px;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.ps-del-note {
  margin: 0;
  font-size: 12px;
  color: var(--yellow);
  line-height: 1.5;
}
.ps-del-list code {
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
