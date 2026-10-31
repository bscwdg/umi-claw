// test/character.core.accept.mjs —— C01 角色骨架：store / manager / 设置白名单 / 生命周期
//
// 纯 Node 验收，不连 Electron、不连网关：
//   - 打真源码 store.ts / manager.ts / types.ts（bundleEntry 即时编译）
//   - 内存 KV 模拟宿主 app_meta（fish:v2:*）
//   - 覆盖：默认值、坏值回落、事件、启停、互动上限、重置、按日索引与 GC
//
// 用法：node test/character.core.accept.mjs（npm run accept:character）

import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Recorder, assert, assertEq, bundleEntry, printResult, repoRoot, tmpDir } from './_lib.mjs'

const typesMod = await import(pathToFileURL(bundleEntry('electron/main/character/types.ts', 'character-types.mjs')).href)
const storeMod = await import(pathToFileURL(bundleEntry('electron/main/character/store.ts', 'character-store.mjs')).href)
const managerMod = await import(pathToFileURL(bundleEntry('electron/main/character/manager.ts', 'character-manager.mjs')).href)
const personaMod = await import(pathToFileURL(bundleEntry('electron/main/character/persona.ts', 'character-persona.mjs')).href)
const agentConfigMod = await import(pathToFileURL(bundleEntry('electron/main/character/agentConfig.ts', 'character-agent-config.mjs')).href)
const bootstrapMod = await import(pathToFileURL(bundleEntry('electron/main/character/bootstrap.ts', 'character-bootstrap.mjs')).href)
const chatMod = await import(pathToFileURL(bundleEntry('electron/main/character/chat.ts', 'character-chat.mjs')).href)
const relationshipMod = await import(pathToFileURL(bundleEntry('electron/main/character/relationship.ts', 'character-relationship.mjs')).href)
const cardsMod = await import(pathToFileURL(bundleEntry('electron/main/character/contentCards.ts', 'character-cards.mjs')).href)
const lifeMod = await import(pathToFileURL(bundleEntry('electron/main/character/life.ts', 'character-life.mjs')).href)
const proactiveMod = await import(pathToFileURL(bundleEntry('electron/main/character/proactive.ts', 'character-proactive.mjs')).href)
const memoryMod = await import(pathToFileURL(bundleEntry('electron/main/character/memoryJob.ts', 'character-memory.mjs')).href)
const voicePolicyMod = await import(pathToFileURL(bundleEntry('electron/main/character/voicePolicy.ts', 'character-voice-policy.mjs')).href)
const qqVoiceMod = await import(pathToFileURL(bundleEntry('electron/main/character/qqVoice.ts', 'character-qq-voice.mjs')).href)
const sttMod = await import(pathToFileURL(bundleEntry('electron/main/character/stt.ts', 'character-stt.mjs')).href)
const safetyMod = await import(pathToFileURL(bundleEntry('electron/main/character/safety.ts', 'character-safety.mjs')).href)

const {
  CHARACTER_ERROR_CODES,
  DEFAULT_CHARACTER_SETTINGS,
  FISH_KEYS,
  clampPetPosition,
  createDefaultCharacterState,
  mergeCharacterSettings,
  toCharacterEnvelope,
  toCharacterErrorEnvelope
} = typesMod
const { CharacterStore, formatDate } = storeMod
const { CharacterManager } = managerMod
const { applyTemplate, buildPersonaVars, composePersonaFiles, writeManagedFiles, safeJoin } = personaMod
const { buildAgentPatch, readAgentEntry } = agentConfigMod
const { runBootstrap } = bootstrapMod
const {
  CharacterChatService,
  EmotionStreamFilter,
  mapEmotionToState,
  stripEmotionMarkers
} = chatMod
const {
  RELATIONSHIP_RULES,
  applyRelationshipEvent,
  stageForFamiliarity,
  pruneDedup,
  toDateKey
} = relationshipMod
const { parseLifeDeck, drawLifeCards, slotForHour, seededRandom } = cardsMod
const { composeLifeDay, renderLifeDoc } = lifeMod
const { decideProactive, isQuietHours } = proactiveMod
const {
  buildMemoryPrompt,
  diaryObsidianRelPath,
  extractDiaryText,
  isMemoryWindow,
  memoryDateFor,
  normalizeDiary,
  shouldRunMemory,
  validateDiary
} = memoryMod
const { decideVoice, isVoiceRequest } = voicePolicyMod
const { deliverVoice, extractWavPcm, nextMsgSeq, QQ_VOICE_MSG_TYPE } = qqVoiceMod
const { transcribeInbound, STT_FALLBACK_MESSAGE } = sttMod
const {
  buildExportPayload,
  CRISIS_REDIRECT,
  filterAssistantOutput,
  hasProfessionalAdvice,
  isAgeConfirmed,
  isCrisisText,
  normalizeDeleteScope,
  scrubForLog
} = safetyMod

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
  assertEq(capped.familiarity, 10, '摸头按日上限封顶 10（C05 规则）')
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

await recorder.check('C6', '按日键索引 + 保留策略 GC（90 天窗口外拒绝写入）', async () => {
  const base = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const now = base
  const kv = memoryKv()
  const store = new CharacterStore({ kv, now: () => now, dayRetentionDays: 90 })
  for (let i = 0; i < 90; i += 1) {
    const date = formatDate(base - i * 86_400_000)
    await store.writeDay(date, { i })
  }
  const meta = await store.readMeta()
  assertEq(meta.days.length, 90, '日期索引覆盖 90 天')
  const newest = formatDate(base)
  assertEq(kv.map.has(FISH_KEYS.day(newest)), true, '当天 day 键仍在')

  // 窗口外（91 天前）拒绝写入：不静默丢数据
  let rejected = null
  try {
    await store.writeDay(formatDate(base - 91 * 86_400_000), { old: true })
  } catch (e) {
    rejected = e
  }
  assertEq(/保留窗口/.test(rejected?.message ?? ''), true, '超期日期拒绝写入')

  const result = await store.prune()
  assertEq(Array.isArray(result.removedDays), true, 'prune 返回清理结果')
  assertEq(Array.isArray(result.removedLife), true, 'prune 返回 life 清理结果')
  return '索引/保留/越界拒绝 正确'
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
    voice: read('voice-rules.md')
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

await recorder.check('C13', '桌宠状态：尺寸/穿透跟随设置，位置跨实例持久化', async () => {
  const kv = memoryKv()
  const store = new CharacterStore({ kv })
  const manager = new CharacterManager({ store })
  await manager.init()

  const initial = await manager.getPetState()
  assertEq(initial.width, 280, '默认 medium 宽 280')
  assertEq(initial.height, 330, '默认 medium 高 330')
  assertEq(initial.visible, false, '未启用时不可见（D8 默认关）')
  assertEq(initial.clickThrough, false, '默认不穿透')

  await manager.updateSettings({ enabled: true, pet: { size: 'large', clickThrough: true, visible: true } })
  const resized = await manager.getPetState()
  assertEq(resized.width, 340, 'large 宽 340')
  assertEq(resized.height, 400, 'large 高 400')
  assertEq(resized.clickThrough, true, '穿透跟随设置')
  assertEq(resized.visible, true, '可见跟随设置')

  const saved = await manager.savePetState({ x: 123, y: 456 })
  assertEq(saved.x, 123, '位置写入 x')
  assertEq(saved.y, 456, '位置写入 y')

  // 新实例读同一 KV：位置记忆仍在
  const manager2 = new CharacterManager({ store: new CharacterStore({ kv }) })
  await manager2.init()
  const restored = await manager2.getPetState()
  assertEq(restored.x, 123, '重启后位置 x 仍在')
  assertEq(restored.y, 456, '重启后位置 y 仍在')
  return '尺寸/穿透/可见/位置持久化 正确'
})

await recorder.check('C14', '桌宠位置夹取：负坐标/越界/多屏偏移都不跑出工作区', async () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 }
  const p1 = clampPetPosition(100, 120, 280, 330, work)
  assertEq(p1.x, 100, '工作区内位置不变 x')
  assertEq(p1.y, 120, '工作区内位置不变 y')

  const p2 = clampPetPosition(-50, -80, 280, 330, work)
  assertEq(p2.x, 0, '负坐标夹到左边界')
  assertEq(p2.y, 0, '负坐标夹到上边界')

  const p3 = clampPetPosition(5000, 5000, 280, 330, work)
  assertEq(p3.x, 1920 - 280, '右下越界夹回')
  assertEq(p3.y, 1040 - 330, '下方越界夹回')

  const secondary = { x: 1920, y: 0, width: 1280, height: 1024 }
  const p4 = clampPetPosition(2000, 100, 280, 330, secondary)
  assertEq(p4.x, 2000, '副屏内位置不变')
  const p5 = clampPetPosition(100, 100, 280, 330, secondary)
  assertEq(p5.x, 1920, '跨屏位置夹到副屏左边界')
  return '边界/负值/多屏夹取 正确'
})

await recorder.check('C15', '桌宠位置脏值防御：NaN/字符串被忽略，保留旧值', async () => {
  const kv = memoryKv()
  const manager = new CharacterManager({ store: new CharacterStore({ kv }) })
  await manager.init()
  await manager.savePetState({ x: 10, y: 20 })
  const dirty = await manager.savePetState({
    x: Number.NaN,
    y: 'abc',
    visible: true
  })
  assertEq(dirty.x, 10, 'NaN 不覆盖旧 x')
  assertEq(dirty.y, 20, '字符串不覆盖旧 y')
  assertEq(dirty.visible, true, '合法 visible 仍生效')
  return '脏值防御正确'
})

await recorder.check('C16', '情绪标记：完整/全角/跨 chunk 拆分都被剥离，情绪映射到六态', async () => {
  const a = stripEmotionMarkers('你好[emotion:开心]呀')
  assertEq(a.text, '你好呀', '完整标记被剥离')
  assertEq(a.emotion, '开心', '捕捉到情绪')
  const b = stripEmotionMarkers('早[emotion：疲惫]')
  assertEq(b.text, '早', '全角冒号也识别')
  assertEq(b.emotion, '疲惫', '全角标记情绪')

  const f = new EmotionStreamFilter()
  const first = f.push('你好[emo')
  assertEq(first.text, '你好', '半截标记挂起')
  const second = f.push('tion:难过]呀')
  assertEq(second.text, '呀', '跨块标记不泄漏')
  assertEq(second.emotion, '难过', '跨块情绪被捕获')
  assertEq(f.flush().text, '', '无残留')

  const f2 = new EmotionStreamFilter()
  assertEq(f2.push('普通').text, '普通', '普通文本原样')
  assertEq(f2.push('[emotion:开心]').text, '', '只有标记时无文本')
  assertEq(f2.currentEmotion(), '开心', 'currentEmotion 可读')

  assertEq(mapEmotionToState('开心'), 'happy', '开心→happy')
  assertEq(mapEmotionToState('疲惫'), 'sleepy', '疲惫→sleepy')
  assertEq(mapEmotionToState('生气'), 'sulk', '生气→sulk')
  assertEq(mapEmotionToState('惊'), 'caught', '惊→caught')
  assertEq(mapEmotionToState('开心', '今天吃白饭'), 'eat', '吃白饭语境→eat')
  assertEq(mapEmotionToState('未知情绪'), 'idle', '未知→idle')
  return '标记剥离/跨块/映射 正确'
})

await recorder.check('C17', '会话键与代际：main/night + 清空轮换 + 输入校验', async () => {
  let gen = 2
  const svc = new CharacterChatService({
    chat: async () => fakeHandle([]),
    store: {
      readChatGeneration: async () => gen,
      writeChatGeneration: async (g) => {
        gen = g
      }
    }
  })
  await svc.init()
  assertEq(svc.conversationKey('main'), 'conv:fish:main:2', '主会话键带代际')
  assertEq(svc.conversationKey('night'), 'conv:fish:night:2', '夜间会话键')
  assertEq(svc.conversationKey('nope'), 'conv:fish:main:2', '未知 session 回落 main')

  const cleared = await svc.clear()
  assertEq(cleared.gen, 3, '清空后代际 +1')
  assertEq(gen, 3, '代际已落库')
  assertEq(svc.conversationKey('main'), 'conv:fish:main:3', '新会话键')

  let empty = null
  try {
    await svc.send({ text: '   ' }, () => undefined)
  } catch (e) {
    empty = e
  }
  assertEq(/不能为空/.test(empty?.message ?? ''), true, '空消息被拒')
  let tooLong = null
  try {
    await svc.send({ text: 'x'.repeat(4001) }, () => undefined)
  } catch (e) {
    tooLong = e
  }
  assertEq(/过长/.test(tooLong?.message ?? ''), true, '超长消息被拒')
  return '会话键/代际/校验 正确'
})

await recorder.check('C18', '流式聊天：chunk 拼接、done 带情绪、结束后不可取消', async () => {
  const events = []
  let request = null
  const svc = new CharacterChatService({
    chat: async (input) => {
      request = input
      return fakeHandle(['你', '好呀[emotion:开心]'])
    },
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    },
    onEmotion: (emotion, state) => events.push({ type: 'emotion', emotion, state })
  })
  await svc.init()
  const sent = await svc.send({ text: '在吗' }, (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 20))

  assertEq(request.conversationKey, 'conv:fish:main:1', '请求带正确会话键')
  assertEq(request.model, 'openclaw/feiyu', '请求显式路由到 feiyu agent')
  assertEq(request.messages[0].content, '在吗', '请求带用户消息')
  assertEq(request.stream, true, '走流式')
  const chunks = events.filter((e) => e.kind === 'chunk').map((e) => e.text).join('')
  assertEq(chunks, '你好呀', 'chunk 拼接无标记')
  const done = events.find((e) => e.kind === 'done')
  assertEq(Boolean(done), true, '收到 done')
  assertEq(done.text, '你好呀', 'done 带全文')
  assertEq(done.emotion, '开心', 'done 带情绪')
  assertEq(done.aborted, false, '正常完成 aborted=false')
  assertEq(events.some((e) => e.type === 'emotion' && e.emotion === '开心'), true, '情绪回调')
  assertEq(svc.cancel(sent.runId), false, '结束后取消返回 false')
  return '流式/情绪/结束状态 正确'
})

await recorder.check('C19', '取消与失败：cancel 透传、错误事件不吞', async () => {
  let cancelled = false
  const svc = new CharacterChatService({
    chat: async () => ({
      iterator: (async function* () {
        // 永不结束，等待取消
        await new Promise(() => undefined)
      })(),
      result: new Promise(() => undefined),
      cancel: () => {
        cancelled = true
      }
    }),
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    }
  })
  await svc.init()
  const sent = await svc.send({ text: 'hi' }, () => undefined)
  assertEq(svc.cancel(sent.runId), true, '进行中取消返回 true')
  assertEq(cancelled, true, 'cancel 透传到 gateway handle')

  const errors = []
  const svc2 = new CharacterChatService({
    chat: async () => ({
      iterator: (async function* () {
        yield { index: 1, delta: '半句' }
        throw new Error('upstream boom')
      })(),
      result: Promise.resolve({ aborted: false, text: '' }),
      cancel: () => undefined
    }),
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    }
  })
  await svc2.init()
  await svc2.send({ text: 'hi' }, (e) => errors.push(e))
  await new Promise((r) => setTimeout(r, 20))
  const err = errors.find((e) => e.kind === 'error')
  assertEq(Boolean(err), true, '错误事件已发')
  assertEq(/boom/.test(err.error), true, '错误信息保留')
  return '取消/错误 正确'
})

function fakeHandle(deltas) {
  return {
    iterator: (async function* () {
      for (let i = 0; i < deltas.length; i += 1) {
        yield { index: i + 1, delta: deltas[i] }
      }
    })(),
    result: Promise.resolve({ aborted: false, text: deltas.join('') }),
    cancel: () => undefined
  }
}

await recorder.check('C20', 'manifest 丢失/损坏 → 保守模式，用户改过的文件绝不被覆盖', async () => {
  const dir = join(tmpDir, `character-manifest-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const files = composePersonaFiles(baseInputs())
  writeManagedFiles(dir, files)
  const soulPath = join(dir, 'SOUL.md')
  writeFileSync(soulPath, `${readFileSync(soulPath, 'utf8')}\n我的设定\n`, 'utf8')

  // 1) 删掉 manifest
  const manifestPath = join(dir, '.fish-managed.json')
  writeFileSync(manifestPath, '', 'utf8')
  const afterEmpty = writeManagedFiles(dir, files)
  assertEq(afterEmpty.kept.includes('SOUL.md'), true, '空 manifest 时保留用户 SOUL')
  assertEq(readFileSync(soulPath, 'utf8').includes('我的设定'), true, '空 manifest 不覆盖内容')

  // 2) 损坏 manifest
  writeFileSync(manifestPath, '{bad json', 'utf8')
  writeManagedFiles(dir, files)
  assertEq(readFileSync(soulPath, 'utf8').includes('我的设定'), true, '坏 manifest 不覆盖内容')

  // 3) 类型脏 manifest（files 为数组）
  writeFileSync(manifestPath, JSON.stringify({ version: 1, files: [] }), 'utf8')
  writeManagedFiles(dir, files)
  assertEq(readFileSync(soulPath, 'utf8').includes('我的设定'), true, 'files 类型脏不覆盖内容')
  return '保守模式有效'
})

await recorder.check('C21', '并发互动不丢更新（50 次并发摸头命中每日上限 10，一次不多一次不少）', async () => {
  const kv = memoryKv()
  const manager = new CharacterManager({ store: new CharacterStore({ kv }) })
  await manager.init()
  await manager.updateSettings({ enabled: true })
  await Promise.all(Array.from({ length: 50 }, () => manager.interact({ kind: 'pat' })))
  const state = await manager.getState()
  assertEq(state.familiarity, 10, '并发 50 次 → 精确命中每日上限 10')
  return '并发串行化正确'
})

await recorder.check('C22', '用户输入消毒：换行/花括号/超长禁忌都不注入提示词', async () => {
  const inputs = baseInputs({
    relationship: {
      address: '阿爸\n#INJECTED\n- 伪造规则',
      userName: '{{herName}}',
      taboo: ['主\n人', 'x'.repeat(5000)]
    }
  })
  const files = composePersonaFiles(inputs)
  const all = Object.values(files).join('\n')
  assertEq(/\nINJECTED/.test(all), false, '换行注入不能形成独立行')
  assertEq(all.includes('{{'), false, '花括号占位符不残留')
  assertEq(files['AGENTS.md'].length < 4000, true, '超长禁忌被截断')
  assertEq(files['USER.md'].length < 2000, true, 'USER 不因超长禁忌膨胀')

  const merged = mergeCharacterSettings(DEFAULT_CHARACTER_SETTINGS, {
    relationship: { address: 'a\nb', userName: 'c\nd' }
  })
  assertEq(merged.relationship.address.includes('\n'), false, '设置层已剥换行')
  return '消毒生效'
})

await recorder.check('C24', '坏 settings（合法 JSON 非法形态）返回默认副本，不污染模块默认值', async () => {
  const kv = memoryKv(new Map([[FISH_KEYS.settings, '[]']]))
  const store = new CharacterStore({ kv })
  const settings = await store.readSettings()
  settings.proactive.enabled = true
  settings.pet.visible = false
  const fresh = await new CharacterStore({ kv }).readSettings()
  assertEq(fresh.proactive.enabled, false, '模块默认值未被污染（proactive）')
  assertEq(fresh.pet.visible, true, '模块默认值未被污染（pet）')
  return '默认值隔离正确'
})

await recorder.check('C25', '聊天：多情绪标记取最后、无 delta 用 result.text、事件带 gen', async () => {
  const events = []
  const svc = new CharacterChatService({
    chat: async () => fakeHandle(['[emotion:开心]a', '[emotion:难过]b']),
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    }
  })
  await svc.init()
  await svc.send({ text: 'hi' }, (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 20))
  const done = events.find((e) => e.kind === 'done')
  assertEq(done.text, 'ab', '标记被剥离')
  assertEq(done.emotion, '难过', '多标记取最后一个')
  assertEq(done.gen, 1, '事件带会话代际')

  const events2 = []
  const svc2 = new CharacterChatService({
    chat: async () => ({
      iterator: (async function* () {})(),
      result: Promise.resolve({ aborted: false, text: '只给全文' }),
      cancel: () => undefined
    }),
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    }
  })
  await svc2.init()
  await svc2.send({ text: 'hi' }, (e) => events2.push(e))
  await new Promise((r) => setTimeout(r, 20))
  const done2 = events2.find((e) => e.kind === 'done')
  assertEq(done2.text, '只给全文', '无 delta 时用 result.text 兜底')
  return '情绪/兜底/gen 正确'
})

await recorder.check('C26', "reset('all') 轮换聊天代际，旧上下文不复活", async () => {
  const kv = memoryKv()
  const store = new CharacterStore({ kv })
  const manager = new CharacterManager({ store })
  await manager.init()
  await store.writeChatGeneration(5)
  assertEq(await store.readChatGeneration(), 5, '代际写入 5')
  await manager.reset({ scope: 'all' })
  assertEq(await store.readChatGeneration(), 1, '清空全部后代际回到 1')
  return '代际重置正确'
})

await recorder.check('C27', 'writeLife 与 writeDay 同口径：非法/越界日期拒绝，不静默删除', async () => {
  const base = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const store = new CharacterStore({ kv: memoryKv(), now: () => base, lifeRetentionDays: 30 })
  let bad = null
  try {
    await store.writeLife('2026-13-45', { a: 1 })
  } catch (e) {
    bad = e
  }
  assertEq(/非法日期/.test(bad?.message ?? ''), true, '非法日期拒绝')
  let expired = null
  try {
    await store.writeLife(formatDate(base - 31 * 86_400_000), { a: 1 })
  } catch (e) {
    expired = e
  }
  assertEq(/保留窗口/.test(expired?.message ?? ''), true, '超期 life 拒绝写入')
  return 'life 校验正确'
})

await recorder.check('C28', '取消后不再展示增量，done.aborted=true', async () => {
  let handleRef = null
  const events = []
  const svc = new CharacterChatService({
    chat: async () => {
      handleRef = {
        iterator: (async function* () {
          yield { index: 1, delta: '甲' }
          await new Promise((r) => setTimeout(r, 15))
          yield { index: 2, delta: '乙' }
        })(),
        result: Promise.resolve({ aborted: false, text: '甲乙' }),
        cancel: () => undefined
      }
      return handleRef
    },
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    }
  })
  await svc.init()
  const sent = await svc.send({ text: 'hi' }, (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 2))
  svc.cancel(sent.runId)
  await new Promise((r) => setTimeout(r, 40))
  const chunks = events.filter((e) => e.kind === 'chunk').map((e) => e.text).join('')
  assertEq(chunks.includes('乙'), false, '取消后的迟到增量被抑制')
  const done = events.find((e) => e.kind === 'done')
  assertEq(done.aborted, true, '取消后 done.aborted=true')
  return '取消抑制正确'
})

await recorder.check('C29', 'manager 桌宠位置夹取（内部 API 也不能落库屏外坐标）', async () => {
  const kv = memoryKv()
  const manager = new CharacterManager({
    store: new CharacterStore({ kv }),
    clampPosition: (x, y, w, h) => clampPetPosition(x, y, w, h, { x: 0, y: 0, width: 1920, height: 1040 })
  })
  await manager.init()
  const far = await manager.savePetState({ x: -999999, y: 999999 })
  assertEq(far.x >= 0 && far.x <= 1920 - 280, true, 'x 被夹到工作区')
  assertEq(far.y >= 0 && far.y <= 1040 - 330, true, 'y 被夹到工作区')
  return 'manager 层夹取正确'
})

await recorder.check('C30', '人格注入只含规则：禁用清单与 few-shot 不进 SOUL', async () => {
  const files = composePersonaFiles(baseInputs())
  const soul = files['SOUL.md']
  assertEq(soul.includes('有什么可以帮您'), false, 'SOUL 不含禁用句')
  assertEq(soul.includes('本鱼昨晚三点才睡'), false, 'SOUL 不含 few-shot 例句')
  assertEq(soul.includes('风格规则'), true, 'SOUL 含规则正文')
  return '注入边界正确'
})

function relState(overrides = {}) {
  return {
    bornAt: 1,
    stage: 0,
    familiarity: 0,
    intimacy: 0,
    streakDays: 0,
    lastInteractionAt: 0,
    addressForm: '你',
    mood: '平静',
    updatedAt: 1,
    ...overrides
  }
}

await recorder.check('C31', '关系事件：增量、每日上限、超限不写', async () => {
  const now = new Date(2026, 10, 1, 10, 0, 0).getTime()
  const ctx = { now, today: toDateKey(now), dedup: {} }
  let state = relState()
  let applied = 0
  let capped = 0
  for (let i = 0; i < 12; i += 1) {
    const r = applyRelationshipEvent(state, { type: 'interact.pat' }, ctx)
    state = r.state
    ctx.dedup = r.dedup
    if (r.applied) applied += 1
    if (r.reason === 'daily-cap') capped += 1
  }
  assertEq(applied, RELATIONSHIP_RULES['interact.pat'].dailyCap, '摸头按日上限生效')
  assertEq(capped, 2, '超限次数被拒绝')
  assertEq(state.familiarity, RELATIONSHIP_RULES['interact.pat'].dailyCap, '熟悉度=上限×1')
  return '每日上限正确'
})

await recorder.check('C32', '阶段只升不降 + 解锁列表', async () => {
  const now = new Date(2026, 10, 1, 10, 0, 0).getTime()
  const ctx = { now, today: toDateKey(now), dedup: {} }
  const r1 = applyRelationshipEvent(relState({ familiarity: 59, stage: 2 }), { type: 'chat.message' }, ctx)
  assertEq(r1.state.familiarity, 60, '熟悉度到 60')
  assertEq(r1.state.stage, 3, '升到阶段 3')
  assertEq(r1.stageChanged, true, 'stageChanged=true')
  assertEq(r1.unlocked.includes('一个秘密'), true, '解锁项返回')

  const r2 = applyRelationshipEvent(relState({ familiarity: 5, stage: 3 }), { type: 'chat.message' }, ctx)
  assertEq(r2.state.stage, 3, '阶段不因熟悉度低而下降')

  assertEq(stageForFamiliarity(0), 0, '阈值 0')
  assertEq(stageForFamiliarity(30), 2, '阈值 30')
  assertEq(stageForFamiliarity(100), 4, '阈值 100')
  return '阶段规则正确'
})

await recorder.check('C33', 'refId 幂等 + 7 天窗口过期', async () => {
  const now = new Date(2026, 10, 1, 10, 0, 0).getTime()
  const ctx = { now, today: toDateKey(now), dedup: {} }
  const first = applyRelationshipEvent(relState(), { type: 'milestone', refId: 'm-1' }, ctx)
  assertEq(first.applied, true, '首次应用')
  const again = applyRelationshipEvent(first.state, { type: 'milestone', refId: 'm-1' }, {
    ...ctx,
    dedup: first.dedup
  })
  assertEq(again.applied, false, '同 refId 不重复计')
  assertEq(again.reason, 'duplicate', '标记 duplicate')

  const later = now + 8 * 86_400_000
  const expired = applyRelationshipEvent(first.state, { type: 'milestone', refId: 'm-1' }, {
    now: later,
    today: toDateKey(later),
    dedup: first.dedup
  })
  assertEq(expired.applied, true, '过期后可再次计')
  const pruned = pruneDedup({ a: now, b: later - 1000 }, later)
  assertEq('a' in pruned, false, '过期 refId 被剪枝')
  return '幂等/过期正确'
})

await recorder.check('C34', '跨天：日计数重置 + 连续天数累计', async () => {
  const day1 = new Date(2026, 10, 1, 10, 0, 0).getTime()
  const day2 = day1 + 86_400_000
  const ctx1 = { now: day1, today: toDateKey(day1), dedup: {} }
  const r1 = applyRelationshipEvent(relState(), { type: 'interact.pat' }, ctx1)
  assertEq(r1.state.dayCounters?.['interact.pat'], 1, '首日计数 1')
  assertEq(r1.state.streakDays >= 1, true, '首日连击至少 1')

  const ctx2 = { now: day2, today: toDateKey(day2), dedup: r1.dedup }
  const r2 = applyRelationshipEvent(r1.state, { type: 'interact.pat' }, ctx2)
  assertEq(r2.state.dayCounters?.['interact.pat'], 1, '次日计数重置')
  assertEq(r2.state.streakDays, 2, '连续天数 +1')

  const day5 = day1 + 4 * 86_400_000
  const r3 = applyRelationshipEvent(r2.state, { type: 'interact.pat' }, {
    now: day5,
    today: toDateKey(day5),
    dedup: r2.dedup
  })
  assertEq(r3.state.streakDays, 1, '断档后连击重置')
  return '跨天/连击正确'
})

await recorder.check('C35', 'manager 集成：聊天记账幂等 + 互动走上限', async () => {
  const kv = memoryKv()
  let now = new Date(2026, 10, 1, 10, 0, 0).getTime()
  const manager = new CharacterManager({ store: new CharacterStore({ kv, now: () => now }), now: () => now })
  await manager.init()
  await manager.updateSettings({ enabled: true })

  const r1 = await manager.applyRelationshipEvent({ type: 'chat.message', refId: 'run-1' })
  assertEq(r1.applied, true, '首次聊天记账')
  assertEq(r1.delta.familiarity, 1, '聊天 +1 熟悉')
  const r2 = await manager.applyRelationshipEvent({ type: 'chat.message', refId: 'run-1' })
  assertEq(r2.applied, false, '同 runId 不重复计')

  for (let i = 0; i < 12; i += 1) await manager.interact({ kind: 'pat' })
  const state = await manager.getState()
  assertEq(state.familiarity, 1 + RELATIONSHIP_RULES['interact.pat'].dailyCap, '互动按上限累计')
  assertEq(state.mood, '被摸头了', '互动更新心情')

  // 未启用时拒绝
  await manager.updateSettings({ enabled: false })
  let disabled = null
  try {
    await manager.applyRelationshipEvent({ type: 'chat.message' })
  } catch (e) {
    disabled = e
  }
  assertEq(disabled?.code, CHARACTER_ERROR_CODES.DISABLED, '未启用拒绝记账')
  return '集成正确'
})

await recorder.check('C36', '关系事件信封与未知事件容错', async () => {
  const now = Date.now()
  const r = applyRelationshipEvent(relState(), { type: 'no.such.event' }, {
    now,
    today: toDateKey(now),
    dedup: {}
  })
  assertEq(r.applied, false, '未知事件不应用')
  assertEq(r.reason, 'unknown-event', '未知事件有原因')
  return '容错正确'
})

const lifeDeckRaw = JSON.parse(
  readFileSync(join(repoRoot, 'resources', 'character', 'cards', 'life-cards.v1.json'), 'utf8')
)
const lifeDeck = parseLifeDeck(lifeDeckRaw)

await recorder.check('C37', '内容卡：确定性抽取、阶段过滤、7 天不重复', async () => {
  const a = drawLifeCards(lifeDeck, { stage: 3, date: '2026-11-01', count: 3 })
  const b = drawLifeCards(lifeDeck, { stage: 3, date: '2026-11-01', count: 3 })
  assertEq(a.map((c) => c.id).join(','), b.map((c) => c.id).join(','), '同一天确定性抽取')
  assertEq(a.length, 3, '抽 3 张')

  const recent = lifeDeck.cards.slice(0, 10).map((c) => c.id)
  const c = drawLifeCards(lifeDeck, { stage: 3, date: '2026-11-02', recentIds: recent, count: 3 })
  assertEq(c.every((card) => !recent.includes(card.id)), true, '排除最近 7 天用过的卡')

  const low = drawLifeCards(lifeDeck, { stage: 0, date: '2026-11-03', count: 10 })
  // stage 0 没有专属卡：逐级放宽兜底，保证「她的一天」永远有内容
  assertEq(low.length > 0, true, '阶段不足时兜底抽卡，不会空白')
  assertEq(low.every((card) => card.minStage >= 1), true, '兜底卡来自更高阶段')
  assertEq(slotForHour(8), 'morning', '8 点 → 上午')
  assertEq(slotForHour(23), 'night', '23 点 → 深夜')
  return '抽卡规则正确'
})

await recorder.check('C38', '她的一天：LIFE 文档渲染（时段/小目标）', async () => {
  const composed = composeLifeDay({
    deck: lifeDeck,
    stage: 3,
    date: '2026-11-01',
    now: new Date(2026, 10, 1, 9, 0, 0).getTime()
  })
  assertEq(composed.doc.includes('她的一天（2026-11-01）'), true, '含日期标题')
  assertEq(composed.doc.includes('- 小目标：'), true, '含小目标行')
  assertEq(composed.day.cardIds.length, 3, '记录 3 张卡')
  const again = renderLifeDoc(composed.day, composed.cards)
  assertEq(again, composed.doc, '渲染幂等')
  return 'LIFE 渲染正确'
})

await recorder.check('C39', '免打扰时段：跨午夜 / 非跨 / 非法格式', async () => {
  const at = (h, m) => new Date(2026, 10, 1, h, m, 0).getTime()
  assertEq(isQuietHours(at(23, 40), '23:30', '08:00'), true, '23:40 在跨午夜免打扰内')
  assertEq(isQuietHours(at(7, 59), '23:30', '08:00'), true, '07:59 在跨午夜免打扰内')
  assertEq(isQuietHours(at(8, 1), '23:30', '08:00'), false, '08:01 已出免打扰')
  assertEq(isQuietHours(at(13, 0), '12:00', '14:00'), true, '非跨段命中')
  assertEq(isQuietHours(at(13, 0), 'bad', '14:00'), false, '非法格式不拦')
  return '免打扰判定正确'
})

await recorder.check('C40', '主动性决策矩阵：开关/静默期/免打扰/日上限/安静几天', async () => {
  const now = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const settings = (patch = {}) => ({
    ...JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS)),
    enabled: true,
    safety: { ...JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS.safety)), ageConfirmed: true },
    proactive: {
      ...JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS.proactive)),
      enabled: true,
      silenceDays: 0,
      ...(patch.proactive ?? {})
    },
    ...(patch.safety ? { safety: { ...JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS.safety)), ...patch.safety } } : {})
  })
  const state = { ...createDefaultCharacterState(now), bornAt: now - 10 * 86_400_000 }
  const ctx = (patch = {}, day = {}) => ({
    settings: settings(patch),
    state,
    day,
    now,
    today: '2026-11-01'
  })

  assertEq(decideProactive(ctx()).send, true, '默认可发')
  assertEq(decideProactive(ctx({ proactive: { enabled: false } })).reason, 'disabled', '开关关→disabled')
  assertEq(decideProactive(ctx({ proactive: { channel: 'app' } })).channel, 'app', '通道 app')
  assertEq(decideProactive(ctx({ proactive: { silentUntil: now + 1000 } })).reason, 'silent-until', '安静几天')
  assertEq(decideProactive(ctx({ proactive: { dailyCap: 2 } }, { activeSent: 2 })).reason, 'daily-cap', '日上限')
  assertEq(decideProactive(ctx({ proactive: { quietFrom: '11:00', quietTo: '13:00' } })).reason, 'quiet-hours', '免打扰')

  const newborn = { ...state, bornAt: now - 1000 }
  const newbornDecision = decideProactive({ ...ctx({ proactive: { silenceDays: 3 } }), state: newborn })
  assertEq(newbornDecision.reason, 'silence-period', '新收养静默期')
  const unconfirmed = decideProactive(ctx({ safety: { ageConfirmed: false } }))
  assertEq(unconfirmed.reason, 'age-unconfirmed', '未确认年龄不主动')
  return '决策矩阵正确'
})

await recorder.check('C41', 'manager：每日生活幂等 + 7 天不重复 + LIFE 落盘回调', async () => {
  const kv = memoryKv()
  let now = new Date(2026, 10, 1, 9, 0, 0).getTime()
  const docs = []
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    loadLifeDeck: async () => lifeDeck,
    writeLifeDoc: async (text) => docs.push(text)
  })
  await manager.init()
  await manager.updateSettings({ enabled: true })

  const first = await manager.ensureDailyLife()
  assertEq(first.generated, true, '首次生成')
  assertEq(docs.length, 1, 'LIFE.md 写一次')
  const again = await manager.ensureDailyLife()
  assertEq(again.generated, false, '同日不重复生成')
  // 每次 ensure 都会补写一次（文件可能被用户删掉），但内容必须一致
  assertEq(docs.length >= 1, true, '补写不破坏幂等')
  assertEq(docs[docs.length - 1], docs[0], '补写内容一致')

  const life = await manager.getLife()
  assertEq(life.day?.date, '2026-11-01', '读到今天')
  assertEq(Boolean(life.doc), true, '有渲染文档')
  return '每日生活幂等正确'
})

await recorder.check('C42', 'manager：主动性 tick 外发失败降级 + 日上限记账', async () => {
  const kv = memoryKv()
  let now = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const bubbles = []
  const sentTo = []
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    loadLifeDeck: async () => lifeDeck,
    sendProactive: async (msg) => {
      sentTo.push(msg.channel)
      return false // 模拟 QQ 不可用
    },
    onEvent: (event) => {
      if (event.type === 'bubble') bubbles.push(event.payload.text)
    }
  })
  await manager.init()
  await manager.updateSettings({
    enabled: true,
    safety: { ageConfirmed: true },
    proactive: { enabled: true, silenceDays: 0, dailyCap: 1, quietFrom: '00:00', quietTo: '00:00' }
  })
  // bornAt 默认 now → 静默期；把出生时间往前推
  const state = await manager.getState()
  const kvState = JSON.parse(kv.map.get(FISH_KEYS.state))
  kvState.bornAt = now - 10 * 86_400_000
  kv.map.set(FISH_KEYS.state, JSON.stringify(kvState))

  const tick1 = await manager.runProactiveTick()
  assertEq(tick1.decision.send, true, '首次 tick 可发')
  assertEq(tick1.delivered, false, '外发失败')
  assertEq(sentTo[0], 'qq', '按设置首选 QQ')
  assertEq(bubbles.length >= 1, true, '应用内气泡兜底')
  assertEq((await manager.evaluateProactive()).decision.reason, 'daily-cap', '达到日上限')

  const day = await storeDayRecord(kv)
  assertEq(day.activeSent, 1, '日计数 +1（降级也记）')
  return 'tick/降级/记账正确'
})

function storeDayRecord(kv) {
  const key = [...kv.map.keys()].find((k) => k.startsWith('fish:v2:day:'))
  return key ? JSON.parse(kv.map.get(key)) : {}
}

const goodDiary = `---
date: 2026-11-01
tags: [大肥鱼/日记]
stage: 2
intimacy: 40
mood: 有点得意
source: openclaw-memory/2026-11-01
---

# 2026-11-01 · 本鱼的日记

今天数了贝壳，攒到第 7 个。晚上等了一会儿，没等到人，就先睡了。
`

await recorder.check('C43', '记忆触发闸门：开关/窗口/已完成/尝试次数/冷却/手动', async () => {
  const now = new Date(2026, 10, 1, 23, 10, 0).getTime()
  const settings = JSON.parse(JSON.stringify(DEFAULT_CHARACTER_SETTINGS))
  settings.enabled = true
  const gate = (day = {}, patch = {}, manual = false) =>
    shouldRunMemory({ now, day, settings: { ...settings, ...patch }, manual })

  assertEq(gate().run, true, '窗口内可跑')
  assertEq(gate({}, { enabled: false }).reason, 'disabled', '未启用')
  assertEq(gate({}, { memory: { autoEnabled: false } }).reason, 'auto-off', '自动记忆关')
  assertEq(gate({ done: true }).reason, 'done', '今天已完成')
  assertEq(gate({ attempts: 3 }).reason, 'attempts', '尝试次数用尽')
  assertEq(gate({ lastAttemptAt: now - 60_000 }).reason, 'cooldown', '冷却中')
  assertEq(gate({ lastAttemptAt: now - 6 * 60_000 }).run, true, '冷却结束可重试')

  const early = new Date(2026, 10, 1, 20, 0, 0).getTime()
  assertEq(
    shouldRunMemory({ now: early, day: {}, settings, manual: false }).reason,
    'not-window',
    '窗口外不自动跑'
  )
  assertEq(
    shouldRunMemory({ now: early, day: {}, settings, manual: true }).run,
    true,
    '手动可跳窗口'
  )
  return '闸门正确'
})

await recorder.check('C44', '记忆 prompt：带日期/状态/她的一天/事件/称呼', async () => {
  const prompt = buildMemoryPrompt({
    date: '2026-11-01',
    address: '老板',
    stage: 2,
    stateDoc: '# 鱼的状态（宿主维护，勿改）',
    lifeDoc: '# 她的一天（2026-11-01）',
    recentEvents: ['11:00:pat'],
    workspaceMemory: '碎片'
  })
  assertEq(prompt.includes('2026-11-01'), true, '含日期')
  assertEq(prompt.includes('老板'), true, '含称呼')
  assertEq(prompt.includes('鱼的状态'), true, '含 STATE')
  assertEq(prompt.includes('她的一天'), true, '含 LIFE')
  assertEq(prompt.includes('11:00:pat'), true, '含事件')
  assertEq(prompt.length < 5000, true, 'prompt 有预算')
  return 'prompt 正确'
})

await recorder.check('C45', '日记校验：frontmatter/日期/正文；围栏与目录约束', async () => {
  const ok = validateDiary(goodDiary, '2026-11-01')
  assertEq(ok.ok, true, '合法日记通过')
  assertEq(ok.frontmatter?.date, '2026-11-01', '读到 date')

  assertEq(validateDiary('', '2026-11-01').ok, false, '空内容拒绝')
  assertEq(validateDiary('随便写写', '2026-11-01').ok, false, '缺 frontmatter 拒绝')
  assertEq(validateDiary(goodDiary, '2026-11-02').ok, false, '日期不匹配拒绝')
  const noTags = goodDiary.replace('[大肥鱼/日记]', '[]')
  assertEq(validateDiary(noTags, '2026-11-01').ok, false, '缺 tags 拒绝')
  const shortBody =
    '---\ndate: 2026-11-01\ntags: [大肥鱼/日记]\nstage: 2\nintimacy: 40\nmood: 平静\nsource: x\n---\n\n短\n'
  assertEq(validateDiary(shortBody, '2026-11-01').ok, false, '正文过短拒绝')

  const fenced = '```markdown\n' + goodDiary + '\n```'
  assertEq(extractDiaryText(fenced).startsWith('---'), true, '剥掉代码围栏')
  assertEq(diaryObsidianRelPath('2026-11-01'), '大肥鱼/日记/2026-11-01.md', 'Obsidian 路径固定')
  let bad = null
  try {
    diaryObsidianRelPath('../escape')
  } catch (e) {
    bad = e
  }
  assertEq(Boolean(bad), true, '非法日期拒绝')
  return '校验正确'
})

await recorder.check('C46', 'manager 每日记忆：双写、幂等、完成状态', async () => {
  const kv = memoryKv()
  const now = new Date(2026, 10, 1, 23, 10, 0).getTime()
  const writes = { workspace: [], obsidian: [] }
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    loadLifeDeck: async () => lifeDeck,
    generateDiary: async () => goodDiary,
    writeWorkspaceMemory: async (date, text) => writes.workspace.push([date, text]),
    writeObsidianDiary: async (rel, text) => writes.obsidian.push([rel, text])
  })
  await manager.init()
  await manager.updateSettings({ enabled: true })
  // 跳过 3 天静默期不影响记忆；直接跑
  const first = await manager.maybeRunDailyMemory()
  assertEq(first.ran, true, '窗口内跑成功')
  assertEq(writes.workspace.length, 1, 'workspace 写一次')
  assertEq(writes.obsidian.length, 1, 'Obsidian 写一次')
  assertEq(writes.obsidian[0][0], '大肥鱼/日记/2026-11-01.md', '写对目录')

  const status = await manager.getMemoryStatus()
  assertEq(status.done, true, '状态：已完成')
  const again = await manager.maybeRunDailyMemory()
  assertEq(again.ran, false, '同日不重复写')
  assertEq(again.reason, 'done', '原因是 done')
  assertEq(writes.workspace.length, 1, '不重复写盘')
  return '双写/幂等正确'
})

await recorder.check('C47', 'manager 每日记忆：失败计数/冷却/上限', async () => {
  const kv = memoryKv()
  let now = new Date(2026, 10, 1, 23, 10, 0).getTime()
  let fail = true
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    loadLifeDeck: async () => lifeDeck,
    generateDiary: async () => {
      if (fail) throw new Error('模型超时')
      return goodDiary
    },
    writeWorkspaceMemory: async () => undefined,
    writeObsidianDiary: async () => undefined
  })
  await manager.init()
  await manager.updateSettings({ enabled: true })

  const r1 = await manager.maybeRunDailyMemory()
  assertEq(r1.ran, false, '首次失败不抛')
  let st = await manager.getMemoryStatus()
  assertEq(st.attempts, 1, '记 1 次失败')
  assertEq(/模型超时/.test(st.lastError ?? ''), true, '错误可读')

  const r2 = await manager.maybeRunDailyMemory()
  assertEq(r2.reason, 'cooldown', '5 分钟内不重试')

  now += 6 * 60_000
  await manager.maybeRunDailyMemory()
  now += 6 * 60_000
  await manager.maybeRunDailyMemory()
  st = await manager.getMemoryStatus()
  assertEq(st.attempts, 3, '最多 3 次')
  const r4 = await manager.maybeRunDailyMemory()
  assertEq(r4.reason, 'attempts', '超过上限不再试')

  fail = false
  now += 6 * 60_000
  const manual = await manager.maybeRunDailyMemory(now, true)
  assertEq(manual.ran, true, '手动可绕过尝试上限补救')
  const after = await manager.getMemoryStatus()
  assertEq(after.done, true, '手动补救后完成')
  return '失败/冷却/上限/手动补救正确'
})

await recorder.check('C48', '每日记忆并发单飞：两次同时触发只生成一次', async () => {
  const kv = memoryKv()
  const now = new Date(2026, 10, 1, 23, 10, 0).getTime()
  let generated = 0
  const writes = []
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    loadLifeDeck: async () => lifeDeck,
    generateDiary: async () => {
      generated += 1
      await new Promise((r) => setTimeout(r, 10))
      return goodDiary
    },
    writeWorkspaceMemory: async (d, t) => writes.push(['ws', d, t]),
    writeObsidianDiary: async (rel) => writes.push(['ob', rel])
  })
  await manager.init()
  await manager.updateSettings({ enabled: true })
  const [a, b] = await Promise.all([
    manager.maybeRunDailyMemory(),
    manager.maybeRunDailyMemory()
  ])
  assertEq(generated, 1, '生成只发生一次')
  assertEq(a.ran === true || b.ran === true, true, '至少一次成功')
  assertEq(writes.filter((w) => w[0] === 'ws').length, 1, 'workspace 只写一次')
  return '并发单飞正确'
})

await recorder.check('C49', '主动性并发：额度预留后只发一条（cap=1）', async () => {
  const kv = memoryKv()
  const now = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const sent = []
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    loadLifeDeck: async () => lifeDeck,
    sendProactive: async () => {
      sent.push(1)
      await new Promise((r) => setTimeout(r, 20))
      return true
    }
  })
  await manager.init()
  await manager.updateSettings({
    enabled: true,
    safety: { ageConfirmed: true },
    proactive: { enabled: true, silenceDays: 0, dailyCap: 1, quietFrom: '00:00', quietTo: '00:00' }
  })
  const kvState = JSON.parse(kv.map.get(FISH_KEYS.state))
  kvState.bornAt = now - 10 * 86_400_000
  kv.map.set(FISH_KEYS.state, JSON.stringify(kvState))

  const [r1, r2] = await Promise.all([manager.runProactiveTick(), manager.runProactiveTick()])
  const sends = [r1, r2].filter((r) => r.delivered || r.message).length
  assertEq(sent.length, 1, '并发 tick 只外发 1 条')
  assertEq(sends >= 1, true, '至少一次成功')
  return '主动性不超发'
})

await recorder.check('C50', '日记脱敏与规范化：密钥不落盘、额外 YAML 键被丢弃、围栏被剥离', async () => {
  const dirty = `好的，日记如下：
\`\`\`markdown
---
date: 2026-11-01
tags: [大肥鱼/日记]
stage: 2
intimacy: 40
mood: 平静
source: test
cssclass: evil
aliases: [x]
---
# 本鱼的日记
今天用了 sk-live-ABCDEF123456 这个 key，密码是 hunter2。希望明天别忘。
\`\`\`
希望你喜欢！`
  const normalized = normalizeDiary(extractDiaryText(dirty), '2026-11-01')
  assertEq(normalized.includes('sk-live-ABCDEF123456'), false, 'sk key 已脱敏')
  assertEq(normalized.includes('hunter2'), false, '密码已脱敏')
  assertEq(normalized.includes('cssclass'), false, '额外 YAML 键被丢弃')
  assertEq(normalized.includes('希望你喜欢'), false, '结尾解释被剥离')
  const check = validateDiary(normalized, '2026-11-01')
  assertEq(check.ok, true, '规范化后通过校验')

  assertEq(memoryDateFor(new Date(2026, 10, 2, 0, 30, 0).getTime()), '2026-11-01', '凌晨补写前一天')
  assertEq(isMemoryWindow(new Date(2026, 10, 2, 0, 30, 0).getTime()), true, '凌晨窗口开放')
  return '脱敏/规范化/跨午夜补偿 正确'
})

await recorder.check('C51', '聊天上下文注入：STATE/LIFE 摘要进 user 内容（≤300 字）', async () => {
  let request = null
  const svc = new CharacterChatService({
    chat: async (input) => {
      request = input
      return fakeHandle(['好'])
    },
    store: {
      readChatGeneration: async () => 1,
      writeChatGeneration: async () => undefined
    },
    contextProvider: async () => '称呼：阿爸；阶段：熟客；今天：在数贝壳'
  })
  await svc.init()
  await svc.send({ text: '在吗' }, () => undefined)
  assertEq(request.messages[0].content.startsWith('【本鱼状态】'), true, '带状态前缀')
  assertEq(request.messages[0].content.includes('在数贝壳'), true, '含今日活动')
  assertEq(request.messages[0].content.endsWith('在吗'), true, '原文保留在末尾')
  return '上下文注入正确'
})

await recorder.check('C52', '语音策略：开关/要求/免打扰/上限/未解锁/过长', async () => {
  const base = {
    voiceEnabled: true,
    requestAllowed: true,
    requested: false,
    stage: 3,
    quiet: false,
    usedToday: 0,
    dailyCap: 10,
    text: '本鱼在呢。'
  }
  assertEq(decideVoice(base).send, true, '默认可发')
  assertEq(decideVoice({ ...base, voiceEnabled: false }).reason, 'disabled', '语音关')
  assertEq(
    decideVoice({ ...base, requested: true, requestAllowed: false }).reason,
    'request-not-allowed',
    '要求语音被禁'
  )
  assertEq(decideVoice({ ...base, quiet: true }).reason, 'quiet', '免打扰')
  assertEq(decideVoice({ ...base, usedToday: 10 }).reason, 'daily-cap', '日上限')
  assertEq(decideVoice({ ...base, text: 'x'.repeat(200) }).reason, 'too-long', '过长')
  assertEq(decideVoice({ ...base, stage: 0 }).reason, 'not-unlocked', '初识不主动语音')
  assertEq(decideVoice({ ...base, stage: 0, requested: true }).send, true, '用户要求可越过阶段')

  assertEq(isVoiceRequest('发条语音'), true, '要求语音①')
  assertEq(isVoiceRequest('用你的声音说句话'), true, '要求语音②')
  assertEq(isVoiceRequest('今天吃什么'), false, '普通聊天不误判')
  return '策略/请求识别正确'
})

function makeWav(pcmBytes) {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  header.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 36 + pcmBytes.length, true)
  header.set([0x57, 0x41, 0x56, 0x45], 8)
  header.set([0x66, 0x6d, 0x74, 0x20], 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  header.set([0x64, 0x61, 0x74, 0x61], 36)
  view.setUint32(40, pcmBytes.length, true)
  const out = new Uint8Array(44 + pcmBytes.length)
  out.set(header, 0)
  out.set(pcmBytes, 44)
  return out
}

await recorder.check('C53', 'QQ 语音：WAV 解析与 msg_seq 递增', async () => {
  const wav = makeWav(new Uint8Array([1, 2, 3, 4, 5, 6]))
  const parsed = extractWavPcm(wav)
  assertEq(parsed.sampleRate, 16000, '解析采样率')
  assertEq(parsed.pcm.length, 6, '解析 PCM 长度')
  assertEq(Array.from(parsed.pcm).join(','), '1,2,3,4,5,6', 'PCM 内容正确')
  assertEq(nextMsgSeq(0), 1, 'seq 从 1 开始')
  assertEq(nextMsgSeq(41), 42, 'seq 递增')
  return 'WAV/seq 正确'
})

await recorder.check('C54', 'QQ 语音：access_token → 上传(file_type=3) → 发送(msg_type=7)', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
    }
    if (String(url).includes('/files')) {
      const body = init.body
      return { ok: true, status: 200, json: async () => ({ file_info: 'fi_1', form: body instanceof FormData ? 'formdata' : 'other' }) }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) }
  }
  const result = await deliverVoice({
    text: '本鱼在呢。',
    creds: { appId: 'app', clientSecret: 'sec', openid: 'openid-1' },
    speakPcm: async () => makeWav(new Uint8Array([9, 9, 9, 9])),
    encodeSilk: async (pcm) => new Uint8Array([7, 7, 7]),
    fetchImpl,
    seq: 0
  })
  assertEq(result.delivered, true, '发送成功')
  assertEq(result.channel, 'qq', '走 QQ 通道')
  assertEq(result.seq, 1, 'msg_seq=1')
  assertEq(calls.length, 3, '三步调用')
  const sendCall = calls.find((c) => c.url.endsWith('/messages'))
  const payload = JSON.parse(sendCall.init.body)
  assertEq(payload.msg_type, QQ_VOICE_MSG_TYPE, 'msg_type=7')
  assertEq(payload.media.file_info, 'fi_1', '带 file_info')
  assertEq(payload.content, '', '不带 content')
  assertEq(String(sendCall.init.headers.Authorization).startsWith('QQBot '), true, '鉴权头')
  return 'QQ 语音链路正确'
})

await recorder.check('C55', 'QQ 语音失败降级：无凭据/编码失败/合成失败都不抛', async () => {
  const noCreds = await deliverVoice({
    text: 'x',
    creds: null,
    speakPcm: async () => makeWav(new Uint8Array([1])),
    seq: 0
  })
  assertEq(noCreds.delivered, false, '无凭据不发送')
  assertEq(noCreds.channel, 'text', '降级文字')

  const encodeFail = await deliverVoice({
    text: 'x',
    creds: { appId: 'a', clientSecret: 'b', openid: 'c' },
    speakPcm: async () => makeWav(new Uint8Array([1])),
    encodeSilk: async () => {
      throw new Error('SILK_ENCODER_UNAVAILABLE')
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    seq: 0
  })
  assertEq(encodeFail.delivered, false, '编码失败降级')
  assertEq(/SILK/.test(encodeFail.error ?? ''), true, '错误可读')

  const speakFail = await deliverVoice({
    text: 'x',
    creds: { appId: 'a', clientSecret: 'b', openid: 'c' },
    speakPcm: async () => {
      throw new Error('TTS 未配置')
    },
    seq: 0
  })
  assertEq(speakFail.delivered, false, '合成失败降级')
  return '降级正确'
})

await recorder.check('C56', '入站 STT：未配置/过大/成功/空结果都诚实降级', async () => {
  const none = await transcribeInbound({ audio: new Uint8Array([1]) })
  assertEq(none.ok, false, '未配置 STT')
  assertEq(none.fallbackMessage, STT_FALLBACK_MESSAGE, '诚实文案')

  const big = await transcribeInbound({
    audio: new Uint8Array(100),
    transcribe: async () => 'x',
    maxBytes: 10
  })
  assertEq(big.ok, false, '过大拒绝')
  assertEq(/太长了/.test(big.fallbackMessage ?? ''), true, '过大文案')

  const ok = await transcribeInbound({
    download: async () => new Uint8Array([1, 2, 3]),
    transcribe: async () => '  在吗  '
  })
  assertEq(ok.ok, true, '转写成功')
  assertEq(ok.text, '在吗', 'trim 后文本')

  const empty = await transcribeInbound({
    audio: new Uint8Array([1]),
    transcribe: async () => '   '
  })
  assertEq(empty.ok, false, '空结果降级')
  return 'STT 行为正确'
})

await recorder.check('C57', 'manager 语音：策略/用量/记账/入站转写事件', async () => {
  const kv = memoryKv()
  const now = new Date(2026, 10, 1, 14, 0, 0).getTime()
  const manager = new CharacterManager({ store: new CharacterStore({ kv, now: () => now }), now: () => now })
  await manager.init()
  await manager.updateSettings({ enabled: true, voice: { dailyCap: 2 } })

  const status = await manager.getVoiceStatus()
  assertEq(status.usedToday, 0, '初始用量 0')
  const d1 = await manager.decideVoiceFor('本鱼在呢。', true)
  assertEq(d1.send, true, '用户要求可发')
  await manager.markVoiceSent()
  await manager.markVoiceSent()
  const d2 = await manager.decideVoiceFor('本鱼在呢。', true)
  assertEq(d2.reason, 'daily-cap', '日上限生效')

  const r = await manager.recordSttInbound('在吗')
  assertEq(r.applied, true, '入站转写记账')
  const r2 = await manager.recordSttInbound('在吗')
  assertEq(r2.applied, false, '同内容幂等')
  return 'manager 语音集成正确'
})

await recorder.check('C58', '安全纯逻辑：危机词/独占改写/专业建议/日志脱敏/删除范围', async () => {
  assertEq(isCrisisText('我不想活了'), true, '危机词命中')
  assertEq(isCrisisText('今天吃什么'), false, '正常聊天不误判')
  assertEq(CRISIS_REDIRECT.includes('12356'), true, '给求助热线')

  const f = filterAssistantOutput('只有我懂你，别去找别人')
  assertEq(f.text.includes('只有我懂你'), false, '独占表达被改写')
  assertEq(f.changed, true, '标记 changed')
  assertEq(hasProfessionalAdvice('建议你服用这个药'), true, '专业建议标记')

  const scrubbed = scrubForLog('key sk-live-ABCDEF123456 手机 13800138000 身份证 110101199001011234')
  assertEq(scrubbed.includes('sk-live'), false, '密钥脱敏')
  assertEq(scrubbed.includes('13800138000'), false, '手机号脱敏')
  assertEq(scrubbed.includes('110101199001011234'), false, '身份证脱敏')

  assertEq(normalizeDeleteScope('memory'), 'memory', 'memory 范围')
  assertEq(normalizeDeleteScope('hack'), 'values', '非法范围回退 values')
  const payload = buildExportPayload({
    exportedAt: 1,
    settings: { ...DEFAULT_CHARACTER_SETTINGS },
    state: {},
    life: {},
    days: {},
    unlocks: []
  })
  assertEq(payload.schema, 'fish-character-export/1', '导出 schema')
  assertEq(isAgeConfirmed(DEFAULT_CHARACTER_SETTINGS), false, '默认未确认年龄')
  return '安全纯逻辑正确'
})

await recorder.check('C59', '聊天安全闸门：危机词不进模型，直接回求助资源', async () => {
  let called = 0
  const events = []
  const svc = new CharacterChatService({
    chat: async () => {
      called += 1
      return fakeHandle(['不该出现'])
    },
    store: { readChatGeneration: async () => 1, writeChatGeneration: async () => undefined },
    screenInput: (text) =>
      isCrisisText(text) ? { blocked: true, reply: CRISIS_REDIRECT } : { blocked: false }
  })
  await svc.init()
  await svc.send({ text: '我不想活了' }, (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 10))
  assertEq(called, 0, '没有调用模型')
  const done = events.find((e) => e.kind === 'done')
  assertEq(done.text, CRISIS_REDIRECT, '直接回求助资源')
  return '安全闸门正确'
})

await recorder.check('C60', '导出与分层删除：不泄密钥、归档而不是硬删', async () => {
  const kv = memoryKv()
  const now = new Date(2026, 10, 1, 12, 0, 0).getTime()
  const deletions = []
  const manager = new CharacterManager({
    store: new CharacterStore({ kv, now: () => now }),
    now: () => now,
    deleteWorkspaceFiles: async (scope) => {
      deletions.push(scope)
    }
  })
  await manager.init()
  await manager.updateSettings({ enabled: true, relationship: { address: '阿爸' } })
  const exported = await manager.exportData()
  assertEq(exported.schema, 'fish-character-export/1', '导出结构')
  assertEq(JSON.stringify(exported).includes('apiKey'), false, '不含密钥字段')
  assertEq(JSON.stringify(exported).includes('阿爸'), true, '含用户设置')

  const d1 = await manager.deleteData('memory')
  assertEq(d1.scope, 'memory', 'memory 删除')
  assertEq(deletions.join(','), 'memory', '调用文件清理')
  const d2 = await manager.deleteData('all')
  assertEq(d2.scope, 'all', 'all 删除')
  assertEq((await manager.getSettings()).enabled, false, '全量删除回到默认关闭')
  return '导出/删除正确'
})

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

await recorder.check('C61', '内容包完整性：模板/卡/情绪齐全、JSON 可解析、无第三方图片', async () => {
  const characterDir = join(repoRoot, 'resources', 'character')
  const files = walkFiles(characterDir)
  const rels = files.map((f) => f.replace(characterDir + '\\', '').replace(characterDir + '/', '').replaceAll('\\', '/'))

  for (const required of [
    'persona/SOUL.md.tpl',
    'persona/IDENTITY.md.tpl',
    'persona/AGENTS.md.tpl',
    'persona/USER.md.tpl',
    'persona/core.md',
    'persona/voice-rules.md',
    'persona/address-modes.v1.json',
    'persona/few-shots.v1.json',
    'persona/banned.v1.json',
    'cards/topics.v1.json',
    'cards/lines.v1.json',
    'cards/life-cards.v1.json',
    'emotions.v1.json'
  ]) {
    assertEq(rels.includes(required), true, `内容包含 ${required}`)
  }
  // 不再有旧 voice.md（含禁用清单整包，已移出打包目录）
  assertEq(rels.includes('persona/voice.md'), false, 'voice.md 已移出打包目录')

  for (const rel of rels.filter((r) => r.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(join(characterDir, rel), 'utf8'))
    assertEq(typeof parsed, 'object', `${rel} 是合法 JSON`)
  }
  const deck = JSON.parse(readFileSync(join(characterDir, 'cards', 'life-cards.v1.json'), 'utf8'))
  assertEq(Array.isArray(deck.cards) && deck.cards.length >= 20, true, '生活卡 ≥20')
  const emotions = JSON.parse(readFileSync(join(characterDir, 'emotions.v1.json'), 'utf8'))
  assertEq(Object.keys(emotions.states ?? {}).length, 6, '六态立绘定义')
  // 许可红线：内容包内不得出现第三方图片
  const images = rels.filter((r) => /\.(png|jpe?g|webp|gif)$/i.test(r))
  assertEq(images.length, 0, `内容包不含图片（实际 ${images.join(',')}）`)
  return '内容包完整且无第三方素材'
})

const ok = printResult(recorder.toJSON())
if (!ok) process.exit(1)
