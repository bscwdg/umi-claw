// test/gateway-log-files.accept.mjs —— 网关日志落盘验收（管道 tee / detached 直写 / fd 生命周期）
//
// 打真实源码：
//   - electron/main/claw/spawnEnv.ts 的 openGatewayLogFiles / writeGatewayLogChunk /
//     closeGatewayLogFds（纯 Node，无 electron 依赖，直接 bundle import）
//   - electron/main/clawManager.ts 的 _setupProcessEvents（electron 边界打桩，
//     与 claw-maintenance 套件同口径，adm-zip 标 external）
// 覆盖：两种 stdio 模式都建日志文件、每次拉起截断、原始 chunk 不按行重切、
//       缺 fd/重复关闭/目录不可建均静默降级、exit 与 stop 两条路径都关 fd 不泄漏。
//
// 用法：node test/gateway-log-files.accept.mjs（npm run accept:gateway-log）

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, assert, assertEq, bundleEntry, printResult, tmpDir, writeJson } from './_lib.mjs'

const suite = '网关日志落盘（管道 tee / detached / fd 生命周期）'
const rec = new Recorder(suite)

const runDir = join(tmpDir, `gateway-log-${Date.now()}-${process.pid}`)
mkdirSync(runDir, { recursive: true })

// ── bundle 真源码 ─────────────────────────────────────────────────────────────
const spawnEnvPath = bundleEntry('electron/main/claw/spawnEnv.ts', 'gateway-log-spawn-env.mjs')
const spawnEnv = await import(pathToFileURL(spawnEnvPath).href)
const { openGatewayLogFiles, writeGatewayLogChunk, closeGatewayLogFds } = spawnEnv

const clawPath = bundleEntry('electron/main/clawManager.ts', 'gateway-log-claw-manager.mjs', {
  alias: ['electron=./test/fixtures/electron-stub.mjs'],
  externals: ['adm-zip']
})
const { ClawManager } = await import(pathToFileURL(clawPath).href)

const LOG_NAME = 'openclaw-gateway.log'
const ERR_NAME = 'openclaw-gateway.err.log'

// ── 1. 管道模式：文件建好、fd 可用、detached=false ─────────────────────────────
await rec.check('GL1', '管道模式（keepOnQuit=false）：建文件并打开 fd，detached=false', async () => {
  const dataDir = join(runDir, 'gl1')
  const r = openGatewayLogFiles(false, dataDir)
  assertEq(r.detached, false, 'detached 必须为 false')
  assertEq(typeof r.logFd, 'number', 'stdout fd 已打开')
  assertEq(typeof r.errFd, 'number', 'stderr fd 已打开')
  assertEq(r.logFile, join(dataDir, 'logs', LOG_NAME), '日志路径固定在 data/logs')
  assertEq(existsSync(r.logFile), true, 'stdout 日志文件存在')
  assertEq(existsSync(r.errFile), true, 'stderr 日志文件存在')
  assertEq(readFileSync(r.logFile, 'utf8'), '', '新建文件应为空')
  closeGatewayLogFds([r.logFd, r.errFd])
  return '管道模式文件与 fd 就绪'
})

// ── 2. detached 模式：同一对文件，detached=true ───────────────────────────────
await rec.check('GL2', '保留网关模式（keepOnQuit=true）：detached=true 且同样落盘', async () => {
  const dataDir = join(runDir, 'gl2')
  const r = openGatewayLogFiles(true, dataDir)
  assertEq(r.detached, true, 'detached 必须为 true')
  assertEq(typeof r.logFd, 'number', 'stdout fd 已打开')
  assertEq(typeof r.errFd, 'number', 'stderr fd 已打开')
  writeGatewayLogChunk(r.logFd, Buffer.from('detached-line\n'))
  closeGatewayLogFds([r.logFd, r.errFd])
  assertEq(readFileSync(join(dataDir, 'logs', LOG_NAME), 'utf8'), 'detached-line\n', 'fd 写入可读回')
  return 'detached 语义保持'
})

// ── 3. 每次拉起截断：不无限增长、不串轮次 ─────────────────────────────────────
await rec.check('GL3', '再次打开截断旧内容：每轮网关只保留本轮日志', async () => {
  const dataDir = join(runDir, 'gl3')
  const first = openGatewayLogFiles(false, dataDir)
  writeGatewayLogChunk(first.logFd, 'old-run-content')
  closeGatewayLogFds([first.logFd, first.errFd])
  assertEq(readFileSync(join(dataDir, 'logs', LOG_NAME), 'utf8'), 'old-run-content', '首轮内容已写入')

  const second = openGatewayLogFiles(false, dataDir)
  assertEq(readFileSync(second.logFile, 'utf8'), '', '新一轮拉起必须截断旧日志')
  writeGatewayLogChunk(second.logFd, Buffer.from('new-run'))
  closeGatewayLogFds([second.logFd, second.errFd])
  assertEq(readFileSync(join(dataDir, 'logs', LOG_NAME), 'utf8'), 'new-run', '只保留新一轮内容')
  return '截断语义正确'
})

// ── 4. 写入助手：原始 chunk 不重切、string/Buffer 都行、缺 fd 不炸 ─────────────
await rec.check('GL4', 'writeGatewayLogChunk：原样写入、缺 fd/重复关闭静默', async () => {
  const dataDir = join(runDir, 'gl4')
  const r = openGatewayLogFiles(false, dataDir)
  const multi = Buffer.from('line-a\nline-b\nno-newline-tail')
  writeGatewayLogChunk(r.logFd, multi)
  writeGatewayLogChunk(r.errFd, 'string-chunk\n')
  assertEq(readFileSync(r.logFile).equals(multi), true, 'Buffer 原样落盘（不按行重切）')
  assertEq(readFileSync(r.errFile, 'utf8'), 'string-chunk\n', 'string chunk 可写')
  closeGatewayLogFds([r.logFd, r.errFd])

  let threw = false
  try {
    writeGatewayLogChunk(undefined, 'no-fd') // 缺 fd：空操作
    closeGatewayLogFds([undefined]) // 空列表项忽略
    closeGatewayLogFds([r.logFd, r.logFd]) // 重复关闭不抛
  } catch {
    threw = true
  }
  assertEq(threw, false, '缺 fd/重复关闭都不能抛异常')
  return '写入助手容错正确'
})

// ── 5. 打开失败优雅退回（不阻断网关启动）──────────────────────────────────────
await rec.check('GL5', '日志目录不可建：fds 为 undefined、detached=false、不抛异常', async () => {
  // dataDir 本身是一个文件时，其下 logs/ 子目录 mkdir 必然失败
  const blockedFile = join(runDir, 'gl5-blocker')
  writeFileSync(blockedFile, 'i am a file')
  let r
  let threw = false
  try {
    r = openGatewayLogFiles(false, blockedFile)
  } catch {
    threw = true
  }
  assertEq(threw, false, '打开失败不得抛出')
  assertEq(r.logFd, undefined, 'stdout fd 缺省')
  assertEq(r.errFd, undefined, 'stderr fd 缺省')
  assertEq(r.detached, false, '失败时强制非 detached（退回管道+纯内存）')
  let writeThrew = false
  try {
    writeGatewayLogChunk(undefined, Buffer.from('x'))
  } catch {
    writeThrew = true
  }
  assertEq(writeThrew, false, '无 fd 时 tee 写入静默')
  return '失败回退正确'
})

// ── 假网关进程：EventEmitter + 可发 data 的 stdout/stderr 流 ───────────────────
class FakeStream extends EventEmitter {}
class FakeGatewayProcess extends EventEmitter {
  constructor() {
    super()
    this.pid = 9527
    this.stdout = new FakeStream()
    this.stderr = new FakeStream()
    this.killed = []
  }

  kill(signal) {
    this.killed.push(signal)
    setImmediate(() => this.emit('exit', 0, null))
    return true
  }
}

function makeManager(dataDir) {
  const cm = new ClawManager({ getDataDir: () => dataDir })
  // 绕过真实 spawn：只验证 _setupProcessEvents 的真源码 tee 链路
  const opened = openGatewayLogFiles(false, dataDir)
  cm.gatewayPipeLogFd = opened.logFd
  cm.gatewayPipeErrFd = opened.errFd
  return { cm, opened }
}

// ── 6. 端到端：data 事件 tee 进文件，内存 ring buffer 行为不变 ─────────────────
await rec.check('GL6', 'ClawManager 管道 data 事件：原始输出 tee 落盘 + ring buffer 照常', async () => {
  const dataDir = join(runDir, 'gl6')
  const { cm, opened } = makeManager(dataDir)
  const proc = new FakeGatewayProcess()
  cm.process = proc
  cm._setupProcessEvents(proc)

  proc.stdout.emit('data', Buffer.from('ready on 3213\nplugin loaded\n'))
  proc.stderr.emit('data', Buffer.from('warn: something\n'))

  assertEq(readFileSync(opened.logFile, 'utf8'), 'ready on 3213\nplugin loaded\n', 'stdout 原始 chunk 落盘')
  assertEq(readFileSync(opened.errFile, 'utf8'), 'warn: something\n', 'stderr 原始 chunk 落盘')
  const ring = cm.getLogs().map((e) => `${e.type}:${e.line}`)
  assertEq(ring.includes('stdout:ready on 3213'), true, 'ring buffer 仍收 stdout 行')
  assertEq(ring.includes('stderr:warn: something'), true, 'ring buffer 仍收 stderr 行')

  proc.emit('exit', 0, null)
  assertEq(cm.gatewayPipeLogFd, undefined, 'exit 后 stdout fd 已关闭摘钩')
  assertEq(cm.gatewayPipeErrFd, undefined, 'exit 后 stderr fd 已关闭摘钩')
  assertEq(readFileSync(opened.logFile, 'utf8'), 'ready on 3213\nplugin loaded\n', '退出后文件保留')

  let threw = false
  try {
    proc.stdout.emit('data', Buffer.from('after-exit\n'))
  } catch {
    threw = true
  }
  assertEq(threw, false, '退出后的迟到 data 不抛异常')
  return 'tee 与 ring buffer 并行正确，exit 清理 fd'
})

// ── 7. stop() 主动关 fd（stop 先摘 tracked 引用，exit 会按旧实例跳过清理）──────
await rec.check('GL7', 'stop() 立即摘 fd，不依赖随后的 exit 事件', async () => {
  const dataDir = join(runDir, 'gl7')
  const { cm, opened } = makeManager(dataDir)
  const proc = new FakeGatewayProcess()
  cm.process = proc
  cm._setupProcessEvents(proc)
  proc.stdout.emit('data', Buffer.from('before-stop\n'))

  await cm.stop()
  assertEq(cm.gatewayPipeLogFd, undefined, 'stop 后 stdout fd 已摘')
  assertEq(cm.gatewayPipeErrFd, undefined, 'stop 后 stderr fd 已摘')
  assertEq(proc.killed.includes('SIGTERM'), true, 'stop 仍走 SIGTERM')
  assertEq(readFileSync(opened.logFile, 'utf8'), 'before-stop\n', 'stop 前内容已落盘')
  return 'stop 路径无 fd 泄漏'
})

// ── 8. 归属守卫：旧实例的迟到 data 不混进新一轮日志文件（审查 #6）──────────────
await rec.check('GL8', '进程归属守卫：非 tracked 旧进程的输出不写当前日志文件', async () => {
  const dataDir = join(runDir, 'gl8')
  const { cm, opened } = makeManager(dataDir)
  const oldProc = new FakeGatewayProcess()
  cm.process = oldProc
  cm._setupProcessEvents(oldProc)
  oldProc.stdout.emit('data', Buffer.from('old-tracked\n'))

  // 新实例接管 tracked 引用（双启动竞态：旧进程对象仍存活、监听仍在）
  const newProc = new FakeGatewayProcess()
  cm.process = newProc
  cm._setupProcessEvents(newProc)
  oldProc.stdout.emit('data', Buffer.from('old-ghost-late\n'))
  oldProc.stderr.emit('data', Buffer.from('old-ghost-err\n'))
  newProc.stdout.emit('data', Buffer.from('new-tracked\n'))

  const out = readFileSync(opened.logFile, 'utf8')
  assertEq(out.includes('old-tracked\n'), true, '接管前旧进程作为 tracked 的输出保留')
  assertEq(out.includes('old-ghost-late'), false, '接管后旧进程迟到输出不得落盘')
  assertEq(out.includes('new-tracked\n'), true, '新 tracked 进程正常落盘')
  assertEq(readFileSync(opened.errFile, 'utf8').includes('old-ghost-err'), false, 'stderr 同样按归属隔离')

  // _closePipeLogFds 幂等：exit 与 stop 双路径都可能调用
  newProc.emit('exit', 0, null)
  let threw = false
  try {
    cm._closePipeLogFds()
    cm._closePipeLogFds()
  } catch {
    threw = true
  }
  assertEq(threw, false, '重复关闭不抛异常')
  return '归属守卫与幂等关闭正确'
})

// ── 清理与结果 ─────────────────────────────────────────────────────────────────
rmSync(runDir, { recursive: true, force: true })

const result = rec.toJSON({ entry: [spawnEnvPath, clawPath] })
writeJson(join(process.cwd(), 'test', 'accept-result-gateway-log.json'), result)
const ok = printResult(result)
process.exit(ok ? 0 : 1)
