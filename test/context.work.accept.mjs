// test/context.accept.mjs —— Commit 04 验收：Context Engine v3 + 只读快照
//
// **打真实源码**：esbuild 把 contextEngine.ts + contextManager.ts + 真 DatabaseClient 串起来，
// 纯 Node 跑真 SQLite（真 Worker/建库/迁移）。
//
// 覆盖（对齐 PLAN-3.0.md §六 / §14 B1）：
//   - 七段齐全；画像/事项/待办/confirmed 记录/ready 知识正确入段
//   - **confirmed-only（§6.2）**：candidate 记录不进第 5 段
//   - **预算内全量（§6.3）**：小知识库 mode=full，全量注入
//   - **超预算裁剪**：极小窗口 → truncated；有 query LIKE 命中优先；账本 used ≤ budget
//   - 裁剪顺序 6→…（知识先让位；画像不被砍）
//   - 快照 B1：latest 实时视图；只暴露 memory_snapshot/inputs/dropped；
//     **不泄露 prompt 全文/GATEWAY_TOKEN**
//   - scope 校验：qa/report 缺 id → VALIDATION_ERROR；id 无快照 → NOT_FOUND
//   - token 本地估算纯函数（CJK=1/字）
//
// 用法：node test/context.accept.mjs（npm run accept:context）

import { mkdirSync, readFileSync } from 'node:fs'
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
const runDir = join(tmpDir, `context-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })
const repoRoot = join(__dirname, '..')

// ── bundle ──
const dbBundled = bundleEntry('electron/main/database/database.ts', 'ctx-database.mjs')
const engineBundled = bundleEntry('electron/main/work/contextEngine.ts', 'ctx-engine.mjs')
const managerBundled = bundleEntry('electron/main/work/contextManager.ts', 'ctx-manager.mjs')
// profileManager / matterManager / todoManager / recordManager 用于造数据
const profileBundled = bundleEntry('electron/main/work/profileManager.ts', 'ctx-profile.mjs')
const matterBundled = bundleEntry('electron/main/work/matterManager.ts', 'ctx-matter.mjs')
const todoBundled = bundleEntry('electron/main/work/todoManager.ts', 'ctx-todo.mjs')
const recordBundled = bundleEntry('electron/main/work/recordManager.ts', 'ctx-record.mjs')

const dbMod = await import(pathToFileURL(dbBundled).href)
const engineMod = await import(pathToFileURL(engineBundled).href)
const managerMod = await import(pathToFileURL(managerBundled).href)
const profileMod = await import(pathToFileURL(profileBundled).href)
const matterMod = await import(pathToFileURL(matterBundled).href)
const todoMod = await import(pathToFileURL(todoBundled).href)
const recordMod = await import(pathToFileURL(recordBundled).href)

const { DatabaseClient } = dbMod
const {
  createContextEngine,
  renderContextPackText,
  estimateTokens,
  addDays,
  CONTEXT_BUDGET_RATIO
} = engineMod
const { createContextManager } = managerMod
const { createProfileManager } = profileMod
const { createMatterManager } = matterMod
const { createTodoManager } = todoMod
const { createRecordManager } = recordMod

const logger = () => {}
function clock(startMs = Date.UTC(2026, 8, 23, 10, 0, 0)) {
  let t = startMs
  let n = 0
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    newId: () => `x${++n}`
  }
}

const r = new Recorder('Commit 04 · Context Engine v3')
let database = null
async function outcome(p) {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

try {
  await r.check('E0', '前置：真 Worker/建库/8 表', async () => {
    database = new DatabaseClient({
      dbPath,
      backupDir,
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker-commit04',
      requestTimeoutMs: 30_000,
      logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'ready')
    assertEq(st.tables.length, 8, '8 表')
    return `pid=${st.workerPid}`
  })

  const c = clock()
  const profiles = createProfileManager({ database, logger })
  const matters = createMatterManager({ database, logger, now: c.now, newId: c.newId })
  const todos = createTodoManager({ database, logger, now: c.now, newId: c.newId })
  const records = createRecordManager({ database, logger, now: c.now, newId: c.newId })
  const engine = createContextEngine({ database, logger, now: c.now })

  // ── 造数据 ──
  await r.check('E1', '造数据：画像 + 2 事项 + 3 待办 + confirmed/candidate 记录 + 2 ready 知识', async () => {
    await profiles.update({ callName: '小北', position: '产品经理', company: '某公司' })
    await matters.create({ name: 'Q3活动' })
    c.advance(1000)
    await matters.create({ name: '招聘' })
    await todos.create({ title: '今天的待办' })
    await todos.create({ title: '无日期待办' })
    await todos.create({ title: 'AI 提取的待办', source: 'extracted' }) // candidate，不应进第4段
    await records.create({ content: '完成活动方案', occurredDate: '2026-09-23', occurredTime: '10:00' })
    await records.create({ content: '昨天的准备', occurredDate: '2026-09-22' })
    // 直接插一条 candidate 记录（绕过 create）
    await database.request('activity_log.create', {
      data: {
        id: 'cand-rec',
        content: '未确认的候选记录',
        occurred_date: '2026-09-23',
        source: 'ai_output',
        status: 'candidate',
        created_at: c.now,
        updated_at: c.now
      }
    })
    await database.request('knowledge.create', {
      data: {
        id: 'k1',
        title: '报销规范',
        type: 'text',
        content: '差旅报销需在 5 个工作日内提交，附发票。',
        status: 'ready',
        created_at: c.now,
        updated_at: c.now
      }
    })
    await database.request('knowledge.create', {
      data: {
        id: 'k2',
        title: '周报模板',
        type: 'markdown',
        content: '本周进展 / 下周计划 / 风险三项。',
        status: 'ready',
        created_at: c.now,
        updated_at: c.now
      }
    })
    return '数据就绪'
  })

  // ── 七段 + confirmed-only ──
  await r.check('E2', '七段齐全；画像/事项/待办/记录/知识入段；candidate 记录不进第5段', async () => {
    const pack = await engine.buildPack('qa', { task: '回答一个工作问题' })
    assertEq(pack.scope, 'qa', 'scope')
    assert(pack.profileSummary, '画像摘要应在（已填3项）')
    assert(pack.profileSummary.text.includes('小北'), '画像摘要含姓名')
    assertEq(pack.matters.length, 2, '2 个在跟事项')
    // 第4段：confirmed 待办 2 条（today + 无日期）；candidate 的 AI 提取待办不在
    assertEq(pack.todos.length, 2, `应只含 confirmed 待办（实际 ${pack.todos.length}）`)
    assert(!pack.todos.some((t) => t.title === 'AI 提取的待办'), 'candidate 待办不进第4段')
    assert(pack.todos.some((t) => t.title === '今天的待办'), '今日待办在')
    // 第5段：qa 窗口近3天，confirmed 记录 2 条；candidate 记录不在
    assertEq(pack.records.length, 2, `应只含 confirmed 记录（实际 ${pack.records.length}）`)
    assert(!pack.records.some((x) => x.id === 'cand-rec'), 'candidate 记录不进第5段（§6.2）')
    assert(pack.records.some((x) => x.content === '昨天的准备'), '近3天含昨天')
    // 第6段：2 条 ready 知识
    assertEq(pack.knowledge.length, 2, '2 条知识')
    const text = renderContextPackText(pack)
    assert(text.includes('【任务】'), '渲染含任务段')
    assert(text.includes('报销规范'), '渲染含知识')
    assert(!text.includes('未确认的候选记录'), '渲染事实层不含 candidate')
    return `七段齐；confirmed-only 生效`
  })

  // ── 全量 vs 裁剪 ──
  await r.check('E3', '预算内全量（mode=full）；used ≤ budget；画像不被裁', async () => {
    const pack = await engine.buildPack('qa', {})
    assertEq(pack.budget.mode, 'full', '小知识库应全量')
    assertEq(pack.knowledge.length, 2, '全量 2 条')
    assert(pack.budget.usedTokens <= pack.budget.budgetTokens, 'used ≤ budget')
    assert(pack.profileSummary, '全量下画像保留（不被裁）')
    assert(pack.retrieval.mode === 'full', 'retrieval=full（未做 LIKE）')
    return `mode=full used=${pack.budget.usedTokens} budget=${pack.budget.budgetTokens}`
  })

  await r.check('E4', '超预算裁剪：大知识+小窗口 → truncated；知识先让位；used ≤ budget', async () => {
    // 窗口地板是 2000（budget=1400），故靠**塞大知识**而不是缩窗来触发裁剪。
    // 插一条 ~2000 字 CJK（≈2000 token），加上固定段后超过 budget。
    const big = '项目资料正文'.repeat(420) // 6×420≈2520 字 ≈2520 token，独自即超 budget
    await database.request('knowledge.create', {
      data: {
        id: 'kbig',
        title: '大型项目背景文档',
        type: 'text',
        content: big,
        status: 'ready',
        created_at: c.now,
        updated_at: c.now
      }
    })
    const pack = await engine.buildPack('qa', { contextWindowTokens: 2200 })
    assertEq(pack.budget.mode, 'truncated', '应触发裁剪')
    assert(pack.budget.usedTokens <= pack.budget.budgetTokens, '裁剪后 used ≤ budget（保险丝）')
    assert(pack.profileSummary, '画像不被砍（§6.3，知识让位）')
    return `truncated；used=${pack.budget.usedTokens} budget=${pack.budget.budgetTokens}；画像保留`
  })

  await r.check('E5', '裁剪排序：超预算 + 有 query → LIKE 命中知识优先', async () => {
    // query 只在裁剪（truncated）下生效；先确保超预算（E4 已塞大知识）。
    // 新增一条命中「周报」的知识，与 query 对齐，看它是否排到前面。
    await database.request('knowledge.create', {
      data: {
        id: 'kweek',
        title: '周报写法要点',
        type: 'text',
        content: '周报应突出本周周报关键产出与阻塞。',
        status: 'ready',
        created_at: c.now,
        updated_at: c.now
      }
    })
    const pack = await engine.buildPack('qa', {
      contextWindowTokens: 2200,
      query: '周报'
    })
    assertEq(pack.retrieval.mode, 'like', '裁剪+query → like')
    assert(pack.retrieval.hits >= 1, '应记录命中数')
    // 命中「周报」的条目应排在未命中的大文档之前
    const first = pack.knowledge[0]
    if (first) {
      assertEq(first.id === 'kweek' || first.matchedQuery, true, 'LIKE 命中的应优先')
    }
    return `mode=like hits=${pack.retrieval.hits}`
  })

  // ── 窗口边界 ──
  await r.check('E6', '记录窗口随 scope：latest=当天（不含昨天）；report=7天', async () => {
    const latest = await engine.buildPack('latest', {})
    assertEq(latest.records.filter((x) => x.content === '完成活动方案').length, 1, 'latest 含当天')
    assertEq(latest.records.filter((x) => x.content === '昨天的准备').length, 0, 'latest 不含昨天（仅当天）')
    const report = await engine.buildPack('report', {})
    assertEq(report.records.length, 2, 'report 7天含两天')
    return `latest=1 当天；report=2`
  })

  // ── 快照 B1 ──
  await r.check('E7', '快照 latest：只暴露 memory_snapshot/inputs/dropped；不泄露凭据/整段 prompt', async () => {
    const builtPack = await engine.buildPack('latest', { task: '常规任务' })
    const mgr = createContextManager({
      database,
      buildLatestPack: () => Promise.resolve(builtPack)
    })
    const view = await mgr.snapshot({ scope: 'latest' })
    assert(view.memory_snapshot, '含 memory_snapshot')
    assert(Array.isArray(view.dropped), 'dropped 是数组')
    assert(view.inputs, '含 inputs（任务作为输入副本是合法的）')
    const json = JSON.stringify(view)
    // 硬规则3：无 GATEWAY_TOKEN
    assert(!json.includes('GATEWAY_TOKEN'), '快照不含 GATEWAY_TOKEN')
    // B1：不内嵌**整段渲染 prompt**（结构化视图，而非拼接全文）
    const fullPrompt = renderContextPackText(builtPack)
    assert(!json.includes(fullPrompt), '快照不回显整段渲染 prompt（只给摘要+输入副本）')
    assertEq(view.memory_snapshot.matters.length >= 1, true, '快照含事项摘要')
    return `B1 只读口径；无 token/整段 prompt 泄露`
  })

  await r.check('E8', 'scope 校验：非法 scope / qa,report 缺 id → VALIDATION_ERROR', async () => {
    const mgr = createContextManager({ database, buildLatestPack: () => engine.buildPack('latest', {}) })
    const badScope = await outcome(mgr.snapshot({ scope: 'nope' }))
    assertEq(badScope.code, 'VALIDATION_ERROR', '非法 scope')
    const qaNoId = await outcome(mgr.snapshot({ scope: 'qa' }))
    assertEq(qaNoId.code, 'VALIDATION_ERROR', 'qa 缺 id')
    const reportNoId = await outcome(mgr.snapshot({ scope: 'report' }))
    assertEq(reportNoId.code, 'VALIDATION_ERROR', 'report 缺 id')
    return '非法/缺 id 全被 VALIDATION_ERROR 拒'
  })

  await r.check('E9', 'qa/report id 无快照 → NOT_FOUND', async () => {
    const mgr = createContextManager({ database, buildLatestPack: () => engine.buildPack('latest', {}) })
    const qaMiss = await outcome(mgr.snapshot({ scope: 'qa', id: 'run-ghost' }))
    assertEq(qaMiss.code, 'NOT_FOUND', '无 QA 快照')
    // 先造一份报告行（无 generation_context）→ report 也应 NOT_FOUND
    await database.request('reports.create', {
      data: {
        id: 'rep-empty',
        type: 'daily',
        period: '2026-09-23',
        status: 'draft',
        content: 'x',
        created_at: c.now,
        updated_at: c.now
      }
    })
    const repMiss = await outcome(mgr.snapshot({ scope: 'report', id: 'rep-empty' }))
    assertEq(repMiss.code, 'NOT_FOUND', '报告无生成快照')
    const repGone = await outcome(mgr.snapshot({ scope: 'report', id: 'rep-ghost' }))
    assertEq(repGone.code, 'NOT_FOUND', '报告不存在')
    return '无快照统一 NOT_FOUND'
  })

  await r.check('E10', 'token 本地估算纯函数：CJK=1/字；ASCII≈1/4；窗口校验', async () => {
    assertEq(estimateTokens('你好世界'), 4, '4 个 CJK = 4 token')
    assertEq(estimateTokens(''), 0, '空串 0')
    assertEq(estimateTokens('hello world'), 3, '11 ASCII = ceil(2.75)=3')
    assert(CONTEXT_BUDGET_RATIO > 0 && CONTEXT_BUDGET_RATIO < 1, '预算比例合法')
    const badWindow = await outcome(engine.buildPack('qa', { contextWindowTokens: 10 }))
    assertEq(badWindow.code, 'VALIDATION_ERROR', '窗口过小被拒')
    assertEq(addDays('2026-09-23', 1), '2026-09-24', 'addDays')
    assertEq(addDays('2026-09-23', -1), '2026-09-22', 'addDays 负')
    return '估算/窗口/日期工具断言通过'
  })

  await r.check('E11', 'IPC 静态核对：snapshot 只读通道注册（§14）', async () => {
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'work.ts'), 'utf-8')
    assert(src.includes("'work:context:snapshot'"), '注册 snapshot 通道')
    // 无写入口：不应出现 context:* 的非 snapshot handle
    const writeChannels = (src.match(/work:context:[a-z]+/g) || []).filter((c) => c !== 'work:context:snapshot')
    assertEq(writeChannels.length, 0, 'context 面只有 snapshot（只读）')
    return '只读通道唯一'
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
writeJson(join(__dirname, 'accept-result-context.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
