// test/character-content.accept.mjs —— 用户主动消息语料库（话题/台词/生活卡 + 内置停用）验收
//
// 纯 Node（零 npm 依赖），esbuild 打真源码 electron/main/character/contentStore.ts
// （连带真 contentEngine/contentCards 解析器、contentOverrides 与 types 错误码），
// 临时 dataDir 落盘，不 mock 被测逻辑。
// 覆盖：空目录总览 / 话题导入计数与落盘 / 同 id 接管内置与删除回落 / 空非法导入拒入 /
//       台词新组追加去重与合并顺序 / 删除（含内置拒删、非法下标）/ reset 三范围 /
//       坏 JSON 回落不阻断 / 解析白名单与通道命名 / 上限护栏 / 导出与引擎合并一致 /
//       内置话题/台词/生活卡停用与恢复 / 单卡 upsert 保留额外字段 / 生活卡增删改与合并 /
//       停用清单落盘重读与坏文件回落 / importLifeDeck 合并与上限 / contentLibrary facade。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  tmpDir,
  writeJson
} from './_lib.mjs'

const storeMod = await import(
  pathToFileURL(bundleEntry('electron/main/character/contentStore.ts', 'character-content-store.mjs'))
)
const libraryMod = await import(
  pathToFileURL(
    bundleEntry('electron/main/character/contentLibrary.ts', 'character-content-library.mjs')
  )
)
const {
  createContentStore,
  CHARACTER_CONTENT_CHANNELS,
  USER_TOPIC_MAX,
  USER_LINE_GROUPS_MAX,
  USER_LIFE_CARD_MAX,
  USER_TOPICS_FILE,
  USER_LINES_FILE,
  USER_OVERRIDES_FILE,
  USER_LIFE_CARDS_FILE
} = storeMod
const { createContentLibrary } = libraryMod

const suite = new Recorder('character-content')
const roots = []

function mkRoot(name) {
  const root = join(tmpDir, `character-content-${name}-${process.pid}-${Date.now()}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

/** 内置只读语料夹具（结构等同 parseContentDeck 的产物，带 slots/seasons） */
function builtinDeck() {
  return {
    topics: {
      schema: 'fish-topics/1',
      version: '1.0',
      topics: [
        {
          id: 'builtin-a',
          title: '内置A',
          when: '',
          stance: '',
          details: [],
          hooks: ['内置A钩子'],
          sample: '内置A样例',
          slots: [],
          seasons: []
        },
        {
          id: 'builtin-b',
          title: '内置B',
          when: '',
          stance: '',
          details: [],
          hooks: [],
          sample: '内置B样例',
          slots: ['night'],
          seasons: []
        }
      ]
    },
    lines: {
      schema: 'fish-lines/1',
      version: '1.0',
      groups: { greeting: ['内置问候'], care: ['内置关心'] }
    }
  }
}

function makeStore(root) {
  const deck = builtinDeck()
  return { store: createContentStore({ dataDir: root, loadBuiltin: async () => deck }), deck }
}

/** 内置生活卡夹具（结构等同 contentCards.parseLifeDeck 的产物） */
function builtinLifeDeck() {
  return {
    schema: 'fish-life-cards/1',
    version: '1.0',
    cards: [
      {
        id: 'life-builtin-a',
        slots: ['morning'],
        minStage: 1,
        activity: '内置活动A',
        mood: '开心',
        goal: '目标A',
        hook: '内置钩子A',
        weight: 2
      },
      {
        id: 'life-builtin-b',
        slots: ['night'],
        minStage: 1,
        activity: '内置活动B',
        mood: '安静',
        goal: '',
        hook: '内置钩子B',
        weight: 1
      }
    ]
  }
}

function makeStoreWithLife(root) {
  const deck = builtinDeck()
  const lifeDeck = builtinLifeDeck()
  return {
    store: createContentStore({
      dataDir: root,
      loadBuiltin: async () => deck,
      loadBuiltinLife: async () => lifeDeck
    }),
    deck,
    lifeDeck
  }
}

async function expectBadPayload(fn, label) {
  let error = null
  try {
    await fn()
  } catch (e) {
    error = e
  }
  assert(error, `${label} 必须抛错`)
  assertEq(error?.code, 'CHARACTER_BAD_PAYLOAD', `${label} 错误码为 BAD_PAYLOAD`)
}

await suite.check('K1', '空目录：总览只有内置、用户计数 0，引擎合并等于内置且不落盘', async () => {
  const root = mkRoot('k1')
  const { store } = makeStore(root)
  const overview = await store.overview()
  assertEq(overview.builtinTopicCount, 2, '内置话题 2 张')
  assertEq(overview.userTopicCount, 0, '用户话题 0 张')
  assertEq(overview.userLineCount, 0, '用户台词 0 句')
  assertEq(overview.topics.every((t) => t.source === 'builtin'), true, '全部标 builtin')
  assertEq(overview.lineGroups.length, 2, '两个内置台词组')
  const merged = await store.mergeForEngine()
  assertEq(merged.topics.topics.length, 2, '合并后仍是 2 张话题')
  assertEq(merged.lines.groups.greeting.length, 1, '合并台词组仍是内置 1 句')
  assertEq(existsSync(store.paths().topicsPath), false, '尚未导入，用户话题文件不存在')
  assertEq(existsSync(store.paths().linesPath), false, '尚未导入，用户台词文件不存在')
})

await suite.check('K2', '导入话题：计数/落盘/来源标注/进引擎候选', async () => {
  const root = mkRoot('k2')
  const { store } = makeStore(root)
  const result = await store.importTopics({
    topics: [
      {
        id: 'user-1',
        title: '用户一',
        sample: '用户样例一',
        hooks: ['用户钩子'],
        requiresChatMention: true
      },
      { id: 'user-2', title: '用户二', sample: '用户样例二' }
    ]
  })
  assertEq(result.added, 2, '新增 2 张')
  assertEq(result.updated, 0, '更新 0 张')
  assertEq(result.total, 2, '用户库共 2 张')
  assertEq(existsSync(store.paths().topicsPath), true, '用户话题文件已落盘')
  const onDisk = JSON.parse(readFileSync(store.paths().topicsPath, 'utf8'))
  assertEq(onDisk.topics.length, 2, '落盘 JSON 含 2 张')
  assertDeepEqSafe(onDisk.topics[0].slots, [], '缺省 slots 回落空数组')
  assertDeepEqSafe(onDisk.topics[0].seasons, [], '缺省 seasons 回落空数组（全年可用）')
  assertEq(onDisk.topics[0].requiresChatMention, true, '用户话题上下文门禁字段落盘')
  const overview = await store.overview()
  assertEq(overview.topics.filter((t) => t.source === 'user').length, 2, '总览 2 张标 user')
  const merged = await store.mergeForEngine()
  assertEq(merged.topics.topics.length, 4, '引擎合并 2 内置 + 2 用户')
  assertEq(merged.topics.topics.some((t) => t.id === 'user-1'), true, '用户卡进引擎')
  assertEq(
    merged.topics.topics.find((t) => t.id === 'user-1')?.requiresChatMention,
    true,
    '用户话题上下文门禁进入引擎'
  )
})

await suite.check('K3', '同 id 接管内置卡；删除用户卡后回落内置版本', async () => {
  const root = mkRoot('k3')
  const { store, deck } = makeStore(root)
  await store.importTopics({ topics: [{ id: 'builtin-a', sample: '用户改写的A', hooks: ['改写钩子'] }] })
  let merged = await store.mergeForEngine()
  const takenOver = merged.topics.topics.filter((t) => t.id === 'builtin-a')
  assertEq(takenOver.length, 1, '同 id 只保留一张（用户接管，不重复）')
  assertEq(takenOver[0].sample, '用户改写的A', '生效的是用户版本')
  const overview = await store.overview()
  assertEq(overview.topics.find((t) => t.id === 'builtin-a').source, 'user', '总览标 user')
  const removed = await store.deleteUserTopic('builtin-a')
  assertEq(removed, true, '删除用户接管卡命中')
  merged = await store.mergeForEngine()
  const restored = merged.topics.topics.filter((t) => t.id === 'builtin-a')
  assertEq(restored.length, 1, '删除后仍有一张（回落内置）')
  assertEq(restored[0].sample, deck.topics.topics[0].sample, '回落到内置原文')
  assertEq((await store.overview()).topics.find((t) => t.id === 'builtin-a').source, 'builtin', '总览回落 builtin')
})

await suite.check('K4', '空/非法语料拒入，不写坏文件', async () => {
  const root = mkRoot('k4')
  const { store } = makeStore(root)
  await expectBadPayload(() => store.importTopics({ topics: [] }), '空话题数组')
  await expectBadPayload(
    () => store.importTopics({ topics: [{ id: 'no-content' }] }),
    '无 sample/hooks 的废卡'
  )
  await expectBadPayload(() => store.importLines({ groups: {} }), '空台词组')
  await expectBadPayload(
    () => store.importLines({ groups: { BadName: ['一句'] } }),
    '非法组名（非小写短横线）'
  )
  assertEq(existsSync(store.paths().topicsPath), false, '拒入不写话题文件')
  assertEq(existsSync(store.paths().linesPath), false, '拒入不写台词文件')
})

await suite.check('K5', '台词：新组/同组追加/文本去重，引擎合并内置在前用户在后', async () => {
  const root = mkRoot('k5')
  const { store } = makeStore(root)
  const first = await store.importLines({ groups: { greeting: ['用户问候一', '用户问候二'], miss: ['想你'] } })
  assertEq(first.groupsAdded, 2, '新增 2 个组（greeting 已内置但用户库首次建）')
  assertEq(first.linesAdded, 3, '新增 3 句')
  const second = await store.importLines({ groups: { greeting: ['用户问候一', '用户问候三'] } })
  assertEq(second.linesAdded, 1, '重复句去重，只加 1 句')
  const merged = await store.mergeForEngine()
  assertDeepEqSafe(
    merged.lines.groups.greeting,
    ['内置问候', '用户问候一', '用户问候二', '用户问候三'],
    '合并后内置句在前、用户句在后且去重'
  )
  assertDeepEqSafe(merged.lines.groups.miss, ['想你'], '全新组合并')
  assertEq(merged.lines.groups.care?.[0], '内置关心', '未触碰的内置组保留')
  // 跨内置/用户边界去重：导入与内置重复的句子，合并后不出现两次、不抬高随机权重
  await store.importLines({ groups: { care: ['内置关心', '额外关心'] } })
  const dedupMerged = await store.mergeForEngine()
  assertDeepEqSafe(dedupMerged.lines.groups.care, ['内置关心', '额外关心'], '内置/用户重复句保序去重')
})

await suite.check('K6', '删除：话题命中/未命中/内置拒删；台词下标/整组/非法下标', async () => {
  const root = mkRoot('k6')
  const { store } = makeStore(root)
  await store.importTopics({ topics: [{ id: 'user-x', sample: 'X' }] })
  assertEq(await store.deleteUserTopic('user-x'), true, '删用户话题命中')
  assertEq(await store.deleteUserTopic('user-x'), false, '再删同 id 未命中')
  assertEq(await store.deleteUserTopic('builtin-a'), false, '内置 id 不可删（用户库无此 id）')
  await store.importLines({ groups: { greeting: ['u1', 'u2'] } })
  assertEq(await store.deleteUserLine('greeting', 0), true, '删用户台词句命中')
  assertDeepEqSafe(
    (await store.mergeForEngine()).lines.groups.greeting,
    ['内置问候', 'u2'],
    '删句后内置保留、用户剩 1 句'
  )
  assertEq(await store.deleteUserLine('greeting', 0), true, '删最后一句用户台词')
  const overview = await store.overview()
  assertEq(overview.lineGroups.find((g) => g.name === 'greeting').userLines.length, 0, '用户句清空')
  assertEq(await store.deleteUserLine('greeting', 9), false, '非法下标拒删')
  assertEq(await store.deleteUserLine('not-exist', 0), false, '不存在的组拒删')
})

await suite.check('K7', 'reset 三范围只清用户语料，内置与另一类不受影响', async () => {
  const root = mkRoot('k7')
  const { store } = makeStore(root)
  await store.importTopics({ topics: [{ id: 'u-t', sample: 'T' }] })
  await store.importLines({ groups: { greeting: ['u-line'] } })
  const r1 = await store.resetUser('topics')
  assertEq(r1.topics, 1, '清掉 1 张用户话题')
  assertEq(r1.lines, 0, '台词不计入')
  assertEq(existsSync(store.paths().topicsPath), false, '话题文件已删')
  assertEq(existsSync(store.paths().linesPath), true, '台词文件仍在')
  const r2 = await store.resetUser('all')
  assertEq(r2.topics, 0, '话题已空')
  assertEq(r2.lines, 1, '清掉 1 句用户台词')
  const merged = await store.mergeForEngine()
  assertEq(merged.topics.topics.length, 2, '内置话题仍完整')
  assertEq(merged.lines.groups.greeting[0], '内置问候', '内置台词仍完整')
})

await suite.check('K8', '用户文件损坏：总览/合并不抛错，回落仅内置', async () => {
  const root = mkRoot('k8')
  const { store } = makeStore(root)
  mkdirSync(store.paths().dir, { recursive: true })
  writeFileSync(store.paths().topicsPath, '{ 坏 json', 'utf8')
  writeFileSync(store.paths().linesPath, '也不是 json', 'utf8')
  const overview = await store.overview()
  assertEq(overview.userTopicCount, 0, '坏话题文件回落 0')
  assertEq(overview.userLineCount, 0, '坏台词文件回落 0')
  assertEq(overview.builtinTopicCount, 2, '内置照常加载')
  const merged = await store.mergeForEngine()
  assertEq(merged.topics.topics.length, 2, '引擎合并不被坏文件阻断')
  // 坏文件后仍可正常导入（落盘覆盖坏文件）
  const fixed = await store.importTopics({ topics: [{ id: 'recover', sample: '恢复' }] })
  assertEq(fixed.total, 1, '坏文件可被新导入修复')
})

await suite.check('K9', '解析白名单（seasons 非法值过滤）+ 通道命名合规', async () => {
  const root = mkRoot('k9')
  const { store } = makeStore(root)
  await store.importTopics({
    topics: [
      { id: 'season-card', sample: '季节卡', seasons: ['summer', 'bogus', 'winter'], slots: ['noon', 'bad'] }
    ]
  })
  const card = (await store.overview()).topics.find((t) => t.id === 'season-card')
  assertDeepEqSafe(card.seasons, ['summer', 'winter'], 'seasons 非法值被白名单过滤')
  assertDeepEqSafe(card.slots, ['noon'], 'slots 非法值被白名单过滤')
  for (const channel of Object.values(CHARACTER_CONTENT_CHANNELS)) {
    assert(/^character:content:[a-z-]+$/.test(channel), `通道命名合规：${channel}`)
  }
  assertEq(Object.keys(CHARACTER_CONTENT_CHANNELS).length, 7, '7 个语料通道')
})

await suite.check('K10', '上限护栏：话题/台词组数超限拒入；单组句数由解析器限 30', async () => {
  const root = mkRoot('k10')
  const { store } = makeStore(root)
  const many = Array.from({ length: USER_TOPIC_MAX + 1 }, (_, i) => ({
    id: `t-${i}`,
    sample: `样例${i}`
  }))
  await expectBadPayload(() => store.importTopics({ topics: many }), `超话题上限 ${USER_TOPIC_MAX}`)
  const tooManyGroups = Object.fromEntries(
    Array.from({ length: USER_LINE_GROUPS_MAX + 1 }, (_, i) => [`g${i}`, [`句${i}`]])
  )
  await expectBadPayload(
    () => store.importLines({ groups: tooManyGroups }),
    `超台词组数上限 ${USER_LINE_GROUPS_MAX}`
  )
  // 单组句数上限在解析器层（readStringList 限 30）：导入 31 句唯一值，落盘被截到 30
  await store.importLines({ groups: { capped: Array.from({ length: 31 }, (_, i) => `第${i}句`) } })
  const overview = await store.overview()
  assertEq(
    overview.lineGroups.find((g) => g.name === 'capped').userLines.length,
    30,
    '单组超过 30 句由解析器截断（内置/用户同口径）'
  )
})

await suite.check('K11', 'exportMerged 与引擎合并内容一致，含完整 schema', async () => {
  const root = mkRoot('k11')
  const { store } = makeStore(root)
  await store.importTopics({ topics: [{ id: 'u-e', sample: '导出我' }] })
  const exported = await store.exportMerged()
  const merged = await store.mergeForEngine()
  assertEq(exported.topics.schema, merged.topics.schema, '话题 schema 一致')
  assertEq(exported.lines.schema, merged.lines.schema, '台词 schema 一致')
  assertEq(exported.topics.topics.length, merged.topics.topics.length, '话题条数一致')
  assertEq(exported.topics.topics.some((t) => t.id === 'u-e'), true, '导出含用户卡')
  assertEq(USER_TOPICS_FILE.endsWith('.json') && USER_LINES_FILE.endsWith('.json'), true, '用户文件名固定')
})

await suite.check('K12', '内置 loader 抛错：总览/合并不阻断，回落空内置 + 用户语料仍在', async () => {
  const root = mkRoot('k12')
  const failing = createContentStore({
    dataDir: root,
    loadBuiltin: async () => {
      throw new Error('resources 缺失')
    }
  })
  await failing.importTopics({ topics: [{ id: 'only-user', sample: '只有用户卡' }] })
  const overview = await failing.overview()
  assertEq(overview.builtinTopicCount, 0, '内置失败时内置计数 0')
  assertEq(overview.userTopicCount, 1, '用户语料不受内置失败影响')
  assertEq(overview.topics[0].source, 'user', '仅显示用户卡')
  const merged = await failing.mergeForEngine()
  assertEq(merged.topics.topics.length, 1, '合并不抛错，回落仅用户卡')
  assertEq(merged.topics.topics[0].id, 'only-user', '用户卡仍进引擎')
})

await suite.check('K13', '停用内置话题：引擎不再出现、overview 标 disabled、恢复后回来', async () => {
  const root = mkRoot('k13')
  const { store } = makeStore(root)
  const before = await store.mergeForEngine()
  assertEq(before.topics.topics.some((t) => t.id === 'builtin-a'), true, '停用前内置卡在引擎里')
  const overrides = await store.setTopicDisabled('builtin-a', true)
  assertDeepEqSafe(overrides.kinds.topics.disabledIds, ['builtin-a'], '停用清单记录内置话题 id')
  assertEq(existsSync(store.paths().overridesPath), true, '停用清单已落盘')
  const disabled = await store.mergeForEngine()
  assertEq(disabled.topics.topics.some((t) => t.id === 'builtin-a'), false, '停用后内置卡不进引擎')
  assertEq(disabled.topics.topics.some((t) => t.id === 'builtin-b'), true, '其他内置卡不受影响')
  const overview = await store.overview()
  const item = overview.topics.find((t) => t.id === 'builtin-a')
  assertEq(Boolean(item), true, '被停用的内置卡仍出现在总览（UI 才能恢复）')
  assertEq(item.source, 'builtin', '总览来源仍标 builtin')
  assertEq(item.disabled, true, '总览标 disabled=true')
  assertEq(overview.topics.find((t) => t.id === 'builtin-b').disabled, undefined, '未停用项不带 disabled')
  const restored = await store.restoreOverrides('topics')
  assertDeepEqSafe(restored.kinds.topics.disabledIds, [], '恢复话题停用')
  const back = await store.mergeForEngine()
  assertEq(back.topics.topics.some((t) => t.id === 'builtin-a'), true, '恢复后内置卡回到引擎')
  assertEq(
    (await store.overview()).topics.find((t) => t.id === 'builtin-a').disabled,
    undefined,
    '恢复后总览不再标 disabled'
  )
})

await suite.check('K14', '停用内置台词：单句/整组只过滤内置句，用户台词不受影响，可恢复', async () => {
  const root = mkRoot('k14')
  const { store } = makeStore(root)
  await store.importLines({ groups: { greeting: ['用户问候'], care: ['用户关心'] } })
  await store.setLineDisabled('care', '内置关心', true)
  let merged = await store.mergeForEngine()
  assertDeepEqSafe(merged.lines.groups.care, ['用户关心'], '单句停用后内置句被过滤、用户句保留')
  assertEq(merged.lines.groups.greeting.includes('内置问候'), true, '其他组内置句不受影响')
  let overview = await store.overview()
  const careGroup = overview.lineGroups.find((g) => g.name === 'care')
  assertDeepEqSafe(careGroup.builtinLines, ['内置关心'], '总览仍保留完整内置列表')
  assertDeepEqSafe(careGroup.disabledLines, ['内置关心'], '总览上报被停用的单句文本')
  await store.setGroupDisabled('greeting', true)
  merged = await store.mergeForEngine()
  assertDeepEqSafe(merged.lines.groups.greeting, ['用户问候'], '整组停用只过滤内置句，用户句仍在')
  overview = await store.overview()
  const greetingGroup = overview.lineGroups.find((g) => g.name === 'greeting')
  assertEq(greetingGroup.disabled, true, '整组停用标 disabled')
  assertDeepEqSafe(greetingGroup.builtinLines, ['内置问候'], '整组停用后总览内置列表仍完整')
  assertDeepEqSafe(greetingGroup.userLines, ['用户问候'], '用户句照常展示')
  const restored = await store.restoreOverrides('lines')
  assertDeepEqSafe(restored.kinds.lines.disabledGroups, [], '恢复后无停用组')
  assertDeepEqSafe(restored.kinds.lines.disabledLines, [], '恢复后无停用句')
  merged = await store.mergeForEngine()
  assertEq(merged.lines.groups.greeting.includes('内置问候'), true, '恢复后内置句回到引擎')
  assertEq(merged.lines.groups.care.includes('内置关心'), true, '恢复后单句停用也解除')
})

await suite.check('K15', '单卡话题 upsert：保留文件其他卡/额外字段，同 id 覆盖内置，坏卡拒入', async () => {
  const root = mkRoot('k15')
  const { store } = makeStore(root)
  mkdirSync(store.paths().dir, { recursive: true })
  writeFileSync(
    store.paths().topicsPath,
    JSON.stringify({
      schema: 'fish-topics/2',
      version: '9.9',
      extraTop: '保留我',
      topics: [{ id: 'other', sample: '别的卡', custom: '自定义字段' }]
    }),
    'utf8'
  )
  const added = await store.updateUserTopic({ id: 'new-topic', sample: '新卡', hooks: ['钩子'] })
  assertEq(added.id, 'new-topic', '返回写入的卡')
  let onDisk = JSON.parse(readFileSync(store.paths().topicsPath, 'utf8'))
  assertEq(onDisk.schema, 'fish-topics/2', '文件原有 schema 保留')
  assertEq(onDisk.version, '9.9', '文件原有 version 保留')
  assertEq(onDisk.extraTop, '保留我', '文件级额外字段保留')
  assertEq(onDisk.topics[0].custom, '自定义字段', '其他卡的额外字段保留')
  assertEq(onDisk.topics.length, 2, '按 id upsert 追加新卡')
  const edited = await store.updateUserTopic({ id: 'new-topic', sample: '改后的卡' })
  assertEq(edited.sample, '改后的卡', '同 id 编辑生效')
  onDisk = JSON.parse(readFileSync(store.paths().topicsPath, 'utf8'))
  assertEq(onDisk.topics.length, 2, '编辑不重复追加')
  const override = await store.updateUserTopic({ id: 'builtin-a', sample: '用户接管的内置A' })
  assertEq(override.id, 'builtin-a', '同 id 覆盖内置卡')
  const merged = await store.mergeForEngine()
  const taken = merged.topics.topics.filter((t) => t.id === 'builtin-a')
  assertEq(taken.length, 1, '同 id 覆盖后不重复')
  assertEq(taken[0].sample, '用户接管的内置A', '生效用户版本')
  assertEq(
    (await store.overview()).topics.find((t) => t.id === 'builtin-a').source,
    'user',
    '总览标 user'
  )
  await expectBadPayload(() => store.updateUserTopic({ id: 'bad' }), '没有 sample/hooks 的卡')
  assertEq(
    JSON.parse(readFileSync(store.paths().topicsPath, 'utf8')).topics.length,
    3,
    '坏卡不写盘'
  )
})

await suite.check('K16', '用户生活卡：新增/同 id 覆盖/删除，合并顺序内置在前', async () => {
  const root = mkRoot('k16')
  const { store } = makeStoreWithLife(root)
  const card = await store.upsertUserLifeCard({ id: 'user-life-1', activity: '用户活动' })
  assertEq(card.id, 'user-life-1', '返回写入卡')
  assertEq(card.weight, 1, '缺省 weight 回落 1')
  assertDeepEqSafe(
    card.slots,
    ['morning', 'noon', 'afternoon', 'evening', 'night'],
    '缺省 slots 全时段'
  )
  let merged = await store.mergeLifeDeck()
  assertEq(merged.cards.length, 3, '内置 2 + 用户 1')
  assertEq(merged.cards[merged.cards.length - 1].id, 'user-life-1', '用户新卡追加在末尾')
  await store.upsertUserLifeCard({ id: 'life-builtin-a', activity: '用户覆盖A', mood: '得意' })
  merged = await store.mergeLifeDeck()
  const overridden = merged.cards.filter((c) => c.id === 'life-builtin-a')
  assertEq(overridden.length, 1, '同 id 覆盖不重复')
  assertEq(overridden[0].activity, '用户覆盖A', '生效用户版本')
  assertEq(merged.cards.length, 3, '覆盖不增加总数')
  const listed = await store.listLifeCards()
  assertEq(listed.find((c) => c.id === 'user-life-1').source, 'user', '用户卡标 user')
  assertEq(listed.find((c) => c.id === 'life-builtin-b').source, 'builtin', '未覆盖内置卡标 builtin')
  assertEq(
    listed.some((c) => c.id === 'life-builtin-a' && c.source === 'builtin'),
    false,
    '被用户覆盖的内置卡不重复列'
  )
  assertEq(await store.deleteUserLifeCard('user-life-1'), true, '删除用户卡命中')
  assertEq(await store.deleteUserLifeCard('user-life-1'), false, '再删未命中')
  merged = await store.mergeLifeDeck()
  assertEq(merged.cards.some((c) => c.id === 'user-life-1'), false, '删除后不在合并结果')
  await expectBadPayload(
    () => store.upsertUserLifeCard({ id: 'no-activity' }),
    '缺 activity 的生活卡'
  )
})

await suite.check('K17', '停用内置生活卡：合并过滤、总览标 disabled、恢复回来；未注入 loader 退化用户卡', async () => {
  const root = mkRoot('k17')
  const { store } = makeStoreWithLife(root)
  const overrides = await store.setLifeCardDisabled('life-builtin-a', true)
  assertDeepEqSafe(overrides.kinds.lifeCards.disabledIds, ['life-builtin-a'], '停用清单记录生活卡 id')
  let merged = await store.mergeLifeDeck()
  assertEq(merged.cards.some((c) => c.id === 'life-builtin-a'), false, '停用后内置卡不进合并')
  assertEq(merged.cards.some((c) => c.id === 'life-builtin-b'), true, '其他内置卡不受影响')
  const listed = await store.listLifeCards()
  const item = listed.find((c) => c.id === 'life-builtin-a')
  assertEq(Boolean(item), true, '停用内置卡仍在总览')
  assertEq(item.disabled, true, '总览标 disabled')
  await store.restoreOverrides('lifeCards')
  merged = await store.mergeLifeDeck()
  assertEq(merged.cards.some((c) => c.id === 'life-builtin-a'), true, '恢复后回到合并结果')
  // 未注入 loadBuiltinLife：生活卡合并退化为「只有用户卡」，不抛错
  const bare = createContentStore({ dataDir: root, loadBuiltin: async () => builtinDeck() })
  await bare.upsertUserLifeCard({ id: 'only-user-life', activity: '只有用户卡' })
  const bareMerged = await bare.mergeLifeDeck()
  assertDeepEqSafe(bareMerged.cards.map((c) => c.id), ['only-user-life'], '无内置 loader 时只有用户卡')
})

await suite.check('K18', '停用清单落盘/重读/坏文件回落；importOverrides 往返与宽容解析', async () => {
  const root = mkRoot('k18')
  const { store } = makeStore(root)
  await store.setTopicDisabled('builtin-a', true)
  await store.setLineDisabled('care', '内置关心', true)
  await store.setGroupDisabled('greeting', true)
  const file = store.paths().overridesPath
  assertEq(existsSync(file), true, '清单已落盘')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assertEq(onDisk.schema, 'fish-content-overrides/1', '清单 schema 固定')
  assertDeepEqSafe(onDisk.kinds.topics.disabledIds, ['builtin-a'], '话题停用落盘')
  assertDeepEqSafe(onDisk.kinds.lines.disabledGroups, ['greeting'], '整组停用落盘')
  assertDeepEqSafe(
    onDisk.kinds.lines.disabledLines,
    [{ group: 'care', line: '内置关心' }],
    '单句停用落盘'
  )
  // 新 store 实例重读同一数据目录：停用继续生效（不依赖进程内缓存）
  const reloaded = createContentStore({ dataDir: root, loadBuiltin: async () => builtinDeck() })
  const reread = await reloaded.overrides()
  assertDeepEqSafe(reread.kinds.topics.disabledIds, ['builtin-a'], '重读话题停用')
  const merged = await reloaded.mergeForEngine()
  assertEq(merged.topics.topics.some((t) => t.id === 'builtin-a'), false, '重读后引擎仍过滤')
  assertEq(merged.lines.groups.greeting, undefined, '重读后整组停用仍生效')
  // 坏清单文件：回落空清单，内置全部可见，不抛错
  writeFileSync(file, '{ 坏 json', 'utf8')
  const broken = createContentStore({ dataDir: root, loadBuiltin: async () => builtinDeck() })
  const empty = await broken.overrides()
  assertDeepEqSafe(empty.kinds.topics.disabledIds, [], '坏文件回落空话题清单')
  assertDeepEqSafe(empty.kinds.lines.disabledGroups, [], '坏文件回落空组清单')
  assertDeepEqSafe(empty.kinds.lines.disabledLines, [], '坏文件回落空句清单')
  assertEq((await broken.mergeForEngine()).topics.topics.length, 2, '坏清单不阻断内置合并')
  // importOverrides：宽容解析（缺字段/坏值回落空清单）后原子落盘，不抛错
  const exported = {
    schema: 'fish-content-overrides/1',
    version: '1.0.0',
    kinds: {
      topics: { disabledIds: ['builtin-b'] },
      lines: { disabledGroups: ['care'], disabledLines: [] },
      lifeCards: { disabledIds: ['life-builtin-a'] }
    }
  }
  const imported = await store.importOverrides(exported)
  assertDeepEqSafe(imported.kinds.topics.disabledIds, ['builtin-b'], '导入后清单生效')
  assertDeepEqSafe(imported.kinds.lifeCards.disabledIds, ['life-builtin-a'], '生活卡停用一起导入')
  assertDeepEqSafe((await store.overrides()).kinds.lines.disabledGroups, ['care'], '导入原子落盘并可重读')
  const tolerant = await store.importOverrides(null)
  assertDeepEqSafe(tolerant.kinds.topics.disabledIds, [], '坏入参按空清单回落（不抛错）')
  assertDeepEqSafe((await store.overrides()).kinds.lines.disabledLines, [], '坏入参落盘为空清单')
})

await suite.check('K19', 'importLifeDeck 合并计数/重复导入/上限 200/空与非法拒入', async () => {
  const root = mkRoot('k19')
  const { store } = makeStoreWithLife(root)
  const first = await store.importLifeDeck({
    cards: [
      { id: 'user-1', activity: '活动一' },
      { id: 'life-builtin-a', activity: '覆盖A' }
    ]
  })
  assertEq(first.added, 2, '用户库新增 2 张（覆盖内置的那张在用户库也是新增）')
  assertEq(first.updated, 0, '用户库首次导入无同 id 更新')
  assertEq(first.total, 2, '用户库 2 张')
  const merged = await store.mergeLifeDeck()
  assertEq(merged.cards.length, 3, '内置 2 + 用户 2（覆盖 1 同 id）')
  const second = await store.importLifeDeck({ cards: [{ id: 'user-1', activity: '活动一改' }] })
  assertEq(second.added, 0, '再次导入不重复新增')
  assertEq(second.updated, 1, '再次导入按 id 更新')
  await expectBadPayload(() => store.importLifeDeck({ cards: [] }), '空生活卡')
  await expectBadPayload(
    () => store.importLifeDeck({ cards: [{ id: 'no-activity' }] }),
    '无 activity 的卡'
  )
  // 上限 200：恰好 200 可以，201 拒入且不改写文件
  const root2 = mkRoot('k19-limit')
  const { store: limited } = makeStoreWithLife(root2)
  const many = (count, prefix) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, activity: `活动${i}` }))
  const ok = await limited.importLifeDeck({ cards: many(200, 'cap') })
  assertEq(ok.total, 200, `恰好 ${USER_LIFE_CARD_MAX} 张可导入`)
  const before = readFileSync(limited.paths().lifeCardsPath, 'utf8')
  await expectBadPayload(
    () => limited.importLifeDeck({ cards: many(201, 'over') }),
    `超生活卡上限 ${USER_LIFE_CARD_MAX}`
  )
  assertEq(readFileSync(limited.paths().lifeCardsPath, 'utf8'), before, '超限拒入不改写文件')
})

await suite.check('K20', 'contentLibrary facade：kinds/list/upsert/remove/disable/restore 统一三类语义', async () => {
  const root = mkRoot('k20')
  const { store } = makeStoreWithLife(root)
  const library = createContentLibrary({ store })
  const kinds = library.kinds()
  assertDeepEqSafe(kinds.map((k) => k.kind), ['topics', 'lines', 'lifeCards'], '三种 kind 固定顺序')
  assertDeepEqSafe(kinds.map((k) => k.label), ['话题', '台词', '生活卡'], '中文标签')
  const topics = await library.list('topics')
  assertEq(topics.some((t) => t.id === 'builtin-a' && t.source === 'builtin'), true, 'topics 列表带 source')
  const lines = await library.list('lines')
  const builtinLine = lines.find((l) => l.group === 'greeting' && l.text === '内置问候')
  assertEq(builtinLine.key, 'greeting::内置问候', 'lines key 为 group::text')
  assertEq(builtinLine.source, 'builtin', '内置句标 builtin')
  const appended = await library.upsert('lines', { group: 'greeting', text: 'facade 新句' })
  assertEq(appended.added, true, '追加新台词')
  const again = await library.upsert('lines', { group: 'greeting', text: 'facade 新句' })
  assertEq(again.added, false, '重复追加不重复写入')
  assertEq(await library.remove('lines', 'greeting::facade 新句'), true, '删除用户句')
  assertEq(await library.remove('lines', 'greeting::facade 新句'), false, '再删未命中')
  assertEq(await library.remove('topics', 'builtin-a'), false, '内置话题不可删')
  const afterDisableLine = await library.disable('lines', 'care::内置关心', true)
  assertDeepEqSafe(
    afterDisableLine.kinds.lines.disabledLines,
    [{ group: 'care', line: '内置关心' }],
    '单句停用'
  )
  const disabledLines = await library.list('lines')
  assertEq(disabledLines.find((l) => l.key === 'care::内置关心').disabled, true, 'list 反映单句停用')
  const afterGroup = await library.disable('lines', 'greeting::', true)
  assertDeepEqSafe(afterGroup.kinds.lines.disabledGroups, ['greeting'], 'group:: 表示整组停用')
  const afterTopic = await library.disable('topics', 'builtin-a', true)
  assertEq(afterTopic.kinds.topics.disabledIds.includes('builtin-a'), true, '话题按 id 停用')
  const afterLife = await library.disable('lifeCards', 'life-builtin-a', true)
  assertEq(afterLife.kinds.lifeCards.disabledIds.includes('life-builtin-a'), true, '生活卡按 id 停用')
  const life = await library.list('lifeCards')
  assertEq(life.find((c) => c.id === 'life-builtin-a').disabled, true, 'lifeCards 列表标 disabled')
  const topicCard = await library.upsert('topics', { id: 'facade-topic', sample: 'facade 话题' })
  assertEq(topicCard.id, 'facade-topic', 'topics upsert 走 updateUserTopic')
  const lifeCard = await library.upsert('lifeCards', { id: 'facade-life', activity: 'facade 活动' })
  assertEq(lifeCard.id, 'facade-life', 'lifeCards upsert 走 upsertUserLifeCard')
  await expectBadPayload(
    () => library.upsert('lines', { group: 'Bad Name', text: '句' }),
    '非法台词组名'
  )
  await expectBadPayload(() => library.disable('lines', 'greeting', true), '缺 :: 的台词 key')
  const restored = await library.restore()
  assertDeepEqSafe(restored.kinds.topics.disabledIds, [], 'restore() 恢复全部话题')
  assertDeepEqSafe(restored.kinds.lifeCards.disabledIds, [], 'restore() 恢复全部生活卡')
  assertDeepEqSafe((await library.overrides()).kinds.lines.disabledLines, [], 'restore() 恢复台词')
  assertEq(await library.remove('lifeCards', 'facade-life'), true, '删除用户生活卡')
})

function assertDeepEqSafe(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}（实际 ${JSON.stringify(actual)}）`)
}

const result = suite.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-character-content.json'), result)
for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}
if (!ok) process.exit(1)
