// test/today.accept.mjs —— Commit 05 验收：今日聚合 + 一句话路由
//
// **打真实源码**：esbuild 把 routerManager / todayManager + 真 DatabaseClient 串起来，
// 纯 Node 跑真 SQLite（真 Worker/建库/迁移）。
//
// 覆盖（对齐 PLAN-3.0.md §5 / §14）：
//   Router（§5.2，B3 永不失败）：
//     - 各关键词路由：邮件/报告/待办提醒/纪要/摘要/翻译/润色
//     - 长文本识别；疑问句不误跳（「客户嫌贵怎么回复」→ qa，不跳邮件）
//     - 空输入/无规则 → qa 兜底（永不「没反应」，不抛错）
//     - 「周X」→ 待办提取 + 到期日推算
//   Today（§5.1）：
//     - confirmed 今日待办/无日期/逾期；candidate AI 待办单列
//     - 今日 confirmed 记录；candidate 记录单列（待确认）
//     - 日报状态（exists/status/canGenerate）；counts 徽标；问候语
//
// 用法：node test/today.accept.mjs（npm run accept:today）

import { mkdirSync } from 'node:fs'
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
const runDir = join(tmpDir, `today-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

// ── bundle ──
const dbBundled = bundleEntry('electron/main/database/database.ts', 'tod-database.mjs')
const routerBundled = bundleEntry('electron/main/work/routerManager.ts', 'tod-router.mjs')
const todayBundled = bundleEntry('electron/main/work/todayManager.ts', 'tod-today.mjs')
const todoBundled = bundleEntry('electron/main/work/todoManager.ts', 'tod-todo.mjs')

const dbMod = await import(pathToFileURL(dbBundled).href)
const routerMod = await import(pathToFileURL(routerBundled).href)
const todayMod = await import(pathToFileURL(todayBundled).href)
const todoMod = await import(pathToFileURL(todoBundled).href)

const { DatabaseClient } = dbMod
const { createRouterManager, ROUTE_TARGETS, LONG_TEXT_THRESHOLD } = routerMod
const { createTodayManager } = todayMod
const { createTodoManager } = todoMod

const logger = () => {}
// 固定「现在」= 2026-09-23（周三）10:00
const NOW = Date.UTC(2026, 8, 23, 10, 0, 0)
// 注意：UTC 10:00 在本地（GMT+8）是 18:00 → 用于问候/18:30 边界，today 用本地时区。
// 为避免时区歧义，today 测试单独构造本地时间。
function localNow(y, mo, d, h, mi) {
  return new Date(y, mo, d, h, mi, 0).getTime()
}

const r = new Recorder('Commit 05 · 今日聚合 + 路由')
let database = null

try {
  await r.check('T0', '前置：真 Worker/建库/8 表', async () => {
    database = new DatabaseClient({
      dbPath,
      backupDir,
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker-commit05',
      requestTimeoutMs: 30_000,
      logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'ready')
    assertEq(st.tables.length, 8, '8 表')
    return `pid=${st.workerPid}`
  })

  // ── Router 规则 ──
  const router = createRouterManager({ now: () => localNow(2026, 8, 23, 10, 0) })

  await r.check('R1', '各关键词正确路由（邮件/报告/待办/纪要/摘要/翻译/润色）', async () => {
    assertEq(router.route('帮我写封邮件').target, ROUTE_TARGETS.EMAIL_DRAFT, '邮件')
    assertEq(router.route('写日报').target, ROUTE_TARGETS.REPORT, '日报')
    assertEq(router.route('生成一份周报').target, ROUTE_TARGETS.REPORT, '周报')
    assertEq(router.route('提醒我下午开会').target, ROUTE_TARGETS.TODO_EXTRACT, '提醒→待办')
    assertEq(router.route('记一下买水').target, ROUTE_TARGETS.TODO_EXTRACT, '记一下→待办')
    assertEq(router.route('整理会议纪要').target, ROUTE_TARGETS.TOOL_MINUTES, '纪要')
    assertEq(router.route('翻译成英文').target, ROUTE_TARGETS.TOOL_TRANSLATE, '翻译')
    assertEq(router.route('帮我润色一下').target, ROUTE_TARGETS.TOOL_POLISH, '润色')
    // 长文本 + 总结
    const long = '这是一段比较长的会议文字内容'.repeat(4)
    assertEq(router.route(long + '，帮我总结').target, ROUTE_TARGETS.TOOL_SUMMARY, '长文本总结')
    assert(long.length > LONG_TEXT_THRESHOLD, '长文本超阈值')
    return '9 类关键词路由正确'
  })

  await r.check('R2', 'B3：空输入/无规则 → qa 兜底；不抛错；疑问句不误跳', async () => {
    // B3 永不失败：空/乱输入
    assertEq(router.route('').target, ROUTE_TARGETS.QA, '空 → qa')
    assertEq(router.route('   ').target, ROUTE_TARGETS.QA, '空白 → qa')
    assertEq(router.route(12345).target, ROUTE_TARGETS.QA, '非字符串 → qa（不抛）')
    // 普通疑问 → qa
    assertEq(router.route('这个项目下一步做什么？').target, ROUTE_TARGETS.QA, '疑问 → qa')
    // 关键回归（v0.6 测试）：「客户嫌贵怎么回复」是问答，不是邮件
    assertEq(router.route('客户嫌贵怎么回复').target, ROUTE_TARGETS.QA, '「怎么回复」不跳邮件')
    return '兜底/疑问/误判全走 qa，B3 生效'
  })

  await r.check('R3', '「周X」→ 待办提取 + 到期日推算（基于注入的周三）', async () => {
    // 2026-09-23 是周三；说「周五」→ 2026-09-25
    const res = router.route('周五要交方案')
    assertEq(res.target, ROUTE_TARGETS.TODO_EXTRACT, '周X+要 → 待办')
    assert(res.draft, '产出待办草稿')
    assertEq(res.draft.dueDate, '2026-09-25', '周五 → 2026-09-25')
    assertEq(res.draft.title.includes('交方案'), true, '标题剥掉词后保留正文')
    // 「提醒我」无星期 → dueDate null
    const res2 = router.route('提醒我打电话')
    assertEq(res2.draft.dueDate, null, '无星期 → null')
    assertEq(res2.draft.title, '打电话', '标题提取')
    return '周X 到期日 + 标题提取正确'
  })

  // ── Today 聚合 ──
  const fixedNow = localNow(2026, 8, 23, 10, 0) // 周三 10:00（非 18:30）
  const todos = createTodoManager({ database, logger, now: () => fixedNow })
  const today = createTodayManager({ database, now: () => fixedNow })

  await r.check('D1', '造数据：今日/无日期/逾期 confirmed 待办 + AI candidate 待办', async () => {
    await todos.create({ title: '今天到期', dueDate: '2026-09-23' })
    await todos.create({ title: '没有日期' })
    await todos.create({ title: '已逾期', dueDate: '2026-09-20' })
    await todos.create({ title: '未来的', dueDate: '2026-09-30' }) // 不应出现
    await todos.create({ title: 'AI 提取的待办', source: 'extracted', dueDate: '2026-09-23' })
    return '待办数据就绪'
  })

  await r.check('D2', '今日待办三来源齐（今日/无日期/逾期）；未来的不在；AI candidate 单列', async () => {
    const view = await today.get()
    assertEq(view.date, '2026-09-23', '日期')
    const titles = view.todos.map((t) => t.title)
    assert(titles.includes('今天到期'), '今日到期在')
    assert(titles.includes('没有日期'), '无日期在')
    assert(titles.includes('已逾期'), '逾期在')
    assert(!titles.includes('未来的'), '未来的不在今日页')
    assertEq(view.todos.find((t) => t.title === '已逾期').overdue, true, '逾期标记')
    assertEq(view.todos.find((t) => t.title === '今天到期').overdue, false, '今日不算逾期')
    // AI candidate 单列
    assertEq(view.candidateTodos.length, 1, '1 条 AI candidate 待办')
    assertEq(view.candidateTodos[0].title, 'AI 提取的待办', 'candidate 内容')
    assertEq(view.counts.todos, 3, 'counts.todos=3')
    assertEq(view.counts.candidateTodos, 1, 'counts.candidateTodos=1')
    return '待办三来源 + candidate 单列正确'
  })

  await r.check('D3', '今日记录 confirmed；candidate 记录单列待确认', async () => {
    await database.request('activity_log.create', {
      data: {
        id: 'd-rec1',
        content: '今天做完的事',
        occurred_date: '2026-09-23',
        occurred_time: '09:30',
        source: 'manual',
        status: 'confirmed',
        created_at: fixedNow,
        updated_at: fixedNow
      }
    })
    await database.request('activity_log.create', {
      data: {
        id: 'd-rec2',
        content: '待确认的候选',
        occurred_date: '2026-09-23',
        source: 'ai_output',
        status: 'candidate',
        created_at: fixedNow,
        updated_at: fixedNow
      }
    })
    const view = await today.get()
    assertEq(view.records.length, 1, '1 条 confirmed 记录')
    assertEq(view.records[0].content, '今天做完的事', 'confirmed 内容')
    assertEq(view.records[0].occurredTime, '09:30', '时间在')
    assertEq(view.candidateRecords.length, 1, '1 条 candidate 记录')
    assertEq(view.candidateRecords[0].content, '待确认的候选', 'candidate 内容')
    assertEq(view.counts.records, 1, 'counts.records')
    assertEq(view.counts.candidateRecords, 1, 'counts.candidateRecords')
    return 'confirmed/candidate 记录分流正确'
  })

  await r.check('D4', '日报状态 + canGenerate（18:30 边界）+ 问候语', async () => {
    // 当前 10:00 → canGenerate false；无日报
    const morning = createTodayManager({ database, now: () => localNow(2026, 8, 23, 10, 0) })
    let view = await morning.get()
    assertEq(view.report.exists, false, '10点无日报')
    assertEq(view.report.canGenerate, false, '10点未到18:30')
    assertEq(view.greeting, '早上好', '10点问候')

    // 19:00 → canGenerate true
    const evening = createTodayManager({ database, now: () => localNow(2026, 8, 23, 19, 0) })
    view = await evening.get()
    assertEq(view.report.canGenerate, true, '19点过18:30')
    assertEq(view.greeting, '晚上好', '19点问候')

    // 造一份 draft 日报
    await database.request('reports.create', {
      data: {
        id: 'd-daily',
        type: 'daily',
        period: '2026-09-23',
        status: 'draft',
        content: '草稿',
        created_at: fixedNow,
        updated_at: fixedNow
      }
    })
    view = await morning.get()
    assertEq(view.report.exists, true, '日报存在')
    assertEq(view.report.status, 'draft', 'draft 状态')
    assertEq(view.report.reportId, 'd-daily', 'reportId')
    return '日报状态/canGenerate/问候语正确'
  })

  await r.check('D5', 'get(date) 支持指定日期；weekday 字段；静态 IPC 核对', async () => {
    const view = await today.get('2026-09-23')
    assertEq(view.weekday, 3, '周三 weekday=3')
    // 查一个未来日期 → confirmed 记录为 0；但无日期待办仍展示，且此前的待办变逾期
    const empty = await today.get('2026-09-24')
    assertEq(empty.records.length, 0, '次日无 confirmed 记录')
    assert(empty.todos.some((t) => t.title === '没有日期'), '无日期待办始终展示')
    assert(empty.todos.some((t) => t.title === '今天到期' && t.overdue), '过了今天，原今日待办变逾期')
    return '指定日期/weekday/未来日逾期正确'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  if (database) {
    try {
      await database.dispose()
    } catch {
      /* ignore */
    }
  }
  await sleep(200)
}

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-today.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
