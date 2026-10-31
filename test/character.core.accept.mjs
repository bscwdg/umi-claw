// test/character.core.accept.mjs —— C01 角色骨架：store / manager / 设置白名单 / 生命周期
//
// 纯 Node 验收，不连 Electron、不连网关：
//   - 打真源码 store.ts / manager.ts / types.ts（bundleEntry 即时编译）
//   - 内存 KV 模拟宿主 app_meta（fish:v2:*）
//   - 覆盖：默认值、坏值回落、事件、启停、互动上限、重置、按日索引与 GC
//
// 用法：node test/character.core.accept.mjs（npm run accept:character）

import { pathToFileURL } from 'node:url'
import { Recorder, assert, assertEq, bundleEntry, printResult } from './_lib.mjs'

const typesMod = await import(pathToFileURL(bundleEntry('electron/main/character/types.ts', 'character-types.mjs')).href)
const storeMod = await import(pathToFileURL(bundleEntry('electron/main/character/store.ts', 'character-store.mjs')).href)
const managerMod = await import(pathToFileURL(bundleEntry('electron/main/character/manager.ts', 'character-manager.mjs')).href)

const {
  CHARACTER_ERROR_CODES,
  DEFAULT_CHARACTER_SETTINGS,
  FISH_KEYS,
  mergeCharacterSettings,
  toCharacterEnvelope,
  toCharacterErrorEnvelope
} = typesMod
const { CharacterStore, formatDate } = storeMod
const { CharacterManager } = managerMod

function memoryKv(initial = new Map()) {
  return {
    map: initial,
    async get(key) {
      return initial.has(key) ? initial.get(key) : null
    },
    async set(key, value) {
      if (value === null) initial.delete(key)
      else initial.set(key, value)
    }
  }
}

const recorder = new Recorder('character.core')

await recorder.check('C1', '默认设置完整 + 白名单合并 + 数值夹取', async () => {
  const kv = memoryKv()
  const store = new CharacterStore({ kv })
  const settings = await store.readSettings()
  assertEq(settings.enabled, false, '默认关闭（D8）')
  assertEq(settings.proactive.silenceDays, 3, '默认静默期 3 天')
  assertEq(settings.relationship.address, '你', '默认称呼「你」')

  const merged = mergeCharacterSettings(settings, {
    enabled: true,
    unknownField: 'ignored',
    proactive: { silenceDays: 99, dailyCap: -1, quietFrom: '25:00', quietTo: '08:00' },
    voice: { dailyCap: 9999 },
    relationship: { address: '  阿爸  ', taboo: ['', ' 主人 ', 123] }
  })
  assertEq(merged.enabled, true, 'enabled 可写')
  assertEq(merged.proactive.silenceDays, 14, '沉默期夹到 0–14')
  assertEq(merged.proactive.dailyCap, 0, '日上限夹到 0–10')
  assertEq(merged.proactive.quietFrom, '23:30', '非法时间格式不生效')
  assertEq(merged.proactive.quietTo, '08:00', '合法时间生效')
  assertEq(merged.voice.dailyCap, 100, '语音日限夹到 0–100')
  assertEq(merged.relationship.address, '阿爸', '称呼 trim 后生效')
  assertEq(JSON.stringify(merged.relationship.taboo), JSON.stringify(['主人']), '禁忌只留非空字符串')
  assertEq('unknownField' in merged, false, '未知字段被丢弃')
  assertEq(settings.enabled, false, '原对象不被改动')
  return '白名单/夹取/未知字段/不可变性 均正确'
})

await recorder.check('C2', '坏 JSON 回落默认值，不抛错', async () => {
  const kv = memoryKv(
    new Map([
      [FISH_KEYS.state, '{bad json'],
      [FISH_KEYS.settings, 'not-json'],
      [FISH_KEYS.meta, '[]']
    ])
  )
  const store = new CharacterStore({ kv })
  const state = await store.readState()
  assertEq(state.familiarity, 0, '坏 state 回落默认 familiarity')
  assertEq(state.stage, 0, '坏 state 回落默认 stage')
  const settings = await store.readSettings()
  assertEq(settings.enabled, false, '坏 settings 回落默认')
  const meta = await store.readMeta()
  assertEq(meta.schemaVersion, 1, '坏 meta 回落当前 schemaVersion')
  return '三类坏值均回落默认'
})

await recorder.check('C3', 'manager 初始化：落默认值、状态就绪、未启用时拒绝互动', async () => {
  const kv = memoryKv()
  const store = new CharacterStore({ kv })
  const events = []
  const manager = new CharacterManager({ store, onEvent: (e) => events.push(e) })
  assertEq(manager.isEnabled(), false, '初始化前未启用')
  let threw = null
  try {
    await manager.getState()
  } catch (e) {
    threw = e
  }
  assertEq(threw?.code, CHARACTER_ERROR_CODES.NOT_READY, '未初始化读取状态 → NOT_READY')

  await manager.init()
  const status = manager.getStatus()
  assertEq(status.storeReady, true, 'store 就绪')
  assertEq(status.enabled, false, '默认未启用')
  assertEq(status.ready, false, '未启用时 ready=false')
  assertEq(kv.map.has(FISH_KEYS.settings), true, '初始化即落默认设置')
  assertEq(kv.map.has(FISH_KEYS.state), true, '初始化即落默认状态')

  let disabled = null
  try {
    await manager.interact({ kind: 'pat' })
  } catch (e) {
    disabled = e
  }
  assertEq(disabled?.code, CHARACTER_ERROR_CODES.DISABLED, '未启用互动 → CHARACTER_DISABLED')
  return '初始化 / 就绪态 / 启用闸门 正确'
})

await recorder.check('C4', '启用后互动累计、上限封顶、事件可订阅', async () => {
  const kv = memoryKv()
  const store = new CharacterStore({ kv })
  const events = []
  const manager = new CharacterManager({ store, onEvent: (e) => events.push(e) })
  await manager.init()

  const settings = await manager.updateSettings({ enabled: true })
  assertEq(settings.enabled, true, '启用成功')
  assertEq(events.some((e) => e.type === 'settings'), true, '设置变更事件已发')
  assertEq(manager.getStatus().ready, true, '启用后 ready=true')

  const afterPat = await manager.interact({ kind: 'pat' })
  assertEq(afterPat.familiarity, 1, '摸头 +1 熟悉度')
  const afterFeed = await manager.interact({ kind: 'feed' })
  assertEq(afterFeed.intimacy, 1, '投喂 +1 亲密度')
  assertEq(afterFeed.lastInteractionAt > 0, true, '记下最近互动时间')
  assertEq(events.some((e) => e.type === 'state'), true, '状态变更事件已发')

  for (let i = 0; i < 120; i += 1) await manager.interact({ kind: 'pat' })
  const capped = await manager.getState()
  assertEq(capped.familiarity, 100, '熟悉度封顶 100')
  return '启用 / 累计 / 上限 / 事件 正确'
})

await recorder.check('C5', '重置数值回到初始；全量重置清空设置', async () => {
  const kv = memoryKv()
  const store = new CharacterStore({ kv })
  const manager = new CharacterManager({ store })
  await manager.init()
  await manager.updateSettings({ enabled: true })
  await manager.interact({ kind: 'pat' })
  await manager.interact({ kind: 'feed' })

  const r1 = await manager.reset({ scope: 'values' })
  assertEq(r1.scope, 'values', '重置返回 scope')
  const state = await manager.getState()
  assertEq(state.familiarity, 0, '数值重置后 familiarity=0')
  assertEq(state.intimacy, 0, '数值重置后 intimacy=0')

  const r2 = await manager.reset({ scope: 'all' })
  assertEq(r2.scope, 'all', '全量重置返回 scope')
  assertEq(manager.isEnabled(), false, '全量重置后回到默认关闭')
  return '数值/全量重置正确'
})

await recorder.check('C6', '按日键索引 + 保留策略 GC（超过 90 天的 day 键被清理）', async () => {
  const base = new Date(2026, 10, 1, 12, 0, 0).getTime()
  let now = base
  const kv = memoryKv()
  const store = new CharacterStore({ kv, now: () => now, dayRetentionDays: 90 })
  for (let i = 0; i < 100; i += 1) {
    const date = formatDate(base - i * 86_400_000)
    await store.writeDay(date, { i })
  }
  const meta = await store.readMeta()
  assertEq(meta.days.length <= 90, true, '日期索引不超过保留窗口')
  const oldest = formatDate(base - 99 * 86_400_000)
  assertEq(kv.map.has(FISH_KEYS.day(oldest)), false, '超期 day 键已被清理')
  const newest = formatDate(base)
  assertEq(kv.map.has(FISH_KEYS.day(newest)), true, '当天 day 键仍在')
  const result = await store.prune()
  assertEq(Array.isArray(result.removedDays), true, 'prune 返回清理结果')
  return '索引/保留/清理正确'
})

await recorder.check('C7', '信封：成功/已知错误/未知错误三种形态稳定', async () => {
  const ok = toCharacterEnvelope({ a: 1 })
  assertEq(ok.ok, true, '成功信封 ok')
  assertEq(ok.data.a, 1, '成功信封 data')

  const { CharacterError } = typesMod
  const known = toCharacterErrorEnvelope(new CharacterError(CHARACTER_ERROR_CODES.DISABLED, '未启用'))
  assertEq(known.ok, false, '已知错误信封 false')
  assertEq(known.error.code, CHARACTER_ERROR_CODES.DISABLED, '已知错误码保留')

  const unknown = toCharacterErrorEnvelope(new Error('boom'))
  assertEq(unknown.ok, false, '未知错误信封 false')
  assertEq(unknown.error.code, CHARACTER_ERROR_CODES.STORE_IO, '未知错误归 STORE_IO')
  assertEq(unknown.error.message, 'boom', '未知错误保留 message')
  return '三种信封形态正确'
})

await recorder.check('C8', '设置合并抗原型污染，不写坏宿主对象', async () => {
  const payload = JSON.parse(
    '{"__proto__":{"polluted":true},"relationship":{"__proto__":{"x":1},"address":"你"}}'
  )
  const merged = mergeCharacterSettings(DEFAULT_CHARACTER_SETTINGS, payload)
  assertEq({}.polluted, undefined, '全局原型未被污染')
  assertEq(merged.relationship.address, '你', '正常字段仍生效')
  return '无原型污染'
})

const ok = printResult(recorder.toJSON())
if (!ok) process.exit(1)
