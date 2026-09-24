// test/wizard.accept.mjs —— Commit 09 验收：冷启动向导 + 两个固定本地通知
//
// **打真实源码**：真 wizardManager / reminderManager（bundle）+ 真 DatabaseClient；
// read-old-db.mjs 用便携 Node 真跑，旧库 fixture 用 node:sqlite 现造 2.0 schema。
//
// 覆盖（对齐 §八 Day1 / 硬规则 17 / 硬规则 22）：
//   Wizard：
//     - 首启 consent=false completed=false；无旧库时 oldDb=null
//     - grantConsent；未同意 complete → VALIDATION_ERROR；同意后 complete
//     - 旧库检测：locateOldDbs 注入 → oldDb 在场
//     - 三分支：keep（读映射，read-old-db 真跑）/ fresh / later；非法决定拒；keep 无库 NOT_FOUND
//     - 旧库脚本只读（fixture 里放 businesses → company 映射）
//   Reminder：
//     - 默认开启；setEnabled 持久化；非法 id 拒
//     - check：时刻窗口外不发；进入窗口且开启 → 触发一次；窗口内重复 check 不重发；关闭后不发
//     - notifier 是注入假件（记录通知），不依赖 electron
//
// 用法：node test/wizard.accept.mjs（npm run accept:wizard）

import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import {
  Recorder, __dirname, assert, assertEq, bundleEntry, printResult,
  resolveNodePath, sleep, tmpDir, workerScriptPath, writeJson
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, `wizard-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
const legacyDir = join(runDir, 'legacy2', 'data')
mkdirSync(legacyDir, { recursive: true })

const dbB = bundleEntry('electron/main/database/database.ts', 'wz-database.mjs')
const wizardB = bundleEntry('electron/main/work/wizardManager.ts', 'wz-wizard.mjs')
const reminderB = bundleEntry('electron/main/work/reminderManager.ts', 'wz-reminder.mjs')
const todoB = bundleEntry('electron/main/work/todoManager.ts', 'wz-todo.mjs')

const { DatabaseClient } = await import(pathToFileURL(dbB).href)
const wizardMod = await import(pathToFileURL(wizardB).href)
const reminderMod = await import(pathToFileURL(reminderB).href)
const todoMod = await import(pathToFileURL(todoB).href)

const { createWizardManager, OLDDB, CONSENT_GRANTED } = wizardMod
const { createReminderManager, REMINDERS, REMINDER_TIMES } = reminderMod
const { TodoManager } = todoMod

const logger = () => {}
const r = new Recorder('Commit 09 · 冷启动向导 + 本地提醒')
let database = null

async function outcome(p) {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return { ok: false, code: e?.code, message: e?.message || String(e), details: e?.details }
  }
}

function execFile(file, args, opts) {
  return new Promise((res, rej) =>
    execFileCb(file, args, opts ?? {}, (err, stdout, stderr) =>
      err ? rej({ err, stderr }) : res({ stdout, stderr })
    )
  )
}

/**
 * 用便携 Node 造一个 2.0 schema 旧库 fixture（businesses 表）。
 * 走子进程是因为 Electron 主进程的 Node 无 node:sqlite；便携 Node 有。
 */
const legacyDbPath = join(legacyDir, 'umi-claw.db')
const makeLegacyScript = join(runDir, 'make-legacy.mjs')
const makeLegacy = `
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
const target = ${JSON.stringify(legacyDbPath)}
mkdirSync(dirname(target), { recursive: true })
const db = new DatabaseSync(target)
db.exec("CREATE TABLE businesses (id INTEGER PRIMARY KEY, name TEXT, brand TEXT, tone TEXT)")
db.prepare("INSERT INTO businesses (name, brand, tone) VALUES (?, ?, ?)").run("拾光摄影", "拾光", "温和专业")
db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, industry TEXT)")
db.prepare("INSERT INTO projects (industry) VALUES (?)").run("摄影")
db.close()
console.log('legacy fixture written')
`
const { writeFileSync } = await import('node:fs')
writeFileSync(makeLegacyScript, makeLegacy)

try {
  await r.check('Z0', '前置：便携 Node 造 2.0 旧库 fixture + 真 Worker/建库', async () => {
    const { stdout } = await execFile(nodePath, [makeLegacyScript], { timeout: 15_000 })
    assert(stdout.includes('legacy fixture'), '旧库 fixture 生成')
    assert(existsSync(legacyDbPath), '旧库 db 文件存在')

    database = new DatabaseClient({
      dbPath, backupDir, workerScriptPath, nodePath,
      subprocessName: 'work-db-worker-commit09', requestTimeoutMs: 30_000, logger
    })
    const st = await database.dbStatus({ initialize: true })
    assertEq(st.ready, true, '新库 Worker ready')
    assertEq(st.tables.length, 8, '8 表')
    return `legacy + new db 就绪`
  })

  // 定位器：返回固定的旧库信息（指向 fixture）
  const locate = () => [{ version: '2.0', dbPath: legacyDbPath, present: true }]
  // readOldDb：复刻主进程逻辑——调用便携 Node 跑 read-old-db.mjs
  const readOldDb = async (info) => {
    const script = join(__dirname, '..', 'resources', 'database', 'read-old-db.mjs')
    const { stdout } = await execFile(
      nodePath,
      [script, '--dbPath', info.dbPath, '--version', info.version],
      { timeout: 15_000, maxBuffer: 1024 * 1024 }
    )
    // 拍平：与主进程 readLegacyDb 同契约（WizardManager 要 OldDbMapping，不是脚本原始输出）
    const parsed = JSON.parse(stdout)
    return { ...parsed.mapping, displayOnlyCount: Number(parsed.displayOnlyCount ?? 0) }
  }

  const wizard = createWizardManager({ database, locateOldDbs: locate, readOldDb, logger })

  // ── 首启状态 ──
  await r.check('Z1', '首启：consent=false completed=false；检测到旧库 2.0', async () => {
    const s = await wizard.status()
    assertEq(s.consent, false, '未同意')
    assertEq(s.completed, false, '未完成')
    assert(s.oldDb && s.oldDb.version === '2.0', '检测到 2.0 旧库')
    assertEq(s.oldDbDecision, null, '初始无决定')
    return '首启状态 ✓'
  })

  // ── consent 必过 ──
  await r.check('Z2', '未同意隐私告知 → complete VALIDATION_ERROR；grantConsent 后 complete', async () => {
    const blocked = await outcome(wizard.complete())
    assertEq(blocked.code, 'VALIDATION_ERROR', '不能跳过 consent')
    assertEq(blocked.details?.reason, 'consent-required', '原因可分支')
    // 启动闸门：未同意时 ensureConsent 必须拒（北：启动 OpenClaw 前要校验）
    const gateBlocked = await outcome(wizard.ensureConsent())
    assertEq(gateBlocked.code, 'VALIDATION_ERROR', '未同意不得启动')
    assertEq(gateBlocked.details?.reason, 'consent-required', '闸门原因可分支')
    const before = await wizard.status()
    assertEq(before.consentAt, null, '未同意时无同意时间')

    const g = await wizard.grantConsent()
    assertEq(CONSENT_GRANTED, 'granted', '常量')
    assert(g.consentAt > 0, '同意时间被记录（设置页反显用）')
    const s2 = await wizard.status()
    assertEq(s2.consent, true, '已同意')
    assertEq(s2.consentAt, g.consentAt, 'status 回读同意时间')
    // 同意后闸门放行
    const gateOk = await wizard.ensureConsent()
    assertEq(gateOk.consent, true, '同意后闸门放行')
    // 重复同意保留首次时间（不刷新）
    const g2 = await wizard.grantConsent()
    assertEq(g2.consentAt, g.consentAt, '重复同意保留首次时间')

    await wizard.complete()
    const s3 = await wizard.status()
    assertEq(s3.completed, true, '向导完成')
    return 'consent 必过 + 启动闸门 ✓'
  })

  // ── 撤销同意（北：同意只弹一次，得能重新测）──
  await r.check('Z6', '撤销同意：清标记与时间；启动闸门重新生效；可再次同意；不动 completed', async () => {
    // 前置：Z2 已同意且已完成向导
    const pre = await wizard.status()
    assertEq(pre.consent, true, '前置：已同意')
    assertEq(pre.completed, true, '前置：向导已完成')

    const rv = await wizard.revokeConsent()
    assertEq(rv.consent, false, '撤销返回未同意')

    const after = await wizard.status()
    assertEq(after.consent, false, '撤销后 consent=false')
    assertEq(after.consentAt, null, '撤销后同意时间清空')
    // 关键：向导完成状态**不受影响**（撤销只针对协议，不是重置向导）
    assertEq(after.completed, true, '撤销不动 completed')

    // 启动闸门重新生效
    const gate = await outcome(wizard.ensureConsent())
    assertEq(gate.code, 'VALIDATION_ERROR', '撤销后不得启动 OpenClaw')
    assertEq(gate.details?.reason, 'consent-required', '闸门原因可分支')

    // 可再次同意，且拿到**新的**同意时间（不是旧的）
    const again = await wizard.grantConsent()
    assertEq(again.consent, true, '可再次同意')
    assert(again.consentAt > 0, '再次同意有时间')
    const s2 = await wizard.status()
    assertEq(s2.consent, true, 'status 回读已同意')
    assertEq(s2.consentAt, again.consentAt, '回读新时间')
    const gateOk = await wizard.ensureConsent()
    assertEq(gateOk.consent, true, '再次同意后闸门放行')
    return '撤销/重同意 ✓'
  })

  // ── 三分支 ──
  await r.check('Z3', '三分支 keep：read-old-db 只读真跑，映射出 company/tone/industry', async () => {
    // 注意 Z2 已 complete；decide 仍可调用（设置里可改）
    const res = await wizard.decide(OLDDB.KEEP)
    assertEq(res.decision, 'keep', '决定 keep')
    // fixture businesses.name=拾光摄影 → company；tone；projects.industry
    const mapping = res.mapping
    assert(mapping, '返回映射')
    assertEq(mapping.company, '拾光摄影', `company 映射（实际 ${mapping.company}）`)
    assertEq(mapping.tone, '温和专业', 'tone 映射')
    assertEq(mapping.displayOnlyCount >= 2, true, `displayOnlyCount 计其余事实（实际 ${mapping.displayOnlyCount}）`)
    // readMapping 单独可再取
    const again = await wizard.readMapping()
    assertEq(again.company, '拾光摄影', 'readMapping 只读一致')
    return 'keep 只读映射 ✓（不写旧库）'
  })

  await r.check('Z4', '三分支 fresh / later 可记录；非法决定拒；keep 无旧库 NOT_FOUND', async () => {
    const fresh = await wizard.decide(OLDDB.FRESH)
    assertEq(fresh.decision, 'fresh', 'fresh')
    const later = await wizard.decide(OLDDB.LATER)
    assertEq(later.decision, 'later', 'later')
    const status = await wizard.status()
    assertEq(status.oldDbDecision, OLDDB.LATER, '决定持久化')

    const bad = await outcome(wizard.decide('telepathy'))
    assertEq(bad.code, 'VALIDATION_ERROR', '非法决定拒')

    // keep 但无旧库：用空 locator 的新 manager
    const wizardNoOld = createWizardManager({ database, locateOldDbs: () => [], readOldDb, logger })
    const noOld = await outcome(wizardNoOld.decide(OLDDB.KEEP))
    assertEq(noOld.code, 'NOT_FOUND', 'keep 无旧库 NOT_FOUND')
    return 'fresh/later + 校验 ✓'
  })

  // ── read-old-db 脚本只读性：坏路径退出码非0 ──
  await r.check('Z5', 'read-old-db 只读：坏路径/缺失文件 → 非0退出（绝不静默成功）', async () => {
    const script = join(__dirname, '..', 'resources', 'database', 'read-old-db.mjs')
    const bad = await outcome(execFile(nodePath, [script, '--dbPath', join(runDir, 'nope.db'), '--version', '2.0']))
    assertEq(bad.ok, false, '缺文件退出非0')
    // 旧库文件未被写坏（fixture 仍可读）
    const { stdout } = await execFile(nodePath, [script, '--dbPath', legacyDbPath, '--version', '2.0'], { maxBuffer: 1024 * 1024 })
    assert(JSON.parse(stdout).mapping.company === '拾光摄影', '旧库仍完好（未被写）')
    return '只读失败语义 ✓'
  })

  // ── Reminder ──
  const sentNotifications = []
  const notifier = (id, payload) => sentNotifications.push({ id, payload })

  // 构造一个「正好在 report 窗口内」的时钟：2026-09-23 18:30
  const reportNow = new Date(2026, 8, 23, 18, 30, 0).getTime()
  const morningSummary = async () => ({ count: 2, titles: ['待办甲', '待办乙'] })

  await r.check('M1', 'reminder 默认开启；setEnabled 持久化；非法 id 拒', async () => {
    const rem = createReminderManager({ database, notifier, getMorningSummary: morningSummary, now: () => reportNow })
    assertEq(await rem.isEnabled(REMINDERS.REPORT), true, '默认开启')
    assertEq(await rem.isEnabled(REMINDERS.MORNING), true, 'morning 默认开启')
    await rem.setEnabled(REMINDERS.REPORT, false)
    assertEq(await rem.isEnabled(REMINDERS.REPORT), false, '关闭持久化')
    const badId = await outcome(rem.isEnabled('lunch'))
    assertEq(badId.code, 'VALIDATION_ERROR', '非法 id 拒')
    const badVal = await outcome(rem.setEnabled(REMINDERS.MORNING, 'yes'))
    assertEq(badVal.code, 'VALIDATION_ERROR', 'enabled 非布尔拒')
    assertEq(REMINDER_TIMES.report.hour, 18, 'report 18:30 常量')
    return '开关/校验 ✓'
  })

  await r.check('M2', 'check：窗口外不发；进入窗口且开启触发一次；重复 check 不重发', async () => {
    // 全新库状态：report 开关在 M1 被关；用新 DB（独立 runDir）以免互相干扰
    const subDir = join(runDir, 'sub', 'data')
    mkdirSync(subDir, { recursive: true })
    const subDb = new DatabaseClient({
      dbPath: join(subDir, 'umi-claw.db'), backupDir: join(subDir, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub', requestTimeoutMs: 30_000, logger
    })
    await subDb.dbStatus({ initialize: true })

    const notes = []
    const rem = createReminderManager({
      database: subDb,
      notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary,
      now: () => reportNow // 18:30，report 窗口内
    })

    // 窗口外（11:00：已过 morning 60min 容差，未到 report）不发
    const remMorning = createReminderManager({
      database: subDb, notifier: () => notes.push({ id: 'x' }),
      getMorningSummary: morningSummary,
      now: () => new Date(2026, 8, 23, 11, 0, 0).getTime()
    })
    const noneFired = await remMorning.check()
    assertEq(noneFired.length, 0, '11:00 不在任何窗口，不发')

    // 18:30 → report 触发
    const fired = await rem.check()
    assert(fired.includes(REMINDERS.REPORT), 'report 触发')
    assertEq(notes.filter((n) => n.id === REMINDERS.REPORT).length, 1, '只发 1 次')
    const body = notes.find((n) => n.id === REMINDERS.REPORT).p.body
    assert(body.includes('日报'), '正文提示生成日报')

    // 重复 check 不重发（内存去重）
    await rem.check()
    assertEq(notes.filter((n) => n.id === REMINDERS.REPORT).length, 1, '窗口内不重复发')
    await subDb.dispose()
    return '触发/去重 ✓'
  })

  await r.check('M3', 'morning 通知：09:00 触发，正文含待办汇总；空待办有兜底文案', async () => {
    const subDir2 = join(runDir, 'sub2', 'data')
    mkdirSync(subDir2, { recursive: true })
    const db2 = new DatabaseClient({
      dbPath: join(subDir2, 'umi-claw.db'), backupDir: join(subDir2, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub2', requestTimeoutMs: 30_000, logger
    })
    await db2.dbStatus({ initialize: true })
    const notes = []
    const nine = new Date(2026, 8, 23, 9, 0, 0).getTime()
    const rem = createReminderManager({
      database: db2, notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: async () => ({ count: 2, titles: ['甲', '乙'] }),
      now: () => nine
    })
    const fired = await rem.check()
    assert(fired.includes(REMINDERS.MORNING), 'morning 触发')
    const note = notes[0]
    assertEq(note.id, REMINDERS.MORNING, 'id')
    assert(note.p.body.includes('甲') && note.p.body.includes('乙'), '正文含待办汇总')

    // 空待办兜底
    const notes2 = []
    const remEmpty = createReminderManager({
      database: db2, notifier: (id, p) => notes2.push(p),
      getMorningSummary: async () => ({ count: 0, titles: [] }),
      now: () => new Date(2026, 8, 24, 9, 0, 0).getTime() // 换一天以重置内存去重
    })
    await remEmpty.check()
    assert(notes2[0].body.includes('还没有待办'), '空待办兜底文案')
    await db2.dispose()
    return 'morning 通知 ✓'
  })

  await r.check('M5', '提醒时刻可改：默认 09:00/18:30；setTime 持久化并驱动触发；非法值拒', async () => {
    const subDir4 = join(runDir, 'sub4', 'data')
    mkdirSync(subDir4, { recursive: true })
    const db4 = new DatabaseClient({
      dbPath: join(subDir4, 'umi-claw.db'), backupDir: join(subDir4, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub4', requestTimeoutMs: 30_000, logger
    })
    await db4.dbStatus({ initialize: true })

    const notes = []
    const rem = createReminderManager({
      database: db4, notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary,
      now: () => reportNow // 18:30
    })

    // 未设置 → 默认值
    const defaults = await rem.getTimes()
    assertEq(defaults.report.hour, 18, 'report 默认 18 时')
    assertEq(defaults.report.minute, 30, 'report 默认 30 分')
    assertEq(defaults.morning.hour, 9, 'morning 默认 9 时')

    // 改到 21:15 → 原 18:30 窗口不再触发
    await rem.setTime(REMINDERS.REPORT, 21, 15)
    const moved = await rem.getTimes()
    assertEq(moved.report.hour, 21, 'setTime 持久化（读回）')
    assertEq(moved.report.minute, 15, 'setTime 持久化分钟')
    const noFire = await rem.check()
    assertEq(noFire.length, 0, '改时刻后原窗口不发')

    // 改回 18:30 → 按新时刻触发
    await rem.setTime(REMINDERS.REPORT, 18, 30)
    const fired = await rem.check()
    assert(fired.includes(REMINDERS.REPORT), '改回后按新时刻触发')

    // 非法值拒
    const badHour = await outcome(rem.setTime(REMINDERS.REPORT, 24, 0))
    assertEq(badHour.code, 'VALIDATION_ERROR', 'hour 越界拒')
    const badMinute = await outcome(rem.setTime(REMINDERS.MORNING, 9, 60))
    assertEq(badMinute.code, 'VALIDATION_ERROR', 'minute 越界拒')
    const badId2 = await outcome(rem.setTime('lunch', 9, 0))
    assertEq(badId2.code, 'VALIDATION_ERROR', '非法 id 拒')

    await db4.dispose()
    return '时刻可改 OK'
  })

  await r.check('M6', '本地闭环：report 通知先自动生成草稿再发（不自动外发）；无依赖时退回提醒文案', async () => {
    const subDir5 = join(runDir, 'sub5', 'data')
    mkdirSync(subDir5, { recursive: true })
    const db5 = new DatabaseClient({
      dbPath: join(subDir5, 'umi-claw.db'), backupDir: join(subDir5, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub5', requestTimeoutMs: 30_000, logger
    })
    await db5.dbStatus({ initialize: true })

    // 有 generateDailyDraft：到点先调它，正文说明草稿已就绪
    const calls = []
    const notes = []
    const rem = createReminderManager({
      database: db5, notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => { calls.push(Date.now()); return { status: 'generated', reportId: 'r1' } },
      now: () => reportNow
    })
    const fired = await rem.check()
    assert(fired.includes(REMINDERS.REPORT), 'report 触发')
    assertEq(calls.length, 1, '自动生成草稿被调用一次')
    const body = notes.find((n) => n.id === REMINDERS.REPORT).p.body
    assert(body.includes('草稿已就绪'), '正文指向草稿就绪')
    assert(!body.includes('http'), '不外发：正文无链接')

    // 0 条记录 → 空态文案
    const notes2 = []
    const remEmpty = createReminderManager({
      database: db5, notifier: (id, p) => notes2.push({ id, p }),
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'empty' }),
      now: () => new Date(2026, 8, 24, 18, 30, 0).getTime() // 换一天重置去重
    })
    await remEmpty.check()
    assert(notes2[0].p.body.includes('还没有记录'), '空记录兜底文案')

    // 生成失败 → 告知失败且指向报告页（不静默）
    const notes3 = []
    const remFail = createReminderManager({
      database: db5, notifier: (id, p) => notes3.push({ id, p }),
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'error', message: '模型超时' }),
      now: () => new Date(2026, 8, 25, 18, 30, 0).getTime()
    })
    await remFail.check()
    assert(notes3[0].p.body.includes('模型超时'), '失败原因透出')
    assert(notes3[0].p.body.includes('报告'), '指向报告页可手动生成')

    // 无依赖 → 退回旧提醒文案（既有行为不变）
    const notes4 = []
    const remPlain = createReminderManager({
      database: db5, notifier: (id, p) => notes4.push({ id, p }),
      getMorningSummary: morningSummary,
      now: () => new Date(2026, 8, 26, 18, 30, 0).getTime()
    })
    await remPlain.check()
    assert(notes4[0].p.body.includes('点一下即可'), '无依赖退回提醒文案')

    // 非函数依赖直接拒（构造函数同步抛 → 用 IIFE 包成 promise 给 outcome）
    const badDep = await outcome(
      (async () =>
        createReminderManager({
          database: db5, notifier: () => {}, getMorningSummary: morningSummary,
          generateDailyDraft: 'nope', now: () => reportNow
        }))()
    )
    assertEq(badDep.code, 'VALIDATION_ERROR', '非法 generateDailyDraft 拒')

    await db5.dispose()
    return '本地闭环 OK'
  })

  await r.check('M7', '外发（方案 A）：默认关；未配齐不得开；只推短提示不含正文；失败不阻断本地通知', async () => {
    const subDir6 = join(runDir, 'sub6', 'data')
    mkdirSync(subDir6, { recursive: true })
    const db6 = new DatabaseClient({
      dbPath: join(subDir6, 'umi-claw.db'), backupDir: join(subDir6, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub6', requestTimeoutMs: 30_000, logger
    })
    await db6.dbStatus({ initialize: true })

    const notes = []
    const pushed = []
    const rem = createReminderManager({
      database: db6,
      notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'generated', reportId: 'r1' }),
      pusher: async (id, p) => { pushed.push({ id, p }); return { ok: true } },
      now: () => reportNow
    })

    // 默认关（装了不自动外发）
    const cfg0 = await rem.getPushConfig()
    assertEq(cfg0.enabled, false, '外发默认关')
    assertEq(cfg0.channel, null, '通道默认空')
    assertEq(cfg0.target, null, '目标默认空')

    // 未配齐就开 → 拒（不给「开了但不知道发哪」）
    const notReady = await outcome(rem.setPushConfig({ enabled: true }))
    assertEq(notReady.code, 'VALIDATION_ERROR', '未配齐不得开')

    // 非法通道拒
    const badCh = await outcome(rem.setPushConfig({ channel: 'wechat' }))
    assertEq(badCh.code, 'VALIDATION_ERROR', '非法通道拒')

    // 默认关时 check 不外发（但仍发本地通知）
    const fired1 = await rem.check()
    assert(fired1.includes(REMINDERS.REPORT), '本地通知照发')
    assertEq(pushed.length, 0, '未开启不外发')

    // 配齐并开启 → 外发同一段短提示
    await rem.setPushConfig({ channel: 'feishu', target: 'user:ou_probe' })
    const on = await rem.setPushConfig({ enabled: true })
    assertEq(on.enabled, true, '可开启')
    assertEq(on.channel, 'feishu', '通道持久化')

    // 换一天重置去重后再 check → 外发一次
    const rem2 = createReminderManager({
      database: db6,
      notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'generated', reportId: 'r1' }),
      pusher: async (id, p) => { pushed.push({ id, p }); return { ok: true } },
      now: () => new Date(2026, 8, 24, 18, 30, 0).getTime()
    })
    await rem2.check()
    assertEq(pushed.length, 1, '开启后外发一次')
    assertEq(pushed[0].id, REMINDERS.REPORT, '外发 id 对齐')
    // 方案 A 的关键约束：外发内容就是那条短提示，不含正文
    assertEq(pushed[0].p.body, notes[notes.length - 1].p.body, '外发=本地同一段短提示')
    assert(pushed[0].p.body.length < 200, '短提示（不含正文）')

    // 外发失败不抛、不影响本地通知（尽力而为）
    const notes3 = []
    const rem3 = createReminderManager({
      database: db6,
      notifier: (id, p) => notes3.push({ id, p }),
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'generated', reportId: 'r1' }),
      pusher: async () => ({ ok: false, message: '通道不可用' }),
      now: () => new Date(2026, 8, 25, 18, 30, 0).getTime()
    })
    const fired3 = await rem3.check()
    assert(fired3.includes(REMINDERS.REPORT), '外发失败仍发本地通知')
    assertEq(notes3.length, 1, '本地通知已送达')

    // 非法 pusher 拒
    const badPusher = await outcome(
      (async () =>
        createReminderManager({
          database: db6, notifier: () => {}, getMorningSummary: morningSummary,
          pusher: 'nope', now: () => reportNow
        }))()
    )
    assertEq(badPusher.code, 'VALIDATION_ERROR', '非法 pusher 拒')

    await db6.dispose()
    return '方案 A 外发 OK'
  })

  await r.check('M8', '外发扩展：只列已配置渠道；首选失败自动走次选；全失败记失败提示', async () => {
    const subDir7 = join(runDir, 'sub7', 'data')
    mkdirSync(subDir7, { recursive: true })
    const db7 = new DatabaseClient({
      dbPath: join(subDir7, 'umi-claw.db'), backupDir: join(subDir7, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub7', requestTimeoutMs: 30_000, logger
    })
    await db7.dbStatus({ initialize: true })

    // 渠道清单：只 feishu 已配置；钉钉 supported=false（OpenClaw 无实现）
    let options = [
      { channel: 'feishu', label: '飞书', configured: true, supported: true },
      { channel: 'wecom', label: '企业微信', configured: false, supported: true },
      { channel: 'openclaw-weixin', label: '微信', configured: false, supported: true },
      { channel: 'dingtalk', label: '钉钉', configured: true, supported: false }
    ]

    const attempts = []
    const rem = createReminderManager({
      database: db7,
      notifier: () => {},
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'generated', reportId: 'r1' }),
      listPushChannels: async () => options,
      pusher: async (_id, _p, dest) => {
        attempts.push(dest.channel)
        return dest.channel === 'feishu'
          ? { ok: false, message: '飞书 401' }
          : { ok: true }
      },
      now: () => reportNow
    })

    // 清单原样透出（UI 据此只渲染已配置项）
    const list = await rem.availablePushChannels()
    assertEq(list.length, 4, '四个渠道都在清单里')
    assertEq(list.find((o) => o.channel === 'dingtalk').supported, false, '钉钉不支持')
    assertEq(list.find((o) => o.channel === 'wecom').configured, false, 'wecom 未配置')

    // 未配置的渠道不能选（北：没配置肯定不能推）
    const notCfg = await outcome(rem.setPushConfig({ channel: 'wecom' }))
    assertEq(notCfg.code, 'VALIDATION_ERROR', '未配置渠道拒')

    // 钉钉：OpenClaw 无实现，拒
    const dt = await outcome(rem.setPushConfig({ channel: 'dingtalk' }))
    assertEq(dt.code, 'VALIDATION_ERROR', '钉钉不支持拒')

    // 首选=次选 拒
    const same = await outcome(rem.setPushConfig({ channel: 'feishu', fallbackChannel: 'feishu' }))
    assertEq(same.code, 'VALIDATION_ERROR', '首选次选不得相同')

    // 选次选就必须填次选目标
    await rem.setPushConfig({ channel: 'feishu', target: 'user:ou_x' })
    options = options.map((o) => (o.channel === 'wecom' ? { ...o, configured: true } : o))
    await rem.setPushConfig({ fallbackChannel: 'wecom' })
    const noFbTarget = await outcome(rem.setPushConfig({ enabled: true }))
    assertEq(noFbTarget.code, 'VALIDATION_ERROR', '次选缺目标不得开')

    await rem.setPushConfig({ fallbackTarget: 'user:wx_y', enabled: true })

    // 首选失败 → 自动试次选 → 成功
    const fired = await rem.check()
    assert(fired.includes(REMINDERS.REPORT), 'report 触发')
    assertEq(attempts.join('>'), 'feishu>wecom', '首选失败自动走次选')
    const st1 = await rem.getPushStatus()
    assertEq(st1.ok, true, '最终成功')
    assertEq(st1.channel, 'wecom', '成功渠道=次选')

    // 全失败 → 记失败提示（UI 可见）
    const remFail = createReminderManager({
      database: db7,
      notifier: () => {},
      getMorningSummary: morningSummary,
      generateDailyDraft: async () => ({ status: 'generated', reportId: 'r1' }),
      listPushChannels: async () => options,
      pusher: async () => ({ ok: false, message: '两个都挂了' }),
      now: () => new Date(2026, 8, 25, 18, 30, 0).getTime()
    })
    await remFail.check()
    const st2 = await remFail.getPushStatus()
    assertEq(st2.ok, false, '全失败 ok=false')
    assertEq(st2.message, '两个都挂了', '失败原因被记下')

    // 无 provider 时 availablePushChannels 返回空清单（不报错）
    const remPlain = createReminderManager({
      database: db7, notifier: () => {}, getMorningSummary: morningSummary, now: () => reportNow
    })
    assertEq((await remPlain.availablePushChannels()).length, 0, '无 provider → 空清单')

    await db7.dispose()
    return '清单/兜底/失败提示 OK'
  })

  await r.check('M9', '目标自动发现 + 推送测试：目标由 OpenClaw 给出；测试按首选→次选；成败都入状态', async () => {
    const subDir8 = join(runDir, 'sub8', 'data')
    mkdirSync(subDir8, { recursive: true })
    const db8 = new DatabaseClient({
      dbPath: join(subDir8, 'umi-claw.db'), backupDir: join(subDir8, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub8', requestTimeoutMs: 30_000, logger
    })
    await db8.dbStatus({ initialize: true })

    // OpenClaw 自己记录的目标（模拟 conversations 表）
    const KNOWN = [
      { target: 'ou_5d4e197a5b7b37ecf59d935d429df5f0', label: '私聊', kind: 'direct', updatedAt: 1790179305774 },
      { target: 'chat:oc_3d0272ab3416f46a2e71b457e62962f2', label: '群聊', kind: 'group', updatedAt: 1784795918477 }
    ]
    const options = [
      { channel: 'feishu', label: '飞书', configured: true, supported: true },
      { channel: 'wecom', label: '企业微信', configured: true, supported: true }
    ]

    const calls = []
    const rem = createReminderManager({
      database: db8,
      notifier: () => {},
      getMorningSummary: morningSummary,
      listPushChannels: async () => options,
      listPushTargets: async (ch) => (ch === 'feishu' ? KNOWN : []),
      pusher: async (_id, _p, dest) => {
        calls.push(dest.channel)
        return dest.channel === 'feishu' ? { ok: true } : { ok: false, message: 'wecom 挂了' }
      },
      now: () => reportNow
    })

    // 目标不需要用户手填：由 provider 给出
    const targets = await rem.availablePushTargets('feishu')
    assertEq(targets.length, 2, '拿到 2 个已知目标')
    assertEq(targets[0].target, KNOWN[0].target, '目标值透出')
    assertEq(targets[0].kind, 'direct', 'kind 透出')

    // 非法渠道拒
    const badCh = await outcome(rem.availablePushTargets('nope'))
    assertEq(badCh.code, 'VALIDATION_ERROR', '非法渠道拒')

    // 未配置时测试推送 → 明确提示，不静默
    const noCfg = await rem.testPush()
    assertEq(noCfg.ok, false, '未配置不能测')
    assert(noCfg.message.includes('渠道'), '提示要选渠道')

    // 配置首选 feishu（测试只调首选，不碰 check 的当天去重）
    await rem.setPushConfig({ channel: 'feishu', target: KNOWN[0].target, enabled: true })
    const t1 = await rem.testPush()
    assertEq(t1.ok, true, '测试推送成功')
    assertEq(t1.channel, 'feishu', '成功渠道')
    const st1 = await rem.getPushStatus()
    assertEq(st1.ok, true, '成功写入状态')

    // 首选失败 → 自动走次选（测试与正式外发同一套兜底逻辑）
    const calls2 = []
    const rem2 = createReminderManager({
      database: db8,
      notifier: () => {},
      getMorningSummary: morningSummary,
      listPushChannels: async () => options,
      listPushTargets: async (ch) => (ch === 'feishu' ? KNOWN : [{ target: 'user:wx_y', label: '私聊', kind: 'direct', updatedAt: 1 }]),
      pusher: async (_id, _p, dest) => {
        calls2.push(dest.channel)
        return dest.channel === 'feishu' ? { ok: false, message: '飞书 401' } : { ok: true }
      },
      now: () => reportNow
    })
    await rem2.setPushConfig({ channel: 'feishu', target: KNOWN[0].target })
    await rem2.setPushConfig({ fallbackChannel: 'wecom', fallbackTarget: 'user:wx_y', enabled: true })
    const t2 = await rem2.testPush()
    assertEq(calls2.join('>'), 'feishu>wecom', '测试也走兜底')
    assertEq(t2.ok, true, '兜底后成功')
    assertEq(t2.channel, 'wecom', '成功渠道=次选')

    // 全失败 → 测试返回失败 + 入状态
    const rem3 = createReminderManager({
      database: db8,
      notifier: () => {},
      getMorningSummary: morningSummary,
      listPushChannels: async () => options,
      listPushTargets: async () => [],
      pusher: async () => ({ ok: false, message: '两个都不可用' }),
      now: () => reportNow
    })
    await rem3.setPushConfig({ channel: 'feishu', target: 'user:ou_x' })
    await rem3.setPushConfig({ enabled: true })
    const t3 = await rem3.testPush()
    assertEq(t3.ok, false, '全失败')
    assertEq(t3.message, '两个都不可用', '失败原因透出给 UI')
    assertEq((await rem3.getPushStatus()).ok, false, '失败也入状态')

    // 未接入 pusher → 明确拒绝
    const remNoPusher = createReminderManager({
      database: db8, notifier: () => {}, getMorningSummary: morningSummary, now: () => reportNow
    })
    const t4 = await remNoPusher.testPush()
    assertEq(t4.ok, false, '未接入不假成功')

    await db8.dispose()
    return '目标发现 + 测试推送 OK'
  })

  await r.check('M4', '关闭开关后 check 不发；IPC 静态核对（wizard/reminder 通道）', async () => {
    const subDir3 = join(runDir, 'sub3', 'data')
    mkdirSync(subDir3, { recursive: true })
    const db3 = new DatabaseClient({
      dbPath: join(subDir3, 'umi-claw.db'), backupDir: join(subDir3, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub3', requestTimeoutMs: 30_000, logger
    })
    await db3.dbStatus({ initialize: true })
    const notes = []
    const rem = createReminderManager({
      database: db3, notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary, now: () => reportNow
    })
    await rem.setEnabled(REMINDERS.REPORT, false)
    const fired = await rem.check()
    assertEq(fired.length, 0, '关闭后不发')
    await db3.dispose()

    // IPC 静态核对
    const src = readFileSync(join(__dirname, '..', 'electron', 'main', 'ipc', 'work.ts'), 'utf-8')
    const channels = [
      'work:wizard:status', 'work:wizard:grantConsent', 'work:wizard:ensureConsent',
      'work:wizard:revokeConsent',
      'work:wizard:complete', 'work:wizard:decide', 'work:wizard:readMapping',
      'work:reminder:setEnabled', 'work:reminder:getTimes', 'work:reminder:setTime',
      'work:reminder:getPushConfig', 'work:reminder:setPushConfig',
      'work:reminder:availablePushChannels', 'work:reminder:availablePushTargets',
      'work:reminder:testPush', 'work:reminder:getPushStatus',
      'work:reminder:check'
    ]
    const missing = channels.filter((c) => !src.includes(`'${c}'`))
    assertEq(missing.length, 0, '缺失: ' + missing.join(','))
    return '开关拦截 + IPC ✓'
  })

  // ── M10 待办到点提醒（v2 起，v0.17 口径）──────────────────────────────────────
  //
  // 口径（reminderManager 注释钉死）：**本机通知必达**（不看外发总开关、不看通道配置、
  // 甚至不需要 pusher）+ **外发是加成**（总开关开 + 通道配齐才投）+ **到点即消费**
  // （弹过就写 reminded_at，不补发）+ 改期重新排队 + 逐条兜底 + 失败可见可归因。
  await r.check('M10', '待办到点提醒：本机必达·外发受总开关·到点即消费·改期重排·单条异常不连累·失败可见', async () => {
    const subDir9 = join(runDir, 'sub9', 'data')
    mkdirSync(subDir9, { recursive: true })
    const db9 = new DatabaseClient({
      dbPath: join(subDir9, 'umi-claw.db'), backupDir: join(subDir9, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub9', requestTimeoutMs: 30_000, logger
    })
    await db9.dbStatus({ initialize: true })

    // 可控时钟：起点 14:00 避开 09:00 / 18:30 两个固定通知窗口，隔离出待办提醒
    let clock = new Date(2026, 8, 24, 14, 0, 0).getTime()
    const now = () => clock
    const todos = new TodoManager({ database: db9, now })

    const pushed = []
    const notes = []
    let markImpl = (id, ts) => todos.markReminded(id, ts)
    const rem = createReminderManager({
      database: db9,
      notifier: (id, p) => notes.push({ id, p }),
      getMorningSummary: morningSummary,
      pusher: async (_id, p, dest) => {
        pushed.push({ title: p.title, body: p.body, channel: dest.channel })
        return { ok: true }
      },
      listPushChannels: async () => [
        { channel: 'feishu', label: '飞书', configured: true, supported: true }
      ],
      listDueTodoReminders: async () =>
        (await todos.listDueReminders()).map((t) => ({
          id: t.id, title: t.title, dueDate: t.due_date, dueAt: t.due_at
        })),
      markTodoReminded: (id, ts) => markImpl(id, ts),
      now
    })
    await rem.setPushConfig({ channel: 'feishu', target: 'user:ou_x' })
    assertEq((await rem.getPushConfig()).enabled, false, '前置：外发总开关默认关')

    // 0) 总开关关着：到点**仍弹本机通知**，只是不外发；弹过即消费（不补发）
    const g = await todos.create({ title: '开关关着那条', remindAt: clock + 60_000 })
    clock += 61_000
    await rem.check()
    assertEq(notes.length, 1, '总开关关着也要弹本机通知（本地必达）')
    assertEq(notes[0].id, 'todo', '来源标识 todo（不是 ReminderId，不进 REMINDER_IDS）')
    assertEq(notes[0].p.title, '待办提醒', '通知标题')
    assert(notes[0].p.body.includes('开关关着那条'), '通知正文含待办标题')
    assertEq(pushed.length, 0, '总开关关着不外发')
    assert((await todos.get(g.id)).reminded_at !== null, '弹过即消费（写 reminded_at）')
    assertEq((await todos.listDueReminders()).length, 0, '不补发：队列已空')
    await rem.check()
    assertEq(notes.length, 1, '再 check 不重复弹')

    // 1) 打开总开关：到点 = 本机通知 + 外发各一次；之后都不重复
    await rem.setPushConfig({ enabled: true })
    const sent = pushed.length
    const noted = notes.length
    const a = await todos.create({
      title: '提醒客户回款', dueAt: clock + 30 * 60_000, remindAt: clock + 60_000
    })
    await rem.check()
    assertEq(pushed.length, sent, '未到点不得外发')
    assertEq(notes.length, noted, '未到点不得弹通知')
    assertEq((await todos.listDueReminders()).length, 0, '未到点不在队列')

    clock += 61_000
    await rem.check()
    assertEq(notes.length, noted + 1, '到点弹一次本机通知')
    assertEq(pushed.length, sent + 1, '到点外发一次')
    assertEq(pushed[sent].channel, 'feishu', '投到已配置渠道')
    assert(pushed[sent].body.includes('提醒客户回款'), '外发正文含待办标题')
    assert(pushed[sent].body.includes('到期'), '外发正文含到期时刻')
    assert((await todos.get(a.id)).reminded_at !== null, '投递后标记 reminded_at')
    clock += 61_000
    await rem.check()
    assertEq(pushed.length, sent + 1, '已消费不重复外发（不重试）')
    assertEq(notes.length, noted + 1, '已消费不重复弹通知')

    // 2) 改期 = 重新排队（回归点：不清 reminded_at 就永不再提醒）
    await todos.update(a.id, { remindAt: clock + 60_000 })
    assertEq((await todos.get(a.id)).reminded_at, null, '改期应清掉已投递标记')
    clock += 61_000
    await rem.check()
    assertEq(notes.length, noted + 2, '改期后到点应再弹一次')
    assertEq(pushed.length, sent + 2, '改期后到点应再外发一次')

    // 3) 单条异常不连累同轮其它到点待办
    const c = await todos.create({ title: '会炸的那条', remindAt: clock + 60_000 })
    const d = await todos.create({ title: '正常那条', remindAt: clock + 60_000 })
    clock += 61_000
    markImpl = async (id, ts) => {
      if (id === c.id) throw new Error('NOT_FOUND（模拟：列表与标记之间被删）')
      return todos.markReminded(id, ts)
    }
    const baseN = notes.length
    const baseP = pushed.length
    await rem.check()
    assertEq(notes.length - baseN, 2, '两条都弹了本机通知（异常不截断本轮）')
    assertEq(pushed.length - baseP, 1, '只有标记成功那条继续外发')
    assert((await todos.get(d.id)).reminded_at !== null, '正常那条已标记')
    assertEq((await todos.get(c.id)).reminded_at, null, '异常那条不标记（留给下一轮）')
    assertEq(
      (await todos.listDueReminders()).map((t) => t.id).join(','), c.id,
      '队列里只剩异常那条'
    )
    markImpl = (id, ts) => todos.markReminded(id, ts)
    await db9.dispose()

    // 4) 外发失败：本机通知照弹，失败写 pushStatus 且点名待办（不静默、不重试）
    const subDir10 = join(runDir, 'sub10', 'data')
    mkdirSync(subDir10, { recursive: true })
    const db10 = new DatabaseClient({
      dbPath: join(subDir10, 'umi-claw.db'), backupDir: join(subDir10, 'backup'),
      workerScriptPath, nodePath, subprocessName: 'work-db-wz-sub10', requestTimeoutMs: 30_000, logger
    })
    await db10.dbStatus({ initialize: true })
    const todos2 = new TodoManager({ database: db10, now })
    const pushed2 = []
    const notes2 = []
    const dueOf = (mgr) => async () =>
      (await mgr.listDueReminders()).map((t) => ({
        id: t.id, title: t.title, dueDate: t.due_date, dueAt: t.due_at
      }))
    const rem2 = createReminderManager({
      database: db10,
      notifier: (id, p) => notes2.push({ id, p }),
      getMorningSummary: morningSummary,
      pusher: async (_id, p) => {
        pushed2.push(p.body)
        return { ok: false, message: '飞书 401' }
      },
      listPushChannels: async () => [
        { channel: 'feishu', label: '飞书', configured: true, supported: true }
      ],
      listDueTodoReminders: dueOf(todos2),
      markTodoReminded: (id, ts) => todos2.markReminded(id, ts),
      now
    })
    await rem2.setPushConfig({ channel: 'feishu', target: 'user:ou_x' })
    await rem2.setPushConfig({ enabled: true })
    const b = await todos2.create({ title: '投递失败那条', remindAt: clock + 60_000 })
    clock += 61_000
    await rem2.check()
    assertEq(notes2.length, 1, '外发失败也要弹本机通知')
    assertEq(pushed2.length, 1, '按首选通道尝试投递一次')
    let st = await rem2.getPushStatus()
    assert(st !== null, '失败必须写 pushStatus（不得静默）')
    assertEq(st.ok, false, '记为失败')
    assert(String(st.message).includes('投递失败那条'), `状态点名是哪条待办（实际 ${st.message}）`)
    assert(String(st.message).includes('飞书 401'), `状态带渠道侧原因（实际 ${st.message}）`)
    assert((await todos2.get(b.id)).reminded_at !== null, '按口径消费，不无限重试')
    assertEq((await todos2.listDueReminders()).length, 0, '不再重复排队')

    // 4b) 兜底分支：通道 meta 被清空（UI 走不到——setPushConfig 不允许未配齐就开；
    //     这里模拟手工改库/降级留下的脏 meta）→ 本机通知照弹 + 状态仍可见
    await db10.metaSet('reminder_push_channel', '')
    await db10.metaSet('reminder_push_target', '')
    const b2 = await todos2.create({ title: '通道被清空那条', remindAt: clock + 60_000 })
    clock += 61_000
    await rem2.check()
    assertEq(notes2.length, 2, '没通道也弹本机通知')
    assertEq(pushed2.length, 1, '没有通道自然一次都投不出去')
    st = await rem2.getPushStatus()
    assertEq(st.ok, false, '仍记为失败')
    assert(String(st.message).includes('通道未配置'), `写明原因（实际 ${st.message}）`)
    assert(String(st.message).includes('通道被清空那条'), `点名待办（实际 ${st.message}）`)
    assert((await todos2.get(b2.id)).reminded_at !== null, '按口径消费，不无限重试')

    // 5) 压根没接 pusher（没装渠道 CLI 的机器）：本机通知仍必达
    const notes3 = []
    const rem3 = createReminderManager({
      database: db10,
      notifier: (id, p) => notes3.push({ id, p }),
      getMorningSummary: morningSummary,
      listDueTodoReminders: dueOf(todos2),
      markTodoReminded: (id, ts) => todos2.markReminded(id, ts),
      now
    })
    const b3 = await todos2.create({ title: '没有外发能力那条', remindAt: clock + 60_000 })
    clock += 61_000
    await rem3.check()
    assertEq(notes3.length, 1, '无 pusher 也要弹本机通知')
    assertEq(notes3[0].id, 'todo', '来源标识仍是 todo')
    assert(notes3[0].p.body.includes('没有外发能力那条'), '通知正文正确')
    assert((await todos2.get(b3.id)).reminded_at !== null, '同样消费掉，不重复弹')
    await db10.dispose()

    return '本机必达（含无 pusher）· 外发受总开关 · 到点即消费 · 改期重排 · 单条异常不连累 · 失败可见 ✓'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  if (database) { try { await database.dispose() } catch {} }
  await sleep(200)
}

const result = r.toJSON({ nodePath, dbPath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-wizard.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
