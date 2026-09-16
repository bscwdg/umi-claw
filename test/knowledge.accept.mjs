// test/knowledge.accept.mjs —— Commit 05a 验收：Knowledge（知识库）导入 / 检索 / 重导入
//
// **打真实源码**：esbuild 把 electron/main/marketing/knowledgeManager.ts（含 parsers/）bundle 成
// 临时 ESM，在纯 Node 里 import，注入真 DatabaseClient（真 db-worker.mjs 子进程）+ 临时 dataDir。
// 刻意「不抄一份 Manager 逻辑」，因此验证的正是生产代码路径。
//
// 覆盖点（对齐 PLAN-2.0.md §四 / §五 / §七「Commit 05 边界」/ §十）：
//   - text/markdown/faq 直存；docx/xlsx/pdf **真实样本**（docx 用仓库 `docx` 包现造、
//     xlsx 用 exceljs 现造、PDF 用提交级最小样本）→ LIKE 可检索 + 价格/数字无串行
//   - 中文文字层 PDF 走 KNW_PDF_SAMPLE（没设则**明确标 SKIPPED**，不假装通过）
//   - 扫描件检测：无文字层 PDF → FILE_PARSE_ERROR，且**库里没有空内容行**、磁盘无孤儿文件
//   - 重导入按 UNIQUE(project_id, source_path) upsert：只一行、content 被覆盖、created_at 不变
//   - 原文确实落在 data/projects/<id>/；source_path 为相对 dataDir 的路径
//   - doc/xls 老格式 → VALIDATION_ERROR + 人话提示；参数校验/错误码齐全
//   - 删 Project → 知识条目级联消失；跨 Project 隔离（换 id 读不到别家资料）
//   - 通道名 / preload / main wiring / store 契约静态核对；pdfjs 资产就位与双路径解析；
//     **不采集**（源码静态扫描，url 类抓取是唯一且显式的例外）
//
// 用法：node test/knowledge.accept.mjs    （加 --keep-tmp 保留临时目录）
//       KNW_PDF_SAMPLE=<真中文文字层 PDF 路径> node test/knowledge.accept.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath,
  writeJson
} from './_lib.mjs'
import { MIN_TEXT_LAYER_PDF, SAMPLE_PDF_LINES, buildMinimalPdf } from './fixtures/make-minimal-pdf.mjs'

// mammoth / exceljs 必须在 bundle 时标为 external：mammoth 内有 `require('fs')` 这类
// 动态 require，被打进 ESM bundle 会在运行时报 "Dynamic require of \"fs\" is not supported"。
// （生产构建是 CJS，不受影响；详见 test/_lib.mjs 的 bundleEntry 注释）
const EXTERNALS = ['mammoth', 'exceljs']

const repoRoot = join(__dirname, '..')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, `knowledge-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
const samplesDir = join(runDir, 'samples')
const samplesV2Dir = join(runDir, 'samples-v2')
mkdirSync(samplesDir, { recursive: true })
mkdirSync(samplesV2Dir, { recursive: true })

const knowledgeSrcPath = join(repoRoot, 'electron', 'main', 'marketing', 'knowledgeManager.ts')
const parsersSrcPath = join(repoRoot, 'electron', 'main', 'marketing', 'parsers', 'documentParsers.ts')
const urlParserSrcPath = join(repoRoot, 'electron', 'main', 'marketing', 'parsers', 'urlParser.ts')
const pdfjsAssetsSrcPath = join(repoRoot, 'electron', 'main', 'marketing', 'parsers', 'pdfjsAssets.ts')

const knowledgeBundlePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'knowledge-manager.mjs', {
  externals: EXTERNALS
})
const projectBundlePath = bundleEntry('electron/main/marketing/projectManager.ts', 'project-manager-for-knowledge.mjs')
const databaseBundlePath = bundleEntry('electron/main/database/database.ts', 'knowledge-database.mjs')

const knw = await import(pathToFileURL(knowledgeBundlePath).href)
const projMod = await import(pathToFileURL(projectBundlePath).href)
const dbMod = await import(pathToFileURL(databaseBundlePath).href)

const {
  KnowledgeManager,
  createKnowledgeManager,
  normalizeFaqText,
  sanitizeFileName,
  KNOWLEDGE_TYPES,
  KNOWLEDGE_MANUAL_TYPES,
  KNOWLEDGE_FILE_TYPES,
  KNOWLEDGE_STATUS_READY,
  KNOWLEDGE_TITLE_MAX_LENGTH,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  FALLBACK_TITLE
} = knw
const { DatabaseClient } = dbMod

/** pdfjs 运行时资产（与 main/index.ts 的 resolvePdfjsAssets 同源；这里直接给 dev 形态） */
const pdfjsAssets = {
  root: join(repoRoot, 'resources', 'pdfjs'),
  cmapsDir: join(repoRoot, 'resources', 'pdfjs', 'cmaps'),
  standardFontsDir: join(repoRoot, 'resources', 'pdfjs', 'standard_fonts'),
  workerPath: join(repoRoot, 'resources', 'pdfjs', 'build', 'pdf.worker.js'),
  modulePath: join(repoRoot, 'resources', 'pdfjs', 'build', 'pdf.js')
}

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

function makeClient(overrides = {}) {
  const client = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-knowledge-test',
    requestTimeoutMs: 30_000,
    ...overrides
  })
  clients.add(client)
  return client
}

function makeManagers(database, extra = {}) {
  return {
    knowledge: createKnowledgeManager({ database, dataDir, pdfjsAssets, logger, ...extra }),
    projects: projMod.createProjectManager({ database, dataDir, logger })
  }
}

/** 统一把「抛错」变成可断言的结构 */
async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

const countRows = (database, table, where) =>
  database.request(`${table}.count`, { where }).then((r) => Number(r && r.count))

const listRows = (database, table, where, limit = 1000) =>
  database.request(`${table}.list`, { where, limit }).then((r) => (Array.isArray(r) ? r : []))

/** 去掉注释再扫源码：注释里写着「绝不联网」既不能当成违规，也不能当成证据 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}

// ── 真实样本生成（**不提交二进制 fixture**） ─────────────────────────────────

/** 用仓库已有的 `docx` 包现造一份「套系单」 */
async function writeSuiteDocx(targetPath, { marker, prices }) {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: '拾光摄影 · 套系单', bold: true })] }),
          new Paragraph({ children: [new TextRun(marker)] }),
          ...prices.map((p) => new Paragraph({ children: [new TextRun(p)] }))
        ]
      }
    ]
  })
  writeFileSync(targetPath, await Packer.toBuffer(doc))
}

/** 用 exceljs 现造一份「价目表」 */
async function writePriceXlsx(targetPath) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('价目表')
  ws.addRow(['套系名称', '价格', '服装数'])
  ws.addRow(['轻奢写真', 1288, 3])
  ws.addRow(['甜蜜家庭', 2688, 5])
  ws.addRow(['孕妇写真', 2088, 4])
  await wb.xlsx.writeFile(targetPath)
}

const suiteV1 = join(samplesDir, '套系单.docx')
const suiteV2 = join(samplesV2Dir, '套系单.docx')
await writeSuiteDocx(suiteV1, {
  marker: '轻奢写真套系 1288 元 / 3 套服装',
  prices: ['甜蜜家庭套系 2688 元 / 5 套服装 + 相册', '孕妇写真套系 3888 元 / 4 套服装', '交付周期 45 天']
})
await writeSuiteDocx(suiteV2, {
  marker: '轻奢写真套系 1588 元 / 3 套服装（2026 调价后）',
  prices: ['甜蜜家庭套系 2988 元 / 5 套服装 + 相册', '孕妇写真套系 4188 元 / 4 套服装', '交付周期 40 天']
})
const priceXlsx = join(samplesDir, '价目表.xlsx')
await writePriceXlsx(priceXlsx)

/** 扫描件（无文字层 PDF）：页面只有一块填充矩形 */
const scanPdf = join(runDir, '扫描件-无文字层.pdf')
writeFileSync(scanPdf, buildMinimalPdf({ withText: false }))

/** 老格式 + 未知扩展名 */
const legacyDoc = join(samplesDir, '老套系单.doc')
const legacyXls = join(samplesDir, '老价目表.xls')
const noExt = join(samplesDir, '没有扩展名')
writeFileSync(legacyDoc, Buffer.from('D0CF11E0A1B11AE1 not really a doc', 'latin1'))
writeFileSync(legacyXls, Buffer.from('D0CF11E0A1B11AE1 not really an xls', 'latin1'))
writeFileSync(noExt, 'plain text without extension')

const r = new Recorder('knowledge（知识库导入 / 检索 / 重导入，打真 knowledgeManager.ts）')
const skipped = []
let main = null
let m = null
const ctx = {}

try {
  // ── K1 模块契约：纯 Node import + 常量 + 工厂 + 构造期依赖校验 ──
  await r.check('K1', 'knowledgeManager.ts 可纯 Node import（依赖注入，无 electron 顶层引用）+ 常量契约', async () => {
    assert(typeof KnowledgeManager === 'function', '应导出 KnowledgeManager')
    assertEq(typeof createKnowledgeManager, 'function', '应导出 createKnowledgeManager 工厂')
    const raw = readFileSync(knowledgeSrcPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(raw), '源码不应 import electron')
    assertEq(
      [...KNOWLEDGE_TYPES].join(','),
      'text,markdown,url,faq,docx,xlsx,pdf',
      '§四/§七 05a 支持的 7 种类型（image 属 05b，不在其中）'
    )
    assertEq([...KNOWLEDGE_MANUAL_TYPES].join(','), 'text,markdown,faq', '手工类型应为 text/markdown/faq')
    assertEq([...KNOWLEDGE_FILE_TYPES].join(','), 'docx,xlsx,pdf', '文件类型应为 docx/xlsx/pdf')
    assertEq(KNOWLEDGE_STATUS_READY, 'ready', '状态 ready')
    assertEq(KNOWLEDGE_TITLE_MAX_LENGTH, 120, '标题上限 120')
    assertEq(DEFAULT_SEARCH_LIMIT, 20, '默认检索条数 20')
    assertEq(MAX_SEARCH_LIMIT, 200, '最大检索条数 200')
    // 构造期依赖校验（缺依赖立刻炸，不拖到运行期）
    const bad = await outcome(Promise.resolve().then(() => createKnowledgeManager({})))
    assertEq(bad.code, 'VALIDATION_ERROR', '缺 database 应 VALIDATION_ERROR')
    const badDir = await outcome(
      Promise.resolve().then(() => createKnowledgeManager({ database: { request: () => {} } }))
    )
    assertEq(badDir.code, 'VALIDATION_ERROR', '缺 dataDir 应 VALIDATION_ERROR')
    assertEq(sanitizeFileName('a/b\\c:d*e?.docx'), 'a_b_c_d_e_.docx', '文件名净化应去掉路径分隔符与非法字符')
    return `bundle=${knowledgeBundlePath.replace(/^.*[\\/]/, '')}（${(
      statSync(knowledgeBundlePath).size / 1024
    ).toFixed(0)}KB）；常量/工厂/依赖校验 ✓`
  })

  // ── K2 text / markdown / faq 直存 ──
  await r.check('K2', 'text/markdown/faq 直存：source_path=null、标题推导、faq 结构化、status=ready', async () => {
    main = makeClient()
    m = makeManagers(main)
    await main.ping()
    ctx.p1 = await m.projects.createProject({ name: '拾光摄影' })
    ctx.p2 = await m.projects.createProject({ name: '云朵女装' })

    const text = await m.knowledge.createKnowledge(ctx.p1.id, {
      title: '门店话术',
      type: 'text',
      content: '客人嫌贵的时候，先问预算再推荐套系。'
    })
    ctx.textItem = text
    assertEq(text.source_path, null, '手输条目 source_path 应为 null（NULL 互不冲突）')
    assertEq(text.status, 'ready', 'status 应为 ready')
    assertEq(text.type, 'text', 'type 应落到 text')

    // 标题推导：markdown 取首个非空行（去掉 # 前缀）
    const md = await m.knowledge.createKnowledge(ctx.p1.id, {
      title: '',
      type: 'markdown',
      content: '# 拾光摄影价目说明\n\n轻奢写真 1288 元\n甜蜜家庭 2688 元\n'
    })
    assertEq(md.title, '拾光摄影价目说明', 'markdown 标题应取首个非空行并去掉 # 前缀')

    const faq = await m.knowledge.createKnowledge(ctx.p1.id, {
      title: '常见问答',
      type: 'faq',
      content: 'Q：可以只拍一套吗？\nA：可以，轻奢写真就是单套。\n\n问：多久能拿片？\n答：交付周期 45 天。'
    })
    assert(faq.content.includes('Q: 可以只拍一套吗？'), 'faq 应结构化为 Q: 行')
    assert(faq.content.includes('A: 可以，轻奢写真就是单套。'), 'faq 应结构化为 A: 行')
    assert(faq.content.includes('Q: 多久能拿片？'), '全角「问：」也应识别')
    assertEq(normalizeFaqText('没有标记的纯文本\n第二行'), '没有标记的纯文本\n第二行', '无标记时宽松原样保留')

    const empty = await outcome(m.knowledge.createKnowledge(ctx.p1.id, { title: 'x', type: 'text', content: '   ' }))
    assertEq(empty.code, 'VALIDATION_ERROR', '空内容应 VALIDATION_ERROR')
    const badType = await outcome(
      m.knowledge.createKnowledge(ctx.p1.id, { title: 'x', type: 'docx', content: 'y' })
    )
    assertEq(badType.code, 'VALIDATION_ERROR', 'createKnowledge 只收手工类型')
    assertEq(await countRows(main, 'knowledge_items', { project_id: ctx.p1.id }), 3, 'p1 应有 3 条')
    return `text/markdown/faq 各一条；标题推导 + faq 结构化 + 空内容拦截 ✓`
  })

  // ── K3 LIKE 检索（中文）+ limit + 空白 query ──
  await r.check('K3', 'LIKE 检索：中文关键词命中 title/content/source_name，limit 生效，空白 query 报错', async () => {
    const hits = await m.knowledge.searchKnowledge(ctx.p1.id, '轻奢')
    assert(hits.length >= 2, `「轻奢」应至少命中 2 条，实际 ${hits.length}`)
    const byContent = await m.knowledge.searchKnowledge(ctx.p1.id, '嫌贵')
    assertEq(byContent.length, 1, '正文关键词「嫌贵」应命中 1 条（证明 content 参与检索）')
    assertEq(byContent[0].id, ctx.textItem.id, '命中的应是门店话术那条')
    assert(typeof byContent[0].snippet === 'string' && byContent[0].snippet.length > 0, 'snippet 非空')

    const byTitle = await m.knowledge.searchKnowledge(ctx.p1.id, '常见问答')
    assertEq(byTitle.length, 1, '标题关键词应命中')

    const limited = await m.knowledge.searchKnowledge(ctx.p1.id, '轻奢', 1)
    assertEq(limited.length, 1, 'limit=1 应只回 1 条')
    assert(hits.some((h) => h.id === limited[0].id), 'limit 截断应保留同一排序里的首条')

    const blank = await outcome(m.knowledge.searchKnowledge(ctx.p1.id, '   '))
    assertEq(blank.code, 'VALIDATION_ERROR', '空白 query 应 VALIDATION_ERROR（不许静默返回全表）')
    const miss = await m.knowledge.searchKnowledge(ctx.p1.id, '完全不存在的词xyz')
    assertEq(miss.length, 0, '无命中应返回空数组')
    return `命中 ${hits.length} 条；正文/标题都能搜；limit 与空白 query 语义 ✓`
  })

  // ── K4 docx 真样本导入 ──
  await r.check('K4', 'docx 导入（真生成「套系单」）：中文可检索、价格有序不串行、原文落盘、相对路径', async () => {
    const row = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'docx', filePath: suiteV1 })
    ctx.docxItem = row
    assertEq(row.type, 'docx', 'type=docx')
    assertEq(row.title, '套系单', '默认标题应为文件名去扩展名')
    assertEq(row.source_name, '套系单.docx', 'source_name 应为原文件名')
    assertEq(row.source_path, `projects/${ctx.p1.id}/套系单.docx`, 'source_path 应为相对 dataDir 的路径')
    assertEq(row.status, 'ready', 'status=ready')

    // 内容真的抽出来了（含中文与价格），且**价格顺序与原文一致**（不走模型识别 → 不串行）
    assert(row.content.includes('拾光摄影 · 套系单'), 'docx 中文标题应抽出')
    assert(row.content.includes('1288') && row.content.includes('2688') && row.content.includes('3888'), '三档价格都在')
    const i1288 = row.content.indexOf('1288')
    const i2688 = row.content.indexOf('2688')
    const i3888 = row.content.indexOf('3888')
    assert(i1288 < i2688 && i2688 < i3888, `价格顺序应保持 1288 < 2688 < 3888，实际 ${i1288}/${i2688}/${i3888}`)
    assert(!row.content.includes('[object Object]'), '不应出现对象序列化残留')
    assert(row.content.includes('3 套服装') && row.content.includes('5 套服装'), '价格与配套数未串行')

    // 原文确实落在 data/projects/<id>/，且能与 source_path 对上
    const onDisk = join(dataDir, row.source_path)
    assert(existsSync(onDisk), `原文应落在 ${onDisk}`)
    assertEq(statSync(onDisk).size, statSync(suiteV1).size, '落盘原文应与源文件同大小')
    assertEq(m.knowledge.absolutePathOf(row.source_path), onDisk, 'absolutePathOf 应能还原绝对路径')

    const hits = await m.knowledge.searchKnowledge(ctx.p1.id, '甜蜜家庭')
    assert(hits.some((h) => h.id === row.id), 'docx 内容应可被 LIKE 检索到')
    return `title=${row.title}；content ${row.content.length} 字；落盘 ${row.source_path}`
  })

  // ── K5 xlsx 真样本导入 ──
  await r.check('K5', 'xlsx 导入（真生成「价目表」）：Markdown 表、同行数字不串行、LIKE 命中', async () => {
    const row = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'xlsx', filePath: priceXlsx })
    ctx.xlsxItem = row
    assertEq(row.title, '价目表', '默认标题 = 文件名')
    assertEq(row.source_path, `projects/${ctx.p1.id}/价目表.xlsx`, 'source_path 相对路径')

    // 按 sheet → Markdown 表：表头 + 分隔行 + 数据行，且「同一行的数字不串位」
    assert(row.content.includes('# 工作表：价目表'), '应带工作表标题')
    assert(row.content.includes('| 套系名称 | 价格 | 服装数 |'), '表头应完整')
    assert(row.content.includes('| --- | --- | --- |'), '应带 Markdown 分隔行')
    assert(row.content.includes('| 轻奢写真 | 1288 | 3 |'), '轻奢写真行应完整对齐（价格/数量不串行）')
    assert(row.content.includes('| 甜蜜家庭 | 2688 | 5 |'), '甜蜜家庭行应完整对齐')
    assert(row.content.includes('| 孕妇写真 | 2088 | 4 |'), '孕妇写真行应完整对齐')
    assert(!/\[object Object\]/.test(row.content), '单元格不应被对象序列化污染')

    const hits = await m.knowledge.searchKnowledge(ctx.p1.id, '孕妇写真')
    assert(hits.some((h) => h.id === row.id), 'xlsx 内容应可被检索到')
    const priceHit = await m.knowledge.searchKnowledge(ctx.p1.id, '2688')
    assert(priceHit.some((h) => h.id === row.id), '数字（价格）也应可被检索到')
    return `content ${row.content.length} 字；4 行表格对齐、价格可检 ✓`
  })

  // ── K6 重导入 upsert（同一份文件覆盖，不新增行） ──
  await r.check('K6', '重导入 upsert：同 source_path 只一行、content 被覆盖、created_at 与 id 不变', async () => {
    const before = ctx.docxItem
    const beforeCount = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    await sleep(5)
    const again = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'docx', filePath: suiteV2 })
    const afterCount = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })

    assertEq(afterCount, beforeCount, '重导入不应新增行（UNIQUE(project_id, source_path)）')
    assertEq(again.id, before.id, '重导入应覆盖同一行（id 不变）')
    assertEq(again.created_at, before.created_at, 'created_at 应保持首次导入时间（不能被刷掉）')
    assert(again.updated_at >= before.updated_at, 'updated_at 应刷新')
    assert(again.content.includes('1588'), 'content 应被新版本覆盖（调价后的 1588）')
    assert(!again.content.includes('1288'), '旧内容不应残留')
    const onDisk = readFileSync(join(dataDir, again.source_path), 'utf8')
    assert(existsSync(join(dataDir, again.source_path)), '落盘原文仍在同一路径')
    assertEq(statSync(join(dataDir, again.source_path)).size, statSync(suiteV2).size, '磁盘原文也应被覆盖成新版本')

    const sameSource = await listRows(main, 'knowledge_items', {
      project_id: ctx.p1.id,
      source_path: again.source_path
    })
    assertEq(sameSource.length, 1, '同 source_path 只能有一行')
    return `id 稳定、created_at=${again.created_at} 未漂移；content 由 1288 版本覆盖为 1588 版本`
  })

  // ── K7 提交级最小 PDF（文字层） ──
  await r.check('K7', 'PDF（提交级最小 fixture）：文字层抽取 + 数字有序 + LIKE 命中', async () => {
    assert(existsSync(MIN_TEXT_LAYER_PDF), `缺少提交级样本 ${MIN_TEXT_LAYER_PDF}`)
    assert(statSync(MIN_TEXT_LAYER_PDF).size < 100 * 1024, 'fixture 应 < 100KB')
    const row = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'pdf', filePath: MIN_TEXT_LAYER_PDF })
    ctx.pdfItem = row
    assertEq(row.type, 'pdf', 'type=pdf')
    for (const line of SAMPLE_PDF_LINES) assert(row.content.includes(line), `应抽出「${line}」`)
    const order = ['128', '256', '512', '1024'].map((n) => row.content.indexOf(n))
    assert(
      order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
      `数字应保持原文顺序，实际位置 ${order.join(',')}`
    )
    const hits = await m.knowledge.searchKnowledge(ctx.p1.id, 'FIXTURE')
    assert(hits.some((h) => h.id === row.id), 'PDF 文字层应可被检索')
    return `content ${row.content.length} 字；数字顺序 ${order.join(' < ')} ✓`
  })

  // ── K8 真中文文字层 PDF（环境变量；没设就明确 SKIPPED） ──
  const pdfSample = process.env.KNW_PDF_SAMPLE
  if (pdfSample && existsSync(pdfSample)) {
    await r.check('K8', 'PDF（KNW_PDF_SAMPLE 真中文文字层）：中文抽取 + 中文关键词可检', async () => {
      const row = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'pdf', filePath: pdfSample })
      const cjk = (row.content.match(/[\u4e00-\u9fa5]/g) || []).length
      assert(cjk >= 50, `中文样本应抽出足量汉字，实际 ${cjk}`)
      const phrase = (row.content.match(/[\u4e00-\u9fa5]{4}/g) || [])[0]
      assert(phrase, '应能从抽取文本里取到中文词组')
      const hits = await m.knowledge.searchKnowledge(ctx.p1.id, phrase)
      assert(hits.some((h) => h.id === row.id), `中文关键词「${phrase}」应能命中该 PDF`)
      return `${pdfSample.replace(/^.*[\\/]/, '')}：${cjk} 个汉字，关键词「${phrase}」命中 ✓`
    })
  } else {
    skipped.push('K8')
    r.checks.push({
      id: 'K8',
      name: 'PDF（KNW_PDF_SAMPLE 真中文文字层）',
      ok: true,
      skipped: true,
      detail: pdfSample
        ? `SKIPPED：KNW_PDF_SAMPLE 指向的文件不存在（${pdfSample}）`
        : 'SKIPPED：未设置 KNW_PDF_SAMPLE（中文文字层需真样本；缺 cMap 时会抽出 0 汉字，故不能用手写 PDF 代替）',
      ms: 0
    })
  }

  // ── K9 扫描件检测 ──
  await r.check('K9', '扫描件检测：无文字层 PDF → FILE_PARSE_ERROR + 库里无空内容行 + 无孤儿文件', async () => {
    const beforeCount = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    const filesBefore = readdirSync(m.knowledge.projectDir(ctx.p1.id))
    const res = await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'pdf', filePath: scanPdf }))
    assertEq(res.code, 'FILE_PARSE_ERROR', `扫描件应报 FILE_PARSE_ERROR，实际 ${res.code}: ${res.message || ''}`)
    assertEq(res.details && res.details.reason, 'scanned-pdf', 'details.reason 应为 scanned-pdf（UI 据此标红）')
    assert(/05b|扫描件|文字层/.test(res.message), `错误文案应是给人看的（含"05b/扫描件/文字层"）：${res.message}`)

    const afterCount = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    assertEq(afterCount, beforeCount, '解析失败不应落任何行')
    assertEq(await countRows(main, 'knowledge_items', { project_id: ctx.p1.id, content: null }), 0, '库里不应有空内容行')
    const allRows = await listRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    assert(
      allRows.every((row) => typeof row.content === 'string' && row.content.trim().length > 0),
      '每一行的 content 都必须非空（不得静默存入空内容）'
    )
    const filesAfter = readdirSync(m.knowledge.projectDir(ctx.p1.id))
    assertEq(filesAfter.length, filesBefore.length, '解析失败不应留下孤儿原文文件（先解析后落盘）')
    return `FILE_PARSE_ERROR(scanned-pdf)；行数 ${beforeCount} 不变、0 空内容、0 孤儿文件 ✓`
  })

  // ── K10 老格式 doc/xls ──
  await r.check('K10', 'doc/xls 老格式 → VALIDATION_ERROR +「另存为」人话提示（不落行不落文件）', async () => {
    const beforeCount = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    const docRes = await outcome(
      m.knowledge.importKnowledge(ctx.p1.id, { type: 'docx', filePath: legacyDoc })
    )
    assertEq(docRes.code, 'VALIDATION_ERROR', `.doc 应 VALIDATION_ERROR，实际 ${docRes.code}`)
    assert(/另存为/.test(docRes.message) && /\.docx/.test(docRes.message), `应给「另存为 .docx」提示：${docRes.message}`)
    const xlsRes = await outcome(
      m.knowledge.importKnowledge(ctx.p1.id, { type: 'xlsx', filePath: legacyXls })
    )
    assertEq(xlsRes.code, 'VALIDATION_ERROR', `.xls 应 VALIDATION_ERROR，实际 ${xlsRes.code}`)
    assert(/另存为/.test(xlsRes.message) && /\.xlsx/.test(xlsRes.message), `应给「另存为 .xlsx」提示：${xlsRes.message}`)
    assertEq(
      await countRows(main, 'knowledge_items', { project_id: ctx.p1.id }),
      beforeCount,
      '老格式不应落行'
    )
    assert(!existsSync(join(m.knowledge.projectDir(ctx.p1.id), '老套系单.doc')), '老格式不应拷原文')
    return `两条都是 VALIDATION_ERROR + 人话提示 ✓`
  })

  // ── K10b txt / md 文本文件导入（picker 过滤器承诺支持这两类） ──
  await r.check('K10b', 'txt/md 文件按 text/markdown 导入：读出正文（剥 BOM）、source_path=NULL、可检索；伪装与空文件拦截', async () => {
    const txtPath = join(samplesDir, '门店须知.txt')
    const mdPath = join(samplesDir, '摄影套餐说明.md')
    const emptyPath = join(samplesDir, '空文档.txt')
    writeFileSync(txtPath, '\uFEFF门店须知：每周二公休。\n欢迎光临拾光摄影。', 'utf8')
    writeFileSync(mdPath, '# 摄影套餐说明\n\n轻奢写真 1288 元。', 'utf8')
    writeFileSync(emptyPath, '   \n  \n', 'utf8')

    const beforeCount = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    const filesBefore = readdirSync(m.knowledge.projectDir(ctx.p1.id))

    const txt = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'text', filePath: txtPath })
    assertEq(txt.type, 'text', 'type=text')
    assertEq(txt.source_path, null, '文本文件 source_path 仍为 NULL（与手输同口径）')
    assertEq(txt.source_name, '门店须知.txt', 'source_name 记原文件名（可溯源）')
    assertEq(txt.title, '门店须知', '标题默认取文件名去扩展名')
    assert(txt.content.includes('每周二公休') && !txt.content.startsWith('\uFEFF'), '正文应读出且剥掉 BOM')

    const md = await m.knowledge.importKnowledge(ctx.p1.id, { type: 'markdown', filePath: mdPath })
    assertEq(md.type, 'markdown', 'type=markdown')
    assertEq(md.title, '摄影套餐说明', 'md 标题取文件名')
    assert(md.content.includes('轻奢写真 1288'), 'md 正文应读出')

    const hits = await m.knowledge.searchKnowledge(ctx.p1.id, '公休')
    assert(hits.some((h) => h.id === txt.id), 'txt 正文应可被 LIKE 检索')

    // 防绕过：扫描件 .pdf 不能报成 text 导入架空扫描件检测；.md 也不能报成 text
    const fakePdf = await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'text', filePath: MIN_TEXT_LAYER_PDF }))
    assertEq(fakePdf.code, 'VALIDATION_ERROR', '.pdf + type=text 应被类型-扩展名校验拦下')
    const mdAsText = await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'text', filePath: mdPath }))
    assertEq(mdAsText.code, 'VALIDATION_ERROR', '.md 不能报成 text 类型')
    const empty = await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'text', filePath: emptyPath }))
    assertEq(empty.code, 'FILE_PARSE_ERROR', '空 txt 应 FILE_PARSE_ERROR（不落空内容行）')

    // 失败路径不落行；成功的两条 source_path=NULL 也不拷原文
    assertEq(
      await countRows(main, 'knowledge_items', { project_id: ctx.p1.id }),
      beforeCount + 2,
      '只有 txt/md 两条成功落行（三条失败路径不落行）'
    )
    const filesAfter = readdirSync(m.knowledge.projectDir(ctx.p1.id))
    assertEq(filesAfter.length, filesBefore.length, '文本文件不拷原文（source_path=NULL 口径）')
    return `txt/md 各一条（BOM 已剥、可检索）；伪装 pdf/错类型/空文件 3 条均被拦 ✓`
  })

  // ── K11 参数校验矩阵 ──
  await r.check('K11', '校验矩阵：缺/非法 type、image、类型-扩展名不符、文件不存在、无扩展名、url 非法、跳过长标题', async () => {
    const cases = []
    const push = (label, res, code) => {
      assertEq(res.code, code, `${label} 应 ${code}，实际 ${res.code}: ${res.message || ''}`)
      cases.push(label)
    }
    push('缺 projectId', await outcome(m.knowledge.importKnowledge('', { type: 'text', text: 'x' })), 'VALIDATION_ERROR')
    push('缺 type', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { text: 'x' })), 'VALIDATION_ERROR')
    push('非法 type', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'bogus', text: 'x' })), 'VALIDATION_ERROR')
    const img = await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'image', filePath: suiteV1 }))
    push('image 属 05b', img, 'VALIDATION_ERROR')
    assert(/05b/.test(img.message), `image 提示应指向 05b：${img.message}`)
    push('type 与扩展名不符', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'pdf', filePath: suiteV1 })), 'VALIDATION_ERROR')
    push('文件不存在', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'docx', filePath: join(samplesDir, '不存在.docx') })), 'FILE_NOT_FOUND')
    push('无扩展名', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'docx', filePath: noExt })), 'VALIDATION_ERROR')
    push('文件类缺 filePath', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'docx' })), 'VALIDATION_ERROR')
    push('文本类缺 text', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'text' })), 'VALIDATION_ERROR')
    push('url 类缺 url', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'url' })), 'VALIDATION_ERROR')
    push('url 非 http(s)', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'url', url: 'ftp://a/b' })), 'VALIDATION_ERROR')
    push('url 不是 URL', await outcome(m.knowledge.importKnowledge(ctx.p1.id, { type: 'url', url: '随便写的' })), 'VALIDATION_ERROR')
    // 超长标题截断而不是报错（标题是展示字段，不该挡住导入）
    const long = await m.knowledge.importKnowledge(ctx.p1.id, {
      type: 'text',
      title: '标'.repeat(300),
      text: '标题超长时的正文'
    })
    assertEq(long.title.length, KNOWLEDGE_TITLE_MAX_LENGTH, '超长标题应截断到上限')
    return `${cases.length} 类非法输入全部按 §五 码返回；超长标题截断 ✓`
  })

  // ── K12 project 不存在 ──
  await r.check('K12', 'project 不存在：写/读单条 → NOT_FOUND；列表 → 空数组（读路径不抛）', async () => {
    const ghost = 'no-such-project-id'
    const create = await outcome(m.knowledge.createKnowledge(ghost, { title: 't', type: 'text', content: 'c' }))
    assertEq(create.code, 'NOT_FOUND', `createKnowledge 应 NOT_FOUND，实际 ${create.code}`)
    const imp = await outcome(m.knowledge.importKnowledge(ghost, { type: 'text', text: 'c' }))
    assertEq(imp.code, 'NOT_FOUND', `importKnowledge 应 NOT_FOUND，实际 ${imp.code}`)
    const get = await outcome(m.knowledge.getKnowledge(ghost, ctx.textItem.id))
    assertEq(get.code, 'NOT_FOUND', 'getKnowledge 应 NOT_FOUND')
    const list = await m.knowledge.listKnowledge(ghost)
    assertEq(list.length, 0, '不存在 project 的列表应为空数组')
    const search = await m.knowledge.searchKnowledge(ghost, '轻奢')
    assertEq(search.length, 0, '不存在 project 的检索应为空')
    return `NOT_FOUND（写/读单条）+ 空结果（list/search）✓`
  })

  // ── K13 跨 Project 隔离 ──
  await r.check('K13', '跨 Project 隔离：拿别家 id 读/改/删 → NOT_FOUND 或 deleted:false，条目仍在', async () => {
    const target = ctx.xlsxItem
    const get = await outcome(m.knowledge.getKnowledge(ctx.p2.id, target.id))
    assertEq(get.code, 'NOT_FOUND', '跨 project getKnowledge 应 NOT_FOUND')
    const upd = await outcome(m.knowledge.updateKnowledge(ctx.p2.id, target.id, { title: '篡改' }))
    assertEq(upd.code, 'NOT_FOUND', '跨 project updateKnowledge 应 NOT_FOUND')
    const del = await m.knowledge.deleteKnowledge(ctx.p2.id, target.id)
    assertEq(del.deleted, false, '跨 project deleteKnowledge 应 deleted:false（幂等语义，不算成功）')
    const still = await m.knowledge.getKnowledge(ctx.p1.id, target.id)
    assertEq(still.title, target.title, '条目应仍在原 project 且未被改动')
    const p2List = await m.knowledge.listKnowledge(ctx.p2.id)
    assertEq(p2List.length, 0, 'p2 列表应仍为空（没被串进 p1 的资料）')
    return `读/改 → NOT_FOUND；删 → deleted:false；原条目完好 ✓`
  })

  // ── K14 update 白名单 + 空 patch ──
  await r.check('K14', 'updateKnowledge：白名单字段可改、未知字段 VALIDATION_ERROR、空 patch 不刷 updated_at', async () => {
    const item = ctx.textItem
    await sleep(5)
    const updated = await m.knowledge.updateKnowledge(ctx.p1.id, item.id, {
      title: '门店话术（v2）',
      content: '客人嫌贵时：先问预算，再推轻奢写真 1288。'
    })
    assertEq(updated.title, '门店话术（v2）', 'title 应更新')
    assert(updated.content.includes('1288'), 'content 应更新')
    assertEq(updated.created_at, item.created_at, 'created_at 不应变')
    assert(updated.updated_at >= item.updated_at, 'updated_at 应刷新')

    const unknown = await outcome(m.knowledge.updateKnowledge(ctx.p1.id, item.id, { type: 'markdown' }))
    assertEq(unknown.code, 'VALIDATION_ERROR', '未知字段（type）应 VALIDATION_ERROR')
    const emptyTitle = await outcome(m.knowledge.updateKnowledge(ctx.p1.id, item.id, { title: '  ' }))
    assertEq(emptyTitle.code, 'VALIDATION_ERROR', '空标题应 VALIDATION_ERROR')

    const noop = await m.knowledge.updateKnowledge(ctx.p1.id, item.id, {})
    assertEq(noop.updated_at, updated.updated_at, '空 patch 不应刷新 updated_at（避免无意义写入）')
    const missing = await outcome(m.knowledge.updateKnowledge(ctx.p1.id, 'no-such-id', { title: 'x' }))
    assertEq(missing.code, 'NOT_FOUND', '改不存在的条目应 NOT_FOUND')
    return `白名单/空 patch/不存在 三类语义 ✓`
  })

  // ── K15 delete 幂等 + 检索失效 ──
  await r.check('K15', 'deleteKnowledge：幂等（重复删 deleted:false）；删后检索不到', async () => {
    const tmp = await m.knowledge.createKnowledge(ctx.p1.id, {
      title: '临时资料',
      type: 'markdown',
      content: '# 临时资料\n\n独一无二的检索词 zebrafish-9281'
    })
    const before = await m.knowledge.searchKnowledge(ctx.p1.id, 'zebrafish-9281')
    assertEq(before.length, 1, '删除前应能检索到')
    const del = await m.knowledge.deleteKnowledge(ctx.p1.id, tmp.id)
    assertEq(del.deleted, true, '首次删除应 deleted:true')
    const again = await m.knowledge.deleteKnowledge(ctx.p1.id, tmp.id)
    assertEq(again.deleted, false, '重复删除应 deleted:false（幂等，不报错）')
    const after = await m.knowledge.searchKnowledge(ctx.p1.id, 'zebrafish-9281')
    assertEq(after.length, 0, '删除后不应再被检索到')
    return `幂等删除 ✓；检索随删除失效 ✓`
  })

  // ── K16 检索只吃 ready ──
  await r.check('K16', '检索只返回 status=ready（手插一条其他状态的行不参与检索）', async () => {
    const now = Date.now()
    await main.request('knowledge_items.create', {
      data: {
        id: 'k-not-ready-0001',
        project_id: ctx.p1.id,
        title: '待人工确认的资料',
        type: 'image',
        source_path: null,
        source_name: null,
        content: '这段文字里也有 zebrafish-9281 关键词，但状态不是 ready',
        status: 'pending_ai_confirm',
        created_at: now,
        updated_at: now
      }
    })
    const hits = await m.knowledge.searchKnowledge(ctx.p1.id, 'zebrafish-9281')
    assertEq(hits.length, 0, '非 ready 行不应参与检索（AI 上下文只吃可用资料）')
    const all = await listRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    const notReady = all.find((row) => row.id === 'k-not-ready-0001')
    assert(notReady, '非 ready 行本身应确实存在（证明确实是 status 过滤生效，而不是没插进去）')
    const listed = await m.knowledge.listKnowledge(ctx.p1.id)
    assert(listed.some((row) => row.id === 'k-not-ready-0001'), 'list 应照样列出所有条目（含非 ready）')
    await main.request('knowledge_items.delete', { keys: { id: 'k-not-ready-0001' } })
    return `status 过滤生效；list 不受影响 ✓`
  })

  // ── K17 url 类导入 ──
  await r.check('K17', 'url 类：注入抓取器 → 正文抽取（去 script/style/实体解码）、重导入覆盖、抓取失败报错', async () => {
    const seen = []
    const fakeFetcher = async (url) => {
      seen.push(url)
      return {
        html:
          '<html><head><title>拾光摄影官网 · 套系价格</title><style>.x{color:red}</style></head>' +
          '<body><script>var secret=1;</script><h1>套系价格</h1>' +
          '<p>轻奢写真 1288 元 &amp; 含 3 套服装</p><ul><li>相册</li><li>精修</li></ul></body></html>',
        finalUrl: url,
        status: 200,
        contentType: 'text/html; charset=utf-8'
      }
    }
    const um = makeManagers(main, { htmlFetcher: fakeFetcher }).knowledge
    const url = 'https://example.com/shiguang/price'
    const row = await um.importKnowledge(ctx.p1.id, { type: 'url', url })
    ctx.urlItem = row
    assertEq(row.source_path, url, 'url 类 source_path = 原始 URL（重导入按它 upsert）')
    assertEq(row.title, '拾光摄影官网 · 套系价格', '默认标题应取页面 <title>')
    assert(row.content.includes('套系价格'), '应抽到 h1 正文')
    assert(row.content.includes('轻奢写真 1288 元 & 含 3 套服装'), '实体 &amp; 应被解码')
    assert(row.content.includes('- 相册') && row.content.includes('- 精修'), 'li 应转成列表行')
    assert(!row.content.includes('var secret=1'), 'script 内容不应混进正文')
    assert(!row.content.includes('.x{color:red}'), 'style 内容不应混进正文')

    // 重导入同一 URL：覆盖同一条（不新增）
    const before = await countRows(main, 'knowledge_items', { project_id: ctx.p1.id })
    const row2 = await um.importKnowledge(ctx.p1.id, { type: 'url', url })
    assertEq(row2.id, row.id, '同 URL 重导入应覆盖同一行')
    assertEq(await countRows(main, 'knowledge_items', { project_id: ctx.p1.id }), before, '不应新增行')
    assertEq(seen.length, 2, '抓取器应被调用两次（每次导入一次）')

    // 抓取失败 → FILE_PARSE_ERROR（不落行）
    const failing = makeManagers(main, {
      htmlFetcher: async () => {
        const err = new Error('抓取失败：HTTP 404 https://example.com/404')
        err.code = 'FILE_PARSE_ERROR'
        throw err
      }
    }).knowledge
    const fail = await outcome(failing.importKnowledge(ctx.p1.id, { type: 'url', url: 'https://example.com/404' }))
    assertEq(fail.code, 'FILE_PARSE_ERROR', '抓取失败应 FILE_PARSE_ERROR')
    assertEq(
      await countRows(main, 'knowledge_items', { project_id: ctx.p1.id }),
      before,
      '抓取失败不应落行'
    )

    // 纯函数断言（离线）：URL 校验 + HTML→文本 + 编码解码
    const urlMod = await import(pathToFileURL(bundleEntry('electron/main/marketing/parsers/urlParser.ts', 'url-parser.mjs')).href)
    assertEq(urlMod.assertImportableUrl(' https://a.com/x '), 'https://a.com/x', '应 trim 并接受 https')
    for (const bad of ['ftp://a/b', 'javascript:alert(1)', 'file:///c:/x', '不是URL', '']) {
      const res = await outcome(Promise.resolve().then(() => urlMod.assertImportableUrl(bad)))
      assertEq(res.code, 'VALIDATION_ERROR', `非法 URL「${bad}」应 VALIDATION_ERROR`)
    }
    assertEq(urlMod.decodeEntities('&amp;&lt;&gt;&#65;&#x42;&nbsp;') , '&<>AB ', '实体解码（含数字实体）')
    const extracted = urlMod.extractTextFromHtml('<div><p>甲</p><p>乙</p></div>')
    assertEq(extracted.text, '甲\n\n乙', '块级标签应转换行（段间单空行）')
    const collapsed = urlMod.extractTextFromHtml('<p>甲</p><p></p><p></p><p>乙</p>')
    assertEq(collapsed.text, '甲\n\n乙', '连续空行应压成一个空行')
    assertEq(urlMod.extractHtmlTitle('<title> 拾光 摄影 </title>'), '拾光 摄影', 'title 应归一空白')
    assertEq(urlMod.MAX_FETCH_BYTES, 5 * 1024 * 1024, '抓取体积上限应为 5MB')
    assert(/^https:/.test(urlMod.FETCH_USER_AGENT) === false, 'UA 不应伪装成 https 链接')
    return `正文抽取 + 覆盖 + 失败路径 + 纯函数（URL/实体/块级） ✓`
  })

  // ── K18 删 Project 级联 ──
  await r.check('K18', '删 Project → 知识条目级联消失 + data/projects/<id>/ 目录消失', async () => {
    const p3 = await m.projects.createProject({ name: '级联测试商家' })
    const item = await m.knowledge.importKnowledge(p3.id, { type: 'docx', filePath: suiteV1 })
    const dir = m.knowledge.projectDir(p3.id)
    assert(existsSync(join(dataDir, item.source_path)), '导入后原文应在 data/projects/<id>/')
    assertEq(await countRows(main, 'knowledge_items', { project_id: p3.id }), 1, '应有 1 条')

    const res = await m.projects.deleteProject(p3.id)
    assertEq(res.rowDeleted, true, '行应删除')
    assertEq(res.dirRemoved, true, '目录应删除')
    assertEq(await countRows(main, 'knowledge_items', { project_id: p3.id }), 0, '知识条目应级联消失（§十）')
    assert(!existsSync(dir), 'data/projects/<id>/ 应被删掉')

    const ghost = await outcome(m.knowledge.getKnowledge(p3.id, item.id))
    assertEq(ghost.code, 'NOT_FOUND', '删 Project 后条目应读不到')
    // RAG 预留表本期只建表不用（§四 knowledge_chunks）
    assertEq(await countRows(main, 'knowledge_chunks', {}), 0, 'knowledge_chunks 应为空（本期只建表不用）')
    return `p3 条目 ${item.id} 随 Project 级联清除；目录已删 ✓`
  })

  // ── K19 通道 / preload / wiring / store 契约 ──
  await r.check('K19', 'IPC 通道 / preload / main wiring / store 契约一致（静态核对，避免漂移）', async () => {
    const ipcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'marketing.ts'), 'utf-8')
    const ipcIndexSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'index.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    const mainSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
    const storeSrc = readFileSync(join(repoRoot, 'src', 'stores', 'marketing.ts'), 'utf-8')
    const storeCode = stripComments(storeSrc)

    const channels = [
      'marketing:knowledge:list',
      'marketing:knowledge:get',
      'marketing:knowledge:create',
      'marketing:knowledge:update',
      'marketing:knowledge:delete',
      'marketing:knowledge:search',
      'marketing:knowledge:import',
      'marketing:knowledge:pickFile'
    ]
    for (const c of channels) {
      assert(ipcSrc.includes(`'${c}'`), `ipc/marketing.ts 应声明通道 ${c}`)
      assert(preloadSrc.includes(`'${c}'`), `preload/index.ts 应暴露通道 ${c}`)
    }
    assert(/MARKETING_KNOWLEDGE_CHANNELS/.test(ipcSrc), '应导出 MARKETING_KNOWLEDGE_CHANNELS')
    assert(/MARKETING_KNOWLEDGE_CHANNELS/.test(ipcIndexSrc), 'ipc/index.ts 应转出 knowledge 通道表')
    assert(
      /registerMarketingIpc\([\s\S]{0,300}knowledgeManager/.test(ipcSrc),
      'registerMarketingIpc 应接收 knowledgeManager'
    )
    // 主进程 wiring：工厂 + pdfjs 资产双路径解析 + 第 5 个依赖
    assert(/createKnowledgeManager/.test(mainSrc), 'main/index.ts 应创建 knowledgeManager')
    assert(/resolvePdfjsAssets\(/.test(mainSrc), 'main/index.ts 应用 resolvePdfjsAssets 解析资产路径')
    assert(/app\.isPackaged/.test(mainSrc) && /process\.resourcesPath/.test(mainSrc), 'wiring 应含 dev/打包双路径取值')
    assert(
      /registerMarketingIpc\(\s*marketingDatabase!,\s*marketingProjectManager!,\s*marketingBusinessManager!,\s*marketingWatchlistManager!,\s*marketingKnowledgeManager!\s*\)/.test(
        mainSrc
      ),
      'main/index.ts 应把 5 个依赖都传给 registerMarketingIpc'
    )
    // preload 面：api.marketing.knowledge.*
    assert(/knowledge:\s*\{[\s\S]{0,1500}?import:/.test(preloadSrc), 'preload 应暴露 knowledge.import')
    assert(
      /knowledge:\s*\{[\s\S]{0,2000}?pickFile:/.test(preloadSrc),
      'preload 应暴露 knowledge.pickFile'
    )

    // 本地文件选择器：dialog 只能在主进程用 → 写在 ipc 层（manager 保持纯 Node 可测，不上 electron）
    assert(/import\s*\{[^}]*\bdialog\b[^}]*\}\s*from\s*'electron'/.test(ipcSrc), 'ipc/marketing.ts 应 import dialog（主进程）')
    assert(/dialog\.showOpenDialog\(/.test(ipcSrc), 'pickFile 应使用 dialog.showOpenDialog')
    assert(/properties:\s*\[\s*'openFile'\s*\]/.test(ipcSrc), 'picker 应限定 properties: ["openFile"]')
    assert(/title:\s*'选择要导入的资料'/.test(ipcSrc), 'picker 标题应为「选择要导入的资料」')
    for (const ext of ['docx', 'xlsx', 'pdf', 'txt', 'md']) {
      assert(new RegExp(`'${ext}'`).test(ipcSrc), `picker filters 应包含 ${ext}`)
    }
    assert(/所有文件/.test(ipcSrc), 'picker 应有「所有文件」一项')
    assert(
      /filePath:\s*string\s*\|\s*null/.test(ipcSrc),
      'pickFile 返回类型应为 { filePath: string | null }（null = 用户取消）'
    )
    // 取消不是错误：结果里应为 null，而不是抛错
    assert(/canceled[\s\S]{0,120}null/.test(ipcSrc), '取消应返回 filePath=null（不报错）')
    assert(
      !/from\s*['"]electron['"]/.test(readFileSync(knowledgeSrcPath, 'utf-8')),
      'knowledgeManager.ts 不应 import electron（picker 归 IPC 层）'
    )

    // store 契约（主会话 UI 直接依赖这些名字；不得改名）
    for (const name of [
      'KnowledgeItem',
      'knowledge',
      'knowledgeLoading',
      'loadKnowledge',
      'importKnowledge',
      'removeKnowledge',
      'searchKnowledge',
      'knowledgeCompleteness',
      'overallCompleteness'
    ]) {
      assert(new RegExp(`\\b${name}\\b`).test(storeSrc), `store 应暴露 ${name}`)
    }
    assert(
      /knowledge\s*=\s*ref<KnowledgeItem\[\]>\(\[\]\)\s*as Ref<KnowledgeItem\[\]>/.test(storeSrc.replace(/\s+/g, ' ')),
      'store 的 knowledge 应为 Ref<KnowledgeItem[]>'
    )
    // 老的契约不能被顶掉
    for (const name of ['projects', 'business', 'watchlist', 'completeness', 'saveBusiness', 'addWatch']) {
      assert(new RegExp(`\\b${name}\\b`).test(storeSrc), `store 应保留既有契约 ${name}`)
    }
    // 完整度：Business 六项 + Knowledge 一项（等权）
    assert(
      /BUSINESS_COMPLETENESS_FIELDS\.length\s*\+\s*1/.test(storeSrc),
      'overallCompleteness 应为 Business 六项 + Knowledge 一项'
    )
    assert(
      /status\s*===\s*KNOWLEDGE_READY_STATUS/.test(storeSrc),
      'knowledgeCompleteness 应按 ready 状态计'
    )
    assert(!/error\.message\.includes\(|message\.includes\(/.test(storeCode), 'store 禁止用 message.includes() 判断错误')
    return `8 通道三处一致（含 pickFile）；picker 过滤器/标题/取消语义 ✓；wiring + pdfjs 资产双路径；store 14 项（9 新 + 5 旧）契约齐全`
  })

  // ── K20 pdfjs 资产就位 + 双路径解析 + 不被打包器静态引入 ──
  await r.check('K20', 'pdfjs 运行时资产就位（cmaps/standard_fonts/worker/本体）+ dev|打包双路径解析', async () => {
    const { resolvePdfjsAssets, resolveResourcesRoot, PDFJS_ASSETS_SUBDIR } = await import(
      pathToFileURL(bundleEntry('electron/main/marketing/parsers/pdfjsAssets.ts', 'pdfjs-assets.mjs')).href
    )
    const dev = resolvePdfjsAssets({ isPackaged: false, appPath: 'C:\\repo', resourcesPath: 'C:\\ignored' })
    assertEq(dev.root, join('C:\\repo', 'resources', PDFJS_ASSETS_SUBDIR), 'dev 应取 app.getAppPath()/resources')
    const packed = resolvePdfjsAssets({
      isPackaged: true,
      appPath: 'C:\\repo',
      resourcesPath: join('C:\\app', 'resources')
    })
    assertEq(
      packed.root,
      join('C:\\app', 'resources', 'resources', PDFJS_ASSETS_SUBDIR),
      '打包应取 process.resourcesPath/resources（与 extraResources 的 to=resources 对齐）'
    )
    assertEq(resolveResourcesRoot({ isPackaged: false, appPath: 'C:\\repo', resourcesPath: 'C:\\x' }), join('C:\\repo', 'resources'), 'resolveResourcesRoot(dev)')
    const bad = await outcome(
      Promise.resolve().then(() => resolvePdfjsAssets({ isPackaged: false, appPath: '', resourcesPath: '' }))
    )
    assertEq(bad.code, 'VALIDATION_ERROR', '缺路径应 VALIDATION_ERROR')

    // 资产就位（安装包靠 electron-builder 的 extraResources 带整个 resources/）
    assert(existsSync(pdfjsAssets.root), `资产目录应存在: ${pdfjsAssets.root}`)
    assert(existsSync(pdfjsAssets.workerPath), '应有 build/pdf.worker.js')
    assert(existsSync(pdfjsAssets.modulePath), '应有 build/pdf.js（运行时加载的 pdfjs 本体）')
    const cmapCount = readdirSync(pdfjsAssets.cmapsDir).length
    const fontCount = readdirSync(pdfjsAssets.standardFontsDir).length
    assert(cmapCount >= 150, `cmaps 应有 169 个左右，实际 ${cmapCount}`)
    assert(fontCount >= 10, `standard_fonts 应齐全，实际 ${fontCount}`)
    const total = dirSize(pdfjsAssets.root)
    assert(total > 3 * 1024 * 1024 && total < 8 * 1024 * 1024, `assets 体积应约 4.5MB，实际 ${(total / 1048576).toFixed(2)}MB`)

    // 不被打包器静态引入（否则 esbuild/rollup 会因 pdfjs 的 require('canvas') 直接打包失败）+ 不 import electron
    const parsersSrc = readFileSync(parsersSrcPath, 'utf-8')
    assert(
      !/^\s*import\s+.*\s+from\s+['"]pdfjs-dist/m.test(parsersSrc),
      'documentParsers.ts 不得静态 import pdfjs-dist（必须走运行时资产加载）'
    )
    assert(/createRequire|loadPdfjsModule/.test(parsersSrc), '应通过 createRequire 运行时加载 pdfjs')
    assert(/typeof import\('pdfjs-dist/.test(parsersSrc), '类型仍应取自官方 d.ts（type-only，不产生运行时 import）')
    assert(!/from\s*["']electron["']/.test(readFileSync(pdfjsAssetsSrcPath, 'utf-8')), 'pdfjsAssets.ts 不应 import electron')
    const bundleText = readFileSync(knowledgeBundlePath, 'utf-8')
    assert(!/Could not resolve/.test(bundleText), 'bundle 不应携带打包期未解析提示')
    assert(
      statSync(knowledgeBundlePath).size < 1500 * 1024,
      `bundle 不应把 pdfjs（0.7MB+）打进来，实际 ${(statSync(knowledgeBundlePath).size / 1024).toFixed(0)}KB`
    )
    return `assets ${(total / 1048576).toFixed(2)}MB（cmaps ${cmapCount} / fonts ${fontCount}）；dev+打包双路径 ✓；bundle ${(
      statSync(knowledgeBundlePath).size / 1024
    ).toFixed(0)}KB 无 pdfjs ✓`
  })

  // ── K21 不采集 / 不联网 静态扫描 ──
  await r.check('K21', '不采集：manager 与文件解析器无网络调用；url 抓取是唯一且显式的例外（无 Cookie/无第三方 API）', async () => {
    const NETWORK_PATTERNS = [
      [/\bfetch\s*\(/, 'fetch('],
      [/\baxios\b/, 'axios'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/from\s+['"](?:node:)?(?:net|http|https|dgram|tls)['"]/, "import ... from 'net|http|https|dgram|tls'"],
      [/https?:\/\//i, 'http(s):// 字面量']
    ]
    for (const [label, file] of [
      ['knowledgeManager.ts', knowledgeSrcPath],
      ['documentParsers.ts', parsersSrcPath],
      ['pdfjsAssets.ts', pdfjsAssetsSrcPath]
    ]) {
      const code = stripComments(readFileSync(file, 'utf-8'))
      const hits = NETWORK_PATTERNS.filter(([re]) => re.test(code)).map(([, name]) => name)
      assertEq(hits.join(' / '), '', `${label} 不应存在网络调用，命中: ${hits.join(' / ')}`)
    }
    // 采集相关依赖一个都不许有
    for (const word of ['collector', 'crawler', 'puppeteer', 'cheerio', 'playwright']) {
      for (const file of [knowledgeSrcPath, parsersSrcPath]) {
        assert(
          !new RegExp(`\\b${word}\\b`, 'i').test(stripComments(readFileSync(file, 'utf-8'))),
          `${file} 不应依赖 ${word}（采集属 Commit 11，硬规则 12）`
        )
      }
    }
    // manager 头部必须写死「绝不采集」契约（防后续提交悄悄塞进采集）
    const knwRaw = readFileSync(knowledgeSrcPath, 'utf-8')
    assert(/绝不采集/.test(knwRaw), '文件头应写明「绝不采集」契约')
    assert(/Commit 11/.test(knwRaw), '文件头应指明采集归属 Commit 11');

    // url 抓取是唯一的出站动作：只允许 node:http(s)、不得带 Cookie / 不得调第三方抽取 API
    const urlCode = stripComments(readFileSync(urlParserSrcPath, 'utf-8'))
    assert(/import\('node:https'\)|require\('node:https'\)/.test(urlCode), 'urlParser 只应引 node:https')
    assert(/import\('node:http'\)|require\('node:http'\)/.test(urlCode), 'urlParser 只应引 node:http')
    assert(/method:\s*'GET'/.test(urlCode), '只做 GET')
    assert(!/Cookie/i.test(urlCode), '不得携带 Cookie（硬规则 11）')
    assert(!/readability|jina\.ai|r\.jina|extractorapi|mercury/i.test(urlCode), '不得调用第三方正文抽取 API')
    assert(!/User-Agent[^\n]*Mozilla/i.test(urlCode), '不得伪装成浏览器 UA')
    assert(/MAX_FETCH_BYTES|FETCH_TIMEOUT_MS|MAX_REDIRECTS/.test(urlCode), '应有体积/超时/重定向上限')
    return `${NETWORK_PATTERNS.length} 类网络特征在 manager/解析器 0 命中；urlParser 仅 http(s) GET、无 Cookie/无第三方 API ✓`
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const c of [...clients]) {
    try {
      await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
}

const result = r.toJSON({
  bundle: knowledgeBundlePath,
  dataDir,
  nodePath,
  skipped,
  pdfSample: process.env.KNW_PDF_SAMPLE || null,
  logSample: logs.slice(0, 20)
})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-knowledge.json'), result)
console.log('结果已写入 test/accept-result-knowledge.json')
if (skipped.length) console.log(`⚠️ 跳过（未假装通过）: ${skipped.join(', ')}`)

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
