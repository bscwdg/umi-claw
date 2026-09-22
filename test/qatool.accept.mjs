// test/qatool.accept.mjs —— Commit 07 验收：工作问答 + 工具箱
//
// **打真实源码**：真 DB Worker + 真 ContextEngine + 真 GatewayClient（指向假 SSE 网关），
// 真 QaManager / ToolManager。
//
// 覆盖（对齐 §十/§六/§2.2/§14）：
//   QA：
//     - ask 吃 qa Context Pack（近3天 confirmed），SSE 回答
//     - 空问题拒；runId 唯一
//     - 流结束落 assistant 行 + metadata.contextSnapshot（§14.1，供 context.snapshot qa）
//     - 闭环：context.snapshot({scope:qa, id:runId}) 能读回
//   Tools：
//     - list 六个工具（产出型/加工型标记）
//     - 加工型（polish/translate/summary/email_polish）：直接回文本，**不落候选、不落记录**
//     - 产出型 minutes：结果走候选（candidate）+ 待办块确定性提取（source=extracted candidate）
//     - 产出型 email_draft：走候选
//     - 薄边界：加工型无文本拒；未知工具拒；abortRun
//
// 用法：node test/qatool.accept.mjs（npm run accept:qatool）

import { createServer } from 'node:http'
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
const runDir = join(tmpDir, `qatool-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const dbB = bundleEntry('electron/main/database/database.ts', 'qt-database.mjs')
const gwB = bundleEntry('electron/main/gatewayClient.ts', 'qt-gateway.mjs')
const engineB = bundleEntry('electron/main/work/contextEngine.ts', 'qt-engine.mjs')
const recordB = bundleEntry('electron/main/work/recordManager.ts', 'qt-record.mjs')
const todoB = bundleEntry('electron/main/work/todoManager.ts', 'qt-todo.mjs')
const qaB = bundleEntry('electron/main/work/qaManager.ts', 'qt-qa.mjs')
const toolB = bundleEntry('electron/main/work/toolManager.ts', 'qt-tool.mjs')
const ctxB = bundleEntry('electron/main/work/contextManager.ts', 'qt-ctxmgr.mjs')

const { DatabaseClient } = await import(pathToFileURL(dbB).href)
const { createGatewayClient, GATEWAY_ENDPOINTS } = await import(pathToFileURL(gwB).href)
const { createContextEngine } = await import(pathToFileURL(engineB).href)
const { createRecordManager } = await import(pathToFileURL(recordB).href)
const { createTodoManager } = await import(pathToFileURL(todoB).href)
const { createQaManager } = await import(pathToFileURL(qaB).href)
const { createToolManager } = await import(pathToFileURL(toolB).href)
const { createContextManager } = await import(pathToFileURL(ctxB).href)

const logger = () => {}
const r = new Recorder('Commit 07 · 工作问答 + 工具箱')
let database = null
const gates = []

async function outcome(p) {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return { ok: false, code: e?.code, message: e?.message || String(e), details: e?.details }
  }
}

/** 假网关：chat SSE。可注入产出内容（minutes 待办块）；默认 片1..片6 */
function fakeGateway(opts = {}) {
  const state = { chatRequests: 0, bodies: [] }
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    let raw = ''
    for await (const c of req) raw += c
    if (url.startsWith(GATEWAY_ENDPOINTS.health)) return res.writeHead(200).end('{}')
    if (url.startsWith(GATEWAY_ENDPOINTS.models)) {
      return res.writeHead(200).end(JSON.stringify({ object: 'list', data: [{ id: 'openclaw' }] }))
    }
    if (url.startsWith(GATEWAY_ENDPOINTS.chatCompletions)) {
      state.chatRequests += 1
      let body = null
      try { body = JSON.parse(raw) } catch {}
      state.bodies.push(body)
      const content = opts.content ?? '片1片2片3片4片5片6'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 把 content 作为一个整 chunk 发（简化：单 delta）
      res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ usage: { total_tokens: 0 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
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
  await r.check('Q0', '前置：真 Worker/建库/8 表', async () => {
    database = new DatabaseClient({
      dbPath, backupDir, workerScriptPath, nodePath,
      subprocessName: 'work-db-worker-commit07', requestTimeoutMs: 30_000, logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'ready')
    assertEq(st.tables.length, 8, '8 表')
    return `pid=${st.workerPid}`
  })

  const gate = fakeGateway()
  gates.push(gate)
  const baseUrl = await gate.listen()
  const gateway = createGatewayClient({ baseUrl, token: 't', logger, sleepImpl: async () => {} })
  const engine = createContextEngine({ database, logger })
  const records = createRecordManager({ database, logger })
  const todos = createTodoManager({ database, logger })
  const qa = createQaManager({ database, contextEngine: engine, gateway, logger })
  const tools = createToolManager({ records, todos, gateway, logger })
  const ctxMgr = createContextManager({ database, buildLatestPack: () => engine.buildPack('latest', {}) })

  // 造 confirmed 记录（qa grounding）
  await r.check('Q1', '造数据：confirmed 记录（近3天）', async () => {
    await database.request('activity_log.create', {
      data: {
        id: 'g1', content: '完成活动方案', occurred_date: '2026-09-23', occurred_time: '09:00',
        source: 'manual', status: 'confirmed', created_at: 1, updated_at: 1
      }
    })
    return 'ok'
  })

  // ── QA ──
  let qaRunId = null
  await r.check('Q2', 'QA ask：吃 Pack，SSE 回答；空问题拒；runId 唯一', async () => {
    const empty = await outcome(qa.ask({ question: '  ' }))
    assertEq(empty.code, 'VALIDATION_ERROR', '空问题拒')
    const h = await qa.ask({ question: '我今天做了什么？' })
    assert(h.runId, 'runId')
    qaRunId = h.runId
    // system prompt 含 grounding（记录事实）
    await h.stream.result
    await sleep(150)
    // 两次 runId 不同
    const h2 = await qa.ask({ question: '再问一个' })
    assert(h2.runId !== qaRunId, 'runId 每次唯一')
    await h2.stream.result
    await sleep(150)
    // user + assistant 对话行都落了
    const rows = await database.request('conversations.list', { where: { conversation_key: 'conv:work:qa' } })
    const users = rows.filter((x) => x.role === 'user')
    const assistants = rows.filter((x) => x.role === 'assistant')
    assertEq(users.length, 2, '2 user 行')
    assertEq(assistants.length, 2, '2 assistant 行')
    return 'ask + 对话落库 ✓'
  })

  await r.check('Q3', 'QA 快照闭环（§14.1）：assistant metadata.contextSnapshot 可被 context.snapshot qa 读回', async () => {
    const view = await ctxMgr.snapshot({ scope: 'qa', id: qaRunId })
    assertEq(view.scope, 'qa', 'scope')
    assert(view.memory_snapshot, '含 memory_snapshot')
    assert(view.memory_snapshot.records.some((x) => x.content === '完成活动方案'), '快照含 grounding 记录')
    const ghost = await outcome(ctxMgr.snapshot({ scope: 'qa', id: 'run-ghost' }))
    assertEq(ghost.code, 'NOT_FOUND', '无快照 NOT_FOUND')
    const noId = await outcome(ctxMgr.snapshot({ scope: 'qa' }))
    assertEq(noId.code, 'VALIDATION_ERROR', '缺 id VALIDATION_ERROR')
    return 'qa runId → 快照闭环 ✓'
  })

  // ── Tools: list ──
  await r.check('T1', 'tools.list：六个工具，产出型/加工型标记正确', async () => {
    const list = tools.list()
    assertEq(list.length, 6, '6 工具')
    const byId = Object.fromEntries(list.map((t) => [t.id, t]))
    assertEq(byId.minutes.kind, 'productive', 'minutes 产出型')
    assertEq(byId.email_draft.kind, 'productive', 'email_draft 产出型')
    assertEq(byId.polish.kind, 'processing', 'polish 加工型')
    assertEq(byId.translate.kind, 'processing', 'translate 加工型')
    assertEq(byId.summary.kind, 'processing', 'summary 加工型')
    assertEq(byId.email_polish.kind, 'processing', 'email_polish 加工型')
    assert(byId.minutes.needsSource, 'minutes 需素材')
    return '工具元数据 ✓'
  })

  // ── 加工型：不落候选/记录 ──
  await r.check('T2', '加工型 polish：直接回文本，不落候选、不落任何记录', async () => {
    const beforeCand = (await records.list({ status: 'candidate' })).length
    const beforeLogs = (await database.request('activity_log.list', {} )).length
    const h = tools.run({ toolId: 'polish', text: '一段需要润色的原文内容' })
    const res = await h.stream.result
    assertEq(res.aborted, false, '完成')
    await sleep(120)
    const afterCand = (await records.list({ status: 'candidate' })).length
    const afterLogs = (await database.request('activity_log.list', {} )).length
    assertEq(afterCand, beforeCand, '不产候选')
    assertEq(afterLogs, beforeLogs, '不新增任何记录行')
    return '加工型零落库 ✓'
  })

  await r.check('T3', '薄边界：加工型无文本拒；未知工具拒', async () => {
    // run() 同步抛错 → 包一层 Promise 让 outcome 能捕获
    const noText = await outcome(Promise.resolve().then(() => tools.run({ toolId: 'translate', text: '  ' })))
    assertEq(noText.code, 'VALIDATION_ERROR', 'translate 无文本拒')
    const unknown = await outcome(Promise.resolve().then(() => tools.run({ toolId: 'telekinesis', text: 'x内容' })))
    assertEq(unknown.code, 'VALIDATION_ERROR', '未知工具拒')
    const summaryNoText = await outcome(Promise.resolve().then(() => tools.run({ toolId: 'summary', text: '' })))
    assertEq(summaryNoText.code, 'VALIDATION_ERROR', 'summary 无文本拒')
    return '薄边界校验 ✓'
  })

  // ── 产出型 minutes：候选 + 待办提取 ──
  // 需要一个返回纪要+待办块的假网关
  await r.check('T4', 'minutes：结果走候选（candidate）+ 待办块确定性提取（extracted candidate）', async () => {
    const minutesContent = [
      '会议纪要：讨论了方案。',
      '【待办】',
      '- 修改方案第二版（截止 2026-09-25）',
      '- 同步给相关同事'
    ].join('\n')
    const g2 = fakeGateway({ content: minutesContent })
    gates.push(g2)
    const url2 = await g2.listen()
    const gw2 = createGatewayClient({ baseUrl: url2, token: 't', logger, sleepImpl: async () => {} })
    const tools2 = createToolManager({ records, todos, gateway: gw2, logger })

    const beforeCand = (await records.list({ status: 'candidate' })).length
    const h = tools2.run({ toolId: 'minutes', text: '一大段会议原始转写文字，内容足够长' })
    await h.stream.result
    await sleep(150)

    // 结果进候选
    const afterCand = (await records.list({ status: 'candidate' })).length
    assertEq(afterCand, beforeCand + 1, 'minutes 结果新增 1 候选')
    const cand = (await records.list({ status: 'candidate' })).find((c) => c.content.includes('会议纪要'))
    assert(cand, '候选是纪要内容')

    // 待办提取 2 条（source=extracted，state=candidate）
    const extractedTodos = await todos.list({ state: 'candidate' })
    assertEq(extractedTodos.length, 2, `提取 2 条待办（实际 ${extractedTodos.length}）`)
    const t1 = extractedTodos.find((t) => t.title.includes('修改方案'))
    const t2 = extractedTodos.find((t) => t.title.includes('同步给'))
    assert(t1 && t2, '两条待办标题正确')
    assertEq(t1.due_date, '2026-09-25', '第一条带截止日期')
    assertEq(t2.due_date, null, '第二条无日期')
    return 'minutes 候选 + 待办提取 ✓'
  })

  await r.check('T5', 'email_draft：结果走候选（产出型）', async () => {
    const g3 = fakeGateway({ content: '尊敬的同事：邮件正文……此致敬礼' })
    gates.push(g3)
    const url3 = await g3.listen()
    const gw3 = createGatewayClient({ baseUrl: url3, token: 't', logger, sleepImpl: async () => {} })
    const tools3 = createToolManager({ records, todos, gateway: gw3, logger })

    const before = (await records.list({ status: 'candidate' })).length
    const h = tools3.run({ toolId: 'email_draft', text: '邮件要点：汇报项目进展' })
    await h.stream.result
    await sleep(150)
    const after = (await records.list({ status: 'candidate' })).length
    assertEq(after, before + 1, 'email_draft 新增候选')
    return 'email_draft 候选 ✓'
  })

  await r.check('T6', 'abortRun 真断上游；IPC 静态核对（qa/tools 通道）', async () => {
    const h = tools.run({ toolId: 'polish', text: '一段待处理的原文内容xyz' })
    const r2 = await tools.abortRun(h.runId)
    assertEq(r2.aborted, true, 'abort 返回 true')
    const miss = await tools.abortRun('ghost-run')
    assertEq(miss.aborted, false, '未知 runId 不报错返回 false')
    return 'abort ✓'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const g of gates) { try { await g.close() } catch {} }
  if (database) { try { await database.dispose() } catch {} }
  await sleep(200)
}

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-qatool.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
