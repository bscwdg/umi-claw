// test/plugin-isolation.e2e.mjs —— Phase 1 B3 真机：utilityProcess + 权限 env + 服务桥
//
// 通过 UMI_ISOLATION_PROBE=1 让真实 Electron main 用 PluginSupervisor fork
// dist-electron/main/pluginProcessChild.js，加载 test/fixtures/service-plugin.cjs，
// 插件 ctx.services.kv.get 经宿主 onService 返回，主进程写 marker 后退出。

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder, __dirname, assert, assertEq, printResult, repoRoot, writeJson } from './_lib.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const r = new Recorder('Phase 1 · 隔离真机 E2E（utilityProcess + 权限 env + 服务桥）')

await r.check('E1', '真实 utilityProcess：activate → ctx.services.kv.get → 宿主返回 → invoke', async () => {
  if (process.platform === 'linux' && !process.env.DISPLAY) return '跳过：Linux 无 DISPLAY'
  assert(existsSync(join(repoRoot, 'dist-electron', 'main', 'pluginProcessChild.js')), 'child 构建产物存在')
  const dataDir = mkdtempSync(join(tmpdir(), 'umi-iso-e2e-'))
  const marker = join(dataDir, 'isolation-probe.json')
  const env = {
    ...process.env,
    CLAW_DATA_DIR: dataDir,
    UMI_ISOLATION_PROBE: '1',
    UMI_ISOLATION_PLUGIN_DIR: join(repoRoot, 'test', 'fixtures'),
    UMI_ISOLATION_MAIN: join(repoRoot, 'test', 'fixtures', 'security-plugin.cjs'),
    UMI_SECRET_SENTINEL: 'should-not-leak'
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [repoRoot, `--user-data-dir=${join(dataDir, 'user-data')}`, '--no-sandbox'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr?.on('data', (d) => (stderr += String(d)))
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
    assertEq(code, 0, `app 退出码（stderr 尾部：${stderr.slice(-800)}）`)
    assert(existsSync(marker), 'isolation-probe.json 已写')
    const probe = JSON.parse(readFileSync(marker, 'utf8'))
    if (!probe.ok) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(repoRoot, 'data', 'tmp', 'b3-e2e-stderr.log'), stderr, 'utf8')
    }
    assertEq(probe.ok, true, `探针失败：${probe.error ?? ''}；stderr=${stderr.slice(-1200)}`)
    assertEq(probe.result, 'host-value', '插件读到宿主服务返回值')
    assertEq(probe.state, 'running', 'invoke 时处于 running')
    const sec = probe.security ?? {}
    assertEq(sec.escape?.ok, true, 'escape 方法执行')
    assertEq(sec.escape?.value?.code, 'ERR_ACCESS_DENIED', 'fs 越界被 Node 权限拒绝')
    assertEq(sec.spawn?.value?.ok, false, 'spawn 被拒绝')
    assertEq(sec.spawn?.value?.code, 'ERR_ACCESS_DENIED', 'spawn 错误码')
    assertEq(sec.worker?.value?.ok, false, 'worker 被拒绝')
    assertEq(sec.worker?.value?.code, 'ERR_ACCESS_DENIED', 'worker 错误码')
    assertEq(sec.native?.ok, true, 'native 方法执行')
    assert(
      sec.native?.value?.code === 'ERR_ACCESS_DENIED' || sec.native?.value?.code === 'ERR_DLOPEN_DISABLED',
      `dlopen 错误码=${sec.native?.value?.code}`
    )
    assertEq(sec.env?.value?.sentinel, null, '宿主 env 不泄漏')
    assertEq(sec.env?.value?.path, true, 'PATH 保留')
    assertEq(sec.env?.value?.home ?? null, null, 'HOME 不传')
    assertEq(sec.env?.value?.userProfile ?? null, null, 'USERPROFILE 不传')
    assertEq(sec.env?.value?.appData ?? null, null, 'APPDATA 不传')
    assertEq(sec.env?.value?.dataDir ?? null, null, 'CLAW_DATA_DIR 不传')
    return 'utilityProcess 全链路 ✓'
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-isolation-e2e.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
