// test/advisor.accept.mjs —— Commit 08 验收（主进程半边）：AI Advisor（grounded 问答 + 扩词候选）
//
// **打真实源码**：esbuild 把 electron/main/marketing/advisorManager.ts（连带真 ContextEngine、
// 真 GatewayClient、真四个 Manager）bundle 成临时 ESM，在纯 Node 里 import；
// HTTP 侧用**真 Node http 服务端**扮演 Gateway（真 socket、真 SSE），不注入假 fetch。
//
// 覆盖点（对齐 PLAN-2.0.md §一 产品智能原则 / §六「AI Advisor 定义」/ §七 08 行）：
//   - 每轮请求 = Context Pack（06）+ 用户消息；`user=conv:<projectId>:<conversation_key>`
//   - **不回灌历史**：请求体只有 system + user 两条（历史靠 sticky `user=`，§六 结论 A）
//   - 事实护栏在位（只能引用资料/资料没有就明说）+ **资料缺口显式入 prompt**（生成前主动追问缺口）
//   - 空资料也能问；超预算裁剪在 prompt 里可见（不静默）
//   - 流式增量顺序正确；`cancel()` 真断上游（「停止生成」名副其实）
//   - 扩词候选：脏输出容忍（围栏/夹解释）、去重、排除已有词、剔非法 type、上限收敛
//   - 错误码透传（401 → OPENCLAW_AUTH_ERROR，不被包装成 DB_ERROR）
//
// 用法：node test/advisor.accept.mjs    （加 --keep-tmp 保留临时目录；npm run accept:advisor）

import { createServer } from 'node:http'
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
const runDir = join(tmpDir, `advisor-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')
const EXTERNALS = ['mammoth', 'exceljs']

const advisorPath = bundleEntry('electron/main/marketing/advisorManager.ts', 'advisor-manager.mjs', {
  externals: EXTERNALS
})
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'advisor-context-engine.mjs', {
  externals: EXTERNALS
})
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'advisor-gateway-client.mjs')
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'advisor-business-manager.mjs', {
  externals: EXTERNALS
})
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'advisor-knowledge-manager.mjs', {
  externals: EXTERNALS
})
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'advisor-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'advisor-database.mjs')

const advMod = await import(pathToFileURL(advisorPath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const { AdvisorManager, createAdvisorManager, ADVISOR_GUARDRAILS, parseWatchCandidates, WATCH_CANDIDATE_PROMPT } =
  advMod
const { createContextEngine } = ctxMod
const { createGatewayClient } = gwMod
const { DatabaseClient } = dbMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

/** 假 Gateway：真 http 服务端；SSE 给流式问答，JSON 给非流式（扩词） */
function createFakeGateway() {
  const state = {
    mode: 'ok', // ok | auth
    chunkCount: 5,
    chunkDelayMs: 2,
    chatBodies: [],
    nonStreamText: '[]',
    clientClosedEarly: 0,
    chunkFramesSent: 0,
    port: 0
  }
  const server = createServer(async (req, res) => {
    if ((req.url || '').startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'live' }))
      return
    }
    if ((req.url || '').startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'openclaw' }] }))
      return
    }
    if ((req.url || '').startsWith('/v1/chat/completions')) {
      let raw = ''
      for await (const c of req) raw += c
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        /* 由断言暴露 */
      }
      state.chatBodies.push(body)
      if (state.mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'unauthorized' }))
        return
      }
      if (body && body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'openclaw',
            choices: [{ message: { role: 'assistant', content: state.nonStreamText } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let finished = false
      res.on('close', () => {
        if (!finished) state.clientClosedEarly += 1
      })
      for (let i = 1; i <= state.chunkCount; i++) {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: `答${i}` } }] })}\n\n`)
        state.chunkFramesSent += 1
        await sleep(state.chunkDelayMs)
      }
      res.write('data: [DONE]\n\n')
      finished = true
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
      return `http://127.0.0.1:${state.port}`
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
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

const r = new Recorder('advisor（AI Advisor 主进程半边：grounded 问答 + 扩词候选，打真 advisorManager.ts）')
const servers = []
const ctx = {}

try {
  const database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-advisor-test',
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
    // 与生产（main/index.ts）同口径：会话隔离键由主进程从 projects 表取，渲染端碰不到
    conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key,
    logger
  })
  clients.add(gateway)
  const advisor = createAdvisorManager({ contextEngine, gateway, watchlistManager: watchlist, logger })

  // ── 造数据 ──
  const project = await projects.createProject({ name: 'C08 光影摄影', industry: '摄影' })
  await business.upsertBusiness(project.id, {
    name: '光影婚纱摄影',
    city: '杭州',
    positioning: '轻奢外景纪实',
    tone: '亲切专业'
  })
  await knowledge.createKnowledge(project.id, {
    title: '套系价目表',
    type: 'text',
    content: '婚纱套系 5999 元，含 30 张精修、2 套服装；亲子套系 1999 元。'
  })
  await knowledge.createKnowledge(project.id, {
    title: '门店介绍',
    type: 'markdown',
    content: '光影婚纱摄影成立于 2015 年，团队 12 人，主打轻奢外景与纪实风。'
  })
  await watchlist.addWatch(project.id, '杭州婚纱', 'industry')
  const emptyProject = await projects.createProject({ name: 'C08 空资料商家', industry: '摄影' })
  const bigProject = await projects.createProject({ name: 'C08 超预算商家', industry: '摄影' })
  await knowledge.createKnowledge(bigProject.id, {
    title: '超大资料',
    type: 'text',
    content: '价目表说明。'.repeat(30000)
  })

  // ── A1 契约与依赖校验 ──
  await r.check('A1', 'advisorManager 可纯 Node import；依赖缺失即 VALIDATION_ERROR；不 import electron', async () => {
    assert(typeof AdvisorManager === 'function', '应导出 AdvisorManager')
    assertEq(typeof createAdvisorManager, 'function', '应导出工厂')
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'advisorManager.ts'), 'utf-8')
    const bundled = readFileSync(advisorPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(src), '源码不应 import electron')
    assert(!/from\s*["']electron["']/.test(bundled), 'bundle 内不应存在 electron')
    assert(!/\bfetch\s*\(|node:(http|https|net)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), '本模块不得自己发 HTTP（出站只经 07）')
    const bad = await outcome(Promise.resolve().then(() => createAdvisorManager({ contextEngine })))
    assertEq(bad.code, 'VALIDATION_ERROR', '缺依赖应 VALIDATION_ERROR')
    assert(ADVISOR_GUARDRAILS.includes('不得编造'), '护栏文案应包含「不得编造」')
    return '依赖注入 + 无 electron + 无自建 HTTP'
  })

  // ── A2 请求组装（Context Pack + 会话隔离 + 不回灌历史） ──
  await r.check('A2', 'ask 组装：Context Pack + `user=conv:<pid>:<key>` + 只有 system/user 两条（不回灌历史）', async () => {
    const before = fake.state.chatBodies.length
    const turn = await advisor.ask({ projectId: project.id, question: '客户嫌贵怎么回？', platform: 'xiaohongshu' })
    // 把流跑完（让请求体确实到达服务端）
    const deltas = []
    for await (const d of turn.handle.iterator) deltas.push(d)
    await turn.handle.result
    assertEq(deltas.length, 5, '应收到 5 个增量')
    assertEq(deltas.map((d) => d.delta).join(''), '答1答2答3答4答5', '增量应按序拼接')

    const body = fake.state.chatBodies[fake.state.chatBodies.length - 1]
    const expectedUser = `conv:${project.id}:${project.conversation_key}`
    assertEq(body.user, expectedUser, 'user 必须是 conv:<projectId>:<conversation_key>（§六 会话隔离）')
    assertEq(body.stream, true, '面板必须走流式（§六 首字 1.27s vs 冷启动 80.3s）')
    assertEq(body.messages.length, 2, '每轮只发 system + user（历史由 sticky user= 承载，§六 结论 A）')
    assertEq(body.messages[0].role, 'system', '第一条应是 system')
    assertEq(body.messages[1].role, 'user', '第二条应是 user')
    assertEq(body.messages[1].content, '客户嫌贵怎么回？', 'user 消息应是原问题')
    const sys = body.messages[0].content
    assert(sys.includes('只能依据下面给出的商家资料回答'), 'system 应含事实护栏')
    assert(sys.includes('光影婚纱摄影'), 'system 应含商家资料（名称）')
    assert(sys.includes('5999'), 'system 应含知识库正文（价格）')
    assert(sys.includes('杭州婚纱'), 'system 应含关注词（§六 Context Pack 含 watchlist）')
    assert(sys.includes('本次面向的发布平台：xiaohongshu'), 'system 应标明本次平台')
    assertEq(fake.state.chatBodies.length, before + 1, '一轮提问只应发一次请求')
    return `user=${expectedUser.slice(0, 22)}…；messages=2；system 含资料+价格+关注词+平台`
  })

  // ── A3 资料缺口显式入 prompt ──
  await r.check('A3', '资料缺口（missing）显式入 prompt（§一「生成前主动追问缺口」）', async () => {
    const turn = await advisor.ask({ projectId: project.id, question: '给我三个选题角度' })
    const cp = turn.pack.businessCompleteness
    assert(cp.missing.length > 0, '前置：该商家应有缺口')
    assert(
      turn.systemPrompt.includes('资料缺口列表：') && turn.systemPrompt.includes(cp.missing[0]),
      'system 应列出缺口字段名'
    )
    turn.handle.cancel()
    await turn.handle.result
    assert(turn.systemPrompt.includes('建议补充'), '护栏里应要求末尾给「建议补充」')
    return `缺口 ${cp.missing.join('/')} 已入 prompt`
  })

  // ── A4 空资料也能问 ──
  await r.check('A4', '空资料商家（无 business / 无 knowledge）也能提问：不抛错且明示「没资料」', async () => {
    const turn = await advisor.ask({ projectId: emptyProject.id, question: '我该怎么写文案？' })
    turn.handle.cancel()
    await turn.handle.result
    assert(turn.systemPrompt.includes('商家资料尚未填写'), 'system 应明示商家资料未填')
    assert(turn.systemPrompt.includes('知识库为空'), 'system 应明示知识库为空')
    assertEq(turn.pack.knowledge.length, 0, '空知识库不该有内容')
    return '空资料可提问，且明示缺口'
  })

  // ── A5 超预算裁剪在 prompt 里可见 ──
  await r.check('A5', '超预算裁剪在 prompt 里可见（不静默丢资料）', async () => {
    const engineSmall = createContextEngine({
      projectManager: projects,
      businessManager: business,
      knowledgeManager: knowledge,
      watchlistManager: watchlist,
      logger,
      defaultContextWindowTokens: 3_000
    })
    const advisorSmall = createAdvisorManager({ contextEngine: engineSmall, gateway, watchlistManager: watchlist, logger })
    const turn = await advisorSmall.ask({ projectId: bigProject.id, question: '价目表里最贵的是哪个？' })
    turn.handle.cancel()
    await turn.handle.result
    assertEq(turn.pack.budget.mode, 'truncated', '超预算应走裁剪')
    assert(turn.systemPrompt.includes('超上下文预算'), 'prompt 应说明已裁剪')
    assert(turn.systemPrompt.includes('未注入'), 'prompt 应提示有资料未注入')
    assert(turn.systemPrompt.includes('知识库原文'), '被截断条目应带截断标记/提示')
    return `mode=truncated，prompt 明示裁剪与未注入`
  })

  // ── A6 「停止生成」真断上游 ──
  await r.check('A6', '停止生成：cancel() 真断上游（服务端观测断连）+ aborted:true', async () => {
    fake.state.chunkCount = 60
    fake.state.chunkDelayMs = 15
    fake.state.clientClosedEarly = 0
    fake.state.chunkFramesSent = 0
    try {
      const turn = await advisor.ask({ projectId: project.id, question: '写一段长文案' })
      const seen = []
      for await (const d of turn.handle.iterator) {
        seen.push(d)
        if (seen.length === 2) turn.handle.cancel()
      }
      const res = await turn.handle.result
      assertEq(res.aborted, true, 'aborted 应为 true')
      await sleep(120)
      assertEq(seen.length <= 3, true, 'cancel 后不应继续产出')
      assertEq(fake.state.clientClosedEarly >= 1, true, '服务端应观测到断连（上游真断，不白烧 token）')
      return `产出 ${seen.length} 个增量后中止；服务端断连 ${fake.state.clientClosedEarly} 次，已发 ${fake.state.chunkFramesSent}/60 帧`
    } finally {
      fake.state.chunkCount = 5
      fake.state.chunkDelayMs = 2
    }
  })

  // ── A7 扩词候选（脏输出容忍 + 清洗） ──
  await r.check('A7', '扩词候选：容忍围栏/夹解释，去重、剔非法 type、排除已有词、上限收敛', async () => {
    // 真的超过 30 字（04 的长度上限）——上版样本只有 28 字，把「本来就不会丢」误判成了丢弃
    const LONG_WORD = '这是一个特别特别特别长的关注词'.repeat(3)
    fake.state.nonStreamText = [
      '好的，这是我推荐的关注词：',
      '```json',
      JSON.stringify([
        { keyword: '杭州婚纱', type: 'industry', reason: '已有词' },
        { keyword: '旅拍', type: 'product', reason: '客群常搜' },
        { keyword: '旅拍', type: 'product', reason: '模型自己重复' },
        { keyword: '备婚人群', type: 'audience', reason: '目标客群' },
        { keyword: '临平', type: 'region', reason: '附近区域' },
        { keyword: '国庆', type: 'season', reason: '非法 type' },
        { keyword: LONG_WORD, type: 'industry', reason: '超长' }
      ]),
      '```',
      '希望有帮助！'
    ].join('\n')

    const res = await advisor.suggestWatchlist(project.id, { count: 5 })
    const usable = res.candidates.filter((c) => !c.existing)
    const existing = res.candidates.filter((c) => c.existing)
    assertEq(existing.length, 1, '已有词应被标 existing 并单独回')
    assertEq(existing[0].keyword, '杭州婚纱', '已有词应是它')
    assertEq(
      usable.length,
      4,
      `可用候选应为 4 个（旅拍/备婚人群/临平/国庆），实际 ${usable.length}：${usable.map((c) => c.keyword).join('/')}`
    )
    assert(usable.some((c) => c.keyword === '旅拍'), '「旅拍」应入选')
    const dup = usable.filter((c) => c.keyword === '旅拍').length
    assertEq(dup, 1, '模型重复的候选应去重')
    const season = res.candidates.find((c) => c.keyword === '国庆')
    assertEq(season.type, null, '非法 type 应被归一为 null（词保留，但不把 season 喂进库）')
    assert(!res.candidates.some((c) => c.keyword === LONG_WORD), '超过 30 字的候选必须被丢弃')
    assert(res.candidates.every((c) => c.keyword.length <= 30), '候选词长必须都在 30 字以内')
    // 已有 1 词 → 还能加 9 个；要 5 个也只会给出 ≤5 个可用
    assert(usable.length <= 5, '不得超过请求的候选数')
    return `可用 ${usable.length}（弃重复/非法/超长），已有 1 个单独标记`
  })

  // ── A8 扩词容错：不可解析要报错，不伪装成「没有候选」 ──
  await r.check('A8', '扩词脏输出不可解析 → VALIDATION_ERROR(candidates-unparsable)，不静默给空列表', async () => {
    fake.state.nonStreamText = '抱歉，我不太确定你想关注什么。'
    const res = await outcome(advisor.suggestWatchlist(project.id, { count: 5 }))
    assertEq(res.ok, false, '不可解析应抛错')
    assertEq(res.code, 'VALIDATION_ERROR', '应是 VALIDATION_ERROR')
    assertEq(res.details.reason, 'candidates-unparsable', '应带可分支的 reason')
    // 纯函数层直接断言（同一实现）
    const direct = await outcome(Promise.resolve().then(() => parseWatchCandidates('完全不是 JSON')))
    assertEq(direct.code, 'VALIDATION_ERROR', 'parseWatchCandidates 同样应抛')
    assert(WATCH_CANDIDATE_PROMPT.includes('只输出 JSON 数组'), '扩词指令应写死 JSON 口径')
    return `${res.code}/${res.details.reason}`
  })

  // ── A9 参数校验 ──
  await r.check('A9', '参数校验：空/超长问题、缺失 projectId、非法平台 → VALIDATION_ERROR', async () => {
    const cases = [
      [advisor.ask({ projectId: project.id, question: '   ' }), '空问题'],
      [advisor.ask({ projectId: project.id, question: '好'.repeat(1001) }), '超长问题'],
      [advisor.ask({ projectId: '', question: 'hi' }), '缺 projectId'],
      [advisor.ask({ projectId: project.id, question: 'hi', platform: 'weibo' }), '非法平台']
    ]
    const seen = []
    for (const [p, name] of cases) {
      const res = await outcome(p)
      assertEq(res.code, 'VALIDATION_ERROR', `${name} 应 VALIDATION_ERROR`)
      seen.push(name)
    }
    const noPlatform = await advisor.ask({ projectId: project.id, question: '随便聊聊' })
    assertEq(noPlatform.platform, null, '不传平台应为 null')
    assert(!noPlatform.systemPrompt.includes('本次面向的发布平台'), '不传平台时不该出现平台行')
    noPlatform.handle.cancel()
    await noPlatform.handle.result
    return `${seen.length} 个非法入参被拒；平台可缺省`
  })

  // ── A10 错误码透传 ──
  await r.check('A10', '错误码透传：Gateway 401 → OPENCLAW_AUTH_ERROR（不被包装成 DB_ERROR）', async () => {
    fake.state.mode = 'auth'
    try {
      const turn = await advisor.ask({ projectId: project.id, question: '你好' })
      const res = await outcome(turn.handle.result)
      assertEq(res.ok, false, '鉴权失败应失败')
      assertEq(res.code, 'OPENCLAW_AUTH_ERROR', '应是 OPENCLAW_AUTH_ERROR')
      return `${res.code}（原码上抛）`
    } finally {
      fake.state.mode = 'ok'
    }
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

const result = r.toJSON({ bundle: advisorPath, dataDir, nodePath, logSample: logs.slice(0, 10) })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-advisor.json'), result)
console.log('结果已写入 test/accept-result-advisor.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
