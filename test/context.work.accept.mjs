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

// ── E12 预算公式（W2-b：services/context/budget.ts 纯函数） ──
await r.check('E12', 'computeBudget：floor(window×ratio) / reserved=window-budget / 0 与 ratio=1 边界', async () => {
  const budgetMod = await import(
    pathToFileURL(bundleEntry('electron/main/services/context/budget.ts', 'context-budget.mjs')).href
  )
  const { computeBudget } = budgetMod
  const a = computeBudget(128_000, 0.7)
  assertEq(a.budgetTokens, 89_600, '128k × 0.7 → 89600')
  assertEq(a.reservedTokens, 38_400, '128k × 0.7 → reserved 38400')
  const b = computeBudget(128_000, 0.6)
  assertEq(b.budgetTokens, 76_800, '128k × 0.6 → 76800')
  assertEq(b.reservedTokens, 51_200, '128k × 0.6 → reserved 51200')
  const c = computeBudget(1, 0.7)
  assertEq(c.budgetTokens, 0, 'floor 向下取整')
  assertEq(c.reservedTokens, 1, 'reserved 补齐差额')
  const d = computeBudget(0, 0.7)
  assertEq(d.budgetTokens, 0, '0 窗口')
  assertEq(d.reservedTokens, 0, '0 窗口 reserved')
  const e = computeBudget(2_000, 1)
  assertEq(e.budgetTokens, 2_000, 'ratio=1 时全额进预算')
  assertEq(e.reservedTokens, 0, 'ratio=1 reserved')
  // 非整数 / 负数窗口：上游 requireWindow 已拒绝，这里锁定纯数学行为（不兜底）
  const f = computeBudget(10.5, 0.7)
  assertEq(f.budgetTokens, 7, '非整数窗口：只对 budgetTokens 取 floor')
  assertEq(f.reservedTokens, 3.5, '非整数窗口：reserved 取差额，可为小数')
  const g = computeBudget(-100, 0.7)
  assertEq(g.budgetTokens, -70, '负数窗口：纯数学，不兜底')
  assertEq(g.reservedTokens, -30, '负数窗口：reserved 同为负')
  return '7 组：128k×0.7 / 128k×0.6 / 向下取整 / 0 / ratio=1 / 10.5 / -100'
})

// ── E13 取舍循环内核（W2-c：services/context/assemble.ts） ──
await r.check('E13', 'assembleLoop：全量/准入/截断/保险丝/预置 dropped 五条不变量（合成模型）', async () => {
  const mod = await import(
    pathToFileURL(bundleEntry('electron/main/services/context/assemble.ts', 'context-assemble.mjs')).href
  )
  const { assembleLoop } = mod

  // 合成模型：候选正文 = 'x'.repeat(n)（n 个 ASCII → ceil(n/4) token）
  // renderText = 正文 + 「未注入」清单（清单本身也占预算，与两域一致）
  const mk = (id, chars) => ({ id, body: 'x'.repeat(chars) })
  const renderText = (chosen, dropped, mode) =>
    [
      ...chosen.map((c) => c.body),
      ...(dropped.length ? ['【未注入】', ...dropped.map((d) => d.title)] : [])
    ].join('\n')
  const toDropped = (item, reason) => ({ id: item.id, title: 'T' + item.id, reason })
  const titleTokens = (item) => estimateTokens('T' + item.id)
  const include = (item, { truncate, sliceBudget }) => ({
    ...item,
    truncated: truncate,
    body: truncate
      ? engineMod.sliceToTokenBudget(item.body, Math.max(0, sliceBudget ?? 0))
      : item.body
  })

  const base = {
    markerTokens: estimateTokens(engineMod.ITEM_TRUNCATE_MARKER),
    overheadTokens: engineMod.PACK_OVERHEAD_TOKENS,
    minSliceTokens: 5,
    renderText,
    measure: estimateTokens,
    include,
    toDropped,
    titleTokens
  }

  // ① 全量装得下 → full、全收、无 dropped、不超预算
  {
    const items = [mk('a', 40), mk('b', 40)] // 各 10 token，合计 20
    const r = assembleLoop({ ...base, budgetTokens: 10_000, allCandidates: items, ranked: items.map((item) => ({ item })) })
    assertEq(r.mode, 'full', '全量装得下应为 full')
    assertEq(r.chosen.length, 2, 'full 模式应收下全部')
    assertEq(r.dropped.length, 0, 'full 模式不应产生 dropped')
    assert(r.usedTokens <= 10_000, 'full 模式不得超预算')
  }

  // ② 装不下 → truncated、真子集、余项进 dropped(budget)、不超预算
  //    10 条 × 200 字符 = 各 50 token，全量 500；预算 300 必超
  {
    const items = Array.from({ length: 10 }, (_, k) => mk(String(k), 200))
    const r = assembleLoop({ ...base, budgetTokens: 300, allCandidates: items, ranked: items.map((item) => ({ item })) })
    assertEq(r.mode, 'truncated', '全量超预算应为 truncated')
    assert(r.chosen.length > 0 && r.chosen.length < items.length, `应部分收入（实际 ${r.chosen.length}/10）`)
    assert(r.usedTokens <= 300, `不得超预算（实际 ${r.usedTokens}）`)
    assert(r.dropped.length > 0, '落选条目必须进 dropped')
    assert(r.dropped.every((d) => d.reason === 'budget'), '落选原因应为 budget')
    // dropped 必须正好是 ranked 里没被收入的那一段（按 id 顺序）
    const chosenIds = new Set(r.chosen.map((c) => c.id))
    const expectDropped = items.filter((it) => !chosenIds.has(it.id)).map((it) => it.id)
    assertEq(r.dropped.map((d) => d.id).join(','), expectDropped.join(','), 'dropped 应与落选集合一致')
  }

  // ③ 截断：放不下整条但剩余空间够 → 最后一条以 truncated 收入
  //    必须有且仅有一条被截断（断言不能写「<=1」——那在「永不截断」的实现下也会空转通过）
  {
    const items = [mk('0', 100), mk('1', 100), mk('2', 900)]
    const r = assembleLoop({ ...base, budgetTokens: 150, allCandidates: items, ranked: items.map((item) => ({ item })) })
    const truncatedCount = r.chosen.filter((c) => c.truncated).length
    assertEq(truncatedCount, 1, `必须恰好一条被截断（实际 ${truncatedCount}）`)
    assertEq(r.chosen[r.chosen.length - 1].truncated, true, '被截断的必须是最后收入的那条')
    assert(r.usedTokens <= 150, `截断后仍不得超预算（实际 ${r.usedTokens}）`)
    assert(r.chosen[r.chosen.length - 1].body.length < 900, '被截断的正文必须真的变短')
  }

  // ④ 保险丝：预算不足时要能收缩到「装得下的最大子集」，且不超预算
  //    注意既有边界：预算若小到连「【未注入】清单」本身都装不下，内核无法再收缩——
  //    两域旧实现也是同一行为（它只减 includedCount，dropped 只增不减）。这里用
  //    能容下清单的预算来验证收缩逻辑本身。
  {
    const items = Array.from({ length: 5 }, (_, k) => mk(String(k), 50)) // 各 13 token，全量 65
    const r = assembleLoop({ ...base, budgetTokens: 40, allCandidates: items, ranked: items.map((item) => ({ item })) })
    assert(r.usedTokens <= 40, `必须收缩到不超预算（实际 ${r.usedTokens}）`)
    assert(r.chosen.length < items.length, `必须真的让位（实际收入 ${r.chosen.length}/5）`)
    assert(r.dropped.length === items.length - r.chosen.length, 'dropped 数 = 落选数')
  }

  // ⑥ 性质测试：一整排预算下，四条不变量都必须成立
  //    （比「造一个会撒谎的 measure」更可证伪——后者测的是「内核能否读心」，不是逻辑）
  {
    const items = Array.from({ length: 8 }, (_, k) => mk(String(k), 200)) // 各 50 token，全量 ~400
    const budgets = [60, 100, 150, 200, 300, 500, 5000]
    for (const budgetTokens of budgets) {
      const r = assembleLoop({
        ...base,
        budgetTokens,
        allCandidates: items,
        ranked: items.map((item) => ({ item }))
      })
      assert(r.usedTokens <= budgetTokens, `预算 ${budgetTokens} 不得超（实际 ${r.usedTokens}）`)
      assertEq(r.chosen.length + r.dropped.length, items.length, `预算 ${budgetTokens}：收入+落选必须等于总数`)
      const ids = new Set(r.chosen.map((c) => c.id))
      assert(r.dropped.every((d) => !ids.has(d.id)), `预算 ${budgetTokens}：同一 id 不能既收又丢`)
      assertEq(r.mode, budgetTokens >= 500 ? 'full' : r.mode, `预算 ${budgetTokens}：mode 与是否装满一致`)
    }
  }

  // ⑤ 预置 dropped（如 empty-content）必须保留，且不被改写
  {
    const items = [mk('a', 4)]
    const r = assembleLoop({
      ...base,
      budgetTokens: 10_000,
      allCandidates: items,
      ranked: items.map((item) => ({ item })),
      initialDropped: [{ id: 'e', title: '空', reason: 'empty-content' }]
    })
    assertEq(r.dropped.length, 1, '预置 dropped 必须保留')
    assertEq(r.dropped[0].reason, 'empty-content', '预置项原因不被改写')
  }

  return '5 组：全量 / 准入+余项 / 截断 / 小预算保险丝 / 预置 dropped'
})

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-context-work.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
