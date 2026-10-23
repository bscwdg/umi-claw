// test/node-runtime.accept.mjs —— Node 运行时引擎闸门验收
//
// 背景：openclaw@2026.10.6 把 engines.node 抬到 `>=24.22.1 <25 || >=26.12.1`，
// 而便携运行时停在 v24.21.0。旧判据（24.16.0 / 26.1.0）把它当“兼容”，更新链路
// 也没有预检，结果 npm preinstall 直接退出码 1，三个镜像源白跑 4 分钟才回滚。
//
// **打真实源码**：esbuild bundle electron/main/downloadManager.ts 后 import，
// 断言区间判据、报错解析与「内置默认版本自身必须满足 OpenClaw 要求」。
//
// 用法：node test/node-runtime.accept.mjs    （npm run accept:node-runtime）

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  writeJson
} from './_lib.mjs'

const downloadPath = bundleEntry('electron/main/downloadManager.ts', 'node-runtime-download-manager.mjs', {
  alias: ['electron=./test/fixtures/electron-stub.mjs'],
  externals: ['adm-zip']
})
const dl = await import(pathToFileURL(downloadPath).href)
const { OPENCLAW_NODE_RANGE, NODE_VERSION, satisfiesNodeRange, satisfiesOpenClawNodeRange, parseRequiredNodeRange } = dl

const r = new Recorder('node-runtime')

try {
  await r.check('N1', '内置默认 Node 版本必须满足 OpenClaw 当前引擎要求', () => {
    assert(
      satisfiesOpenClawNodeRange(NODE_VERSION),
      `NODE_VERSION=${NODE_VERSION} 不满足 ${OPENCLAW_NODE_RANGE}（新装环境会直接装出跑不起来的核心）`
    )
    return `${NODE_VERSION} ∈ ${OPENCLAW_NODE_RANGE}`
  })

  await r.check('N2', '引擎区间边界：24.21.0 / 24.22.0 不满足，24.22.1 满足', () => {
    const bad = ['v24.21.0', 'v24.22.0', 'v24.0.0', 'v25.0.0', 'v25.9.0', 'v26.12.0', 'v26.0.0']
    const good = ['v24.22.1', 'v24.23.0', 'v24.99.0', 'v26.12.1', 'v26.13.0', 'v27.0.0']
    for (const v of bad) assert(!satisfiesOpenClawNodeRange(v), `${v} 不应被判为满足`)
    for (const v of good) assert(satisfiesOpenClawNodeRange(v), `${v} 应被判为满足`)
    return `${bad.length} 个不满足 / ${good.length} 个满足，边界全部命中`
  })

  await r.check('N3', '区间判据支持 npm semver 常见写法', () => {
    assertEq(satisfiesNodeRange('v24.22.1', '^24.22.1'), true, '^ 下界含等号')
    assertEq(satisfiesNodeRange('v25.0.0', '^24.22.1'), false, '^ 不得跨大版本')
    assertEq(satisfiesNodeRange('v24.22.5', '~24.22.1'), true, '~ 同 minor 内')
    assertEq(satisfiesNodeRange('v24.23.0', '~24.22.1'), false, '~ 不得跨 minor')
    assertEq(satisfiesNodeRange('v24.5.0', '24'), true, '裸大版本按整段区间')
    assertEq(satisfiesNodeRange('v25.0.0', '24'), false, '裸大版本不跨大版本')
    assertEq(satisfiesNodeRange('v24.22.1', '24.22'), true, '裸 x.y 按 minor 区间')
    assertEq(satisfiesNodeRange('v24.23.0', '24.22'), false, '裸 x.y 不跨 minor')
    assertEq(satisfiesNodeRange('v24.22.1', '>=24.22.1 <25 || >=26.12.1'), true, '|| 命中第一段')
    assertEq(satisfiesNodeRange('v26.12.1', '>=24.22.1 <25 || >=26.12.1'), true, '|| 命中第二段')
    return '^ ~ 裸版本 || 与 AND 语义均正确'
  })

  await r.check('N4', '能从 npm preinstall 报错里解析出要求区间', () => {
    const real =
      'npm error command C:\\Windows\\system32\\cmd.exe /d /s /c node scripts/preinstall-package-manager-warning.mjs\n' +
      'npm error [openclaw] error: this OpenClaw release requires Node >=24.22.1 <25 || >=26.12.1.\n' +
      'npm error [openclaw] detected Node 24.21.0 (exec: D:\\work2026\\umi-claw\\data\\runtime\\node-win32-x64\\node.exe).\n'
    assertEq(parseRequiredNodeRange(real), '>=24.22.1 <25 || >=26.12.1', '应去掉句末句点并保留区间')
    assert(satisfiesNodeRange('v24.22.1', parseRequiredNodeRange(real)), '解析出的区间应可直接用于判据')
    assertEq(parseRequiredNodeRange('npm error code E404'), null, '无关报错不得误判为引擎错误')
    assertEq(parseRequiredNodeRange(''), null, '空串返回 null')
    return '真实报错文本解析正确，且不会把 404 之类误判成引擎闸门'
  })

  await r.check('N6', '渲染端 isNodeCompatible 与主进程判据不漂移', () => {
    const vue = readFileSync(join(__dirname, '..', 'src', 'views', 'Setup.vue'), 'utf-8')
    const m = vue.match(/function isNodeCompatible\(v: string\): boolean \{([\s\S]*?)\n\}/)
    assert(m, 'Setup.vue 里找不到 isNodeCompatible（判据被改名/删除？）')
    // 纯数字逻辑，去掉参数类型注解后可直接执行
    const uiCheck = new Function('v', m[1].replace(/: string/g, ''))
    const samples = ['v24.21.0', 'v24.22.0', 'v24.22.1', 'v24.23.0', 'v25.0.0', 'v26.11.9', 'v26.12.0', 'v26.12.1', 'v27.0.0']
    for (const v of samples) {
      assertEq(uiCheck(v), satisfiesOpenClawNodeRange(v), `Setup.vue 与主进程判据不一致：${v}`)
    }
    return `${samples.length} 个样本两端判据一致`
  })

  await r.check('N7', 'env:init 必须停/起网关并共用启动闸（Node 自动升级会结束进程）', () => {
    const mainSrc = readFileSync(join(__dirname, '..', 'electron', 'main', 'index.ts'), 'utf-8')
    const start = mainSrc.indexOf('const envInitImpl')
    const end = mainSrc.indexOf('const envUpdateImpl', start)
    assert(start >= 0 && end > start, '找不到 envInitImpl（初始化入口被改名？）')
    const block = mainSrc.slice(start, end)
    assert(block.includes('clawManager.getStatus().running'), '必须记录 wasRunning')
    assert(block.includes('clawManager.stop()'), '初始化前必须停网关')
    assert(block.includes('clawManager.start()'), '初始化后必须按原状态恢复网关')
    assert(block.includes('envUpdateInFlight = true'), '初始化期间必须闸住外部启动')
    return '停网关 → 初始化 → 恢复，且 envUpdateInFlight 全程命中'
  })

  await r.check('N5', '更新链路必须在建快照前做 Node 预检（防回归）', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'main', 'downloadManager.ts'), 'utf-8')
    const updateBody = src.slice(src.indexOf('async updateOpenClaw('), src.indexOf('private async _ensureNodeRuntimeFor('))
    assert(updateBody.includes('_ensureNodeRuntimeFor('), 'updateOpenClaw 必须调用 _ensureNodeRuntimeFor')
    assert(
      updateBody.indexOf('_ensureNodeRuntimeFor(') < updateBody.indexOf('_snapshotOpenClawForUpdate()'),
      'Node 预检必须在建快照之前：升级失败时环境应原封不动'
    )
    assert(updateBody.includes('_installOpenClawWithNodeRecovery('), '更新安装必须走引擎错误自愈包装')
    return '预检 → 快照 → 安装（带引擎自愈）的顺序固定在源码里'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
}

const result = r.toJSON({ bundle: downloadPath, range: OPENCLAW_NODE_RANGE, nodeVersion: NODE_VERSION })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-node-runtime.json'), result)
process.exitCode = ok ? 0 : 1
