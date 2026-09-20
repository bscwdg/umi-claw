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
        <button
          class="btn"
          :disabled="marketing.hotScoring"
          title="忽略 24 小时缓存，让 AI 重新分析当前视角下的全部热点"
          @click="rescore()"
        >
          {{ marketing.hotScoring ? 'AI 分析中…' : '重新分析' }}
        </button>
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
        热点榜单本身全商家共享，但「带去内容中心」要知道写给谁、发到哪个平台。
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

      <!-- 今日建议（v1.12：1 条主推 + 理由 + 时机；评分失败只显黄条，不挡榜单） -->
      <div v-if="marketing.hotSuggestion" class="card suggest-card">
        <div class="suggest-head">
          <span class="suggest-badge">💡 今日建议</span>
          <a
            v-if="marketing.hotSuggestion.url"
            class="title-link suggest-title"
            @click="openUrl(marketing.hotSuggestion.url!)"
            >{{ marketing.hotSuggestion.title }}</a
          >
          <span v-else class="suggest-title">{{ marketing.hotSuggestion.title }}</span>
          <span class="badge badge-green">相关 {{ marketing.hotSuggestion.matchScore }}</span>
          <span class="badge badge-blue">适配 {{ marketing.hotSuggestion.platformFit }}</span>
        </div>
        <div class="suggest-body text-sm">
          <span class="text-muted">理由：</span>{{ marketing.hotSuggestion.reason }}
          <span class="text-muted" style="margin-left: 12px">时机：</span>{{ marketing.hotSuggestion.timing }}
        </div>
        <div class="suggest-actions">
          <button class="btn btn-sm btn-primary" @click="takeSuggestion()">带去内容中心</button>
        </div>
      </div>
      <div
        v-else-if="marketing.hotScoreError"
        class="card text-sm"
        style="color: var(--yellow); border-color: var(--yellow)"
      >
        ⚠️ {{ marketing.hotScoreError }}
      </div>

      <!-- 视角与数据源筛选 -->
      <div class="card filter-card">
        <div class="filter-row">
          <span class="filter-label">时间范围</span>
          <div class="tabs">
            <button
              v-for="w in WINDOW_OPTIONS"
              :key="w.hours"
              class="tab"
              :class="{ on: windowHours === w.hours }"
              @click="windowHours = w.hours"
            >
              {{ w.label }}
            </button>
          </div>
          <span class="text-sm text-muted">AI 只评近 7 天在榜热点；时间窗只改变榜单展示范围</span>
        </div>
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
            AI 相关度评分在 Commit 12 上线；当前视角决定「带去内容中心」的默认发布平台
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
        <div class="board-head">
          <h3 style="margin: 0">📈 全网热点榜 · {{ windowLabel }}</h3>
          <span v-if="marketing.hotScoring" class="text-sm" style="color: var(--green)">
            AI 分析中…{{ scoringProgress }}
          </span>
          <span v-else-if="marketing.hotScoreError" class="text-sm" style="color: var(--yellow)">
            AI 暂不可用，未评分热点可正常浏览
          </span>
          <span v-else-if="filteredBoard.length" class="text-sm text-muted">
            已按商家相关度 × 平台适配度分组
          </span>
        </div>
        <div v-if="marketing.hotLoading && !radar" class="loading-hint text-sm text-muted">采集与加载中…</div>
        <div v-else-if="!filteredBoard.length" class="empty-inline">
          <div style="font-size: 28px">🫙</div>
          <p>今天没有值得跟的。</p>
          <p class="text-muted text-sm" v-if="radar?.calendar.length">往下看节点日历，节点前备稿正当时。</p>
        </div>
        <template v-else>
          <div v-for="g in groups" :key="g.key" class="tier-group" v-show="g.items.length">
            <div class="tier-head">
              <span class="tier-name">{{ g.icon }} {{ g.label }}</span>
              <span class="text-sm text-muted">{{ g.items.length }} 条 · {{ g.hint }}</span>
            </div>
            <div v-for="t in visibleOf(g.key)" :key="t.id" class="topic">
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
                  <template v-if="t.score && t.score.match_score != null">
                    <span class="badge" :class="tierBadge(t.score.match_score, t.score.platform_fit)">
                      相关 {{ t.score.match_score }}
                    </span>
                    <span class="badge badge-muted">适配 {{ t.score.platform_fit }}</span>
                  </template>
                  <span v-else class="badge badge-muted">⏳ 待分析</span>
                </div>
                <div v-if="t.score?.reason" class="topic-reason text-sm text-muted">💡 {{ t.score.reason }}</div>
              </div>
              <button class="btn btn-sm btn-primary take-btn" @click="takeToContent(t)">带去内容中心</button>
            </div>
            <div v-if="g.items.length > TIER_PAGE" class="list-footer">
              <button class="btn btn-sm" @click="toggleGroup(g.key)">
                {{ expandedGroups.has(g.key) ? '收起，只看前 ' + TIER_PAGE + ' 条' : '展开全部 ' + g.items.length + ' 条' }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- 节点日历 -->
      <div class="card" v-if="radar?.calendar.length">
        <h3>📅 节点日历（提前备稿窗口内，{{ radar.calendar.length }} 个）</h3>
        <div class="cal-grid">
          <div v-for="t in radar.calendar" :key="t.id" class="cal-item">
            <span class="cal-title">{{ t.title }}</span>
            <button class="btn btn-sm" @click="takeToContent(t)">带去内容中心</button>
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

const publishPlatform = ref<'xiaohongshu' | 'douyin'>('xiaohongshu')
const sourceFilter = ref('')
const windowHours = ref<number>(24)
const expandedGroups = ref<Set<string>>(new Set())

const WINDOW_OPTIONS = [
  { hours: 24, label: '近 24 小时' },
  { hours: 72, label: '近 3 天' },
  { hours: 168, label: '近 7 天' }
] as const
const windowLabel = computed(
  () => WINDOW_OPTIONS.find((w) => w.hours === windowHours.value)?.label ?? '近 24 小时'
)
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

// v1.11 四档分组（阈值与后端 hotScoreManager.scoreTier 静态契约锁定，双端不得漂移）
type TierKey = 'hot' | 'watch' | 'skip' | 'pending'
const TIER_DEFS = [
  { key: 'hot', label: '值得跟', icon: '🔥', hint: '相关度与平台适配都 ≥70，优先跟' },
  { key: 'watch', label: '观察', icon: '👀', hint: '至少一项在 40-69，可结合排期观察' },
  { key: 'skip', label: '不建议', icon: '❌', hint: '两项都 <40，与当前商家/平台不匹配' },
  { key: 'pending', label: '待分析', icon: '⏳', hint: 'AI 尚未评分，打开雷达后每批 30 条自动续评' }
] as const
const TIER_PAGE = 10

function tierOf(topic: HotTopic): TierKey {
  const m = topic.score?.match_score
  const f = topic.score?.platform_fit
  if (typeof m !== 'number' || typeof f !== 'number') return 'pending'
  if (m >= 70 && f >= 70) return 'hot'
  if (m < 40 && f < 40) return 'skip'
  return 'watch'
}
function tierBadge(match: number | null, fit: number | null): string {
  if (typeof match !== 'number' || typeof fit !== 'number') return 'badge-muted'
  if (match >= 70 && fit >= 70) return 'badge-green'
  if (match < 40 && fit < 40) return 'badge-muted'
  return 'badge-yellow'
}
const groups = computed(() => {
  const buckets: Record<TierKey, HotTopic[]> = { hot: [], watch: [], skip: [], pending: [] }
  for (const t of filteredBoard.value) buckets[tierOf(t)].push(t)
  const cmpScore = (a: HotTopic, b: HotTopic): number => {
    const sa = (a.score?.match_score ?? 0) + (a.score?.platform_fit ?? 0)
    const sb = (b.score?.match_score ?? 0) + (b.score?.platform_fit ?? 0)
    if (sa !== sb) return sb - sa
    // 平分兜底与后端 hotShared.compareHeatRank 同口径（heat→rank→last_seen），双端不得漂移
    const ha = a.heat ?? -1
    const hb = b.heat ?? -1
    if (ha !== hb) return hb - ha
    const ra = a.rank ?? 9999
    const rb = b.rank ?? 9999
    if (ra !== rb) return ra - rb
    return (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0)
  }
  buckets.hot.sort(cmpScore)
  buckets.watch.sort(cmpScore)
  buckets.skip.sort(cmpScore)
  return TIER_DEFS.map((d) => ({ ...d, items: buckets[d.key] }))
})
function visibleOf(key: string): HotTopic[] {
  const group = groups.value.find((g) => g.key === key)
  const items = group?.items ?? []
  return expandedGroups.value.has(key) ? items : items.slice(0, TIER_PAGE)
}
function toggleGroup(key: string): void {
  const next = new Set(expandedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedGroups.value = next
}

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
    await marketing.loadHotRadar(pid, {
      platform: publishPlatform.value,
      force,
      windowHours: windowHours.value
    })
  } catch {
    /* hotError 已在状态条展示 */
  }
}

/** AI 懒评分（Commit 12）：后端无待评时零模型调用；切平台/切商家由 store 代际令牌作废旧循环 */
function scheduleScore(): void {
  const pid = marketing.currentProjectId
  if (!pid) return
  void marketing.runHotScoring(pid, publishPlatform.value, { getWindowHours: () => windowHours.value })
}

/** 手动重新分析：无视 24h TTL，当前视角全部重评 */
async function rescore(): Promise<void> {
  const pid = marketing.currentProjectId
  if (!pid || marketing.hotScoring) return
  await marketing.runHotScoring(pid, publishPlatform.value, {
    force: true,
    getWindowHours: () => windowHours.value
  })
}

const scoringProgress = computed(() => {
  const p = marketing.hotScoreProgress
  if (!p || !p.total) return ''
  return '（' + Math.max(0, p.total - p.remaining) + '/' + p.total + '）'
})

function takeSuggestion(): void {
  const s = marketing.hotSuggestion
  if (!s) return
  const topic = radar.value?.board.find((t) => t.id === s.topicId)
  if (topic) {
    takeToContent(topic)
    return
  }
  // 建议来自 24h 窗，理论上必在 board；极端情况下用建议载荷兜底跳转
  takeToContent({ id: s.topicId, title: s.title, source_platform: s.sourcePlatform, score: null } as HotTopic)
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
    await marketing.loadHotRadar(pid, {
      platform: publishPlatform.value,
      skipCollect: true,
      windowHours: windowHours.value
    })
  } catch {
    /* hotError 已在状态条展示 */
  }
  scheduleScore()
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
  scheduleScore()
})

// 切发布视角：榜单 LEFT 关联换一套评分，同时触发该平台的懒评分（两平台各评各的缓存）
watch(publishPlatform, () => {
  expandedGroups.value = new Set()
  sourceFilter.value = ''
  void reload()
  scheduleScore()
})
// 时间窗只改展示范围（评分候选窗固定 7 天），不触发评分
watch(windowHours, () => {
  void reload()
})

watch(
  () => marketing.currentProjectId,
  (pid) => {
    expandedGroups.value = new Set()
    sourceFilter.value = ''
    if (pid) {
      void reload()
      scheduleScore()
    }
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

/* Commit 12：今日建议卡 */
.suggest-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-color: rgba(63, 185, 80, 0.45);
}
.suggest-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.suggest-badge {
  font-weight: 600;
  color: var(--green);
  flex: none;
}
.suggest-title {
  font-size: 15px;
  font-weight: 600;
}
.suggest-body {
  line-height: 1.7;
}
.suggest-actions {
  display: flex;
}

/* Commit 12：分组榜单 */
.board-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.tier-group {
  margin-bottom: 14px;
}
.tier-group:last-of-type {
  margin-bottom: 0;
}
.tier-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border-muted);
}
.tier-name {
  font-weight: 600;
  font-size: 14px;
}
.topic-reason {
  line-height: 1.6;
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
