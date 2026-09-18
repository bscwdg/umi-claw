// test/platform.accept.mjs —— Commit 10 验收：双平台工作流（小红书 + 抖音规则模板注入）
//
// **打真实源码**：esbuild bundle 真 platformRules.ts / contextEngine.ts / contentManager.ts /
// advisorManager.ts（连带真 Manager / DatabaseClient），HTTP 侧真 Node http 服务扮演 Gateway。
//
// 覆盖点（对齐 PLAN-2.0.md §七 Commit 10 / §六 Context Pack / 硬规则 10、12、13）：
//   P1 模板本体：两平台规则齐备、边界写死（抖音「不做视频」、小红书图文笔记）、非法平台拒绝
//   P2 09 生成组装：三角度每路 user 都带本平台规则区块、互不串味；prompt 快照含规则
//   P3 06 引擎挂载：pack.platformRule 与模板同源；不指定平台为 null；规则不进 60% 预算账本
//   P4 08 Advisor：带平台时 system 追加规则区块；不带平台时不出现
//   P5 抖音端到端：真 generate 三路请求 + 落库版本 prompt 快照均为抖音口径
//   P6 小红书端到端：请求与快照为小红书口径，且商家资料（价格）仍在
//   P7 静态契约：规则不上 IPC / 不扩 worker 白名单 / UI 双平台提示齐备 / §六 六键不变
//
// 用法：node test/platform.accept.mjs   （npm run accept:platform）

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertDeepEq,
  assertEq,
  bundleEntry,
  printResult,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath,
  writeJson
} from './_lib.mjs'

const repoRoot = join(__dirname, '..')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, 'platform-' + Date.now())
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const EXTERNALS = ['mammoth', 'exceljs']

const rulesPath = bundleEntry('electron/main/marketing/platformRules.ts', 'platform-rules.mjs')
const contentPath = bundleEntry('electron/main/marketing/contentManager.ts', 'platform-content-manager.mjs', {
  externals: EXTERNALS
})
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'platform-context-engine.mjs', {
  externals: EXTERNALS
})
const advisorPath = bundleEntry('electron/main/marketing/advisorManager.ts', 'platform-advisor-manager.mjs', {
  externals: EXTERNALS
})
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'platform-gateway-client.mjs')
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'platform-business-manager.mjs', {
  externals: EXTERNALS
})
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'platform-knowledge-manager.mjs', {
  externals: EXTERNALS
})
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'platform-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'platform-database.mjs')

const rulesMod = await import(pathToFileURL(rulesPath).href)
const contentMod = await import(pathToFileURL(contentPath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const advMod = await import(pathToFileURL(advisorPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const { PLATFORM_LABELS, getPlatformRule, getPlatformScope, renderPlatformRuleSection } = rulesMod
const {
  createContentManager,
  buildGenerationMessages,
  buildPromptSnapshot,
  CONTENT_GUARDRAILS,
  CONTENT_GENERATION_ANGLES
} = contentMod
const { createContextEngine, CONTEXT_PACK_KEYS, PLATFORMS, estimateTokens, renderContextPackText } = ctxMod
const { createAdvisorManager } = advMod
const { createGatewayClient } = gwMod
const { DatabaseClient } = dbMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

// ── 假 Gateway（真 http + 真 SSE；记录全部请求体） ─────────────────────────────

function createFakeGateway() {
  const state = { bodies: [], port: 0 }
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    if (url.startsWith('/health') || url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(url.includes('models') ? JSON.stringify({ data: [{ id: 'openclaw' }] }) : '{"ok":true}')
      return
    }
    if (url.startsWith('/v1/chat/completions')) {
      let raw = ''
      for await (const c of req) raw += c
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        /* 由断言暴露 */
      }
      const userMsg = Array.isArray(body?.messages) ? body.messages.find((m) => m.role === 'user')?.content : null
      const parts = Array.isArray(userMsg) ? userMsg : []
      const textAll = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
      state.bodies.push({
        user: body?.user ?? null,
        system: String(body?.messages?.[0]?.content ?? ''),
        instruction: textAll
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: ' + JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: '成稿A' } }] }) + '\n\n')
      await sleep(2)
      res.write('data: ' + JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: '成稿B' } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  return {
    state,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      state.port = server.address().port
      return 'http://127.0.0.1:' + state.port
    },
    async close() {
      await new Promise((r) => server.close(() => r()))
    }
  }
}

async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e) }
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

async function drainAll(streams) {
  await Promise.all(
    streams.map(async (h) => {
      for await (const d of h.iterator) {
        if (!d) break
      }
    })
  )
}

const r = new Recorder('platform（Commit 10：双平台规则模板注入，打真 platformRules/contextEngine/contentManager/advisorManager）')
const servers = []
const ctx = {}

try {
  const database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-platform-test',
    requestTimeoutMs: 30_000
  })
  clients.add(database)

  const fake = createFakeGateway()
  servers.push(fake)
  const baseUrl = await fake.listen()

  const projects = projMod.createProjectManager({ database, dataDir, logger })
  const business = bizMod.createBusinessManager({ database, logger })
  const watchlist = bizMod.createWatchlistManager({ database, logger })
  const knowledge = knowMod.createKnowledgeManager({ database, dataDir, logger })
  const contextEngine = createContextEngine({
    projectManager: projects,
    businessManager: business,
    knowledgeManager: knowledge,
    watchlistManager: watchlist,
    logger
  })
  const gateway = createGatewayClient({
    baseUrl,
    token: '***',
    models: { text: 'openclaw' },
    conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key,
    logger
  })
  clients.add(gateway)
  const manager = createContentManager({ database, contextEngine, gateway, logger })
  const advisor = createAdvisorManager({ contextEngine, gateway, watchlistManager: watchlist, logger })

  const project = await projects.createProject({ name: '10 知秋女装', industry: '女装' })
  await business.upsertBusiness(project.id, {
    name: '知秋女装',
    city: '杭州',
    positioning: '通勤真丝女装',
    target_customer: '28-40 岁职场女性'
  })
  await knowledge.createKnowledge(project.id, {
    title: '秋款价目',
    type: 'text',
    content: '真丝衬衫秋款 399 元两件；线下门店试穿，杭州湖滨银泰。'
  })

  // ── P1 模板本体 ──
  await r.check('P1', '两套规则齐备：小红书=图文笔记三件套、抖音=口播三件套且写死「不做视频」；均人工复制发布；非法平台 VALIDATION_ERROR', async () => {
    assertDeepEq(PLATFORM_LABELS, { xiaohongshu: '小红书', douyin: '抖音' }, '平台展示名')
    for (const p of PLATFORMS) {
      const rule = getPlatformRule(p)
      assert(rule.length >= 150, p + ' 规则正文不应过短（实际 ' + rule.length + ' 字）')
      assert(rule.includes('话题标签'), p + ' 规则要有话题标签口径')
      assert(rule.includes('绝对化用语'), p + ' 规则要有合规红线')
      assert(rule.includes('人工复制发布'), p + ' 规则要写死人工复制发布（硬规则 10）')
      assert(renderPlatformRuleSection(p).includes('【发布平台规则：' + PLATFORM_LABELS[p] + '（' + p + '）】'), p + ' 区块头')
    }
    const xhs = getPlatformRule('xiaohongshu')
    const dy = getPlatformRule('douyin')
    assert(xhs.includes('图文笔记'), '小红书：图文笔记形态')
    assert(!xhs.includes('口播脚本'), '小红书模板不得混入抖音口播口径')
    assert(dy.includes('口播脚本'), '抖音：口播脚本')
    assert(dy.includes('不做视频'), '抖音：一期不做视频边界写死')
    assert(!dy.includes('图文笔记'), '抖音模板不得混入小红书图文口径')
    assert(getPlatformScope('douyin').includes('口播脚本'), 'scope 给 UI/日志的一句话')
    const bad = await outcome(Promise.resolve().then(() => getPlatformRule('weibo')))
    assert(!bad.ok && bad.code === 'VALIDATION_ERROR', '非法平台 VALIDATION_ERROR')
    const src = stripComments(readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'platformRules.ts'), 'utf-8'))
    assert(!/from\s*["']electron["']/.test(src), '不 import electron')
    assert(!/\bfetch\s*\(|node:(http|https|net)/.test(src), '不发 HTTP')
    assert(!/database\.request|db\.request|INSERT INTO/.test(src), '不落库（纯数据模块）')
    return '两平台模板齐备、边界与合规写死、非法平台拒绝 ✓'
  })

  // ── P2 09 生成组装（纯函数，真 pack） ──
  await r.check('P2', 'buildGenerationMessages：三角度每路都带本平台规则区块、互不串味；快照含规则；护栏引用平台规则', async () => {
    const packX = await contextEngine.buildContextPack(project.id, {
      platform: 'xiaohongshu',
      task: 'content-draft',
      query: '秋款上新'
    })
    const packD = await contextEngine.buildContextPack(project.id, {
      platform: 'douyin',
      task: 'content-draft',
      query: '秋款上新'
    })
    for (const angle of CONTENT_GENERATION_ANGLES) {
      const mx = buildGenerationMessages(packX, 'xiaohongshu', '秋款上新', angle, '')
      const ux = mx[1].content.map((p) => p.text).join('\n')
      assert(ux.includes('发布平台：xiaohongshu'), '小红书路保留平台 id 行')
      assert(ux.includes('【发布平台规则：小红书'), '小红书路注入规则区块')
      assert(ux.includes('图文笔记') && !ux.includes('口播脚本'), '小红书路不串抖音口径')
      const md = buildGenerationMessages(packD, 'douyin', '秋款上新', angle, '')
      const ud = md[1].content.map((p) => p.text).join('\n')
      assert(ud.includes('口播脚本') && ud.includes('不做视频'), '抖音路口播 + 不做视频')
      assert(!ud.includes('图文笔记'), '抖音路不串小红书口径')
    }
    assert(CONTENT_GUARDRAILS.includes('发布平台规则'), '护栏第 3 条指向平台规则结构')
    const snapX = buildPromptSnapshot(packX, 'xiaohongshu', '秋款上新')
    const snapD = buildPromptSnapshot(packD, 'douyin', '秋款上新')
    assert(snapX.includes('【发布平台规则：小红书') && snapX.includes('图文笔记'), '小红书快照含规则（当时提示词可复盘）')
    assert(snapD.includes('口播脚本') && snapD.includes('不做视频'), '抖音快照含规则')
    ctx.packX = packX
    ctx.packD = packD
    return '三角度 × 两平台规则注入正确；快照留存 ✓'
  })

  // ── P3 06 引擎挂载与预算边界 ──
  await r.check('P3', 'pack.platformRule 与模板同源；不带平台为 null；规则不进 60% 预算账本（六键契约不变）', async () => {
    assertEq(ctx.packX.platformRule, getPlatformRule('xiaohongshu'), 'pack 挂小红书规则')
    assertEq(ctx.packD.platformRule, getPlatformRule('douyin'), 'pack 挂抖音规则')
    const none = await contextEngine.buildContextPack(project.id, {})
    assertEq(none.platformRule, null, '未指定平台 → platformRule=null')
    const bad = await outcome(contextEngine.buildContextPack(project.id, { platform: 'weibo' }))
    assertEq(bad.code, 'VALIDATION_ERROR', '非法平台仍由引擎拒绝')
    const text = renderContextPackText(ctx.packX)
    assert(!text.includes('【发布平台规则'), '规则不进 renderContextPackText（预算文本）')
    const giant = { ...ctx.packX, platformRule: '字'.repeat(20000) }
    assertEq(
      estimateTokens(renderContextPackText(giant)),
      estimateTokens(text),
      '再大的模板也不改变 60% 预算账本（模板属预留 40%）'
    )
    assertDeepEq([...CONTEXT_PACK_KEYS], ['business', 'knowledge', 'watchlist', 'customer', 'platform', 'task'], '§六 六键契约不变（platformRule 是附加字段）')
    return 'platformRule 挂载 + 预算边界 + 六键不变 ✓'
  })

  // ── P4 08 Advisor ──
  await r.check('P4', 'Advisor system：带平台追加规则区块（保留原平台行）；不带平台不出现规则', async () => {
    const sysD = advisor.buildSystemPrompt(ctx.packD, 'douyin')
    assert(sysD.includes('本次面向的发布平台：douyin'), '保留原平台行（A2 口径）')
    assert(sysD.includes('口播脚本') && sysD.includes('不做视频'), '抖音规则进 Advisor system')
    const sysX = advisor.buildSystemPrompt(ctx.packX, 'xiaohongshu')
    assert(sysX.includes('图文笔记') && !sysX.includes('口播脚本'), '小红书规则进 Advisor system 且不串味')
    const none = await contextEngine.buildContextPack(project.id, { task: 'advisor-qa' })
    const sysNone = advisor.buildSystemPrompt(none, null)
    assert(!sysNone.includes('【发布平台规则'), '不挑平台的任务不注入规则')
    return 'Advisor 规则注入/缺省正确 ✓'
  })

  // ── P5 抖音端到端 ──
  await r.check('P5', '真 generate（抖音）：三路请求都带抖音规则、不串小红书；版本 prompt 快照落库抖音规则', async () => {
    const before = fake.state.bodies.length
    const run = await manager.generate(project.id, { platform: 'douyin', topic: '秋款真丝衬衫' })
    await drainAll(run.streams)
    const results = await Promise.all(run.streams.map((s) => s.result))
    assertEq(results.every((x) => !x.aborted), true, '三路正常完成')
    const bodies = fake.state.bodies.slice(before)
    assertEq(bodies.length, 3, '恰好 3 次请求')
    for (const b of bodies) {
      assert(b.instruction.includes('【发布平台规则：抖音'), '请求带抖音规则区块')
      assert(b.instruction.includes('口播脚本') && b.instruction.includes('不做视频'), '抖音成稿口径')
      assert(!b.instruction.includes('图文笔记'), '不得混入小红书口径')
      assert(b.instruction.includes('399'), '商家资料（价格）仍注入')
    }
    const versions = await manager.listVersions(project.id, run.contentId)
    assertEq(versions.length, 3, '三路各落一版')
    for (const v of versions) {
      assertEq(v.source, 'ai', 'source=ai')
      assert(v.prompt.includes('口播脚本') && v.prompt.includes('不做视频'), '版本快照含抖音规则')
      assert(v.prompt.includes('【发布平台规则：抖音'), '快照含规则区块头')
    }
    const row = await manager.getContent(project.id, run.contentId)
    assertEq(row.platform, 'douyin', '草稿平台落库 douyin')
    return '三路抖音口径正确 + 版本快照留存 ✓'
  })

  // ── P6 小红书端到端 ──
  await r.check('P6', '真 generate（小红书）：三路请求 + 快照均小红书口径，商家资料不丢', async () => {
    const before = fake.state.bodies.length
    const run = await manager.generate(project.id, { platform: 'xiaohongshu', topic: '湖滨探店' })
    await drainAll(run.streams)
    const bodies = fake.state.bodies.slice(before)
    assertEq(bodies.length, 3, '恰好 3 次请求')
    for (const b of bodies) {
      assert(b.instruction.includes('【发布平台规则：小红书'), '请求带小红书规则区块')
      assert(b.instruction.includes('图文笔记'), '小红书成稿口径')
      assert(!b.instruction.includes('口播脚本'), '不得混入抖音口径')
      assert(b.instruction.includes('399'), '商家资料（价格）仍注入')
    }
    const versions = await manager.listVersions(project.id, run.contentId)
    for (const v of versions) {
      assert(v.prompt.includes('图文笔记') && v.prompt.includes('【发布平台规则：小红书'), '版本快照含小红书规则')
    }
    assertEq((await manager.getContent(project.id, run.contentId)).platform, 'xiaohongshu', '草稿平台落库 xiaohongshu')
    return '三路小红书口径正确 ✓'
  })

  // ── P7 静态契约 ──
  await r.check('P7', '规则不上 IPC（§五 边界）/ 不扩 worker 白名单 / 渲染端不直接引主进程模块 / UI 双平台提示齐备', () => {
    const read = (rel) => readFileSync(join(repoRoot, rel), 'utf-8')
    const preload = read('electron/preload/index.ts') + read('electron/preload/index.d.ts')
    assert(!preload.includes('platformRule') && !preload.includes('PlatformRule'), 'preload 不暴露规则（无渲染端通道）')
    assert(!read('electron/main/ipc/content.ts').includes('platformRule'), 'content IPC 不新增规则面')
    assert(!read('resources/database/db-worker.mjs').includes('platform_rule'), 'worker 白名单零扩展（无 platform_rule 方法）')
    const srcRenderer = []
    for (const f of ['src/views/marketing/ContentCenter.vue', 'src/views/marketing/AdvisorPanel.vue']) {
      srcRenderer.push(read(f))
    }
    assert(!srcRenderer.some((s) => s.includes('marketing/platformRules')), '渲染端不引主进程规则模块')
    const vue = read('src/views/marketing/ContentCenter.vue')
    for (const marker of ['图文笔记', '口播脚本', '不做视频', '人工复制发布']) {
      assert(vue.includes(marker), 'UI 平台提示含：' + marker)
    }
    return '规则纯主进程内部数据 + worker 零改动 + UI 提示齐备 ✓'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const s of servers) {
    try {
      await s.close()
    } catch {
      /* 忽略 */
    }
  }
  for (const c of [...clients]) {
    try {
      if (typeof c.dispose === 'function') await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(200)
}

const result = r.toJSON({ bundle: rulesPath, dataDir, nodePath, logSample: logs.slice(0, 10) })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-platform.json'), result)
console.log('结果已写入 test/accept-result-platform.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
