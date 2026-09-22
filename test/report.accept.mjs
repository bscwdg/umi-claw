// test/report.accept.mjs —— Commit 06 验收：报告流（事实聚合 → AI 表达 → 冗余快照）
//
// **打真实源码**：真 DB Worker + 真 ContextEngine + 真 GatewayClient，
// GatewayClient 指向一个**假 HTTP 网关**（真 Node http，回真 SSE）。
//
// 覆盖（对齐 §2.4/§2.5/§七/§14）：
//   确定性事实聚合 aggregate（不调模型）：
//     A1 事项优先/无事项入 other；A2 分节序；A3 组内序（无时间在后）；
//     A7 周报去重（子串降级/跨日 ×N）；A8 focus(≥3)；A9 只统计 confirmed；A10 按 occurred_date
//   生成 generate：SSE 产出落 immutable generation（inputs 副本 + snapshot + prompt + content）
//   重生成 regenerate：追加 generation（不覆盖；current 指针推进）
//   A4 0 条 → VALIDATION_ERROR（不调模型）
//   saveDraft / confirm；get.versions 可回看
//
// 用法：node test/report.accept.mjs（npm run accept:report）

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
const runDir = join(tmpDir, `report-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

// ── bundle 真源码 ──
const dbB = bundleEntry('electron/main/database/database.ts', 'rep-database.mjs')
const gwB = bundleEntry('electron/main/gatewayClient.ts', 'rep-gateway.mjs')
const engineB = bundleEntry('electron/main/work/contextEngine.ts', 'rep-engine.mjs')
const reportB = bundleEntry('electron/main/work/reportManager.ts', 'rep-report.mjs')

const dbMod = await import(pathToFileURL(dbB).href)
const gwMod = await import(pathToFileURL(gwB).href)
const engineMod = await import(pathToFileURL(engineB).href)
const reportMod = await import(pathToFileURL(reportB).href)

const { DatabaseClient } = dbMod
const { createGatewayClient, GATEWAY_ENDPOINTS } = gwMod
const { createContextEngine } = engineMod
const { createReportManager, periodWindow, isoWeek } = reportMod

const logger = () => {}
const r = new Recorder('Commit 06 · 报告流')
let database = null
const fakeGate = []

async function outcome(p) {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return { ok: false, code: e?.code, message: e?.message || String(e), details: e?.details }
  }
}

/** 假网关：/health /v1/models 200；chat SSE 回 片1..片N */
function fakeGateway(chunkCount = 6) {
  const state = { chatRequests: 0, chunkCount }
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    let raw = ''
    for await (const c of req) raw += c
    if (url.startsWith(GATEWAY_ENDPOINTS.health)) {
      res.writeHead(200).end(JSON.stringify({ ok: true }))
      return
    }
    if (url.startsWith(GATEWAY_ENDPOINTS.models)) {
      res.writeHead(200).end(JSON.stringify({ object: 'list', data: [{ id: 'openclaw' }] }))
      return
    }
    if (url.startsWith(GATEWAY_ENDPOINTS.chatCompletions)) {
      state.chatRequests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 1; i <= state.chunkCount; i++) {
        res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: `片${i}` } }] })}\n\n`)
        await sleep(1)
      }
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
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      await new Promise((r) => server.close(r))
    }
  }
}

try {
  await r.check('P0', '前置：真 Worker/建库/8 表', async () => {
    database = new DatabaseClient({
      dbPath,
      backupDir,
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker-commit06',
      requestTimeoutMs: 30_000,
      logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'ready')
    assertEq(st.tables.length, 8, '8 表')
    return `pid=${st.workerPid}`
  })

  // 假网关 + 真 client
  const gate = fakeGateway(6)
  fakeGate.push(gate)
  const baseUrl = await gate.listen()
  const gateway = createGatewayClient({
    baseUrl,
    token: 'test-token',
    logger,
    sleepImpl: async () => {}
  })
  const engine = createContextEngine({ database, logger })
  const reports = createReportManager({ database, contextEngine: engine, gateway, logger })

  // ── 造 confirmed 记录（2026-09-23 当天 + 一事项）──
  await r.check('P1', '造数据：事项 + 当天 confirmed 记录 3 条（含无时间）+ 1 candidate', async () => {
    await database.request('matters.create', {
      data: { id: 'm1', name: 'Q3活动', status: 'active', color: '#F59E0B', created_at: 1, updated_at: 1 }
    })
    const mk = (id, content, time, date = '2026-09-23', matter = 'm1') =>
      database.request('activity_log.create', {
        data: {
          id, content, occurred_date: date, occurred_time: time, source: 'manual',
          status: 'confirmed', matter_id: matter, created_at: 1, updated_at: 1
        }
      })
    await mk('r1', '完成活动方案初稿', '09:00')
    await mk('r2', '推进方案评审', null) // 无时间
    await mk('r3', '同步给团队', '15:00')
    // candidate：不应进聚合
    await database.request('activity_log.create', {
      data: {
        id: 'r4', content: '未确认的事', occurred_date: '2026-09-23',
        source: 'ai_output', status: 'candidate', created_at: 1, updated_at: 1
      }
    })
    return '记录就绪'
  })

  // ── 确定性聚合 ──
  await r.check('P2', 'daily 聚合：A1 事项分组；A3 组内序（无时间在后）；A9 candidate 不入统计', async () => {
    const { aggregation, factSheet } = await reports.aggregate('daily', '2026-09-23')
    assertEq(aggregation.empty, false, '非空')
    assertEq(aggregation.stats.total, 3, '只统计 confirmed（candidate 不入）')
    assertEq(aggregation.sections.length, 1, '1 个事项组')
    assertEq(aggregation.sections[0].matter_name, 'Q3活动', '事项名')
    // A3：组内 09:00 → 15:00 → 无时间（排最后）
    const items = aggregation.sections[0].items
    assertEq(items[0].time, '09:00', '最早在前')
    assertEq(items[1].time, '15:00', '其次')
    assertEq(items[2].time, null, '无时间排最后')
    assertEq(items[2].content, '推进方案评审', '无时间内容')
    assertEq(aggregation.stats.time_missing, 1, '1 条缺时间')
    assert(factSheet.includes('Q3活动'), '事实清单含事项')
    assert(factSheet.includes('时间未记'), '无时间标「时间未记」')
    assert(!factSheet.includes('未确认的事'), '事实清单不含 candidate')
    return 'A1/A3/A9 生效'
  })

  await r.check('P3', 'A2 分节序 + other：无事项记录入 other 且恒在最后', async () => {
    // 加第二事项 + other 记录
    await database.request('matters.create', {
      data: { id: 'm2', name: '招聘', status: 'active', color: '#10B981', created_at: 1, updated_at: 1 }
    })
    await database.request('activity_log.create', {
      data: {
        id: 'r5', content: '筛简历', occurred_date: '2026-09-23', occurred_time: '10:00',
        source: 'manual', status: 'confirmed', matter_id: 'm2', created_at: 1, updated_at: 1
      }
    })
    await database.request('activity_log.create', {
      data: {
        id: 'r6', content: '处理杂事', occurred_date: '2026-09-23', occurred_time: '11:00',
        source: 'manual', status: 'confirmed', matter_id: null, created_at: 1, updated_at: 1
      }
    })
    const { aggregation } = await reports.aggregate('daily', '2026-09-23')
    assertEq(aggregation.sections.length, 2, '2 个事项组')
    assertEq(aggregation.other.items.length, 1, 'other 1 条')
    assertEq(aggregation.other.items[0].content, '处理杂事', 'other 内容')
    assertEq(aggregation.stats.total, 5, '5 条 confirmed')
    // factSheet 顺序里 other 最后由渲染保证；这里验 sections 不含 other
    assert(aggregation.sections.every((s) => s.matter_id !== null), 'sections 都是事项组')
    return 'A2 + other 生效'
  })

  await r.check('P4', 'A8 focus：同事项 ≥3 条 → is_focus=true 并排前；纯计数', async () => {
    const { aggregation } = await reports.aggregate('daily', '2026-09-23')
    const m1 = aggregation.sections.find((s) => s.matter_id === 'm1')
    const m2 = aggregation.sections.find((s) => s.matter_id === 'm2')
    assertEq(m1.items.length, 3, 'm1 有 3 条')
    assertEq(m1.is_focus, true, '≥3 → focus')
    assertEq(m2.is_focus, false, 'm2 仅1条 非focus')
    // focus 排最前
    assertEq(aggregation.sections[0].matter_id, 'm1', 'focus 组在最前')
    return 'A8 focus 生效'
  })

  // ── A7 周报去重 ──
  await r.check('P5', 'A7 周报去重：跨日完全同文本 ×N；子串降级为进展', async () => {
    // 本周（2026-09-21~27）造重复记录
    const wm = (id, content, date, time) =>
      database.request('activity_log.create', {
        data: {
          id, content, occurred_date: date, occurred_time: time, source: 'manual',
          status: 'confirmed', matter_id: 'm2', created_at: 1, updated_at: 1
        }
      })
    await wm('w1', '每日站会同步', '2026-09-21', '09:00')
    await wm('w2', '每日站会同步', '2026-09-22', '09:00') // 完全同文本
    await wm('w3', '完成每日站会同步并复盘', '2026-09-23', '09:30') // 包含上者
    const week = isoWeek('2026-09-23')
    const { aggregation } = await reports.aggregate('weekly', week)
    const m2 = aggregation.sections.find((s) => s.matter_id === 'm2')
    assert(m2, 'm2 周组存在')
    // 找「每日站会同步」
    const base = m2.items.find((it) => it.content === '每日站会同步')
    assert(base, '保留一条基础记录')
    assertEq(base.repeatCount, 2, '跨日完全同文本 → ×2')
    // 包含它的较晚记录降级为进展
    const prog = m2.items.find((it) => it.content === '完成每日站会同步并复盘')
    assert(prog, '包含记录存在')
    assertEq(prog.isProgress, true, '子串关系 → 降级进展')
    return 'A7 周报去重生效'
  })

  await r.check('P6', '周期窗口：daily 当天；weekly 周一到周日（ISO）', async () => {
    const d = periodWindow('daily', '2026-09-23')
    assertEq(d.start, '2026-09-23', 'daily start')
    assertEq(d.end, '2026-09-23', 'daily end')
    const week = isoWeek('2026-09-23')
    assertEq(week, '2026-W39', '2026-09-23 是 2026-W39')
    const w = periodWindow('weekly', week)
    assertEq(w.start, '2026-09-21', 'W39 周一 09-21')
    assertEq(w.end, '2026-09-27', 'W39 周日 09-27')
    return '周期窗口正确'
  })

  // ── 生成（SSE → immutable generation）──
  let reportId = null
  await r.check('P7', 'generate：SSE 产出落 immutable generation（content=片1..片6）', async () => {
    const handle = await reports.generate({ type: 'daily', period: '2026-09-23' })
    assert(handle.runId, '返回 runId')
    assert(handle.version >= 1, 'version')
    reportId = handle.reportId
    // 消费流
    const deltas = []
    for await (const d of handle.stream.iterator) deltas.push(d)
    const res = await handle.stream.result
    assertEq(res.aborted, false, '正常完成')
    assertEq(res.text, '片1片2片3片4片5片6', '拼接产出')
    // 等异步 finishRun 落库
    await sleep(200)
    const detail = await reports.get(reportId)
    assertEq(detail.versions.length, 1, '落了 1 个 generation')
    assertEq(detail.versions[0].content, '片1片2片3片4片5片6', 'generation content 是 AI 原文')
    assertEq(detail.content, '片1片2片3片4片5片6', 'reports.content 工作副本同步')
    assertEq(detail.versions[0].model, 'openclaw', '记录 model')
    return 'generation 落库 ✓'
  })

  await r.check('P8', 'generation 是冗余快照：inputs 副本 + memory_snapshot + prompt（§7.1）', async () => {
    const raw = await database.request('reports.get', { keys: { id: reportId } })
    const ctx = JSON.parse(raw.generation_context)
    assertEq(ctx.current, 1, 'current=1')
    const g = ctx.generations[0]
    assert(Array.isArray(g.inputs) && g.inputs.length >= 3, 'inputs 冗余全量副本')
    assert(g.memory_snapshot, '含 memory_snapshot')
    assert(typeof g.prompt === 'string' && g.prompt.includes('事实清单'), '含当时 prompt')
    assert(g.contextSnapshot, '含 contextSnapshot（供 context.snapshot report）')
    return '冗余快照完整 ✓'
  })

  await r.check('P9', 'regenerate：追加新 generation（不覆盖；current 推进；旧版本可回看）', async () => {
    const handle = await reports.regenerate(reportId)
    await handle.stream.result
    await sleep(200)
    const detail = await reports.get(reportId)
    assertEq(detail.versions.length, 2, '追加为 2 个 generation')
    assertEq(detail.versions[0].version, 1, 'v1 仍在（不覆盖）')
    assertEq(detail.versions[1].version, 2, 'v2 新增')
    const raw = JSON.parse(detail.generation_context)
    assertEq(raw.current, 2, 'current 指针 → 2')
    return 'append-only 重生成 ✓'
  })

  await r.check('P10', 'saveDraft 改工作副本（不动 generation）；confirm → confirmed', async () => {
    await reports.saveDraft(reportId, '用户自己改过的正文')
    const detail = await reports.get(reportId)
    assertEq(detail.content, '用户自己改过的正文', '工作副本更新')
    assertEq(detail.versions.length, 2, 'generation 数量不变（改稿不动快照）')
    assertEq(detail.versions[1].content, '片1片2片3片4片5片6', 'AI 原文仍在 generation')
    const confirmed = await reports.confirm(reportId)
    assertEq(confirmed.status, 'confirmed', '确认状态')
    return '工作副本与快照分离 ✓'
  })

  // ── A4 空记录 ──
  await r.check('P11', 'A4：0 条记录 → VALIDATION_ERROR（不调模型，不发 chat）', async () => {
    const before = gate.state.chatRequests
    const res = await outcome(reports.generate({ type: 'daily', period: '2026-09-30' }))
    assertEq(res.code, 'VALIDATION_ERROR', '空周期报错')
    assertEq(res.details?.reason, 'no-records', '原因可分支')
    assertEq(gate.state.chatRequests, before, '没有发 chat（不调模型）')
    // 但报告行已建（draft，空 content）
    const rows = await database.request('reports.list', { where: { period: '2026-09-30' } })
    assertEq(rows.length, 1, '报告行已建（draft）')
    return 'A4 不调模型 ✓'
  })

  await r.check('P12', 'A5 偏薄提示 + 非法周期校验', async () => {
    // 09-29 放 1 条 → thin
    await database.request('activity_log.create', {
      data: {
        id: 'thin1', content: '只做了一件小事', occurred_date: '2026-09-29',
        source: 'manual', status: 'confirmed', created_at: 1, updated_at: 1
      }
    })
    const { aggregation } = await reports.aggregate('daily', '2026-09-29')
    assertEq(aggregation.thin, true, '1 条 → thin')
    // 非法周报周期
    const bad = await outcome(reports.aggregate('weekly', '2026-09-23'))
    assertEq(bad.code, 'VALIDATION_ERROR', '周报需 YYYY-Www')
    const nf = await outcome(reports.get('ghost-report'))
    assertEq(nf.code, 'NOT_FOUND', 'get 不存在 → NOT_FOUND')
    return 'A5 + 校验 ✓'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const g of fakeGate) {
    try {
      await g.close()
    } catch {
      /* ignore */
    }
  }
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
writeJson(join(__dirname, 'accept-result-report.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
