// test/openclaw-summary.accept.mjs —— OpenClaw 当日总结（v0.18 桥接式）验收
//
// 打真实源码：真 DatabaseClient / db-worker / RecordManager / ReminderManager，
// 注入假 gateway（createChatStream）。**不碰 OpenClaw 内部库**——这正是 v0.18 的改判：
// 总结内容来自 OpenClaw 自己，本套件只验「桥接 → 解析 → 落候选 → 调度」这条链。
//
// 覆盖点：
//   - 开关默认关 / 持久化跨实例
//   - 总结 → 候选落库（内容 / outputType / occurred_date=被总结那天）
//   - 「（无）」及其散文变体 → 0 候选、empty=true、不抛错
//   - 空响应 / 无法识别 → 抛 OPENCLAW_INVALID_OUTPUT（绝不把空响应当「明确无」）
//   - 同日重复触发 → 已提议集合挡住，不产生重复候选；措辞变化 → 新内容仍入候选
//   - 与已确认记录重复 → 质量门槛 filtered 计数
//   - runScheduled：关着 disabled / 当天已成功 done / 失败 error+计数 /
//     间隔不足 retry-wait / 耗尽 attempts-exhausted
//   - 手动不受自动预算约束，且成功后不占掉当天的自动轮次
//   - ReminderManager 集成：日报时刻前 30 分钟窗口内触发、窗口外不触发、
//     终态只跑一次、error 下一轮重试
//   - 并发：手动撞上在途自动轮 → 只调一次模型
//
// 用法：node test/openclaw-summary.accept.mjs（npm run accept:openclaw-summary）

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
  writeJson
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, 'openclaw-summary-' + Date.now())
const dataDir = join(runDir, 'data')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'work.db')
const backupDir = join(dataDir, 'backup')

const { DatabaseClient } = await import(
  pathToFileURL(bundleEntry('electron/main/database/database.ts', 'os-database.mjs')).href
)
const { createRecordManager } = await import(
  pathToFileURL(bundleEntry('electron/main/work/recordManager.ts', 'os-record.mjs')).href
)
const summaryMod = await import(
  pathToFileURL(bundleEntry('electron/main/work/openclawSummaryManager.ts', 'os-summary.mjs')).href
)
const reminderMod = await import(
  pathToFileURL(bundleEntry('electron/main/work/reminderManager.ts', 'os-reminder.mjs')).href
)
const { createOpenClawSummaryManager, MAX_AUTO_ATTEMPTS_PER_DAY, AUTO_RETRY_GAP_MS } = summaryMod
const { createReminderManager, SUMMARY_LEAD_MS } = reminderMod

const database = new DatabaseClient({
  dbPath,
  backupDir,
  workerScriptPath: join(__dirname, '..', 'resources', 'database', 'db-worker.mjs'),
  nodePath,
  subprocessName: 'os-db-worker'
})
const records = createRecordManager({ database })

const pad = (n) => String(n).padStart(2, '0')
const fmtDate = (ts) => {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const TODAY = fmtDate(Date.now())

/** 假 gateway：createChatStream 返回固定文本（计调用次数） */
function fakeGateway(text) {
  const gw = {
    calls: 0,
    createChatStream(input) {
      gw.calls += 1
      gw.lastInput = input
      return {
        result: Promise.resolve({ text, chunks: 1, usage: null, model: 'fake', aborted: false, ms: 1 }),
        cancel() {},
        iterator: (async function* () {})()
      }
    }
  }
  return gw
}

/** 按调用次序返回不同文本的假 gateway */
function sequenceGateway(outputs) {
  const gw = fakeGateway('')
  const seen = []
  gw.createChatStream = () => {
    const text = outputs[seen.length] ?? outputs[outputs.length - 1]
    seen.push(text)
    gw.calls += 1
    return {
      result: Promise.resolve({ text, chunks: 1, usage: null, model: 'fake', aborted: false, ms: 1 }),
      cancel() {},
      iterator: (async function* () {})()
    }
  }
  gw.seen = seen
  return gw
}

/** 抛错的假 gateway（模拟网关未就绪 / token 过期） */
function throwingGateway(message) {
  return {
    calls: 0,
    createChatStream() {
      this.calls += 1
      return { result: Promise.reject(new Error(message)), cancel() {}, iterator: (async function* () {})() }
    }
  }
}

function makeManager(gateway, opts = {}) {
  return createOpenClawSummaryManager({
    database,
    records,
    gateway,
    now: opts.now,
    ...opts
  })
}

const r = new Recorder('OpenClaw 当日总结（桥接式）验收')

try {
  await r.check('S1', '自动开关默认关', async () => {
    const m = makeManager(fakeGateway(''))
    assertEq(await m.isAutoEnabled(), false, '默认应为关（会调模型花钱，必须用户主动开）')
  })

  await r.check('S2', '开关持久化（跨实例读取）', async () => {
    const m = makeManager(fakeGateway(''))
    await m.setAutoEnabled(true)
    assertEq(await makeManager(fakeGateway('')).isAutoEnabled(), true, '新实例应读到开')
    await m.setAutoEnabled(false)
    assertEq(await makeManager(fakeGateway('')).isAutoEnabled(), false, '关闭后各实例同步')
  })

  await r.check('S3', '总结 → 候选落库（内容 / outputType / occurred_date）', async () => {
    const gw = fakeGateway('- 完成AI教学课第一课大纲\n- 与客户确认了回款计划')
    const m = makeManager(gw)
    const res = await m.summarizeToday('manual')
    assertEq(res.proposed, 2, '应落 2 条候选')
    assertEq(res.date, TODAY, '总结的是今天')
    assertEq(gw.calls, 1, '只调一次模型')
    assertEq(gw.lastInput.stream, true, '走流式（冷启动 80s，非流式 120s 硬超时太贴脸）')
    assert(
      String(gw.lastInput.conversationKey).startsWith('conv:work:summary:daily:' + TODAY),
      'conversationKey 按日固定前缀（被 :conv:work: 排除规则挡住，不会自我循环）'
    )
    const rows = await records.list({ status: 'candidate' })
    const mine = rows.filter((c) => c.content === '完成AI教学课第一课大纲')
    assertEq(mine.length, 1, '候选内容应正确')
    assertEq(mine[0].occurred_date, TODAY, 'occurred_date = 被总结那天')
    assertEq(mine[0].source, 'ai_output', '来源必须是 ai_output（AI 产出默认是候选）')
    assert(
      String(mine[0].source_ref).includes('openclaw_summary'),
      'source_ref 应标 openclaw_summary 产出类型'
    )
  })

  await r.check('S4', '「（无）」与散文变体 → 0 候选、empty=true、不抛错', async () => {
    for (const text of ['（无）', '- （无）', '好的，分析如下：\n- （无）', '- 无。', '- 暂无可记录内容']) {
      const gw = fakeGateway(text)
      const m = makeManager(gw)
      const res = await m.summarizeToday('manual')
      assertEq(res.proposed, 0, text + ' → 0 候选')
      assertEq(res.empty, true, text + ' → empty=true')
      assertEq(res.candidateIds.length, 0, text + ' → 不带 id')
    }
    const rows = await records.list({ status: 'candidate' })
    assert(
      !rows.some((c) => String(c.content).includes('无可记录') || c.content === '无。' || c.content === '（无）'),
      '「无内容」变体绝不能成为候选'
    )
  })

  await r.check('S5', '空响应 → 抛 OPENCLAW_INVALID_OUTPUT（不当「明确无」）', async () => {
    const m = makeManager(fakeGateway(''))
    let threw = null
    try {
      await m.summarizeToday('manual')
    } catch (e) {
      threw = e
    }
    assert(threw, '空响应应抛错')
    assertEq(threw.code, 'OPENCLAW_INVALID_OUTPUT', '错误码应为 OPENCLAW_INVALID_OUTPUT')
    assertEq(threw.details?.reason, 'empty-output', 'reason=empty-output')
  })

  await r.check('S6', '无法识别的散文 → 抛 OPENCLAW_INVALID_OUTPUT', async () => {
    const m = makeManager(fakeGateway('抱歉，我没办法整理这些内容。'))
    let threw = null
    try {
      await m.summarizeToday('manual')
    } catch (e) {
      threw = e
    }
    assert(threw, '无法识别应抛错')
    assertEq(threw.code, 'OPENCLAW_INVALID_OUTPUT', '错误码应为 OPENCLAW_INVALID_OUTPUT')
    assertEq(threw.details?.reason, 'unparseable-output', 'reason=unparseable-output')
  })

  await r.check('S7', '同日重复触发 → 已提议集合挡住，不产生重复候选', async () => {
    const DB7 = 's7'
    const content = '推进了知识库检索优化'
    const m = makeManager(fakeGateway('- ' + content))
    const first = await m.summarizeToday('manual')
    assertEq(first.proposed, 1, '首次新增 1 条')
    // 同一天再触发（自动轮次 / 用户又点了一次）：内容相同 → 全被挡住
    const second = await makeManager(fakeGateway('- ' + content)).summarizeToday('manual')
    assertEq(second.proposed, 0, '重复触发不应再新增')
    assertEq(second.duplicates, 1, 'duplicates=1')
    const rows = await records.list({ status: 'candidate' })
    assertEq(
      rows.filter((c) => c.content === content).length,
      1,
      '同一条内容只有一条候选（DB7=' + DB7 + '）'
    )
  })

  await r.check('S8', '同日措辞变化 → 新内容入候选，旧的不重复', async () => {
    const m1 = makeManager(fakeGateway('- 完成方案初稿'))
    const a = await m1.summarizeToday('manual')
    assertEq(a.proposed, 1, '首次 1 条')
    const m2 = makeManager(fakeGateway('- 完成方案初稿\n- 评审了预算表'))
    const b = await m2.summarizeToday('manual')
    assertEq(b.proposed, 1, '只有新增的那条入候选')
    assertEq(b.duplicates, 1, '旧那条按内容哈希挡住')
    const rows = await records.list({ status: 'candidate' })
    assertEq(rows.filter((c) => c.content === '完成方案初稿').length, 1, '旧内容不重复')
    assert(rows.some((c) => c.content === '评审了预算表'), '新内容应入候选')
  })

  await r.check('S9', '与已确认记录重复 → 质量门槛挡下并计数', async () => {
    await records.create({ content: '已经确认过的工作内容' })
    const m = makeManager(fakeGateway('- 已经确认过的工作内容'))
    const res = await m.summarizeToday('manual')
    assertEq(res.proposed, 0, '不入候选')
    assertEq(res.filtered, 1, 'filtered=1（留痕在「已过滤」，不静默丢）')
  })

  await r.check('S10', 'runScheduled：开关关 → skipped(disabled)，不调模型', async () => {
    const gw = fakeGateway('- 不该被调用')
    const m = makeManager(gw)
    const res = await m.runScheduled()
    assertEq(res.status, 'skipped', '应跳过')
    assertEq(res.reason, 'disabled', 'reason=disabled')
    assertEq(gw.calls, 0, '关着绝不调模型')
  })

  await r.check('S11', 'runScheduled：自动成功一次后当天不再自动跑', async () => {
    await database.metaSet('openclaw_summary_auto', '1')
    await database.metaSet('openclaw_summary_state', '0')
    const gw = sequenceGateway(['- 自动总结的工作甲', '- 自动总结的工作乙'])
    const m = makeManager(gw)
    const first = await m.runScheduled()
    assertEq(first.status, 'done', '首次应完成')
    assertEq(first.proposed, 1, '新增 1 条')
    const second = await m.runScheduled()
    assertEq(second.status, 'skipped', '第二次应跳过')
    assertEq(second.reason, 'done', 'reason=done')
    assertEq(gw.calls, 1, '当天只调一次模型')
    const status = await m.getStatus()
    assertEq(status.autoDone, true, '状态里 autoDone=true')
    assertEq(status.enabled, true, '状态里 enabled=true')
  })

  await r.check('S12', 'runScheduled：失败计数 + 最小间隔 + 耗尽后停手', async () => {
    await database.metaSet('openclaw_summary_state', '0')
    let clock = Date.now()
    const gw = throwingGateway('网关未就绪')
    const m = makeManager(gw, { now: () => clock })
    const a = await m.runScheduled()
    assertEq(a.status, 'error', '失败应返回 error（provider 永不抛错）')
    assertEq(a.message, '网关未就绪', '原始错误透出')
    assertEq((await m.getStatus()).attempts, 1, 'attempts=1')
    // 间隔不足 → retry-wait（不撞网关）
    clock += 60_000
    const b = await m.runScheduled()
    assertEq(b.status, 'skipped', '间隔不足应跳过')
    assertEq(b.reason, 'retry-wait', 'reason=retry-wait')
    assertEq(gw.calls, 1, '间隔内不得再调模型')
    // 过了最小间隔 → 再试；直到耗尽
    for (let i = 0; i < MAX_AUTO_ATTEMPTS_PER_DAY; i++) {
      clock += AUTO_RETRY_GAP_MS + 1000
      await m.runScheduled()
    }
    assertEq(gw.calls, MAX_AUTO_ATTEMPTS_PER_DAY, '当天最多试 ' + MAX_AUTO_ATTEMPTS_PER_DAY + ' 次')
    const exhausted = await m.runScheduled()
    assertEq(exhausted.status, 'skipped', '耗尽后跳过')
    assertEq(exhausted.reason, 'attempts-exhausted', 'reason=attempts-exhausted')
    const st = await m.getStatus()
    assertEq(st.lastStatus, 'error', '状态里留着最近一次失败')
    assert(st.lastMessage && st.lastMessage.length > 0, '状态里留着失败原因（UI 要点名）')
  })

  await r.check('S13', '手动不受自动预算约束，且不占掉当天自动轮次', async () => {
    // 承接 S12：attempts 已耗尽
    const before = await database.metaGet('openclaw_summary_state')
    assert(JSON.parse(before).attempts >= MAX_AUTO_ATTEMPTS_PER_DAY, '前置：自动预算已耗尽')
    const gw = fakeGateway('- 手动救回来的工作')
    const m = makeManager(gw)
    const res = await m.summarizeToday('manual')
    assertEq(res.proposed, 1, '手动照样能跑成功')
    const st = await m.getStatus()
    assertEq(st.autoDone, false, '手动成功不占自动轮次（到点那次仍会跑，补下午的工作）')
    assertEq(st.lastTrigger, 'manual', '状态记录最近一次是手动')
    assertEq(st.lastStatus, 'done', '状态记录成功')
    await database.metaSet('openclaw_summary_auto', '0')
    await database.metaSet('openclaw_summary_state', '0')
  })

  await r.check('S14', 'ReminderManager：日报时刻前 30 分钟窗口触发，终态只跑一次', async () => {
    assertEq(SUMMARY_LEAD_MS, 30 * 60_000, '提前量应是 30 分钟')
    // 关掉两个固定提醒，隔离出总结这条路径
    const reminder0 = createReminderManager({
      database,
      notifier: () => {},
      getMorningSummary: async () => ({ count: 0, titles: [] })
    })
    await reminder0.setEnabled('morning', false)
    await reminder0.setEnabled('report', false)
    const times = await reminder0.getTimes()
    const report = times.report

    const at = (h, m) => {
      const d = new Date()
      d.setHours(h, m, 0, 0)
      return d.getTime()
    }
    const build = (clock, provider) =>
      createReminderManager({
        database,
        notifier: () => {},
        getMorningSummary: async () => ({ count: 0, titles: [] }),
        summarizeDaily: provider,
        now: () => clock.t
      })

    // ① 窗口起点（日报时刻 - 30min）→ 触发一次；终态 done → 后续 check 不再调
    let calls = 0
    const provider = async () => {
      calls += 1
      return { status: 'done', date: TODAY, proposed: 3 }
    }
    const clock = { t: at(report.hour, report.minute) - SUMMARY_LEAD_MS }
    const rm = build(clock, provider)
    await rm.check()
    assertEq(calls, 1, '窗口起点应触发一次')
    await rm.check()
    await rm.check()
    assertEq(calls, 1, 'done 是终态：同一天不再重复调模型')

    // ② 窗口外（提前 31 分钟）→ 不触发
    let calls2 = 0
    const clock2 = { t: at(report.hour, report.minute) - SUMMARY_LEAD_MS - 60_000 }
    const rm2 = build(clock2, async () => {
      calls2 += 1
      return { status: 'done', date: TODAY, proposed: 0 }
    })
    await rm2.check()
    assertEq(calls2, 0, '窗口前不触发')

    // ③ 窗口右边界（日报时刻 + 30min）内仍触发；再晚就不补了
    let calls3 = 0
    const clock3 = { t: at(report.hour, report.minute) - SUMMARY_LEAD_MS + 60 * 60_000 }
    const rm3 = build(clock3, async () => {
      calls3 += 1
      return { status: 'done', date: TODAY, proposed: 0 }
    })
    await rm3.check()
    assertEq(calls3, 1, '窗口右边界（+60min 宽容度）仍应触发')
    let calls4 = 0
    const clock4 = { t: at(report.hour, report.minute) - SUMMARY_LEAD_MS + 61 * 60_000 }
    const rm4 = build(clock4, async () => {
      calls4 += 1
      return { status: 'done', date: TODAY, proposed: 0 }
    })
    await rm4.check()
    assertEq(calls4, 0, '过了窗口不补（补在草稿之后就失去确认窗口的意义）')

    // ④ provider 报 error → 释放占位，下一轮 check 重试
    let calls5 = 0
    const clock5 = { t: at(report.hour, report.minute) - SUMMARY_LEAD_MS }
    const rm5 = build(clock5, async () => {
      calls5 += 1
      return calls5 < 3 ? { status: 'error', message: '网关未就绪', date: TODAY } : { status: 'done', date: TODAY, proposed: 1 }
    })
    await rm5.check()
    await rm5.check()
    await rm5.check()
    assertEq(calls5, 3, 'error 非终态：后续 check 应继续重试直到成功')
  })

  await r.check('S15', '并发：手动撞上在途轮次 → 只调一次模型', async () => {
    let release = null
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    const gw = {
      createChatStream() {
        calls += 1
        return {
          result: gate.then(() => ({ text: '- 并发场景的工作', chunks: 1, usage: null, model: 'fake', aborted: false, ms: 1 })),
          cancel() {},
          iterator: (async function* () {})()
        }
      }
    }
    const m = makeManager(gw)
    const p1 = m.summarizeToday('manual')
    await sleep(30)
    const p2 = m.summarizeToday('manual')
    await sleep(30)
    assertEq(calls, 1, '在途时不得起第二轮')
    release()
    const [a, b] = await Promise.all([p1, p2])
    assert(a === b, '两次调用复用同一个结果对象')
    assertEq(calls, 1, '全程只调一次模型')
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  try {
    await database.dispose()
  } catch {
    /* 忽略 */
  }
  await sleep(200)
}

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-openclaw-summary.json'), result)

console.log('')
console.log('----- ' + result.suite + ': ' + result.passed + '/' + result.total + ' 通过，失败 ' + result.failed + ' -----')
process.exit(ok ? 0 : 1)
