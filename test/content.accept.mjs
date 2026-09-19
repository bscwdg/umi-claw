// test/content.accept.mjs —— Commit 09 验收：Content Center（一次 3 版供选 → 编辑 → 版本 → 人工审核）
//
// **打真实源码**：esbuild bundle 真 contentManager.ts（连带真 ContextEngine / GatewayClient /
// 四 Manager / DatabaseClient），HTTP 侧真 Node http 服务端扮演 Gateway（真 SSE、真断连）；
// 库侧真 DB Worker + 直读行数断言（与 advisor/scan 同口径，不注入假 fetch）。
//
// 覆盖点（§七 09 行 / §一 v1.12「3 版供选」/ 硬规则 10/13 / §四 prompt 快照）：
//   C1  契约与纯函数（不 import electron/不发 HTTP；三角度写死；护栏文本）
//   C2  generate：三路并行流式、text 模型、会话键 content-<taskId>-a<i>（不进商家 sticky）、
//       每路 user 含 Context Pack 正文（价格）+ 各自角度指令；pack 摘要回传
//   C3  先落库后 done：result resolve 时版本行必读得到；source=ai + prompt 快照带角度；
//       三并发版本号为 {1,2,3} 无重复（串行化链）
//   C4  单路中止：只停那一路（上游真断连、该路不落版本），其余两路照常落库
//   C5  人工审核链：生成后 status 恒 draft；空正文拒 published；adopt→published 自动补 published_at；
//       退草稿保留 published_at
//   C6  CRUD/隔离：跨 project NOT_FOUND（get/update/generate 的 contentId）、未知字段拒、
//       PATCH 保留未传字段、delete 幂等 + 版本级联清
//   C7  版本：saveVersion(source=user, activate) → 正文写回 + prompt NULL；listVersions 升序
//   C8  错误透传与空产出：401 三路 reject 不落版本；真空文本 done 但零版本；纯围栏 → FILE_PARSE_ERROR(empty-generation)
//   C9  热点 payload：sourceTopicId 预检存在性（不存在→reason=source-topic-not-found）、入库、不可改
//   C10 静态契约：9 通道三处一致 / 两路 abort / before-quit / store 切片 / UI 文案与四路 /
//       路由换真页 / db-worker 零改动（白名单不扩）
//   C11 整体中止：run.cancel() 三路 aborted、零版本、注册表清空；cancelGenerationByProject 命中
//
// 用法：node test/content.accept.mjs   （npm run accept:content；--keep-tmp 保留临时目录）

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
const runDir = join(tmpDir, `content-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const EXTERNALS = ['mammoth', 'exceljs']

const contentPath = bundleEntry('electron/main/marketing/contentManager.ts', 'content-manager.mjs', {
  externals: EXTERNALS
})
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'content-context-engine.mjs', {
  externals: EXTERNALS
})
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'content-gateway-client.mjs')
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'content-business-manager.mjs', {
  externals: EXTERNALS
})
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'content-knowledge-manager.mjs', {
  externals: EXTERNALS
})
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'content-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'content-database.mjs')

const contentMod = await import(pathToFileURL(contentPath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const {
  createContentManager,
  ContentManager,
  CONTENT_GUARDRAILS,
  CONTENT_GENERATION_ANGLES,
  CONTENT_GENERATION_VERSIONS,
  CONTENT_STATUSES,
  normalizeRecognizedBody,
  buildPromptSnapshot
} = contentMod
const { createContextEngine } = ctxMod
const { createGatewayClient } = gwMod
const { DatabaseClient } = dbMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

// ── 假 Gateway（真 http；按会话键尾部 -a<i> 区分三路角度） ───────────────────

function createFakeGateway() {
  const state = {
    mode: 'ok', // ok | slow1（只慢路 1）| slowAll（三路全慢）| auth | empty | fences
    bodies: [],
    closeEarly: 0,
    framesByAngle: {}, // angle -> 帧数
    port: 0
  }
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
      const angleMatch = /-a(\d+)$/.exec(String(body?.user ?? ''))
      const angle = angleMatch ? Number(angleMatch[1]) : 0
      state.bodies.push({
        model: body?.model ?? null,
        user: body?.user ?? null,
        stream: body?.stream ?? null,
        temperature: body?.temperature ?? null,
        imageParts: parts.filter((p) => p?.type === 'image_url').length,
        roles: (body?.messages ?? []).map((m) => m.role).join(','),
        system: String(body?.messages?.[0]?.content ?? ''),
        instruction: textAll,
        angle
      })
      if (state.mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'unauthorized' }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let finished = false
      res.on('close', () => {
        if (!finished) state.closeEarly += 1
      })
      const send = async (piece) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: piece } }] })}\n\n`)
        state.framesByAngle[angle] = (state.framesByAngle[angle] ?? 0) + 1
        await sleep(2)
      }
      if (state.mode === 'slow1' && angle === 1) {
        for (let i = 1; i <= 40; i++) {
          if (res.writableEnded || res.destroyed) return
          await send(`慢1-${i}`)
          await sleep(8)
        }
      } else if (state.mode === 'slowAll') {
        for (let i = 1; i <= 40; i++) {
          if (res.writableEnded || res.destroyed) return
          await send(`慢${angle}-${i}`)
          await sleep(8)
        }
      } else if (state.mode === 'empty') {
        /* 只收尾，不吐正文 */
      } else if (state.mode === 'fences') {
        await send('```\n\n```')
      } else {
        await send(`版${angle}A`)
        await send(`版${angle}B`)
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

const countRows = (database, table, where) =>
  database.request(`${table}.count`, { where }).then((r) => Number(r && r.count))

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 并发排空三路（模拟 forwardGatewayStream 的消费），可选在指定路第一帧时触发 onCancel */
async function drainAll(streams, onCancel) {
  let cancelledOnce = false
  await Promise.all(
    streams.map(async (h, i) => {
      for await (const d of h.iterator) {
        if (onCancel && !cancelledOnce && onCancel(i, d)) {
          cancelledOnce = true
          h.cancel()
        }
      }
    })
  )
}

const r = new Recorder('content（Commit 09：Content Center 一次 3 版供选 + 版本 prompt 快照 + 人工审核，打真 contentManager.ts）')
const servers = []
const ctx = {}

try {
  const database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-content-test',
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

  const project = await projects.createProject({ name: '09 拾光摄影', industry: '摄影' })
  await business.upsertBusiness(project.id, { name: '拾光摄影', city: '杭州', positioning: '轻奢外景' })
  await knowledge.createKnowledge(project.id, {
    title: '套系价目表',
    type: 'text',
    content: '婚纱套系 5999 元，含 30 张精修；亲子套系 1999 元。'
  })

  // ── C1 契约与纯函数 ──
  await r.check('C1', 'contentManager 可纯 Node import；缺依赖 VALIDATION_ERROR；不 import electron/不发 HTTP/不直写 SQL；三角度与护栏写死', async () => {
    assertEq(typeof createContentManager, 'function', '工厂导出')
    assertEq(typeof ContentManager, 'function', '类导出')
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'contentManager.ts'), 'utf-8')
    const code = stripComments(src)
    assert(!/from\s*["']electron["']/.test(code), '不 import electron')
    assert(!/\bfetch\s*\(|node:(http|https|net)/.test(code), '不发 HTTP（出站只经 07）')
    assert(!/INSERT INTO|UPDATE \w+ SET|prepare\(/.test(code), '不直写 SQL（一律经 DatabaseClient）')
    for (const bad of [
      { database: null, contextEngine, gateway },
      { database, contextEngine: null, gateway },
      { database, contextEngine, gateway: null }
    ]) {
      const res = await outcome(Promise.resolve().then(() => createContentManager(bad)))
      assertEq(res.code, 'VALIDATION_ERROR', '缺依赖应 VALIDATION_ERROR')
    }
    assertEq(CONTENT_GENERATION_VERSIONS, 3, '一次生成 3 版（§七 v1.12）')
    assertEq(CONTENT_GENERATION_ANGLES.length, 3, '三角度写死')
    assertDeepEq(CONTENT_GENERATION_ANGLES.map((a) => a.key), ['direct', 'story', 'objection'], '角度键稳定（preload/accept 依赖）')
    assert(CONTENT_GUARDRAILS.includes('只能引用'), '护栏：事实只能引资料')
    assert(CONTENT_GUARDRAILS.includes('不许编一个数字'), '护栏：不硬编价格')
    assertEq(normalizeRecognizedBody('```md\n正文\n```'), '正文', '剥围栏')
    assertEq(normalizeRecognizedBody('a\n\n\n\nb'), 'a\n\nb', '压多余空行')
    assertDeepEq([...CONTENT_STATUSES], ['draft', 'review', 'approved', 'published', 'archived'], '§四 状态机全集')
    return '依赖注入 + 无 electron/HTTP/SQL + 三角度护栏 ✓'
  })

  // ── C2 生成组装 ──
  await r.check('C2', 'generate 三路并行：text 模型（无图）、user=conv:<pid>:content-<taskId>-a<i>（不进商家 sticky）、每路含 Context Pack 价格 + 独立角度指令、temperature 0.8', async () => {
    const before = fake.state.bodies.length
    const run = await manager.generate(project.id, { platform: 'xiaohongshu', topic: '秋季外景预约' })
    assertEq(run.angles.length, 3, '三路 streamId')
    assertDeepEq(run.angles.map((a) => a.streamId), run.angles.map((a) => `${run.genTaskId}-${a.angle.key}`), 'streamId=`<genTaskId>-<角度key>`')
    assertEq(run.contentId.length > 10, true, '草稿先行落库（三路共写一条）')
    await drainAll(run.streams)
    const results = await Promise.all(run.streams.map((s) => s.result))
    const bodies = fake.state.bodies.slice(before)
    assertEq(bodies.length, 3, '恰好 3 次请求')
    const sticky = `conv:${project.id}:${project.conversation_key}`
    for (const b of bodies) {
      assertEq(b.model, 'openclaw', '纯文本请求走 text 默认模型')
      assertEq(b.imageParts, 0, '无图')
      assertEq(b.roles, 'system,user', '每路只 system+user（历史不回灌）')
      assertEq(b.stream, true, '流式（§六）')
      assertEq(b.temperature, 0.8, '创作温度 0.8（护栏兜事实）')
      assert(b.user !== sticky, '绝不进商家 Advisor 的 sticky 会话')
      assert(/^conv:[^:]+:content-content-\d+-[a-z0-9]+-a\d$/.test(b.user), `会话键形状: ${b.user}`)
      assertEq(b.system.includes('只能引用'), true, 'system 带内容护栏')
      assert(b.instruction.includes('5999'), 'user 含 Context Pack 正文（价格）')
      assert(b.instruction.includes('秋季外景预约'), 'user 带选题')
      assert(b.instruction.includes('发布平台：xiaohongshu'), 'user 带平台')
    }
    assertEq(new Set(bodies.map((b) => b.user)).size, 3, '三路会话键互不相同（并行不穿插）')
    assertDeepEq(bodies.map((b) => b.angle).sort(), [0, 1, 2], '三角度都发到了')
    assert(bodies.some((b) => b.instruction.includes('直给')) && bodies.some((b) => b.instruction.includes('场景')) && bodies.some((b) => b.instruction.includes('异议')), '各带独立角度指令')
    assertEq(run.pack.budget.knowledgeIncluded, 1, 'pack 账本：注入 1 条资料（正文不出主进程）')
    assertEq(results.every((x) => !x.aborted), true, '三路正常完成')
    ctx.run = run
    ctx.results = results
    return `3 路 streamId=…-${run.angles.map((a) => a.angle.key).join('/')}；pack.k=1 ✓`
  })

  // ── C3 先落库后 done + prompt 快照 ──
  await r.check('C3', '先落库后 done：resolve 时版本行已在（直读）、source=ai、prompt 快照含任务/平台/角度/资料；三路版本号 {1,2,3} 无重复', async () => {
    const { run, results } = ctx
    // 此刻三路 result 均已 resolve——done 若发生在落库前，这里直读会数到 0
    const rows = await manager.listVersions(project.id, run.contentId)
    assertEq(rows.length, 3, '三路各一版')
    assertDeepEq(rows.map((v) => v.version).sort(), [1, 2, 3], '并发写版本号不重复（串行化链）')
    for (const row of rows) {
      assertEq(row.source, 'ai', 'source=ai')
      assert(row.prompt.includes('【任务】content-draft'), '快照带任务')
      assert(row.prompt.includes('xiaohongshu'), '快照带平台')
      assert(row.prompt.includes('5999'), '快照带 Context Pack（资料正文）')
      assert(CONTENT_GENERATION_ANGLES.some((a) => row.prompt.includes(`【本版角度】${a.label}`)), '快照带本版角度')
    }
    // done 文本 = 版本正文（渲染端以 done 展示、以版本为采纳源，两者必须同源）
    for (let i = 0; i < 3; i++) {
      const text = results[i].text
      const versionText = normalizeRecognizedBody(text)
      assert(rows.some((v) => v.content === versionText), `路 ${i} 版本正文与流文本同源`)
    }
    return `3 版齐（v{1,2,3}）；快照含任务/平台/角度/资料 ✓`
  })

  // ── C4 单路中止 ──
  await r.check('C4', '只停第 1 路：上游真断（服务端观测 close）、该路 aborted 不落版本，其余两路照常落库', async () => {
    fake.state.mode = 'slow1'
    fake.state.closeEarly = 0
    fake.state.framesByAngle = {}
    try {
      // 计数必须在 generate **之前**取：generate 开头就落草稿（三路共写的载体），
      // 之后取基线再 +1 会把那条草稿重复计入（首轮实测：期望 3 实际 2）
      const contentsBefore = await countRows(database, 'contents', {})
      const run = await manager.generate(project.id, { platform: 'douyin', topic: '停一路测试' })
      const versionsBefore = await countRows(database, 'content_versions', {})
      await drainAll(run.streams, (i, d) => i === 1 && d.index === 2) // 第 1 路第二帧时 cancel 那一路
      const results = await Promise.all(run.streams.map((s) => s.result))
      assertEq(results[1].aborted, true, '第 1 路 aborted')
      assertEq(results[0].aborted, false, '第 0 路不受影响')
      assertEq(results[2].aborted, false, '第 2 路不受影响')
      await sleep(150)
      assert(fake.state.closeEarly >= 1, `服务端应观测到断连，实际 ${fake.state.closeEarly}`)
      assert(fake.state.framesByAngle[1] < 40, '断连发生在流中途（非超时跑完）')
      assertEq(await countRows(database, 'content_versions', {}), versionsBefore + 2, '只落 2 版（中止路不落）')
      assertEq(await countRows(database, 'contents', {}), contentsBefore + 1, '中止不丢草稿（生成前先有载体）')
      const rows = await manager.listVersions(project.id, run.contentId)
      assertEq(rows.length, 2, '该草稿两版')
      assert(!rows.some((v) => v.content.includes('慢1')), '中止路文本不落库')
    } finally {
      fake.state.mode = 'ok'
    }
    return '断连观测 ✓；2 落 1 不落 ✓'
  })

  // ── C5 人工审核链（硬规则 10） ──
  await r.check('C5', '状态机全人工：生成后恒 draft；空正文不能 published；adopt→published 自动补 published_at；退回保留发布时刻', async () => {
    const { run } = ctx
    const row = await manager.getContent(project.id, run.contentId)
    assertEq(row.status, 'draft', '生成只造草稿，状态不自动推进（§十：无自动发布）')
    assertEq(row.platform, 'xiaohongshu', '平台落库')
    assertEq(row.topic, '秋季外景预约', '选题落库')

    // 空正文拒发布（另建一条）
    const bare = await manager.createContent(project.id, { title: '空稿', platform: 'douyin' })
    const bad = await outcome(manager.updateContent(project.id, bare.id, { status: 'published' }))
    assertEq(bad.code, 'VALIDATION_ERROR', '空正文不能发布')
    assertEq(bad.details.reason, 'publish-without-content', 'reason 可分支')

    // adopt 正文（模拟「采用为正文」）→ 发布
    const rows = await manager.listVersions(project.id, run.contentId)
    const adoptedRow = await manager.updateContent(project.id, run.contentId, { content: rows[0].content })
    assertEq(adoptedRow.status, 'draft', 'adopt 只写正文，不推状态')
    const published = await manager.updateContent(project.id, run.contentId, { status: 'published' })
    assertEq(published.status, 'published', '人工点发布成功')
    assert(Number(published.published_at) > 0, 'published_at 自动补（v1.13 唯一真相来源）')
    const back = await manager.updateContent(project.id, run.contentId, { status: 'draft' })
    assertEq(back.published_at, published.published_at, '退回 draft 保留最近发布时刻（不造第二个真相）')
    // 非法状态
    const bad2 = await outcome(manager.updateContent(project.id, run.contentId, { status: 'sent' }))
    assertEq(bad2.code, 'VALIDATION_ERROR', '状态白名单')
    await manager.deleteContent(project.id, bare.id)
    return 'draft→审核→发布→退回 全人工 ✓；published_at 语义 ✓'
  })

  // ── C6 CRUD / 隔离 ──
  await r.check('C6', '跨 Project 视同不存在（get/update/generate contentId）；未知字段硬拒；PATCH 保留未传字段；delete 幂等 + 版本级联', async () => {
    const other = await projects.createProject({ name: '09 别家', industry: '摄影' })
    const mine = await manager.createContent(project.id, { title: '隔离样本', platform: 'xiaohongshu' })
    const crossGet = await outcome(manager.getContent(other.id, mine.id))
    assertEq(crossGet.code, 'NOT_FOUND', '跨 project get → NOT_FOUND')
    const crossGen = await outcome(manager.generate(other.id, { contentId: mine.id, platform: 'douyin' }))
    assertEq(crossGen.code, 'NOT_FOUND', '拿别家草稿生成 → NOT_FOUND')
    const crossUpd = await outcome(manager.updateContent(other.id, mine.id, { status: 'archived' }))
    assertEq(crossUpd.code, 'NOT_FOUND', '跨 project update → NOT_FOUND')

    const unknown = await outcome(manager.updateContent(project.id, mine.id, { content: 'x', id: 'hack' }))
    assertEq(unknown.code, 'VALIDATION_ERROR', '未知字段（含 id）硬拒')
    const badPlatform = await outcome(manager.createContent(project.id, { platform: 'weibo' }))
    assertEq(badPlatform.code, 'VALIDATION_ERROR', '平台白名单（§四 双平台）')

    await manager.updateContent(project.id, mine.id, { content: '正文只此一句' })
    const afterTitle = await manager.updateContent(project.id, mine.id, { title: '改标题' })
    assertEq(afterTitle.content, '正文只此一句', 'PATCH：未传的 content 保留（PUT 式清空会误删稿）')

    const list = await manager.listContents(project.id, { status: 'draft' })
    assert(list.some((c) => c.id === mine.id), 'status 过滤')
    const listP = await manager.listContents(project.id, { platform: 'douyin' })
    assert(!listP.some((c) => c.id === mine.id), 'platform 过滤')

    const del = await manager.deleteContent(project.id, mine.id)
    assertEq(del.deleted, true, '首次删除')
    const versionsLeft = await countRows(database, 'content_versions', { content_id: mine.id })
    assertEq(versionsLeft, 0, '版本随 FK 级联清除')
    const again = await manager.deleteContent(project.id, mine.id)
    assertEq(again.deleted, false, '幂等：重复删不报错')
    const badProject = await outcome(manager.createContent('no-such-project', { title: '孤儿' }))
    assertEq(badProject.code, 'NOT_FOUND', 'project 不存在 → NOT_FOUND（不落孤儿行）')
    return '隔离 ×3 + 白名单 + PATCH + 级联/幂等 ✓'
  })

  // ── C7 版本流 ──
  await r.check('C7', 'saveVersion(source=user,activate)：正文写回 + prompt=NULL；listVersions 升序；非法 source 拒', async () => {
    const { run } = ctx
    const rows0 = await manager.listVersions(project.id, run.contentId)
    const res = await manager.saveVersion(
      project.id,
      run.contentId,
      { content: '老板亲手改的定稿：加一句门店地址', source: 'user' },
      { activate: true }
    )
    assertEq(res.version.source, 'user', '手改版 source=user')
    assertEq(res.version.prompt, null, '§四：user 版 prompt 必为 NULL')
    assertEq(res.version.version, Math.max(...rows0.map((v) => v.version)) + 1, '版本递增')
    const after = await manager.getContent(project.id, run.contentId)
    assertEq(after.content, '老板亲手改的定稿：加一句门店地址', 'activate 写回正文（Learning 的「改了什么」样本）')
    const rows = await manager.listVersions(project.id, run.contentId)
    assertDeepEq(rows.map((v) => v.version), rows.map((v) => v.version).sort((a, b) => a - b), 'listVersions 升序')
    const bad = await outcome(manager.saveVersion(project.id, run.contentId, { content: 'x', source: 'ghost' }))
    assertEq(bad.code, 'VALIDATION_ERROR', 'source 白名单 ai/user')
    const emptyV = await outcome(manager.saveVersion(project.id, run.contentId, { content: '  ' }))
    assertEq(emptyV.code, 'VALIDATION_ERROR', '空正文不存版本')
    return 'user 版 + activate + 升序 + 白名单 ✓'
  })

  // ── C8 错误透传与空产出 ──
  await r.check('C8', '401 三路 reject OPENCLAW_AUTH_ERROR 零版本；真空文本 done 但零版本；纯围栏 → FILE_PARSE_ERROR(empty-generation)', async () => {
    fake.state.bodies.length = 0
    try {
      fake.state.mode = 'auth'
      const run = await manager.generate(project.id, { platform: 'xiaohongshu', topic: '鉴权失败' })
      const before = await countRows(database, 'content_versions', {})
      const settled = await Promise.all(run.streams.map((s) => outcome(s.result)))
      assertEq(settled.every((s) => !s.ok), true, '三路全失败')
      assertEq(settled.every((s) => s.code === 'OPENCLAW_AUTH_ERROR'), true, '07 原码透传（跨 bundle：不降级 DB_ERROR）')
      assertEq(await countRows(database, 'content_versions', {}), before, '失败不落版本')

      fake.state.mode = 'empty'
      const run2 = await manager.generate(project.id, { platform: 'douyin', topic: '空产出' })
      const settled2 = await Promise.all(run2.streams.map((s) => outcome(s.result)))
      assertEq(settled2.every((s) => s.ok), true, '空文本流正常收尾（不报错）')
      assertEq(settled2.every((s) => s.value.text === ''), true, 'text 空')
      assertEq(await countRows(database, 'content_versions', { content_id: run2.contentId }), 0, '没产出就不落版本（空版本位）')
      await manager.deleteContent(project.id, run2.contentId)

      fake.state.mode = 'fences'
      const run3 = await manager.generate(project.id, { platform: 'douyin', topic: '围栏脏输出' })
      const settled3 = await Promise.all(run3.streams.map((s) => outcome(s.result)))
      assertEq(settled3.every((s) => !s.ok && s.code === 'FILE_PARSE_ERROR'), true, '剥围栏后为空 → FILE_PARSE_ERROR')
      assertEq(settled3.every((s) => s.details.reason === 'empty-generation'), true, 'reason=empty-generation')
      assertEq(await countRows(database, 'content_versions', { content_id: run3.contentId }), 0, '脏输出不落空版本')
      await manager.deleteContent(project.id, run3.contentId)
    } finally {
      fake.state.mode = 'ok'
    }
    return '鉴权/空文本/纯围栏 三分支各得其所 ✓'
  })

  // ── C9 热点 payload 溯源 ──
  await r.check('C9', 'sourceTopicId：预检存在性（不存在→source-topic-not-found）、随草稿入库、生成带 payload、身份列不可改', async () => {
    const topicId = 'ht-09-test'
    const now = Date.now()
    await database.request('hot_topics.create', {
      data: {
        id: topicId,
        source_platform: 'douyin',
        source: 'fake-board',
        origin: 'board',
        title: '秋天的第一杯奶茶',
        url: null,
        fingerprint: 'fp-09',
        heat: 100,
        rank: 1,
        lifecycle: 'new',
        first_seen_at: now,
        last_seen_at: now
      }
    })
    const good = await manager.createContent(project.id, {
      title: '奶茶联名',
      platform: 'douyin',
      topic: '秋天的第一杯奶茶',
      sourceTopicId: topicId
    })
    assertEq(good.source_topic_id, topicId, '溯源列落库（§四 v1.10）')
    const bad = await outcome(
      manager.createContent(project.id, { title: '假溯源', platform: 'douyin', sourceTopicId: 'no-such-topic' })
    )
    assertEq(bad.code, 'VALIDATION_ERROR', '不存在的 topic → 拒（不赌 FK 天书）')
    assertEq(bad.details.reason, 'source-topic-not-found', 'reason 可分支（11 联调时 UI 好翻译）')
    const imm = await outcome(manager.updateContent(project.id, good.id, { source_topic_id: 'other' }))
    assertEq(imm.code, 'VALIDATION_ERROR', '溯源是身份，update 白名单外')
    const viaGen = await manager.generate(project.id, {
      platform: 'xiaohongshu',
      topic: 'payload 生成',
      sourceTopicId: topicId
    })
    const genRow = await manager.getContent(project.id, viaGen.contentId)
    assertEq(genRow.source_topic_id, topicId, '新建草稿路径也带溯源')
    await drainAll(viaGen.streams)
    await Promise.all(viaGen.streams.map((s) => s.result))
    await manager.deleteContent(project.id, good.id)
    await manager.deleteContent(project.id, viaGen.contentId)
    return 'payload 接收端就绪（11 的按钮直接可用）✓'
  })

  // ── C10 静态契约 ──
  await r.check('C10', '9 通道三处一致 + 两路 abort + before-quit + store/UI/路由契约 + db-worker 白名单零改动', async () => {
    const ipcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'content.ts'), 'utf-8')
    const indexSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'index.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    const mainSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
    const storeSrc = stripComments(readFileSync(join(repoRoot, 'src', 'stores', 'marketing.ts'), 'utf-8'))
    const vueSrc = readFileSync(join(repoRoot, 'src', 'views', 'marketing', 'ContentCenter.vue'), 'utf-8')
    const routeSrc = readFileSync(join(repoRoot, 'src', 'renderer', 'main.ts'), 'utf-8')
    const workerSrc = readFileSync(join(repoRoot, 'resources', 'database', 'db-worker.mjs'), 'utf-8')

    const channels = [
      'marketing:content:list',
      'marketing:content:get',
      'marketing:content:create',
      'marketing:content:update',
      'marketing:content:delete',
      'marketing:content:generate',
      'marketing:content:generate:abort',
      'marketing:content:saveVersion',
      'marketing:content:versions'
    ]
    for (const c of channels) {
      assert(ipcSrc.includes(`'${c}'`), `ipc/content.ts 应声明 ${c}`)
      assert(preloadSrc.includes(`'${c}'`), `preload 应暴露 ${c}`)
    }
    assert(/MARKETING_CONTENT_CHANNELS/.test(indexSrc) && /abortAllContentGenerations/.test(indexSrc), 'index.ts 转出 content 面')
    assert(!/\.send\(\s*['"]marketing:(?!gateway)/.test(ipcSrc), '不自造流事件名（复用 07 三事件）')
    assert(/forwardGatewayStream\(/.test(ipcSrc), '经 07 forwardGatewayStream')
    assert(/abortGenerate:\s*\(genTaskId\?: string \| null, projectId\?: string \| null\)/.test(preloadSrc), 'preload abort 两路参数')
    assert(/registerContentIpc\(marketingContentManager!\)/.test(mainSrc), 'main 注册 content IPC')
    assert(/abortAllContentGenerations\(\)/.test(mainSrc), 'before-quit 第四路')
    // §五 扩面在代码注释里注明
    assert(/扩面/.test(ipcSrc), '扩面注释在位（delete/abort/versions）')

    for (const name of [
      'contents',
      'contentGen',
      'contentGenStreaming',
      'loadContents',
      'createContent',
      'updateContent',
      'removeContent',
      'loadContentVersions',
      'saveContentVersion',
      'generateContent',
      'stopGenerate',
      'clearGenerate',
      'disposeContent'
    ]) {
      assert(new RegExp(`\\b${name}\\b`).test(storeSrc), `store 应暴露 ${name}`)
    }
    assert(!/error\.message\.includes\(|message\.includes\(/.test(storeSrc), 'store 禁 message.includes()（§五）')

    assert(vueSrc.includes('停止生成'), 'UI：停止生成')
    assert(vueSrc.includes('采用为正文'), 'UI：人工采纳（硬规则 10）')
    assert(vueSrc.includes('标记已发布'), 'UI：发布标记人工点')
    assert(vueSrc.includes('提交审核') && vueSrc.includes('审核通过'), 'UI：审核链人工推进')
    assert(vueSrc.includes('价格'), 'UI：价格人工核对提示')
    assert(/watch\(\s*\(\) => marketing\.currentProjectId[\s\S]{0,220}clearGenerate/.test(vueSrc), '四路之切商家')
    assert(/onBeforeUnmount\([\s\S]{0,200}clearGenerate[\s\S]{0,80}disposeContent/.test(vueSrc), '四路之卸载')
    assert(/永不自动发布/.test(vueSrc), 'UI 明示不自动发（§一 不做全自动）')
    assert(routeSrc.includes("import('../views/marketing/ContentCenter.vue')"), '路由换真页')
    // Commit 11 上线后，热点路由由 Placeholder 换为 HotCenter（payload 接收端仍在本页，见 prefill 用例）
    assert(/marketing\/hot[\s\S]{0,160}HotCenter\.vue/.test(routeSrc), '热点路由 11 已换真页 HotCenter')

    // db-worker 白名单零改动：本提交只消费既有 generic CRUD
    assert(workerSrc.includes("contents: {"), 'contents 表定义（02 建，未动）')
    assert(workerSrc.includes("content_versions: {"), 'content_versions 表定义（未动）')
    assert(!/content\.generate|'contents\.version/.test(workerSrc), '未往 worker 塞业务方法（业务在 manager，硬规则 8/12 精神）')
    return '9 通道三处一致；四路中止；store 13 项；UI 人工链路；路由；worker 零改动 ✓'
  })

  // ── C11 参数校验 ──
  await r.check('C11', '参数校验：缺 projectId / 缺 platform / 非法 id → VALIDATION_ERROR，全部在请求外发前', async () => {
    const before = fake.state.bodies.length
    const cases = [
      [manager.generate('', { platform: 'douyin' }), '缺 projectId'],
      [manager.generate(project.id, {}), '缺 platform'],
      [manager.generate(project.id, { platform: 'weibo' }), '非法平台'],
      [manager.getContent(project.id, ''), '空 id'],
      [manager.listContents(project.id, { status: 'ghost' }), '非法状态过滤']
    ]
    for (const [p, name] of cases) {
      const res = await outcome(p)
      assertEq(res.code, 'VALIDATION_ERROR', name)
    }
    assertEq(fake.state.bodies.length, before, '校验失败零请求（不为坏参数烧 token）')
    return '5 个非法入参全拒于外发前 ✓'
  })

  // ── C12 整体中止与注册表 ──
  await r.check('C12', 'run.cancel()/cancelByProject/cancelAll：三路全 aborted、零新版本、注册表即时清零（幂等重复取消不双计）', async () => {
    // 三路全慢（slowAll）：cancel 时三路都必在途——否则快路会先完成并落库，断言不成立
    fake.state.mode = 'slowAll'
    try {
      const run = await manager.generate(project.id, { platform: 'douyin', topic: '整体中止' })
      const versionsBefore = await countRows(database, 'content_versions', { content_id: run.contentId })
      assertEq(versionsBefore, 0, '前置：新草稿无版本')
      const p = Promise.all(run.streams.map((s) => s.result))
      const seen = await run.streams[1].iterator[Symbol.asyncIterator]().next() // 起消第 1 路，让请求真在途
      assertEq(seen.done, false, '前置：第 1 路已有增量')
      assertEq(manager.activeGenerationCount(), 1, '任务在途可见')
      assertEq(run.cancel(), undefined, 'run.cancel 无返回值（内部幂等）')
      const results = await p
      assertEq(results.every((x) => x.aborted), true, '三路都 aborted')
      assertEq(manager.cancelGeneration(run.genTaskId), false, '已终结任务再 cancel=false（幂等不双计）')
      assertEq(await countRows(database, 'content_versions', { content_id: run.contentId }), 0, '整体中止零版本落库')
      // cancelByProject：新任务按商家取消（渲染端 await 期间切商家的兼路径）
      const run2 = await manager.generate(project.id, { platform: 'douyin', topic: '按商家取消' })
      const p2 = Promise.all(run2.streams.map((s) => s.result))
      await run2.streams[0].iterator[Symbol.asyncIterator]().next()
      assertEq(manager.cancelGenerationByProject(project.id) >= 1, true, '两路定位之 projectId 路命中')
      const results2 = await p2
      assertEq(results2.every((x) => x.aborted), true, '按商家取消也三路 aborted')
      run2.cancel()
      assertEq(manager.cancelGenerationByProject(''), 0, '空 projectId → 0')
      assertEq(manager.cancelGeneration(''), false, '空 genTaskId → false')
      assertEq(manager.cancelAllGenerations(), 0, '都已终结 → cancelAll 数 0（不双计）')
    } finally {
      fake.state.mode = 'ok'
      await sleep(80)
      assertEq(manager.activeGenerationCount(), 0, '收尾后注册表空')
    }
    return '整体中止 + 两路定位 + 幂等不双计 ✓'
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

const result = r.toJSON({ bundle: contentPath, dataDir, nodePath, logSample: logs.slice(0, 10) })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-content.json'), result)
console.log('结果已写入 test/accept-result-content.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
