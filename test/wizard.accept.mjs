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

const { DatabaseClient } = await import(pathToFileURL(dbB).href)
const wizardMod = await import(pathToFileURL(wizardB).href)
const reminderMod = await import(pathToFileURL(reminderB).href)

const { createWizardManager, OLDDB, CONSENT_GRANTED } = wizardMod
const { createReminderManager, REMINDERS, REMINDER_TIMES } = reminderMod

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
    await wizard.grantConsent()
    assertEq(CONSENT_GRANTED, 'granted', '常量')
    const s2 = await wizard.status()
    assertEq(s2.consent, true, '已同意')
    await wizard.complete()
    const s3 = await wizard.status()
    assertEq(s3.completed, true, '向导完成')
    return 'consent 必过 ✓'
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
      'work:wizard:status', 'work:wizard:grantConsent', 'work:wizard:complete',
      'work:wizard:decide', 'work:wizard:readMapping',
      'work:reminder:setEnabled', 'work:reminder:check'
    ]
    const missing = channels.filter((c) => !src.includes(`'${c}'`))
    assertEq(missing.length, 0, '缺失: ' + missing.join(','))
    return '开关拦截 + IPC ✓'
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
