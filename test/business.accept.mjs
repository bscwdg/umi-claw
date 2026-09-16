// test/business.accept.mjs —— Commit 04 验收：Business（商家大脑）+ Watchlist（手工增删，不采集）
//
// **打真实源码**：esbuild 把 electron/main/marketing/businessManager.ts bundle 成临时 ESM，
// 在纯 Node 里 import，注入真 DatabaseClient（真 db-worker.mjs 子进程）+ 临时 dataDir。
// 刻意「不抄一份 Manager 逻辑」，因此验证的正是生产代码路径。
//
// 覆盖点（对齐 PLAN-2.0.md §四 / §五 / §七 Commit 04 / §十）：
//   - get 空 → null（不抛）；upsert 新建/幂等/覆盖；UNIQUE(project_id) 兜底
//   - project 不存在 → NOT_FOUND；非法类型/超长/未知字段/缺 projectId → VALIDATION_ERROR
//   - 级联：删 project → businesses + project_watchlist 一起消失（§十）
//   - Watchlist：增删列/上限 10 词(VALIDATION_ERROR + details.max)/重复词 CONFLICT/toggle 持久化
//   - **不采集**：源码内无任何网络调用（剥掉注释后再扫，避免注释自证清白）
//
// 用法：node test/business.accept.mjs    （加 --keep-tmp 保留临时目录）

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
const runDir = join(tmpDir, `business-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')
const businessSrcPath = join(repoRoot, 'electron', 'main', 'marketing', 'businessManager.ts')

const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'businessManager.mjs')
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'project-manager-for-business.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'business-database.mjs')

const bizMod = await import(pathToFileURL(businessPath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)
const {
  BusinessManager,
  WatchlistManager,
  createBusinessManager,
  createWatchlistManager,
  BUSINESS_FIELDS,
  BUSINESS_COMPLETENESS_FIELDS,
  BUSINESS_FIELD_MAX_LENGTH,
  WATCHLIST_MAX,
  WATCHLIST_TYPES,
  WATCHLIST_KEYWORD_MAX_LENGTH
} = bizMod
const { DatabaseClient } = dbMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

function makeClient(overrides = {}) {
  const client = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-business-test',
    requestTimeoutMs: 30_000,
    ...overrides
  })
  clients.add(client)
  return client
}

function makeManagers(database) {
  return {
    business: createBusinessManager({ database, logger }),
    watchlist: createWatchlistManager({ database, logger }),
    projects: projMod.createProjectManager({ database, dataDir, logger })
  }
}

/** 统一把「抛错」变成可断言的结构 */
async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

function countRows(database, table, projectId, extraWhere = {}) {
  return database
    .request(`${table}.count`, { where: { project_id: projectId, ...extraWhere } })
    .then((r) => Number(r && r.count))
}

/** 去掉注释再扫网络 API：注释里写着「绝不联网」不能当成违规，也不能当成证据 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const NETWORK_PATTERNS = [
  [/\bfetch\s*\(/, 'fetch('],
  [/\baxios\b/, 'axios'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bnode:(net|http|https|dgram|tls)\b/, 'node:<net|http|https|dgram|tls>'],
  [/(?:require|from)\s*\(\s*['"](?:node:)?(?:net|http|https|dgram|tls)['"]\s*\)/, "require('net|http|https|dgram|tls')"],
  [/from\s+['"](?:node:)?(?:net|http|https|dgram|tls)['"]/, "import ... from 'net|http|https|dgram|tls'"],
  [/https?:\/\//i, 'http(s):// 字面量']
]

const r = new Recorder('business（Business 1:1 + Watchlist 手工增删，打真 businessManager.ts）')
let main = null
let m = null
const ctx = {}

try {
  // ── B1 真源码可纯 Node import + 常量契约 ──
  await r.check('B1', 'businessManager.ts 可纯 Node import（依赖注入，无 electron 顶层引用）', async () => {
    assert(typeof BusinessManager === 'function', '应导出 BusinessManager')
    assert(typeof WatchlistManager === 'function', '应导出 WatchlistManager')
    assertEq(typeof createBusinessManager, 'function', '应导出 createBusinessManager 工厂')
    assertEq(typeof createWatchlistManager, 'function', '应导出 createWatchlistManager 工厂')
    const bundled = readFileSync(businessPath, 'utf-8')
    const raw = readFileSync(businessSrcPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(raw), '源码不应 import electron')
    assert(!/from\s*["']electron["']/.test(bundled), 'bundle 内不应存在 electron')
    assertEq(WATCHLIST_MAX, 10, 'WATCHLIST_MAX 应为 10（§七 Commit 04）')
    assertEq(WATCHLIST_KEYWORD_MAX_LENGTH, 30, '关注词长度上限应为 30')
    // 白名单 = §四 DDL 的 8 个业务字段
    assertEq(
      [...BUSINESS_FIELDS].sort().join(','),
      ['address', 'brand', 'city', 'name', 'phone', 'positioning', 'target_customer', 'tone'].sort().join(','),
      'BUSINESS_FIELDS 应与 §四 businesses DDL 的 8 个可写字段一致'
    )
    assertEq(
      [...WATCHLIST_TYPES].sort().join(','),
      'audience,industry,product,region',
      'WATCHLIST_TYPES 应为 industry/product/audience/region'
    )
    // 构造期依赖校验（缺 database 立刻炸，不拖到运行期）
    const bad = await outcome(Promise.resolve().then(() => createBusinessManager({})))
    assertEq(bad.code, 'VALIDATION_ERROR', '缺 database 应 VALIDATION_ERROR')
    const badWatch = await outcome(Promise.resolve().then(() => createWatchlistManager({ database: {} })))
    assertEq(badWatch.code, 'VALIDATION_ERROR', 'database 缺 request 应 VALIDATION_ERROR')
    return `bundle=${businessPath.replace(/^.*[\\/]/, '')}；常量/工厂/依赖校验 ✓`
  })

  // ── B2 get 空 → null（UI 首填场景，不是错误） ──
  await r.check('B2', 'getBusiness：无行 → null（不抛 NOT_FOUND）', async () => {
    main = makeClient()
    m = makeManagers(main)
    await main.ping()
    ctx.p1 = await m.projects.createProject({ name: '拾光摄影' })
    ctx.p2 = await m.projects.createProject({ name: '云朵女装' })
    const got = await m.business.getBusiness(ctx.p1.id)
    assertEq(got, null, '未填写时应返回 null')
    const missingId = await outcome(m.business.getBusiness(''))
    assertEq(missingId.code, 'VALIDATION_ERROR', '缺 projectId 应 VALIDATION_ERROR')
    return 'null 语义正确（首填场景不报错）'
  })

  // ── B3 upsert 新建：字段齐 + project_id 正确 + 空串归一 ──
  await r.check('B3', 'upsert 新建：8 字段落库、project_id 正确、空串 → null', async () => {
    const saved = await m.business.upsertBusiness(ctx.p1.id, {
      name: '  拾光摄影  ',
      brand: '拾光',
      city: '绵阳',
      address: '涪城区某某路 1 号',
      phone: '0816-1234567',
      positioning: '县城人像写真',
      target_customer: '25-35 岁年轻妈妈',
      tone: '  '
    })
    ctx.biz1 = saved
    assertEq(saved.project_id, ctx.p1.id, 'project_id 应为传入的 projectId')
    assertEq(saved.name, '拾光摄影', 'name 应 trim')
    assertEq(saved.brand, '拾光', 'brand 应落库')
    assertEq(saved.city, '绵阳', 'city 应落库')
    assertEq(saved.address, '涪城区某某路 1 号', 'address 应落库')
    assertEq(saved.phone, '0816-1234567', 'phone 应落库')
    assertEq(saved.positioning, '县城人像写真', 'positioning 应落库')
    assertEq(saved.target_customer, '25-35 岁年轻妈妈', 'target_customer 应落库')
    assertEq(saved.tone, null, '空白 tone 应归一为 null')
    assert(typeof saved.id === 'string' && saved.id.length > 0, 'id 应生成')
    assert(saved.created_at > 0, 'created_at 应落库')
    assertEq(saved.updated_at, saved.created_at, '新建时 updated_at 应等于 created_at')

    // 未传字段全部落 null（不是 undefined）
    const bare = await m.business.upsertBusiness(ctx.p2.id, { name: '云朵女装' })
    ctx.biz2 = bare
    for (const f of ['brand', 'city', 'address', 'phone', 'positioning', 'target_customer', 'tone']) {
      assertEq(bare[f], null, `新建时未传字段 ${f} 应为 null`)
    }
    assertEq(await countRows(main, 'businesses', ctx.p1.id), 1, '一个 project 一条 business')
    return `id=${saved.id.slice(0, 8)}…；8 字段落库，空串→null`
  })

  // ── B4 upsert 幂等 + 覆盖策略 ──
  await r.check('B4', 'upsert 幂等：同 project 两次 → 只有一行、updated_at 变、旧值被覆盖、未传字段保留', async () => {
    const before = await m.business.getBusiness(ctx.p1.id)
    await sleep(5)
    const after = await m.business.upsertBusiness(ctx.p1.id, {
      name: '拾光摄影·旗舰店',
      city: null // 显式置空
    })
    assertEq(after.id, before.id, '应复用同一行（1:1）')
    assertEq(after.created_at, before.created_at, 'created_at 不应被覆盖')
    assert(after.updated_at > before.updated_at, `updated_at 应刷新（${before.updated_at} → ${after.updated_at}）`)
    assertEq(after.name, '拾光摄影·旗舰店', '传了的字段应被覆盖')
    assertEq(after.city, null, '显式 null 应清空该字段')
    assertEq(after.brand, before.brand, '未传字段应保留旧值（PATCH 策略）')
    assertEq(after.positioning, before.positioning, '未传字段应保留旧值')
    assertEq(await countRows(main, 'businesses', ctx.p1.id), 1, '反复 upsert 仍只有一行')

    // 全量空 patch：不改值，但仍是一次保存（updated_at 前进）
    const same = await m.business.upsertBusiness(ctx.p1.id, {})
    assertEq(same.name, after.name, '空 patch 不应清空任何字段')
    assertEq(same.brand, after.brand, '空 patch 不应清空任何字段')
    return `行 id 稳定；updated_at 前进 ${after.updated_at - before.updated_at}ms；未传字段保留`
  })

  // ── B5 UNIQUE(project_id) 兜底 ──
  await r.check('B5', 'UNIQUE(project_id)：绕过 manager 直插第二行 → 报错（DB 层兜得住）', async () => {
    const now = Date.now()
    const dup = await outcome(
      main.request('businesses.create', {
        data: { id: 'biz-direct-dup', project_id: ctx.p1.id, name: '野生第二行', created_at: now, updated_at: now }
      })
    )
    assertEq(dup.ok, false, '第二行应被 UNIQUE(project_id) 拒绝')
    assertEq(dup.code, 'CONFLICT', '应回 CONFLICT（worker 把 UNIQUE 映射成 CONFLICT）')
    assertEq(await countRows(main, 'businesses', ctx.p1.id), 1, '仍然只有一行')
    return `code=${dup.code}`
  })

  // ── B6 project 不存在 → NOT_FOUND ──
  await r.check('B6', 'project 不存在 → NOT_FOUND（不靠外键报错糊过去）', async () => {
    const up = await outcome(m.business.upsertBusiness('ghost-project', { name: '幽灵店' }))
    assertEq(up.code, 'NOT_FOUND', 'upsert 应回 NOT_FOUND')
    assertEq(up.details && up.details.projectId, 'ghost-project', 'details 应带 projectId')
    const add = await outcome(m.watchlist.addWatch('ghost-project', '写真'))
    assertEq(add.code, 'NOT_FOUND', 'watchlist.add 应回 NOT_FOUND')
    const enable = await outcome(m.watchlist.setWatchEnabled('ghost-project', '写真', true))
    assertEq(enable.code, 'NOT_FOUND', 'setWatchEnabled 应回 NOT_FOUND')
    assertEq(await countRows(main, 'businesses', 'ghost-project'), 0, '不得留下孤儿行')
    return `3 个入口均 NOT_FOUND，0 孤儿行`
  })

  // ── B7 校验：类型/超长/未知字段/缺 projectId ──
  await r.check('B7', '校验：非字符串/超长/未知字段 → VALIDATION_ERROR；失败不落库', async () => {
    const rowsBefore = await countRows(main, 'businesses', ctx.p2.id)
    const badType = await outcome(m.business.upsertBusiness(ctx.p2.id, { name: 42 }))
    assertEq(badType.code, 'VALIDATION_ERROR', '非字符串应 VALIDATION_ERROR')
    assertEq(badType.details && badType.details.field, 'name', 'details.field 应为 name')

    const tooLong = await outcome(
      m.business.upsertBusiness(ctx.p2.id, { positioning: 'x'.repeat(BUSINESS_FIELD_MAX_LENGTH + 1) })
    )
    assertEq(tooLong.code, 'VALIDATION_ERROR', '超长应 VALIDATION_ERROR')
    assertEq(tooLong.details && tooLong.details.max, BUSINESS_FIELD_MAX_LENGTH, 'details.max 应为 200')
    assertEq(tooLong.details && tooLong.details.length, BUSINESS_FIELD_MAX_LENGTH + 1, 'details.length 应为实际长度')

    const justOk = await outcome(
      m.business.upsertBusiness(ctx.p2.id, { city: 'y'.repeat(BUSINESS_FIELD_MAX_LENGTH) })
    )
    assertEq(justOk.ok, true, '刚好 200 字符应通过（边界包含）')

    const unknown = await outcome(m.business.upsertBusiness(ctx.p2.id, { nickname: 'x' }))
    assertEq(unknown.code, 'VALIDATION_ERROR', '未知字段应 VALIDATION_ERROR（不静默丢弃）')
    assertEq(unknown.details && unknown.details.allowed.length, 8, 'details.allowed 应列出 8 个可写字段')

    const noProject = await outcome(m.business.upsertBusiness('   ', { name: 'x' }))
    assertEq(noProject.code, 'VALIDATION_ERROR', '空白 projectId 应 VALIDATION_ERROR')
    const noProjectNull = await outcome(m.business.upsertBusiness(null, { name: 'x' }))
    assertEq(noProjectNull.code, 'VALIDATION_ERROR', '缺 projectId 应 VALIDATION_ERROR')

    const idField = await outcome(m.business.upsertBusiness(ctx.p2.id, { id: 'forged' }))
    assertEq(idField.code, 'VALIDATION_ERROR', 'id 属身份字段，不接受写入')

    const after = await m.business.getBusiness(ctx.p2.id)
    assertEq(after.city, 'y'.repeat(BUSINESS_FIELD_MAX_LENGTH), '只有合法那一次生效')
    assertEq(after.name, '云朵女装', '非法入参不得污染已有字段')
    assertEq(await countRows(main, 'businesses', ctx.p2.id), rowsBefore, '非法入参不得新增行')
    return `4 类非法入参拒绝；200 边界通过`
  })

  // ── B8 Watchlist：增/列/删 ──
  await r.check('B8', 'watchlist add/list/remove：列表按 created_at 升序，删除幂等', async () => {
    const a = await m.watchlist.addWatch(ctx.p1.id, '  孕妇照  ', 'product')
    await sleep(3)
    const b = await m.watchlist.addWatch(ctx.p1.id, '绵阳', 'region')
    await sleep(3)
    const c = await m.watchlist.addWatch(ctx.p1.id, '儿童摄影') // 不传 type
    assertEq(a.keyword, '孕妇照', 'keyword 应 trim 后落库')
    assertEq(a.type, 'product', 'type 应落库')
    assertEq(c.type, null, '不传 type → null（未分类合法）')
    assertEq(a.enabled, 1, '新增默认 enabled=1')

    let list = await m.watchlist.listWatchlist(ctx.p1.id)
    assertEq(list.length, 3, '应有 3 个词')
    for (let i = 1; i < list.length; i++) {
      assert(
        list[i - 1].created_at <= list[i].created_at ||
          (list[i - 1].created_at === list[i].created_at && list[i - 1].keyword <= list[i].keyword),
        '列表应按 created_at 升序（同刻按 keyword）'
      )
    }
    assertEq(list.map((w) => w.keyword).join(','), '孕妇照,绵阳,儿童摄影', '顺序应与插入一致')

    const removed = await m.watchlist.removeWatch(ctx.p1.id, '绵阳')
    assertEq(removed.removed, true, 'remove 应返回 removed=true')
    const again = await m.watchlist.removeWatch(ctx.p1.id, '绵阳')
    assertEq(again.removed, false, '重复删除应幂等（removed=false，不报错）')
    list = await m.watchlist.listWatchlist(ctx.p1.id)
    assertEq(list.length, 2, '删除后应剩 2 个词')
    // 跨 project 隔离
    await m.watchlist.addWatch(ctx.p2.id, '连衣裙', 'product')
    assertEq((await m.watchlist.listWatchlist(ctx.p2.id)).length, 1, '另一个 project 的关注词独立')
    assertEq((await m.watchlist.listWatchlist(ctx.p1.id)).length, 2, '本 project 列表不受影响')
    return `3 词升序；删除幂等；跨 project 隔离 ✓`
  })

  // ── B9 上限 10 词 ──
  await r.check('B9', '上限 10 词：第 11 个 → VALIDATION_ERROR + details.max=10（不是 DB_ERROR）', async () => {
    const filler = await m.projects.createProject({ name: '上限测试店' })
    for (let i = 1; i <= WATCHLIST_MAX; i++) {
      await m.watchlist.addWatch(filler.id, `词-${i}`, 'industry')
    }
    assertEq(await countRows(main, 'project_watchlist', filler.id), WATCHLIST_MAX, '应恰好 10 个词')
    const overflow = await outcome(m.watchlist.addWatch(filler.id, '第 11 个'))
    assertEq(overflow.ok, false, '第 11 个应失败')
    assertEq(overflow.code, 'VALIDATION_ERROR', '应是 VALIDATION_ERROR（业务约束，非基础设施故障）')
    assertEq(overflow.details && overflow.details.max, WATCHLIST_MAX, 'details.max 应为 10')
    assertEq(overflow.details && overflow.details.current, WATCHLIST_MAX, 'details.current 应为 10')
    assertEq(await countRows(main, 'project_watchlist', filler.id), WATCHLIST_MAX, '失败的添加不得落库')

    // 删一个 → 又能加
    await m.watchlist.removeWatch(filler.id, '词-1')
    const okAgain = await outcome(m.watchlist.addWatch(filler.id, '第 11 个'))
    assertEq(okAgain.ok, true, '腾出位置后应能再加')
    assertEq(await countRows(main, 'project_watchlist', filler.id), WATCHLIST_MAX, '仍为 10 个词')
    return `10 词封顶；第 11 个 code=${overflow.code} details.max=${overflow.details.max}`
  })

  // ── B10 重复词 → CONFLICT ──
  await r.check('B10', '重复词 → CONFLICT（UI 要能提示「这个词已在列表里」）', async () => {
    const dup = await outcome(m.watchlist.addWatch(ctx.p1.id, '孕妇照', 'product'))
    assertEq(dup.ok, false, '重复词应失败')
    assertEq(dup.code, 'CONFLICT', '应回 CONFLICT（不是 VALIDATION_ERROR/DB_ERROR）')
    assertEq(dup.details && dup.details.keyword, '孕妇照', 'details 应带 keyword')
    // 全半角/空格差异 trim 后视为同一个词
    const dupTrim = await outcome(m.watchlist.addWatch(ctx.p1.id, '  孕妇照  '))
    assertEq(dupTrim.code, 'CONFLICT', 'trim 后同词仍应 CONFLICT')
    // 不同 project 的同名词互不冲突
    const crossOk = await outcome(m.watchlist.addWatch(ctx.p2.id, '孕妇照'))
    assertEq(crossOk.ok, true, '不同 project 的同名词应可各自存在')
    return `code=${dup.code}；跨 project 不冲突`
  })

  // ── B11 keyword / type 校验 ──
  await r.check('B11', 'keyword 空/超长 → VALIDATION_ERROR；type 非法 → VALIDATION_ERROR 且不落库', async () => {
    const before = await countRows(main, 'project_watchlist', ctx.p2.id)
    for (const bad of ['', '   ', undefined, null, 42, 'x'.repeat(WATCHLIST_KEYWORD_MAX_LENGTH + 1)]) {
      const out = await outcome(m.watchlist.addWatch(ctx.p2.id, bad))
      assertEq(out.ok, false, `keyword=${JSON.stringify(bad)} 应失败`)
      assertEq(out.code, 'VALIDATION_ERROR', `keyword=${JSON.stringify(bad)} 应回 VALIDATION_ERROR`)
      assertEq(out.details && out.details.field, 'keyword', 'details.field 应为 keyword')
    }
    const edge = await outcome(
      m.watchlist.addWatch(ctx.p2.id, 'z'.repeat(WATCHLIST_KEYWORD_MAX_LENGTH), 'audience')
    )
    assertEq(edge.ok, true, `刚好 ${WATCHLIST_KEYWORD_MAX_LENGTH} 字符应通过`)

    const badType = await outcome(m.watchlist.addWatch(ctx.p2.id, '新词', 'nonsense'))
    assertEq(badType.code, 'VALIDATION_ERROR', '非法 type 应 VALIDATION_ERROR（不静默归一）')
    assertEq(badType.details && badType.details.field, 'type', 'details.field 应为 type')
    assertEq(
      (await m.watchlist.listWatchlist(ctx.p2.id)).some((w) => w.keyword === '新词'),
      false,
      '非法 type 时不得落库'
    )
    assertEq(await countRows(main, 'project_watchlist', ctx.p2.id), before + 1, '只有合法那一次落库')
    return `keyword 6 类非法入参 + type 非法均拒绝；30 字符边界通过`
  })

  // ── B12 setWatchEnabled 持久化 ──
  await r.check('B12', 'setWatchEnabled：持久化 0/1；词不存在 → NOT_FOUND；非法值 → VALIDATION_ERROR', async () => {
    const off = await m.watchlist.setWatchEnabled(ctx.p1.id, '孕妇照', false)
    assertEq(off.enabled, 0, 'false 应写 0')
    assertEq((await m.watchlist.listWatchlist(ctx.p1.id)).find((w) => w.keyword === '孕妇照').enabled, 0, '列表应读回 0')
    const on = await m.watchlist.setWatchEnabled(ctx.p1.id, '孕妇照', 1)
    assertEq(on.enabled, 1, '数字 1 应写 1')

    const miss = await outcome(m.watchlist.setWatchEnabled(ctx.p1.id, '不存在的词', true))
    assertEq(miss.code, 'NOT_FOUND', '词不存在应 NOT_FOUND（修改语义不静默成功）')
    const badValue = await outcome(m.watchlist.setWatchEnabled(ctx.p1.id, '孕妇照', 'yes'))
    assertEq(badValue.code, 'VALIDATION_ERROR', '非法 enabled 应 VALIDATION_ERROR')

    // 模拟重启：新 DatabaseClient + 新 manager，只读数据
    await main.dispose()
    clients.delete(main)
    const restarted = makeClient()
    const m2 = makeManagers(restarted)
    main = restarted
    m = m2
    const biz = await m2.business.getBusiness(ctx.p1.id)
    assertEq(biz && biz.name, '拾光摄影·旗舰店', '重启后 business 应仍在（落库为真）')
    assertEq(biz && biz.brand, '拾光', '重启后未传字段的保留值仍在')
    const words = await m2.watchlist.listWatchlist(ctx.p1.id)
    assertEq(words.length, 2, '重启后关注词应仍在')
    assertEq(words.find((w) => w.keyword === '孕妇照').enabled, 1, 'enabled 应持久化')
    return `0/1 往返持久化；重启后 business + watchlist 均可读`
  })

  // ── B13 deleteBusiness 幂等 ──
  await r.check('B13', 'deleteBusiness：删除生效且幂等（无行 → deleted:false，不报错）', async () => {
    const before = await countRows(main, 'businesses', ctx.p2.id)
    assertEq(before, 1, '前置：应有一行')
    const first = await m.business.deleteBusiness(ctx.p2.id)
    assertEq(first.deleted, true, '首次删除应 deleted=true')
    assertEq(await countRows(main, 'businesses', ctx.p2.id), 0, '行应已删除')
    const second = await m.business.deleteBusiness(ctx.p2.id)
    assertEq(second.deleted, false, '重复删除应幂等')
    const missingId = await outcome(m.business.deleteBusiness(''))
    assertEq(missingId.code, 'VALIDATION_ERROR', '缺 projectId 应 VALIDATION_ERROR')
    // 删除后 upsert 应能重新创建（id 换新，不留残渣）
    const recreated = await m.business.upsertBusiness(ctx.p2.id, { name: '云朵女装·重建' })
    assert(recreated.id !== ctx.biz2.id, '重建应拿到新的 business id')
    assertEq(recreated.name, '云朵女装·重建', '重建内容应落库')
    return `deleted true → false；重建 id 已换新`
  })

  // ── B14 级联：删 project 带走 businesses + watchlist（§十） ──
  await r.check('B14', '级联：删 Project → businesses + project_watchlist 行一起消失', async () => {
    const victim = await m.projects.createProject({ name: '待删摄影' })
    const keeper = await m.projects.createProject({ name: '保留女装' })
    await m.business.upsertBusiness(victim.id, { name: '待删店', city: '绵阳' })
    await m.watchlist.addWatch(victim.id, '毕业照', 'product')
    await m.watchlist.addWatch(victim.id, '绵阳', 'region')
    await m.business.upsertBusiness(keeper.id, { name: '保留店' })
    await m.watchlist.addWatch(keeper.id, '连衣裙', 'product')

    assertEq(await countRows(main, 'businesses', victim.id), 1, '删除前 businesses 应有 1 行')
    assertEq(await countRows(main, 'project_watchlist', victim.id), 2, '删除前 watchlist 应有 2 行')

    const res = await m.projects.deleteProject(victim.id)
    assertEq(res.rowDeleted, true, 'Project 应已删除')
    assertEq(await countRows(main, 'businesses', victim.id), 0, 'businesses 应被级联清空')
    assertEq(await countRows(main, 'project_watchlist', victim.id), 0, 'project_watchlist 应被级联清空')
    // 邻店不受影响
    assertEq(await countRows(main, 'businesses', keeper.id), 1, '其他 Project 的 business 不受影响')
    assertEq(await countRows(main, 'project_watchlist', keeper.id), 1, '其他 Project 的 watchlist 不受影响')
    assertEq((await m.business.getBusiness(victim.id)), null, '删后 get 应回 null（首填场景）')
    return `级联清 2 表；邻店数据完好`
  })

  // ── B15 不采集：源码无任何网络调用 ──
  await r.check('B15', '不采集：模块源码内无任何网络调用（剥注释后静态扫描）', async () => {
    const raw = readFileSync(businessSrcPath, 'utf-8')
    const code = stripComments(raw)
    const hits = []
    for (const [pattern, label] of NETWORK_PATTERNS) {
      if (pattern.test(code)) hits.push(label)
    }
    assertEq(hits.join(' / '), '', `businessManager.ts 不应存在网络调用，命中: ${hits.join(' / ')}`)
    // 也不允许出现「采集/爬取」相关依赖（collector / crawler / puppeteer / cheerio）
    for (const word of ['collector', 'crawler', 'puppeteer', 'cheerio', 'playwright']) {
      assert(!new RegExp(`\\b${word}\\b`, 'i').test(code), `不应依赖 ${word}（采集属 Commit 11，硬规则 12）`)
    }
    // 文件头必须写死「绝不采集」契约（防止后续提交悄悄把采集塞进来）
    assert(/绝不联网|绝不采集/.test(raw), '文件头应写明「绝不联网 / 绝不采集」契约')
    assert(/Commit 11|collector/.test(raw), '文件头应指明采集归属 Commit 11 的 collector adapter')
    return `${NETWORK_PATTERNS.length} 类网络特征 0 命中；无采集依赖；契约注释在位`
  })

  // ── B16 IPC / preload / main wiring / store 契约静态核对 ──
  await r.check('B16', 'IPC 通道 / preload / wiring / store 契约一致（静态核对，避免漂移）', async () => {
    const ipcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'marketing.ts'), 'utf-8')
    const ipcIndexSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'index.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    const mainSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
    const storeSrc = readFileSync(join(repoRoot, 'src', 'stores', 'marketing.ts'), 'utf-8')
    const storeCode = stripComments(storeSrc)

    const channels = [
      'marketing:business:get',
      'marketing:business:upsert',
      'marketing:business:delete',
      'marketing:watchlist:list',
      'marketing:watchlist:add',
      'marketing:watchlist:remove',
      'marketing:watchlist:setEnabled'
    ]
    for (const c of channels) {
      assert(ipcSrc.includes(`'${c}'`), `ipc/marketing.ts 应声明通道 ${c}`)
      assert(preloadSrc.includes(`'${c}'`), `preload/index.ts 应暴露通道 ${c}`)
    }
    assert(/MARKETING_BUSINESS_CHANNELS/.test(ipcSrc), '应导出 MARKETING_BUSINESS_CHANNELS')
    assert(/MARKETING_WATCHLIST_CHANNELS/.test(ipcSrc), '应导出 MARKETING_WATCHLIST_CHANNELS')
    assert(/MARKETING_BUSINESS_CHANNELS/.test(ipcIndexSrc), 'ipc/index.ts 应转出 business 通道表')
    assert(/MARKETING_WATCHLIST_CHANNELS/.test(ipcIndexSrc), 'ipc/index.ts 应转出 watchlist 通道表')
    assert(
      /registerMarketingIpc\([\s\S]{0,200}businessManager[\s\S]{0,200}watchlistManager/.test(ipcSrc),
      'registerMarketingIpc 应接收 businessManager + watchlistManager'
    )
    // 1:1 → 不应出现 business:list / business:create 通道
    assert(!/marketing:business:(list|create)/.test(ipcSrc), 'Business 与 Project 1:1，不应有 list/create 通道')
    // 主进程 wiring
    assert(/createBusinessManager/.test(mainSrc), 'main/index.ts 应创建 businessManager')
    assert(/createWatchlistManager/.test(mainSrc), 'main/index.ts 应创建 watchlistManager')
    assert(
      /registerMarketingIpc\(\s*marketingDatabase!,\s*marketingProjectManager!,\s*marketingBusinessManager!,\s*marketingWatchlistManager!\s*\)/.test(
        mainSrc
      ),
      'main/index.ts 应把 4 个依赖都传给 registerMarketingIpc'
    )
    // store 契约（主会话 UI 直接依赖这些名字）
    for (const name of [
      'business',
      'businessLoading',
      'loadBusiness',
      'saveBusiness',
      'completeness',
      'watchlist',
      'watchlistLoading',
      'loadWatchlist',
      'addWatch',
      'removeWatch',
      'setWatchEnabled',
      'BUSINESS_COMPLETENESS_FIELDS',
      'WATCHLIST_MAX',
      'WATCHLIST_PRESET_TYPES'
    ]) {
      assert(new RegExp(`\\b${name}\\b`).test(storeSrc), `store 应暴露 ${name}`)
    }
    assert(
      /business\s*=\s*ref<Business \| null>\(null\)\s*as Ref<Business \| null>/.test(storeSrc.replace(/\s+/g, ' ')),
      'store 的 business 应为 Ref<Business | null>（null = 未填写）'
    )
    assert(
      /watchlist\s*=\s*ref<WatchItem\[\]>\(\[\]\)\s*as Ref<WatchItem\[\]>/.test(storeSrc.replace(/\s+/g, ' ')),
      'store 的 watchlist 应为 Ref<WatchItem[]>'
    )
    assert(
      !/error\.message\.includes\(|message\.includes\(/.test(storeCode),
      'store 禁止用 message.includes() 判断错误（只看代码，注释不算）'
    )
    // 完整度口径：两处常量必须一致（跨 tsconfig 无法共享，靠这里守）
    const grab = (src) => {
      const m2 = src.match(/BUSINESS_COMPLETENESS_FIELDS[\s\S]{0,40}?=\s*\[([^\]]*)\]/)
      assert(m2, '应能解析出 BUSINESS_COMPLETENESS_FIELDS')
      return (m2[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')).join(',')
    }
    assertEq(
      grab(storeSrc),
      grab(readFileSync(businessSrcPath, 'utf-8')),
      'store 与 manager 的 BUSINESS_COMPLETENESS_FIELDS 必须一致'
    )
    for (const name of ['WATCHLIST_TYPES', 'WATCHLIST_MAX']) {
      assert(new RegExp(`\\b${name}\\b`).test(readFileSync(businessSrcPath, 'utf-8')), `manager 应导出 ${name}`)
    }
    return `7 通道三处一致；store 14 项契约齐全；完整度口径两处一致`
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const c of [...clients]) {
    try {
      await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
}

const result = r.toJSON({
  bundle: businessPath,
  dataDir,
  nodePath,
  logSample: logs.slice(0, 20)
})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-business.json'), result)
console.log('结果已写入 test/accept-result-business.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
