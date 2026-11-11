// test/character-content.accept.mjs —— 用户主动消息语料库（话题/台词查看/导入/删除）验收
//
// 纯 Node（零 npm 依赖），esbuild 打真源码 electron/main/character/contentStore.ts
// （连带真 contentEngine 解析器与 types 错误码），临时 dataDir 落盘，不 mock 被测逻辑。
// 覆盖：空目录总览 / 话题导入计数与落盘 / 同 id 接管内置与删除回落 / 空非法导入拒入 /
//       台词新组追加去重与合并顺序 / 删除（含内置拒删、非法下标）/ reset 三范围 /
//       坏 JSON 回落不阻断 / 解析白名单与通道命名 / 上限护栏 / 导出与引擎合并一致。

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
const {
  createContentStore,
  CHARACTER_CONTENT_CHANNELS,
  USER_TOPIC_MAX,
  USER_LINE_GROUPS_MAX,
  USER_TOPICS_FILE,
  USER_LINES_FILE
} = storeMod

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
      { id: 'user-1', title: '用户一', sample: '用户样例一', hooks: ['用户钩子'] },
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
  const overview = await store.overview()
  assertEq(overview.topics.filter((t) => t.source === 'user').length, 2, '总览 2 张标 user')
  const merged = await store.mergeForEngine()
  assertEq(merged.topics.topics.length, 4, '引擎合并 2 内置 + 2 用户')
  assertEq(merged.topics.topics.some((t) => t.id === 'user-1'), true, '用户卡进引擎')
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
