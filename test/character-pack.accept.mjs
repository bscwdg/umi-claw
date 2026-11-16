// test/character-pack.accept.mjs —— 大肥鱼统一资料包 v1（人格/知识/主动消息/记忆）验收
//
// 纯 Node（零 npm 依赖，esbuild 只作为 CLI 被调用），打真源码：
//   electron/main/character/packBundle.ts（连带真 persona/knowledgeImport/memoryAdmin/backupBundle）
//   electron/main/character/contentStore.ts（话题/台词合并语义，验收不 mock）
// 覆盖：合法目录包全量导入计数 / persona 写入+旧人格备份+AGENTS 边界段 / 知识类别与记忆 kind 白名单 /
//       话题同 id 覆盖与台词去重合并 / 关系与日记同名不覆盖 / zip-slip 与非法条目拒绝 /
//       数量与单文件超限、NUL、坏 schema、缺 manifest 拒绝 / 合法 zip round-trip /
//       snapshotCurrent→readPackDir→再导入 round-trip（含人格未初始化时跳过不失败）/
//       部分失败如实报告（未配置 vault 时知识失败但话题照常写入，或全失败抛错）/ 通道命名。
//
// 恶意 zip 用「存储模式」手写最小 zip（local header + central directory + EOCD + CRC32），
// 与 sticker.accept.mjs 同口径：验收脚本不能 import adm-zip（零 npm 依赖）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  tmpDir,
  writeJson
} from './_lib.mjs'

const packMod = await import(
  pathToFileURL(
    // adm-zip 有运行时 require 内置模块的写法，打进 ESM 会炸；标 external 由 Node 按 CJS 加载
    bundleEntry('electron/main/character/packBundle.ts', 'character-pack-bundle.mjs', {
      externals: ['adm-zip']
    })
  )
)
const contentMod = await import(
  pathToFileURL(bundleEntry('electron/main/character/contentStore.ts', 'character-pack-content.mjs'))
)

const {
  CHARACTER_PACK_CHANNELS,
  PACK_SCHEMA,
  PACK_MAX_KNOWLEDGE_FILES,
  PACK_MAX_TOPICS,
  PACK_MAX_ENTRIES,
  PACK_MAX_MANIFEST_BYTES,
  readPackDir,
  readPackZip,
  snapshotCurrent,
  importPack
} = packMod
const { createContentStore } = contentMod

const suite = new Recorder('character-pack')
const roots = []

function mkRoot(name) {
  const root = join(tmpDir, `character-pack-${name}-${process.pid}-${Date.now()}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function writeFileRel(root, rel, data) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.isBuffer(data) ? data : String(data), 'utf8')
}

function readFileRel(root, rel) {
  return readFileSync(join(root, rel), 'utf8')
}

function existsRel(root, rel) {
  return existsSync(join(root, rel))
}

/** 内置只读语料夹具：用于验证「导出走合并后 deck」「导入走 contentStore 合并语义」 */
function builtinDeck() {
  return {
    topics: {
      schema: 'fish-topics/1',
      version: '1.0.0',
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
        }
      ]
    },
    lines: { schema: 'fish-lines/1', version: '1.0.0', groups: { greeting: ['内置问候'] } }
  }
}

function makeStore(dataDir) {
  return createContentStore({ dataDir, loadBuiltin: async () => builtinDeck() })
}

function makeEnv(root) {
  const env = {
    workspaceDir: join(root, 'workspace'),
    vaultDir: join(root, 'vault'),
    dataDir: join(root, 'data')
  }
  mkdirSync(env.workspaceDir, { recursive: true })
  mkdirSync(env.vaultDir, { recursive: true })
  mkdirSync(env.dataDir, { recursive: true })
  return env
}

function manifestJson(overrides = {}) {
  return JSON.stringify(
    {
      schema: PACK_SCHEMA,
      name: '验收资料包',
      createdAt: '2026-01-01T00:00:00.000Z',
      source: 'accept',
      targets: ['persona', 'knowledge', 'proactive', 'memory'],
      ...overrides
    },
    null,
    2
  )
}

function personaJson(files) {
  return JSON.stringify(
    { version: 1, herName: '大肥鱼', exportedAt: 1760000000000, files },
    null,
    2
  )
}

function topicDeck(topics) {
  return JSON.stringify({ schema: 'fish-topics/1', version: '1.0.0', topics }, null, 2)
}

function lineDeck(groups) {
  return JSON.stringify({ schema: 'fish-lines/1', version: '1.0.0', groups }, null, 2)
}

/** 构造一个覆盖四类内容的合法目录包 */
function makeFullPackDir(root) {
  const packDir = join(root, 'pack-full')
  writeFileRel(packDir, 'manifest.json', manifestJson())
  writeFileRel(
    packDir,
    'persona.json',
    personaJson({
      'SOUL.md': '# SOUL 导入\n本鱼新灵魂',
      'USER.md': '# USER\n主人'
    })
  )
  writeFileRel(
    packDir,
    'proactive/topics.json',
    topicDeck([
      { id: 'pack-topic-1', sample: '导入话题一', hooks: ['钩子一'] },
      { id: 'pack-topic-2', sample: '导入话题二' }
    ])
  )
  writeFileRel(
    packDir,
    'proactive/lines.json',
    lineDeck({ greeting: ['导入问候', '内置问候'], 'pack-greeting': ['专属问候'] })
  )
  writeFileRel(packDir, 'knowledge/世界书/世界一.md', '世界一正文')
  writeFileRel(
    packDir,
    'knowledge/角色卡/角色一.md',
    '---\ntitle: 旧标题\ntags: [旧]\n---\n\n角色一正文'
  )
  writeFileRel(packDir, 'knowledge/关系/约定/知识约定.md', '知识约定正文')
  writeFileRel(packDir, 'knowledge/未知类别/坏.md', '未知类别应被忽略')
  writeFileRel(packDir, 'memory/relations/约定/记忆约定.md', '约定正文')
  writeFileRel(packDir, 'memory/relations/大事记/大事记一.md', '大事记正文')
  writeFileRel(packDir, 'memory/relations/未知/坏.md', '未知 kind 应被忽略')
  writeFileRel(packDir, 'memory/diaries/2026-01-01.md', '日记一正文')
  writeFileRel(packDir, 'memory/diaries/2026-02-30.md', '非法日期应被忽略')
  writeFileRel(packDir, 'unknown/other.bin', '未知条目应被忽略')
  return packDir
}

function expectBadPayload(fn, label) {
  let error = null
  try {
    fn()
  } catch (e) {
    error = e
  }
  assert(error, `${label} 必须抛错`)
  assertEq(error?.code, 'CHARACTER_BAD_PAYLOAD', `${label} 错误码为 BAD_PAYLOAD`)
}

async function expectBadPayloadAsync(fn, label) {
  let error = null
  try {
    await fn()
  } catch (e) {
    error = e
  }
  assert(error, `${label} 必须抛错`)
  assertEq(error?.code, 'CHARACTER_BAD_PAYLOAD', `${label} 错误码为 BAD_PAYLOAD`)
}

// ── 手写存储模式 zip（只用于恶意/非法条目用例；合法 zip 导入也用同一写器）────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const dataBuf = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? '', 'utf8')
    const crc = crc32(dataBuf)
    // 可选伪造字段（对抗审查 P2-1）：本地头/中央目录的大小与 CRC 允许被测试单独改写
    const localCrc = item.localCrc ?? crc
    const localSize = item.localSize ?? dataBuf.length
    const localCompressed = item.localCompressed ?? dataBuf.length
    const centralCrc = item.crc ?? crc
    const centralSize = item.centralSize ?? dataBuf.length
    const centralCompressed = item.centralCompressed ?? dataBuf.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(localCrc, 14)
    local.writeUInt32LE(localSize, 18)
    local.writeUInt32LE(localCompressed, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const localOffset = offset
    locals.push(local, nameBuf, dataBuf)
    offset += local.length + nameBuf.length + dataBuf.length
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(centralCrc, 16)
    central.writeUInt32LE(centralSize, 20)
    central.writeUInt32LE(centralCompressed, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(localOffset, 42)
    centrals.push(central, nameBuf)
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(localBuf.length, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([localBuf, centralBuf, end])
}

// ── P1：合法目录包全量导入计数与四处落盘 ────────────────────────────────────
await suite.check('P1', '合法目录包：四类内容全部导入，计数与落盘位置正确', async () => {
  const root = mkRoot('p1')
  const packDir = makeFullPackDir(root)
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)

  const plan = readPackDir(packDir)
  assertEq(plan.manifest.schema, PACK_SCHEMA, 'manifest schema 解析正确')
  assertEq(plan.persona.files['SOUL.md'], '# SOUL 导入\n本鱼新灵魂', 'persona SOUL 读入')
  assertEq(plan.topics.topics.length, 2, '话题 2 张')
  assertEq(Object.keys(plan.lines.groups).length, 2, '台词 2 组')
  assertEq(plan.knowledge.length, 3, '知识 3 篇（未知类别已忽略）')
  assertEq(plan.relations.length, 2, '关系 2 篇（未知 kind 已忽略）')
  assertEq(plan.diaries.length, 1, '日记 1 篇（非法日期已忽略）')
  assert(
    plan.warnings.some((w) => w.includes('未知知识类别')),
    `未知知识类别要有 warning（实际 ${JSON.stringify(plan.warnings)}）`
  )
  assert(
    plan.warnings.some((w) => w.includes('非法日记日期')),
    `非法日记日期要有 warning（实际 ${JSON.stringify(plan.warnings)}）`
  )

  const result = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan,
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(result.counts.persona.length, 2, '人格写入 2 个槽位')
  assertEq(result.counts.topics.added, 2, '话题新增 2 张')
  assertEq(result.counts.topics.updated, 0, '话题更新 0 张')
  assertEq(result.counts.lines.groupsAdded, 2, '台词新组 2 组')
  assertEq(result.counts.lines.linesAdded, 3, '台词新增 3 句')
  assertEq(result.counts.knowledge, 3, '知识写入 3 篇')
  assertEq(result.counts.relations, 2, '关系写入 2 篇')
  assertEq(result.counts.diaries, 1, '日记写入 1 篇')
  assertEq(result.errors.length, 0, `不应有失败项（实际 ${JSON.stringify(result.errors)}）`)
  assertEq(readFileRel(env.workspaceDir, 'SOUL.md'), '# SOUL 导入\n本鱼新灵魂', 'SOUL.md 落 workspace')
  assert(existsRel(env.vaultDir, '大肥鱼/世界书/世界一.md'), '知识落 大肥鱼/世界书/')
  assert(existsRel(env.vaultDir, '大肥鱼/角色卡/角色一.md'), '知识落 大肥鱼/角色卡/')
  assert(existsRel(env.vaultDir, '大肥鱼/关系/约定/知识约定.md'), '知识落 大肥鱼/关系/约定/')
  assert(existsRel(env.vaultDir, '大肥鱼/关系/约定/记忆约定.md'), '关系记忆落 大肥鱼/关系/约定/')
  assert(existsRel(env.vaultDir, '大肥鱼/关系/大事记/大事记一.md'), '关系记忆落 大肥鱼/关系/大事记/')
  assertEq(readFileRel(env.workspaceDir, 'memory/2026-01-01.md'), '日记一正文', '日记落 workspace memory/')
  assert(
    !existsRel(env.vaultDir, '大肥鱼/世界书/坏.md'),
    '未知类别的知识文件不落盘'
  )

  // 知识笔记带新 frontmatter；包内旧 frontmatter 被剥掉，不会两层 --- 叠加
  const roleNote = readFileRel(env.vaultDir, '大肥鱼/角色卡/角色一.md')
  assert(roleNote.includes('tags: [大肥鱼, 大肥鱼/角色卡]'), '知识笔记带类别 tags')
  assert(!roleNote.includes('title: 旧标题'), '旧 frontmatter 已剥掉（不重复叠加）')
  assert(roleNote.includes('角色一正文'), '知识正文保留')

  // 用户语料真进了 contentStore（合并在引擎读取时生效）
  const merged = await store.mergeForEngine()
  assert(
    merged.topics.topics.some((t) => t.id === 'pack-topic-1'),
    '导入的话题进入合并后内容包'
  )
  assertEq(merged.lines.groups.greeting[0], '内置问候', '合并后台词内置句仍在前')
  assert(merged.lines.groups.greeting.includes('导入问候'), '用户台词追加进同名组')
})

// ── P2：persona 写入 + 旧人格备份 + AGENTS 边界硬段 ─────────────────────────
await suite.check('P2', '人格导入：覆盖 SOUL、旧文件进 .persona-backup、AGENTS 带边界硬段', async () => {
  const root = mkRoot('p2')
  const env = makeEnv(root)
  const packDir = join(root, 'pack-persona')
  writeFileRel(packDir, 'manifest.json', manifestJson({ targets: ['persona'] }))
  writeFileRel(
    packDir,
    'persona.json',
    personaJson({
      'SOUL.md': '# 新 SOUL',
      'AGENTS.md': '# 导入 AGENTS\n用户自定义段'
    })
  )
  writeFileRel(env.workspaceDir, 'SOUL.md', '# 旧 SOUL')
  writeFileRel(env.workspaceDir, 'AGENTS.md', '# 旧 AGENTS')
  writeFileRel(
    env.workspaceDir,
    '.fish-managed.json',
    JSON.stringify({ version: 1, files: { 'SOUL.md': 'oldhash' } })
  )
  const store = makeStore(env.dataDir)
  const plan = readPackDir(packDir)
  const result = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan,
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    },
    now: 1760000000123
  })
  assertEq(result.counts.persona.length, 2, '两个槽位写入')
  assertEq(readFileRel(env.workspaceDir, 'SOUL.md'), '# 新 SOUL', 'SOUL 被导入内容覆盖')
  assert(result.personaBackupDir, '返回旧人格备份目录')
  assertEq(
    readFileRel(env.workspaceDir, '.persona-backup/1760000000123/SOUL.md'),
    '# 旧 SOUL',
    '旧 SOUL 备份在 .persona-backup/<ts>/'
  )
  const agents = readFileRel(env.workspaceDir, 'AGENTS.md')
  assert(agents.includes('<!-- fish:managed:boundary:start -->'), 'AGENTS 带边界硬段 start')
  assert(agents.includes('<!-- fish:managed:boundary:end -->'), 'AGENTS 带边界硬段 end')
  assert(agents.includes('不假装人类'), '边界硬段内容存在（不能随人格包被移除）')
  const manifest = JSON.parse(readFileRel(env.workspaceDir, '.fish-managed.json'))
  assert(!('SOUL.md' in manifest.files), '导入槽位从受管 manifest 删除（视为用户手改）')
})

// ── P3：话题同 id 覆盖 / 台词组去重 / 二次导入幂等 ──────────────────────────
await suite.check('P3', '话题同 id 覆盖、台词组去重追加、二次导入幂等', async () => {
  const root = mkRoot('p3')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  await store.importTopics({ topics: [{ id: 'pack-topic-1', sample: '旧样例' }] })
  const packDir = makeFullPackDir(root)

  const first = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan: readPackDir(packDir),
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(first.counts.topics.added, 1, '新增 1 张（pack-topic-2）')
  assertEq(first.counts.topics.updated, 1, '更新 1 张（同 id pack-topic-1）')
  const overview = await store.overview()
  const replaced = overview.topics.find((t) => t.id === 'pack-topic-1' && t.source === 'user')
  assertEq(replaced.sample, '导入话题一', '同 id 用户卡被资料包内容接管')

  const second = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan: readPackDir(packDir),
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(second.counts.topics.added, 0, '二次导入话题新增 0')
  assertEq(second.counts.topics.updated, 2, '二次导入话题更新 2')
  assertEq(second.counts.lines.linesAdded, 0, '台词语料已存在，二次导入新增 0（去重）')
})

// ── P4：关系/日记同名不覆盖 ────────────────────────────────────────────────
await suite.check('P4', '关系同名加序号不覆盖；日记同日跳过并 warning', async () => {
  const root = mkRoot('p4')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  writeFileRel(env.vaultDir, '大肥鱼/关系/约定/记忆约定.md', '旧关系正文')
  writeFileRel(env.workspaceDir, 'memory/2026-01-01.md', '旧日记正文')
  const result = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan: readPackDir(makeFullPackDir(root)),
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(
    readFileRel(env.vaultDir, '大肥鱼/关系/约定/记忆约定.md'),
    '旧关系正文',
    '旧关系笔记未被覆盖'
  )
  assertEq(
    readFileRel(env.vaultDir, '大肥鱼/关系/约定/记忆约定-2.md'),
    '约定正文',
    '导入关系改名加序号'
  )
  assertEq(result.counts.relations, 2, '两篇关系都写入（一篇加序号）')
  assertEq(
    readFileRel(env.workspaceDir, 'memory/2026-01-01.md'),
    '旧日记正文',
    '同日日记不被覆盖'
  )
  assertEq(result.counts.diariesSkipped, 1, '同日日记计入跳过')
  assertEq(result.counts.diaries, 0, '包内唯一日记与已有同日，跳过数=1、写入数=0')
  assert(
    result.warnings.some((w) => w.includes('已存在，已跳过')),
    '同日跳过要有 warning'
  )
})

// ── P5：zip-slip / 非法条目名拒绝（反斜杠先规范化；合法反斜杠不再拒，见 P13） ──
await suite.check('P5', 'zip-slip、绝对路径、盘符、反斜杠穿越一律拒绝（不解压到磁盘）', async () => {
  const root = mkRoot('p5')
  const cases = [
    { name: '../evil.md', label: '父目录穿越' },
    { name: 'knowledge/世界书/../../evil.md', label: '中段穿越' },
    { name: '..\\evil.md', label: '反斜杠父目录穿越' },
    { name: 'C:/evil.md', label: '盘符绝对路径' },
    { name: 'C:\\evil.md', label: '反斜杠盘符路径' },
    { name: '/etc/evil.md', label: '根绝对路径' }
  ]
  for (const item of cases) {
    const zipPath = join(root, `slip-${crc32(Buffer.from(item.name))}.zip`)
    writeFileSync(
      zipPath,
      makeZip([
        { name: item.name, data: 'evil' },
        { name: 'manifest.json', data: manifestJson() }
      ])
    )
    expectBadPayload(() => readPackZip(zipPath), item.label)
  }
  assertEq(existsRel(root, 'evil.md'), false, '拒绝后没有在磁盘落任何文件')
})

// ── P6：超限 / NUL / 坏 schema / 缺 manifest 拒绝 ─────────────────────────
await suite.check('P6', '数量与单文件超限、NUL、坏 schema、缺 manifest 均拒绝', async () => {
  const root = mkRoot('p6')
  // 单文件 >512KB
  const bigDir = join(root, 'big')
  writeFileRel(bigDir, 'manifest.json', manifestJson())
  writeFileRel(bigDir, 'knowledge/世界书/大.md', 'x'.repeat(513 * 1024))
  expectBadPayload(() => readPackDir(bigDir), '单文件 513KB')

  // NUL
  const nulDir = join(root, 'nul')
  writeFileRel(nulDir, 'manifest.json', manifestJson())
  writeFileRel(nulDir, 'knowledge/世界书/nul.md', 'a\u0000b')
  expectBadPayload(() => readPackDir(nulDir), '知识文件含 NUL')

  // 话题 201 张
  const topicsDir = join(root, 'topics')
  writeFileRel(topicsDir, 'manifest.json', manifestJson())
  writeFileRel(
    topicsDir,
    'proactive/topics.json',
    topicDeck(Array.from({ length: PACK_MAX_TOPICS + 1 }, (_, i) => ({ id: `t-${i}`, sample: `样${i}` })))
  )
  expectBadPayload(() => readPackDir(topicsDir), `话题超过 ${PACK_MAX_TOPICS} 张`)

  // 知识 301 篇
  const manyDir = join(root, 'many')
  writeFileRel(manyDir, 'manifest.json', manifestJson())
  for (let i = 0; i < PACK_MAX_KNOWLEDGE_FILES + 1; i += 1) {
    writeFileRel(manyDir, `knowledge/世界书/k${i}.md`, `正文${i}`)
  }
  expectBadPayload(() => readPackDir(manyDir), `知识超过 ${PACK_MAX_KNOWLEDGE_FILES} 篇`)

  // 坏 schema
  const schemaDir = join(root, 'schema')
  writeFileRel(schemaDir, 'manifest.json', manifestJson({ schema: 'other-pack/1' }))
  writeFileRel(schemaDir, 'proactive/topics.json', topicDeck([{ id: 'a', sample: 'a' }]))
  expectBadPayload(() => readPackDir(schemaDir), 'manifest schema 不符')

  // 缺 manifest
  const noManifest = join(root, 'nomanifest')
  writeFileRel(noManifest, 'proactive/topics.json', topicDeck([{ id: 'a', sample: 'a' }]))
  expectBadPayload(() => readPackDir(noManifest), '缺 manifest')

  // 空包（有 manifest 但无任何内容）
  const emptyDir = join(root, 'empty')
  writeFileRel(emptyDir, 'manifest.json', manifestJson())
  expectBadPayload(() => readPackDir(emptyDir), '没有任何可导入内容')
})

// ── P7：合法 zip round-trip ───────────────────────────────────────────────
await suite.check('P7', '合法 zip：readPackZip 解析 → 导入计数与目录包一致', async () => {
  const root = mkRoot('p7')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  const zipPath = join(root, 'pack.zip')
  const entries = [
    { name: 'manifest.json', data: manifestJson() },
    {
      name: 'persona.json',
      data: personaJson({ 'SOUL.md': '# ZIP SOUL', 'IDENTITY.md': '# ZIP IDENTITY' })
    },
    {
      name: 'proactive/topics.json',
      data: topicDeck([{ id: 'zip-topic', sample: 'ZIP 话题' }])
    },
    { name: 'proactive/lines.json', data: lineDeck({ 'zip-greeting': ['ZIP 台词'] }) },
    { name: 'knowledge/世界书/zip世界.md', data: 'ZIP 世界正文' },
    { name: 'memory/relations/约定/zip约定.md', data: 'ZIP 约定正文' },
    { name: 'memory/diaries/2026-05-20.md', data: 'ZIP 日记' }
  ]
  writeFileSync(zipPath, makeZip(entries))

  const plan = readPackZip(zipPath)
  assertEq(plan.persona.files['IDENTITY.md'], '# ZIP IDENTITY', 'zip persona 读入')
  assertEq(plan.topics.topics[0].id, 'zip-topic', 'zip 话题读入')
  assertEq(plan.knowledge.length, 1, 'zip 知识 1 篇')
  assertEq(plan.relations.length, 1, 'zip 关系 1 篇')
  assertEq(plan.diaries.length, 1, 'zip 日记 1 篇')

  const result = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan,
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(result.counts.persona.length, 2, 'zip 人格 2 槽位')
  assertEq(result.counts.topics.added, 1, 'zip 话题 1 张')
  assertEq(result.counts.lines.groupsAdded, 1, 'zip 台词 1 组')
  assertEq(result.counts.knowledge, 1, 'zip 知识 1 篇')
  assertEq(result.counts.relations, 1, 'zip 关系 1 篇')
  assertEq(result.counts.diaries, 1, 'zip 日记 1 篇')
  assertEq(readFileRel(env.workspaceDir, 'IDENTITY.md'), '# ZIP IDENTITY', 'zip 人格落盘')
  assert(existsRel(env.vaultDir, '大肥鱼/世界书/zip世界.md'), 'zip 知识落盘')
})

// ── P8：部分失败如实报告（未配置 vault）───────────────────────────────────
await suite.check('P8', '部分失败如实报告：未配置 vault 时知识失败但话题照常写入；全失败抛错', async () => {
  const root = mkRoot('p8')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  // 有话题 + 有知识，vault 未配置：话题成功、知识报 errors，不抛错也不谎报知识成功
  const mixed = await importPack({
    workspaceDir: env.workspaceDir,
    plan: readPackDir(makeFullPackDir(root)),
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(mixed.counts.topics.added, 2, '未配置 vault 不影响话题导入')
  assertEq(mixed.counts.knowledge, 0, '知识计数为 0（不谎报成功）')
  assertEq(mixed.counts.relations, 0, '关系计数为 0')
  assertEq(mixed.errors.length, 1, '知识/关系未导入计入 errors')
  assert(mixed.errors[0].includes('Obsidian vault'), 'errors 说明 vault 未配置')

  // 只有知识、无 vault：全失败 → 抛 STORE_IO，不能说成功
  const knowledgeOnly = join(root, 'pack-knowledge-only')
  writeFileRel(knowledgeOnly, 'manifest.json', manifestJson({ targets: ['knowledge'] }))
  writeFileRel(knowledgeOnly, 'knowledge/世界书/只有知识.md', '正文')
  let thrown = null
  try {
    await importPack({
      workspaceDir: env.workspaceDir,
      plan: readPackDir(knowledgeOnly),
      content: {
        importTopics: (raw) => store.importTopics(raw),
        importLines: (raw) => store.importLines(raw)
      }
    })
  } catch (e) {
    thrown = e
  }
  assert(thrown, '全目标失败必须抛错')
  assertEq(thrown.code, 'CHARACTER_STORE_IO', '全失败错误码 STORE_IO')
})

// ── P9：snapshotCurrent → readPackDir → 再导入 round-trip ─────────────────
await suite.check('P9', '导出 round-trip：当前内容→资料包→全新环境再导入，计数一致', async () => {
  const root = mkRoot('p9')
  const src = makeEnv(root)
  const store = makeStore(src.dataDir)
  // 源环境：人格 4 槽位 + workspace 日记
  writeFileRel(src.workspaceDir, 'SOUL.md', '# SOUL 源')
  writeFileRel(src.workspaceDir, 'IDENTITY.md', '# IDENTITY 源')
  writeFileRel(src.workspaceDir, 'AGENTS.md', '# AGENTS 源')
  writeFileRel(src.workspaceDir, 'USER.md', '# USER 源')
  writeFileRel(src.workspaceDir, 'memory/2026-03-03.md', '源日记')
  // 源 vault：知识两类别 + 关系目录/单文件 + vault 日记（workspace 没有的日期）
  writeFileRel(src.vaultDir, '大肥鱼/世界书/知识A.md', '知识A正文')
  writeFileRel(src.vaultDir, '大肥鱼/角色卡/角色B.md', '角色B正文')
  writeFileRel(src.vaultDir, '大肥鱼/关系/约定/约定A.md', '约定A正文')
  writeFileRel(src.vaultDir, '大肥鱼/关系/大事记.md', '大事记单文件正文')
  writeFileRel(src.vaultDir, '大肥鱼/日记/2026-03-04.md', 'vault 日记')
  // 用户主动消息语料（导出必须走合并后 deck，含内置）
  await store.importTopics({ topics: [{ id: 'user-topic', sample: '用户话题' }] })
  const deck = await store.exportMerged()

  const outputDir = join(root, 'export-target')
  mkdirSync(outputDir, { recursive: true })
  writeFileRel(outputDir, 'keep.txt', '用户目录里的其它文件不能被清空')
  const snapshot = snapshotCurrent({
    workspaceDir: src.workspaceDir,
    vaultDir: src.vaultDir,
    dataDir: src.dataDir,
    deck,
    outputDir,
    now: 1760000000000
  })
  assertEq(basename(snapshot.dir).startsWith('大肥鱼资料包-'), true, `导出到 大肥鱼资料包-<时间> 子目录（${snapshot.dir}）`)
  assert(existsRel(outputDir, 'keep.txt'), '不清理用户目录里的其它文件')
  assertEq(snapshot.counts.persona, 4, '导出人格 4 槽位')
  assertEq(snapshot.counts.topics, deck.topics.topics.length, '导出话题 = 合并后 deck 条数（含内置）')
  assertEq(snapshot.counts.lineGroups, Object.keys(deck.lines.groups).length, '导出台词组 = 合并后 deck 组数')
  // 「大肥鱼/关系/约定」既是知识类别也是关系记忆 kind：导出会同时出现在两个目标里，
  // 由导入侧的「同内容按关系记忆收口」去重（见 P9 后半段断言）
  assertEq(snapshot.counts.knowledge, 3, '导出知识 3 篇（世界书/角色卡/关系约定）')
  assertEq(snapshot.counts.relations, 2, '导出关系 2 篇（目录 + 单文件形态）')
  assertEq(snapshot.counts.diaries, 2, '导出日记 2 篇（workspace 优先 + vault 补缺）')
  assert(existsRel(snapshot.dir, 'manifest.json'), '导出包有 manifest.json')
  assert(existsRel(snapshot.dir, 'persona.json'), '导出包有 persona.json')
  assert(existsRel(snapshot.dir, 'proactive/topics.json'), '导出包有 proactive/topics.json')
  assert(existsRel(snapshot.dir, 'knowledge/关系/约定/约定A.md'), '导出知识保留 关系/约定 目录')
  assert(existsRel(snapshot.dir, 'memory/relations/大事记/大事记.md'), '导出关系含单文件形态')

  // 读回并导入到全新环境
  const plan = readPackDir(snapshot.dir)
  assertEq(plan.persona.files['SOUL.md'], '# SOUL 源', 'round-trip persona 内容一致')
  assertEq(plan.topics.topics.length, deck.topics.topics.length, 'round-trip 话题条数一致')
  assertEq(plan.knowledge.length, 3, 'round-trip 知识 3 篇（含关系/约定 重复项，导入时去重）')
  const dst = makeEnv(join(root, 'dst'))
  const dstStore = makeStore(dst.dataDir)
  const imported = await importPack({
    workspaceDir: dst.workspaceDir,
    vaultDir: dst.vaultDir,
    plan,
    content: {
      importTopics: (raw) => dstStore.importTopics(raw),
      importLines: (raw) => dstStore.importLines(raw)
    }
  })
  assertEq(imported.counts.persona.length, 4, 'round-trip 人格 4 槽位')
  assertEq(imported.counts.topics.added, deck.topics.topics.length, 'round-trip 话题全部导入')
  assertEq(imported.counts.knowledge, 2, 'round-trip 知识 2 篇（关系/约定 与关系记忆重复的被收口）')
  assertEq(imported.counts.relations, 2, 'round-trip 关系 2 篇')
  assertEq(imported.counts.diaries, 2, 'round-trip 日记 2 篇')
  assertEq(imported.errors.length, 0, 'round-trip 无失败项')
  assert(
    imported.warnings.some((w) => w.includes('与关系记忆内容重复')),
    '知识/关系 重复内容要有跳过 warning'
  )
  assertEq(readFileRel(dst.workspaceDir, 'memory/2026-03-03.md'), '源日记', 'round-trip 日记内容一致')
  assertEq(
    readFileRel(dst.vaultDir, '大肥鱼/关系/约定/约定A.md'),
    '约定A正文',
    '关系记忆原文落盘（不走知识 frontmatter 重生成）'
  )
  assertEq(readFileRel(dst.vaultDir, '大肥鱼/关系/大事记/大事记.md'), '大事记单文件正文', 'round-trip 单文件关系落目录形态')
})

// ── P10：人格未初始化时导出跳过不失败；缺 persona.json 允许导入 ─────────────
await suite.check('P10', '人格未初始化导出只 warning 不失败；导入侧 persona.json 可缺失', async () => {
  const root = mkRoot('p10')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  await store.importTopics({ topics: [{ id: 'only-topic', sample: '只有话题' }] })
  const outputDir = join(root, 'out')
  mkdirSync(outputDir, { recursive: true })
  const snapshot = snapshotCurrent({
    workspaceDir: env.workspaceDir,
    deck: await store.exportMerged(),
    outputDir
  })
  assertEq(snapshot.counts.persona, 0, '没有人格文件时导出人格 0')
  assertEq(snapshot.counts.topics, 2, '话题照常导出（含内置）')
  assert(
    snapshot.warnings.some((w) => w.includes('人格文件尚未初始化')),
    '人格未初始化要有 warning'
  )
  assertEq(existsRel(snapshot.dir, 'persona.json'), false, '不写空的 persona.json')

  const plan = readPackDir(snapshot.dir)
  assertEq(plan.persona, null, 'persona.json 缺失时 plan.persona 为 null')
  const dst = makeEnv(join(root, 'dst'))
  const dstStore = makeStore(dst.dataDir)
  const imported = await importPack({
    workspaceDir: dst.workspaceDir,
    plan,
    content: {
      importTopics: (raw) => dstStore.importTopics(raw),
      importLines: (raw) => dstStore.importLines(raw)
    }
  })
  assertEq(imported.counts.persona.length, 0, '缺 persona.json 导入不报人格失败')
  assertEq(imported.errors.length, 0, '缺 persona.json 不是错误')
  assertEq(imported.counts.topics.added, 2, '话题照常导入')
})

// ── P11：通道命名合规 ─────────────────────────────────────────────────────
await suite.check('P11', '通道命名合规：character:pack:*，3 个通道', async () => {
  const channels = Object.values(CHARACTER_PACK_CHANNELS)
  assertEq(channels.length, 3, '3 个资料包通道')
  for (const channel of channels) {
    assert(/^character:pack:[a-z-]+$/.test(channel), `通道命名合规：${channel}`)
  }
})

// ── P12：全部跳过时明确提示「没有写入任何内容」────────────────────────────
await suite.check('P12', '全部条目已存在被跳过时不谎报成功，给出明确 warning', async () => {
  const root = mkRoot('p12')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  const packDir = join(root, 'pack-diary-only')
  writeFileRel(packDir, 'manifest.json', manifestJson({ targets: ['memory'] }))
  writeFileRel(packDir, 'memory/diaries/2026-01-01.md', '包内日记')
  writeFileRel(env.workspaceDir, 'memory/2026-01-01.md', '旧日记')
  const result = await importPack({
    workspaceDir: env.workspaceDir,
    plan: readPackDir(packDir),
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(result.counts.diaries, 0, '没有写入任何日记')
  assertEq(result.counts.diariesSkipped, 1, '同名日记计入跳过')
  assertEq(result.errors.length, 0, '跳过不是错误')
  assert(
    result.warnings.some((w) => w.includes('没有写入任何内容')),
    '全部跳过的包要明确提示没有写入内容（不能谎报成功）'
  )
})

// ── P13：zip 套一层顶层目录 + 反斜杠条目兼容 ─────────────────────────────
await suite.check('P13', 'zip 套壳/反斜杠条目：自动规范化并剥前缀，可直接导入', async () => {
  const root = mkRoot('p13')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  const top = '示例资料包'
  const wrappedZip = join(root, 'wrapped.zip')
  writeFileSync(
    wrappedZip,
    makeZip([
      { name: `${top}/manifest.json`, data: manifestJson() },
      { name: `${top}/persona.json`, data: personaJson({ 'SOUL.md': '# 套壳 SOUL' }) },
      {
        name: `${top}\\proactive\\topics.json`,
        data: topicDeck([{ id: 'wrapped-topic', sample: '套壳话题' }])
      },
      { name: `${top}\\knowledge\\世界书\\套壳世界.md`, data: '套壳世界正文' },
      { name: `${top}\\memory\\relations\\约定\\套壳约定.md`, data: '套壳约定正文' },
      { name: `${top}\\memory\\diaries\\2026-06-01.md`, data: '套壳日记' }
    ])
  )
  const plan = readPackZip(wrappedZip)
  assert(
    plan.warnings.some((w) => w.includes('顶层目录') && w.includes(top)),
    `套壳 zip 要提示已剥顶层目录（实际 ${JSON.stringify(plan.warnings)}）`
  )
  assertEq(plan.persona.files['SOUL.md'], '# 套壳 SOUL', '套壳 persona 读入')
  assertEq(plan.topics.topics[0].id, 'wrapped-topic', '反斜杠条目规范化后话题读入')
  assertEq(plan.knowledge.length, 1, '反斜杠知识条目读入')
  const imported = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan,
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(imported.counts.persona.length, 1, '套壳包人格导入')
  assertEq(imported.counts.topics.added, 1, '套壳包话题导入')
  assertEq(imported.counts.knowledge, 1, '套壳包知识导入')
  assertEq(imported.counts.relations, 1, '套壳包关系导入')
  assertEq(imported.counts.diaries, 1, '套壳包日记导入')
  assertEq(imported.errors.length, 0, '套壳包无失败项')
  assert(existsRel(env.vaultDir, '大肥鱼/世界书/套壳世界.md'), '套壳知识落盘')

  // 根级 manifest + 反斜杠条目（没有套壳）也要能读，且不能被误判成套壳
  const plainZip = join(root, 'backslash.zip')
  writeFileSync(
    plainZip,
    makeZip([
      { name: 'manifest.json', data: manifestJson() },
      { name: 'knowledge\\世界书\\根级反斜杠.md', data: '根级反斜杠正文' },
      { name: 'memory\\diaries\\2026-06-02.md', data: '反斜杠日记' }
    ])
  )
  const plainPlan = readPackZip(plainZip)
  assertEq(plainPlan.knowledge.length, 1, '根级反斜杠知识条目读入')
  assertEq(plainPlan.diaries.length, 1, '根级反斜杠日记条目读入')
  assert(
    !plainPlan.warnings.some((w) => w.includes('顶层目录')),
    '根级 manifest 的 zip 不应被当成套壳'
  )

  // 多顶层且根级无 manifest：仍是坏包
  const multiZip = join(root, 'multi-top.zip')
  writeFileSync(
    multiZip,
    makeZip([
      { name: '包A/manifest.json', data: manifestJson() },
      { name: '包B/proactive/topics.json', data: topicDeck([{ id: 'x', sample: 'x' }]) }
    ])
  )
  expectBadPayload(() => readPackZip(multiZip), '多顶层目录且根级无 manifest')
})

// ── P15：同包内知识/关系同名——知识优先，关系跳过不生成 -2 ────────────────
await suite.check('P14', '同包知识/关系同名不同文：知识写入，关系跳过且不生成 -2；用户已有文件仍加序号', async () => {
  const root = mkRoot('p15')
  const packDir = join(root, 'pack-same-name')
  writeFileRel(packDir, 'manifest.json', manifestJson({ targets: ['knowledge', 'memory'] }))
  writeFileRel(packDir, 'knowledge/关系/约定/同题.md', '知识正文（与关系不同）')
  writeFileRel(packDir, 'memory/relations/约定/同题.md', '关系正文（与知识不同）')
  const plan = readPackDir(packDir)
  assertEq(plan.knowledge.length, 1, '知识 1 篇')
  assertEq(plan.relations.length, 1, '关系 1 篇')

  const env = makeEnv(join(root, 'dst'))
  const store = makeStore(env.dataDir)
  const result = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan,
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(result.counts.knowledge, 1, '知识写入 1 篇')
  assertEq(result.counts.relations, 0, '同包同名关系被跳过（不是 -2）')
  assertEq(
    existsRel(env.vaultDir, '大肥鱼/关系/约定/同题-2.md'),
    false,
    '不生成 -2（关系那条跳过）'
  )
  assert(
    readFileRel(env.vaultDir, '大肥鱼/关系/约定/同题.md').includes('知识正文'),
    '目标文件是知识那条（知识优先）'
  )
  assert(
    result.warnings.some((w) => w.includes('同名同目标')),
    `要提示关系被跳过的原因（实际 ${JSON.stringify(result.warnings)}）`
  )

  // 已存在的用户文件仍不覆盖：知识加序号写入，关系仍按「同包同名」跳过
  const env2 = makeEnv(join(root, 'dst2'))
  writeFileRel(env2.vaultDir, '大肥鱼/关系/约定/同题.md', '用户旧笔记')
  const store2 = makeStore(env2.dataDir)
  const result2 = await importPack({
    workspaceDir: env2.workspaceDir,
    vaultDir: env2.vaultDir,
    plan: readPackDir(packDir),
    content: {
      importTopics: (raw) => store2.importTopics(raw),
      importLines: (raw) => store2.importLines(raw)
    }
  })
  assertEq(
    readFileRel(env2.vaultDir, '大肥鱼/关系/约定/同题.md'),
    '用户旧笔记',
    '用户旧文件不被覆盖'
  )
  assertEq(result2.counts.knowledge, 1, '知识写入（因用户文件占用而加序号）')
  assert(
    readFileRel(env2.vaultDir, '大肥鱼/关系/约定/同题-2.md').includes('知识正文'),
    '知识加序号 -2 落盘'
  )
  assertEq(result2.counts.relations, 0, '关系仍被同包知识优先跳过')
})

// ── P16：manifest.targets 语义——memory 只看关系/日记，不因知识而声明 ──────
await suite.check('P15', 'manifest.targets：只有知识时声明 knowledge 不声明 memory', async () => {
  const root = mkRoot('p16')
  const env = makeEnv(root)
  // 只放知识（世界书/角色卡；「关系/约定」目录同时被关系记忆扫描，这里不放，避免混淆目标语义）
  writeFileRel(env.vaultDir, '大肥鱼/世界书/只有知识.md', '知识正文')
  writeFileRel(env.vaultDir, '大肥鱼/角色卡/只有知识角色卡.md', '角色卡正文')
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  const snapshot = snapshotCurrent({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    outputDir: out
  })
  assertEq(snapshot.counts.knowledge, 2, '知识 2 篇')
  assertEq(snapshot.counts.relations, 0, '没有关系记忆')
  assertEq(snapshot.counts.diaries, 0, '没有日记')
  const manifest = JSON.parse(readFileRel(snapshot.dir, 'manifest.json'))
  assert(manifest.targets.includes('knowledge'), 'targets 含 knowledge')
  assert(!manifest.targets.includes('memory'), '只有知识时 targets 不声明 memory')
  assert(!manifest.targets.includes('persona'), '没有人格时不声明 persona')
})

// ── P16：导入前备份语义——snapshot 到 backups 可作为恢复包，救回被覆盖的同 id 话题 ──
await suite.check('P16', '导入前备份可恢复：snapshot 备份目录 → 导入覆盖 → 用备份目录回滚还原', async () => {
  const root = mkRoot('p16')
  const env = makeEnv(root)
  const store = makeStore(env.dataDir)
  await store.importTopics({ topics: [{ id: 'takeover', sample: '原用户样例' }] })
  writeFileRel(env.workspaceDir, 'SOUL.md', '# 原人格')
  writeFileRel(env.vaultDir, '大肥鱼/世界书/原有知识.md', '原有知识正文')
  writeFileRel(env.workspaceDir, 'memory/2026-07-01.md', '原有日记')

  // 模拟 wiring 的导入前备份：snapshot 到 <dataDir>/backups/大肥鱼资料包-时间/
  const backupsRoot = join(env.dataDir, 'backups')
  mkdirSync(backupsRoot, { recursive: true })
  const backup = snapshotCurrent({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    dataDir: env.dataDir,
    deck: await store.exportMerged(),
    outputDir: backupsRoot
  })
  assertEq(basename(backup.dir).startsWith('大肥鱼资料包-'), true, `备份目录名合规（${backup.dir}）`)
  assertEq(existsRel(backupsRoot, basename(backup.dir)), true, '备份落在 dataDir/backups 下')

  // 导入一个会覆盖同 id 话题、人格与知识的包
  const incoming = join(root, 'incoming')
  writeFileRel(
    incoming,
    'manifest.json',
    manifestJson({ targets: ['persona', 'knowledge', 'memory', 'proactive'] })
  )
  writeFileRel(incoming, 'persona.json', personaJson({ 'SOUL.md': '# 包内人格' }))
  writeFileRel(
    incoming,
    'proactive/topics.json',
    topicDeck([{ id: 'takeover', sample: '包内覆盖样例' }])
  )
  writeFileRel(incoming, 'knowledge/世界书/包内知识.md', '包内知识正文')
  const overwritten = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan: readPackDir(incoming),
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(overwritten.counts.topics.updated, 1, '同 id 话题被包内覆盖')
  assertEq(readFileRel(env.workspaceDir, 'SOUL.md'), '# 包内人格', '人格被包内覆盖')
  const afterImport = (await store.overview()).topics.find(
    (t) => t.id === 'takeover' && t.source === 'user'
  )
  assertEq(afterImport.sample, '包内覆盖样例', '覆盖后用户话题变成包内样例')

  // 用备份目录（同一格式）回滚：同 id 话题恢复成原用户内容，人格恢复
  const backupPlan = readPackDir(backup.dir)
  const restored = await importPack({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    plan: backupPlan,
    content: {
      importTopics: (raw) => store.importTopics(raw),
      importLines: (raw) => store.importLines(raw)
    }
  })
  assertEq(restored.counts.topics.updated >= 1, true, '备份回滚覆盖同 id 话题')
  const afterRestore = (await store.overview()).topics.find(
    (t) => t.id === 'takeover' && t.source === 'user'
  )
  assertEq(
    afterRestore.sample,
    '原用户样例',
    '同 id 话题被备份恢复（zip 备份不含用户语料，做不到这条）'
  )
  assertEq(readFileRel(env.workspaceDir, 'SOUL.md'), '# 原人格', '人格被备份恢复')
  assertEq(restored.errors.length, 0, `回滚无失败项（实际 ${JSON.stringify(restored.errors)}）`)
  assert(existsRel(env.vaultDir, '大肥鱼/世界书/原有知识.md'), '备份回滚后原有知识仍在')
})

// ── P17：导出截断语义与 UI 提示文案（P2-3）────────────────────────────────
await suite.check('P17', '导出截断会产出「截断」warning；角色页导出提示明确告知被截断', async () => {
  const root = mkRoot('p17')
  const env = makeEnv(root)
  for (let i = 0; i < PACK_MAX_KNOWLEDGE_FILES + 5; i += 1) {
    writeFileRel(env.vaultDir, `大肥鱼/世界书/k${i}.md`, `知识正文${i}`)
  }
  const out = join(root, 'out')
  mkdirSync(out, { recursive: true })
  const snapshot = snapshotCurrent({
    workspaceDir: env.workspaceDir,
    vaultDir: env.vaultDir,
    outputDir: out
  })
  assertEq(snapshot.counts.knowledge, PACK_MAX_KNOWLEDGE_FILES, '知识截断到上限')
  assert(
    snapshot.warnings.some((w) => w.includes('截断')),
    `截断时 warnings 必须含「截断」（实际 ${JSON.stringify(snapshot.warnings)}）`
  )
  // UI 的截断提示条件依赖上面的 warning 文案；这里静态锁住渲染端确实区分「已导出」与「已导出但被截断」
  const pageSrc = readFileSync(join(repoRoot, 'src', 'character', 'CharacterPage.vue'), 'utf8')
  assert(pageSrc.includes('已导出，但部分内容被截断/跳过'), '资源包导出结果要明确提示被截断')
  assert(
    pageSrc.includes('资料包已导出，但有内容被截断'),
    '截断时 toast 不能只说「资料包已导出」'
  )
})

// ── P18：zip 伪造头/静默截断防护（对抗审查 P2-1/P2-2，恶意 zip 必须拒、诚实包必须过）──
await suite.check('P18', 'STORED 谎报/CRC 伪造/声明 0 有数据：恶意 zip 一律拒绝，诚实 zip 正常', async () => {
  const root = mkRoot('p18')
  const manifest = JSON.stringify({
    schema: PACK_SCHEMA,
    name: '伪造头测试',
    createdAt: '2026-11-16T12:00:00+08:00'
  })
  const writeZip = (name, entries) => {
    const zipPath = join(root, name)
    writeFileSync(zipPath, makeZip(entries))
    return zipPath
  }
  // 本地头诚实（10 字节）+ 中央目录谎报 5 字节并伪造 CRC：adm-zip CRC 校验失败 → 拒绝，绝不静默截断
  const forgedCentral = writeZip('forged-central.zip', [
    { name: 'manifest.json', data: manifest },
    {
      name: 'knowledge/世界书/a.md',
      data: '1234567890',
      centralSize: 5,
      centralCompressed: 5,
      crc: crc32(Buffer.from('12345'))
    }
  ])
  expectBadPayload(() => readPackZip(forgedCentral), '中央目录谎报大小+伪造 CRC')

  // STORED 中央目录自相矛盾（声明 5 / 压缩 7）：读数据前就拒
  const inconsistent = writeZip('stored-inconsistent.zip', [
    { name: 'manifest.json', data: manifest },
    {
      name: 'knowledge/世界书/b.md',
      data: '1234567',
      centralSize: 5,
      centralCompressed: 7,
      crc: crc32(Buffer.from('12345'))
    }
  ])
  expectBadPayload(() => readPackZip(inconsistent), 'STORED 压缩大小≠声明大小')

  // 声明 0 但带数据（历史谎报入口）：拒绝
  const zeroDeclared = writeZip('zero-declared.zip', [
    { name: 'manifest.json', data: manifest },
    {
      name: 'knowledge/世界书/c.md',
      data: '12345',
      centralSize: 0,
      centralCompressed: 5,
      localSize: 0,
      localCompressed: 5,
      localCrc: crc32(Buffer.from('12345')),
      crc: crc32(Buffer.from('12345'))
    }
  ])
  expectBadPayload(() => readPackZip(zeroDeclared), '声明 0 但有压缩数据')

  // 诚实 STORED 包必须照常解析（防误伤）
  const honest = writeZip('honest.zip', [
    { name: 'manifest.json', data: manifest },
    { name: 'knowledge/世界书/d.md', data: '正常笔记正文\n' }
  ])
  const plan = readPackZip(honest)
  assertEq(plan.knowledge.length, 1, '诚实 zip 正常解析')
})

// ── P19：条目洪水与 manifest 体积上限（关键 zip/目录守卫补断言）──────────────
await suite.check('P19', '条目数 >2000 拒绝；manifest >256KB 目录包/zip 均拒绝', async () => {
  const root = mkRoot('p19')
  const manifest = JSON.stringify({
    schema: PACK_SCHEMA,
    name: '洪水测试',
    createdAt: '2026-11-16T12:00:00+08:00'
  })
  // 2001 个条目（含 manifest）：扫描期即拒，不进解析
  const floodEntries = [{ name: 'manifest.json', data: manifest }]
  for (let i = 0; i < PACK_MAX_ENTRIES; i += 1) {
    floodEntries.push({ name: `knowledge/世界书/f${i}.md`, data: `正文${i}` })
  }
  const floodPath = join(root, 'flood.zip')
  writeFileSync(floodPath, makeZip(floodEntries))
  expectBadPayload(() => readPackZip(floodPath), `条目数 ${PACK_MAX_ENTRIES + 1} 超过 ${PACK_MAX_ENTRIES}`)

  // manifest 超过 256KB：目录包与 zip 两条路径都要拒（与 skill 侧 validate 同口径）
  const bigManifest = JSON.stringify({
    schema: PACK_SCHEMA,
    name: '大 manifest',
    createdAt: '2026-11-16T12:00:00+08:00',
    padding: 'x'.repeat(PACK_MAX_MANIFEST_BYTES)
  })
  const bigDir = join(root, 'big-manifest-dir')
  writeFileRel(bigDir, 'manifest.json', bigManifest)
  expectBadPayload(() => readPackDir(bigDir), '目录包 manifest 超 256KB')
  const bigZip = join(root, 'big-manifest.zip')
  writeFileSync(bigZip, makeZip([{ name: 'manifest.json', data: bigManifest }]))
  expectBadPayload(() => readPackZip(bigZip), 'zip manifest 超 256KB')
})

const result = suite.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-character-pack.json'), result)
for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}
if (!ok) process.exit(1)
