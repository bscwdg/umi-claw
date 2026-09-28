// test/openclaw-import.accept.mjs —— OpenClaw 使用记录 → 工作记录候选 验收
//
// 打真实源码：真 DatabaseClient / db-worker / RecordManager，注入假 reader / 假 gateway。
//
// 覆盖点：
//   - 自动开关默认关、持久化、跨 manager 实例读取
//   - 0 条新消息不调模型
//   - 有消息 → AI 条目落 candidate + 增量水位线推进
//   - 第二次扫描 reader 收到上次水位（只提炼新消息）
//   - AI 返回「（无）」→ 0 候选但水位仍推进
//   - 与 confirmed 重复 → 质量门槛挡下，filtered 计数
//   - 并发两次 importToday 只扫描一次
//   - reader 时钟统一 created_at：重启重写守卫（旧内嵌时间戳丢弃、缺失兜底保留）
//   - 失败重试（间隔超过去重窗口）→ 已提议集合按会话键跳过，不重复候选
//   - 手动撞上在途自动扫描 → 等待并复用真实扫描结果，绝不并发起两轮
//   - 真 reader 失败路径（库不存在 / 缺表）→ exit 0 + 单份 JSON + unavailable，不崩溃
//   - 跨午夜补扫 → 昨天的消息记回昨天（occurred_date 不串到今天）
//   - 读库故障不消耗模型重试预算（不花钱的故障不该让自动提取整天停摆）
//   - 0 条新消息但已读行前移 → 水位照样收敛，不每轮重读被丢弃的行
//
// 用法：node test/openclaw-import.accept.mjs（npm run accept:openclaw-import）

import { mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
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
const runDir = join(tmpDir, `openclaw-import-${Date.now()}`)
const dataDir = join(runDir, 'data')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'work.db')
const backupDir = join(dataDir, 'backup')

const dbBundled = bundleEntry('electron/main/database/database.ts', 'oi-database.mjs')
const recordBundled = bundleEntry('electron/main/work/recordManager.ts', 'oi-record.mjs')
const importBundled = bundleEntry('electron/main/work/openclawImportManager.ts', 'oi-import.mjs')

const { DatabaseClient } = await import(pathToFileURL(dbBundled).href)
const { createRecordManager } = await import(pathToFileURL(recordBundled).href)
const { createOpenClawImportManager } = await import(pathToFileURL(importBundled).href)

const database = new DatabaseClient({
  dbPath,
  backupDir,
  workerScriptPath: join(__dirname, '..', 'resources', 'database', 'db-worker.mjs'),
  nodePath,
  subprocessName: 'oi-db-worker'
})
const records = createRecordManager({ database })

const AGENT_DB = 'D:\\fake\\openclaw-agent.sqlite'

/** 假 gateway：chat 非流式返回固定文本 */
function fakeGateway(text) {
  return {
    calls: 0,
    async chat() {
      this.calls += 1
      return { text, chunks: 1, usage: null, model: 'fake-model', aborted: false, ms: 1 }
    }
  }
}

/** 按调用次序返回不同输出的假 gateway（分批场景用） */
function sequenceGateway(outputs) {
  const calls = []
  return {
    calls,
    async chat() {
      const text = outputs[calls.length] ?? outputs[outputs.length - 1]
      calls.push(text)
      return { text, chunks: 1, usage: null, model: 'fake-model', aborted: false, ms: 1 }
    }
  }
}

/** 假 reader：按调用次序返回预设批次，记录每次收到的参数 */
function fakeReader(batches) {
  const calls = []
  const reader = async (params) => {
    calls.push(params)
    return batches[calls.length - 1] ?? { messages: [], maxCreatedAt: params.sinceMs }
  }
  reader.calls = calls
  return reader
}

function makeManager(gateway, reader) {
  return createOpenClawImportManager({
    database,
    records,
    gateway,
    reader,
    dbPath: AGENT_DB
  })
}

function sessionMessage(role, text) {
  return { ts: Date.now(), role, text, sessionKey: 'agent:main:dashboard:fake', channel: null }
}

const r = new Recorder('OpenClaw 使用记录自动提取验收')

try {
  await r.check('C1', '自动开关默认关', async () => {
    const manager = makeManager(fakeGateway(''), fakeReader([]))
    assertEq(await manager.isAutoEnabled(), false, '默认应为关')
  })

  await r.check('C2', '开关持久化（跨实例读取）', async () => {
    const manager = makeManager(fakeGateway(''), fakeReader([]))
    await manager.setAutoEnabled(true)
    const other = makeManager(fakeGateway(''), fakeReader([]))
    assertEq(await other.isAutoEnabled(), true, '新实例应读到开')
    await other.setAutoEnabled(false)
    assertEq(await manager.isAutoEnabled(), false, '关闭后各实例同步')
  })

  await r.check('C3', '0 条新消息不调模型', async () => {
    const gateway = fakeGateway('')
    const reader = fakeReader([{ messages: [], maxCreatedAt: 0 }])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(result.scanned, 0, 'scanned=0')
    assertEq(gateway.calls, 0, '不应调模型')
    assertEq(reader.calls[0].dbPath, AGENT_DB, '应查询 agent 库')
    assert(reader.calls[0].dayStartMs > 0, '应带当天起点')
  })

  const WATERMARK_1 = 1_790_000_000_000

  await r.check('C4', '对话 → AI 提炼候选 + 水位推进', async () => {
    const gateway = fakeGateway('- 完成AI教学课第一课大纲\n- 测试了自动提取功能')
    const reader = fakeReader([
      {
        messages: [
          sessionMessage('user', '帮我看下第一课大纲'),
          sessionMessage('assistant', '大纲建议如下……')
        ],
        maxCreatedAt: WATERMARK_1
      }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(result.scanned, 2, 'scanned=2')
    assertEq(result.extracted, 2, 'extracted=2')
    assertEq(gateway.calls, 1, '调一次模型')
    const candidates = await records.list({ status: 'candidate' })
    assertEq(candidates.length, 2, '应落2条候选')
    assert(
      candidates.some((c) => c.content === '完成AI教学课第一课大纲'),
      '候选内容应正确'
    )
  })

  await r.check('C5', '增量扫描：reader 收到上次水位', async () => {
    const gateway = fakeGateway('- 下午推进了第二件事')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '继续干活')], maxCreatedAt: WATERMARK_1 + 1000 }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(reader.calls[0].sinceMs, WATERMARK_1, 'sinceMs 应=上次水位')
    assertEq(result.extracted, 1, '只新增1条候选')
    const candidates = await records.list({ status: 'candidate' })
    assertEq(candidates.length, 3, '候选累计3条')
  })

  await r.check('C6', 'AI 返回「（无）」→ 0 候选但水位仍推进', async () => {
    const gateway = fakeGateway('（无）')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '今天天气怎么样')], maxCreatedAt: WATERMARK_1 + 2000 }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(result.extracted, 0, '0候选')
    const nextReader = fakeReader([])
    const next = makeManager(fakeGateway(''), nextReader)
    await next.importToday()
    assertEq(nextReader.calls[0].sinceMs, WATERMARK_1 + 2000, '水位应已推进')
  })

  await r.check('C7', '与 confirmed 重复 → 门槛挡下', async () => {
    await records.create({ content: '已经确认过的工作内容' })
    const gateway = fakeGateway('- 已经确认过的工作内容')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '重复的活')], maxCreatedAt: WATERMARK_1 + 3000 }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(result.extracted, 0, '不入候选')
    assertEq(result.filtered, 1, 'filtered=1')
  })

  await r.check('C8', '并发两次调用只扫描一次', async () => {
    const gateway = fakeGateway('- 并发测试工作')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '并发场景')], maxCreatedAt: WATERMARK_1 + 4000 }
    ])
    const manager = makeManager(gateway, reader)
    const [first, second] = await Promise.all([manager.importToday(), manager.importToday()])
    assertEq(reader.calls.length, 1, 'reader 只调一次')
    assertEq(gateway.calls, 1, '模型只调一次')
    assert(first === second, '两次应复用同一结果')
  })

  await r.check('C9', '模型输出无法识别 → 抛错且不推进水位（下轮重试）', async () => {
    const gateway = fakeGateway('抱歉，这段对话内容我无法整理。')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '格式异常场景')], maxCreatedAt: WATERMARK_1 + 5000 }
    ])
    const manager = makeManager(gateway, reader)
    let threw = null
    try {
      await manager.importToday()
    } catch (e) {
      threw = e
    }
    assert(threw, '无法识别时应抛错')
    // 水位未推进：探针 reader 收到的 sinceMs 与失败那次相同
    const probeReader = fakeReader([])
    const probe = makeManager(fakeGateway(''), probeReader)
    await probe.importToday()
    assertEq(probeReader.calls[0].sinceMs, reader.calls[0].sinceMs, '水位不应推进')
  })

  await r.check('C10', '对话量超预算 → 分批提炼，早间工作不漏', async () => {
    const gateway = sequenceGateway(['- 早间完成的工作', '- 晚间完成的工作'])
    const bigMessages = []
    for (let index = 0; index < 12; index++) {
      bigMessages.push(sessionMessage(index % 2 ? 'assistant' : 'user', 'x'.repeat(2900)))
    }
    const reader = fakeReader([
      { messages: bigMessages, maxCreatedAt: bigMessages[bigMessages.length - 1].ts }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(gateway.calls.length, 2, '应分2批调2次模型')
    assertEq(result.extracted, 2, '两批共2条，早间工作未漏')
  })

  await r.check('C11', '「- 无。」「- 暂无可记录内容」等行内变体 → 不进候选、不抛错且水位推进', async () => {
    // 带 bullet 的「无内容」变体必须在 parseRecordLines 逐行挡下：
    // isExplicitEmpty 只在整段 0 条时才被咨询，挡不到「- 暂无可记录内容」
    const gateway = sequenceGateway(['- 无。', '- 暂无可记录内容'])
    const bigMessages = []
    for (let index = 0; index < 12; index++) {
      bigMessages.push(sessionMessage(index % 2 ? 'assistant' : 'user', 'y'.repeat(2900)))
    }
    const reader = fakeReader([
      { messages: bigMessages, maxCreatedAt: bigMessages[bigMessages.length - 1].ts }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(gateway.calls.length, 2, '两批各调一次模型')
    assertEq(result.extracted, 0, '两批都无内容，0候选')
    const candidatesNow = await records.list({ status: 'candidate' })
    assert(
      !candidatesNow.some((c) => c.content.includes('无可记录') || c.content === '无。'),
      '变体短语不得成为候选'
    )
    const probeReader = fakeReader([])
    const probe = makeManager(fakeGateway(''), probeReader)
    await probe.importToday()
    assertEq(probeReader.calls[0].sinceMs, bigMessages[bigMessages.length - 1].ts, '水位应已推进')
  })

  await r.check('C12', '模型返回空文本 → 抛错且不推进水位（不视为明确无内容）', async () => {
    const gateway = fakeGateway('')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '空响应场景')], maxCreatedAt: WATERMARK_1 + 6000 }
    ])
    const manager = makeManager(gateway, reader)
    let threw = null
    try {
      await manager.importToday('auto')
    } catch (e) {
      threw = e
    }
    assert(threw, '空响应应抛错')
    assertEq(threw.code, 'OPENCLAW_INVALID_OUTPUT', '错误码应为 OPENCLAW_INVALID_OUTPUT')
    assertEq(threw.details?.reason, 'empty-output', 'reason 应为 empty-output')
    const probeReader = fakeReader([])
    const probe = makeManager(fakeGateway(''), probeReader)
    await probe.importToday()
    assertEq(probeReader.calls[0].sinceMs, reader.calls[0].sinceMs, '水位不应推进')
  })

  await r.check('C13', '自动解析失败 → 退避期跳过模型调用；手动成功后水位推进、计数清零', async () => {
    const BACKOFF_DB = 'D:\\fake\\backoff.sqlite'
    const base = Date.now()
    let clock = base
    // 隔离：上一用例 C12 的自动失败计数也写在共享 app_meta，先清零
    await database.metaSet('openclaw_import_retry', '0')
    const gateway = sequenceGateway(['抱歉，无法整理。', '- 退避后手动提炼成功'])
    const batchMax = WATERMARK_1 + 7000
    // reader 每次调用都要返回同一批（fakeReader 按调用序号取预设，给三份相同数据）
    const sameBatch = { messages: [sessionMessage('user', '退避场景')], maxCreatedAt: batchMax }
    const reader = fakeReader([sameBatch, sameBatch, sameBatch])
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway,
      reader,
      dbPath: BACKOFF_DB,
      now: () => clock
    })
    let threw = null
    try {
      await manager.importToday('auto')
    } catch (e) {
      threw = e
    }
    assert(threw, '首次自动失败应抛错')
    assertEq(gateway.calls.length, 1, '只调了1次模型')

    clock = base + 5 * 60_000
    const skipped = await manager.importToday('auto')
    assertEq(skipped.skipped, true, '退避期内自动轮询应跳过')
    assertEq(gateway.calls.length, 1, '跳过期间不得再调模型')

    const manual = await manager.importToday('manual')
    assertEq(manual.extracted, 1, '手动触发应正常提炼1条')
    assertEq(gateway.calls.length, 2, '手动时再调一次模型')

    // 同一 dbPath 才有同一水位键：手动成功后该库水位推进到 batchMax
    const probeReader = fakeReader([])
    const probe = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(''),
      reader: probeReader,
      dbPath: BACKOFF_DB
    })
    await probe.importToday('auto')
    assertEq(probeReader.calls[0].sinceMs, batchMax, '手动成功后水位应已推进')
  })

  await r.check('C14', '散文 +「- （无）」→ 视为明确无内容，不抛错且水位推进', async () => {
    const batchMax = WATERMARK_1 + 8000
    const gateway = fakeGateway('好的，分析如下：\n- （无）')
    const reader = fakeReader([
      { messages: [sessionMessage('user', '散文加标记场景')], maxCreatedAt: batchMax }
    ])
    const manager = makeManager(gateway, reader)
    const result = await manager.importToday()
    assertEq(result.extracted, 0, '0新候选')
    assertEq(gateway.calls, 1, '只调一次模型')
    const probeReader = fakeReader([])
    const probe = makeManager(fakeGateway(''), probeReader)
    await probe.importToday()
    assertEq(probeReader.calls[0].sinceMs, batchMax, '水位应已推进')
  })

  await r.check('C15', '所有库 unavailable → 抛错而非误报「没有内容」', async () => {
    const UNAVAIL_DB = 'D:\\fake\\unavail.sqlite'
    const unavailableReader = async () => ({
      messages: [],
      maxCreatedAt: 0,
      unavailable: true,
      reason: 'database is locked'
    })
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(''),
      reader: unavailableReader,
      dbPath: UNAVAIL_DB
    })
    let threw = null
    try {
      await manager.importToday()
    } catch (e) {
      threw = e
    }
    assert(threw, '全部不可读时应抛错')
    assertEq(threw.code, 'OPENCLAW_NOT_READY', '错误码应为 OPENCLAW_NOT_READY')
  })

  await r.check('C16', '重扫命中既有候选（deduped）→ 不计入 extracted，candidateIds 不重复', async () => {
    const DEDUP_DB = 'D:\\fake\\dedup.sqlite'
    const content = '去重覆盖测试工作内容'
    const firstMax = WATERMARK_1 + 9000
    // 源消息对象两轮共享：源锚定键只认消息身份，不认模型措辞
    const source = [sessionMessage('user', '第一次扫描')]
    const sameScan = { messages: source, maxCreatedAt: firstMax }
    const firstReader = fakeReader([sameScan, sameScan])
    const first = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(`- ${content}`),
      reader: firstReader,
      dbPath: DEDUP_DB
    })
    const firstResult = await first.importToday()
    assertEq(firstResult.extracted, 1, '首次新增1条')

    // SKEW 重读：同一批源消息再次返回，模型输出完全相同
    const secondReader = fakeReader([sameScan, sameScan])
    const second = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(`- ${content}`),
      reader: secondReader,
      dbPath: DEDUP_DB
    })
    const secondResult = await second.importToday()
    assertEq(secondResult.extracted, 0, '覆盖更新不是新增')
    assertEq(secondResult.deduped, 1, 'deduped=1')
    assertEq(secondResult.candidateIds.length, 0, 'candidateIds 不含重复 id')
  })

  await r.check('C17', 'reader：created_at 增量 + 重启重写守卫（旧内嵌时间戳丢弃、缺失兜底保留）', async () => {
    const fixtureDb = join(dataDir, 'reader-fixture.sqlite')
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dayStartMs0 = today.getTime()
    const since = dayStartMs0 + 10 * 3600_000
    const mkJson = (content, timestamp) =>
      JSON.stringify({
        type: 'message',
        message:
          timestamp === null
            ? { role: 'user', content }
            : { role: 'user', content, timestamp }
      })
    const events = [
      { seq: 1, createdAt: since + 1000, json: mkJson('时钟偏慢但未过窗口起点', since - 120_000) },
      { seq: 2, createdAt: since + 2000, json: mkJson('没有内嵌时间戳', null) },
      { seq: 3, createdAt: since + 3000, json: mkJson('正常新消息', since + 3000) },
      { seq: 4, createdAt: since + 4000, json: mkJson('昨天旧消息被重启重写', dayStartMs0 - 3600_000) },
      { seq: 5, createdAt: since + 5000, json: mkJson('秒级时间戳消息', Math.floor((since + 5000) / 1000)) },
      { seq: 6, createdAt: since + 6000, json: mkJson('最新行无时间戳', null) }
    ]
    const fixtureScript = [
      'const { DatabaseSync } = require("node:sqlite");',
      'const db = new DatabaseSync(process.argv[1]);',
      'db.exec(`CREATE TABLE session_windows (session_id TEXT NOT NULL PRIMARY KEY, session_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, channel TEXT) STRICT;',
      'CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)) STRICT;`);',
      'db.prepare("INSERT INTO session_windows (session_id,session_key,created_at,updated_at) VALUES (?,?,?,?)").run("s1","agent:main:dashboard:c17",' + since + ',' + since + ');',
      'for (const e of ' + JSON.stringify(events) + ')',
      'db.prepare("INSERT INTO transcript_events (session_id,seq,event_json,created_at) VALUES (?,?,?,?)").run("s1",e.seq,e.json,e.createdAt);'
    ].join('\n')
    execFileSync(nodePath, ['-e', fixtureScript, fixtureDb], { windowsHide: true })

    const readerPath = join(__dirname, '..', 'resources', 'database', 'openclaw-reader.mjs')
    const rawOut = execFileSync(
      nodePath,
      [readerPath, fixtureDb, String(since), String(dayStartMs0)],
      { windowsHide: true }
    ).toString()
    const out = JSON.parse(rawOut)
    assertEq(out.messages.length, 5, '守卫只丢昨天旧消息；缺失时间戳兜底保留，不整渠道静默丢失')
    assertEq(out.messages[0].text, '时钟偏慢但未过窗口起点', '内嵌时间未早于窗口起点 → 保留')
    assertEq(out.messages[1].text, '没有内嵌时间戳', '缺失时间戳兜底保留')
    assertEq(out.messages[2].text, '正常新消息', '正常消息应保留')
    assertEq(out.messages[3].text, '秒级时间戳消息', '秒级时间戳应 ×1000 后保留')
    assertEq(out.messages[3].ts, since + 5000, '输出 ts=created_at（绝不混用内嵌时钟）')
    assertEq(out.messages[4].text, '最新行无时间戳', '最新无时间戳行应保留')
    assertEq(out.maxCreatedAt, since + 6000, '最新行无时间戳也应收敛水位（按 created_at）')
  })

  await r.check('C18', '同源消息重扫、模型措辞一字之差 → 命中同键覆盖（deduped），不产生重复候选', async () => {
    const ANCHOR_DB = 'D:\\fake\\anchor.sqlite'
    await database.metaSet('openclaw_import_retry', '0')
    const source = [
      sessionMessage('user', '帮我完善A项目大纲'),
      sessionMessage('assistant', '大纲建议如下')
    ]
    const sameScan = { messages: source, maxCreatedAt: source[source.length - 1].ts }
    const first = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway('- 完成A大纲'),
      reader: fakeReader([sameScan, sameScan]),
      dbPath: ANCHOR_DB
    })
    const firstResult = await first.importToday()
    assertEq(firstResult.extracted, 1, '首次新增1条')
    // 模拟 SKEW 重读：reader 再次返回同一批源消息，模型概括措辞有一字之差
    const second = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway('- 完成了A大纲'),
      reader: fakeReader([sameScan, sameScan]),
      dbPath: ANCHOR_DB
    })
    const secondResult = await second.importToday()
    assertEq(secondResult.extracted, 0, '措辞不同也不是新增')
    assertEq(secondResult.deduped, 1, '应命中源锚定键覆盖')
    const outline = await records.list({ status: 'candidate' })
    assertEq(
      outline.filter((c) => String(c.content).includes('A大纲')).length,
      1,
      '同一事项只有1条候选'
    )
  })

  await r.check('C19', 'auto 模式 gateway 异常（token 过期等）→ 计入重试预算，退避期跳过', async () => {
    const GW_FAIL_DB = 'D:\\fake\\gwfail.sqlite'
    await database.metaSet('openclaw_import_retry', '0')
    const throwingGateway = {
      async chat() {
        throw new Error('401 Unauthorized')
      }
    }
    const sameScan = {
      messages: [sessionMessage('user', '网关故障场景')],
      maxCreatedAt: WATERMARK_1 + 10000
    }
    const base = Date.now()
    let clock = base
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway: throwingGateway,
      reader: fakeReader([sameScan, sameScan, sameScan]),
      dbPath: GW_FAIL_DB,
      now: () => clock
    })
    let threw = null
    try {
      await manager.importToday('auto')
    } catch (e) {
      threw = e
    }
    assert(threw, '网关异常应抛错')
    assertEq(threw.message, '401 Unauthorized', '原始错误应透出')
    clock = base + 5 * 60_000
    const skipped = await manager.importToday('auto')
    assertEq(skipped.skipped, true, '非解析故障同样进入退避跳过')
    assertEq(skipped.skipReason, 'backoff', 'skipReason=backoff')
  })

  await r.check('C20', '重试耗尽后手动触发、0 条新消息 → 退避清除不复发（横幅不闪烁）', async () => {
    const EMPTY_AFTER_DB = 'D:\\fake\\emptyafter.sqlite'
    await database.metaSet('openclaw_import_retry', '0')
    const base = Date.now()
    await database.metaSet(
      'openclaw_import_retry',
      JSON.stringify({ count: 5, firstAt: base - 3600_000, lastAt: base })
    )
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(''),
      reader: fakeReader([]),
      dbPath: EMPTY_AFTER_DB
    })
    const result = await manager.importToday('manual')
    assertEq(result.scanned, 0, '0 扫描')
    assertEq(result.skipped, undefined, '手动结果不带 skipped')
    assertEq(await database.metaGet('openclaw_import_retry'), '0', '退避状态应已清除')
  })

  await r.check('C21', '失败重试间隔超过去重窗口 → 已提议集合按会话键跳过，不重复候选', async () => {
    const PROPOSED_DB = 'D:\\fake\\proposed.sqlite'
    await database.metaSet('openclaw_import_retry', '0')
    const base = Date.now()
    let clock = base
    // 12 条大消息切成两批：批1 提案成功、批2 模型失败 → 整轮失败、水位不推进
    const bigMessages = []
    for (let index = 0; index < 12; index++) {
      bigMessages.push(sessionMessage(index % 2 ? 'assistant' : 'user', 'x'.repeat(2900)))
    }
    const sameScan = { messages: bigMessages, maxCreatedAt: WATERMARK_1 + 11000 }
    const gateway = sequenceGateway([
      '- 提案幂等工作甲',      // 第1轮 批1：提案成功
      '抱歉，无法整理',        // 第1轮 批2：失败 → 已提议集合持久化
      '- 提案幂等工作甲改写',  // 第2轮 批1：同键 → 已提议跳过
      '- 提案幂等工作乙'       // 第2轮 批2：新键 → 正常提议
    ])
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway,
      reader: fakeReader([sameScan, sameScan]),
      dbPath: PROPOSED_DB,
      now: () => clock
    })
    let threw = null
    try {
      await manager.importToday('manual')
    } catch (e) {
      threw = e
    }
    assert(threw, '第1轮批2失败应抛错')
    assertEq(gateway.calls.length, 2, '第1轮调2次模型')

    // 第2轮：间隔 40 分钟（超过 recordManager 30 分钟去重窗口），源消息不变
    clock = base + 40 * 60_000
    const second = await manager.importToday('manual')
    assertEq(second.extracted, 1, '仅新键乙入候选')
    assertEq(second.deduped, 1, '甲的会话键已提议过 → 跳过计 deduped')

    const contents = (await records.list({ status: 'candidate' })).map((c) => c.content)
    assertEq(
      contents.filter((c) => c === '提案幂等工作甲').length,
      1,
      '甲只有一条候选（改写措辞没有再入）'
    )
    assert(!contents.some((c) => c.includes('甲改写')), '改写措辞不得成为新候选')
    assert(contents.some((c) => c === '提案幂等工作乙'), '乙应正常入候选')
  })

  await r.check('C22', '手动撞上在途自动扫描 → 等待并复用真实扫描结果，绝不并发起两轮', async () => {
    const INFLIGHT_DB = 'D:\\fake\\inflight.sqlite'
    await database.metaSet('openclaw_import_retry', '0')
    const scan = {
      messages: [sessionMessage('user', '在途复用场景')],
      maxCreatedAt: WATERMARK_1 + 12000
    }
    const reader = fakeReader([scan])
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const gateway = {
      async chat() {
        await gate
        return { text: '- 在途复用工作', chunks: 1, usage: null, model: 'fake', aborted: false, ms: 1 }
      }
    }
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway,
      reader,
      dbPath: INFLIGHT_DB
    })
    const autoPromise = manager.importToday('auto')
    await sleep(50)
    const manualPromise = manager.importToday('manual')
    await sleep(50)
    assertEq(reader.calls.length, 1, '手动等待在途自动轮，不并发起第二轮扫描')
    release()
    const autoResult = await autoPromise
    const manualResult = await manualPromise
    assertEq(reader.calls.length, 1, '真实扫描成功的结果直接复用，全程只扫一次')
    assert(autoResult === manualResult, '手动应复用在途自动扫描的结果对象')
  })

  await r.check('C23', 'reader 失败路径：库不存在 / 缺表 → exit 0 + 单份 JSON + unavailable（不崩溃）', async () => {
    const readerPath = join(__dirname, '..', 'resources', 'database', 'openclaw-reader.mjs')
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dayStart = today.getTime()
    const since = dayStart + 3600_000
    const run = (db) => {
      const res = spawnSync(nodePath, [readerPath, db, String(since), String(dayStart)], {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
      })
      return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }
    }

    // ① 库文件不存在（OpenClaw 从未产生会话 / 枚举后被删）
    const missing = run(join(dataDir, 'no-such-agent.sqlite'))
    assertEq(missing.status, 0, '库不存在应优雅退出 exit 0（不是崩溃）')
    assert(!/TypeError|not iterable/.test(missing.stderr), 'stderr 不应出现崩溃栈')
    // JSON.parse 能过就证明 stdout 只有一份 JSON（曾经会连写三份再崩）
    const missingOut = JSON.parse(missing.stdout)
    assertEq(missingOut.unavailable, true, '应标 unavailable')
    assertEq(missingOut.messages.length, 0, '0 条消息')
    assertEq(missingOut.maxCreatedAt, since, '水位原样返回（不可用时绝不推进）')
    assert(
      typeof missingOut.reason === 'string' && missingOut.reason.length > 0,
      '应带 reason 供日志定位'
    )

    // ② 库存在但缺表（OpenClaw 升级改 schema）：真因必须透出，不能被 TypeError 覆盖
    const noTableDb = join(dataDir, 'no-table.sqlite')
    execFileSync(
      nodePath,
      [
        '-e',
        'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.close();',
        noTableDb
      ],
      { windowsHide: true }
    )
    const noTable = run(noTableDb)
    assertEq(noTable.status, 0, '缺表也应优雅退出 exit 0')
    const noTableOut = JSON.parse(noTable.stdout)
    assertEq(noTableOut.unavailable, true, '缺表应标 unavailable')
    assert(/no such table/.test(noTableOut.reason), `reason 应是真因（实际：${noTableOut.reason}）`)
    assert(!/TypeError|not iterable/.test(noTable.stderr), 'stderr 不应出现崩溃栈')
    return '库不存在 / 缺表 均 exit 0 + 单份 JSON + 真因 ✓'
  })

  await r.check('C24', '跨午夜补扫：昨天的消息记回昨天（occurred_date 不串到今天）', async () => {
    const MIDNIGHT_DB = 'D:\\fake\\midnight.sqlite'
    await database.metaSet('openclaw_import_retry', '0')
    const fmtDate = (ts) => {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    const today0 = new Date()
    today0.setHours(0, 0, 0, 0)
    const yesterdayNoon = today0.getTime() - 12 * 3600_000
    const todayMorning = today0.getTime() + 9 * 3600_000
    const mk = (ts, text) => ({
      ts,
      role: 'user',
      text,
      sessionKey: 'agent:main:dashboard:midnight',
      channel: null
    })
    // 水位停在昨天 → reader 一次返回昨天 + 今天两段消息
    const scan = {
      messages: [mk(yesterdayNoon, '昨天中午的对话'), mk(todayMorning, '今天早上的对话')],
      maxCreatedAt: todayMorning
    }
    const gateway = sequenceGateway(['- 昨天推进的工作甲', '- 今天推进的工作乙'])
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway,
      reader: fakeReader([scan, scan]),
      dbPath: MIDNIGHT_DB
    })
    const result = await manager.importToday('manual')
    assertEq(result.scanned, 2, '两段消息都扫到')
    assertEq(gateway.calls.length, 2, '按消息自己的本地日分成两批（昨天/今天各一批）')
    const rows = await records.list({ status: 'candidate' })
    const yRow = rows.find((c) => c.content === '昨天推进的工作甲')
    const tRow = rows.find((c) => c.content === '今天推进的工作乙')
    assert(yRow && tRow, '两天各一条候选')
    assertEq(yRow.occurred_date, fmtDate(yesterdayNoon), '昨天那条必须归昨天（不得串进今天日报）')
    assertEq(tRow.occurred_date, fmtDate(todayMorning), '今天那条归今天')
    return `${yRow.occurred_date} / ${tRow.occurred_date} 各归其日 ✓`
  })

  await r.check('C25', '读库故障不消耗模型重试预算（unavailable / reader reject 两种形态）', async () => {
    const READFAIL_DB = 'D:\\fake\\readfail.sqlite'
    await database.metaSet('openclaw_import_retry', '0')

    // ① reader 正常返回但标 unavailable（库被 OpenClaw 独占）
    const unavailableReader = async () => ({
      messages: [],
      maxCreatedAt: 0,
      unavailable: true,
      reason: 'database is locked'
    })
    const m1 = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(''),
      reader: unavailableReader,
      dbPath: READFAIL_DB
    })
    let threw1 = null
    try {
      await m1.importToday('auto')
    } catch (e) {
      threw1 = e
    }
    assert(threw1, '全库不可读应抛错（不能误报「没有新内容」）')
    assertEq(threw1.code, 'OPENCLAW_NOT_READY', '错误码 OPENCLAW_NOT_READY')
    assertEq(
      await database.metaGet('openclaw_import_retry'),
      '0',
      '读库故障不花 token，不得计入模型重试预算'
    )

    // ② reader 直接 reject（便携 Node 未就绪 / spawn 失败 / 输出损坏）
    const rejectingReader = async () => {
      const e = new Error('便携 Node 运行时尚未就绪，无法读取 OpenClaw 会话')
      e.code = 'OPENCLAW_NOT_READY'
      throw e
    }
    const m2 = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(''),
      reader: rejectingReader,
      dbPath: READFAIL_DB
    })
    let threw2 = null
    try {
      await m2.importToday('auto')
    } catch (e) {
      threw2 = e
    }
    assert(threw2, 'reader reject 应抛错')
    assertEq(
      await database.metaGet('openclaw_import_retry'),
      '0',
      'reader reject 同属读库故障，同样不计入预算'
    )

    // ③ 对照：会花钱的解析故障仍要计入（防止同一批转录无限烧钱）
    const m3 = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway('抱歉，我无法整理。'),
      reader: fakeReader([
        { messages: [sessionMessage('user', '解析故障对照')], maxCreatedAt: WATERMARK_1 + 13000 }
      ]),
      dbPath: 'D:\\fake\\parsefail.sqlite'
    })
    let threw3 = null
    try {
      await m3.importToday('auto')
    } catch (e) {
      threw3 = e
    }
    assert(threw3, '解析失败应抛错')
    const raw = await database.metaGet('openclaw_import_retry')
    assert(raw && raw !== '0', '解析故障应写入重试状态')
    assertEq(JSON.parse(raw).count, 1, '解析故障计入预算 count=1')
    await database.metaSet('openclaw_import_retry', '0')
    return '读库故障 0 计入 · 解析故障 1 计入 ✓'
  })

  await r.check('C26', '0 条新消息但已读行前移 → 水位照样收敛（不每轮重读被丢弃的行）', async () => {
    const CONVERGE_DB = 'D:\\fake\\converge.sqlite'
    const advanced = WATERMARK_1 + 20000
    const gateway = fakeGateway('')
    // reader 读到了行、但全被角色/空文本/重启重写守卫丢弃 → messages 为空、maxCreatedAt 前移
    const reader = fakeReader([{ messages: [], maxCreatedAt: advanced }])
    const manager = createOpenClawImportManager({
      database,
      records,
      gateway,
      reader,
      dbPath: CONVERGE_DB
    })
    const first = await manager.importToday('manual')
    assertEq(first.scanned, 0, 'scanned=0')
    assertEq(gateway.calls, 0, '0 条消息不调模型')
    const probeReader = fakeReader([])
    const probe = createOpenClawImportManager({
      database,
      records,
      gateway: fakeGateway(''),
      reader: probeReader,
      dbPath: CONVERGE_DB
    })
    await probe.importToday('manual')
    assertEq(
      probeReader.calls[0].sinceMs,
      advanced,
      '水位应收敛到已读行末尾，否则被丢弃的行每轮重读（最坏 20000 行 / 10 分钟）'
    )
    return '水位收敛到 ' + advanced + ' ✓'
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
writeJson(join(__dirname, 'accept-result-openclaw-import.json'), result)

console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total} 通过，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
