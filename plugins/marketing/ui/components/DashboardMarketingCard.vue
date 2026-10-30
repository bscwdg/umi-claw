<template>
  <!-- 营销摘要卡：从宿主 Dashboard 搬进插件（D4 / Phase 4），停用营销后整块消失 -->
  <div class="marketing-grid">
    <div class="card marketing-card">
      <div class="marketing-head">
        <span class="marketing-icon">🏪</span>
        <div>
          <div class="marketing-title">当前商家</div>
          <div class="text-sm text-muted">Business Brain</div>
        </div>
        <span v-if="marketing.currentProject" class="badge badge-green">进行中</span>
      </div>

      <div v-if="marketing.currentProject" class="marketing-body">
        <div class="biz-name">
          {{ marketing.currentProject.name }}
          <span v-if="marketing.currentProject.industry" class="badge">
            {{ marketing.currentProject.industry }}
          </span>
        </div>
        <div class="text-sm text-muted">
          {{
            marketing.currentProject.description ||
            '还没有描述 —— 去商家大脑补充定位与客群，AI 才会更懂你'
          }}
        </div>
        <div class="text-sm text-muted" style="margin-top: 6px">
          共 {{ marketing.projects.length }} 个商家 · 创建于
          {{ formatDate(marketing.currentProject.created_at) }}
        </div>
      </div>
      <div v-else class="marketing-body text-sm text-muted">
        还没有选择商家。每个商家 = 一个独立工作空间（资料 / 知识库 / 内容互相隔离）。
      </div>

      <div class="marketing-actions">
        <button class="btn btn-sm btn-primary" @click="switcher.show()">
          {{ marketing.currentProject ? '切换 / 新建商家' : '＋ 新建商家' }}
        </button>
        <button
          class="btn btn-sm"
          :disabled="!marketing.currentProject"
          @click="router.push('/marketing/business')"
        >
          打开商家大脑
        </button>
      </div>
    </div>

    <div class="card marketing-card">
      <div class="marketing-head">
        <span class="marketing-icon">✨</span>
        <div>
          <div class="marketing-title">AI 营销</div>
          <div class="text-sm text-muted">AI 顾问 / 内容中心 / 🔥 热点雷达</div>
        </div>
      </div>
      <div class="marketing-body text-sm text-muted">
        已上线：AI 顾问问答、内容中心三版生成、热点雷达与 AI 商家匹配评分。
      </div>
      <div class="marketing-actions">
        <button class="btn btn-sm" @click="router.push('/marketing/advisor')">AI 顾问</button>
        <button class="btn btn-sm" @click="router.push('/marketing/content')">内容中心</button>
        <button class="btn btn-sm" @click="router.push('/marketing/hot')">🔥 热点雷达</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMarketingStore } from '../store'
import { useProjectSwitcher } from '../composables/useProjectSwitcher'

const router = useRouter()
const marketing = useMarketingStore()
const switcher = useProjectSwitcher()

function formatDate(ts: number): string {
  if (!ts) return '--'
  return new Date(ts).toLocaleDateString('zh-CN')
}

// 侧边栏切换器挂载时也会 load，这里只兜「还没人加载过」的情况
onMounted(() => {
  if (!marketing.projects.length) marketing.load()
})
</script>

<style scoped>
.marketing-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.marketing-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
}
.marketing-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.marketing-icon {
  font-size: 22px;
}
.marketing-title {
  font-size: 15px;
  font-weight: 600;
}
.marketing-body {
  line-height: 1.6;
  flex: 1;
}
.biz-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}
.marketing-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
