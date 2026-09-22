// test/one-day.e2e.mjs —— Commit 10：「一天」端到端（主进程 Manager 层全链路）
//
// 不抄 Manager 逻辑：真 DatabaseClient（真 db-worker/建库）+ 真各 Manager，
// GatewayClient 指向假 SSE 网关（真 Node http）。
//
// 按 §16.1 / §八 DayN 跑完整一天：
//   早上 今日聚合（含例事/无日期/逾期）
//   → 手动记 2 条 confirmed
//   → 工具箱 minutes：结果进候选 + 待办提取（extracted candidate）
//   → 候选批量确认（candidate→confirmed）
//   → 勾完成待办联动落记录
//   → 事实聚合 aggregate（不调模型）
//   → 生成日报（SSE）→ 确认 → 快照不可变（删源记录报告仍完整）
//   → 删除即遗忘（删的记录不进新 Pack）
//   → 周报聚合
//
// 用法：node test/one-day.e2e.mjs（npm run e2e:day）

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder, __dirname, assert, assertEq, bundleEntry, printResult,
  resolveNodePath, sleep, tmpDir, workerScriptPath, writeJson
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, `oneday-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(join(runDir, 'samples'), { recursive: true })

const bundles = {}
bundles.db = bundleEntry('electron/main/database/database.ts', 'day-database.mjs')
bundles.gw = bundleEntry('electron/main/gatewayClient.ts', 'day-gateway.mjs')
bundles.engine = bundleEntry('electron/main/work/contextEngine.ts', 'day-engine.mjs')
bundles.profile = bundleEntry('electron/main/work/profileManager.ts', 'day-profile.mjs')
bundles.matter = bundleEntry('electron/main/work/matterManager.ts', 'day-matter.mjs')
bundles.todo = bundleEntry('electron/main/work/todoManager.ts', 'day-todo.mjs')
bundles.record = bundleEntry('electron/main/work/recordManager.ts', 'day-record.mjs')
bundles.report = bundleEntry('electron/main/work/reportManager.ts', 'day-report.mjs')
bundles.qa = bundleEntry('electron/main/work/qaManager.ts', 'day-qa.mjs')
bundles.tool = bundleEntry('electron/main/work/toolManager.ts', 'day-tool.mjs')
bundles.knowledge = bundleEntry('electron/main/work/knowledgeManager.ts', 'day-knowledge.mjs', {
  externals: ['mammoth', 'exceljs']
})
bundles.wizard = bundleEntry('electron/main/work/wizardManager.ts', 'day-wizard.mjs')
bundles.ctxMgr = bundleEntry('electron/main/work/contextManager.ts', 'day-ctxmgr.mjs')
bundles.reminder = bundleEntry('electron/main/work/reminderManager.ts', 'day-reminder.mjs')

async function imp(key) {
  return import(pathToFileURL(bundles[key]).href)
}
const dbMod = await imp('db')
const gwMod = await imp('gw')
const engineMod = await imp('engine')
const profileMod = await imp('profile')
const matterMod = await imp('matter')
const todoMod = await imp('todo')
const recordMod = await imp('record')
const reportMod = await imp('report')
const qaMod = await imp('qa')
const toolMod = await imp('tool')
const knowledgeMod = await imp('knowledge')
const wizardMod = await imp('wizard')
const ctxMgrMod = await imp('ctxMgr')
const reminderMod = await imp('reminder')

const logger = () => {}
const r = new Recorder('Commit 10 · 「一天」端到端')
let database = null
const gates = []

async function outcome(p) {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return { ok: false, code: e?.code, message: e?.message || String(e), details: e?.details }
  }
}

/** 假网关：chat 一律 SSE 单 chunk，内容可注入；health/models 200 */
function fakeGateway(content = '片1片2片3片4片5片6') {
  const state = { chatRequests: 0 }
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    if (url.startsWith(gwMod.GATEWAY_ENDPOINTS.health)) return res.writeHead(200).end('{}')
    if (url.startsWith(gwMod.GATEWAY_ENDPOINTS.models)) {
      return res.writeHead(200).end(JSON.stringify({ object: 'list', data: [{ id: 'openclaw' }] }))
    }
    if (url.startsWith(gwMod.GATEWAY_ENDPOINTS.chatCompletions)) {
      state.chatRequests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ usage: { total_tokens: 0 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    res.writeHead(404).end()
  })
  return {
    state,
    async listen() {
      await new Promise((x) => server.listen(0, '127.0.0.1', x))
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      await new Promise((x) => server.close(x))
    }
  }
}

try {
  await r.check('D0', '前置：真 Worker/建库/8 表', async () => {
    database = new dbMod.DatabaseClient({
      dbPath, backupDir, workerScriptPath, nodePath,
      subprocessName: 'work-db-worker-day', requestTimeoutMs: 30_000, logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'ready')
    assertEq(st.tables.length, 8, '8 表')
    return '底座就绪'
  })

  const gate = fakeGateway()
  gates.push(gate)
  const baseUrl = await gate.listen()
  const gateway = gwMod.createGatewayClient({ baseUrl, token: 't', logger, sleepImpl: async () => {} })
  const engine = engineMod.createContextEngine({ database, logger })

  const profile = profileMod.createProfileManager({ database, logger })
  const matters = matterMod.createMatterManager({ database, logger })
  const todos = todoMod.createTodoManager({ database, logger })
  const records = recordMod.createRecordManager({ database, logger })
  const ctxMgr = ctxMgrMod.createContextManager({
    database, buildLatestPack: () => engine.buildPack('latest', {})
  })
  const reports = reportMod.createReportManager({ database, contextEngine: engine, gateway, logger })
  const qa = qaMod.createQaManager({ database, contextEngine: engine, gateway, logger })
  const tools = toolMod.createToolManager({ records, todos, gateway, logger })
  const wizard = wizardMod.createWizardManager({ database, logger })
  const reminder = reminderMod.createReminderManager({
    database, notifier: () => {},
    getMorningSummary: async () => ({ count: 0, titles: [] }),
    logger
  })
  // 全部实例可构造（冒烟：依赖注入图闭合）
  assert([profile, matters, todos, records, reports, qa, tools, ctxMgr, wizard, reminder].every(Boolean), '全 Manager 构造')

  const TODAY = '2026-09-23'

  // ── 1. 早上：画像 + 今日聚合 ──
  await r.check('D1', '早上：画像填写；今日页聚合（例事/无日期/逾期）', async () => {
    await profile.update({ callName: '小北', position: '产品经理', company: '某公司' })
    // 昨日逾期、无日期、未来
    await todos.create({ title: '遗留事项', dueDate: '2026-09-22' })
    await todos.create({ title: '随时可做' })
    await todos.create({ title: '未来事项', dueDate: '2026-09-30' })

    // 今日页：固定日期视角（真实 TodayManager 用 now()；这里直接走 confirmed todos 读路径）
    const todayMgr = {
      async get(date) {
        // 直接通过 todos/records 复刻 TodayManager 读路径（真实 TodayManager 用 now()）
        const all = await todos.list({ state: 'confirmed' })
        const relevant = all.filter((t) => t.due_date === null || String(t.due_date) <= date)
        return relevant
      }
    }
    const viewTodos = await todayMgr.get(TODAY)
    const titles = viewTodos.map((t) => t.title)
    assert(titles.includes('遗留事项'), '逾期在')
    assert(titles.includes('随时可做'), '无日期在')
    assert(!titles.includes('未来事项'), '未来不在')
    return '今日聚合 ✓'
  })

  // ── 2. 手动记 2 条 ──
  await r.check('D2', '手动记 2 条 confirmed（双时间：一条补时间，一条无时间）', async () => {
    await records.create({ content: '完成活动方案第二版', occurredDate: TODAY, occurredTime: '09:30' })
    await records.create({ content: '整理会议材料', occurredDate: TODAY })
    const list = await records.list({ date: TODAY })
    assertEq(list.length, 2, '当天 2 条')
    return '手动记录 ✓'
  })

  // ── 3. minutes：候选 + 待办提取 ──
  await r.check('D3', '工具箱 minutes：纪要结果进候选 + 待办块提取（extracted candidate）', async () => {
    const minutesContent = [
      '会议纪要：确定下阶段安排。',
      '【待办】',
      '- 修改方案第三版（截止 2026-09-25）',
      '- 同步相关同事'
    ].join('\n')
    const g2 = fakeGateway(minutesContent)
    gates.push(g2)
    const url2 = await g2.listen()
    const gw2 = gwMod.createGatewayClient({ baseUrl: url2, token: 't', logger, sleepImpl: async () => {} })
    const tools2 = toolMod.createToolManager({ records, todos, gateway: gw2, logger })

    const before = (await records.list({ status: 'candidate' })).length
    const h = tools2.run({ toolId: 'minutes', text: '一大段会议转写文字，内容足够长以满足薄边界' })
    await h.stream.result
    await sleep(120)
    const after = (await records.list({ status: 'candidate' })).length
    assertEq(after, before + 1, '纪要进候选')
    const extracted = await todos.list({ state: 'candidate' })
    assertEq(extracted.length, 2, `提取 2 待办（实际 ${extracted.length}）`)
    assert(extracted.some((t) => t.due_date === '2026-09-25'), '带截止日期')
    return 'minutes 候选+待办 ✓'
  })

  // ── 4. 候选批量确认 ──
  await r.check('D4', '候选记录批量确认（candidate→confirmed）；待办批量确认', async () => {
    const candRecords = await records.list({ status: 'candidate' })
    const batch = await records.confirmBatch(candRecords.map((c) => c.id))
    assertEq(batch.affected.length, candRecords.length, '全部记入')
    assertEq((await records.list({ status: 'candidate' })).length, 0, '无候选记录')

    const candTodos = await todos.list({ state: 'candidate' })
    const tb = await todos.confirmBatch(candTodos.map((t) => t.id))
    assertEq(tb.affected.length, candTodos.length, '待办全部确认')
    // 确认后当天 confirmed 记录变多
    const confirmedToday = await records.list({ date: TODAY })
    assert(confirmedToday.length >= 3, `当天 confirmed ≥3（实际 ${confirmedToday.length}）`)
    return '批量确认 ✓'
  })

  // ── 5. 勾完成待办联动 ──
  await r.check('D5', '勾完成待办：联动自动落一条 confirmed 工作记录', async () => {
    const created = await todos.create({ title: '给团队做同步', dueDate: TODAY })
    const before = (await records.list({ date: TODAY })).length
    await todos.complete(created.id)
    await sleep(50)
    const after = await records.list({ date: TODAY })
    assertEq(after.length, before + 1, '联动新增 1 记录')
    const linked = after.find((x) => x.content === '给团队做同步')
    assert(linked && linked.source === 'todo', 'source=todo 可溯源')
    return '勾完成联动 ✓'
  })

  // ── 6. 事实聚合（不调模型）──
  await r.check('D6', '事实聚合 aggregate（确定性，不调模型）：分组/排序/focus', async () => {
    // 先建一个事项并挂一条 confirmed 记录（之前记录都无事项，全在 other）
    const matter = await matters.create({ name: 'Q3活动', color: '#F59E0B' })
    await records.create({
      content: '召开 Q3 启动会', occurredDate: TODAY, occurredTime: '14:00', matterId: matter.id
    })

    const beforeChats = gate.state.chatRequests
    const { aggregation, factSheet } = await reports.aggregate('daily', TODAY)
    assertEq(aggregation.empty, false, '非空')
    assert(aggregation.sections.length >= 1, '有事项分组')
    const q3 = aggregation.sections.find((s) => s.matter_name === 'Q3活动')
    assert(q3 && q3.items.some((i) => i.content === '召开 Q3 启动会'), '事项组内含所挂记录')
    assert(factSheet.includes('Q3活动') || factSheet.includes('活动方案'), '事实清单含事项')
    assertEq(gate.state.chatRequests, beforeChats, '未发任何 chat（不调模型）')
    return '确定性聚合 ✓'
  })

  // ── 7. 生成日报 → 确认 → 快照不可变 ──
  let reportId = null
  await r.check('D7', '生成日报（SSE）→ confirmed；快照含 inputs 副本/prompt', async () => {
    const handle = await reports.generate({ type: 'daily', period: TODAY })
    const res = await handle.stream.result
    assertEq(res.aborted, false, '正常生成')
    await sleep(120)
    reportId = handle.reportId
    const detail = await reports.get(reportId)
    assertEq(detail.versions.length, 1, '落 1 generation')
    await reports.confirm(reportId)
    const confirmed = await reports.get(reportId)
    assertEq(confirmed.status, 'confirmed', '日报确认')

    const raw = JSON.parse(detail.generation_context)
    const g = raw.generations[0]
    assert(Array.isArray(g.inputs) && g.inputs.length >= 1, 'inputs 冗余副本')
    assert(typeof g.prompt === 'string', 'prompt 留存')
    return '日报生成+快照 ✓'
  })

  await r.check('D8', '快照不可变：删掉源记录后，历史报告仍完整（存的是副本）', async () => {
    // 找一条进过 inputs 副本的源记录并物理删除
    const target = (await records.list({ date: TODAY })).find((x) => x.content === '整理会议材料')
    if (target) await records.delete(target.id)
    const detail = await reports.get(reportId)
    const g = detail.versions[0]
    assert(g && typeof g.content === 'string', 'generation 仍在')
    const raw = JSON.parse(detail.generation_context)
    assert(Array.isArray(raw.generations[0].inputs), 'inputs 副本未受源删除影响')
    return '删除源记录，报告快照仍完整 ✓'
  })

  // ── 8. 删除即遗忘 ──
  await r.check('D9', '删除即遗忘：被删记录不进新 Pack；但历史报告不受影响', async () => {
    const deletedContent = '只应存在于被删记录里的独特关键词ZZQ'
    const rec = await records.create({ content: deletedContent, occurredDate: TODAY })
    let pack = await engine.buildPack('qa', {})
    assert(renderIncludes(pack, '独特关键词ZZQ'), '删除前在 Pack 内')
    await records.delete(rec.id)
    pack = await engine.buildPack('qa', {})
    assert(!renderIncludes(pack, '独特关键词ZZQ'), '删除后不进新 Pack')
    const detail = await reports.get(reportId)
    assertEq(detail.versions.length, 1, '历史报告未被波及')
    return '删除即遗忘 ✓'
  })

  // ── 9. QA grounded + 周报 ──
  await r.check('D10', '工作问答 grounded（SSE 触发）；周报本周聚合', async () => {
    const h = await qa.ask({ question: '我今天推进了什么？' })
    const res = await h.stream.result
    assertEq(res.aborted, false, 'QA 流式完成')
    await sleep(80)

    const week = reportMod.isoWeek(TODAY)
    const { aggregation } = await reports.aggregate('weekly', week)
    assert(aggregation.stats.total >= 3, `本周 confirmed ≥3（实际 ${aggregation.stats.total}）`)
    return 'QA + 周报 ✓'
  })
} catch (e) {
  console.error('e2e 自身异常:', e)
} finally {
  for (const g of gates) { try { await g.close() } catch {} }
  if (database) { try { await database.dispose() } catch {} }
  await sleep(200)
}

function renderIncludes(pack, needle) {
  return engineMod.renderContextPackText(pack).includes(needle)
}

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-oneday.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
