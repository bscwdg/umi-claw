/**
 * Commit 06/07 打包态端到端（对应 PLAN §九 待办 #25）
 *
 * 做法：对**真安装包产物** `release/win-unpacked/Umi Claw.exe` 加 `--remote-debugging-port`，
 * 用 CDP 在**真实渲染进程**里调真实的 `window.api.*`，验的是
 * 「打包后的 main + preload + db-worker.mjs + 便携 Node + 便携数据目录」整条链路，
 * 不是单元测试的替身。
 *
 * 本脚本覆盖（06/07 新面）：
 *   - 打包态建库（11 表 / uv=1）与 Project / Knowledge / Watchlist 真 IPC
 *   - **07 的 `marketing:gateway:{status}` 只读面**在打包 preload 里真的存在，且快照不含 token
 *   - 打包启动时**配置迁移真落地**：openclaw.json 里 chatCompletions.enabled=true、meta 无非法字段（#15）
 *   - 06/07 两个模块在打包 main 里真的被构造（stdout 里的就绪日志）
 *
 * ⚠️ 安全阀（必须保持）：`clawManager.start()` 内含 `_killGhostProcesses()` →
 * `taskkill /f /im openclaw.exe`，会误杀**本机正在运行**的 OpenClaw（含托管本会话的实例）。
 * 因此本脚本：
 *   ① 预写便携 `config/app.json`（`autoStart:false`，并把 `port` 改成 3299 不去碰真机的 3213）；
 *   ② **绝不调用** `claw:*` / `marketing:gateway:ensureReady`（任何会触发 start() 的面）；
 *   ③ 收尾按 **PID** 结束本进程，不做任何按镜像名的全量 taskkill。
 *
 * 用法：node test/packaged-gateway.smoke.mjs   （加 --keep 保留数据目录与日志）
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { __dirname, repoRoot, sleep, tmpDir, writeJson } from './_lib.mjs'

const exeDir = join(repoRoot, 'release', 'win-unpacked')
const exePath = join(exeDir, 'Umi Claw.exe')
const dataDir = join(exeDir, 'data')
const userDataDir = join(exeDir, 'context-data')
const runDir = join(tmpDir, `packaged-07-${Date.now()}`)
const CDP_PORT = Number(process.env.CDP_PORT || 9223)

const checks = []
function check(id, name, fn) {
  try {
    const detail = fn()
    checks.push({ id, name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (e) {
    checks.push({ id, name, ok: false, detail: (e && e.message) || String(e) })
  }
}
function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message)
}
function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`断言失败: ${message} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

// ── CDP 小工具（与 test/packaged-smoke.mjs 同口径：只用 Node 自带 WebSocket） ──
async function waitForPage(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) {
      lastErr = e
    }
    await sleep(500)
  }
  throw new Error(`等待 CDP 目标超时：${lastErr ? lastErr.message : '未出现 page target'}`)
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true })
  })
}

async function evalJs(ws, expression) {
  const id = Math.floor(Math.random() * 1e9)
  const result = await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
      })
    )
  })
  if (result.exceptionDetails) {
    throw new Error('EVAL_EXCEPTION ' + JSON.stringify(result.exceptionDetails).slice(0, 400))
  }
  return result.result?.value ?? null
}

// ── 准备便携数据目录 ──────────────────────────────────────────────────────────
let child = null
let stdoutAll = ''
let stderrAll = ''

try {
  assert(existsSync(exePath), `找不到打包产物：${exePath}（先跑 npm run build:win）`)
  mkdirSync(runDir, { recursive: true })
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  // 便携 Node 就位（否则 DB Worker 起不来 → SETUP_REQUIRED）
  const repoRuntime = join(repoRoot, 'data', 'runtime', 'node-win32-x64')
  assert(existsSync(join(repoRuntime, 'node.exe')), `仓库便携 Node 缺失：${repoRuntime}\\node.exe`)
  cpSync(repoRuntime, join(dataDir, 'runtime', 'node-win32-x64'), { recursive: true })
  // 安全阀：不自动拉起 gateway；端口也避开真机的 3213
  writeFileSync(
    join(dataDir, 'config', 'app.json'),
    JSON.stringify({ port: 3299, autoStart: false }, null, 2),
    'utf-8'
  )

  child = spawn(exePath, [`--remote-debugging-port=${CDP_PORT}`], {
    cwd: exeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (d) => (stdoutAll += d.toString('utf-8')))
  child.stderr.on('data', (d) => (stderrAll += d.toString('utf-8')))

  const page = await waitForPage()
  const ws = await openWs(page.webSocketDebuggerUrl)

  // ── P1 打包态建库（便携 Node + db-worker.mjs） ──
  const dbStatus = await evalJs(ws, `window.api.marketing.system.dbStatus({ initialize: true })`)
  check('P1', '打包态建库：便携 Node + db-worker.mjs 可用（11 表 / uv=1）', () => {
    assertEq(dbStatus.ok, true, 'dbStatus 应成功')
    const data = dbStatus.data
    assertEq(data.userVersion, 1, 'user_version 应为 1')
    assert(Array.isArray(data.tables) && data.tables.length >= 11, `表数应 ≥ 11（实际 ${data.tables?.length}）`)
    return `${data.tables.length} 表 / uv=${data.userVersion} / sqlite ${data.sqliteVersion}`
  })

  // ── P2 07 只读就绪面在打包 preload 里真的存在 ──
  const surface = await evalJs(
    ws,
    `({ status: typeof window.api.marketing.gateway?.status, ensureReady: typeof window.api.marketing.gateway?.ensureReady, token: window.api.marketing.gateway?.token })`
  )
  check('P2', '打包 preload 暴露 marketing.gateway.{status,ensureReady}，且不泄 token', () => {
    assertEq(surface.status, 'function', 'status 应是函数')
    assertEq(surface.ensureReady, 'function', 'ensureReady 应是函数')
    assertEq(surface.token, undefined, 'gateway 面上不得有 token 字段（硬规则 13）')
    return '两条通道在；面内无 token'
  })

  // ── P3 status 是真的发 HTTP 并正确判非就绪（只读、零 token、不拉进程） ──
  const gwStatus = await evalJs(ws, `window.api.marketing.gateway.status()`)
  check('P3', 'gateway.status 真发 HTTP 且正确判定「未就绪」（零 token、不触发拉起）', () => {
    assertEq(gwStatus.ok, true, 'status 应成功返回快照（探活失败也是成功返回）')
    const d = gwStatus.data
    assertEq(d.port, 3299, '应按便携配置用 3299（不碰真机 3213）')
    assertEq(d.ready, false, '3299 没有服务 → 不应就绪')
    assertEq(d.endpointsEnabled, false, '端点开关也应为 false')
    assertEq(d.lastError?.code, 'OPENCLAW_NOT_READY', '应给出 OPENCLAW_NOT_READY')
    assertEq(d.lastError?.details?.reason, 'connect-failed', '原因应是 connect-failed')
    return `port=${d.port} ready=${d.ready} code=${d.lastError?.code}/${d.lastError?.details?.reason}`
  })

  // ── P4 03/05a 真 IPC 在打包态可用（顺带证明没有回归） ──
  const project = await evalJs(ws, `window.api.marketing.project.create({ name: 'E2E C06/C07 商家' })`)
  const projectId = project?.data?.id
  check('P4', '打包态真 IPC：Project / Knowledge / Watchlist / 当前商家', () => {
    assertEq(project.ok, true, '建商家应成功')
    assert(projectId, '应回 project id')
    assertEq(existsSync(join(dataDir, 'projects', projectId)), true, '应建出 data/projects/<id>/')
    return `project=${projectId.slice(0, 8)}… 目录已建`
  })

  const knowledge = await evalJs(
    ws,
    `window.api.marketing.knowledge.create(${JSON.stringify(projectId)}, { title: 'E2E 价目表', type: 'text', content: '婚纱套系 5999 元，含 30 张精修。' })`
  )
  const search = await evalJs(ws, `window.api.marketing.knowledge.search(${JSON.stringify(projectId)}, '5999')`)
  const watch = await evalJs(
    ws,
    `window.api.marketing.watchlist.add(${JSON.stringify(projectId)}, '杭州婚纱', 'industry')`
  )
  const current = await evalJs(
    ws,
    `window.api.marketing.context.setCurrentProject(${JSON.stringify(projectId)}).then(() => window.api.marketing.context.getCurrentProject())`
  )
  check('P5', '打包态 Knowledge 写入 + LIKE 检索 + Watchlist + 当前商家持久化', () => {
    assertEq(knowledge.ok, true, 'knowledge.create 应成功')
    assertEq(search.ok, true, '检索应成功')
    assertEq(search.data.length >= 1, true, `应能检索到（实际 ${search.data.length} 条）`)
    assertEq(watch.ok, true, 'watchlist.add 应成功')
    assertEq(current?.data?.id, projectId, '当前商家应已是它')
    return `检索 ${search.data.length} 条（snippet 命中 5999）；watchlist 已加；current=${projectId.slice(0, 8)}…`
  })

  // ── P6 打包启动时的配置迁移真落地（#17 端点开关 + #15 meta） ──
  const configPath = join(dataDir, 'config', '.openclaw', 'openclaw.json')
  check('P6', '打包启动即同步：chatCompletions.enabled=true 且 meta 无非法字段（#15）', () => {
    assert(existsSync(configPath), `应生成 ${configPath}`)
    const json = JSON.parse(readFileSync(configPath, 'utf-8'))
    assertEq(
      json?.gateway?.http?.endpoints?.chatCompletions?.enabled,
      true,
      '打包态也须把兼容面默认打开（§六 实测默认 false）'
    )
    assertEq('lastTouchedAt' in (json?.meta || {}), false, 'meta.lastTouchedAt 不得写入（schema 非法字段）')
    assert(json?.meta?.lastTouchedVersion !== 'latest', "meta.lastTouchedVersion 不得是字面量 'latest'")
    return `enabled=${json.gateway.http.endpoints.chatCompletions.enabled}；meta=${JSON.stringify(json.meta ?? null)}`
  })

  // ── P7 06/07 在打包 main 里真的被构造（stdout 就绪日志） ──
  check('P7', '打包 main 里 06/07 两个模块真的被构造（就绪日志）', () => {
    assert(/\[context\] Context Engine 就绪/.test(stdoutAll), '缺 Context Engine 就绪日志（06 未接线？）')
    assert(/\[gateway\] Gateway Client 就绪/.test(stdoutAll), '缺 Gateway Client 就绪日志（07 未接线？）')
    const line = stdoutAll.split('\n').find((l) => l.includes('[gateway] Gateway Client 就绪')) || ''
    return line.replace(/^\s+/, '').slice(0, 120)
  })

  try {
    ws.close()
  } catch {
    /* 忽略 */
  }
} catch (e) {
  checks.push({ id: 'PX', name: '脚本执行异常', ok: false, detail: (e && e.stack) || String(e) })
} finally {
  // 只按 PID 结束本进程（绝不做按镜像名的全量 taskkill）
  if (child && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
    await sleep(500)
  }
}

const leftover = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='Umi Claw.exe'" | Where-Object { $_.ExecutablePath -like '*win-unpacked*' } | Measure-Object).Count`
  ],
  { encoding: 'utf-8', windowsHide: true }
)
const leftoverCount = Number((leftover.stdout || '0').trim() || 0)

const passed = checks.filter((c) => c.ok).length
const result = {
  suite: 'packaged-06/07（真安装包产物 + CDP 驱真渲染进程）',
  finishedAt: new Date().toISOString(),
  total: checks.length,
  passed,
  failed: checks.length - passed,
  exePath,
  dataDir,
  leftoverPackagedProcesses: leftoverCount,
  stderrSample: stderrAll.split('\n').slice(0, 10),
  checks
}

console.log('')
console.log(`===== ${result.suite} =====`)
for (const c of checks) {
  console.log(`${c.ok ? '[PASS]' : '[FAIL]'} ${c.id} ${c.name}`)
  if (c.detail) console.log('        -> ' + c.detail)
}
console.log(`----- 打包态: ${passed}/${checks.length} 通过 -----`)
console.log(`残留打包进程: ${leftoverCount}（应为 0）`)

mkdirSync(tmpDir, { recursive: true })
writeJson(join(__dirname, 'packaged-smoke-07.json'), result)
console.log('结果已写入 test/packaged-smoke-07.json')

if (!process.argv.includes('--keep')) {
  try {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(passed === checks.length && leftoverCount === 0 ? 0 : 1)
