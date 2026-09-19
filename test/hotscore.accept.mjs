// test/hotscore.accept.mjs —— Commit 12 验收：热点 AI 商家匹配（懒评分）
//
// **打真实源码**：esbuild bundle 真 hotScoreManager.ts（连带真 ContextEngine、
// renderContextPackText/platformRules）+ 真四个 Manager + 真 DB Worker；
// AI 侧用注入式假 Gateway（只实现 chat()，记录 messages/温度/抛错行为），不发真 HTTP。
//
// 覆盖（对齐 PLAN-2.0.md §七 12 行 / v1.8 评分边界 / v1.9 TTL / v1.11 四档 / v1.12 今日建议）：
//   S1 候选选取：只评近 7 天 board、超 30 按 heat 取前 30、日历/过期不入选；Context Pack 真注入
//   S2 TTL 短路（不调模型）+ 续批评完 + 今日建议
//   S3 force 无视 TTL
//   S4 双平台各评各的（platform_fit 按平台，行不串）
//   S5 部分失败容错（坏条目丢弃落库成功的、留下批）
//   S6 整次失败（OPENCLAW_NOT_READY）原样抛、零落库、不影响裸榜
//   S7 垃圾 JSON 抛 VALIDATION_ERROR
//   S8 纯函数：四档阈值/分数清洗/JSON 容错解析/时机兜底/今日建议排序与窗口
//   S9 今日建议端到端（双门槛 + 平分看 heat + 24h 窗）
//   S10 静态契约：通道四处/模块边界/表不加列/双端阈值/prompt 护栏
//   S12 force 水位：TTL 内旧分跨续批全部重评（复审 1）
//   S13 非法/漏回条目计入 remaining，续批补评且不重复花钱（复审 3）
//   S14 热点表/Pack 短 TTL 缓存：续批只构建一次 Pack，过期重建（复审 7）
//
// 用法：node test/hotscore.accept.mjs    （npm run accept:hotscore）

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath,
  writeJson
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, 'hotscore-' + Date.now())
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')
const EXTERNALS = ['mammoth', 'exceljs']

const scorePath = bundleEntry('electron/main/marketing/hotScoreManager.ts', 'score-manager.mjs', { externals: EXTERNALS })
const hotManagerPath = bundleEntry('electron/main/marketing/hotManager.ts', 'score-hot-manager.mjs')
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'score-context-engine.mjs', { externals: EXTERNALS })
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'score-business-manager.mjs', { externals: EXTERNALS })
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'score-knowledge-manager.mjs', { externals: EXTERNALS })
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'score-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'score-database.mjs')

const scoreMod = await import(pathToFileURL(scorePath).href)
const hotMod = await import(pathToFileURL(hotManagerPath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const {
  createHotScoreManager,
  scoreTier,
  coerceScore,
  parseScoreItems,
  extractJsonArray,
  timingFor,
  pickTodaySuggestion,
  TIER_HOT_MIN,
  TIER_WATCH_MIN
} = scoreMod
const { createContextEngine } = ctxMod
const { createHotManager } = hotMod
const { DatabaseClient } = dbMod

const T0 = Date.parse('2026-09-20T04:00:00Z')
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const r = new Recorder('hotscore（Commit 12：热点 AI 懒评分，打真 hotScoreManager + 真 ContextEngine + 真 Worker）')
const clients = new Set()

try {
  const database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-hotscore-test',
    requestTimeoutMs: 30_000
  })
  clients.add(database)

  const projects = projMod.createProjectManager({ database, dataDir, logger: () => {} })
  const business = bizMod.createBusinessManager({ database, logger: () => {} })
  const watchlist = bizMod.createWatchlistManager({ database, logger: () => {} })
  const knowledge = knowMod.createKnowledgeManager({ database, dataDir, logger: () => {} })
  const contextEngine = createContextEngine({
    projectManager: projects,
    businessManager: business,
    knowledgeManager: knowledge,
    watchlistManager: watchlist,
    logger: () => {}
  })

  // ── 造全局热点：35 条近 7 天 toutiao board（heat=1000+i）+ 1 日历 + 1 过期 ──
  async function seedTopic(o) {
    await database.request('hot_topics.create', {
      data: {
        id: o.id,
        source_platform: o.source_platform || 'toutiao',
        source: o.source || 'toutiao-web',
        origin: o.origin || 'board',
        title: o.title,
        url: o.url ?? null,
        fingerprint: 'fp-' + o.id,
        heat: o.heat ?? null,
        rank: o.rank ?? null,
        lifecycle: o.lifecycle ?? null,
        first_seen_at: o.lastSeen,
        last_seen_at: o.lastSeen
      }
    })
  }
  for (let i = 0; i < 35; i += 1) {
    await seedTopic({
      id: 't' + String(i).padStart(2, '0'),
      title: '热点编号' + i,
      heat: 1000 + i,
      rank: i + 1,
      lastSeen: T0 - HOUR,
      lifecycle: i === 34 ? 'rising' : null
    })
  }
  await seedTopic({ id: 'cal1', origin: 'calendar', source_platform: 'calendar', source: 'builtin-calendar', title: '中秋节节点', heat: null, rank: null, lastSeen: T0 - HOUR })
  await seedTopic({ id: 'old1', title: '八天前热点', heat: 9999, rank: 1, lastSeen: T0 - 8 * DAY })

  async function listScores(pid, platform) {
    const rows = await database.request('project_hot_topics.list', {
      where: { project_id: pid, platform },
      limit: 5000
    })
    return Array.isArray(rows) ? rows : []
  }

  /** 假 Gateway（SSE 形态）：responder(callIndex,input) 决定文本/抛错；记录每次调用 */
  function fakeGateway(responder) {
    const gw = {
      calls: [],
      createChatStream(input) {
        gw.calls.push(input)
        const outPromise = Promise.resolve().then(() => responder(gw.calls.length, input))
        async function* iterate() {
          const out = await outPromise
          if (out.throwError) throw out.throwError
          yield { index: 1, delta: out.text }
        }
        const result = outPromise.then((out) => {
          if (out.throwError) throw out.throwError
          return { text: out.text, chunks: 1, usage: null, model: 'openclaw', aborted: false, ms: 1 }
        })
        return { iterator: iterate(), result, cancel() {} }
      }
    }
    return gw
  }
  /** 默认应答：按 user 里的 [n] 行数回全 80/80 */
  function okResponder(callIndex, input) {
    const user = input.messages[1].content
    const n = (user.match(/^\[\d+\]/gm) || []).length
    const arr = []
    for (let i = 0; i < n; i += 1) {
      arr.push({
        idx: i,
        match_score: 80,
        platform_fit: 80,
        reason: '杭州婚纱摄影相关，可做外景选题',
        content_angle: '图文探店',
        lifecycle_advice: '明天发'
      })
    }
    return { text: JSON.stringify(arr) }
  }

  const project = await projects.createProject({ name: 'C12 光影摄影', industry: '摄影' })
  await business.upsertBusiness(project.id, {
    name: '光影婚纱摄影',
    city: '杭州',
    positioning: '轻奢外景纪实',
    tone: '亲切专业'
  })
  await watchlist.addWatch(project.id, '杭州婚纱', 'industry')

  const gateway = fakeGateway(okResponder)
  // 可变时钟：force 水位要求重评时刻严格晚于旧 scored_at（生产环境墙钟天然递增）
  const clock = { t: T0 }
  const manager = createHotScoreManager({
    database,
    contextEngine,
    gateway,
    logger: () => {},
    now: () => clock.t
  })
  const pid = project.id

  // ── S1 候选选取：只评 heat 前 30，日历/过期不入选，Context Pack 真入 prompt ──
  await r.check('S1', '懒评分候选：近7天 board、heat 前 30、日历/过期排除、资料真注入', async () => {
    const res = await manager.scoreBatch(pid, 'xiaohongshu')
    assertEq(res.scored, 30, '首批落库 30')
    assertEq(res.failed, 0, '无坏条目')
    assertEq(res.total, 35, '候选总数 35（日历/8天前不计）')
    assertEq(res.remaining, 5, '剩 5 条待续批')
    assertEq(gateway.calls.length, 1, '模型只调一次')
    const user = gateway.calls[0].messages[1].content
    const listed = (user.match(/^\[\d+\] 标题：热点编号(\d+)/gm) || []).map((s) => Number(s.match(/热点编号(\d+)/)[1]))
    assertEq(listed.length, 30, 'user 列了 30 条')
    assert(listed.includes(34) && listed.includes(5), '含 heat 前 30 边界（5..34）')
    assert(!listed.some((i) => i <= 4), 'heat 最低的 0..4 不在首批')
    assert(!user.includes('中秋节节点') && !user.includes('八天前热点'), '日历节点/过期热点不花评分钱')
    const sys = gateway.calls[0].messages[0].content
    assert(sys.includes('光影婚纱摄影'), 'system 注入商家资料（Context Pack 真打包）')
    assert(sys.includes('杭州婚纱'), 'system 含关注词')
    assert(sys.includes('小红书'), 'system 标明发布平台')
    assert(gateway.calls[0].temperature === 0.2, '低温求稳定 JSON')
    const rows = await listScores(pid, 'xiaohongshu')
    assertEq(rows.length, 30, 'project_hot_topics 落 30 行')
    const row = rows[0]
    assertEq(row.match_score, 80, 'match_score 落库')
    assertEq(row.scored_at, T0, 'scored_at 用注入时钟')
    assert(row.reason && row.reason.includes('杭州婚纱'), 'reason 落库')
  })

  // ── S2 续批评完 + TTL 短路不调模型 + 今日建议即时返回 ──────────────────────
  await r.check('S2', '续批 5 条评完；TTL 内再调零模型调用；今日建议返回', async () => {
    const second = await manager.scoreBatch(pid, 'xiaohongshu')
    assertEq(second.scored, 5, '第二批落 5 条')
    assertEq(second.remaining, 0, '评完了')
    assertEq(gateway.calls.length, 2, '第二批调一次模型')
    const user2 = gateway.calls[1].messages[1].content
    assert(user2.includes('热点编号0') && user2.includes('热点编号4'), '第二批是 heat 最低 5 条')

    const third = await manager.scoreBatch(pid, 'xiaohongshu')
    assertEq(third.scored, 0, 'TTL 内无待评')
    assertEq(gateway.calls.length, 2, 'TTL 短路：不调模型')
    assert(third.suggestion, '返回今日建议')
    assertEq(third.suggestion.topicId, 't34', '80/80 平分看 heat，最高的 t34 主推')
    assertEq(third.suggestion.timing, '明天发', '时机用模型 lifecycle_advice')
  })

  // ── S3 force：无视 TTL 立即重评 ────────────────────────────────────────────
  await r.check('S3', '手动重新分析 force=true 无视 24h TTL', async () => {
    clock.t = T0 + 1000
    const res = await manager.scoreBatch(pid, 'xiaohongshu', { force: true })
    assertEq(res.forced, true, 'forced 标记')
    assertEq(res.scored, 30, 'force 首批仍 30（重评 heat 前 30）')
    assertEq(res.remaining, 5, 'force 水位下余 5 条由续批补评（复审 1）')
    assertEq(gateway.calls.length, 3, 'TTL 内 force 仍调模型')
    const rows = await listScores(pid, 'xiaohongshu')
    assertEq(rows.length, 35, 'upsert 不产生重复行')
  })

  // ── S4 双平台隔离：小红书/抖音各评各的缓存，prompt 标明平台 ────────────────
  await r.check('S4', 'platform_fit 按平台分别评分缓存，行不串', async () => {
    const res = await manager.scoreBatch(pid, 'douyin')
    assertEq(res.scored, 30, '抖音首批 30')
    assertEq(res.remaining, 5, '抖音剩 5')
    const sysDy = gateway.calls[3].messages[0].content
    assert(sysDy.includes('抖音'), '抖音批 prompt 标明抖音平台')
    const xhs = await listScores(pid, 'xiaohongshu')
    const dy = await listScores(pid, 'douyin')
    assertEq(xhs.length, 35, '小红书评分行不受影响')
    assertEq(dy.length, 30, '抖音独立 30 行（同热点两平台各一行）')
    assert(dy.every((row) => row.platform === 'douyin'), '抖音行 platform 正确')
  })

  // ── S5 部分失败：坏条目丢弃，成功条目照常落库 ──────────────────────────────
  await r.check('S5', '单条 idx 越界/分数非法/缺字段只计 failed，好条目照落', async () => {
    const p2 = (await projects.createProject({ name: 'C12 二号店', industry: '餐饮' })).id
    const gw5 = fakeGateway(() => ({
      text: JSON.stringify([
        { idx: 0, match_score: 80, platform_fit: 75, reason: 'ok0', content_angle: 'a', lifecycle_advice: 'b' },
        { idx: 9, match_score: 80, platform_fit: 80, reason: '越界 idx' },
        { idx: 1, match_score: 999, platform_fit: 80, reason: '分数越界' },
        { idx: 2, match_score: 80, reason: '缺 platform_fit' },
        { idx: 3, match_score: 70, platform_fit: 70, reason: '长'.repeat(300) }
      ])
    }))
    const m5 = createHotScoreManager({ database, contextEngine, gateway: gw5, logger: () => {}, now: () => T0, batchSize: 5 })
    const res = await m5.scoreBatch(p2, 'xiaohongshu')
    assertEq(res.scored, 2, '只落 idx0/3 两条')
    assertEq(res.failed, 3, '坏条目计 failed')
    assertEq(res.remaining, 33, '坏 3 条仍 stale：35-2=33（旧实现误报 30 会让前端提前 break）')
    const rows = await listScores(p2, 'xiaohongshu')
    assertEq(rows.length, 2, '库里正好 2 行')
    const longOne = rows.find((row) => row.match_score === 70)
    assert(longOne && longOne.reason.length === 200, 'reason 截断到 200 字')
  })

  // ── S6 整次失败：网关错误原样抛、零落库 ────────────────────────────────────
  await r.check('S6', 'OPENCLAW_NOT_READY 原样透传，无评分落库，不吞错不包装', async () => {
    const p3 = (await projects.createProject({ name: 'C12 三号店', industry: '摄影' })).id
    const codeError = new Error('gateway not ready')
    codeError.code = 'OPENCLAW_NOT_READY'
    const gw6 = fakeGateway(async () => ({ throwError: codeError }))
    const m6 = createHotScoreManager({ database, contextEngine, gateway: gw6, logger: () => {}, now: () => T0 })
    let caught = null
    try {
      await m6.scoreBatch(p3, 'xiaohongshu')
    } catch (e) {
      caught = e
    }
    assert(caught && caught.code === 'OPENCLAW_NOT_READY', '错误码透传（前端据此降级裸榜）')
    assertEq((await listScores(p3, 'xiaohongshu')).length, 0, '整次失败零落库')
  })

  // ── S7 垃圾 JSON：VALIDATION_ERROR（reason=score-unparsable） ──────────────
  await r.check('S7', '模型不返回 JSON 数组时抛 VALIDATION_ERROR', async () => {
    const p4 = (await projects.createProject({ name: 'C12 四号店', industry: '摄影' })).id
    const gw7 = fakeGateway(() => ({ text: '我不会输出 JSON，今天天气不错' }))
    const m7 = createHotScoreManager({ database, contextEngine, gateway: gw7, logger: () => {}, now: () => T0 })
    let caught = null
    try {
      await m7.scoreBatch(p4, 'xiaohongshu')
    } catch (e) {
      caught = e
    }
    assert(caught && caught.code === 'VALIDATION_ERROR', '校验错误码')
    assertEq(caught.details && caught.details.reason, 'score-unparsable', 'details.reason 固定')
  })

  // ── S8 纯函数 ──────────────────────────────────────────────────────────────
  await r.check('S8', '四档阈值/分数清洗/JSON 容错/时机兜底（纯函数）', () => {
    assertEq(TIER_HOT_MIN, 70, 'hot 阈值 70')
    assertEq(TIER_WATCH_MIN, 40, 'watch/skip 界 40')
    assertEq(scoreTier(70, 70), 'hot', '双门槛 70/70')
    assertEq(scoreTier(70, 69), 'watch', '高相关低适配不进 hot')
    assertEq(scoreTier(90, 39), 'watch', '任一 40-69 即 watch')
    assertEq(scoreTier(39, 39), 'skip', '双低 skip')
    assertEq(scoreTier(null, 80), 'pending', '缺分待分析')
    assertEq(coerceScore('85'), 85, '数字字符串')
    assertEq(coerceScore(85.4), 85, '四舍五入')
    assertEq(coerceScore(101), null, '越界丢弃')
    assertEq(coerceScore('abc'), null, '非数丢弃')

    const good = '[{"idx":0,"match_score":80,"platform_fit":75}]'
    const noisy = '好的，结果如下：' + good + ' 以上'
    assertEq(parseScoreItems(noisy, 5).items.length, 1, '容忍解释文字夹 JSON 数组')
    const dup = '[{"idx":0,"match_score":1,"platform_fit":1},{"idx":0,"match_score":2,"platform_fit":2}]'
    const dupParsed = parseScoreItems(dup, 5)
    assertEq(dupParsed.items.length, 1, '重复 idx 只取第一条')
    assertEq(dupParsed.failed, 1, '重复 idx 计 failed')
    let badJson = null
    try {
      parseScoreItems('[{', 5)
    } catch (e) {
      badJson = e
    }
    assert(badJson && badJson.code === 'VALIDATION_ERROR', '坏 JSON 抛错')
    assertEq(extractJsonArray('no array here'), null, '无数组返回 null')

    assert(timingFor('明天晚上发', 'peak') === '明天晚上发', '模型 advice 优先')
    assert(timingFor(null, 'rising').includes('24 小时'), 'rising 本地兜底')
    assert(timingFor(null, 'long_tail').includes('尽快'), 'long_tail 本地兜底')
  })

  // ── S9 今日建议：双门槛 + 平分看 heat + 24h 窗 + 排除日历 ─────────────────
  await r.check('S9', 'pickTodaySuggestion：窗口/门槛/排序/日历排除/宁缺毋滥', () => {
    const score = (m, f) => ({
      project_id: 'p', topic_id: 'x', platform: 'xiaohongshu',
      match_score: m, platform_fit: f, reason: 'r', content_angle: null, lifecycle_advice: null, scored_at: T0
    })
    const mk = (id, m, f, lastSeen, heat, origin = 'board') => ({
      id, source_platform: 'toutiao', source: 's', origin, title: id, url: null, fingerprint: id,
      heat, rank: 1, lifecycle: null, first_seen_at: lastSeen, last_seen_at: lastSeen,
      score: m === null ? null : score(m, f)
    })
    const topics = [
      mk('watch1', 70, 69, T0, 100),
      mk('old', 90, 90, T0 - 25 * HOUR, 9999),
      mk('cal', 95, 95, T0, 8888, 'calendar'),
      mk('hotA', 80, 80, T0, 200),
      mk('hotB', 90, 70, T0, 100),
      mk('pending', null, null, T0, 50)
    ]
    assertEq(pickTodaySuggestion(topics, T0)?.topicId, 'hotA', 'old 出窗、cal 排除；hotA/hotB 平分 160 看 heat')
    const onlyWatch = [mk('w', 50, 50, T0, 1)]
    assertEq(pickTodaySuggestion(onlyWatch, T0), null, '无 hot 档不硬凑建议')
  })

  // ── S10 静态契约：通道 / 模块边界 / 表不加列 / 双端阈值 / 护栏 ─────────────
  await r.check('S10', 'score 通道两处一致；hotManager 不碰 AI；表不加列；UI 四档+建议+窗口', () => {
    const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')
    const ipcSrc = read('electron/main/ipc/hot.ts')
    const preloadSrc = read('electron/preload/index.ts')
    for (const src of [ipcSrc, preloadSrc]) {
      assert(src.includes('marketing:hot:score'), '通道 marketing:hot:score：' + (src === ipcSrc ? 'ipc' : 'preload'))
    }
    const mgrSrc = read('electron/main/marketing/hotScoreManager.ts')
    assert(!/from 'electron'/.test(mgrSrc), 'scoreManager 不 import electron')
    assert(!/globalThis[.]fetch|child_process|INSERT INTO|prepare[(]/.test(mgrSrc), 'scoreManager 不发裸 HTTP/不 spawn/不直写 SQL')
    assert(mgrSrc.includes('createChatStream') && mgrSrc.includes('hot-score-'), '评分走 SSE 独立会话（防 120s 整体超时、不污染 Advisor 历史）')
    assert(mgrSrc.includes('资料不足') && mgrSrc.includes('JSON 数组'), '事实护栏 + JSON 契约在 prompt')
    assert(mgrSrc.includes("origin !== 'calendar'"), '日历节点不评分')
    const hotSrc = read('electron/main/marketing/hotManager.ts')
    assert(!hotSrc.includes('gatewayClient') && !hotSrc.includes('createChatStream'), '边界：hotManager 源码不引用 Gateway（采集独立于 AI）')

    const workerSrc = read('resources/database/db-worker.mjs')
    const columnsBlock = workerSrc.match(/project_hot_topics:[\s\S]*?columns:[\s\S]*?\[([\s\S]*?)\]/)
    assert(columnsBlock, 'worker 含 project_hot_topics 定义')
    const colCount = (columnsBlock[1].match(/'/g) || []).length / 2
    assertEq(colCount, 9, '12 不加列（仍是 02 封板的 9 列）')

    const storeSrc = read('src/stores/marketing.ts')
    for (const token of ['runHotScoring', 'hotSuggestion', 'hotScoring', 'hotScoreProgress', 'hotScoreError']) {
      assert(storeSrc.includes(token), 'store 含 ' + token)
    }
    assert(storeSrc.includes('failures >= 2') && storeSrc.includes('delay(3000)'), '单批失败退让 3s 补试一次（真网间歇空闲超时自愈）')
    assert(storeSrc.includes('delay(1500)'), '批间退让 1.5s，降低网关排队概率')
    const viewSrc = read('src/views/marketing/HotCenter.vue')
    for (const label of ['值得跟', '观察', '不建议', '待分析', '今日建议', '重新分析']) {
      assert(viewSrc.includes(label), '视图含「' + label + '」')
    }
    assert(viewSrc.includes('m >= 70 && f >= 70') && viewSrc.includes('m < 40 && f < 40'), '视图阈值与后端 70/40 双端一致')
    assert(viewSrc.includes('近 3 天') && viewSrc.includes('近 7 天'), '时间窗 24h/3d/7d 可切')
    assert(viewSrc.includes('AI 只评近 7 天在榜热点'), '明示评分窗独立于展示窗')
    assert(viewSrc.includes('windowHours'), '视图 windowHours 透传 listRadar')

    // 复审 6/8：分页/排序单一真相 hotShared
    const sharedSrc = read('electron/main/marketing/hotShared.ts')
    assert(sharedSrc.includes('listAllRows') && sharedSrc.includes('compareHeatRank'), 'hotShared 导出分页/排序共用件')
    assert(mgrSrc.includes("from './hotShared'") && hotSrc.includes("from './hotShared'"), '两个 manager 都 import hotShared')
    assert(!mgrSrc.includes('private async listAllRows'), 'scoreManager 不再私藏分页实现')
    // 复审 1/2/3/4/7/9/10
    assert(mgrSrc.includes('forceWatermarks') && mgrSrc.includes('isStale'), 'force 水位 + stale 真实重算 remaining')
    assert(mgrSrc.includes('cacheTtlMs') && mgrSrc.includes('Promise.all'), '短 TTL 缓存 + 批量并发 upsert')
    assert(storeSrc.includes('getWindowHours'), '续批循环实时读时间窗 getter（复审 2）')
    assert(storeSrc.includes('稍后重新打开雷达'), 'guard 耗尽有可见提示（复审 4）')
    assert(viewSrc.includes('expandedGroups.value = new Set()'), '切商家/平台重置展开态（复审 10）')
    assert(viewSrc.includes('a.rank ?? 9999'), '前端排序兜底口径含 rank（复审 8）')
  })

  // ── S12 force 水位：TTL 内旧分在续批中也必须全部重评（复审 1） ────────────────
  await r.check('S12', 'force 首批 30 后，非 force 续批仍补评余下 5 条 TTL 内旧分', async () => {
    const p12 = (await projects.createProject({ name: 'C12 十二号店', industry: '餐饮' })).id
    // 预置 35 条「1 小时前评过」的旧评分（TTL 24h 内，非 force 调用本不会重评）
    for (let i = 0; i < 35; i += 1) {
      await database.request('project_hot_topics.upsert', {
        data: {
          project_id: p12,
          topic_id: 't' + String(i).padStart(2, '0'),
          platform: 'xiaohongshu',
          match_score: 55,
          platform_fit: 55,
          reason: '旧评分',
          content_angle: null,
          lifecycle_advice: null,
          scored_at: T0 - HOUR
        }
      })
    }
    const gw12 = fakeGateway(okResponder)
    const clock12 = { t: T0 }
    const m12 = createHotScoreManager({
      database,
      contextEngine,
      gateway: gw12,
      logger: () => {},
      now: () => clock12.t,
      cacheTtlMs: 0
    })
    clock12.t = T0
    const first = await m12.scoreBatch(p12, 'xiaohongshu', { force: true })
    assertEq(first.scored, 30, 'force 首批重评 30')
    assertEq(first.remaining, 5, '未入批的 5 条旧分在 force 水位下仍 stale')
    const second = await m12.scoreBatch(p12, 'xiaohongshu')
    assertEq(second.scored, 5, '非 force 续批补评低热 5 条')
    assertEq(second.remaining, 0, '全部重评完成')
    assertEq(gw12.calls.length, 2, '正好两次模型调用，不多评')
    const rows = await listScores(p12, 'xiaohongshu')
    assertEq(rows.length, 35, 'upsert 不产生重复行')
    assert(rows.every((row) => row.scored_at === T0), '35 条 scored_at 全部刷新（含 t00..t04）')
    assert(rows.every((row) => row.match_score === 80), '旧的 55 分全部被新评分覆盖')
  })

  // ── S13 漏回/非法条目计入 remaining：续批补评，好条目不重复花钱（复审 3） ──────
  await r.check('S13', '首批漏回 3 条时 remaining=8，续批只补 8 条，27 好条目不重评', async () => {
    const p13 = (await projects.createProject({ name: 'C12 十三号店', industry: '餐饮' })).id
    let modelCalls = 0
    const gw13 = fakeGateway((callIndex, input) => {
      modelCalls += 1
      if (modelCalls === 1) {
        const user = input.messages[1].content
        const n = (user.match(/^\[\d+\]/gm) || []).length
        assertEq(n, 30, '首批 30 条')
        const arr = []
        for (let i = 0; i < n; i += 1) {
          // 故意漏回 idx 0/7/29（批内 heat 序对应 t34/t27/t05）
          if (i === 0 || i === 7 || i === 29) continue
          arr.push({ idx: i, match_score: 80, platform_fit: 80, reason: 'ok', content_angle: '图文', lifecycle_advice: '尽快' })
        }
        return { text: JSON.stringify(arr) }
      }
      return okResponder(callIndex, input)
    })
    const m13 = createHotScoreManager({
      database,
      contextEngine,
      gateway: gw13,
      logger: () => {},
      now: () => T0,
      cacheTtlMs: 0
    })
    const first = await m13.scoreBatch(p13, 'xiaohongshu')
    assertEq(first.scored, 27, '首批成功 27 条')
    assertEq(first.failed, 0, '整包合法：漏回不计 failed，但也不能算完成')
    assertEq(first.remaining, 8, '3 漏回 + 5 未入批 = 8（旧实现误报 5 会提前 break）')
    assertEq((await listScores(p13, 'xiaohongshu')).length, 27, '落库 27 行')

    const second = await m13.scoreBatch(p13, 'xiaohongshu')
    assertEq(second.scored, 8, '续批补完 8 条')
    assertEq(second.remaining, 0, '本视角全部评完')
    assertEq(modelCalls, 2, '正好两次模型调用')
    assertEq((await listScores(p13, 'xiaohongshu')).length, 35, '合计 35 行无重复')
    const ids = [...gw13.calls[1].messages[1].content.matchAll(/^\[\d+\] 标题：热点编号(\d+)/gm)].map(
      (m) => Number(m[1])
    )
    assertEq(
      ids.slice().sort((a, b) => a - b).join(','),
      '0,1,2,3,4,5,27,34',
      '续批只含漏回 3 条 + 低热 5 条，27 条好条目不重复评分'
    )
  })

  // ── S14 短 TTL 缓存：同 pid|平台续批只构建一次 Pack，过期重建（复审 7） ────────
  await r.check('S14', '热点表/Context Pack 60s 内跨批复用；评分不缓存；TTL 过期后重建', async () => {
    const p14 = (await projects.createProject({ name: 'C12 十四号店', industry: '餐饮' })).id
    let builds = 0
    const rawBuild = contextEngine.buildContextPack.bind(contextEngine)
    const countingEngine = {
      buildContextPack: (...args) => {
        builds += 1
        return rawBuild(...args)
      }
    }
    const gw14 = fakeGateway(okResponder)
    const clock14 = { t: T0 }
    const m14 = createHotScoreManager({
      database,
      contextEngine: countingEngine,
      gateway: gw14,
      logger: () => {},
      now: () => clock14.t
    })
    const first = await m14.scoreBatch(p14, 'xiaohongshu')
    assertEq(first.scored, 30, '首批 30')
    const second = await m14.scoreBatch(p14, 'xiaohongshu')
    assertEq(second.scored, 5, '续批 5')
    assertEq(builds, 1, '两批只构建 1 次 Context Pack')
    assertEq(gw14.calls.length, 2, '模型仍调两次（评分结果不缓存）')
    clock14.t = T0 + 61_000
    const third = await m14.scoreBatch(p14, 'xiaohongshu', { force: true })
    assertEq(third.scored, 30, 'force 重评 heat 前 30')
    assertEq(builds, 2, '缓存过期后重建 Pack')
  })

  // ── S11 接缝：评分写库 → hotManager.listRadar LEFT 关联 + 时间窗 + project/平台隔离 ──
  await r.check('S11', '评分后 listRadar 读到分数；窗口 24/72/168 边界；project 与平台隔离；增量只评新条', async () => {
    const radarOnly = createHotManager({
      database,
      collectorScriptPath: join(repoRoot, 'resources', 'collector', 'index.mjs'),
      nodePath,
      logger: () => {},
      now: () => T0
    })
    // 新插一条 4 天前的热点：24h/72h 窗不可见、168h 窗可见，且尚未评分
    await seedTopic({ id: 't4d', title: '四天前热点', heat: 50, rank: 50, lastSeen: T0 - 4 * DAY })

    const v24 = await radarOnly.listRadar(pid, { platform: 'xiaohongshu', skipCollect: true, windowHours: 24 })
    assertEq(v24.board.length, 35, '24h 窗 35 条 board')
    assertEq(v24.calendar.length, 1, '日历 1 条')
    assert(v24.board.every((t) => t.score && t.score.match_score === 80), 'xhs 35 条都带上评分（LEFT 接缝）')
    assertEq(v24.calendar[0].score, null, '日历节点无评分')
    assert(!v24.board.some((t) => t.id === 't4d'), '4 天前热点不在 24h 窗')

    const v72 = await radarOnly.listRadar(pid, { platform: 'xiaohongshu', skipCollect: true, windowHours: 72 })
    assertEq(v72.board.length, 35, '72h 窗仍 35 条（4 天前不进）')

    const v168 = await radarOnly.listRadar(pid, { platform: 'xiaohongshu', skipCollect: true, windowHours: 168 })
    assertEq(v168.board.length, 36, '168h 窗 36 条')
    const t4dView = v168.board.find((t) => t.id === 't4d')
    assert(t4dView && t4dView.score === null, '新热点尚未评分，视图 score=null（待分析）')

    // 增量评分：35 条 TTL 未过期，只有 t4d 是 pending → 只评 1 条、零重复花钱。
    // 用 cacheTtlMs:0 的 manager：采集期缓存为秒级优化，新热点落库后必须能被无缓存路径读到
    const scoreFresh = createHotScoreManager({
      database,
      contextEngine,
      gateway,
      logger: () => {},
      now: () => T0,
      cacheTtlMs: 0
    })
    const inc = await scoreFresh.scoreBatch(pid, 'xiaohongshu')
    assertEq(inc.scored, 1, '只评新出现的 t4d')
    assertEq(inc.total, 36, '候选总数随在榜热点增长')
    assertEq(inc.remaining, 0, '无剩余')
    const v168b = await radarOnly.listRadar(pid, { platform: 'xiaohongshu', skipCollect: true, windowHours: 168 })
    const t4dAfter = v168b.board.find((t) => t.id === 't4d')
    assert(t4dAfter && t4dAfter.score && t4dAfter.score.match_score === 80, '重读后 t4d 分数可见')

    // project 隔离：另一个 project 的 LEFT 关联读不到 pid 的评分
    const other = await projects.createProject({ name: 'C12 隔壁店', industry: '餐饮' })
    const vOther = await radarOnly.listRadar(other.id, { platform: 'xiaohongshu', skipCollect: true })
    assert(vOther.board.every((t) => t.score === null), '别的商家看不到 pid 的评分')

    // 平台隔离：抖音只续评过首批 30（t05..t34），t00..t04 仍 null
    const vDy = await radarOnly.listRadar(pid, { platform: 'douyin', skipCollect: true })
    const scoredDy = vDy.board.filter((t) => t.score !== null).length
    assertEq(scoredDy, 30, '抖音视角只关联 30 条抖音评分')
    assert(vDy.board.find((t) => t.id === 't00').score === null, '未续批的低热条目待分析')
  })

  for (const c of [...clients]) {
    try {
      if (typeof c.dispose === 'function') await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(200)
} catch (e) {
  console.error('验收脚本自身异常（非断言失败）:', e)
  r.checks.push({ id: 'FATAL', name: '夹具/启动失败', ok: false, detail: String(e?.stack || e), ms: 0 })
}

const result = r.toJSON({ bundle: scorePath, dataDir, nodePath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-hotscore.json'), result)
console.log('结果已写入 test/accept-result-hotscore.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
