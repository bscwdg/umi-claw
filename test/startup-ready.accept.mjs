/**
 * 网关就绪/复用状态验收（node:test）
 *
 * master 没有 4.0 的 claw-maintenance / ui 验收套件，这里用「真 ClawManager + 假 ConfigManager」
 * 覆盖不依赖真实网关的状态机路径（不 spawn、不联网、只用临时目录）：
 *   - waitReady：未运行 → 明确错误；**复用（adoptedPid）状态下认「在运行」**（4.0 8015a52）
 *   - waitReady：复用但未就绪 → 超时错误（不是「未在运行」）
 *   - getStatus：复用后 running/pid/ready/bootPhase 正确；startInFlight 在途 → starting/preparing
 *   - 运行时描述 gateway-runtime.json：含 pid/port/openclawVersion，可被清除
 *
 * 运行：node --test test/startup-ready.accept.mjs
 * （被测 TS 由 build 脚本经 esbuild 打到 test/.tmp/claw-manager.mjs，'electron' 走 fixtures 桩）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const bundle = join(repoRoot, 'test', '.tmp', 'claw-manager.mjs')

const esbuild = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
)

/** 'electron' 用测试桩替换；adm-zip 保持外部依赖（node_modules 里已有） */
const ALIAS_ELECTRON = `--alias:electron=${join(repoRoot, 'test', 'fixtures', 'electron-stub.ts')}`

if (!existsSync(bundle)) {
  execFileSync(
    esbuild,
    [
      join(repoRoot, 'electron', 'main', 'clawManager.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      ALIAS_ELECTRON,
      '--external:adm-zip',
      `--outfile=${bundle}`
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  )
}

const { ClawManager } = await import(pathToFileURL(bundle).href)

/** 假 ConfigManager：只实现 ClawManager 用到的读取接口 */
function makeManager(configOverrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'claw-ready-'))
  const config = {
    port: 3213,
    providers: [],
    activeProvider: '',
    keepGatewayOnQuit: true,
    ...configOverrides
  }
  const configManager = {
    getConfig: () => config,
    getDataDir: () => dataDir,
    getNodePath: () => join(dataDir, 'node.exe'),
    syncOpenClawConfig: async () => ({ ok: true }),
    ensureWebhookMigrationMarker: async () => ({ changed: false })
  }
  return {
    cm: new ClawManager(configManager),
    dataDir,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true })
  }
}

test('waitReady：完全没有在运行 → 明确错误', async () => {
  const { cm, cleanup } = makeManager()
  try {
    const res = await cm.waitReady(100)
    assert.equal(res.ready, false)
    assert.equal(res.error, 'OpenClaw 未在运行')
    assert.equal(res.elapsedMs, 0)
  } finally {
    cleanup()
  }
})

test('waitReady：复用（adoptedPid）且已就绪 → 返回就绪（不再误报未运行）', async () => {
  const { cm, cleanup } = makeManager()
  try {
    cm.adoptedPid = 4321
    cm.startedAt = Date.now() - 5000
    cm.ready = true
    cm.readyAt = Date.now() - 1000

    const res = await cm.waitReady(1000)
    assert.equal(res.ready, true)
    assert.ok(res.elapsedMs >= 4000, 'elapsedMs 应基于 startedAt 计算')
    assert.equal(res.error, undefined)
  } finally {
    cleanup()
  }
})

test('waitReady：复用但未就绪 → 超时错误（不是「未在运行」）', async () => {
  const { cm, cleanup } = makeManager()
  try {
    cm.adoptedPid = 4321
    cm.startedAt = Date.now()
    cm.ready = false
    // 不打真实端口：探活/端口探测一律返回「未通」，只验证 waitReady 的等待与错误路径
    cm._fetchHealthOk = async () => false
    cm._probePortOpen = async () => false

    const res = await cm.waitReady(300)
    assert.equal(res.ready, false)
    assert.match(res.error, /启动超时/)
    assert.notEqual(res.error, 'OpenClaw 未在运行')
  } finally {
    cleanup()
  }
})

test('getStatus：复用状态 → running/pid/ready/bootPhase 正确', () => {
  const { cm, cleanup } = makeManager()
  try {
    cm.adoptedPid = 4321
    cm.startedAt = Date.now() - 3000
    cm.ready = true
    cm.readyAt = Date.now() - 1000

    const st = cm.getStatus()
    assert.equal(st.running, true)
    assert.equal(st.pid, 4321)
    assert.equal(st.ready, true)
    assert.equal(st.starting, false)
    assert.equal(st.bootPhase, 'ready')
    assert.equal(st.startupMs, 2000)
  } finally {
    cleanup()
  }
})

test('getStatus：startInFlight 在途 → starting + bootPhase=preparing', async () => {
  const { cm, cleanup } = makeManager()
  try {
    // 用永不 resolve 的 Promise 模拟「spawn 前的准备阶段」（patch/doctor 在途）
    cm.startInFlight = new Promise(() => {})
    const st = cm.getStatus()
    assert.equal(st.running, false)
    assert.equal(st.starting, true)
    assert.equal(st.bootPhase, 'preparing')
  } finally {
    cleanup()
  }
})

test('运行时描述：写 pid/port/openclawVersion，可清除', () => {
  const { cm, dataDir, cleanup } = makeManager()
  try {
    // 伪造已安装的 openclaw 版本（adopt 的跨版本校验读取点）
    const pkgDir = join(dataDir, 'openclaw', 'node_modules', 'openclaw')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '2026.test.1' }))

    cm.detachedChild = true
    cm.process = { pid: 9876 }
    cm.port = 3213
    cm.startedAt = 1_700_000_000_000
    cm._writeGatewayRuntime(join(dataDir, 'logs', 'openclaw-gateway.log'))

    const file = join(dataDir, 'cache', 'gateway-runtime.json')
    const desc = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(desc.pid, 9876)
    assert.equal(desc.port, 3213)
    assert.equal(desc.detached, true)
    assert.equal(desc.openclawVersion, '2026.test.1', 'adopt 版本校验依赖该字段')
    assert.equal(desc.logFile, join(dataDir, 'logs', 'openclaw-gateway.log'))

    cm._clearGatewayRuntime()
    assert.equal(existsSync(file), false)
  } finally {
    cleanup()
  }
})

test('运行时描述：openclaw 未安装时不写版本（不阻断启动）', () => {
  const { cm, dataDir, cleanup } = makeManager()
  try {
    cm.detachedChild = true
    cm.process = { pid: 1 }
    cm.port = 3213
    cm.startedAt = Date.now()
    cm._writeGatewayRuntime(join(dataDir, 'logs', 'gw.log'))
    const desc = JSON.parse(readFileSync(join(dataDir, 'cache', 'gateway-runtime.json'), 'utf-8'))
    assert.equal(desc.openclawVersion, undefined)
  } finally {
    cleanup()
  }
})
