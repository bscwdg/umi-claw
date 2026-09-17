// test/context.accept.mjs —— Commit 06 验收：Context Engine（§六 Context Pack + §一 产品智能原则）
//
// **打真实源码**：esbuild 把 electron/main/marketing/contextEngine.ts 及其四个依赖 Manager
// bundle 成临时 ESM，在纯 Node 里 import，注入真 DatabaseClient（真 db-worker.mjs 子进程）
// + 临时 dataDir。刻意「不抄一份组装逻辑」，因此验证的正是生产代码路径。
//
// 覆盖点（对齐 PLAN-2.0.md §一 / §四 / §五 / §六 / §七 Commit 06）：
//   - 预算内**全量打包**（§六 v1.10 写死）：不做检索、不做裁剪、正文完整
//   - 超预算**退化为 LIKE 裁剪**：命中优先、按时间回退、截断带标记、超预算条目不静默丢
//   - **本地 token 估算**（§六：Gateway 的 usage 恒为 0）：口径、单调性、预算账本与实际渲染一致
//   - 只打包 `status='ready'`；空内容条目显式 dropped；跨 Project 隔离
//   - 错误码**透传**：NOT_FOUND / SETUP_REQUIRED / VALIDATION_ERROR 不被吞成 DB_ERROR（跨 bundle 身份）
//   - 不联网、不碰 GATEWAY_TOKEN（硬规则 13）；wat/wiring 静态核对
//
// 用法：node test/context.accept.mjs    （加 --keep-tmp 保留临时目录）
//      npm run accept:context

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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

const nodePath = resolveNodePath()
const runDir = join(tmpDir, `context-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')
const contextSrcPath = join(repoRoot, 'electron', 'main', 'marketing', 'contextEngine.ts')
const mainSrcPath = join(repoRoot, 'electron', 'main', 'index.ts')

// knowledgeManager 会经 documentParsers 静态引入 mammoth / exceljs（内含动态 require('fs')），
// 打进 ESM bundle 会变成 "Dynamic require of fs is not supported" → 标成 external，由 Node 按 CJS 加载
// （与 test/knowledge.accept.mjs 同口径；生产构建是 CJS，不受影响）
const EXTERNALS = ['mammoth', 'exceljs']

const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'context-engine.mjs', {
  externals: EXTERNALS
})
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'project-manager-for-context.mjs')
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'business-manager-for-context.mjs', {
  externals: EXTERNALS
})
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'knowledge-manager-for-context.mjs', {
  externals: EXTERNALS
})
const databasePath = bundleEntry('electron/main/database/database.ts', 'context-database.mjs')

const ctxMod = await import(pathToFileURL(contextPath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const {
  ContextEngine,
  createContextEngine,
  CONTEXT_PACK_KEYS,
  CONTEXT_BUDGET_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  PLATFORMS,
  PACK_TEXT_MAX_LENGTH,
  ITEM_TRUNCATE_MARKER,
  KNOWLEDGE_ITEM_MIN_TOKENS,
  estimateTokens,
  sliceToTokenBudget,
  summarizeBusiness,
  computeBusinessCompleteness,
  renderContextPackText
} = ctxMod
const { DatabaseClient } = dbMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

function makeClient(overrides = {}) {
  const client = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-context-test',
    requestTimeoutMs: 30_000,
    ...overrides
  })
  clients.add(client)
  return client
}

function makeStack(database) {
  const projects = projMod.createProjectManager({ database, dataDir, logger })
  const business = bizMod.createBusinessManager({ database, logger })
  const watchlist = bizMod.createWatchlistManager({ database, logger })
  const knowledge = knowMod.createKnowledgeManager({ database, dataDir, logger })
  const engine = createContextEngine({ projectManager: projects, businessManager: business, knowledgeManager: knowledge, watchlistManager: watchlist, logger })
  return { projects, business, watchlist, knowledge, engine }
}

async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

/** 去掉注释再扫：注释里写「绝不联网」既不能算违规、也不能算证据 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 去掉注释与空白，便于跨行断言 */
function flat(src) {
  return stripComments(src).replace(/\s+/g, ' ')
}

const NETWORK_PATTERNS = [
  [/\bfetch\s*\(/, 'fetch('],
  [/\baxios\b/, 'axios'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bnode:(net|http|https|dgram|tls)\b/, 'node:<net|http|https|dgram|tls>'],
  [/(?:require|from)\s*\(\s*['"](?:node:)?(?:net|http|https|dgram|tls)['"]\s*\)/, "require('net|http|https|dgram|tls')"],
  [/from\s+['"](?:node:)?(?:net|http|https|dgram|tls)['"]/, "import ... from 'net|http|https|dgram|tls'"],
  [/https?:\/\//i, 'http(s):// 字面量']
]

const r = new Recorder('context（Context Engine：全量打包 / 超预算 LIKE 裁剪，打真 contextEngine.ts）')
const ctx = {}

try {
  const database = makeClient()
  const stack = makeStack(database)
  const { projects, business, watchlist, knowledge, engine } = stack

  // ── C1 契约与构造 ──
  await r.check('C1', 'contextEngine.ts 可纯 Node import；六键/比例/平台常量与 §六 一致；缺依赖即炸', async () => {
    assert(typeof ContextEngine === 'function', '应导出 ContextEngine')
    assertEq(typeof createContextEngine, 'function', '应导出 createContextEngine 工厂')
    const raw = readFileSync(contextSrcPath, 'utf-8')
    const bundled = readFileSync(contextPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(raw), '源码不应 import electron')
    assert(!/from\s*["']electron["']/.test(bundled), 'bundle 内不应存在 electron（依赖注入才测得了）')
    // §六 原文：{ business, knowledge[], watchlist[], customer, platform, task }
    assertEq(
      [...CONTEXT_PACK_KEYS].join(','),
      'business,knowledge,watchlist,customer,platform,task',
      'CONTEXT_PACK_KEYS 应与 §六 的六个包字段逐字一致'
    )
    assertEq(CONTEXT_BUDGET_RATIO, 0.6, '预算比例应为 60%（§六 原文）')
    assertEq([...PLATFORMS].join(','), 'xiaohongshu,douyin', 'PLATFORMS 应为 §四 contents.platform 的两个取值')
    assertEq(DEFAULT_CONTEXT_WINDOW_TOKENS, 128_000, '默认上下文窗口应为 128k')
    assert(MIN_CONTEXT_WINDOW_TOKENS > 0 && MAX_CONTEXT_WINDOW_TOKENS > MIN_CONTEXT_WINDOW_TOKENS, '窗口上下界应合法')
    // 构造期依赖校验：缺一个 Manager 立刻 VALIDATION_ERROR，不拖到运行期
    const bad = await outcome(
      Promise.resolve().then(() => createContextEngine({ projectManager: projects }))
    )
    assertEq(bad.ok, false, '缺依赖应抛')
    assertEq(bad.code, 'VALIDATION_ERROR', '缺依赖应是 VALIDATION_ERROR')
    return `常量与 §六 逐字一致；bundle 无 electron；缺依赖即 VALIDATION_ERROR`
  })

  // ── 造数据：P1（主用例）/ P2（超预算）/ P4（单条超大）/ P5（命中排序）/ P6（空商家）/ P3（隔离） ──
  const p1 = await projects.createProject({ name: 'C06 摄影工作室', industry: '摄影' })
  const p2 = await projects.createProject({ name: 'C06 超预算商家', industry: '摄影' })
  const p4 = await projects.createProject({ name: 'C06 单条超大商家', industry: '摄影' })
  const p5 = await projects.createProject({ name: 'C06 命中排序商家', industry: '摄影' })
  const p6 = await projects.createProject({ name: 'C06 空商家', industry: '摄影' })
  const p3 = await projects.createProject({ name: 'C06 隔壁商家', industry: '摄影' })
  ctx.projects = { p1: p1.id, p2: p2.id, p3: p3.id, p4: p4.id, p5: p5.id, p6: p6.id }

  await business.upsertBusiness(p1.id, { name: '光影婚纱摄影', brand: '光影', city: '杭州' })
  await watchlist.addWatch(p1.id, '杭州婚纱', 'industry')
  await watchlist.addWatch(p1.id, '旅拍', 'product')
  await watchlist.addWatch(p1.id, '暂停词', 'audience')
  await watchlist.setWatchEnabled(p1.id, '暂停词', false)
  const kPrice = await knowledge.createKnowledge(p1.id, {
    title: '套系价目表',
    type: 'text',
    content: '婚纱套系 5999 元，含 30 张精修、2 套服装；亲子套系 1999 元，含 10 张精修。'
  })
  const kAbout = await knowledge.createKnowledge(p1.id, {
    title: '门店介绍',
    type: 'markdown',
    content: '# 关于我们\n光影婚纱摄影成立于 2015 年，主打轻奢外景与纪实风，团队 12 人。'
  })
  const kFaq = await knowledge.createKnowledge(p1.id, {
    title: '常见问答',
    type: 'faq',
    content: '问：能出片多久？\n答：选片后 15 个工作日。'
  })
  await knowledge.createKnowledge(p3.id, {
    title: '隔壁商家的机密价目',
    type: 'text',
    content: '隔壁商家独有暗号：UMI-NEIGHBOR-77，绝不该出现在别人家的上下文里。'
  })

  // ── C2 空商家：不抛错，六键齐全，缺口可读 ──
  await r.check('C2', '空商家（无 business / 无 knowledge）也能出包：缺口显式暴露，不抛错', async () => {
    const pack = await engine.buildContextPack(p6.id)
    for (const key of CONTEXT_PACK_KEYS) assert(key in pack, `包内应有 ${key}`)
    assertEq(pack.business, null, '无 business 时 business 应为 null')
    assertEq(pack.businessSummary, null, '无字段时 businessSummary 应为 null')
    assertEq(pack.businessCompleteness.percent, 0, '空商家完整度应为 0%')
    assertEq(pack.businessCompleteness.missing.length, 6, '§七 Commit 04 口径：6 项等权全部缺失')
    assertEq(pack.knowledge.length, 0, '无资料时 knowledge 应为空数组')
    assertEq(pack.dropped.length, 0, '没有条目就不该有 dropped')
    assertEq(pack.budget.mode, 'full', '空包不存在超预算问题')
    assertEq(pack.retrieval.mode, 'full', '预算内不做检索')
    const text = renderContextPackText(pack)
    assert(text.includes('商家资料尚未填写'), '渲染文本应显式写「商家资料尚未填写」（§一：把锅甩回可行动的事）')
    assert(text.includes('知识库为空'), '渲染文本应提示知识库为空')
    assertEq(pack.platform, null, '未指定平台应为 null')
    return `percent=0 missing=6 knowledge=0；渲染含空态提示`
  })

  // ── C3 预算内全量注入（§六 v1.10 主口径） ──
  await r.check('C3', '预算内**全量打包**：ready 条目全进包、正文完整、不做检索、不裁剪', async () => {
    const pack = await engine.buildContextPack(p1.id, { platform: 'xiaohongshu', task: '写一条小红书文案' })
    assertEq(pack.budget.mode, 'full', '预算内应为 full 模式')
    assertEq(pack.retrieval.mode, 'full', '全量模式不应触发 LIKE 检索')
    assertEq(pack.retrieval.hits, 0, '全量模式 hits 应为 0（压根没检索）')
    assertEq(pack.knowledge.length, 3, 'P1 的 3 条 ready 资料应全量进包')
    assertEq(pack.budget.knowledgeTotal, 3, 'knowledgeTotal 应为 3')
    assertEq(pack.dropped.length, 0, '全量模式不该有 dropped')
    const price = pack.knowledge.find((k) => k.id === kPrice.id)
    assert(price, '价目表应在包内')
    assert(price.content.includes('5999'), '全量模式下正文应完整（含价格数字）')
    assertEq(price.truncated, false, '全量模式下不应标截断')
    assert(price.estimatedTokens > 0, '应给出单条 token 估算')
    assertEq(pack.projectName, 'C06 摄影工作室', '应带项目名')
    return `3/3 条全量注入；usedTokens=${pack.budget.usedTokens} ≤ budget=${pack.budget.budgetTokens}`
  })

  // ── C4 只打包 ready ──
  await r.check('C4', "只打包 status='ready' 的条目（草稿态不进 AI 上下文）", async () => {
    const before = await engine.buildContextPack(p1.id)
    assertEq(before.budget.knowledgeTotal, 3, '前置：ready 应为 3 条')
    await database.request('knowledge_items.update', { keys: { id: kFaq.id }, data: { status: 'draft' } })
    try {
      const pack = await engine.buildContextPack(p1.id)
      assertEq(pack.budget.knowledgeTotal, 2, '草稿态条目不该计入 knowledgeTotal')
      assertEq(pack.knowledge.length, 2, '草稿态条目不该进包')
      assert(!pack.knowledge.some((k) => k.id === kFaq.id), 'FAQ 处于 draft，不该出现在上下文里')
    } finally {
      await database.request('knowledge_items.update', { keys: { id: kFaq.id }, data: { status: 'ready' } })
    }
    const restored = await engine.buildContextPack(p1.id)
    assertEq(restored.knowledge.length, 3, '改回 ready 后应恢复 3 条')
    return `draft 态被排除（3→2→3）`
  })

  // ── C5 空内容条目显式 dropped ──
  await r.check('C5', '内容为空的 ready 条目显式 dropped（不静默、也不占 AI 上下文）', async () => {
    const kEmpty = await knowledge.createKnowledge(p1.id, { title: '空资料', type: 'text', content: '占位' })
    await database.request('knowledge_items.update', { keys: { id: kEmpty.id }, data: { content: '   ' } })
    try {
      const pack = await engine.buildContextPack(p1.id)
      const entry = pack.dropped.find((d) => d.id === kEmpty.id)
      assert(entry, '空内容条目应出现在 dropped 里')
      assertEq(entry.reason, 'empty-content', '原因应为 empty-content')
      assertEq(pack.knowledge.length, 3, '空条目不该进包（仍是 3 条）')
      assertEq(pack.budget.knowledgeTotal, 3, '空条目不计入 knowledgeTotal')
    } finally {
      await knowledge.deleteKnowledge(p1.id, kEmpty.id)
    }
    return `空条目 reason=empty-content；不进包也不计入总数`
  })

  // ── C6 Watchlist 只取 enabled ──
  await r.check('C6', 'Watchlist 只把 enabled=1 的词喂给上下文（禁用词不进包）', async () => {
    const pack = await engine.buildContextPack(p1.id)
    const words = pack.watchlist.map((w) => w.keyword)
    assertEq(words.length, 2, '3 个词里禁用 1 个 → 应只带 2 个')
    assert(words.includes('杭州婚纱') && words.includes('旅拍'), '启用的词应在包内')
    assert(!words.includes('暂停词'), '禁用词不该出现在上下文里')
    assertEq(pack.watchlist.find((w) => w.keyword === '杭州婚纱').type, 'industry', '应带类型')
    const text = renderContextPackText(pack)
    assert(text.includes('杭州婚纱（行业）'), '渲染应带类型标签')
    return `2/3 词进包；禁用词被过滤`
  })

  // ── C7 business 摘要 + 完整度 ──
  await r.check('C7', 'business 摘要确定性 + 完整度六项等权（§七 04 口径，直接复用同一常量）', async () => {
    const pack = await engine.buildContextPack(p1.id)
    assertEq(pack.businessCompleteness.percent, 50, '填 3/6 项应得 50%')
    assertEq(pack.businessCompleteness.missing.length, 3, '应报出 3 项缺口')
    assert(
      pack.businessCompleteness.missing.includes('positioning'),
      '缺口应含定位（08「生成前主动追问缺口」靠它）'
    )
    assert(pack.businessSummary.includes('名称：光影婚纱摄影'), '摘要应含名称')
    assert(pack.businessSummary.includes('城市：杭州'), '摘要应含城市')
    assert(!pack.businessSummary.includes('电话：'), '未填字段不该出现空行')
    // 与导出的纯函数一致，且两次调用稳定
    assertEq(summarizeBusiness(pack.business), pack.businessSummary, '摘要应是同一个确定性函数')
    assert(
      JSON.stringify(computeBusinessCompleteness(pack.business)) ===
        JSON.stringify(pack.businessCompleteness),
      '完整度应是同一个确定性函数'
    )
    return `percent=50% missing=${pack.businessCompleteness.missing.join('/')}`
  })

  // ── C8 超预算 → 降级裁剪，且不静默丢 ──
  await r.check('C8', '超预算退化为裁剪：条目数守恒（included+dropped=total），未注入原因可查', async () => {
    // P2：5 条中等（各 ~600 汉字）+ 1 条超大
    for (let i = 1; i <= 5; i++) {
      await knowledge.createKnowledge(p2.id, {
        title: `中等资料 ${i}`,
        type: 'text',
        content: `第 ${i} 份资料。`.repeat(100)
      })
    }
    await knowledge.createKnowledge(p2.id, {
      title: '超大资料',
      type: 'text',
      content: '这是一份特别长的价目表说明。'.repeat(20000)
    })
    await business.upsertBusiness(p2.id, { name: '超预算商家', brand: '超预算', city: '杭州' })

    const pack = await engine.buildContextPack(p2.id, { contextWindowTokens: 4_000 })
    assertEq(pack.budget.mode, 'truncated', '超预算应降级为 truncated')
    assertEq(pack.budget.budgetTokens, 2_400, '预算应为 floor(4000×0.6)=2400')
    assert(pack.budget.knowledgeIncluded < pack.budget.knowledgeTotal, '应确实少装了几条')
    assertEq(
      pack.budget.knowledgeIncluded + pack.dropped.filter((d) => d.reason === 'budget').length,
      pack.budget.knowledgeTotal,
      '条目数守恒：进包的 + 因预算落下的 = 总数（不静默丢）'
    )
    assert(pack.dropped.length > 0, '应留下未注入清单')
    assert(pack.dropped.every((d) => d.reason === 'budget'), '未注入原因应是 budget')
    assertEq(pack.budget.knowledgeDropped, pack.dropped.length, 'knowledgeDropped 应与 dropped 数一致')
    const text = renderContextPackText(pack)
    assert(text.includes('超上下文预算'), '渲染应说明「超预算已裁剪」')
    assert(text.includes('【本次未注入的资料】'), '渲染应列出未注入的资料名（不静默）')
    return `included=${pack.budget.knowledgeIncluded}/${pack.budget.knowledgeTotal}，dropped=${pack.dropped.length}，used=${pack.budget.usedTokens}/${pack.budget.budgetTokens}`
  })

  // ── C9 单条超大：截断带显式标记 ──
  await r.check('C9', '单条超长条目在裁剪模式下按预算截断，并带显式截断标记', async () => {
    const kHuge = await knowledge.createKnowledge(p4.id, {
      title: '唯一一份超大资料',
      type: 'text',
      content: '婚纱摄影价目表。'.repeat(40000)
    })
    const pack = await engine.buildContextPack(p4.id, { contextWindowTokens: 4_000 })
    assertEq(pack.budget.mode, 'truncated', '应走裁剪')
    assertEq(pack.budget.knowledgeIncluded, 1, '这条超大资料应被截断收入（而不是整条丢掉）')
    assertEq(pack.budget.truncatedItems, 1, '应标记 1 条被截断')
    const item = pack.knowledge[0]
    assertEq(item.id, kHuge.id, '应是那条超大资料')
    assertEq(item.truncated, true, 'truncated 应为 true')
    assert(item.content.endsWith(ITEM_TRUNCATE_MARKER), '正文尾应带截断标记')
    assert(item.chars < '婚纱摄影价目表。'.repeat(40000).length, '正文应确实被截短')
    assert(pack.budget.usedTokens <= pack.budget.budgetTokens, '截断后不应超预算')
    return `截断 1 条：${item.chars} 字 / used=${pack.budget.usedTokens} ≤ ${pack.budget.budgetTokens}`
  })

  // ── C10 账本与实际渲染同源 ──
  await r.check('C10', '账本可信：渲染后的真实 token 数 ≤ 预算；reserved = window − budget', async () => {
    const cases = [
      [p1.id, { contextWindowTokens: 128_000 }],
      [p2.id, { contextWindowTokens: 4_000 }],
      [p4.id, { contextWindowTokens: 4_000 }],
      [p4.id, { contextWindowTokens: 3_000 }]
    ]
    const details = []
    for (const [pid, opts] of cases) {
      const pack = await engine.buildContextPack(pid, opts)
      const rendered = estimateTokens(renderContextPackText(pack))
      assertEq(
        rendered,
        pack.budget.usedTokens,
        `usedTokens 必须等于渲染后文本的真实估算（window=${opts.contextWindowTokens}）`
      )
      assert(
        rendered <= pack.budget.budgetTokens,
        `渲染后 ${rendered} tokens 不应超过预算 ${pack.budget.budgetTokens}（window=${opts.contextWindowTokens}）`
      )
      assertEq(
        pack.budget.reservedTokens,
        opts.contextWindowTokens - pack.budget.budgetTokens,
        'reservedTokens 应为留给对话历史/生成/平台规则的余量'
      )
      assertEq(pack.budget.remainingTokens, Math.max(0, pack.budget.budgetTokens - rendered), 'remainingTokens 应自洽')
      details.push(`w=${opts.contextWindowTokens}:${rendered}/${pack.budget.budgetTokens}`)
    }
    return details.join(' ')
  })

  // ── C11 query 命中优先 ──
  await r.check('C11', '裁剪模式按 LIKE 命中排序：命中的那条即使最旧也排第一', async () => {
    // 先建「价目表」条目（最旧，recency 排最后），再建两条无关的大条目
    await knowledge.createKnowledge(p5.id, {
      title: '套系价目表',
      type: 'text',
      content: '婚纱套系 5999 元。'.repeat(300)
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await knowledge.createKnowledge(p5.id, {
      title: '团队介绍',
      type: 'text',
      content: '我们是一支纪实风格的摄影团队。'.repeat(300)
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await knowledge.createKnowledge(p5.id, {
      title: '门店地址',
      type: 'text',
      content: '门店在杭州市西湖区某路 1 号。'.repeat(300)
    })

    const pack = await engine.buildContextPack(p5.id, { contextWindowTokens: 3_000, query: '价目表' })
    assertEq(pack.retrieval.mode, 'like', '给了 query 应走 LIKE 裁剪')
    assertEq(pack.retrieval.query, '价目表', '应回显 query')
    assert(pack.retrieval.hits >= 1, '应至少命中 1 条')
    assertEq(pack.knowledge[0].title, '套系价目表', '命中的条目应排第一（尽管它最旧）')
    assertEq(pack.knowledge[0].matchedQuery, true, '命中条目标记 matchedQuery=true')
    return `mode=like hits=${pack.retrieval.hits} 首条=${pack.knowledge[0].title}`
  })

  // ── C12 无 query 按时间回退 ──
  await r.check('C12', '超预算但没给 query：按时间（最新优先）裁剪，并标明 recency', async () => {
    const pack = await engine.buildContextPack(p5.id, { contextWindowTokens: 3_000 })
    assertEq(pack.retrieval.mode, 'recency', '无 query 应标明 recency')
    assertEq(pack.retrieval.query, null, 'query 应为 null')
    assertEq(pack.knowledge[0].title, '门店地址', '应按时间倒序（最新在前）')
    assert(pack.knowledge.every((k) => k.matchedQuery === false), 'recency 模式下不应有命中标记')
    return `mode=recency 首条=${pack.knowledge[0].title}`
  })

  // ── C13 platform 校验 ──
  await r.check('C13', 'platform 只接受 §四 的两个发布平台；非法值 VALIDATION_ERROR（不静默归一）', async () => {
    for (const platform of [...PLATFORMS]) {
      const pack = await engine.buildContextPack(p1.id, { platform })
      assertEq(pack.platform, platform, `${platform} 应被接受`)
    }
    const bad = await outcome(engine.buildContextPack(p1.id, { platform: 'weibo' }))
    assertEq(bad.ok, false, 'weibo 应被拒')
    assertEq(bad.code, 'VALIDATION_ERROR', '非法平台应是 VALIDATION_ERROR')
    assertEq(bad.details.allowed.length, 2, 'details 应给出允许值')
    const empty = await outcome(engine.buildContextPack(p1.id, { platform: '   ' }))
    assertEq(empty.code, 'VALIDATION_ERROR', '空白平台应是 VALIDATION_ERROR')
    const none = await engine.buildContextPack(p1.id)
    assertEq(none.platform, null, '不传平台应是 null（Advisor 这类不挑平台的任务）')
    return `两个合法值接受；weibo/空白 → VALIDATION_ERROR`
  })

  // ── C14 上下文窗口校验 ──
  await r.check('C14', 'contextWindowTokens 校验：非法值 VALIDATION_ERROR；合法值决定预算', async () => {
    for (const value of ['abc', 500, 0, -1, 999_999_999, 12_000.5]) {
      const bad = await outcome(engine.buildContextPack(p1.id, { contextWindowTokens: value }))
      assertEq(bad.ok, false, `${String(value)} 应被拒`)
      assertEq(bad.code, 'VALIDATION_ERROR', `${String(value)} 应是 VALIDATION_ERROR（不是 DB_ERROR）`)
    }
    const pack = await engine.buildContextPack(p1.id, { contextWindowTokens: 32_000 })
    assertEq(pack.budget.contextWindowTokens, 32_000, '窗口应生效')
    assertEq(pack.budget.budgetTokens, 19_200, 'budget 应为 floor(32000×0.6)')
    assertEq(pack.budget.ratio, CONTEXT_BUDGET_RATIO, '包内应回显比例')
    return `6 个非法值全拒；32000 → budget=19200`
  })

  // ── C15 project 不存在 / 缺 projectId ──
  await r.check('C15', 'project 不存在 → NOT_FOUND；缺 projectId → VALIDATION_ERROR（原码透传）', async () => {
    const missing = await outcome(engine.buildContextPack('00000000-0000-4000-8000-000000000000'))
    assertEq(missing.ok, false, '不存在的 project 应抛')
    assertEq(missing.code, 'NOT_FOUND', '应是 NOT_FOUND（不是 DB_ERROR）')
    const empty = await outcome(engine.buildContextPack(''))
    assertEq(empty.code, 'VALIDATION_ERROR', '空 projectId 应是 VALIDATION_ERROR')
    const undef = await outcome(engine.buildContextPack(undefined))
    assertEq(undef.code, 'VALIDATION_ERROR', 'undefined projectId 应是 VALIDATION_ERROR')
    return `NOT_FOUND / VALIDATION_ERROR 均原样透传`
  })

  // ── C16 SETUP_REQUIRED 透传（跨 bundle 错误码身份） ──
  await r.check('C16', '便携 Node 缺失 → SETUP_REQUIRED 透传（不被包装成 DB_ERROR）', async () => {
    const brokenDb = makeClient({ nodePath: join(runDir, 'no-such-node.exe'), subprocessName: 'marketing-db-worker-context-broken' })
    const broken = makeStack(brokenDb)
    const res = await outcome(broken.engine.buildContextPack(p1.id))
    assertEq(res.ok, false, '应抛错')
    assertEq(res.code, 'SETUP_REQUIRED', '应是 SETUP_REQUIRED（§五：前端据此引导去环境初始化）')
    assert(String(res.message).includes('环境初始化'), '文案应指向环境初始化')
    return `code=${res.code}（跨 bundle 身份未被吞）`
  })

  // ── C17 跨 Project 隔离 ──
  await r.check('C17', 'Context Pack 按 Project 隔离：别的商家的资料不会进包（硬规则 9）', async () => {
    const pack = await engine.buildContextPack(p1.id)
    assert(!pack.knowledge.some((k) => k.title.includes('隔壁商家')), '隔壁商家的资料不该进 P1 的包')
    const text = renderContextPackText(pack)
    assert(!text.includes('UMI-NEIGHBOR-77'), '渲染文本里不该泄漏别家暗号')
    const other = await engine.buildContextPack(p3.id)
    assertEq(other.knowledge.length, 1, 'P3 只有自己那 1 条')
    assert(other.knowledge[0].title.includes('隔壁商家'), 'P3 应看到自己的资料')
    assertEq(other.business, null, 'P3 没有 business')
    return `P1 不含别家资料；P3 只见自己 1 条`
  })

  // ── C18 稳定性与可序列化 ──
  await r.check('C18', '同输入两次构包结果一致（除 builtAt）；包可 JSON 序列化', async () => {
    const a = await engine.buildContextPack(p1.id, { platform: 'douyin', task: '口播脚本' })
    const b = await engine.buildContextPack(p1.id, { platform: 'douyin', task: '口播脚本' })
    const strip = (pack) => JSON.stringify({ ...pack, builtAt: 0 })
    assertEq(strip(a), strip(b), '两次构包应完全一致（顺序/账本/清单都不抖）')
    assert(a.builtAt > 0, '应带构建时间戳')
    const json = JSON.parse(JSON.stringify(a))
    assertEq(json.knowledge.length, a.knowledge.length, 'JSON 往返后条目数应一致')
    assertEq(json.budget.usedTokens, a.budget.usedTokens, 'JSON 往返后账本应一致')
    return `两次一致；JSON 往返无损（${json.knowledge.length} 条）`
  })

  // ── C19 主进程 wiring ──
  await r.check('C19', '主进程 wiring：构造 Context Engine 并注入四个 Manager；不新增 §五 之外的 IPC 通道', async () => {
    const mainSrc = readFileSync(mainSrcPath, 'utf-8')
    const code = flat(mainSrc)
    assert(/from '\.\/marketing\/contextEngine'/.test(code), 'main/index.ts 应引入 contextEngine')
    assert(/createContextEngine\(/.test(code), '应调用 createContextEngine')
    assert(
      /createContextEngine\(\{[\s\S]{0,400}projectManager[\s\S]{0,200}businessManager[\s\S]{0,200}knowledgeManager[\s\S]{0,200}watchlistManager/.test(
        code
      ),
      '构造时应注入四个 Manager（硬规则 9：全部显式 projectId）'
    )
    assert(/marketingContextEngine = createMarketingContextEngine\(/.test(code), '应在 whenReady 里 wiring 单例')
    assert(/export function getMarketingContextEngine\(/.test(code), '应导出 07/08 取用单例的入口（避免各处自建第二个引擎）')
    assert(/不注册 IPC|没有渲染端通道|§五 没有/.test(mainSrc), '应写明「Context Pack 不新增 IPC 通道」的理由')
    // §五 没有 context pack 通道 → 不应偷偷加
    const ipcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'marketing.ts'), 'utf-8')
    assert(
      !/marketing:context:(buildPack|previewPack|pack)/.test(ipcSrc),
      '§五 没有 context pack 通道，不应新增（如要加需先改基线）'
    )
    return `wiring 就位；context 通道仍为 Commit 03 的两条`
  })

  // ── C20 不联网 / 不碰 Gateway token（硬规则 13） ──
  await r.check('C20', 'Context Engine 不联网、不碰 GATEWAY_TOKEN（硬规则 13，剥注释后静态扫描）', async () => {
    const raw = readFileSync(contextSrcPath, 'utf-8')
    const code = stripComments(raw)
    const hits = NETWORK_PATTERNS.filter(([re]) => re.test(code)).map(([, name]) => name)
    assertEq(hits.join(','), '', `不应命中任何网络特征，实际命中: ${hits.join(',')}`)
    assert(!/GATEWAY_TOKEN|127\.0\.0\.1:3213|Bearer\s/.test(code), '不该出现 Gateway token / 端点（那是 Commit 07）')
    assert(/Commit 06/.test(raw), '文件头应标明所属提交')
    assert(/硬规则 13/.test(raw), '文件头应写明硬规则 13 的边界')
    assert(/不裁剪 business|不静默丢/.test(raw), '文件头应写明两条取舍原则')
    return `${NETWORK_PATTERNS.length} 类网络特征 0 命中；无 token/端点字面量；契约注释在位`
  })

  // ── C21 估算器口径与切片 ──
  await r.check('C21', '本地 token 估算器：口径确定、单调、切片不超预算（§六：不用 Gateway 的 usage）', async () => {
    assertEq(estimateTokens(''), 0, '空串应为 0')
    assertEq(estimateTokens(null), 0, 'null 应为 0')
    assertEq(estimateTokens('中'.repeat(100)), 100, '纯中文 1 token/字')
    assertEq(estimateTokens('a'.repeat(100)), 25, 'ASCII 1/4 token/字符')
    assertEq(estimateTokens('中'.repeat(50) + '\n'), 51, '换行按 1 计')
    assert(estimateTokens('abc'.repeat(1000)) > estimateTokens('abc'.repeat(100)), '应单调不减')
    // 切片：长度尽量长且不超预算
    const text = '价目表说明。'.repeat(2000)
    const sliced = sliceToTokenBudget(text, 500)
    assert(estimateTokens(sliced) <= 500, '切片后不应超预算')
    assert(estimateTokens(sliced) > 500 - 10, '切片应尽量用满预算（不许切太短）')
    assert(sliceToTokenBudget(text, 0) === '', '预算 0 → 空串')
    assertEq(sliceToTokenBudget(text, 1_000_000), text, '预算足够 → 原样返回')
    // 不劈开代理对（emoji）
    const emoji = '😀'.repeat(100)
    const cut = sliceToTokenBudget(emoji, 20)
    assert(!/[\uD800-\uDBFF]$/.test(cut), '不应以孤立的高代理结尾')
    assertEq(estimateTokens(''), 0, '再次确认空串')
    return `1 token/汉字、0.25/ASCII、换行 1；切片 500 → ${estimateTokens(sliced)} tokens，${sliced.length} 字符`
  })

  // ── C22 task/customer 校验（超长/类型） ──
  await r.check('C22', 'task / customer / query 的入参边界（超长与类型错误 → VALIDATION_ERROR）', async () => {
    const longTask = await outcome(engine.buildContextPack(p1.id, { task: '很长的任务'.repeat(200) }))
    assertEq(longTask.code, 'VALIDATION_ERROR', `task 超过 ${PACK_TEXT_MAX_LENGTH} 应被拒`)
    assertEq(longTask.details.max, PACK_TEXT_MAX_LENGTH, 'details 应给出上限')
    const badType = await outcome(engine.buildContextPack(p1.id, { customer: 123 }))
    assertEq(badType.code, 'VALIDATION_ERROR', 'customer 非字符串应被拒')
    const longQuery = await outcome(engine.buildContextPack(p1.id, { query: '词'.repeat(201) }))
    assertEq(longQuery.code, 'VALIDATION_ERROR', 'query 超长应被拒')
    const okPack = await engine.buildContextPack(p1.id, { task: '  写文案  ', customer: null })
    assertEq(okPack.task, '写文案', 'task 应 trim')
    assertEq(okPack.customer, null, 'customer 为 null 应保留 null')
    assertEq(KNOWLEDGE_ITEM_MIN_TOKENS, 120, '裁剪模式下单条最小留存 token 应为 120')
    return `超长/类型错误全拒；trim 与 null 语义正确`
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
  bundle: contextPath,
  dataDir,
  nodePath,
  logSample: logs.slice(0, 20)
})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-context.json'), result)
console.log('结果已写入 test/accept-result-context.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
