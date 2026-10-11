// test/claw-maintenance.accept.mjs —— 启动自愈验收：更新探针 + 退出码 78 的自动 doctor
//
// **打真实源码**：esbuild 把 electron/main/clawManager.ts 打成临时 ESM 在纯 Node 里 import
// （configManager 顶层 import electron，在该宿主边界打桩，见 test/fixtures/electron-stub.mjs）。
// 只替换「真实 spawn」这一步：用一个 EventEmitter 假进程冒充网关子进程，
// 这样探针关心的两件事——进程有没有退出、就绪探测有没有通过——都能被精确驱动。
//
// 覆盖点：
//   - probeStartup 三态：就绪→ok / 进程自行退出→refused(带 exitCode) / 两者皆无→inconclusive
//   - 只有 refused 才是「可据此回滚」的正面证据，inconclusive 绝不能触发回滚
//   - 探针期间退出码 78 **不**再触发自动 doctor（决策权归探针调用方）
//   - 非探针期间退出码 78 仍照常触发自动 doctor（守卫没有误伤自愈路径）
//
// 用法：node test/claw-maintenance.accept.mjs   （npm run accept:maintenance）

import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assert,
  assertDeepEq,
  assertEq,
  bundleEntry,
  printResult,
  Recorder,
  sleep,
  tmpDir,
  writeJson
} from './_lib.mjs'

const suite = '启动自愈（更新探针 / 退出码 78）'
const rec = new Recorder(suite)

// ── bundle 真源码 ─────────────────────────────────────────────────────────────
// configManager 顶层 import { app, dialog } from 'electron' → 在该边界打桩；
// 它静态引入 adm-zip（内含 require('fs')），打进 ESM bundle 会炸 → 标 external
const clawPath = bundleEntry('electron/main/clawManager.ts', 'claw-maintenance-claw-manager.mjs', {
  alias: ['electron=./test/fixtures/electron-stub.mjs'],
  externals: ['adm-zip']
})
const { ClawManager, decideRollback } = await import(pathToFileURL(clawPath).href)

// ── 假网关进程 ───────────────────────────────────────────────────────────────

/** 冒充网关子进程：只要 EventEmitter 的 once/off/emit 与 stdout/stderr 空槽 */
class FakeProcess extends EventEmitter {
  constructor() {
    super()
    this.pid = 4242
    this.stdout = null
    this.stderr = null
  }
}

/**
 * 把 ClawManager.start() 换成「装一个假进程」。
 * 其余（_setupProcessEvents / 退出处理 / probeStartup）全是真源码。
 */
function installFakeStart(cm, { failWith = null } = {}) {
  const state = { proc: null, startCalls: 0 }
  cm.start = async function () {
    state.startCalls += 1
    // 冒充 start() 的前置失败（未配 API Key / 配置同步失败 / 找不到运行时…）
    if (failWith) return { success: false, error: failWith }
    if (this.process) return { success: false, error: 'OpenClaw 已在运行中' }
    const proc = new FakeProcess()
    state.proc = proc
    this.process = proc
    this._setupProcessEvents()
    return { success: true }
  }
  return state
}

/** 造一个不会真的跑 doctor / taskkill 的 ClawManager */
function makeClaw(opts = {}) {
  const cm = new ClawManager({ getDataDir: () => tmpDir })
  const doctor = { calls: 0 }
  cm._killGhostProcesses = async () => {}
  cm.runDoctorFix = async () => {
    doctor.calls += 1
    return { success: true, output: '' }
  }
  return { cm, doctor, fake: installFakeStart(cm, opts) }
}

// ── 1. 就绪 → ok ─────────────────────────────────────────────────────────────

await rec.check('probe-ready', '就绪探测通过 → ok，且不算 refused/inconclusive', async () => {
  const { cm, fake } = makeClaw()
  const r = await cm.probeStartup(async () => true, 5000, 10)
  assertEq(r.ok, true, 'ok')
  assertEq(r.refused, false, 'refused')
  assertEq(r.inconclusive, false, 'inconclusive')
  assertEq(fake.startCalls, 1, '探针应恰好拉起一次网关')
  return r.reason
})

// ── 2. 进程自行退出 → refused（唯一可据此回滚的正面证据）───────────────────────

await rec.check('probe-refused', '进程退 78 → refused 且带 exitCode / 迁移标记', async () => {
  const { cm, fake } = makeClaw()
  cm.maintenanceMarkerSeen = true // 冒充网关退出前打印过 schema 迁移提示
  setTimeout(() => fake.proc.emit('exit', 78, null), 50)
  const r = await cm.probeStartup(async () => false, 5000, 10)
  assertEq(r.refused, true, 'refused')
  assertEq(r.ok, false, 'ok')
  assertEq(r.inconclusive, false, 'inconclusive')
  assertEq(r.exitCode, 78, 'exitCode')
  assertEq(r.maintenanceRequired, true, 'maintenanceRequired')
  return r.reason
})

// ── 2a. maintenanceRequired 只标注「数据待迁移」，不改变 refused 语义 ─────────────
//
// 这个标记只影响文案与补救动作（重跑 doctor vs 重试更新），**不**参与回滚安全性判断
// —— 那只看数据有没有真被迁移过（见 env:update 的 rollbackSafe）。所以两种自退原因
// 都必须保持 refused=true，且只有 78 / 迁移提示才置位 maintenanceRequired。

await rec.check(
  'probe-maintenance-flag',
  '只有退出码 78 / 迁移提示才标 maintenanceRequired，其它自退不标',
  async () => {
    // 假进程由 start() 装上，且探针是在 start() 返回后才挂 exit 监听 —— 轮询等到
    // fake.proc 就绪再发退出，既不会早于 start()（空指针），也不会早于监听注册。
    // 定长 setTimeout 两边都堵不住（机器慢时 start() 还没跑完就发了）。
    const emitExitSoon = (fake, code) => {
      const t = setInterval(() => {
        if (!fake.proc) return
        clearInterval(t)
        fake.proc.emit('exit', code, null)
      }, 5)
    }

    const { cm: cm78, fake: f78 } = makeClaw()
    const { cm: cm1, fake: f1 } = makeClaw()
    emitExitSoon(f78, 78)
    emitExitSoon(f1, 1)

    const r78 = await cm78.probeStartup(async () => false, 3000, 10)
    const r1 = await cm1.probeStartup(async () => false, 3000, 10)

    assertEq(r78.refused, true, '78 仍应算 refused（自退是自退）')
    assertEq(r78.maintenanceRequired, true, '78 应标 maintenanceRequired')
    assertEq(r1.refused, true, '退 1 也算 refused')
    assertEq(r1.maintenanceRequired, false, '退 1 且无迁移提示，不应标 maintenanceRequired')
    return `78→maint=${r78.maintenanceRequired}；1→maint=${r1.maintenanceRequired}`
  }
)

// ── 2b. start() 前置失败 → inconclusive（用户配置问题不该导致回滚）──────────────

await rec.check(
  'probe-prespawn-failure',
  'start() 前置失败（如未配 API Key）→ inconclusive，绝不回滚',
  async () => {
    const { cm } = makeClaw({ failWith: '火山方舟 API Key 未配置' })
    const r = await cm.probeStartup(async () => false, 3000, 10)
    assertEq(r.refused, false, 'refused —— 没配 API Key 与新版本好坏无关，不能据此回滚')
    assertEq(r.inconclusive, true, 'inconclusive')
    assertEq(r.ok, false, 'ok')
    return r.reason
  }
)

// ── 3. 既不退出也不就绪 → inconclusive（证据不足，绝不能回滚）──────────────────

await rec.check('probe-inconclusive', '未退出也未就绪 → inconclusive，不误判为起不来', async () => {
  const { cm } = makeClaw()
  const r = await cm.probeStartup(async () => false, 150, 10)
  assertEq(r.inconclusive, true, 'inconclusive')
  assertEq(r.refused, false, 'refused —— 进程还在跑，不能据此回滚')
  assertEq(r.ok, false, 'ok')
  return r.reason
})

// ── 4. 探针期间退出码 78 不触发自动 doctor ────────────────────────────────────

await rec.check('probe-suppresses-autofix', '探针期间退 78 → 不触发自动 doctor（决策权归调用方）', async () => {
  const { cm, doctor, fake } = makeClaw()
  setTimeout(() => fake.proc.emit('exit', 78, null), 50)
  const r = await cm.probeStartup(async () => false, 3000, 10)
  await sleep(120) // 留足窗口，若守卫失效这里就会被 doctor 调用
  assertEq(r.refused, true, 'refused')
  assertEq(doctor.calls, 0, '探针期间不得自动跑 doctor')
  return `probe=${r.reason}，doctor 调用 ${doctor.calls} 次`
})

// ── 5. 非探针期间退出码 78 仍照常自愈（守卫没有误伤）──────────────────────────

await rec.check('autofix-still-works', '非探针期间退 78 → 仍自动 doctor 并重启', async () => {
  const { cm, doctor, fake } = makeClaw()
  await cm.start()
  fake.proc.emit('exit', 78, null)
  await sleep(150)
  assertEq(doctor.calls, 1, '应触发一次自动 doctor')
  assertEq(fake.startCalls, 2, 'doctor 后应重启一次网关')
  return `doctor ${doctor.calls} 次，start ${fake.startCalls} 次`
})

// ── 6. 探针结束后自愈恢复（守卫是作用域内生效，不是一次性关掉）─────────────────

await rec.check('probe-guard-scoped', '探针结束后退出码 78 恢复触发自愈', async () => {
  const { cm, doctor, fake } = makeClaw()
  setTimeout(() => fake.proc.emit('exit', 78, null), 50)
  await cm.probeStartup(async () => false, 3000, 10)
  await sleep(120)
  assertEq(doctor.calls, 0, '探针期间不应触发')
  // 探针已结束，此后再退 78 应恢复自愈
  cm.process = new FakeProcess()
  cm._setupProcessEvents()
  cm.process.emit('exit', 78, null)
  await sleep(150)
  assertEq(doctor.calls, 1, '探针结束后应恢复自动 doctor')
  return `doctor ${doctor.calls} 次`
})

// ── 7. schema 版本探测：回滚安全性的唯一判据 ──────────────────────────────────
//
// 回滚快照里没有数据库，所以「doctor 有没有动过数据」必须靠读库头来判断。
// 这里造真文件（SQLite 头 offset 60 的 4 字节大端 = user_version），验证能读出来；
// 并覆盖「半迁移」——state 升了、agent 没升，正是 dev 环境那次事故的形态。

await rec.check(
  'schema-version-read',
  '读 SQLite 头 offset 60 得到 user_version，缺失库读作 null 而不抛',
  async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const os = await import('node:os')

    const sandbox = mkdtempSync(join(os.tmpdir(), 'umi-schema-'))
    const root = join(sandbox, 'config', '.openclaw')
    const writeDb = (rel, version) => {
      const p = join(root, rel)
      mkdirSync(dirname(p), { recursive: true })
      const buf = Buffer.alloc(100)
      buf.writeUInt32BE(version, 60) // 文件头 offset 60 = PRAGMA user_version
      writeFileSync(p, buf)
    }
    writeDb(join('state', 'openclaw.sqlite'), 19)
    writeDb(join('agents', 'main', 'agent', 'openclaw-agent.sqlite'), 19)

    const cm = new ClawManager({ getDataDir: () => sandbox })
    const got = (await cm.readSchemaVersions())
      .map((v) => `${v.file}=${v.version}`)
      .sort()
    assertDeepEq(
      got,
      ['agents/main/agent/openclaw-agent.sqlite=19', 'state/openclaw.sqlite=19'],
      '应读到 state 与 agent 两个库的版本'
    )

    // 目录整体缺失时不能抛：返回 null，调用方按「未知」处理
    const empty = new ClawManager({ getDataDir: () => join(sandbox, 'nope') })
    const none = await empty.readSchemaVersions()
    assertEq(none.length, 1, 'agents 目录不存在时只剩 state 一项')
    assertEq(none[0].version, null, '读不到应为 null（绝不能当成「没变」）')
    return got.join('，')
  }
)

// ── 8. doctor 自己保证状态库独占（缺陷 3：更新流程没清残留网关）─────────────────
//
// 事故链：stop() 只杀直接子进程 → 网关派生的 worker 活着占住 agent 库 →
// doctor 报「An agent database is in use」半途而废 → 留下半迁移状态。
// 现在清理封进 runDoctorFix，且命中争用提示再清一次重试。

/** 造一个 runDoctorFix 能跑起来的沙箱（要求 node 与 clawJs 都存在） */
async function makeDoctorSandbox() {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const os = await import('node:os')
  const sandbox = mkdtempSync(join(os.tmpdir(), 'umi-doctor-'))
  const clawJs = join(sandbox, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js')
  mkdirSync(dirname(clawJs), { recursive: true })
  writeFileSync(clawJs, '')
  return sandbox
}

await rec.check(
  'doctor-cleanup-before-run',
  'doctor 前先清残留网关；命中状态库争用时清理后重试一次',
  async () => {
    const sandbox = await makeDoctorSandbox()
    const cm = new ClawManager({
      getDataDir: () => sandbox,
      getNodePath: () => process.execPath
    })
    let cleans = 0
    cm.prepareForDoctor = async () => {
      cleans += 1
    }
    const cleansAtCall = []
    cm._runDoctorOnce = async () => {
      cleansAtCall.push(cleans)
      if (cleansAtCall.length === 1) {
        return {
          success: false,
          output:
            'Doctor could not enter maintenance. An agent database is in use. ' +
            'Stop other OpenClaw processes using this state, then retry the update.',
          error: 'doctor 退出码 1'
        }
      }
      return { success: true, output: 'ok' }
    }

    const r = await cm.runDoctorFix()
    assertEq(r.success, true, '清理重试后应成功')
    assertEq(cleansAtCall.length, 2, '争用应恰好重试一次')
    assertEq(cleansAtCall[0], 1, '第一次 doctor 前必须先清理')
    assertEq(cleansAtCall[1], 2, '重试前必须再清理一次')
    return `doctor ${cleansAtCall.length} 次，清理 ${cleans} 次`
  }
)

await rec.check(
  'doctor-no-retry-on-other-failure',
  'doctor 因非争用原因失败 → 不重试（避免白等一轮 20 分钟）',
  async () => {
    const sandbox = await makeDoctorSandbox()
    const cm = new ClawManager({
      getDataDir: () => sandbox,
      getNodePath: () => process.execPath
    })
    cm.prepareForDoctor = async () => {}
    let calls = 0
    cm._runDoctorOnce = async () => {
      calls += 1
      return { success: false, output: 'plugin whitelist expired', error: 'doctor 退出码 1' }
    }
    const r = await cm.runDoctorFix()
    assertEq(r.success, false, '失败')
    assertEq(calls, 1, '非争用失败不应重试')
    return `doctor ${calls} 次`
  }
)

await rec.check(
  'doctor-single-flight',
  '并发两次 runDoctorFix → 只执行一次迁移，两边复用同一结果（杜绝双 doctor 并发改库）',
  async () => {
    const sandbox = await makeDoctorSandbox()
    const cm = new ClawManager({
      getDataDir: () => sandbox,
      getNodePath: () => process.execPath
    })
    cm.prepareForDoctor = async () => {}
    let calls = 0
    cm._runDoctorOnce = async () => {
      calls += 1
      await sleep(50)
      return { success: true, output: 'ok' }
    }
    const [r1, r2] = await Promise.all([cm.runDoctorFix(), cm.runDoctorFix()])
    assertEq(calls, 1, '同一时刻只允许一个 doctor 落库')
    assertEq(r1.success, true, '调用方 1 拿到结果')
    assertEq(r2.success, true, '调用方 2 复用同一结果')
    // 上一轮结束后再调用应能重新执行（单飞是作用域内归并，不是永久闩锁）
    await cm.runDoctorFix()
    assertEq(calls, 2, '上一轮结束后应允许新一轮 doctor')
    return `并发归并：_runDoctorOnce 共 ${calls} 次`
  }
)

// ── 8b. 退出事件按进程身份归属（缺陷：双启动竞态把成功实例的句柄清成「已停止」）──

await rec.check(
  'exit-event-process-identity',
  '旧实例退出不清空当前实例句柄、不触发自愈；当前实例退出才更新状态并自愈',
  async () => {
    const { cm, doctor, fake } = makeClaw()

    // 模拟竞态：先 spawn 的实例 A，句柄被后 spawn 的实例 B 覆盖（旧代码会发生）
    const procA = new FakeProcess()
    cm.process = procA
    cm._setupProcessEvents(procA)
    const procB = new FakeProcess()
    cm.process = procB
    cm._setupProcessEvents(procB)

    // 旧实例 A 退出（比如它发现状态目录被占而退 78）：
    // 绝不能清掉 B 的句柄，也不能替 B 触发一轮 doctor
    procA.emit('exit', 78, null)
    await sleep(120)
    assertEq(cm.process, procB, '旧实例退出不得清空当前实例句柄')
    assertEq(doctor.calls, 0, '旧实例的退出码 78 不得触发自愈')

    // 当前实例 B 自己退 78：照常自愈
    procB.emit('exit', 78, null)
    await sleep(150)
    assert(!!cm.process && cm.process !== procB, '当前实例退出后应经 doctor 重启出新实例')
    assertEq(doctor.calls, 1, '当前实例退 78 应触发一次 doctor')
    assertEq(fake.startCalls, 1, 'doctor 后应重启一次')
    return `doctor ${doctor.calls} 次，句柄归属正确`
  }
)

// ── 8c. start() 并发归并（缺陷：检查与 spawn 之间的 await 窗口被双重进入）──────

await rec.check(
  'start-merge-concurrent',
  '并发调用 start() 只真正 spawn 一次，所有调用方拿到同一次启动结果',
  async () => {
    const cm = new ClawManager({ getDataDir: () => tmpDir })
    let spawns = 0
    cm._spawnGateway = async function () {
      spawns += 1
      await sleep(60) // 模拟 ghost 清理 / 配置同步 / 写 checkpoint 的 await 窗口
      this.process = new FakeProcess()
      return { success: true }
    }
    const results = await Promise.all([cm.start(), cm.start(), cm.start()])
    assertEq(spawns, 1, '并发启动必须归并到一次 spawn')
    assertEq(results.filter((r) => r.success).length, 3, '三个调用方都拿到成功结果')

    // 启动落定后再调用：进程已在跑，返回「已在运行中」而不是再 spawn
    const again = await cm.start()
    assertEq(again.success, false, '已在运行应返回冲突提示')
    assertEq(spawns, 1, '不能再 spawn 第二个网关')
    return `3 路并发仅 spawn ${spawns} 次`
  }
)

// ── 9. 回滚决策：这条判断出过一次把环境焊死的错，逐格盖住 ──────────────────────
//
// 事故：最初只拿「本次 doctor 有没有改 schema」当判据。环境若已被上一次失败迁到
// 一半（state 库升到 19、旧二进制只支持 17），再跑一次因「这次没变化」被判成安全，
// 回滚后新旧都起不来，且备份已被消费 —— 应用再也救不回来。
// 回滚还是单向的（会先删掉新版本 node_modules），所以每一格都必须偏保守。

/** 造一个探针结果，只指定关心的字段 */
const probe = (over = {}) => ({
  ok: false,
  refused: false,
  inconclusive: false,
  maintenanceRequired: false,
  reason: '测试用',
  ...over
})

await rec.check('rollback-ok', '新版本已就绪 → 不回滚', async () => {
  const d = decideRollback(probe({ ok: true }), false)
  assertEq(d.rollback, false, '就绪不该回滚')
  return d.reason
})

await rec.check(
  'rollback-genuinely-broken',
  '进程自退 + 数据未被动过 → 回滚（这是回滚唯一该生效的场景）',
  async () => {
    const d = decideRollback(probe({ refused: true, exitCode: 1 }), false)
    assertEq(d.rollback, true, '新版本确实坏了，应回滚')
    return d.reason
  }
)

await rec.check('rollback-data-migrated', '本次更新迁移过数据 → 不回滚', async () => {
  const d = decideRollback(probe({ refused: true, exitCode: 1 }), true)
  assertEq(d.rollback, false, '数据已迁移，旧版本读不了，不能回滚')
  return d.reason
})

await rec.check(
  'rollback-maintenance-required',
  '数据待迁移（78/迁移提示）→ 不回滚，哪怕本次没检测到 schema 变化',
  async () => {
    // 正是 dev 环境那次事故的形态：state 库在**上一次**失败里就被升到 19，
    // 所以这一次 doctor 再失败也不会带来变化 —— dataMigrated 会是 false，
    // 只有 maintenanceRequired 能挡住回滚。
    const d = decideRollback(probe({ refused: true, exitCode: 78, maintenanceRequired: true }), false)
    assertEq(d.rollback, false, '数据待迁移时回滚可能焊死环境，必须挡住')
    return d.reason
  }
)

await rec.check(
  'rollback-no-evidence',
  '证据不足（未自退 / 启动没发起）→ 不回滚',
  async () => {
    assertEq(decideRollback(probe({ inconclusive: true }), false).rollback, false, 'inconclusive 不回滚')
    assertEq(decideRollback(probe({}), false).rollback, false, '既没自退也没就绪，不回滚')
    return '两种证据不足情形都不回滚'
  }
)

// ── 10. 残留网关清理：按命令行精确命中，不误杀无关 node ───────────────────────
//
// 这一条**真的起 node 进程**：真实网关是 node.exe，用户机器上同时还跑着别的 node，
// 所以「只杀本数据目录的 openclaw 入口」这条判据必须用真进程验，假进程验不出来。

await rec.check(
  'ghost-node-cleanup',
  '残留网关按命令行精确清理，且不误杀无关 node 进程',
  async () => {
    if (process.platform !== 'win32') return '非 win32，跳过'

    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { spawn } = await import('node:child_process')
    const os = await import('node:os')

    const sandbox = mkdtempSync(join(os.tmpdir(), 'umi-ghost-'))
    const dataDir = join(sandbox, 'data')
    const clawJs = join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'dist', 'index.js')
    const decoyJs = join(sandbox, 'unrelated', 'index.js')
    mkdirSync(join(clawJs, '..'), { recursive: true })
    mkdirSync(join(decoyJs, '..'), { recursive: true })
    const stayAlive = 'setInterval(() => {}, 1000)\n'
    writeFileSync(clawJs, stayAlive)
    writeFileSync(decoyJs, stayAlive)

    const ghost = spawn(process.execPath, [clawJs, 'gateway', '--port', '0'], { stdio: 'ignore' })
    const innocent = spawn(process.execPath, [decoyJs], { stdio: 'ignore' })
    await sleep(500)

    const cm = new ClawManager({ getDataDir: () => dataDir })
    // 别真去 taskkill /im bun.exe、openclaw.exe —— 用户机器上可能真有
    cm._killByImageName = async () => {}
    await cm._killGhostProcesses(dataDir)
    await sleep(800)

    const ghostDead = ghost.exitCode !== null || ghost.signalCode !== null
    const innocentAlive = innocent.exitCode === null && innocent.signalCode === null

    innocent.kill('SIGKILL')
    rmSync(sandbox, { recursive: true, force: true })

    assert(ghostDead, `本数据目录的网关进程应被清理（exitCode=${ghost.exitCode}）`)
    assert(innocentAlive, '命令行不含本数据目录 openclaw 入口的 node 进程不得被误杀')
    return `ghost(pid ${ghost.pid}) 已清理；无关 node(pid ${innocent.pid}) 存活`
  }
)

// ── 结果 ─────────────────────────────────────────────────────────────────────

const result = rec.toJSON({ entry: clawPath })
writeJson(join(process.cwd(), 'test', 'accept-result-maintenance.json'), result)
const ok = printResult(result)
process.exit(ok ? 0 : 1)
