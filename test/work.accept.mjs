// test/work.accept.mjs —— Commit 02 验收：profile / matters / todos + 待办状态机
//
// **打真实源码**：esbuild 把 electron/main/work/*.ts + 真 DatabaseClient + 真 db-worker 串起来，
// 在纯 Node 里跑真 SQLite（真 Worker 子进程、真建库、真迁移）。
//
// 覆盖点（对齐 PLAN-3.0.md §2.3 / §2.2.1 / §4.2 / §14 契约 / 参数约定）：
//   - profile：单行惰性建行、完整度六项等权、局部更新（未传不动）、空 patch 幂等
//   - matters：CRUD、色板校验、**幂等删除**（不存在 → false 不报错）、
//     删除后 todos/activity_log **挂空不删行**（§4.2 W7 语义）、suggestMatter 确定性匹配
//   - todos：**初始状态由 source 决定**（参数约定 7，三条全断言）、state 不接受传入、
//     confirm/ignore 与批量、complete 联动落记录 + 例事生成下一次、
//     uncomplete 撤回未编辑记录 / 保留已编辑记录并断开 source_ref、
//     状态机非法迁移被拒、幂等（重复 complete/uncomplete）、list 新→旧（参数约定 4）
//
// 用法：node test/work.accept.mjs    （npm run accept:work）

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
const runDir = join(tmpDir, `work-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')

// ── bundle 真源码 ─────────────────────────────────────────────────────────────
const dbPathBundled = bundleEntry('electron/main/database/database.ts', 'work-database.mjs')
const profilePath = bundleEntry('electron/main/work/profileManager.ts', 'work-profile.mjs')
const matterPath = bundleEntry('electron/main/work/matterManager.ts', 'work-matter.mjs')
const todoPath = bundleEntry('electron/main/work/todoManager.ts', 'work-todo.mjs')

const dbMod = await import(pathToFileURL(dbPathBundled).href)
const profileMod = await import(pathToFileURL(profilePath).href)
const matterMod = await import(pathToFileURL(matterPath).href)
const todoMod = await import(pathToFileURL(todoPath).href)

const { DatabaseClient } = dbMod
const { createProfileManager, computeCompleteness, PROFILE_COMPLETENESS_FIELDS, PROFILE_ROW_ID } = profileMod
const { createMatterManager, MATTER_COLOR_PALETTE, MATTER_STATUS_ACTIVE, MATTER_STATUS_ARCHIVED } = matterMod
const {
  createTodoManager,
  INITIAL_STATE_BY_SOURCE,
  TODO_STATE_CANDIDATE,
  TODO_STATE_CONFIRMED,
  TODO_STATE_DONE,
  TODO_STATE_IGNORED,
  normalizeDate,
  dateOf,
  nextDueDate
} = todoMod

const logger = () => {}

/** 可控时钟 + 可控 id（让断言不依赖真实时间/随机） */
function makeClock(startMs = Date.UTC(2026, 8, 23, 10, 0, 0)) {
  let t = startMs
  let n = 0
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
      return t
    },
    newId: () => `id-${++n}`
  }
}

const r = new Recorder('Commit 02 · profile / matters / todos')
let database = null

async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

try {
  // ── W0 前置：真 Worker 拉起 + 建库 + 迁移 ──
  await r.check('W0', '前置：真 DB Worker 拉起、建库、user_version=1、8 表', async () => {
    database = new DatabaseClient({
      dbPath,
      backupDir,
      workerScriptPath,
      nodePath,
      subprocessName: 'work-db-worker-commit02',
      requestTimeoutMs: 30_000,
      logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, 'Worker 应就绪')
    assertEq(st.userVersion, 1, 'user_version 应为 1')
    assertEq(st.tables.length, 8, `应有 8 张表（实际 ${st.tables.length}）`)
    return `pid=${st.workerPid} uv=${st.userVersion} tables=${st.tables.length}`
  })

  const clock = makeClock()
  const profile = createProfileManager({ database, logger })
  const matters = createMatterManager({ database, logger, now: clock.now, newId: clock.newId })
  const todos = createTodoManager({ database, logger, now: clock.now, newId: clock.newId })

  // ══ profile ═══════════════════════════════════════════════════════════════

  await r.check('P1', '单行画像：首次 get 惰性建行，完整度 0/6', async () => {
    const view = await profile.get()
    assertEq(view.profile.id, PROFILE_ROW_ID, `画像行 id 应为 ${PROFILE_ROW_ID}`)
    assertEq(view.completeness.total, PROFILE_COMPLETENESS_FIELDS.length, '完整度总分应为 6')
    assertEq(view.completeness.filled, 0, '初始应 0 项已填')
    assertEq(view.completeness.percent, 0, '初始完整度应为 0%')
    assertEq(view.completeness.missing.length, 6, '应缺 6 项')
    // 再 get 一次不应产生第二行
    await profile.get()
    const rows = await database.request('profile.list', {})
    assertEq(rows.length, 1, '单行表不应出现第二行')
    return `id=${view.profile.id} percent=0% rows=1`
  })

  await r.check('P2', '局部更新：只改传了的字段，未传不动；完整度随之上升', async () => {
    const after = await profile.update({ callName: '小北', position: '产品经理' })
    assertEq(after.profile.call_name, '小北', 'call_name 应写入')
    assertEq(after.profile.position, '产品经理', 'position 应写入')
    assertEq(after.completeness.filled, 2, '应 2 项已填')
    assertEq(after.completeness.percent, 33, '2/6 应为 33%')
    // 第二次只改一个字段：前两个不能被清掉
    const after2 = await profile.update({ company: '某公司' })
    assertEq(after2.profile.call_name, '小北', '未传字段不得被清空（局部更新）')
    assertEq(after2.profile.position, '产品经理', '未传字段不得被清空')
    assertEq(after2.profile.company, '某公司', '新字段应写入')
    assertEq(after2.completeness.filled, 3, '应 3 项已填')
    return `filled 0→2→3；未传字段保持`
  })

  await r.check('P3', '显式 null / 空串 = 清空；空 patch 幂等不报错', async () => {
    const cleared = await profile.update({ callName: null })
    assertEq(cleared.profile.call_name, null, '显式 null 应清空')
    const blank = await profile.update({ position: '   ' })
    assertEq(blank.profile.position, null, '空白串应归一为 null')
    const empty = await outcome(profile.update({}))
    assertEq(empty.ok, true, '空 patch 不应报错（幂等）')
    return 'null/空白 → 清空；空 patch 幂等'
  })

  await r.check('P4', '字段校验：非字符串被拒；完整度计算是纯函数可断言', async () => {
    const bad = await outcome(profile.update({ callName: 123 }))
    assertEq(bad.code, 'VALIDATION_ERROR', '非字符串应被拒')
    const c = computeCompleteness({
      id: PROFILE_ROW_ID,
      call_name: 'a',
      position: 'b',
      department: null,
      company: 'c',
      report_to: null,
      tone: 'd',
      report_style: null,
      industry: null,
      created_at: 0,
      updated_at: 0
    })
    assertEq(c.filled, 4, '4 项已填')
    assertEq(c.percent, 67, '4/6 应为 67%')
    assertEq(JSON.stringify(c.missing), JSON.stringify(['department', 'report_to']), '缺失项应可枚举')
    return `非法类型被拒；computeCompleteness 纯函数断言通过`
  })

  // ══ matters ══════════════════════════════════════════════════════════════

  await r.check('M1', '事项 CRUD：create 默认 active；list 新→旧；get 不存在 → NOT_FOUND', async () => {
    const a = await matters.create({ name: 'Q3活动' })
    assertEq(a.status, MATTER_STATUS_ACTIVE, '默认应为 active')
    assertEq(a.color, null, '不传 color 应为 null（UI 用默认灰）')
    // 推进时钟：让两次 create 的 created_at 不同，否则「新→旧」打平无法断言
    clock.advance(1000)
    const b = await matters.create({ name: '招聘', color: MATTER_COLOR_PALETTE[1] })
    assertEq(b.color, MATTER_COLOR_PALETTE[1], 'color 应写入')
    const list = await matters.list()
    assertEq(list.length, 2, '应有 2 个事项')
    // 参数约定 4：list 新→旧（后建的在前）
    assertEq(list[0].id, b.id, 'list 应新→旧（后建的在前）')
    assertEq(list[1].id, a.id, '较早的应排在后')
    const nf = await outcome(matters.get('ghost'))
    assertEq(nf.code, 'NOT_FOUND', '不存在应 NOT_FOUND')
    return `active 默认 ✓ color ✓ list 新→旧 ✓`
  })

  await r.check('M2', 'update 局部更新 + 状态归档；非法 color/status 被拒', async () => {
    const list = await matters.list()
    const target = list.find((m) => m.name === '招聘')
    const renamed = await matters.update(target.id, { name: '2026招聘' })
    assertEq(renamed.name, '2026招聘', 'name 应更新')
    assertEq(renamed.color, MATTER_COLOR_PALETTE[1], '未传 color 不得被清')
    const archived = await matters.update(target.id, { status: MATTER_STATUS_ARCHIVED })
    assertEq(archived.status, MATTER_STATUS_ARCHIVED, '应可归档')
    assertEq((await matters.list({ status: MATTER_STATUS_ACTIVE })).length, 1, 'active 过滤应只剩 1 个')
    assertEq((await matters.list({ status: 'all' })).length, 2, 'all 应 2 个')
    const badColor = await outcome(matters.update(target.id, { color: 'red' }))
    assertEq(badColor.code, 'VALIDATION_ERROR', '非法 color 应被拒')
    const badStatus = await outcome(matters.update(target.id, { status: 'done' }))
    assertEq(badStatus.code, 'VALIDATION_ERROR', '非法 status 应被拒（事项没有 done 态）')
    const emptyName = await outcome(matters.create({ name: '   ' }))
    assertEq(emptyName.code, 'VALIDATION_ERROR', '空名称应被拒')
    return '局部更新 ✓ 归档 ✓ 非法值被拒 ✓'
  })

  await r.check('M3', '幂等删除（参数约定 3）：不存在 → rowDeleted:false 且不报错', async () => {
    const ghost = await outcome(matters.delete('ghost-matter'))
    assertEq(ghost.ok, true, '删除不存在的应成功返回（幂等，不返回 NOT_FOUND）')
    assertEq(ghost.value.rowDeleted, false, 'rowDeleted 应为 false')
    const list = await matters.list({ status: 'all' })
    const victim = list.find((m) => m.name === '2026招聘')
    const real = await matters.delete(victim.id)
    assertEq(real.rowDeleted, true, '真实删除应 true')
    const again = await matters.delete(victim.id)
    assertEq(again.rowDeleted, false, '再删应 false（幂等）')
    return 'ghost→false；真删→true；再删→false；均不报错'
  })

  await r.check('M4', '删事项 → todos/activity_log 挂空但不删行（弱关联 SET NULL）', async () => {
    const matter = await matters.create({ name: '待删事项' })
    const todo = await todos.create({ title: '挂在事项上的待办', matterId: matter.id })
    assertEq(todo.matter_id, matter.id, '待办应挂上')
    await database.request('activity_log.create', {
      data: {
        id: 'rec-m4',
        content: '挂在事项上的记录',
        occurred_date: '2026-09-23',
        source: 'manual',
        status: 'confirmed',
        matter_id: matter.id,
        created_at: clock.now(),
        updated_at: clock.now()
      }
    })
    const del = await matters.delete(matter.id)
    assertEq(del.rowDeleted, true, '事项应被删除')
    const todoAfter = await todos.get(todo.id)
    assertEq(todoAfter.matter_id, null, '待办应挂空')
    const recAfter = await database.request('activity_log.get', { keys: { id: 'rec-m4' } })
    assert(recAfter, '记录不应被级联删除')
    assertEq(recAfter.matter_id, null, '记录应挂空')
    return '事项删除 → 待办/记录挂空，行数不变'
  })

  await r.check('M5', 'suggestMatter：确定性关键词匹配，匹配不到返回 null（不硬凑）', async () => {
    const m = await matters.create({ name: 'Q3活动方案' })
    const hit = await matters.suggestMatter('今天推进了 Q3活动方案的初稿')
    assertEq(hit.matterId, m.id, '应命中包含完整名称的事项')
    assertEq(hit.reason.includes('Q3活动方案'), true, '理由应可展示')
    const miss = await matters.suggestMatter('跟这些事项完全无关的一段话')
    assertEq(miss.matterId, null, '匹配不到应返回 null（不硬凑）')
    assertEq(miss.candidates.length, 0, '候选应为空')
    const empty = await outcome(matters.suggestMatter('   '))
    assertEq(empty.code, 'VALIDATION_ERROR', '空文本应被拒')
    return `命中 ${hit.candidates.length} 个候选；无重合 → null`
  })

  // ══ todos ════════════════════════════════════════════════════════════════

  await r.check('T1', '初始状态由 source 决定（参数约定 7）：manual/extracted/routine 三条全断言', async () => {
    // 这是 §14 参数约定 7 的核心：state 不接受传入
    assertEq(INITIAL_STATE_BY_SOURCE.manual, TODO_STATE_CONFIRMED, 'manual → confirmed')
    assertEq(INITIAL_STATE_BY_SOURCE.extracted, TODO_STATE_CANDIDATE, 'extracted → candidate')
    assertEq(INITIAL_STATE_BY_SOURCE.routine, TODO_STATE_CONFIRMED, 'routine → confirmed')

    const manual = await todos.create({ title: '手动待办' })
    assertEq(manual.source, 'manual', 'source 应默认 manual')
    assertEq(manual.state, TODO_STATE_CONFIRMED, 'manual 应直接 confirmed')
    const extracted = await todos.create({ title: 'AI 提取的待办', source: 'extracted' })
    assertEq(extracted.state, TODO_STATE_CANDIDATE, 'extracted 应为 candidate')
    const routine = await todos.create({ title: '每日站会', source: 'routine', routineRule: 'daily' })
    assertEq(routine.state, TODO_STATE_CONFIRMED, 'routine 应为 confirmed')
    assertEq(routine.routine_rule, 'daily', 'routine_rule 应写入')

    // 显式传 state 必须被忽略（不是报错，而是不被采纳）
    const sneaky = await todos.create({ title: '想直接 done', state: TODO_STATE_DONE })
    assertEq(sneaky.state, TODO_STATE_CONFIRMED, 'state 不由调用方传，应仍为 confirmed')

    const badSource = await outcome(todos.create({ title: 'x', source: 'telepathy' }))
    assertEq(badSource.code, 'VALIDATION_ERROR', '非法 source 应被拒')
    const routineNoRule = await outcome(todos.create({ title: 'x', source: 'routine' }))
    assertEq(routineNoRule.code, 'VALIDATION_ERROR', '例事必须带 routine_rule')
    return 'manual→confirmed / extracted→candidate / routine→confirmed；state 传入被忽略'
  })

  await r.check('T2', 'confirm / ignore：candidate → confirmed / ignored；批量不因单条失败中断', async () => {
    const c1 = await todos.create({ title: 'AI 提取 A', source: 'extracted' })
    const c2 = await todos.create({ title: 'AI 提取 B', source: 'extracted' })
    const c3 = await todos.create({ title: 'AI 提取 C', source: 'extracted' })
    const confirmed = await todos.confirm(c1.id)
    assertEq(confirmed.state, TODO_STATE_CONFIRMED, 'confirm 后应 confirmed')
    const ignored = await todos.ignore(c2.id)
    assertEq(ignored.state, TODO_STATE_IGNORED, 'ignore 后应 ignored')
    // 批量：c3 有效 + ghost 不存在 + c1 已是 confirmed（状态不符）
    const batch = await todos.confirmBatch([c3.id, 'ghost', c1.id])
    assertEq(JSON.stringify(batch.affected), JSON.stringify([c3.id]), '只应改动 c3')
    assertEq(batch.skipped.length, 2, 'ghost 与状态不符的应跳过')
    // 幂等
    const again = await todos.confirm(c1.id)
    assertEq(again.state, TODO_STATE_CONFIRMED, '重复 confirm 幂等')
    // 非法迁移：confirmed 不能 confirm（已在上面幂等），ignored 不能 complete
    const badComplete = await outcome(todos.complete(c2.id))
    assertEq(badComplete.code, 'VALIDATION_ERROR', 'ignored 不能直接 complete')
    const emptyBatch = await outcome(todos.confirmBatch([]))
    assertEq(emptyBatch.code, 'VALIDATION_ERROR', '空批量应被拒')
    return `confirm/ignore ✓ 批量 affected=1 skipped=2 ✓ 非法迁移被拒 ✓`
  })

  await r.check('T3', '勾完成联动 1：自动落工作记录（source=todo, confirmed, source_ref=todoId）', async () => {
    const todo = await todos.create({ title: '提交上周数据', matterId: null })
    const res = await todos.complete(todo.id)
    assertEq(res.todo.state, TODO_STATE_DONE, '应变为 done')
    assert(res.todo.done_at, 'done_at 应落库')
    assert(res.recordId, '应返回自动记录 id')
    const rec = await database.request('activity_log.get', { keys: { id: res.recordId } })
    assertEq(rec.source, 'todo', '记录 source 应为 todo')
    assertEq(rec.source_ref, todo.id, 'source_ref 应指向待办')
    assertEq(rec.status, 'confirmed', '用户动作 → 直接 confirmed（来源≠事实）')
    assertEq(rec.content, '提交上周数据', '内容应等于待办标题')
    assertEq(rec.occurred_date, dateOf(clock.now()), '发生日应为当天')
    assertEq(rec.occurred_time, null, '时间未记（双时间语义）')
    // 幂等：再勾一次不重复落记录
    const again = await todos.complete(todo.id)
    assertEq(again.recordId, null, '重复 complete 不应再落记录')
    const recs = await database.request('activity_log.list', { where: { source_ref: todo.id } })
    assertEq(recs.length, 1, '记录不应重复')
    return `记录 ${res.recordId} 落库；重复 complete 幂等`
  })

  await r.check('T4', '取消勾选：未编辑记录一并撤回（记录数回到 0）', async () => {
    const todo = await todos.create({ title: '临时待办' })
    const done = await todos.complete(todo.id)
    const before = await database.request('activity_log.list', { where: { source_ref: todo.id } })
    assertEq(before.length, 1, '前置：应有 1 条自动记录')
    const back = await todos.uncomplete(todo.id)
    assertEq(back.todo.state, TODO_STATE_CONFIRMED, '应回到 confirmed')
    assertEq(back.todo.done_at, null, 'done_at 应清空')
    assertEq(back.recordRetracted, true, '未编辑记录应被撤回')
    const after = await database.request('activity_log.list', { where: { source_ref: todo.id } })
    assertEq(after.length, 0, '记录应被撤回')
    assertEq(done.recordId !== null, true, '前置记录确实存在过')
    return 'done → confirmed，自动记录被撤回'
  })

  await r.check('T5', '取消勾选：已编辑记录保留并断开 source_ref（不丢用户编辑）', async () => {
    const todo = await todos.create({ title: '会被编辑的待办' })
    const done = await todos.complete(todo.id)
    // 用户编辑了那条自动记录
    clock.advance(60_000)
    await database.request('activity_log.update', {
      keys: { id: done.recordId },
      data: { content: '用户改写过的内容', updated_at: clock.now() },
      required: true
    })
    const back = await todos.uncomplete(todo.id)
    assertEq(back.recordDetached, true, '已编辑记录应保留并断开关联')
    assertEq(back.recordRetracted, false, '不应撤回已编辑记录')
    const rec = await database.request('activity_log.get', { keys: { id: done.recordId } })
    assert(rec, '记录应仍在（用户编辑不能丢）')
    assertEq(rec.content, '用户改写过的内容', '编辑内容应保留')
    assertEq(rec.source_ref, null, 'source_ref 应断开')
    return `记录 ${done.recordId} 保留、内容不变、source_ref=null`
  })

  await r.check('T6', '例事联动 3：routine 勾完成 → 自动生成下一次 confirmed(open) + 落记录', async () => {
    const routine = await todos.create({ title: '每日站会', source: 'routine', routineRule: 'daily' })
    const res = await todos.complete(routine.id)
    assert(res.nextTodoId, '例事应生成下一次')
    const next = await todos.get(res.nextTodoId)
    assertEq(next.state, TODO_STATE_CONFIRMED, '下一次应为 confirmed(open)')
    assertEq(next.source, 'routine', '下一次应仍是 routine')
    assertEq(next.routine_rule, 'daily', '规则应延续')
    assertEq(next.title, '每日站会', '标题应延续')
    assertEq(next.due_date, nextDueDate('daily', clock.now()), '到期日应为次日')
    assertEq(next.id === routine.id, false, '应是新的一条')
    const recs = await database.request('activity_log.list', { where: { source_ref: routine.id } })
    assertEq(recs.length, 1, '例事完成也应落记录')
    // 非例事不生成下一次
    const plain = await todos.create({ title: '普通待办' })
    const plainRes = await todos.complete(plain.id)
    assertEq(plainRes.nextTodoId, null, '非例事不应生成下一次')
    return `daily → 下次 ${next.due_date}；非例事不生成`
  })

  await r.check('T7', 'update 局部更新；不允许改 state；日期严格校验', async () => {
    const todo = await todos.create({ title: '原名', dueDate: '2026-09-30' })
    const updated = await todos.update(todo.id, { title: '新名' })
    assertEq(updated.title, '新名', 'title 应更新')
    assertEq(updated.due_date, '2026-09-30', '未传字段不得被清（局部更新）')
    const cleared = await todos.update(todo.id, { dueDate: null })
    assertEq(cleared.due_date, null, '显式 null 应清空')
    // state 不在白名单：传了也不生效
    const sneaky = await todos.update(todo.id, { state: TODO_STATE_DONE })
    assertEq(sneaky.state, TODO_STATE_CONFIRMED, 'state 不可通过 update 修改')
    const badDate = await outcome(todos.create({ title: 'x', dueDate: '2026-2-3' }))
    assertEq(badDate.code, 'VALIDATION_ERROR', '非严格 YYYY-MM-DD 应被拒')
    const badDate2 = await outcome(todos.create({ title: 'x', dueDate: '2026-02-30' }))
    assertEq(badDate2.code, 'VALIDATION_ERROR', '不存在的日期应被拒')
    const emptyTitle = await outcome(todos.create({ title: '  ' }))
    assertEq(emptyTitle.code, 'VALIDATION_ERROR', '空标题应被拒')
    return '局部更新 ✓ state 不可改 ✓ 日期严格校验 ✓'
  })

  await r.check('T8', 'list 新→旧（参数约定 4）+ state 过滤 + 幂等删除', async () => {
    const list = await todos.list({ limit: 50 })
    assert(list.length >= 5, '应有若干待办')
    for (let i = 1; i < list.length; i++) {
      assert(
        Number(list[i - 1].created_at) >= Number(list[i].created_at),
        `list 必须新→旧（第 ${i} 项违反）`
      )
    }
    const candidates = await todos.list({ state: TODO_STATE_CANDIDATE })
    assert(candidates.every((t) => t.state === TODO_STATE_CANDIDATE), 'state 过滤应生效')
    const badState = await outcome(todos.list({ state: 'nope' }))
    assertEq(badState.code, 'VALIDATION_ERROR', '非法 state 应被拒')
    const ghost = await todos.delete('ghost-todo')
    assertEq(ghost.rowDeleted, false, '删不存在应 false 不报错（参数约定 3）')
    const victim = list[0].id
    const real = await todos.delete(victim)
    assertEq(real.rowDeleted, true, '真删应 true')
    const nf = await outcome(todos.get(victim))
    assertEq(nf.code, 'NOT_FOUND', '删除后 get 应 NOT_FOUND')
    return `list 新→旧 ✓ state 过滤 ✓ 幂等删除 ✓`
  })

  await r.check('T9', 'IPC 契约静态核对：通道名与参数形状（§14）', async () => {
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'work.ts'), 'utf-8')
    const channels = [
      'work:profile:get',
      'work:profile:update',
      'work:matters:list',
      'work:matters:create',
      'work:matters:update',
      'work:matters:delete',
      'work:matters:suggestMatter',
      'work:todos:list',
      'work:todos:create',
      'work:todos:update',
      'work:todos:delete',
      'work:todos:complete',
      'work:todos:uncomplete',
      'work:todos:confirm',
      'work:todos:ignore',
      'work:todos:confirmBatch',
      'work:todos:ignoreBatch'
    ]
    const missing = channels.filter((c) => !src.includes(`'${c}'`))
    assertEq(missing.length, 0, '缺失通道: ' + missing.join(', '))
    // id 是首个位置参数（不是包在对象里）
    assert(/handle\(WORK_MATTERS_CHANNELS\.update, \(id: string, patch/.test(src), 'update 应 (id, patch) 位置参数')
    assert(/handle\(WORK_TODOS_CHANNELS\.complete, \(id: string\)/.test(src), 'complete 应 (id) 位置参数')
    // 失败信封统一
    assert(src.includes('toErrorEnvelope'), '应走统一错误信封')
    return `${channels.length} 条通道齐备；id 位置参数；统一信封`
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
writeJson(join(__dirname, 'accept-result-work.json'), result)

console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total} 通过，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
