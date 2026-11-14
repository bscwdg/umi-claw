// test/plugin-install.e2e.mjs —— C5 真机：真实 .umi-plugin 安装 → staging → utilityProcess 启动
//
// 不 mock installer/manager：main 进程用 installPluginPackage 解包验签，再把 staging
// child 交给 utilityProcess；插件 main.js 复制 test/fixtures/security-plugin.cjs。

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder, __dirname, assert, assertEq, printResult, repoRoot, writeJson } from './_lib.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const r = new Recorder('Phase 2 · 真实安装→启动 E2E（C5）')

await r.check('I1', 'keygen/pack → Electron 安装 → staged child → utilityProcess → invoke', async () => {
  if (process.platform === 'linux' && !process.env.DISPLAY) return '跳过：Linux 无 DISPLAY'
  const root = mkdtempSync(join(tmpdir(), 'umi-install-e2e-'))
  const dataDir = join(root, 'data')
  try {
    const src = join(root, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'e2e-inst', version: '1.0.0', name: 'E2E Install' }), 'utf8')
    writeFileSync(join(src, 'main.js'), readFileSync(join(__dirname, 'fixtures', 'security-plugin.cjs')), 'utf8')
    const keyFile = join(root, 'key.json')
    const pkgFile = join(root, 'e2e-inst.umi-plugin')
    const run = (args) => spawnSync(process.execPath, ['scripts/umi-plugin.mjs', ...args], { encoding: 'utf8' })
    assertEq(run(['keygen', '--out', keyFile]).status, 0, 'keygen')
    assertEq(
      run(['pack', '--source', src, '--out', pkgFile, '--key-file', keyFile, '--include-public-key']).status,
      0,
      'pack'
    )
    assert(existsSync(pkgFile), '安装包存在')

    const env = {
      ...process.env,
      UMI_INSTALL_PROBE: '1',
      UMI_INSTALL_PROBE_DIR: dataDir,
      UMI_INSTALL_PACKAGE: pkgFile
    }
    delete env.CLAW_DATA_DIR
    delete env.ELECTRON_RUN_AS_NODE
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
      }, 40_000)
      child.once('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    assertEq(code, 0, `app 退出码（stderr 尾部：${stderr.slice(-800)}）`)
    const marker = join(dataDir, 'install-probe.json')
    assert(existsSync(marker), 'install-probe.json 已写')
    const probe = JSON.parse(readFileSync(marker, 'utf8'))
    if (!probe.ok) {
      writeFileSync(join(repoRoot, 'data', 'tmp', 'install-e2e-stderr.log'), stderr, 'utf8')
    }
    assertEq(probe.ok, true, `探针失败：${probe.error ?? ''}；stderr=${stderr.slice(-3000)}`)
    assertEq(probe.id, 'e2e-inst', '安装 id')
    assertEq(probe.version, '1.0.0', '安装版本')
    assertEq(probe.state, 'running', '启动状态')
    assertEq(probe.env?.path, true, '真实 child 环境')
    assertEq(probe.env?.dataDir ?? null, null, '宿主数据目录不进 child env')
    assert(existsSync(probe.entry), '宿主 child 存在')
    assert(probe.entry.includes('dist-electron'), '启动使用宿主 app 内 child（Electron utilityProcess 约束）')
    assert(existsSync(join(dataDir, 'plugin-runtime')), 'staging 目录已写')
    const state = JSON.parse(readFileSync(join(dataDir, 'plugin-install-state.json'), 'utf8'))
    assertEq(state.plugins['e2e-inst'].version, '1.0.0', '安装态落盘')
    return '安装→启动真机全链路 ✓'
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-install-e2e.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
