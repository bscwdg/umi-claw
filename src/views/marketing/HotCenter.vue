<template>
  <div class="hc">
    <div class="page-header">
      <div>
        <h1>🔥 热点雷达</h1>
        <p class="text-muted text-sm" style="margin-top: 4px">
          {{
            marketing.currentProject
              ? marketing.currentProject.name + ' · 近 24 小时全网在榜热点 + 节点日历'
              : '热点为全局数据，选择商家后按发布视角浏览'
          }}
        </p>
      </div>
      <div class="flex gap-2" v-if="marketing.currentProjectId">
        <button class="btn" :disabled="marketing.hotLoading || marketing.hotRefreshing" @click="forceRefresh()">
          {{ marketing.hotLoading || marketing.hotRefreshing ? '采集处理中…' : '立即刷新' }}
        </button>
      </div>
    </div>

    <div v-if="loadError" class="card text-sm" style="color: var(--red); border-color: var(--red)">
      ⚠️ 商家列表加载失败：{{ loadError }}。热点数据仍可尝试加载，请检查本地数据库后重试。
    </div>

    <!-- 未选商家 -->
    <div v-if="!marketing.currentProjectId" class="card empty-card">
      <div style="font-size: 32px">🔥</div>
      <h3>还没有选择商家</h3>
      <p class="text-muted text-sm" style="max-width: 460px; line-height: 1.7">
        热点榜单本身全商家共享，但「带去 Content Center」要知道写给谁、发到哪个平台。
      </p>
      <button class="btn btn-primary" @click="switcher.show()">打开商家切换器</button>
    </div>

    <template v-else>
      <!-- 数据源状态条：成功 / 失败 / 跳过 三态分开 -->
      <div class="card status-card">
        <div class="status-line">
          <span class="text-sm" v-if="radar?.collected">
            ✅ 本轮采集完成：新增 {{ radar.collected.inserted }} · 更新 {{ radar.collected.updated }} ·
            用时 {{ radar.collected.durationMs }}ms
          </span>
          <span class="text-sm text-muted" v-else-if="lastStatus">
            上次采集 {{ formatTime(lastStatus.fetchedAt) }} · 后台运行期间每小时自动跑一轮，刷新可立即重采
          </span>
          <span class="text-sm" v-else-if="marketing.hotError || radar?.lastError" style="color: var(--red)">
            第一轮采集失败：{{ marketing.hotError || radar?.lastError }} · 点「立即刷新」重试
          </span>
          <span class="text-sm text-muted" v-else>正在完成第一轮采集（头条/B站直连，约几秒）…</span>
        </div>
        <div class="src-chips">
          <span
            v-for="s in statusSources"
            :key="s.sourcePlatform + '|' + s.source"
            class="src-chip"
            :class="s.ok ? 'ok' : 'fail'"
            :title="s.ok ? '' : s.error || '失败'"
          >
            {{ s.ok ? '✓' : '✗' }} {{ sourceLabel(s.sourcePlatform) }}
            <template v-if="s.ok"> · {{ s.count }} 条</template>
            <template v-else> · {{ s.error || '失败' }}</template>
          </span>
          <span v-if="dailyhotSkipped" class="src-chip skip" title="自部署 DailyHotApi（默认端口 6688）后，在配置里填写地址即可启用">
            ⏭ 聚合源（抖音/微博/知乎/百度/快手）未配置，已跳过
          </span>
        </div>
        <div v-if="marketing.hotError" class="text-sm" style="color: var(--red)">⚠️ {{ marketing.hotError }}</div>
        <div v-else-if="radar?.lastError" class="text-sm" style="color: var(--yellow)">
          ⚠️ {{ radar.lastError }}（榜单仍展示库内已有热点）
        </div>
      </div>

      <!-- 视角与数据源筛选 -->
      <div class="card filter-card">
        <div class="filter-row">
          <span class="filter-label">发布视角</span>
          <div class="tabs">
            <button
              v-for="p in PUBLISH_PLATFORMS"
              :key="p.key"
              class="tab"
              :class="{ on: publishPlatform === p.key }"
              @click="publishPlatform = p.key"
            >
              {{ p.label }}视角
            </button>
          </div>
          <span class="text-sm text-muted">
            AI 相关度评分在 Commit 12 上线；当前视角决定「带去 Content Center」的默认发布平台
          </span>
        </div>
        <div class="filter-row" v-if="sourceOptions.length > 1">
          <span class="filter-label">数据源</span>
          <div class="tabs">
            <button class="tab" :class="{ on: sourceFilter === '' }" @click="sourceFilter = ''">
              全部 {{ radar?.board.length ?? 0 }}
            </button>
            <button
              v-for="s in sourceOptions"
              :key="s.platform"
              class="tab"
              :class="{ on: sourceFilter === s.platform }"
              @click="sourceFilter = s.platform"
            >
              {{ sourceLabel(s.platform) }} {{ s.count }}
            </button>
          </div>
        </div>
        <div v-if="publishPlatform === 'xiaohongshu'" class="text-sm text-muted">
          小红书没有公开、稳定、免鉴权的热榜：下面适合小红书的选题来自<strong>综合平台热点与节点日历</strong>，成稿时按小红书口径改写。
        </div>
      </div>

      <!-- 榜单 -->
      <div class="card">
        <h3>📈 全网热点榜 · 近 24h</h3>
        <div v-if="marketing.hotLoading && !radar" class="loading-hint text-sm text-muted">采集与加载中…</div>
        <div v-else-if="!filteredBoard.length" class="empty-inline">
          <div style="font-size: 28px">🫙</div>
          <p>今天没有值得跟的。</p>
          <p class="text-muted text-sm" v-if="radar?.calendar.length">往下看节点日历，节点前备稿正当时。</p>
        </div>
        <template v-else>
          <div v-for="t in visibleBoard" :key="t.id" class="topic">
            <span class="rank" :class="rankClass(t.rank)">{{ t.rank ?? '·' }}</span>
            <div class="topic-main">
              <div class="topic-title">
                <a v-if="t.url" class="title-link" @click="openUrl(t.url)">{{ t.title }}</a>
                <span v-else>{{ t.title }}</span>
              </div>
              <div class="topic-meta">
                <span class="badge badge-blue">{{ sourceLabel(t.source_platform) }}</span>
                <span v-if="lifecycleMeta(t.lifecycle)" class="badge" :class="lifecycleMeta(t.lifecycle)!.cls">
                  {{ lifecycleMeta(t.lifecycle)!.label }}
                </span>
                <span class="text-sm text-muted">{{ heatText(t.heat) }}</span>
                <span v-if="t.score?.match_score != null" class="badge badge-green">
                  相关度 {{ t.score.match_score }}
                </span>
              </div>
            </div>
            <button class="btn btn-sm btn-primary take-btn" @click="takeToContent(t)">带去 Content Center</button>
          </div>
          <div v-if="filteredBoard.length > PAGE_SIZE" class="list-footer">
            <button class="btn btn-sm" @click="expanded = !expanded">
              {{ expanded ? '收起，只看 Top ' + PAGE_SIZE : '展开全部 ' + filteredBoard.length + ' 条' }}
            </button>
          </div>
        </template>
      </div>

      <!-- 节点日历 -->
      <div class="card" v-if="radar?.calendar.length">
        <h3>📅 节点日历（提前备稿窗口内，{{ radar.calendar.length }} 个）</h3>
        <div class="cal-grid">
          <div v-for="t in radar.calendar" :key="t.id" class="cal-item">
            <span class="cal-title">{{ t.title }}</span>
            <button class="btn btn-sm" @click="takeToContent(t)">带去 Content Center</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMarketingStore, type HotTopic } from '@/stores/marketing'
import { useProjectSwitcher } from '@/composables/useProjectSwitcher'
import { setContentPrefill } from '@/composables/useContentPrefill'

const marketing = useMarketingStore()
const switcher = useProjectSwitcher()
const router = useRouter()

const PUBLISH_PLATFORMS = [
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'douyin', label: '抖音' }
] as const

const PAGE_SIZE = 20

const publishPlatform = ref<'xiaohongshu' | 'douyin'>('xiaohongshu')
const sourceFilter = ref('')
const expanded = ref(false)
const loadError = ref<string | null>(null)

const radar = computed(() => marketing.hotRadar)
const lastStatus = computed(() => radar.value?.lastStatus ?? null)
const statusSources = computed(() => {
  const s = radar.value?.collected?.sources ?? radar.value?.lastStatus?.sources ?? []
  return s
})
// C5：不能只凭「状态里没有 dailyhot」推断未配置——首轮整体失败时也没有，
// 会把已配置的聚合源误报成「已跳过」。只有拿到过一轮成功状态且其中确无聚合源时才提示。
const dailyhotSkipped = computed(
  () => !!lastStatus.value && !radar.value?.lastError && !statusSources.value.some((s) => s.source.startsWith('dailyhot:'))
)

const sourceOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const t of radar.value?.board ?? []) {
    counts.set(t.source_platform, (counts.get(t.source_platform) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count)
})

const filteredBoard = computed(() => {
  const board = radar.value?.board ?? []
  return sourceFilter.value ? board.filter((t) => t.source_platform === sourceFilter.value) : board
})
const visibleBoard = computed(() =>
  expanded.value ? filteredBoard.value : filteredBoard.value.slice(0, PAGE_SIZE)
)

const SOURCE_LABELS: Record<string, string> = {
  toutiao: '头条',
  bilibili: 'B站',
  douyin: '抖音',
  weibo: '微博',
  zhihu: '知乎',
  baidu: '百度',
  kuaishou: '快手',
  calendar: '节点日历'
}
function sourceLabel(platform: string): string {
  if (SOURCE_LABELS[platform]) return SOURCE_LABELS[platform]
  if (platform.startsWith('dailyhot:')) return '聚合·' + platform.slice('dailyhot:'.length)
  return platform
}

const LIFECYCLE_META: Record<string, { label: string; cls: string }> = {
  new: { label: '新上榜', cls: 'badge-blue' },
  rising: { label: '上升中', cls: 'badge-green' },
  breaking: { label: '爆发', cls: 'badge-red' },
  peak: { label: '高热', cls: 'badge-yellow' },
  long_tail: { label: '降温', cls: 'badge-muted' }
}
function lifecycleMeta(v: string | null): { label: string; cls: string } | null {
  return v && LIFECYCLE_META[v] ? LIFECYCLE_META[v] : null
}

function rankClass(rank: number | null): string {
  if (rank === null) return ''
  if (rank <= 3) return 'rank-top'
  if (rank <= 10) return 'rank-hot'
  return ''
}

function heatText(heat: number | null): string {
  if (typeof heat !== 'number' || !Number.isFinite(heat)) return '热度暂无'
  if (heat >= 100000000) return (heat / 100000000).toFixed(1) + ' 亿热度'
  if (heat >= 10000) return (heat / 10000).toFixed(1) + ' 万热度'
  return String(heat) + ' 热度'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function openUrl(url: string): void {
  // 协议白名单：榜单 url 来自外部接口，只放行 http(s)，防 javascript:/file: 等注入系统浏览器
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  window.api.shell.openExternal(parsed.toString()).catch(() => undefined)
}

/** 一键只带草稿（硬规则 10）：预填选题与发布平台，不自动生成、不自动发布 */
function takeToContent(topic: HotTopic): void {
  setContentPrefill({
    topicId: topic.id,
    title: topic.title,
    sourcePlatform: topic.source_platform,
    platform: publishPlatform.value,
    contentAngle: topic.score?.content_angle ?? null,
    lifecycleAdvice: topic.score?.lifecycle_advice ?? null
  })
  router.push('/marketing/content')
}

async function reload(force = false): Promise<void> {
  const pid = marketing.currentProjectId
  if (!pid) return
  try {
    await marketing.loadHotRadar(pid, { platform: publishPlatform.value, force })
  } catch {
    /* hotError 已在状态条展示 */
  }
}

/** 立即刷新：先走全局强制采集（全源失败会抛错 → 状态条显红），再重载库内榜单 */
async function forceRefresh(): Promise<void> {
  try {
    await marketing.refreshHot()
  } catch {
    /* 全源失败：hotError 已置位；继续往下读库内旧榜 */
  }
  const pid = marketing.currentProjectId
  if (!pid) return
  try {
    // skipCollect：强制采集刚跑完，这里只读库渲染；否则全源失败时 last_fetch 未推进，
    // listRadar 会立刻起第二轮采集，双倍连打端点、按钮卡 ~90s
    await marketing.loadHotRadar(pid, { platform: publishPlatform.value, skipCollect: true })
  } catch {
    /* hotError 已在状态条展示 */
  }
}

onMounted(async () => {
  if (!marketing.projects.length) {
    try {
      await marketing.load()
    } catch (e) {
      // 商家列表加载失败不得阻断雷达挂载：reload 照常尝试，错误就地提示
      loadError.value = e instanceof Error ? e.message : '商家数据加载失败'
    }
  }
  await reload()
})

watch(
  () => marketing.currentProjectId,
  (pid) => {
    if (pid) void reload()
    else marketing.clearHot()
  }
)

onBeforeUnmount(() => {
  marketing.clearHot()
})
</script>

<style scoped>
.hc {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
}
.status-line {
  display: flex;
  align-items: center;
  gap: 10px;
}
.src-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.src-chip {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border-muted);
  background: var(--bg-elevated);
}
.src-chip.ok {
  color: var(--green);
  border-color: rgba(63, 185, 80, 0.4);
}
.src-chip.fail {
  color: var(--red);
  border-color: rgba(248, 81, 73, 0.4);
}
.src-chip.skip {
  color: var(--text-muted);
}

.filter-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.filter-label {
  font-size: 13px;
  color: var(--text-muted);
  min-width: 56px;
}
.badge-muted {
  background: var(--bg-elevated);
  color: var(--text-muted);
}

.loading-hint,
.empty-inline {
  padding: 28px 12px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.topic {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--border-muted);
}
.topic:last-of-type {
  border-bottom: none;
}
.rank {
  width: 28px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex: none;
}
.rank-top {
  color: var(--red);
  font-size: 17px;
}
.rank-hot {
  color: var(--yellow);
}
.topic-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.topic-title {
  font-size: 14px;
  line-height: 1.5;
  word-break: break-all;
}
.title-link {
  cursor: pointer;
  color: var(--text-primary);
}
.title-link:hover {
  color: var(--accent);
}
.topic-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.take-btn {
  flex: none;
}
.list-footer {
  display: flex;
  justify-content: center;
  padding-top: 12px;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.cal-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-elevated);
}
.cal-title {
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: 640px) {
  .take-btn {
    padding: 4px 8px;
    font-size: 12px;
  }
}
</style>
