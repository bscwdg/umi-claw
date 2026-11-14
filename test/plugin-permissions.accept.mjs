// test/plugin-permissions.accept.mjs —— Phase 1 B2：权限 manifest / 授权存储 / broker / 审计 / env
//
// 只测纯 Node 边界：不 fork 子进程、不启用 Node permission（那会限制验收进程自身）。
// 真机 --experimental-permission 行为由 B0 spike + B4 负向测试覆盖。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  assertDeepEq,
  bundleEntry,
  printResult,
  repoRoot,
  writeJson
} from './_lib.mjs'

const r = new Recorder('Phase 1 · 插件权限模型（manifest / store / broker / audit / env）')
const require = createRequire(import.meta.url)
const manifestMod = await import(
  pathToFileURL(bundleEntry('electron/main/kernel/manifest.ts', 'perm-manifest.mjs')).href
)
const permMod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginPermissions.ts', 'perm-service.mjs')).href
)

const baseManifest = {
  id: 'perm-probe',
  name: '权限探针',
  version: '1.0.0',
  capabilities: [],
  inject: ['host'],
  activation: ['onStartup'],
  defaultEnabled: false
}

await r.check('P1', 'manifest permissions：合法申请可解析；未知键/绝对路径/.. 穿越 fail-closed', async () => {
  const parsed = manifestMod.parseManifest(
    {
      ...baseManifest,
      permissions: {
        fs: { read: ['docs'], write: ['cache/tmp'] },
        network: ['api.example.com', '*.trusted.test'],
        services: ['config', 'notifications']
      }
    },
    '<test>'
  )
  assertEq(parsed.permissions.fs.read[0], 'docs', 'fs.read')
  assertEq(parsed.permissions.fs.write[0], 'cache/tmp', 'fs.write')
  assertEq(parsed.permissions.network[0], 'api.example.com', 'network')
  assertEq(parsed.permissions.services.includes('config'), true, 'services')

  for (const bad of [
    { permissions: { unknown: true } },
    { permissions: { fs: { read: ['../escape'] } } },
    { permissions: { fs: { read: ['C:\\Windows'] } } },
    { permissions: { fs: { read: ['C:..'] } } },
    { permissions: { fs: { read: ['C:'] } } },
    { permissions: { fs: { read: ['a b'] } } },
    { permissions: { fs: { read: ['x --allow-fs-read=C:\\Windows'] } } },
    { permissions: { network: ['http://example.com/path'] } },
    { permissions: { services: ['Bad Name'] } }
  ]) {
    let threw = null
    try {
      manifestMod.parseManifest({ ...baseManifest, ...bad }, '<test>')
    } catch (e) {
      threw = e
    }
    assert(threw, `应拒绝：${JSON.stringify(bad)}`)
    assertEq(threw.field.startsWith('permissions'), true, `错误字段：${threw.field}`)
  }
  return 'manifest 权限校验 ✓'
})

await r.check('P2', '默认拒绝：未授权时 fs/network/service 全部 denied，且写审计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const auditFile = join(dir, 'audit.log')
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const audit = permMod.createPermissionAudit(auditFile)
    const broker = permMod.createPermissionBroker({
      store,
      audit,
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    const read = broker.check('p1', { type: 'fs.read', path: join(dir, 'plugin', 'main.js') })
    const net = broker.check('p1', { type: 'network', host: 'api.example.com' })
    const svc = broker.check('p1', { type: 'service', name: 'config' })
    assertEq(read.allowed, false, '默认拒绝 fs.read')
    assertEq(net.allowed, false, '默认拒绝 network')
    assertEq(svc.allowed, false, '默认拒绝 service')
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n')
    assertEq(lines.length, 3, '3 条审计')
    assert(lines.every((l) => JSON.parse(l).allowed === false), '审计记录 denied')
    return '默认拒绝 + 审计 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P3', '授权后 allowlist 生效：fs read/write、network 通配、service；撤销立即拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const pluginDir = join(dir, 'plugin')
    const dataDir = join(dir, 'data')
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const audit = permMod.createPermissionAudit(join(dir, 'audit.log'))
    const broker = permMod.createPermissionBroker({
      store,
      audit,
      rootsFor: () => ({ pluginDir, dataDir })
    })
    store.grant('p1', {
      fs: { read: ['docs'], write: ['cache'] },
      network: ['*.example.com'],
      services: ['config']
    })

    assertEq(broker.check('p1', { type: 'fs.read', path: join(pluginDir, 'main.js') }).allowed, true, '插件目录默认可读')
    assertEq(broker.check('p1', { type: 'fs.read', path: join(dataDir, 'docs', 'a.txt') }).allowed, true, 'docs 可读')
    assertEq(broker.check('p1', { type: 'fs.read', path: join(dataDir, 'secret.txt') }).allowed, false, '未申请路径不可读')
    assertEq(broker.check('p1', { type: 'fs.write', path: join(dataDir, 'cache', 'a.bin') }).allowed, true, 'cache 可写')
    assertEq(broker.check('p1', { type: 'fs.write', path: join(dataDir, 'docs', 'a.txt') }).allowed, false, 'docs 不可写')
    assertEq(broker.check('p1', { type: 'network', host: 'api.example.com' }).allowed, true, '通配域名放行')
    assertEq(broker.check('p1', { type: 'network', host: 'sub.example.com' }).allowed, true, '通配子域放行')
    assertEq(broker.check('p1', { type: 'network', host: 'example.com' }).allowed, false, '*. 不匹配裸域')
    assertEq(broker.check('p1', { type: 'network', host: 'evil-example.com' }).allowed, false, '后缀伪装拒绝')
    assertEq(broker.check('p1', { type: 'network', host: 'evil.test' }).allowed, false, '未申请域名拒绝')
    assertEq(broker.check('p1', { type: 'service', name: 'config' }).allowed, true, '已申请服务')
    assertEq(broker.check('p1', { type: 'service', name: 'secrets' }).allowed, false, '未申请服务')

    store.revoke('p1')
    assertEq(broker.check('p1', { type: 'fs.read', path: join(pluginDir, 'main.js') }).allowed, false, '撤销后立即拒绝')
    return '授权/allowlist/撤销 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P4', '授权持久化：换 store 实例仍可读；坏文件 fail-closed 为空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const file = join(dir, 'permissions.json')
    const s1 = permMod.createPermissionStore(file)
    s1.grant('p1', { services: ['config'] })
    const s2 = permMod.createPermissionStore(file)
    assertEq(s2.get('p1').permissions.services[0], 'config', '换实例可读')
    writeFileSync(file, '{bad json', 'utf8')
    const s3 = permMod.createPermissionStore(file)
    assertEq(s3.get('p1'), undefined, '坏文件 fail-closed')
    return '持久化/坏文件 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P5', 'NODE_OPTIONS 权限注入 + 子进程 env 白名单（不含宿主密钥/数据目录）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const pluginDir = join(dir, 'plugin')
    const dataDir = join(dir, 'data')
    const env = permMod.buildPluginPermissionEnv({
      pluginDir,
      dataDir,
      permissions: { fs: { read: ['docs'], write: ['cache'] }, network: ['api.example.com'] },
      baseEnv: {
        PATH: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        OPENAI_API_KEY: 'sk-secret',
        CLAW_DATA_DIR: 'C:\\Users\\me\\data',
        AWS_SECRET_ACCESS_KEY: 'secret'
      }
    })
    assert(/--experimental-permission/.test(env.NODE_OPTIONS), '带 permission 旗标')
    assert(env.NODE_OPTIONS.includes('--allow-fs-read=.'), 'cwd（插件目录）可读，相对路径避开空格')
    assert(env.NODE_OPTIONS.includes('--allow-fs-read=../data/docs'), 'docs 可读（相对 cwd）')
    assert(env.NODE_OPTIONS.includes('--allow-fs-write=../data/cache'), 'cache 可写（相对 cwd）')
    assert(!env.NODE_OPTIONS.includes(dir), 'NODE_OPTIONS 不含绝对路径')
    assertEq(env.OPENAI_API_KEY, undefined, '不透传 API key')
    assertEq(env.CLAW_DATA_DIR, undefined, '不透传宿主数据目录')
    assertEq(env.AWS_SECRET_ACCESS_KEY, undefined, '不透传云密钥')
    assertEq(env.PATH, 'C:\\Windows', '保留 PATH')
    return 'NODE_OPTIONS/env 白名单 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P6', '生产接线：grant 只授予 manifest 已申请权限；broker 已接入 pluginRuntime', async () => {
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  assert(/plugin:permissions:grant/.test(src), '注册 grant IPC')
  assert(/record\.manifest\.permissions/.test(src), 'grant 以 manifest.permissions 为准')
  assert(/createPermissionBroker/.test(src), 'broker 已创建')
  assert(/plugin-audit\.log/.test(src), '审计日志路径')
  const preload = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf8')
  assert(/plugin:permissions:list/.test(preload) && /revokePermissions/.test(preload), 'preload 暴露权限 API')
  return '生产接线 ✓'
})

await r.check('P7', '恶意/损坏 grant 不崩溃：结构坏 entry fail-closed，路径越界拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const audit = permMod.createPermissionAudit(join(dir, 'audit.log'))
    const pluginDir = join(dir, 'plugin')
    const dataDir = join(dir, 'data')
    const broker = permMod.createPermissionBroker({ store, audit, rootsFor: () => ({ pluginDir, dataDir }) })
    // 绕过类型直接写入历史/损坏 grant（模拟手改 permissions.json）
    store.grant('p1', { fs: { read: ['C:..'] } })
    assertEq(broker.check('p1', { type: 'fs.read', path: join(dir, 'plugins', 'other', 'data.db') }).allowed, false, '越界路径拒绝')
    // 结构坏 entry 在 load 时被丢弃
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ schema: 1, grants: { p2: { pluginId: 'p2', permissions: null } } }), 'utf8')
    const s2 = permMod.createPermissionStore(join(dir, 'permissions.json'))
    assertEq(s2.get('p2'), undefined, '坏 entry 丢弃')
    return '损坏 grant fail-closed ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P8', '安装/数据路径含空格时用相对路径注入，不拆分 NODE_OPTIONS', async () => {
  const dir = join(tmpdir(), 'umi space', 'plugin')
  const dataDir = join(tmpdir(), 'umi space', 'data')
  const env = permMod.buildPluginPermissionEnv({ pluginDir: dir, dataDir, permissions: {} })
  assert(env.NODE_OPTIONS.includes('--allow-fs-read=.'), 'cwd 相对路径')
  assert(!/\s--/.test(env.NODE_OPTIONS.replace('--experimental-permission ', '')), '旗标之间没有裸空格路径')
  return '空格路径相对注入 ✓'
})

await r.check('P9', '审计日志不写完整绝对路径（只写 basename）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const auditFile = join(dir, 'audit.log')
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const audit = permMod.createPermissionAudit(auditFile)
    const pluginDir = join(dir, 'plugin')
    const dataDir = join(dir, 'data')
    const broker = permMod.createPermissionBroker({ store, audit, rootsFor: () => ({ pluginDir, dataDir }) })
    store.grant('p1', { fs: { read: ['docs'] } })
    broker.check('p1', { type: 'fs.read', path: join(dataDir, 'docs', 'secret-name.txt') })
    const line = JSON.parse(readFileSync(auditFile, 'utf8').trim())
    assertEq(line.target, 'secret-name.txt', 'target 只写 basename')
    assert(!readFileSync(auditFile, 'utf8').includes(dataDir), '审计不含完整路径')
    return '审计脱敏 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P10', '真 Electron 子进程：相对 NODE_OPTIONS + 空格安装目录仍能读插件入口', async () => {
  const base = join(tmpdir(), 'umi space e2e')
  const pluginDir = join(base, 'plugin dir')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'entry.txt'), 'perm-ok', 'utf8')
  try {
    const env = permMod.buildPluginPermissionEnv({
      pluginDir,
      dataDir: join(base, 'data dir'),
      permissions: {},
      baseEnv: process.env
    })
    const electronPath = require('electron')
    const script = `try{console.log(require('fs').readFileSync(process.argv[1],'utf8'))}catch(e){console.log('ERR',e.code);process.exit(2)}`
    const result = spawnSync(electronPath, ['-e', script, 'entry.txt'], {
      cwd: pluginDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: env.NODE_OPTIONS },
      encoding: 'utf8',
      timeout: 15000
    })
    assertEq(result.status, 0, `electron 退出码（stderr ${String(result.stderr).slice(-300)}）`)
    assertEq(String(result.stdout).trim(), 'perm-ok', '读取插件入口目录')
    return '相对 NODE_OPTIONS 真进程 ✓'
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

await r.check('P11', '内部服务永不对第三方开放：manifest 拒绝 consent/abort，broker 双保险拒绝历史 grant', async () => {
  for (const name of ['consent', 'abort', 'hostOps', 'legacyDb']) {
    let err = null
    try {
      manifestMod.parseManifest({ ...baseManifest, permissions: { services: [name] } }, '<test>')
    } catch (e) {
      err = e
    }
    assert(err, `${name} 应被 manifest 拒绝`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'umi-perm-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    const broker = permMod.createPermissionBroker({
      store,
      audit: permMod.createPermissionAudit(join(dir, 'audit.log')),
      rootsFor: () => ({ pluginDir: join(dir, 'plugin'), dataDir: join(dir, 'data') })
    })
    store.grant('p1', { services: ['consent'] })
    assertEq(broker.check('p1', { type: 'service', name: 'consent' }).allowed, false, 'consent 被 broker 拒绝')
    return '内部服务 allowlist ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await r.check('P12', '升级授权只收窄：新 grant = 旧 grant ∩ 新 manifest，新增权限不继承', async () => {
  const oldPerms = {
    fs: { read: ['a', 'b'], write: ['c'] },
    network: ['x.com'],
    services: ['kv', 'db']
  }
  const nextPerms = {
    fs: { read: ['b', 'c'], write: ['c', 'd'] },
    network: ['x.com', 'y.com'],
    services: ['db', 'secrets']
  }
  const merged = permMod.intersectPermissions(oldPerms, nextPerms)
  assertDeepEq(merged, {
    fs: { read: ['b'], write: ['c'] },
    network: ['x.com'],
    services: ['db']
  })
  assertEq(permMod.intersectPermissions({}, nextPerms).services, undefined, '旧授权为空则不继承')
  return '授权求交 ✓'
})

await r.check('P13', '安装期 reparse point 检测：junction 被识别并拒绝', async () => {
  if (process.platform !== 'win32') return '跳过：非 Windows'
  const dir = mkdtempSync(join(tmpdir(), 'umi-reparse-'))
  const target = join(dir, 'target')
  const link = join(dir, 'link')
  mkdirSync(target)
  writeFileSync(join(target, 'x.txt'), 'x')
  const res = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' })
  try {
    if (res.status !== 0) return '跳过：当前环境不允许创建 junction'
  assertEq(permMod.findReparsePoint(dir), link, 'junction 被识别')
  assertEq(permMod.findReparsePoint(join(dir, 'missing')) ?? null, null, '不存在目录不误报')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return 'reparse point 检测 ✓'
})

await r.check('P14', '升级 reconcile：交集为空时撤销，不留下假授权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umi-grant-'))
  try {
    const store = permMod.createPermissionStore(join(dir, 'permissions.json'))
    store.grant('p', { services: ['kv'] })
    const kept = permMod.applyPermissionUpdate(store, 'p', { services: ['kv'] }, { services: ['kv', 'db'] })
    assertEq(kept, true, '有交集保留授权')
    assertEq(store.get('p')?.permissions.services.join(','), 'kv', '新增 db 不继承')
    const revoked = permMod.applyPermissionUpdate(store, 'p', { services: ['kv'] }, { services: ['db'] })
    assertEq(revoked, false, '无交集撤销')
    assertEq(store.get('p'), undefined, 'store 已撤销')
    return '空交集撤销 ✓'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-permissions.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
