// test/record.accept.mjs —— Commit 03 验收：工作记录 + 候选管线
//
// **打真实源码**：esbuild 把 electron/main/work/recordManager.ts + 真 DatabaseClient +
// 真 db-worker 串起来，在纯 Node 里跑真 SQLite（真 Worker 子进程、真建库、真迁移）。
//
// 覆盖点（对齐 PLAN-3.0.md §2.2 / §2.2.1 / §4.1 / §14）：
//   - **产出型 / 加工型分流**：产出型才产候选；加工型（润色/翻译/摘要）不产
//   - **候选质量门槛**：空 / 过短 / 与既有 confirmed 高相似 → 挡下并**留痕（含原因）**，不静默丢
//   - **候选去重**：同会话 + 同产出类型 + 30 分钟内 → 覆盖更新（不新增第二条）；
//     不同会话 / 不同产出类型 / 超窗口 → 各自独立；已处理（非 candidate）不参与去重
//   - **状态机**：candidate→confirmed / →ignored / ignored→candidate（恢复）；
//     非法迁移被拒；幂等
//   - **批量**：不因单条失败中断（不存在/状态不符 → skipped）
//   - **双时间语义**：occurred_date 必填可≠入库日（补记）；occurred_time 可空（时间未记）
//   - **删除即遗忘**：物理删除（行真的没了）
//   - **列表**：新→旧（参数约定 4）、status 默认只看 confirmed、LIKE 检索
//
// 用法：node test/record.accept.mjs    （npm run accept:record）

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
const runDir = join(tmpDir, `record-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')

// ── bundle 真源码 ─────────────────────────────────────────────────────────────
const dbBundled = bundleEntry('electron/main/database/database.ts', 'rec-database.mjs')
const recordBundled = bundleEntry('electron/main/work/recordManager.ts', 'rec-record.mjs')
const matterBundled = bundleEntry('electron/main/work/matterManager.ts', 'rec-matter.mjs')

const dbMod = await import(pathToFileURL(dbBundled).href)
const recordMod = await import(pathToFileURL(recordBundled).href)
const matterMod = await import(pathToFileURL(matterBundled).href)

const { DatabaseClient } = dbMod
const {
  createRecordManager,
  OUTPUT_TYPE_CLASSIFICATION,
  isProductiveOutputType,
  CANDIDATE_DEDUP_WINDOW_MS,
  CANDIDATE_MIN_CONTENT_LENGTH,
  FILTER_REASONS,
  RECORD_STATUS_CANDIDATE,
  RECORD_STATUS_CONFIRMED,
  RECORD_STATUS_IGNORED,
  encodeSourceRef,
  decodeSourceRef,
  normalizeForCompare,
  normalizeTime
} = recordMod
const { createMatterManager } = matterMod

const logger = () => {}

function makeClock(startMs = Date.UTC(2026, 8, 23, 10, 0, 0)) {
  let t = startMs
  let n = 0
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
      return t
    },
    newId: () => `rid-${++n}`
  }
}

const r = new Recorder('Commit 03 · 工作记录 + 候选管线')
let database = null

async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

try {
  await r.check('R0', '前置：真 DB Worker 拉起、建库、user_version=1、8 表', async () => {
    database = new DatabaseClient({
      dbPath,
      backupDir,
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker-commit03',
      requestTimeoutMs: 30_000,
      logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'Worker 应就绪')
    assertEq(st.tables.length, 8, `应有 8 张表（实际 ${st.tables.length}）`)
    return `pid=${st.workerPid} uv=${st.userVersion}`
  })

  const clock = makeClock()
  const records = createRecordManager({ database, logger, now: clock.now, newId: clock.newId })
  const matters = createMatterManager({ database, logger, now: clock.now, newId: clock.newId })

  // ── 分流表 ──
  await r.check('C1', '产出型/加工型分流表：产出型才产候选，加工型不产', async () => {
    assertEq(isProductiveOutputType('minutes'), true, '会议纪要是产出型')
    assertEq(isProductiveOutputType('report'), true, '日报/周报是产出型')
    assertEq(isProductiveOutputType('email_draft'), true, '邮件草稿是产出型')
    assertEq(isProductiveOutputType('polish'), false, '润色是加工型（不产候选）')
    assertEq(isProductiveOutputType('translate'), false, '翻译是加工型')
    assertEq(isProductiveOutputType('summary'), false, '摘要是加工型')
    assertEq(isProductiveOutputType('nope'), false, '未知类型不算产出型')

    // 加工型调用 proposeCandidate → 不产生候选、也不留痕
    const before = (await records.list({ status: 'all' })).length
    const res = await records.proposeCandidate({
      content: '这是一段被润色过的文本，有交付物吗？',
      outputType: 'polish',
      conversationKey: 'conv:work:tool:polish'
    })
    assertEq(res.candidate, null, '加工型不应产生候选')
    assertEq(res.filteredReason, null, '加工型不算被过滤（不是噪音，是本来就不产）')
    assertEq(res.filteredRecordId, null, '加工型不应留痕')
    const after = (await records.list({ status: 'all' })).length
    assertEq(after, before, '加工型不应在库里留下任何行')
    return `产出型 3 类 / 加工型 3 类；加工型调用零落库`
  })

  // ── 质量门槛 ──
  await r.check('C2', '质量门槛①：空内容 / 过短 → 挡下 + 留痕（含原因），不静默丢', async () => {
    const empty = await records.proposeCandidate({
      content: '   ',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes'
    })
    assertEq(empty.candidate, null, '空内容应被挡')
    assertEq(empty.filteredReason, FILTER_REASONS.EMPTY, '原因应为 empty')
    assert(empty.filteredRecordId, '应留痕（不静默丢）')

    const short = await records.proposeCandidate({
      content: '好的',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes'
    })
    assertEq(short.filteredReason, FILTER_REASONS.TOO_SHORT, '过短应被挡')
    assertEq(CANDIDATE_MIN_CONTENT_LENGTH, 4, '门槛阈值应为 4')

    // 留痕可见（「已过滤」筛选）
    const filtered = await records.listFiltered()
    assertEq(filtered.length, 2, '应有 2 条已过滤留痕')
    assert(filtered.every((f) => f.status === RECORD_STATUS_IGNORED), '留痕应为 ignored 态')
    assert(filtered.every((f) => f.filtered_reason !== null), '留痕必须带原因')
    const reasons = filtered.map((f) => f.filtered_reason).sort()
    assertEq(JSON.stringify(reasons), JSON.stringify([FILTER_REASONS.EMPTY, FILTER_REASONS.TOO_SHORT]), '两条原因应可读回')
    return `empty / too-short 各留痕 1 条，原因可读回`
  })

  await r.check('C3', '质量门槛②：与既有 confirmed 高相似 → 挡下（不污染事实层）', async () => {
    // 先落一条事实
    await records.create({ content: '完成活动方案第二版', occurredDate: '2026-09-23' })
    // 同内容产出 → 应被挡
    const same = await records.proposeCandidate({
      content: '完成活动方案第二版',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes'
    })
    assertEq(same.candidate, null, '完全相同应被挡')
    assertEq(same.filteredReason, FILTER_REASONS.SIMILAR_TO_CONFIRMED, '原因应为 similar-to-confirmed')
    // 归一化后相同（标点/空白差异）也应被挡
    const normalized = await records.proposeCandidate({
      content: '完成活动方案第二版。',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes'
    })
    assertEq(normalized.filteredReason, FILTER_REASONS.SIMILAR_TO_CONFIRMED, '归一化相同应被挡')
    // 包含关系也应被挡（子串）
    const superset = await records.proposeCandidate({
      content: '今天完成活动方案第二版并同步给了团队',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes'
    })
    assertEq(superset.filteredReason, FILTER_REASONS.SIMILAR_TO_CONFIRMED, '包含既有记录应被挡')
    // 确实不同的内容应通过
    const fresh = await records.proposeCandidate({
      content: '整理项目会议材料并归档',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes'
    })
    assert(fresh.candidate, '不同内容应通过质量门槛')
    assertEq(fresh.candidate.status, RECORD_STATUS_CANDIDATE, '通过的应为候选态')
    return `相同/归一化相同/包含 → 均挡；不同内容通过`
  })

  // ── 去重 ──
  await r.check('C4', '候选去重：同会话+同类型+30min → 覆盖更新（不新增第二条）', async () => {
    // 用**全新会话键**：C2/C3 已在 minutes 会话里留了候选，若复用会直接命中去重
    const key = 'conv:work:tool:minutes-dedup'
    const first = await records.proposeCandidate({
      content: '第一版会议纪要的要点',
      outputType: 'minutes',
      conversationKey: key
    })
    assert(first.candidate, '第一条应入队')
    assertEq(first.deduped, false, '第一条不是去重')
    const firstId = first.candidate.id

    clock.advance(5 * 60 * 1000) // 5 分钟后
    const second = await records.proposeCandidate({
      content: '第二版会议纪要的要点（修订）',
      outputType: 'minutes',
      conversationKey: key
    })
    assertEq(second.deduped, true, '应命中去重（覆盖更新）')
    assertEq(second.candidate.id, firstId, '应覆盖同一条，而不是新增')
    assertEq(second.candidate.content, '第二版会议纪要的要点（修订）', '内容应被覆盖')
    const candidates = await records.list({ status: RECORD_STATUS_CANDIDATE })
    const mine = candidates.filter((c) => decodeSourceRef(c.source_ref)?.conversationKey === key)
    assertEq(mine.length, 1, `同会话同类型应只保留 1 条候选（实际 ${mine.length}）`)

    // 不同会话 → 各自独立
    const otherConv = await records.proposeCandidate({
      content: '另一个会话产出的纪要要点',
      outputType: 'minutes',
      conversationKey: 'conv:work:tool:minutes-2'
    })
    assertEq(otherConv.deduped, false, '不同会话不应去重')
    // 不同产出类型 → 各自独立
    const otherType = await records.proposeCandidate({
      content: '今天做了三件事的日报草稿',
      outputType: 'report',
      conversationKey: key
    })
    assertEq(otherType.deduped, false, '不同产出类型不应去重')
    return `同会话同类型覆盖 ✓ 不同会话/类型独立 ✓`
  })

  await r.check('C5', '去重边界：超 30 分钟窗口 → 新增；已处理（非 candidate）→ 不参与去重', async () => {
    const key = 'conv:work:tool:boundary'
    const a = await records.proposeCandidate({
      content: '边界测试第一条内容',
      outputType: 'minutes',
      conversationKey: key
    })
    assertEq(a.deduped, false, '第一条入队')
    // 推进到刚过窗口
    clock.advance(CANDIDATE_DEDUP_WINDOW_MS + 1000)
    const b = await records.proposeCandidate({
      content: '边界测试第二条内容（超窗口）',
      outputType: 'minutes',
      conversationKey: key
    })
    assertEq(b.deduped, false, `超过 ${CANDIDATE_DEDUP_WINDOW_MS}ms 应新增而不是覆盖`)
    assertEq(b.candidate.id === a.candidate.id, false, '应是新的一条')

    // 已确认的候选不参与去重（用户已处理过，不能悄悄被改）
    await records.confirm(b.candidate.id)
    clock.advance(1000)
    const c = await records.proposeCandidate({
      content: '边界测试第三条内容（前一条已确认）',
      outputType: 'minutes',
      conversationKey: key
    })
    assertEq(c.deduped, false, '已 confirmed 的不应被覆盖更新')
    const confirmedRow = await records.get(b.candidate.id)
    assertEq(confirmedRow.content, '边界测试第二条内容（超窗口）', '已确认内容不得被后到候选改写')
    return `超窗口新增 ✓ 已确认不被改写 ✓`
  })

  // ── 状态机 ──
  await r.check('C6', '状态机：candidate→confirmed（可顺手改）/ →ignored / ignored→candidate', async () => {
    const key = 'conv:work:tool:statemachine'
    const p1 = await records.proposeCandidate({
      content: '状态机测试候选一',
      outputType: 'report',
      conversationKey: key
    })
    // 确认时可顺手改内容 + 事项 + 时间（§4.1 规则 1）
    const matter = await matters.create({ name: '状态机事项' })
    const confirmed = await records.confirm(p1.candidate.id, {
      content: '状态机测试候选一（确认时改过）',
      occurredTime: '15:30',
      matterId: matter.id
    })
    assertEq(confirmed.status, RECORD_STATUS_CONFIRMED, '应变为 confirmed')
    assertEq(confirmed.content, '状态机测试候选一（确认时改过）', '确认时应可改内容')
    assertEq(confirmed.occurred_time, '15:30', '确认时应可补时间')
    assertEq(confirmed.matter_id, matter.id, '确认时应可挂事项')
    assert(confirmed.confirmed_at, 'confirmed_at 应落库')
    // 幂等
    const again = await records.confirm(p1.candidate.id)
    assertEq(again.status, RECORD_STATUS_CONFIRMED, '重复 confirm 幂等')

    // ignored → 恢复
    const p2 = await records.proposeCandidate({
      content: '状态机测试候选二',
      outputType: 'report',
      conversationKey: key
    })
    const ignored = await records.ignore(p2.candidate.id)
    assertEq(ignored.status, RECORD_STATUS_IGNORED, '应变为 ignored')
    const restored = await records.restore(p2.candidate.id)
    assertEq(restored.status, RECORD_STATUS_CANDIDATE, '应可恢复为 candidate')
    // 非法迁移：confirmed 不能 restore / ignore
    const badRestore = await outcome(records.restore(p1.candidate.id))
    assertEq(badRestore.code, 'VALIDATION_ERROR', 'confirmed 不能 restore')
    const badIgnore = await outcome(records.ignore(p1.candidate.id))
    assertEq(badIgnore.code, 'VALIDATION_ERROR', 'confirmed 不能 ignore（只有 candidate 能）')
    return `confirm（可改）/ ignore / restore ✓ 非法迁移被拒 ✓`
  })

  await r.check('C7', '批量：不因单条失败中断（不存在/状态不符 → skipped）', async () => {
    const key = 'conv:work:tool:batch'
    const a = await records.proposeCandidate({ content: '批量候选甲内容', outputType: 'minutes', conversationKey: key })
    // 必须**推进过 30 分钟去重窗口**，否则 b 会覆盖 a（两者变成同一行，批量就无法验「两条独立记录」）
    clock.advance(CANDIDATE_DEDUP_WINDOW_MS + 1000)
    const b = await records.proposeCandidate({ content: '批量候选乙内容', outputType: 'minutes', conversationKey: key })
    assertEq(b.deduped, false, '超窗口后应是两条独立候选')
    assert(b.candidate.id !== a.candidate.id, 'a / b 应是不同行')
    // a 先确认掉，让它在批量里变成「状态不符」
    await records.confirm(a.candidate.id)
    const batch = await records.confirmBatch([b.candidate.id, 'ghost-record', a.candidate.id])
    assertEq(JSON.stringify(batch.affected), JSON.stringify([b.candidate.id]), '只应改动 b')
    assertEq(batch.skipped.length, 2, 'ghost 与已确认的应跳过')
    // 批量忽略
    clock.advance(CANDIDATE_DEDUP_WINDOW_MS + 1000)
    const c = await records.proposeCandidate({ content: '批量候选丙内容', outputType: 'minutes', conversationKey: key })
    const ignoreBatch = await records.ignoreBatch([c.candidate.id, 'ghost2'])
    assertEq(JSON.stringify(ignoreBatch.affected), JSON.stringify([c.candidate.id]), '忽略批量应改动 c')
    assertEq(ignoreBatch.skipped.length, 1, 'ghost2 应跳过')
    const empty = await outcome(records.confirmBatch([]))
    assertEq(empty.code, 'VALIDATION_ERROR', '空批量应被拒')
    return `confirmBatch affected=1 skipped=2；ignoreBatch affected=1 skipped=1`
  })

  // ── 双时间语义 ──
  await r.check('C8', '双时间语义：occurred_date 可≠入库日（补记）；occurred_time 可空', async () => {
    const ts = clock.now()
    const today = new Date(ts)
    const pad = (n) => String(n).padStart(2, '0')
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    // 不传 occurredDate → 默认今天（参数约定 5）
    const dflt = await records.create({ content: '不传日期默认今天' })
    assertEq(dflt.occurred_date, todayStr, '不传应默认今天')
    assertEq(dflt.occurred_time, null, '不传时间应为 null（时间未记）')
    // 补记：昨天的事今天记
    const back = await records.create({ content: '昨天补记的事', occurredDate: '2026-09-22' })
    assertEq(back.occurred_date, '2026-09-22', 'occurred_date 应存实际发生日')
    assert(Number(back.created_at) >= Number(back.updated_at) - 1, 'created_at 是入库时刻')
    // 有时间
    const timed = await records.create({ content: '下午开的会', occurredTime: '15:00' })
    assertEq(timed.occurred_time, '15:00', '时间应写入')
    // 校验
    const badDate = await outcome(records.create({ content: 'x', occurredDate: '2026-2-3' }))
    assertEq(badDate.code, 'VALIDATION_ERROR', '非严格日期应被拒')
    const badDate2 = await outcome(records.create({ content: 'x', occurredDate: '2026-02-30' }))
    assertEq(badDate2.code, 'VALIDATION_ERROR', '不存在日期应被拒')
    const badTime = await outcome(records.create({ content: 'x', occurredTime: '25:00' }))
    assertEq(badTime.code, 'VALIDATION_ERROR', '非法时间应被拒')
    const badTime2 = await outcome(records.create({ content: 'x', occurredTime: '9:00' }))
    assertEq(badTime2.code, 'VALIDATION_ERROR', '非 HH:MM 应被拒')
    assertEq(normalizeTime('  '), null, '空白时间应归一为 null')
    return `默认今天 ✓ 补记 2026-09-22 ✓ 时间未记 ✓ 严格校验 ✓`
  })

  await r.check('C9', 'ai_output 不能直接落事实层（来源≠事实，硬规则 4）', async () => {
    const bad = await outcome(
      records.create({ content: '想直接当事实的 AI 产出', source: 'ai_output' })
    )
    assertEq(bad.code, 'VALIDATION_ERROR', 'ai_output 走 create 应被拒')
    assert(bad.message.includes('proposeCandidate'), '错误信息应指出正确入口')
    // 手动登记仍是 confirmed
    const manual = await records.create({ content: '手动登记的一条' })
    assertEq(manual.status, RECORD_STATUS_CONFIRMED, '手动登记应直接 confirmed')
    assertEq(manual.source, 'manual', 'source 应为 manual')
    assert(manual.confirmed_at, '手动登记应落 confirmed_at')
    // source_ref 承载 JSON（去重键 + 溯源）
    const ref = decodeSourceRef(encodeSourceRef({ conversationKey: 'conv:work:qa', outputType: 'report', messageId: 'm1' }))
    assertEq(ref.conversationKey, 'conv:work:qa', 'source_ref 应可解码')
    assertEq(ref.outputType, 'report', 'outputType 应可解码')
    assertEq(ref.messageId, 'm1', 'messageId 应可解码')
    assertEq(decodeSourceRef('plain-todo-id'), null, '纯字符串（todo 来源）应解不出 JSON')
    return `ai_output 走 create 被拒；source_ref 编解码 ✓`
  })

  // ── 删除与列表 ──
  await r.check('C10', '删除即遗忘：物理删除（行真的没了）；幂等不报错', async () => {
    const rec = await records.create({ content: '待删除的记录' })
    const del = await records.delete(rec.id)
    assertEq(del.rowDeleted, true, '应真删除')
    const nf = await outcome(records.get(rec.id))
    assertEq(nf.code, 'NOT_FOUND', '删除后 get 应 NOT_FOUND')
    // 直连库确认行真的没了（不是软删）
    const rows = await database.request('activity_log.list', { where: { id: rec.id } })
    assertEq(rows.length, 0, '物理删除：库里不应再有该行')
    const again = await records.delete(rec.id)
    assertEq(again.rowDeleted, false, '再删应 false 不报错（参数约定 3）')
    return '物理删除 ✓ 幂等 ✓'
  })

  await r.check('C11', '列表：新→旧（参数约定 4）、默认只看 confirmed、LIKE 检索、状态过滤', async () => {
    const all = await records.list({ status: 'all', limit: 200 })
    assert(all.length >= 5, '应有若干记录')
    // 新→旧：occurred_date 倒序（同日按 created_at 倒序）
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]
      const cur = all[i]
      assert(prev.occurred_date >= cur.occurred_date, `occurred_date 必须倒序（第 ${i} 项违反）`)
      if (prev.occurred_date === cur.occurred_date) {
        assert(Number(prev.created_at) >= Number(cur.created_at), `同日应按 created_at 倒序（第 ${i} 项违反）`)
      }
    }
    // 默认只看 confirmed
    const dflt = await records.list({ limit: 200 })
    assert(dflt.every((row) => row.status === RECORD_STATUS_CONFIRMED), '不传 status 应只看 confirmed')
    assert(dflt.length < all.length, 'confirmed 应少于 all（库里还有候选/已忽略）')
    // LIKE 检索
    const hit = await records.list({ query: '活动方案', status: 'all', limit: 200 })
    assert(hit.length >= 1, '检索应命中')
    assert(hit.every((row) => row.content.includes('活动方案')), '命中项应包含关键词')
    const miss = await records.list({ query: '绝对不存在的词xyz', status: 'all', limit: 200 })
    assertEq(miss.length, 0, '不应命中')
    const blank = await records.list({ query: '   ', status: 'all', limit: 200 })
    assertEq(blank.length, all.length, '空检索词应不过滤')
    // 非法 status
    const badStatus = await outcome(records.list({ status: 'nope' }))
    assertEq(badStatus.code, 'VALIDATION_ERROR', '非法 status 应被拒')
    // 非法日期
    const badDate = await outcome(records.list({ date: '2026-2-3' }))
    assertEq(badDate.code, 'VALIDATION_ERROR', '非法日期应被拒')
    return `新→旧 ✓ 默认 confirmed ✓ LIKE 检索 ✓`
  })

  await r.check('C12', '局部更新：未传字段不动；内容/日期/时间/事项可改；状态不可改', async () => {
    const matter = await matters.create({ name: '更新测试事项' })
    const rec = await records.create({
      content: '原始内容',
      occurredDate: '2026-09-20',
      occurredTime: '09:00',
      matterId: matter.id
    })
    const updated = await records.update(rec.id, { content: '改过的内容' })
    assertEq(updated.content, '改过的内容', '内容应更新')
    assertEq(updated.occurred_date, '2026-09-20', '未传日期不得被清（局部更新）')
    assertEq(updated.occurred_time, '09:00', '未传时间不得被清')
    assertEq(updated.matter_id, matter.id, '未传事项不得被清')
    const cleared = await records.update(rec.id, { matterId: null, occurredTime: null })
    assertEq(cleared.matter_id, null, '显式 null 应清空事项')
    assertEq(cleared.occurred_time, null, '显式 null 应清空时间')
    // 状态不在白名单：传了也不生效
    const sneaky = await records.update(rec.id, { status: RECORD_STATUS_IGNORED })
    assertEq(sneaky.status, RECORD_STATUS_CONFIRMED, 'status 不可通过 update 修改')
    const empty = await outcome(records.update(rec.id, {}))
    assertEq(empty.ok, true, '空 patch 应幂等不报错')
    const badContent = await outcome(records.create({ content: '  ' }))
    assertEq(badContent.code, 'VALIDATION_ERROR', '空内容应被拒')
    return `局部更新 ✓ 显式清空 ✓ status 不可改 ✓`
  })

  await r.check('C13', 'IPC 契约静态核对：12 条 records 通道（§14）', async () => {
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'work.ts'), 'utf-8')
    const channels = [
      'work:records:list',
      'work:records:get',
      'work:records:create',
      'work:records:update',
      'work:records:delete',
      'work:records:confirm',
      'work:records:ignore',
      'work:records:restore',
      'work:records:confirmBatch',
      'work:records:ignoreBatch',
      'work:records:listFiltered',
      'work:records:proposeCandidate'
    ]
    const missing = channels.filter((c) => !src.includes(`'${c}'`))
    assertEq(missing.length, 0, '缺失通道: ' + missing.join(', '))
    // 契约里没有 records:restore，但 §4.1 状态机要求「ignored → candidate 可在已忽略筛选中找回」
    // —— 这里登记为「按状态机补齐的实现」，需回写基线 §14
    assert(/handle\(WORK_RECORDS_CHANNELS\.confirm, \(id: string, patch/.test(src), 'confirm 应 (id, patch)')
    assert(/handle\(WORK_RECORDS_CHANNELS\.delete, \(id: string\)/.test(src), 'delete 应 (id)')
    assertEq(normalizeForCompare('完成 活动方案，第二版。'), normalizeForCompare('完成活动方案第二版'), '归一化应去空白与标点')
    return `${channels.length} 条通道齐备；归一化比较 ✓`
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  if (database) {
    try {
      await database.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(200)
}

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-record.json'), result)

console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total} 通过，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
