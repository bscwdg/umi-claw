// test/shooting.accept.mjs —— 二阶段验收：分镜脚本（shooting_script 产物）
//
// **打真实源码**：esbuild bundle 真 contentManager.ts（连带真 shootingScript/ContextEngine/
// GatewayClient/四 Manager/DatabaseClient），HTTP 侧真 Node http 服务端扮演 Gateway（真 SSE）；
// 库侧真 DB Worker（与 content.accept 同口径）。
//
// 覆盖点（二阶段评审）：
//   S1  shootingScript 纯模块：无 electron/HTTP；JSON 提取/解析/校验（坏条目丢弃、shots 封顶、
//       durationSec 夹紧、hashtags 归一）/序列化往返/渲染/业务线推导与归一/契约文本
//   S2  generate(shooting_script)：单路流、temp 0.4、独立会话键 -script；请求注入 JSON 契约 +
//       业务线 + Context Pack + 平台规则；done 带 deliverable；版本行存 JSON、prompt 快照全要素；
//       正文不自动采用
//   S3  采用：deliverable 渲染文本写回 contents.content
//   S4  坏 JSON：result 拒绝 VALIDATION_ERROR(reason=shooting-script-unparsable)、零版本行、草稿保留
//   S5  post 回归：三路、temp 0.8、会话键 -a0/1/2、post 版本视图不挂 rendered_content
//   S6  content_type 创建后不可改（白名单拒绝）
//   S7  （并入 S8）
//   S8  v1→v2 迁移：user_version=2；默认 post；shooting_script 行持久化、列可直读
//   S9  静态契约：IPC/preload 透链 contentType/businessLine，不新增通道
//
// 用法：node test/shooting.accept.mjs   （npm run accept:shooting；--keep-tmp 保留临时目录）

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
  writeJson,
  sleep,
  tmpDir,
  workerScriptPath
} from './_lib.mjs'

const repoRoot = join(__dirname, '..')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, `shooting-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const EXTERNALS = ['mammoth', 'exceljs']

const contentPath = bundleEntry('electron/main/marketing/contentManager.ts', 'shoot-content-manager.mjs', {
  externals: EXTERNALS
})
const purePath = bundleEntry('electron/main/marketing/shootingScript.ts', 'shooting-pure.mjs')
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'shoot-context-engine.mjs', {
  externals: EXTERNALS
})
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'shoot-gateway-client.mjs')
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'shoot-business-manager.mjs', {
  externals: EXTERNALS
})
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'shoot-knowledge-manager.mjs', {
  externals: EXTERNALS
})
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'shoot-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'shoot-database.mjs')

const contentMod = await import(pathToFileURL(contentPath).href)
const pureMod = await import(pathToFileURL(purePath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const {
  createContentManager,
  SHOOTING_SCRIPT_GUARDRAILS
} = contentMod
const {
  extractJsonObject,
  parseShootingScript,
  serializeShootingScript,
  renderScriptText,
  deriveBusinessLine,
  normalizeContentType,
  normalizeBusinessLine,
  shootingScriptContractText
} = pureMod
const { createContextEngine } = ctxMod
const { createGatewayClient, forwardGatewayStream, GATEWAY_STREAM_EVENTS } = gwMod
const { DatabaseClient } = dbMod

// ── 固定脚本 payload（含全部防护触发点：重复#标签、超范围时长） ───────────────

const SCRIPT_PAYLOAD = {
  title: '3 个镜头讲清 5999 婚纱套系',
  cover: '新人站在外景草坪，大字「5999 含 30 张精修」',
  hook: '杭州拍婚纱照，5999 到底能拿到啥？',
  cta: '评论区扣「婚纱」发你套系表',
  hashtags: ['杭州婚纱', '婚纱照', '#杭州婚纱摄影', '杭州婚纱'],
  shots: [
    { index: 1, shot: '迎宾开场，摄影师挥手', durationSec: 5, voiceover: '杭州拍婚纱照，5999 到底能拿到啥？', subtitle: '5999 能拿到啥', cameraTip: '固定中景' },
    { index: 2, shot: '精修相册翻页特写', durationSec: 8, voiceover: '30 张精修，外景拍一天。', subtitle: '30 张精修', cameraTip: '俯拍特写' },
    { index: 3, shot: '客片外景大景收尾', durationSec: 400, voiceover: '就是这个味儿。', subtitle: '', cameraTip: '' }
  ]
}

// ── 假 Gateway（真 http；按 system 文本识别脚本/图文请求） ───────────────────

function createFakeGateway() {
  const state = { mode: 'auto', requests: [] }
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
      const instruction = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
      const system = String(body?.messages?.[0]?.content ?? '')
      const isScript = system.includes('分镜导演')
      state.requests.push({
        conversationKey: body?.user ?? null,
        temperature: body?.temperature ?? null,
        stream: body?.stream ?? null,
        system,
        instruction
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = async (piece) => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: piece } }] })}\n\n`)
        await sleep(2)
      }
      if (isScript && state.mode === 'garbage') {
        await send('这个需求我没办法满足，你换个选题吧。')
      } else if (isScript) {
        const json = JSON.stringify(SCRIPT_PAYLOAD)
        const cut = Math.ceil(json.length / 3)
        await send(json.slice(0, cut))
        await send(json.slice(cut, cut * 2))
        await send(json.slice(cut * 2))
      } else {
        await send('成稿A')
        await send('成稿B')
      }
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
      return `http://127.0.0.1:${server.address().port}`
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
    return { ok: false, code: e && e.code, message: e && e.message, details: e && e.details }
  }
}

const countRows = (database, table, where) =>
  database.request(`${table}.count`, { where }).then((r) => Number(r && r.count))

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

async function drainStreams(streams) {
  await Promise.all(
    streams.map(async (h) => {
      for await (const d of h.iterator) {
        /* 消费迭代器 */
      }
    })
  )
  return Promise.all(streams.map((h) => h.result))
}

const r = new Recorder('shooting（二阶段：分镜脚本 shooting_script 单路 JSON + 版本 JSON/正文渲染 + content_type v2，打真 contentManager.ts）')
const servers = []
const clients = []
let project
let scriptContentId = ''
let lastDeliverable = ''

try {
  const database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'db-worker-shooting-test',
    requestTimeoutMs: 30_000
  })
  clients.push(database)

  const fake = createFakeGateway()
  servers.push(fake)
  const baseUrl = await fake.listen()

  const projects = projMod.createProjectManager({ database, dataDir, logger: () => {} })
  const business = bizMod.createBusinessManager({ database, logger: () => {} })
  const watchlist = bizMod.createWatchlistManager({ database, logger: () => {} })
  const knowledge = knowMod.createKnowledgeManager({ database, dataDir, logger: () => {} })
  const contextEngine = createContextEngine({
    projectManager: projects,
    businessManager: business,
    knowledgeManager: knowledge,
    watchlistManager: watchlist,
    logger: () => {}
  })
  const gateway = createGatewayClient({
    baseUrl,
    token: '***',
    models: { text: 'openclaw' },
    conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key,
    logger: () => {}
  })
  clients.push(gateway)
  const manager = createContentManager({ database, contextEngine, gateway, logger: () => {} })

  project = await projects.createProject({ name: '二阶段·拾光摄影', industry: '摄影' })
  await business.upsertBusiness(project.id, { name: '拾光摄影', city: '杭州', positioning: '轻奢外景' })
  await knowledge.createKnowledge(project.id, {
    title: '套系价目表',
    type: 'text',
    content: '婚纱套系 5999 元，含 30 张精修；亲子套系 1999 元。'
  })

  // ── S1 纯模块 ──
  await r.check('S1', 'shootingScript：无 electron/HTTP；提取/解析/校验/序列化/渲染/推导/归一/契约', async () => {
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'shootingScript.ts'), 'utf8')
    const code = stripComments(src)
    assert(!/from\s*["']electron["']/.test(code), '不 import electron')
    assert(!/\bfetch\s*\(|node:(http|https|net)/.test(code), '不发 HTTP')
    assertEq(extractJsonObject('前缀 {"a":1} 后缀'), '{"a":1}', '夹在解释文字里')
    assertEq(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}', 'markdown 围栏')
    assertEq(extractJsonObject('没有对象'), null, '抽不到 → null')

    const script = parseShootingScript('好的：' + JSON.stringify(SCRIPT_PAYLOAD) + '完毕')
    assertEq(script.title, SCRIPT_PAYLOAD.title)
    assertEq(script.shots.length, 3)
    assertEq(script.shots[2].durationSec, 300, 'durationSec 400 → 夹紧 300')
    assertEq(script.shots[2].index, 3, 'index 保持')
    assertDeepEq(script.hashtags, ['杭州婚纱', '婚纱照', '杭州婚纱摄影'], 'hashtags 剥#/去重')

    const garbage = await outcome(Promise.resolve().then(() => parseShootingScript('我不会')))
    assertEq(garbage.ok, false, '无 JSON → 抛错')
    assertEq(garbage.code, 'VALIDATION_ERROR')
    assertEq(garbage.details?.reason, 'shooting-script-unparsable')
    const noTitle = await outcome(Promise.resolve().then(() => parseShootingScript(JSON.stringify({ ...SCRIPT_PAYLOAD, title: '  ' }))))
    assertEq(noTitle.ok, false, '缺 title 抛错')
    const noHook = await outcome(Promise.resolve().then(() => parseShootingScript(JSON.stringify({ ...SCRIPT_PAYLOAD, hook: '' }))))
    assertEq(noHook.ok, false, '缺 hook 抛错')
    const noShots = await outcome(Promise.resolve().then(() => parseShootingScript(JSON.stringify({ ...SCRIPT_PAYLOAD, shots: [] }))))
    assertEq(noShots.ok, false, '空 shots 抛错')

    const big = {
      ...SCRIPT_PAYLOAD,
      shots: Array.from({ length: 31 }, (_, i) => ({ index: i + 1, shot: '画面' + i, durationSec: 3, voiceover: '口播' + i }))
    }
    assertEq(parseShootingScript(JSON.stringify(big)).shots.length, 30, 'shots 封顶 30')
    const mixed = {
      ...SCRIPT_PAYLOAD,
      shots: [
        { index: 1, shot: '', voiceover: '缺画面' },
        { index: 2, shot: '好画面', durationSec: '6', voiceover: '动口播' },
        { index: 3, shot: '时长非法', durationSec: '长', voiceover: '默认时长' }
      ]
    }
    const parsedMixed = parseShootingScript(JSON.stringify(mixed))
    assertEq(parsedMixed.shots.length, 2, '坏条目丢弃')
    assertEq(parsedMixed.shots[0].index, 1, '重编号')
    assertEq(parsedMixed.shots[0].durationSec, 6, '数字字符串接受')
    assertEq(parsedMixed.shots[1].durationSec, 5, '非法时长 → 默认 5')

    const roundTrip = parseShootingScript(serializeShootingScript(script))
    assertDeepEq(roundTrip, script, '序列化往返一致')

    const text = renderScriptText(script)
    assert(text.startsWith('【分镜脚本】'), '渲染标题块')
    assert(text.includes('镜头 1（5s）'), '渲染分镜+时长')
    assert(text.includes('口播：杭州拍婚纱'), '渲染口播')
    assert(text.includes('#杭州婚纱 '), '渲染话题')
    const renderedLines = text.split('\n')
    assert(!renderedLines.some((line) => line === '  机位：' || line === '  字幕：'), '空字幕/机位不渲染空字段行')

    assertEq(deriveBusinessLine('摄影'), 'photography')
    assertEq(deriveBusinessLine('婚纱摄影工作室'), 'photography')
    assertEq(deriveBusinessLine('女装服饰'), 'fashion')
    assertEq(deriveBusinessLine('服装批发'), 'fashion')
    assertEq(deriveBusinessLine('餐饮'), null)
    assertEq(deriveBusinessLine(null), null)

    assertEq(normalizeContentType(undefined), 'post', '缺省 → post')
    assertEq(normalizeContentType('SHOOTING_SCRIPT'), 'shooting_script', '大小写归一')
    const badType = await outcome(Promise.resolve().then(() => normalizeContentType('video')))
    assertEq(badType.ok, false, '非法类型抛错')
    assertEq(normalizeBusinessLine(''), null, '空业务线 → null')
    assertEq(normalizeBusinessLine('fashion'), 'fashion')
    const badLine = await outcome(Promise.resolve().then(() => normalizeBusinessLine('food')))
    assertEq(badLine.ok, false, '非法业务线抛错')

    const contract = shootingScriptContractText()
    assert(contract.includes('"shots"'), '契约含 shots')
    assert(contract.includes('1-300'), '契约含时长范围')
    assert(SHOOTING_SCRIPT_GUARDRAILS.includes('脚本文案'), '护栏点明产物是文案不是视频')
    return '纯模块 30+ 断言全过 ✓'
  })

  // ── S2 单路生成 ──
  await r.check('S2', 'generate(shooting_script)：单路 temp 0.4 独立会话键；契约+业务线+pack+规则注入；版本 JSON、deliverable、正文不自动采用', async () => {
    const run = await manager.generate(project.id, {
      platform: 'douyin',
      contentType: 'shooting_script',
      businessLine: 'photography',
      topic: '5999 套系怎么拍'
    })
    assertEq(run.contentType, 'shooting_script')
    assertEq(run.businessLine, 'photography')
    assertEq(run.streams.length, 1, '单路')
    assertEq(run.angles.length, 1, '单槽')
    assertEq(run.angles[0].angle.key, 'shooting_script')
    assertEq(run.angles[0].angle.label, '分镜脚本')
    const settled = (await drainStreams(run.streams))[0]
    assertEq(settled.aborted, false)
    assertEq(typeof settled.deliverable, 'string', 'result 挂渲染文本')
    assert(settled.deliverable.includes('镜头 1'), '渲染文本成形')
    lastDeliverable = settled.deliverable
    scriptContentId = run.contentId

    const req = fake.state.requests.at(-1)
    assert(/-script$/.test(String(req.conversationKey)), '会话键 -script 唯一')
    assert(!/-a\d$/.test(String(req.conversationKey)), '不与角度键混')
    assertEq(req.temperature, 0.4)
    assertEq(req.stream, true)
    assert(req.system.includes('JSON'), 'system 脚本护栏')
    assert(req.instruction.includes('严格只输出一个 JSON 对象'), 'JSON 契约注入')
    assert(req.instruction.includes('业务线：摄影'), '业务线注入')
    assert(req.instruction.includes('婚纱套系 5999'), 'Context Pack 知识库注入')
    assert(req.instruction.includes('【发布平台规则：抖音'), '抖音平台规则注入')

    const versions = await manager.listVersions(project.id, run.contentId)
    assertEq(versions.length, 1, '落 1 个版本行')
    const stored = JSON.parse(versions[0].content)
    assertEq(stored.title, SCRIPT_PAYLOAD.title, '版本行存原始 JSON')
    assertEq(stored.shots[2].durationSec, 300)
    assertEq(versions[0].source, 'ai')
    assert(versions[0].prompt.includes('shooting-script'), '快照标任务')
    assert(versions[0].prompt.includes('"shots"'), '快照含 JSON 契约')
    assert(versions[0].prompt.includes('业务线：摄影'), '快照含业务线')
    assertEq(typeof versions[0].rendered_content, 'string', '版本视图可重渲染')
    assert(versions[0].rendered_content.includes('镜头 1'))

    const row = await manager.getContent(project.id, run.contentId)
    assertEq(row.content_type, 'shooting_script')
    assertEq(row.content, null, '不自动采用：正文仍空')
    return '单路生成 + 版本 JSON + deliverable ✓'
  })

  // ── S3 采用 ──
  await r.check('S3', '采用：deliverable 渲染文本写回 contents.content', async () => {
    const saved = await manager.updateContent(project.id, scriptContentId, { content: lastDeliverable })
    assert(saved.content.includes('【分镜脚本】'), '正文是渲染文本不是 JSON')
    assert(saved.content.includes('行动引导'), '渲染含 CTA')
    return '采用路径 ✓'
  })

  // ── S4 坏 JSON ──
  await r.check('S4', '坏 JSON：result 拒绝 VALIDATION_ERROR、零版本行、草稿保留（原文渲染端保留）', async () => {
    fake.state.mode = 'garbage'
    const run = await manager.generate(project.id, {
      platform: 'douyin',
      contentType: 'shooting_script',
      topic: '坏 JSON 场景'
    })
    for await (const d of run.streams[0].iterator) {
      /* 消费（模拟上屏） */
    }
    const settled = await outcome(run.streams[0].result)
    assertEq(settled.ok, false)
    assertEq(settled.code, 'VALIDATION_ERROR')
    assertEq(settled.details?.reason, 'shooting-script-unparsable')
    const n = await countRows(database, 'content_versions', { content_id: run.contentId })
    assertEq(n, 0, '不落版本行')
    const draft = await manager.getContent(project.id, run.contentId)
    assertEq(draft.content_type, 'shooting_script', '草稿行保留')

    // 渲染端事件面：落库/解析失败必须在 done 之前透传成 error —— 不能被吞成一次「成功 done」。
    // 吞掉的后果：UI 显示「完成」，「采用为正文」条件成立（它 gate 的是 !errorCode），
    // 于是整段未解析的原始输出被写进 contents.content，且没有任何版本行可回溯。
    fake.state.mode = 'garbage'
    const run2 = await manager.generate(project.id, {
      platform: 'douyin',
      contentType: 'shooting_script',
      topic: '坏 JSON 的渲染端事件'
    })
    const events = []
    await forwardGatewayStream(
      { send: (channel, payload) => events.push({ channel, payload }) },
      's4-stream',
      run2.streams[0]
    ).done
    assertEq(
      events.some((e) => e.channel === GATEWAY_STREAM_EVENTS.done),
      false,
      '解析失败不该推 done（否则 UI 显示「完成」并可「采用为正文」）'
    )
    const errEvt = events.find((e) => e.channel === GATEWAY_STREAM_EVENTS.error)
    assert(errEvt, '解析失败应推 error 事件')
    assertEq(errEvt.payload.error.code, 'VALIDATION_ERROR', 'error 事件应带原错误码')
    assertEq(errEvt.payload.error.details?.reason, 'shooting-script-unparsable')
    const streamed = events
      .filter((e) => e.channel === GATEWAY_STREAM_EVENTS.chunk)
      .map((e) => e.payload.delta)
      .join('')
    assert(streamed.trim().length > 0, '已上屏的原始文本仍要保留（渲染端「复制原文」兜底）')
    const n2 = await countRows(database, 'content_versions', { content_id: run2.contentId })
    assertEq(n2, 0, '渲染端事件路径同样零版本行')

    fake.state.mode = 'auto'
    return '解析失败软落地 ✓（result 拒绝 + 渲染端 error 事件）'
  })

  // ── S5 post 回归 ──
  await r.check('S5', 'post 回归：三路 temp 0.8 会话键 -a0/1/2；post 版本不挂 rendered_content', async () => {
    const before = fake.state.requests.length
    const run = await manager.generate(project.id, { platform: 'xiaohongshu', topic: 'post 回归' })
    assertEq(run.contentType, 'post')
    assertEq(run.streams.length, 3)
    assertDeepEq(run.angles.map((a) => a.angle.key), ['direct', 'story', 'objection'], '角度键')
    const settled = await drainStreams(run.streams)
    assertEq(settled.filter((s) => !s.aborted).length, 3)
    const newRequests = fake.state.requests.slice(before)
    assertEq(newRequests.length, 3)
    assertDeepEq(
      newRequests.map((q) => /-a(\d)$/.exec(String(q.conversationKey))?.[1]),
      ['0', '1', '2'],
      '角度会话键'
    )
    assertEq(newRequests[0].temperature, 0.8)
    const versions = await manager.listVersions(project.id, run.contentId)
    assertEq(versions.length, 3)
    for (const v of versions) {
      assertEq(v.rendered_content, undefined, 'post 版本无重渲染字段')
      assertEq(v.content.includes('成稿'), true)
    }
    const row = await manager.getContent(project.id, run.contentId)
    assertEq(row.content_type, 'post')
    assertEq(row.content, null, 'post 同样不自动采用')
    return 'post 三路无回归 ✓'
  })

  // ── S6 不可改 ──
  await r.check('S6', 'content_type 创建后不可改（白名单拒绝未知字段）', async () => {
    const settled = await outcome(
      manager.updateContent(project.id, scriptContentId, { content_type: 'post' })
    )
    assertEq(settled.ok, false)
    assertEq(settled.code, 'VALIDATION_ERROR')
    const row = await manager.getContent(project.id, scriptContentId)
    assertEq(row.content_type, 'shooting_script', '类型未被改动')
    return '类型身份锁定 ✓'
  })

  // ── S8 迁移与默认值 ──
  await r.check('S8', 'v1→v2：user_version=2；create 默认 post / 显式脚本持久化、列可直读', async () => {
    const info = await database.request('schema.info')
    assertEq(info.userVersion, 2, '迁移到 v2')
    const post = await manager.createContent(project.id, { platform: 'xiaohongshu' })
    assertEq(post.content_type, 'post', '默认 post')
    const script = await manager.createContent(project.id, {
      contentType: 'shooting_script',
      platform: 'douyin'
    })
    assertEq(script.content_type, 'shooting_script')
    const rows = await database.request('contents.list', {
      where: { content_type: 'shooting_script' },
      limit: 50
    })
    assert(Array.isArray(rows) && rows.some((row) => row.id === script.id), '列可直读可过滤')
    return '迁移 + 默认值 ✓'
  })

  // ── S10 类型一致性（生成侧 vs 读取侧同一真相） ──
  await r.check('S10', 'generate(contentId)：显式类型与草稿行不一致 → 拒绝；不传则跟随行上类型', async () => {
    // 读取侧（listVersions → attachRenderedContent）按**行上** content_type 决定要不要 parseShootingScript。
    // 生成侧一旦按调用方说法写入不同口径的版本行，那些行就永远拿不到 rendered_content（纯文本当 JSON 展示）。
    const draft = await manager.createContent(project.id, {
      contentType: 'shooting_script',
      platform: 'douyin'
    })

    const bad = await outcome(
      manager.generate(project.id, {
        contentId: draft.id,
        contentType: 'post',
        platform: 'douyin',
        topic: '类型漂移'
      })
    )
    assertEq(bad.ok, false, '显式类型与草稿不一致应拒绝')
    assertEq(bad.code, 'VALIDATION_ERROR')
    assertEq(bad.details?.field, 'contentType')
    assertEq(bad.details?.expected, 'shooting_script')
    assertEq(bad.details?.actual, 'post')
    const leaked = await countRows(database, 'content_versions', { content_id: draft.id })
    assertEq(leaked, 0, '拒绝时不该落任何版本行')

    // 不传 contentType：跟随行上类型（脚本草稿仍走单路 JSON），不退化成 post 三路
    const run = await manager.generate(project.id, {
      contentId: draft.id,
      platform: 'douyin',
      topic: '跟随行上类型'
    })
    assertEq(run.contentType, 'shooting_script', '不传类型时跟随草稿行')
    assertEq(run.streams.length, 1, '脚本仍是单路（不是三路）')
    await drainStreams(run.streams)
    const versions = await manager.listVersions(project.id, draft.id)
    assert(versions.length > 0, '应落版本行')
    for (const v of versions) {
      assert(v.rendered_content !== undefined, '脚本版本行应挂 rendered_content（读取侧口径一致）')
    }
    return '类型一致性守门 ✓'
  })

  // ── S9 静态契约 ──
  await r.check('S9', '静态：IPC/preload 透链 contentType/businessLine；通道不新增', () => {
    const ipcSrc = stripComments(readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'content.ts'), 'utf8'))
    assert(ipcSrc.includes('contentType: run.contentType'), 'IPC 回传 contentType')
    // 回传侧也要断：只断请求侧会让 store 的 `res.data?.businessLine` 静默恒为 null（死链路）
    assert(ipcSrc.includes('businessLine: run.businessLine'), 'IPC 回传 businessLine')
    assert(/businessLine:\s*string \| null/.test(ipcSrc), 'IPC 结果类型声明含 businessLine')
    const preSrc = stripComments(readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf8'))
    assert(preSrc.includes('contentType?: string'), 'preload 含 contentType')
    assert(preSrc.includes('businessLine?: string | null'), 'preload 含 businessLine')
    const channelCount = (ipcSrc.match(/marketing:content:[a-z:]+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i)
    assertEq(channelCount.length, 9, '仍是 9 通道（不新增）')
    const mgrSrc = stripComments(readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'contentManager.ts'), 'utf8'))
    assert(!/from\s*["']electron["']/.test(mgrSrc), 'manager 不 import electron')
    return '静态契约一致 ✓'
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

const result = r.toJSON({ dataDir, nodePath })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-shooting.json'), result)

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* Windows 偶发文件锁；目录在 test/.tmp 下，忽略 */
  }
}

process.exit(ok ? 0 : 1)
