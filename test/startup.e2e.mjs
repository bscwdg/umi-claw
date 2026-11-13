// test/startup.e2e.mjs —— 启动级 E2E（PLAN-5.0 Phase 0 出口）
//
// 为什么需要：现有 one-day e2e 打真 Worker，但它是「域逻辑端到端」，没有启动真实 Electron app。
// 这里用 UMI_STARTUP_PROBE=1 让真实 `dist-electron/main/index.js` 走到 app.whenReady
// 后写标记并退出；验证 EXE 能启动、主进程入口能加载、版本正确、退出码 0。
// 不建窗口、不拉 DB worker/网关，避免污染用户数据或拖慢验收。

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Recorder, assert, assertEq, printResult, repoRoot, writeJson, __dirname } from './_lib.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const r = new Recorder('Phase 0 · 启动级 E2E（真实 Electron whenReady）')

function spawnProbe(dataDir) {
  const env = { ...process.env, CLAW_DATA_DIR: dataDir, UMI_STARTUP_PROBE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const args = [repoRoot, `--user-data-dir=${join(dataDir, 'user-data')}`, '--no-sandbox']
  return spawn(electronPath, args, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

await r.check('S1', '真实 Electron app 启动到 whenReady，写 startup-probe.json 并退出 0', async () => {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    return '跳过：Linux 无 DISPLAY（CI 无头环境）'
  }
  assert(existsSync(electronPath), `electron 可执行文件存在：${electronPath}`)
  const dataDir = mkdtempSync(join(tmpdir(), 'umi-startup-'))
  const marker = join(dataDir, 'startup-probe.json')
  try {
    const child = spawnProbe(dataDir)
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => (out += String(d)))
    child.stderr?.on('data', (d) => (err += String(d)))
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve('timeout')
      }, 30_000)
      child.once('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    assertEq(code, 0, `app 退出码（stderr 尾部：${err.slice(-500)}）`)
    assert(existsSync(marker), 'startup-probe.json 已写')
    const probe = JSON.parse(readFileSync(marker, 'utf8'))
    assertEq(probe.ok, true, 'probe.ok')
    assertEq(probe.version, '4.3.0', 'probe.version')
    return `真实 Electron 启动 ✓（stdout ${out.length}B / stderr ${err.length}B）`
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-startup.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
