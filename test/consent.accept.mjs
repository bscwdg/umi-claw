// test/consent.accept.mjs —— 用户协议宿生单源服务验收（4.1.1）
//
// **打真实源码**：esbuild 把 electron/main/services/consent.ts 打成临时 ESM，
// 用内存 fake store 注入（不建库、不连 DB、不连网关），纯 Node 可跑。
//
// 覆盖点（对齐这次改造的 5 项判据）：
//   C1 status：空库 → 未同意；grant → 同意且有首次时间
//   C2 grant 幂等：重复同意保留**首次**时间
//   C3 revoke：清 granted、写墓碑、返回 consent:false
//   C4 P1 墓碑：撤销后从插件库迁移**不得复活**（这是本次缺陷的根）
//   C5 迁移幂等：宿主已有结论 → 跳过；插件无源 → 跳过
//   C6 ensure：未同意抛 VALIDATION_ERROR（reason=consent-required）
//   C7 未注入宿主库时 status 不崩（返回未同意）
//   C8 P2：work 停用时 pluginDb 返回 null → 迁移给 plugin-db-unavailable 而不是建库
//   C9 revoke 双保险：work 启用时顺手清插件库旧键
//   C10 生产接线静态核对：启动迁移 + work 委托 + 渲染端宿主 consent（4.2 复核补修 P1-1）
//
// 用法：node test/consent.accept.mjs（npm run accept:consent）

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Recorder, __dirname, assert, assertEq, bundleEntry, printResult, repoRoot, writeJson } from './_lib.mjs'
import { join } from 'node:path'

const mod = await import(
  pathToFileURL(bundleEntry('electron/main/services/consent.ts', 'consent-service.mjs')).href
)
const { createConsentService, CONSENT_KEYS, CONSENT_GRANTED } = mod

/** 内存版 app_meta（模拟宿主 work.db 与插件库） */
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    async metaGet(key) {
      return map.has(key) ? map.get(key) : null
    },
    async metaSet(key, value) {
      if (value === null) map.delete(key)
      else map.set(key, value)
      return { changes: 1 }
    },
    _dump: () => Object.fromEntries(map)
  }
}

const r = new Recorder('用户协议宿生单源（consent:* + 完全委托）')

// ── C1 空库 → 未同意；grant → 同意 ──
await r.check('C1', 'status：空库未同意；grant 后同意且记录首次时间', async () => {
  const host = makeStore()
  const svc = createConsentService({
    hostDb: () => host,
    pluginDb: () => null,
    now: () => 1000
  })
  const s0 = await svc.status()
  assertEq(s0.consent, false, '空库应未同意')
  assertEq(s0.consentAt, null, '空库无时间')
  assertEq(s0.revokedAt, null, '空库无墓碑')

  const g = await svc.grant()
  assertEq(g.consent, true, 'grant 返回同意')
  assertEq(g.consentAt, 1000, '首次时间 = now')

  const s1 = await svc.status()
  assertEq(s1.consent, true, '落库后可读回')
  assertEq(s1.consentAt, 1000, '时间已持久化')
  return '空库未同意 → grant 落库 → 可读回'
})

// ── C2 重复同意保留首次时间 ──
await r.check('C2', 'grant 幂等：重复同意保留**首次**时间', async () => {
  const host = makeStore()
  let clock = 1000
  const svc = createConsentService({ hostDb: () => host, pluginDb: () => null, now: () => clock })
  await svc.grant()
  clock = 5000
  const second = await svc.grant()
  assertEq(second.consentAt, 1000, '第二次同意不得覆盖首次时间')
  return '首次时间 1000 被保留（第二次时钟 5000 未生效）'
})

// ── C3 revoke：清 granted + 写墓碑 ──
await r.check('C3', 'revoke：清同意、写墓碑、返回 consent:false', async () => {
  const host = makeStore()
  let clock = 1000
  const svc = createConsentService({ hostDb: () => host, pluginDb: () => null, now: () => clock })
  await svc.grant()
  clock = 3000
  const res = await svc.revoke()
  assertEq(res.consent, false, '撤销返回未同意')

  const s = await svc.status()
  assertEq(s.consent, false, '撤销后未同意')
  assertEq(s.consentAt, null, '撤销后无时间')
  assertEq(s.revokedAt, 3000, '墓碑写入 now')
  return '同意标记清空 + 墓碑 3000'
})

// ── C4 P1 墓碑：撤销后迁移不得复活（本次缺陷的根）──
await r.check('C4', 'P1 墓碑生效：撤销后从插件库迁移**不得复活**', async () => {
  const host = makeStore()
  const plugin = makeStore({ [CONSENT_KEYS.GRANTED]: CONSENT_GRANTED })
  let clock = 1000
  const svc = createConsentService({ hostDb: () => host, pluginDb: () => plugin, now: () => clock })

  // 用户先同意 → 再撤销
  await svc.grant()
  clock = 3000
  await svc.revoke()

  // 此时插件库里仍有旧 granted（模拟升级用户的历史数据）
  const migrated = await svc.migrateFromPluginDb()
  assertEq(migrated.migrated, false, '有墓碑时不得迁移')
  assertEq(migrated.skipped, 'tombstone', '跳过原因应为 tombstone')

  const s = await svc.status()
  assertEq(s.consent, false, '撤销后绝不能被复活')
  return '墓碑拦住迁移：consent 仍为 false'
})

// ── C5 迁移幂等 + 无源跳过 ──
await r.check('C5', '迁移幂等：宿主已有结论跳过；插件无源跳过', async () => {
  // 5a 插件有 granted、宿主为空 → 迁移成功
  {
    const host = makeStore()
    const plugin = makeStore({
      [CONSENT_KEYS.GRANTED]: CONSENT_GRANTED,
      [CONSENT_KEYS.GRANTED_AT]: '1700000000000'
    })
    const svc = createConsentService({ hostDb: () => host, pluginDb: () => plugin, now: () => 2000 })
    const m1 = await svc.migrateFromPluginDb()
    assertEq(m1.migrated, true, '首次迁移应成功')
    const s = await svc.status()
    assertEq(s.consent, true, '迁移后宿主为同意')
    assertEq(s.consentAt, 1700000000000, '迁移保留原同意时间')

    // 5b 再迁一次 → 幂等跳过
    const m2 = await svc.migrateFromPluginDb()
    assertEq(m2.migrated, false, '重复迁移应跳过')
    assertEq(m2.skipped, 'host-already-decided', '跳过原因')
  }

  // 5c 插件没有 granted → 无源
  {
    const host = makeStore()
    const plugin = makeStore()
    const svc = createConsentService({ hostDb: () => host, pluginDb: () => plugin, now: () => 1 })
    const m = await svc.migrateFromPluginDb()
    assertEq(m.migrated, false, '无源不迁移')
    assertEq(m.skipped, 'no-source', '跳过原因')
  }
  return '迁移成功/幂等跳过/无源跳过 三段'
})

// ── C6 ensure：未同意抛 VALIDATION_ERROR ──
await r.check('C6', 'ensure：未同意抛 VALIDATION_ERROR（reason=consent-required）', async () => {
  const host = makeStore()
  const svc = createConsentService({ hostDb: () => host, pluginDb: () => null, now: () => 1 })
  let code = null
  let reason = null
  try {
    await svc.ensure()
  } catch (e) {
    code = e.code
    reason = e.details && e.details.reason
  }
  assertEq(code, 'VALIDATION_ERROR', '错误码')
  assertEq(reason, 'consent-required', 'details.reason')

  await svc.grant()
  await svc.ensure() // 不抛即通过
  return '未同意 → VALIDATION_ERROR/consent-required；同意后放行'
})

// ── C7 宿主库未就绪时 status 不崩 ──
await r.check('C7', '宿主库未就绪：status 返回未同意而非抛错', async () => {
  const svc = createConsentService({ hostDb: () => null, pluginDb: () => null, now: () => 1 })
  const s = await svc.status()
  assertEq(s.consent, false, '库未就绪视为未同意')
  assertEq(s.consentAt, null, '无时间')
  return '不崩、按未同意处理'
})

// ── C8 P2：work 停用时 pluginDb 为 null → 不建库 ──
await r.check('C8', 'P2 work 停用：pluginDb 返回 null → 迁移给 plugin-db-unavailable（不建库）', async () => {
  const host = makeStore()
  let called = 0
  const svc = createConsentService({
    hostDb: () => host,
    pluginDb: () => {
      called += 1
      return null // 模拟 work 未启用：调用方不提供库
    },
    now: () => 1
  })
  const m = await svc.migrateFromPluginDb()
  assertEq(m.migrated, false, '不应迁移')
  assertEq(m.skipped, 'plugin-db-unavailable', '跳过原因')
  assert(called === 1, '应尝试取值一次（但拿不到库）')
  const s = await svc.status()
  assertEq(s.consent, false, '宿主仍为空')
  return 'null 库 → plugin-db-unavailable，宿主不受影响'
})

// ── C9 revoke 双保险：清了插件库旧键 ──
await r.check('C9', 'revoke 双保险：work 启用时顺手清插件库旧键', async () => {
  const host = makeStore()
  const plugin = makeStore({
    [CONSENT_KEYS.GRANTED]: CONSENT_GRANTED,
    [CONSENT_KEYS.GRANTED_AT]: '111'
  })
  const svc = createConsentService({ hostDb: () => host, pluginDb: () => plugin, now: () => 9 })
  await svc.grant()
  await svc.revoke()

  const dump = plugin._dump()
  assert(!('wizard_consent' in dump), '插件库 granted 应被清')
  assert(!('wizard_consent_at' in dump), '插件库时间应被清')
  return '插件库旧键已清空（墓碑 + 双保险）'
})

// ── C10 生产接线静态核对（4.2 复核补修：启动迁移不能只靠 afterEnable）──
await r.check('C10', '生产接线：启动迁移 + work 委托 + 渲染端读宿主 consent', async () => {
  const read = (rel) => readFileSync(join(repoRoot, rel), 'utf-8')

  // 启动迁移与 afterEnable 迁移必须是两处调用；启动那处必须是 init().then 链式（删掉 = 升级用户重复弹协议）
  const hostSrc = read('electron/main/index.ts')
  const migrateCalls = (hostSrc.match(/migrateFromPluginDb\(\)/g) || []).length
  assert(migrateCalls >= 2, `migrateFromPluginDb 应有启动 + afterEnable 两处调用（实际 ${migrateCalls}）`)
  assert(
    /pluginRuntime\.init\(\)\.then\(\(\) => consentService\.migrateFromPluginDb\(\)\)/.test(hostSrc),
    '启动迁移必须挂在 pluginRuntime.init().then(...) 之后（activateAll 之后才迁移）'
  )

  // work 插件把宿主 consent 透传给 wizardManager（任一处断开都会回落到插件库）
  assert(
    /consent:\s*consent\s*\?\?\s*undefined/.test(read('plugins/work/main.ts')),
    'work main 应把 ctx.services.consent 传给 runtime'
  )
  assert(
    /consent:\s*deps\.consent/.test(read('plugins/work/domain/runtime.ts')),
    'runtime 应把 consent 传给 wizardManager'
  )
  const manifest = JSON.parse(read('plugins/work/plugin.json'))
  assert(manifest.inject.includes('consent'), 'work plugin.json 必须声明 consent')

  // 渲染端首启读宿主通道；决定向导前查插件激活态（避免 plugins.list 竞态）
  const appSrc = read('src/App.vue')
  assert(/api\.consent\.status\(\)/.test(appSrc), 'App 首启应读宿主 consent 通道')
  assert(
    /api\.plugins\.list\(\)/.test(appSrc) && /async function isWorkPluginActive/.test(appSrc),
    'App 应通过 isWorkPluginActive() 查插件状态（避免使用共享 ref 的竞态）'
  )
  const workActiveCalls = (appSrc.match(/await isWorkPluginActive\(\)/g) || []).length
  assert(workActiveCalls >= 2, `首启与同意后两处都应走 isWorkPluginActive()（实际 ${workActiveCalls}）`)

  // enabled 集合只收「已激活」：激活失败的插件没有通道，盲调会 No handler。
  // 注意 main.ts 里还有一处 `status.enabled && status.state === 'activated'`（安装 UI 用），
  // 所以必须精确断言 enabledPluginIds 的赋值表达式，不能全文搜 activated。
  assert(
    /enabledPluginIds\.value = new Set\(\s*statuses\.filter\(\(x\) => x\.enabled && x\.state === 'activated'\)/.test(
      read('src/renderer/main.ts')
    ),
    'enabledPluginIds 只应收 enabled && activated 的插件'
  )

  // P2-4：宿主库未就绪时的 skipped 必须是 host-db-unavailable（且不抛错）
  const nullHostSvc = createConsentService({
    hostDb: () => null,
    pluginDb: () => makeStore({ [CONSENT_KEYS.GRANTED]: CONSENT_GRANTED }),
    now: () => 1
  })
  const nullHostMigrate = await nullHostSvc.migrateFromPluginDb()
  assertEq(nullHostMigrate.skipped, 'host-db-unavailable', 'hostDb 为 null 时跳因应为 host-db-unavailable')
  return '启动迁移 / 委托 / 渲染端接线静态核对通过'
})

const result = r.toJSON({})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-consent.json'), result)
console.log('结果已写入 test/accept-result-consent.json')
process.exit(ok ? 0 : 1)
