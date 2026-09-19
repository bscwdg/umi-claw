// test/hot.accept.mjs —— Commit 11 验收：热点采集与浏览（热点雷达）
//
// **打真实源码**：esbuild bundle 真 hotManager.ts（连带真 errors）；采集侧 spawn 真
// resources/collector/index.mjs + 真 adapters，HTTP 用真 Node http 假服务扮演头条/B站公开端点；
// 库侧真 DB Worker（白名单零改，全走 generic CRUD）+ 直读行数断言。
//
// 覆盖点（§七 11 行 / §六 v1.7-v1.12 架构 / 硬规则 8/9/12）：
//   H1  collector 契约：成功描述符平台键 / 失败描述符一致 / dailyhot 无 base 静默跳过
//   H2  同源去重（指纹 + 批内包含合并）；跨平台同事件不合并；日历 cal: 指纹/无生命周期
//   H3  upsert 幂等（二轮零新增、samples 追加、last_seen 推进）
//   H4  采样裁剪 maxSamples（超出留最近 N 条）
//   H5  生命周期纯函数 + 热度变化积分（new/rising/breaking/long_tail/peak）
//   H6  时间差：未到点跳过 / 到点采集 / force 恒采集
//   H7  single-flight：并发 collect 复用同一 Promise，collector 只起一轮
//   H8  全源失败：HOT_SOURCE_ERROR、不推进 last_fetch、写 error；恢复后清空 error
//   H9  collector 整体超时 kill 后不留僵尸，下一轮可正常采
//   H10 listRadar：24h 窗口、board/calendar 分组、评分 LEFT 关联（project × 平台隔离）、
//       参数校验、getTopic NOT_FOUND、getStatus
//   H11 7 天落榜清理 + contents 引用例外（v1.11）+ samples 级联
//   H12 静态契约：3 通道三处一致且无 score / worker 白名单零改 / extraResources 随包 /
//       collector 零依赖不碰 electron / manager 不 import electron 不发 HTTP 不直写 SQL /
//       store 切片 / 真页路由 / 带去 Content Center 六字段 payload
//
// 用法：node test/hot.accept.mjs   （npm run accept:hot；--keep-tmp 保留临时目录）

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
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

const repoRoot = join(__dirname, '..')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, `hot-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const collectorPath = join(repoRoot, 'resources', 'collector', 'index.mjs')
const HOUR = 60 * 60 * 1000
const NOW_ISO = '2026-09-19T04:00:00Z'
const clock = { t: Date.parse(NOW_ISO) }

// ── bundle 真源码 ────────────────────────────────────────────────────────────
const hotPath = bundleEntry('electron/main/marketing/hotManager.ts', 'hot-manager.mjs')
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'hot-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'hot-database.mjs')
const hotMod = await import(pathToFileURL(hotPath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)
const { createHotManager, normalizeTitle, classifyLifecycle, META_LAST_FETCH_AT, META_SOURCE_ERROR } = hotMod
const { DatabaseClient } = dbMod

// ── 日历夹具（3 个在窗、1 个未到窗口） ───────────────────────────────────────
const calPath = join(runDir, 'cal.json')
writeFileSync(
  calPath,
  JSON.stringify([
    { id: 'mid-autumn-2026', kind: 'festival', title: '中秋节：团圆 / 家庭合影', date: '2026-09-25', leadDays: 12 },
    { id: 'national-day', kind: 'festival', title: '国庆假期：旅拍 / 出游', date: '10-01', leadDays: 14 },
    { id: 'autumn-look', kind: 'season', title: '秋季换新：外景黄金季', start: '09-15', end: '11-05', leadDays: 7 },
    { id: 'double11', kind: 'promo', title: '双11：全年大促', date: '11-11', leadDays: 16 }
  ]),
  'utf8'
)

// ── 假头条/B站公开端点 ───────────────────────────────────────────────────────
const T = {
  same1: '同一个事件',
  same2: '同一个事件！',
  indep1: '独立测试新闻标题',
  indep2: '独立测试新闻标题后续详情',
  swing: '升降温新闻',
  stable: '稳定新闻'
}
function toutiaoRows(swingHeat, nullHeat) {
  const rows = [
    { Title: T.same1, HotValue: 1000, Url: 'https://example.com/same' },
    { Title: T.same2, HotValue: 1200, Url: 'https://example.com/same2' },
    { Title: T.indep1, HotValue: 500, Url: null },
    { Title: T.indep2, HotValue: 600, Url: null },
    { Title: T.swing, HotValue: swingHeat, Url: null },
    { Title: T.stable, HotValue: 800, Url: null }
  ]
  // A3/复查1 夹具：某轮 stable 的热度字段缺失。行上 heat 沿用旧值（保展示排序），
  // 但采样必须如实写 null（不用旧值伪造趋势点）
  if (nullHeat) {
    for (const row of rows) if (row.Title === T.stable) row.HotValue = null
  }
  return rows
}
function biliRows() {
  return [
    { title: T.same1, stat: { view: 5000 }, short_link_v2: 'https://b23.tv/x' },
    { title: 'B站独有视频', stat: { view: 3000 }, bvid: 'BV1testxx' }
  ]
}

function createFakeUpstream() {
  const ctrl = { swingHeat: 100, fail: false, slowMs: 0, nullHeat: false, toutiaoHits: 0, biliHits: 0, port: 0 }
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    await sleep(ctrl.slowMs)
    if (url.startsWith('/toutiao')) {
      ctrl.toutiaoHits += 1
      if (ctrl.fail) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"forced"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: toutiaoRows(ctrl.swingHeat, ctrl.nullHeat) }))
      return
    }
    if (url.startsWith('/bili')) {
      ctrl.biliHits += 1
      if (ctrl.fail) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"forced"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { list: biliRows() } }))
      return
    }
    // A2 夹具：DailyHotApi 聚合协议——douyin 失败、weibo 成功（成功/失败描述符必须同 source=host）
    if (url.startsWith('/weibo')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 200, data: [{ name: '微博热搜词', hot: 12, index: 1, url: null }] }))
      return
    }
    if (url.startsWith('/douyin')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"code":500}')
      return
    }
    res.writeHead(404); res.end('nope')
  })
  return {
    ctrl,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          ctrl.port = server.address().port
          resolve('http://127.0.0.1:' + ctrl.port)
        })
      }),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

async function expectCode(promise, code, label) {
  let thrown = null
  try {
    await promise
  } catch (e) {
    thrown = e
  }
  assert(thrown, label + ' 应拒绝')
  assertEq(thrown.code, code, label + ' 错误码')
}

const r = new Recorder('hot（Commit 11：热点采集与浏览，打真 hotManager.ts + 真 collector + 真 DB Worker）')
const logs = []
const logger = (m) => logs.push(String(m))
let database
let manager
let base
const upstream = createFakeUpstream()

function collectorArgs(calOverride, nowIso) {
  return [
    '--toutiao-url', base + '/toutiao',
    '--bili-url', base + '/bili',
    '--sources', 'calendar,toutiao,bilibili',
    '--calendar-path', calOverride || calPath,
    '--now', nowIso || NOW_ISO
  ]
}
function makeManager(opts = {}) {
  return createHotManager({
    database,
    collectorScriptPath: collectorPath,
    nodePath,
    logger,
    now: () => clock.t,
    fetchIntervalMs: HOUR,
    ...opts,
    // extraArgs 默认走夹具参数，opts 显式给时优先（如 C3 注入更晚的 --now）
    extraArgs: opts.extraArgs || collectorArgs(opts.calPath, opts.nowIso)
  })
}

/** 本地日历日的 ISO 串（A4：日历按本地时区解释，夹具时间也按本机时区构造） */
function localIso(year, month0, day, hour = 12) {
  return new Date(year, month0, day, hour, 0, 0, 0).toISOString()
}

/**
 * 绕过 worker 直连 SQLite 批量播种（仅测试夹具；生产读写一律走 DB Worker）。
 * 单条 IPC 约 34ms，5000+ 行的截断回归用它在一个事务里瞬间完成。WAL 允许第二连接，
 * worker 随后读到的就是已提交数据。
 */
function seedSqlite(fn) {
  const conn = new DatabaseSync(dbPath)
  conn.exec('PRAGMA busy_timeout=5000')
  try {
    conn.exec('BEGIN')
    fn(conn)
    conn.exec('COMMIT')
  } catch (e) {
    conn.exec('ROLLBACK')
    throw e
  } finally {
    conn.close()
  }
}

async function listTopics(platform) {
  const rows = await database.request('hot_topics.list', platform
    ? { where: { source_platform: platform }, limit: 5000 }
    : { limit: 5000 })
  return rows
}
async function samplesOf(topicId) {
  return database.request('hot_topic_samples.list', { where: { topic_id: topicId }, order: ['sampled_at'], limit: 5000 })
}
const byTitle = (rows, title) => rows.find((x) => x.title === title)
async function metaValue(key) {
  const row = await database.request('app_meta.get', { keys: { key } })
  return row?.value ?? null
}

/** 直接 spawn 真 collector，解析 stdout JSONL（必须异步：同步 spawn 会阻塞本进程的假 HTTP 服务） */
function runCollector(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [collectorPath, '--timeout-ms', '8000', ...args], {
      cwd: repoRoot,
      windowsHide: true
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('collector 探针超时'))
    }, 20000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const descriptors = []
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        descriptors.push(JSON.parse(t))
      }
      resolve({ code, descriptors, stderr: err })
    })
  })
}

try {
  database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-hot-test',
    requestTimeoutMs: 30_000
  })
  base = await upstream.listen()
  const projects = projMod.createProjectManager({ database, dataDir, logger })

  // ── H1 collector 契约 ────────────────────────────────────────────────────
  await r.check('H1', 'collector：成功描述符平台键 / 失败一致 / dailyhot 无 base 跳过', async () => {
    const ok = await runCollector(collectorArgs())
    assertEq(ok.code, 0, '退出码 0')
    assertEq(ok.descriptors.length, 3, '3 个数据源描述符')
    const bySource = Object.fromEntries(ok.descriptors.map((d) => [d.source, d]))
    assert(bySource['toutiao-web']?.ok && bySource['toutiao-web'].sourcePlatform === 'toutiao', '头条平台键 toutiao')
    assertEq(bySource['toutiao-web'].items.length, 6, '头条原始 6 条（去重在 manager）')
    assert(bySource['bilibili-web']?.ok && bySource['bilibili-web'].sourcePlatform === 'bilibili', 'B站平台键 bilibili')
    assertEq(bySource['bilibili-web'].items.length, 2, 'B站 2 条')
    assert(bySource['builtin-calendar']?.ok && bySource['builtin-calendar'].sourcePlatform === 'calendar', '日历平台键 calendar')
    assertEq(bySource['builtin-calendar'].items.length, 3, '日历 3 个在窗节点')
    assert(bySource['builtin-calendar'].items.every((i) => String(i.fid || '').startsWith ? /^(mid-autumn-2026|national-day|autumn-look)$/.test(i.fid) : false), 'fid 稳定')

    const fail = await runCollector(['--sources', 'toutiao', '--toutiao-url', base + '/missing'])
    const fd = fail.descriptors.find((d) => d.source === 'toutiao-web')
    assert(fd && fd.ok === false, '头条失败描述符存在')
    assertEq(fd.sourcePlatform, 'toutiao', '失败描述符平台键与成功时一致')
    assertEq(fd.origin, 'board', '失败描述符 origin')

    const skip = await runCollector(['--sources', 'dailyhot'])
    assertEq(skip.descriptors.length, 0, '未配 base：不产出 dailyhot 描述符')
    assert(/SKIP dailyhot/.test(skip.stderr), 'stderr 写明跳过')
    return '成功/失败/跳过三态描述符契约 ✓'
  })

  manager = makeManager()

  // ── H2 同源去重 / 跨平台不合并 / 日历指纹 ────────────────────────────────
  await r.check('H2', '同源指纹去重 + 批内包含合并；跨平台不合并；日历 cal: 指纹', async () => {
    const st = await manager.collect(true)
    assert(st, '首轮采集有状态')
    assertEq(st.inserted, 9, '新增 4 头条 + 2 B站 + 3 日历')
    assertEq(st.updated, 0, '首轮零更新')

    const tt = await listTopics('toutiao')
    assertEq(tt.length, 4, '头条同指纹 + 包含合并后 4 条')
    assert(byTitle(tt, T.same2), '保留信息更长的同指纹标题')
    assert(!byTitle(tt, T.same1), '短标题被合并')
    const indep = byTitle(tt, T.indep2)
    assert(indep, '包含关系保留长标题')
    assertEq(indep.heat, 600, '合并取更高热度')
    assertEq(indep.rank, 3, '合并取更前名次')
    const same = byTitle(tt, T.same2)
    assertEq(same.fingerprint, normalizeTitle(T.same1), '指纹 = 标题归一化')
    assertEq(same.fingerprint, normalizeTitle(T.same2), '噪声标点不入指纹')

    const bili = await listTopics('bilibili')
    assertEq(bili.length, 2, 'B站 2 条')
    assert(byTitle(bili, T.same1), '跨平台同事件不合并（B站独立一行）')

    const cal = await listTopics('calendar')
    assertEq(cal.length, 3, '日历 3 行')
    assert(cal.every((c) => c.fingerprint.startsWith('cal:')), '日历指纹 cal:<id>')
    assert(cal.every((c) => c.lifecycle === null && c.heat === null), '日历不判生命周期、无热度')
    assertEq(cal[0].source, 'builtin-calendar', 'source 记录具体 adapter')
    return '头条 4/B站 2/日历 3；跨平台同事件各一行 ✓'
  })

  // ── H3 幂等 + samples 追加 ───────────────────────────────────────────────
  await r.check('H3', '二轮 upsert：零新增、samples 追加、last_seen 推进', async () => {
    const before = (await listTopics()).length
    const swing = byTitle(await listTopics('toutiao'), T.swing)
    const samplesBefore = (await samplesOf(swing.id)).length
    clock.t += HOUR + 60_000
    const st = await manager.collect(true)
    assertEq(st.inserted, 0, '二轮零新增')
    assertEq(st.updated, 9, '9 条全部更新')
    assertEq((await listTopics()).length, before, '总行数不变')
    const swing2 = byTitle(await listTopics('toutiao'), T.swing)
    assert(swing2.last_seen_at > swing.last_seen_at, 'last_seen_at 推进')
    assertEq((await samplesOf(swing2.id)).length, samplesBefore + 1, 'sample 追加一条')
    return '幂等落库 + 时间序列追加 ✓'
  })

  // ── H4 采样裁剪 ──────────────────────────────────────────────────────────
  await r.check('H4', 'samples 只保留最近 maxSamples 条', async () => {
    const small = makeManager({ maxSamples: 3 })
    const swing = byTitle(await listTopics('toutiao'), T.swing)
    for (let i = 0; i < 3; i++) {
      clock.t += HOUR + 60_000
      await small.collect(true)
    }
    const list = await samplesOf(swing.id)
    assertEq(list.length, 3, '裁剪到 3 条')
    const ts = list.map((s) => s.sampled_at)
    assertEq([...ts].sort((a, b) => a - b).join(','), ts.join(','), '保留的是最近 3 条（升序）')
    return 'maxSamples 裁剪 ✓'
  })

  // ── H5 生命周期 ──────────────────────────────────────────────────────────
  await r.check('H5', '生命周期纯函数 + 热度变化积分（rising/breaking/long_tail/peak）', async () => {
    assertEq(classifyLifecycle(null, 1, 100, null, 5), 'new', '首采样 new')
    assertEq(classifyLifecycle('new', 2, 150, 100, 5), 'rising', '涨 15% 但未翻倍 → rising')
    assertEq(classifyLifecycle('rising', 3, 6000, 300, 5), 'breaking', '翻倍且前 10 breaking')
    assertEq(classifyLifecycle('rising', 3, 6000, 3000, 20), 'rising', '翻倍但名次 20 不算 breaking，回落 rising')
    assertEq(classifyLifecycle('breaking', 4, 100, 6000, 5), 'long_tail', '跌 15% long_tail')
    assertEq(classifyLifecycle('long_tail', 5, 100, 100, 5), 'peak', '横盘 peak')
    assertEq(classifyLifecycle('rising', 5, null, 100, 5), 'rising', 'heat 缺失保持原状')
    assertEq(classifyLifecycle('rising', 2, 100, null, 5), 'rising', '⑨ 上条采样缺热度不把 rising 打回 new')
    assertEq(classifyLifecycle(null, 2, 100, null, 5), 'new', '从未判过阶段才落 new')

    async function swingRound(heat, expected) {
      upstream.ctrl.swingHeat = heat
      clock.t += HOUR + 60_000
      await manager.collect(true)
      const row = byTitle(await listTopics('toutiao'), T.swing)
      assertEq(row.lifecycle, expected, '热度 ' + heat + ' → ' + expected)
    }
    await swingRound(150, 'rising')
    await swingRound(6000, 'breaking')
    await swingRound(100, 'long_tail')
    await swingRound(100, 'peak')
    const cal = await listTopics('calendar')
    assert(cal.every((c) => c.lifecycle === null), '日历始终无生命周期')
    return '5 档生命周期纯函数 + 真采样积分 ✓'
  })

  // ── H6 时间差 ────────────────────────────────────────────────────────────
  await r.check('H6', '未到间隔跳过 / 到点采集 / force 恒采集', async () => {
    assertEq(await manager.collect(false), null, '刚采过：跳过返回 null')
    clock.t += 30 * 60 * 1000
    assertEq(await manager.collect(false), null, '30 分钟仍跳过')
    clock.t += 31 * 60 * 1000
    const due = await manager.collect(false)
    assert(due && typeof due.topicsTotal === 'number', '满 60 分钟自动采集')
    const immediateForce = await manager.collect(true)
    assert(immediateForce, 'force 忽略时间差立即采')
    return '时间差闸门 + force ✓'
  })

  // ── H7 single-flight ─────────────────────────────────────────────────────
  await r.check('H7', '并发 collect 复用同一在途 Promise，collector 只起一轮', async () => {
    clock.t += HOUR + 60_000
    upstream.ctrl.toutiaoHits = 0
    upstream.ctrl.biliHits = 0
    const [a, b] = await Promise.all([manager.collect(false), manager.collect(false)])
    assert(a && b, '两次并发都拿到状态')
    assert(a === b, '共用同一个 Promise（single-flight）')
    assertEq(upstream.ctrl.toutiaoHits, 1, '头条只被打一次')
    assertEq(upstream.ctrl.biliHits, 1, 'B站只被打一次')
    return 'single-flight ✓'
  })

  // ── H8 全源失败 ──────────────────────────────────────────────────────────
  await r.check('H8', '全源失败 HOT_SOURCE_ERROR + 不推进 last_fetch + 恢复后清错', async () => {
    const missingCal = join(runDir, 'nope.json')
    const failManager = makeManager({ calPath: missingCal })
    upstream.ctrl.fail = true
    const beforeTs = await metaValue(META_LAST_FETCH_AT)
    await expectCode(failManager.collect(true), 'HOT_SOURCE_ERROR', '全源失败')
    assertEq(await metaValue(META_LAST_FETCH_AT), beforeTs, 'last_fetch 不推进')
    assert((await metaValue(META_SOURCE_ERROR))?.includes('全部数据源不可用'), '写入全源失败错误')

    upstream.ctrl.fail = false
    const st = await manager.collect(true)
    assert(st, '恢复后采集成功')
    assertEq(await metaValue(META_SOURCE_ERROR), '', '错误状态清空')
    return '失败不推进时间戳；恢复自愈 ✓'
  })

  // ── H9 超时 kill ─────────────────────────────────────────────────────────
  await r.check('H9', 'collector 超时被 kill，不留僵尸，下一轮正常', async () => {
    upstream.ctrl.slowMs = 5000
    const slow = makeManager({ collectorTimeoutMs: 500 })
    await expectCode(slow.collect(true), 'HOT_SOURCE_ERROR', '整体超时')
    await sleep(400)
    assertEq(slow.cancelActiveCollectors(), 0, '超时后无在途子进程残留')
    upstream.ctrl.slowMs = 0
    clock.t += HOUR + 60_000
    const st = await manager.collect(true)
    assert(st && st.inserted === 0, '恢复后下一轮正常（幂等更新）')
    return '超时 kill + 无僵尸 ✓'
  })

  // ── H10 listRadar ────────────────────────────────────────────────────────
  await r.check('H10', 'listRadar：24h 窗口/分组/评分 LEFT 关联/校验/状态', async () => {
    const pa = await projects.createProject({ name: '甲摄影店' })
    const pb = await projects.createProject({ name: '乙摄影店' })

    await database.request('hot_topics.create', {
      data: {
        id: 'stale-unref', source_platform: 'stale', source: 'stale', origin: 'board',
        title: '落榜旧闻', url: null, fingerprint: 'stale-unref', heat: 1, rank: 99,
        lifecycle: 'long_tail', first_seen_at: clock.t - 8 * 24 * HOUR, last_seen_at: clock.t - 25 * HOUR
      }
    })
    await database.request('hot_topic_samples.create', {
      data: { id: 'stale-unref-s1', topic_id: 'stale-unref', sampled_at: clock.t - 25 * HOUR, heat: 1, rank: 99 }
    })

    const view = await manager.listRadar(pa.id)
    assertEq(view.collected, null, '未到点 collected=null（不重复采）')
    assert(!view.board.some((t) => t.id === 'stale-unref'), '超 24h 落榜条不出现在雷达')
    assert(view.board.length >= 4, 'board 含头条/B站在榜条')
    assertEq(view.calendar.length, 3, 'calendar 分区 3 条')
    assert(view.board.every((t) => t.origin !== 'calendar'), 'board 不含日历')
    assertEq(view.board[0].title, T.same1, '跨源按热度降序首条（B站 5000 最高）')
    assertEq(view.board[0].source_platform, 'bilibili', '榜首来自 B站')
    assert(view.board.every((t) => t.score === null), '11 无评分时 score 恒 null')

    const topicId = byTitle(await listTopics('toutiao'), T.same2).id
    await database.request('project_hot_topics.create', {
      data: {
        project_id: pa.id, topic_id: topicId, platform: 'xiaohongshu',
        match_score: 88, platform_fit: 80, reason: '本地家庭客群契合',
        content_angle: '拍一组家庭合影套餐种草', lifecycle_advice: null, scored_at: clock.t
      }
    })
    const viewAx = await manager.listRadar(pa.id, { platform: 'xiaohongshu' })
    const scored = viewAx.board.find((t) => t.id === topicId)
    assertEq(scored.score?.content_angle, '拍一组家庭合影套餐种草', 'A店×小红书 LEFT 关联到评分')
    const viewAd = await manager.listRadar(pa.id, { platform: 'douyin' })
    assertEq(viewAd.board.find((t) => t.id === topicId).score, null, 'A店×抖音查不到小红书评分')
    const viewB = await manager.listRadar(pb.id)
    assertEq(viewB.board.find((t) => t.id === topicId).score, null, 'B店查不到 A店评分')

    await expectCode(manager.listRadar('   '), 'VALIDATION_ERROR', '空 projectId')
    await expectCode(manager.listRadar(pa.id, { platform: 'weibo' }), 'VALIDATION_ERROR', '非法发布平台')
    const got = await manager.getTopic(topicId)
    assertEq(got.id, topicId, 'getTopic 存在性预检')
    await expectCode(manager.getTopic('no-such-id'), 'NOT_FOUND', 'getTopic 不存在')
    const status = await manager.getStatus()
    assert(status.lastStatus && Array.isArray(status.lastStatus.sources), 'getStatus 带持久化状态')
    return '24h 窗口 + 分组 + 评分 project×平台隔离 + 校验 ✓'
  })

  // ── H11 落榜清理 + contents 引用例外 ─────────────────────────────────────
  await r.check('H11', '7 天落榜清理；contents 引用过的保留（v1.11）；samples 级联', async () => {
    const pa = (await database.request('projects.list', { limit: 5 })).find((p) => p.name === '甲摄影店')
    await database.request('hot_topics.create', {
      data: {
        id: 'stale-ref', source_platform: 'stale', source: 'stale', origin: 'board',
        title: '被内容引用的旧闻', url: null, fingerprint: 'stale-ref', heat: 2, rank: 98,
        lifecycle: 'long_tail', first_seen_at: clock.t - 9 * 24 * HOUR, last_seen_at: clock.t - 25 * HOUR
      }
    })
    await database.request('hot_topic_samples.create', {
      data: { id: 'stale-ref-s1', topic_id: 'stale-ref', sampled_at: clock.t - 25 * HOUR, heat: 2, rank: 98 }
    })
    await database.request('contents.create', {
      data: {
        id: 'content-ref-1', project_id: pa.id, title: '引用旧热点的草稿', platform: 'xiaohongshu',
        topic: null, source_topic_id: 'stale-ref', content: null, status: 'draft',
        published_at: null, effect_note: null, created_at: clock.t, updated_at: clock.t
      }
    })

    const cleanup = makeManager({ staleTopicMs: HOUR })
    const st = await cleanup.collect(true)
    assertEq(st.expiredDeleted, 1, '只删未被引用的落榜条')
    assertEq(await database.request('hot_topics.get', { keys: { id: 'stale-unref' } }), null, '未引用落榜条已删')
    assertEq((await samplesOf('stale-unref')).length, 0, '被删热点的 samples 级联清')
    const kept = await database.request('hot_topics.get', { keys: { id: 'stale-ref' }, required: true })
    assert(kept, 'contents 引用过的热点保留')
    assertEq((await samplesOf('stale-ref')).length, 1, '保留热点的 samples 保留')
    const content = await database.request('contents.get', { keys: { id: 'content-ref-1' } })
    assertEq(content.source_topic_id, 'stale-ref', 'contents 溯源链完好')
    return '落榜删 1 条；引用例外 + 级联正确 ✓'
  })

  // ── H12 静态契约 ─────────────────────────────────────────────────────────
  // ── H13 collector：dailyhot 成败描述符一致（A2）+ 日历本地时区（A4） ─────
  await r.check('H13', 'A2 dailyhot 成败描述符同 host；A4 日历按本地日历日过窗', async () => {
    const dh = await runCollector(['--sources', 'dailyhot', '--base', base, '--routes', 'douyin,weibo'])
    assertEq(dh.descriptors.length, 2, '两个路由各一行描述符')
    const host = new URL(base).host
    const ok = dh.descriptors.find((d) => d.sourcePlatform === 'weibo')
    const bad = dh.descriptors.find((d) => d.sourcePlatform === 'douyin')
    assert(ok && ok.ok && ok.source === 'dailyhot:' + host, '成功描述符 source=dailyhot:<host>')
    assertEq(ok.items.length, 1, 'weibo 1 条')
    assert(bad && bad.ok === false, 'douyin 失败描述符存在')
    assertEq(bad.source, 'dailyhot:' + host, 'A2 失败描述符 source 与成功同 host（不归因到 job 名）')

    const calArgs = (nowIso) => ['--sources', 'calendar', '--calendar-path', calPath, '--now', nowIso]
    const atFestival = await runCollector(calArgs(localIso(2026, 8, 25, 8)))
    const afterFestival = await runCollector(calArgs(localIso(2026, 8, 26, 0)))
    const hasMid = (d) => d.descriptors[0]?.items?.some((i) => i.fid === 'mid-autumn-2026')
    assert(hasMid(atFestival), '节点当天本地早 8 点仍在窗')
    assert(!hasMid(afterFestival), 'A4 次日本地零点已出窗（旧 UTC 构造会错留一整天）')
    return 'A2 host 一致；A4 本地零点边界 ✓'
  })

  // ── H14 A3/复查1：行值沿用旧热度，采样如实写 null，阶段不被砸 ──────────────
  await r.check('H14', 'heat 字段缺失：行上沿用旧值，采样写 null 且生命周期保阶段', async () => {
    const before = byTitle(await listTopics('toutiao'), T.stable)
    assertEq(before.heat, 800, '基线热度 800')
    upstream.ctrl.nullHeat = true
    try {
      clock.t += HOUR + 60_000
      const st = await manager.collect(true)
      assert(st, '缺热度字段的一轮仍整轮成功')
    } finally {
      upstream.ctrl.nullHeat = false
    }
    const after = byTitle(await listTopics('toutiao'), T.stable)
    assertEq(after.heat, 800, 'A3 缺测不覆盖已有热度')
    assert(after.last_seen_at > before.last_seen_at, '仍按在榜更新 last_seen_at')
    const ss = await samplesOf(after.id)
    assertEq(ss[ss.length - 1].heat, null, '复查1：缺测轮采样如实写 null（旧值补点会伪造 peak）')
    assertEq(ss[ss.length - 2].heat, 800, '上一轮采样仍是真实热度 800')
    assertEq(after.lifecycle, before.lifecycle, '缺测轮生命周期保阶段（不砸回 new、不误判 peak）')
    return '行值沿用；采样如实 null；阶段保持 ✓'
  })

  // ── H15 C1：单平台存量超 5000 行，尾页指纹走更新不炸整轮 ──────────────────
  await r.check('H15', 'C1 存量 >5000 行分页拉全，UNIQUE 冲突不再卡死采集', async () => {
    const targetFp = normalizeTitle(T.stable)
    const now = clock.t
    seedSqlite((conn) => {
      // 清掉前面用例写入的 toutiao 行（直接连只做夹具，生产读写仍全走 worker）
      conn.exec('DELETE FROM hot_topic_samples WHERE topic_id IN (SELECT id FROM hot_topics WHERE source_platform=\'toutiao\')')
      conn.exec('DELETE FROM hot_topics WHERE source_platform=\'toutiao\'')
      const ins = conn.prepare(
        'INSERT INTO hot_topics (id,source_platform,source,origin,title,url,fingerprint,heat,rank,lifecycle,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      for (let i = 0; i < 5000; i++) {
        const id = 'h' + String(i).padStart(5, '0')
        ins.run(id, 'toutiao', 'toutiao-web', 'board', '旧闻' + i, null, 'fp-old-' + i, 1, i + 1, 'peak', now, now)
      }
      // 第 5001 行 id 排在尾页，指纹正好是本轮会见到的一条
      ins.run('zzz-target', 'toutiao', 'toutiao-web', 'board', '旧标题', null, targetFp, 700, 50, 'peak', now - HOUR, now - HOUR)
    })
    const st = await manager.collect(true)
    assert(st, '超 5000 存量不炸整轮（旧代码必 CONFLICT 且 last_fetch 永不推进）')
    const total = await database.request('hot_topics.count', { where: { source_platform: 'toutiao' } })
    assertEq(total.count, 5004, '5000 旧行 + 尾页指纹命中更新 + 其余 3 条新增')
    const target = await database.request('hot_topics.get', { keys: { id: 'zzz-target' } })
    assertEq(target.title, T.stable, '尾页指纹走更新而非重复 INSERT')
    assert(target.last_seen_at > now - HOUR, '目标行 last_seen_at 推进')
    assertEq(await metaValue(META_LAST_FETCH_AT), String(st.fetchedAt), 'last_fetch 正常推进')
    return '5001 行存量分页命中，采集不卡死 ✓'
  })

  // ── H16 C3 日历过期下线 + C2 contents 引用集超 5000 不击穿豁免 ─────────────
  await r.check('H16', 'C3 过期节点次日下榜；C2 引用集 >5000 分页，v1.11 豁免不被击穿', async () => {
    // C3：collector 时钟推到 10-10（中秋/国庆已过窗，秋季换新 09-15..11-05 仍在）
    const oct = makeManager({ nowIso: localIso(2026, 9, 10, 12) })
    const calStatus = await oct.collect(true)
    assert(calStatus, '10 月采集成功')
    const cal = await listTopics('calendar')
    assertEq(cal.length, 1, '中秋/国庆过期即下榜，只剩秋季换新')
    assertEq(cal[0].fingerprint, 'cal:autumn-look', '剩余为区间型季节节点')

    // C2：5000 条无引用内容 + 尾页 1 条引用过期热点；旧代码截断会误删被引用热点
    const pa = (await database.request('projects.list', { limit: 50 })).find((p) => p.name === '甲摄影店')
    assert(pa, '夹具项目存在')
    seedSqlite((conn) => {
      const topicIns = conn.prepare(
        'INSERT INTO hot_topics (id,source_platform,source,origin,title,url,fingerprint,heat,rank,lifecycle,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      const expiredAt = clock.t - 25 * HOUR
      topicIns.run('stale-ref-big', 'stale', 'stale', 'board', '被 5001 条内容引用的旧闻', null, 'stale-ref-big', 2, 98, 'long_tail', expiredAt, expiredAt)
      topicIns.run('stale-unref-big', 'stale', 'stale', 'board', '无人引用的旧闻', null, 'stale-unref-big', 1, 99, 'long_tail', expiredAt, expiredAt)
      const contentIns = conn.prepare(
        'INSERT INTO contents (id,project_id,title,platform,topic,source_topic_id,content,status,published_at,effect_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      for (let i = 0; i < 5000; i++) {
        contentIns.run('k' + String(i).padStart(5, '0'), pa.id, '无引用内容' + i, 'xiaohongshu', null, null, null, 'draft', null, null, clock.t, clock.t)
      }
      contentIns.run('zzz-content-ref', pa.id, '尾页引用内容', 'xiaohongshu', null, 'stale-ref-big', null, 'draft', null, null, clock.t, clock.t)
    })
    const cleanup = makeManager({ staleTopicMs: HOUR })
    const st = await cleanup.collect(true)
    assertEq(st.expiredDeleted, 1, '只删无人引用的落榜条')
    assertEq(await database.request('hot_topics.get', { keys: { id: 'stale-unref-big' } }), null, '未引用落榜条已删')
    const kept = await database.request('hot_topics.get', { keys: { id: 'stale-ref-big' }, required: true })
    assert(kept, 'C2 尾页引用被分页读到，v1.11 例外生效')
    const content = await database.request('contents.get', { keys: { id: 'zzz-content-ref' } })
    assertEq(content.source_topic_id, 'stale-ref-big', 'contents 溯源链完好')
    return 'C3 过期节点次日下榜；C2 5001 行引用集分页不丢豁免 ✓'
  })

  // ── H12 静态契约 ─────────────────────────────────────────────────────────
  await r.check('H12', '通道/worker/打包/依赖边界/store/UI 静态契约', () => {
    const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')
    const ipcSrc = read('electron/main/ipc/hot.ts')
    const preloadSrc = read('electron/preload/index.ts')
    for (const ch of ['marketing:hot:list', 'marketing:hot:get', 'marketing:hot:refresh']) {
      assert(ipcSrc.includes(ch), 'IPC 注册通道 ' + ch)
      assert(preloadSrc.includes("'" + ch + "'"), 'preload 暴露通道 ' + ch)
    }
    assert(!/marketing:hot:score/.test(preloadSrc), 'score 通道归 Commit 12，11 不开')

    const workerSrc = read('resources/database/db-worker.mjs')
    for (const t of ['hot_topics:', 'hot_topic_samples:', 'project_hot_topics:']) {
      assert(workerSrc.includes(t), 'worker 白名单含 ' + t + '（02 建表，11 零改）')
    }
    assert(!/marketing:hot/.test(workerSrc), 'worker 不含热点业务方法（全走 generic CRUD）')

    const pkg = JSON.parse(read('package.json'))
    assert(pkg.build?.extraResources?.some?.((e) => e.from === 'resources' && e.to === 'resources'),
      'extraResources 整目录随包（collector 零打包改动）')
    assert(pkg.scripts['accept:hot'] === 'node test/hot.accept.mjs', 'accept:hot 脚本')

    const collectorFiles = ['index.mjs', ...readdirSync(join(repoRoot, 'resources', 'collector', 'sources')).map((f) => 'sources/' + f)]
    for (const f of collectorFiles) {
      const src = read(join('resources', 'collector', f))
      const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s['"]([^'"]+)['"]/gm)].map((m) => m[1])
      assert(imports.every((s) => s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')),
        f + ' 只依赖 node 内置与本地 adapter（零 npm 依赖）')
      assert(!imports.includes('electron'), f + ' 不 import electron')
    }

    const mgrSrc = read('electron/main/marketing/hotManager.ts')
    assert(!/from 'electron'/.test(mgrSrc), 'manager 不 import electron')
    assert(!/globalThis\.fetch|\brequire\s*\(/.test(mgrSrc), 'manager 不发 HTTP / 不 require')
    assert(!/INSERT INTO|UPDATE\s+\w+\s+SET|prepare\(/.test(mgrSrc), 'manager 不直写 SQL（硬规则 8）')
    assert(mgrSrc.includes('HOT_SOURCE_ERROR'), 'manager 使用 HOT_SOURCE_ERROR')

    const errSrc = read('electron/main/database/errors.ts')
    assert(errSrc.includes("HOT_SOURCE_ERROR: 'HOT_SOURCE_ERROR'"), '错误码表含 HOT_SOURCE_ERROR')

    const mainSrc = read('electron/main/index.ts')
    for (const token of ['registerHotIpc', 'createMarketingHotManager', 'abortHotCollectors', 'powerMonitor']) {
      assert(mainSrc.includes(token), '主进程接线含 ' + token)
    }

    const storeSrc = read('src/stores/marketing.ts')
    for (const token of ['hotRadar', 'loadHotRadar', 'refreshHot', 'clearHot', 'HOT_SOURCE_ERROR']) {
      assert(storeSrc.includes(token), 'store hot 切片含 ' + token)
    }

    const routeSrc = read('src/renderer/main.ts')
    assert(routeSrc.includes("import('../views/marketing/HotCenter.vue')"), '/marketing/hot 换真页')
    const viewSrc = read('src/views/marketing/HotCenter.vue')
    assert(viewSrc.includes('setContentPrefill'), '热点页带 payload 跳 Content Center')
    for (const field of ['topicId', 'title', 'sourcePlatform', 'platform', 'contentAngle', 'lifecycleAdvice']) {
      assert(viewSrc.includes(field), 'payload 六字段含 ' + field)
    }
    assert(viewSrc.includes("router.push('/marketing/content')"), '跳转 Content Center')
    assert(viewSrc.includes('不自动生成、不自动发布'), '明示人工链路（硬规则 10）')

    // 复审修复锁定（A1-A4 / C1-C6）
    assert(/child\.on\('close'/.test(mgrSrc) && !/child\.on\('exit'/.test(mgrSrc), 'A1 collector 收完 stdio 再解析（close 非 exit）')
    assert(mgrSrc.includes('listAllRows'), 'C1/A5/C2 分页拉全，5000 截断假设消除')
    assert(mgrSrc.includes("code !== 'CONFLICT'") && mgrSrc.includes('C1 防线'), 'C1 UNIQUE 冲突回退更新')
    assert(mgrSrc.includes('本轮缺失的观测值不覆盖旧值'), 'A3 空观测不覆盖旧热度')
    assert(mgrSrc.includes('节日已过') || mgrSrc.includes('本轮没见到的旧节点'), 'C3 过期日历节点主动下线')
    assert(/clearInterval\(hotTickTimer\)/.test(mainSrc), '⑧ 退出时清理 hot tick 定时器')
    assert(storeSrc.includes('hotCallSeq'), 'C6 store 请求代际令牌')
    assert(/parsed\.protocol/.test(viewSrc) && viewSrc.includes("'https:'"), '③ openUrl 只放行 http(s)')
    assert(viewSrc.includes('forceRefresh') && viewSrc.includes('refreshHot()'), 'C4 立即刷先走 refreshHot，失败信号回状态条')
    assert(viewSrc.includes('首轮整体失败'), 'C5 跳过提示不拿失败状态误判（lastStatus 守卫）')
    // 第二轮复审修复锁定（问题 1/2/3/4/5）
    assert(mgrSrc.includes('缺测轮必须如实写 null'), '复查1：缺测采样写 null，不用旧值伪造趋势')
    assert(viewSrc.includes("s.sourcePlatform + '|' + s.source"), '复查2：状态条 chip key 加 sourcePlatform 防重复')
    for (const src of [ipcSrc, preloadSrc, storeSrc, viewSrc]) {
      assert(src.includes('skipCollect'), '复查3：skipCollect 贯通 ipc/preload/store/视图，刷新不再双采集')
    }
    assert(viewSrc.includes('loadError'), '复查4：mounted 商家加载失败有就地提示且不阻断雷达')
    assert(/offset:\s*Math\.max\(0,\s*Number\(count\)\s*-\s*LOOKBACK\)/.test(mgrSrc), '复查5：生命周期只取末 3 条采样，不全量拉表')
    const calAdapter = read('resources/collector/sources/calendar.mjs')
    assert(!/Date\.UTC/.test(calAdapter), 'A4 日历按本地日历日构造，不用 UTC')
    const collectorSrc = read('resources/collector/index.mjs')
    assert(collectorSrc.includes('fallback || failureDescriptor'), 'A2 dailyhot 失败描述符回退到 host 级身份')
    return '3 通道/worker 零改/随包/零依赖/真页+payload+复审 12 项修复锁定 ✓'
  })
} catch (e) {
  console.error('验收脚本自身异常（非断言失败）:', e)
  r.checks.push({ id: 'FATAL', name: '夹具/启动失败', ok: false, detail: String(e?.stack || e), ms: 0 })
} finally {
  try {
    await upstream.close()
  } catch {
    /* 忽略 */
  }
  if (database) {
    try {
      await database.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(200)
}

const result = r.toJSON({ bundle: hotPath, dataDir, nodePath, logSample: logs.slice(-8) })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-hot.json'), result)
console.log('结果已写入 test/accept-result-hot.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
