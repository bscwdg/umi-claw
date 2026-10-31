// test/character.core.accept.mjs —— C01 角色骨架：store / manager / 设置白名单 / 生命周期
//
// 纯 Node 验收，不连 Electron、不连网关：
//   - 打真源码 store.ts / manager.ts / types.ts（bundleEntry 即时编译）
//   - 内存 KV 模拟宿主 app_meta（fish:v2:*）
//   - 覆盖：默认值、坏值回落、事件、启停、互动上限、重置、按日索引与 GC
//
// 用法：node test/character.core.accept.mjs（npm run accept:character）

import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Recorder, assert, assertEq, bundleEntry, printResult, repoRoot, tmpDir } from './_lib.mjs'

const typesMod = await import(pathToFileURL(bundleEntry('electron/main/character/types.ts', 'character-types.mjs')).href)
const storeMod = await import(pathToFileURL(bundleEntry('electron/main/character/store.ts', 'character-store.mjs')).href)
const managerMod = await import(pathToFileURL(bundleEntry('electron/main/character/manager.ts', 'character-manager.mjs')).href)
const personaMod = await import(pathToFileURL(bundleEntry('electron/main/character/persona.ts', 'character-persona.mjs')).href)
const agentConfigMod = await import(pathToFileURL(bundleEntry('electron/main/character/agentConfig.ts', 'character-agent-config.mjs')).href)
const bootstrapMod = await import(pathToFileURL(bundleEntry('electron/main/character/bootstrap.ts', 'character-bootstrap.mjs')).href)

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
const { applyTemplate, buildPersonaVars, composePersonaFiles, writeManagedFiles, safeJoin } = personaMod
const { buildAgentPatch, readAgentEntry } = agentConfigMod
const { runBootstrap } = bootstrapMod

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

const personaSrcDir = join(repoRoot, 'resources', 'character', 'persona')

function loadTemplates() {
  const read = (name) => readFileSync(join(personaSrcDir, name), 'utf8')
  return {
    soul: read('SOUL.md.tpl'),
    identity: read('IDENTITY.md.tpl'),
    agents: read('AGENTS.md.tpl'),
    user: read('USER.md.tpl'),
    core: read('core.md'),
    voice: read('voice.md')
  }
}

function baseInputs(overrides = {}) {
  return {
    settings: {
      ...JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS)),
      relationship: {
        ...JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS.relationship)),
        ...(overrides.relationship ?? {})
      }
    },
    state: {
      ...{
        bornAt: 1,
        stage: 1,
        familiarity: 10,
        intimacy: 20,
        streakDays: 3,
        lastInteractionAt: 5,
        addressForm: '你',
        mood: '有点得意',
        updatedAt: 6
      }
    },
    templates: loadTemplates(),
    herName: '大肥鱼'
  }
}

await recorder.check('C9', '人格变量：空值降级「你」、称呼注入、无占位符残留、禁忌空=不限制', async () => {
  const vars = buildPersonaVars(baseInputs())
  assertEq(vars.address, '你', '未设置称呼时默认「你」')
  assertEq(vars.address, vars.address.trim(), '称呼不带头尾空格')

  const withName = buildPersonaVars(baseInputs({ relationship: { address: '', userName: '阿爸' } }))
  assertEq(withName.address, '阿爸', '没填 address 时用 userName')

  const explicit = buildPersonaVars(baseInputs({ relationship: { address: '老板', userName: '阿爸' } }))
  assertEq(explicit.address, '老板', 'address 优先于 userName')

  assertEq(applyTemplate('叫{{address}}', withName), '叫阿爸', '变量替换')
  assertEq(applyTemplate('叫{{unknownVar}}', vars), '叫', '未知变量清空')
  assertEq(applyTemplate('{{address}}/{{userName}}', { address: '', userName: '' }), '你/你', '空变量降级「你」')

  const files = composePersonaFiles(baseInputs({ relationship: { address: '老板' } }))
  for (const content of Object.values(files)) {
    assertEq(/\{\{[^}]+\}\}/.test(content), false, '落盘文件不应残留 {{变量}}')
  }
  assertEq(files['SOUL.md'].includes('本鱼'), true, 'SOUL 含自称「本鱼」')
  assertEq(files['AGENTS.md'].includes('老板'), true, 'AGENTS 注入称呼')
  assertEq(files['AGENTS.md'].includes('任何称呼都不拦截'), true, '禁忌空时明确不拦截')
  assertEq(files['USER.md'].includes('（无）'), true, 'USER 禁忌为空显示（无）')

  const tabooFiles = composePersonaFiles(
    baseInputs({ relationship: { taboo: ['主人', '爸爸'] } })
  )
  assertEq(tabooFiles['AGENTS.md'].includes('主人、爸爸'), true, 'AGENTS 列出禁忌称呼')
  return '变量替换/降级/禁忌规则 正确'
})

await recorder.check('C10', '受管写入：用户改过的不覆盖、STATE 归宿主、路径越界拒绝', async () => {
  const dir = join(tmpDir, `character-persona-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const files = composePersonaFiles(baseInputs())

  const first = writeManagedFiles(dir, files)
  assertEq(first.written.includes('SOUL.md'), true, '首次写入 SOUL.md')
  assertEq(first.written.includes('fish/STATE.md'), true, '首次写入 STATE.md')
  assertEq(existsSync(join(dir, 'SOUL.md')), true, 'SOUL 已落盘')
  assertEq(existsSync(join(dir, '.fish-managed.json')), true, 'manifest 已落盘')

  // 用户改 SOUL.md：后续写入必须保留
  const custom = `${readFileSync(join(dir, 'SOUL.md'), 'utf8')}\n<!-- 用户自己加的一句 -->\n`
  writeFileSync(join(dir, 'SOUL.md'), custom, 'utf8')
  const second = writeManagedFiles(dir, files)
  assertEq(second.kept.includes('SOUL.md'), true, '用户改过的 SOUL 被保留')
  assertEq(readFileSync(join(dir, 'SOUL.md'), 'utf8').includes('用户自己加的一句'), true, 'SOUL 改动仍在')

  // STATE 宿主维护：即使用户改也会被重写
  writeFileSync(join(dir, 'fish/STATE.md'), '# 乱改\n', 'utf8')
  const third = writeManagedFiles(dir, files)
  assertEq(third.written.includes('fish/STATE.md'), true, 'STATE 每次重写')
  assertEq(readFileSync(join(dir, 'fish/STATE.md'), 'utf8').includes('鱼的状态'), true, 'STATE 内容恢复')

  let rejected = false
  try {
    safeJoin(dir, '../escape.md')
  } catch {
    rejected = true
  }
  assertEq(rejected, true, '拒绝 ../ 越界路径')
  return '受管写入/用户改动保护/宿主文件 正确'
})

await recorder.check('C11', 'agent 补丁构造与配置读回（官方 config patch 载荷）', async () => {
  const patch = buildAgentPatch('feiyu', 'D:/data/workspace-feiyu')
  assertEq(patch.agents.entries.feiyu.workspace, 'D:/data/workspace-feiyu', '补丁含 workspace')
  let bad = false
  try {
    buildAgentPatch('Feiyu!', 'x')
  } catch {
    bad = true
  }
  assertEq(bad, true, '非法 agent id 被拒')

  const configPath = join(tmpDir, `character-config-${Date.now()}.json`)
  writeFileSync(configPath, JSON.stringify({ agents: { entries: { main: {} } } }), 'utf8')
  assertEq(readAgentEntry(configPath, 'feiyu').exists, false, '不存在时 exists=false')
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: { entries: { main: {}, feiyu: { workspace: 'D:/data/workspace-feiyu' } } }
    }),
    'utf8'
  )
  const found = readAgentEntry(configPath, 'feiyu')
  assertEq(found.exists, true, '存在时 exists=true')
  assertEq(found.workspace, 'D:/data/workspace-feiyu', '读回 workspace')

  writeFileSync(configPath, '{bad json', 'utf8')
  const broken = readAgentEntry(configPath, 'feiyu')
  assertEq(broken.exists, false, '坏配置返回不存在')
  assertEq(typeof broken.error, 'string', '坏配置带 error')
  return '补丁载荷/读回/坏配置 正确'
})

await recorder.check('C12', '一键引导：5 步全过、幂等、用户改动保留、Obsidian 目录就位', async () => {
  const runDir = join(tmpDir, `character-bootstrap-${Date.now()}`)
  const workspaceDir = join(runDir, 'workspace-feiyu')
  const vault = join(runDir, 'vault')
  mkdirSync(vault, { recursive: true })
  const inputs = baseInputs()
  let ensured = 0

  const deps = {
    workspaceDir,
    personaSourceDir: personaSrcDir,
    getSettings: async () => inputs.settings,
    getState: async () => inputs.state,
    obsidianVaultPath: vault,
    ensureAgentEntry: async () => {
      ensured += 1
      return { ok: true }
    },
    agentConfigured: () => true,
    gatewayReady: () => true,
    qqReady: () => false,
    ttsReady: () => true,
    memorySearchReady: () => true
  }

  const report = await runBootstrap(deps)
  assertEq(report.ok, true, '首次引导全过')
  assertEq(report.steps.length, 5, '五步：workspace/persona/agent/obsidian/deps')
  assertEq(report.steps.every((s) => s.ok), true, '每步 ok')
  assertEq(existsSync(join(workspaceDir, 'SOUL.md')), true, 'SOUL 已落盘')
  assertEq(existsSync(join(vault, '大肥鱼')), true, 'Obsidian 大肥鱼目录已建')
  assertEq(report.status.agentReady, true, '自检 agentReady')
  assertEq(report.status.obsidianReady, true, '自检 obsidianReady')
  assertEq(ensured, 1, 'agent 补丁执行一次')

  const soulPath = join(workspaceDir, 'SOUL.md')
  writeFileSync(soulPath, `${readFileSync(soulPath, 'utf8')}\n用户改的行\n`, 'utf8')
  const again = await runBootstrap(deps)
  assertEq(again.ok, true, '二次引导仍全过（幂等）')
  assertEq(readFileSync(soulPath, 'utf8').includes('用户改的行'), true, '二次引导不覆盖用户改动')
  return '引导/幂等/改动保护 正确'
})

const ok = printResult(recorder.toJSON())
if (!ok) process.exit(1)
