// test/scan.accept.mjs —— Commit 05b 验收：扫描件/图片 AI 识别兜底
//
// **打真实源码**：esbuild 把 electron/main/marketing/scanRecognizer.ts（连带真 documentParsers/
// pdfjs 资产解析）与 gatewayClient.ts、knowledgeManager.ts bundle 成临时 ESM，在纯 Node 里 import；
// HTTP 侧用**真 Node http 服务端**扮演 Gateway（真 socket、真 SSE 帧），不注入假 fetch——
// 「中止真断上游」只有在真 socket 上才证得了（07/08 同口径）。
//
// 覆盖点（对齐 PLAN-2.0.md §七「Commit 05 边界」05b / §二 硬规则 10、13 / §五 + 外部复审 6 条）：
//   S1  契约与纯函数（不 import electron/不发 HTTP/不碰库；assemble/strip 语义）
//   S2  扫描 PDF 端到端：含图请求真发到 multimodal、PNG dataURI、OCR 护栏、会话隔离键
//   S3  分页发送顺序 = 页序
//   S4  资料图：MIME 按魔数不信任扩展名；伪装图/超范围扩展名被拒
//   S5  三闸（整档/页数/单图）+ FILE_NOT_FOUND 全部**发送前**拒，零请求外泄
//   S6  multimodal 未配置：预检（stage=precheck，栅格化前）+ 07 最终防线都透传且零请求
//   S7  中止真断上游（流中途 cancel → 服务端观测 close、aborted:true、已完成页保留、不再产出）
//   S8  增量复用 07 事件名与 forwardGatewayStream（streamId=taskId）
//   S9  5xx → 重试一次成功且流内明示
//   S10 401 → 原码透传**不重试**
//   S11 确认前不落库（直读行数）；commitRecognized 唯一写入口；同文件 upsert 覆盖
//   S12 价格判据本地正则 + store/主进程字面量同源；进度标记同源
//   S13 可行性探针复跑（真扫描 fixture → PNG；证据回写跟踪文件 probe-scan-render.json）
//   S14 静态契约：3 通道三处一致 / picker 含资料图 / abort 两路 / before-quit / store+UI
//   S15 【复审·中】栅格化窗口中止：cancelByProject 即时生效、不发任何模型请求、任务注销
//   S16 【复审·低】一页多图：指令带「本页第 j/k 张图」、汇总按页归组不分节重复、页数按页计
//   S17 内嵌图扫描件（BI/ID/EI）取到图并识别（实测：v3 转译为 paintImageXObject+objs；OPS 86/87 为防御分支）
//   S18 全程不变式：库中唯一行来自人工确认；副本字节一致
//
// 用法：node test/scan.accept.mjs        （npm run accept:scan；--keep-tmp 保留临时目录）

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { buildScannedPdfMulti, buildInlineImagePdf } from './fixtures/make-scanned-pdf.mjs'

const repoRoot = join(__dirname, '..')
const nodePath = resolveNodePath()
const runDir = join(tmpDir, `scan-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const EXTERNALS = ['mammoth', 'exceljs']
const SCANNED_FIXTURE = join(__dirname, 'fixtures', 'min-scanned.pdf')

const scanPath = bundleEntry('electron/main/marketing/scanRecognizer.ts', 'scan-manager.mjs', {
  externals: EXTERNALS
})
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'scan-gateway-client.mjs')
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'scan-knowledge-manager.mjs', {
  externals: EXTERNALS
})
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'scan-project-manager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'scan-database.mjs')
const assetsPath = bundleEntry('electron/main/marketing/parsers/pdfjsAssets.ts', 'scan-pdfjs-assets.mjs')

const scanMod = await import(pathToFileURL(scanPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)
const assetsMod = await import(pathToFileURL(assetsPath).href)

const {
  createScanRecognizer,
  OCR_GUARDRAILS,
  assembleText,
  detectPriceSuspect,
  normalizeRecognizedText,
  stripProgressMarkers
} = scanMod
const { createGatewayClient, forwardGatewayStream, GATEWAY_STREAM_EVENTS } = gwMod
const { createKnowledgeManager, RECOGNIZED_TYPES } = knowMod
const { createProjectManager } = projMod
const { DatabaseClient } = dbMod

const pdfjsAssets = assetsMod.resolvePdfjsAssets({
  isPackaged: false,
  appPath: repoRoot,
  resourcesPath: join(repoRoot, 'unused-resources')
})

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))
/** 用例间传数据（S2 → S3）；必须在一切 check 之前声明（top-level await 后声明会 TDZ） */
const ctx = {}

/** 真 pdfjs 模块（给 S15 的门控包装当底座） */
function realPdfjs() {
  const requireFrom = createRequire(join(__dirname, 'noop.cjs'))
  return requireFrom(join(repoRoot, 'resources', 'pdfjs', 'build', 'pdf.js'))
}

// ── 假 Gateway（真 http 服务端） ──────────────────────────────────────────────

function createFakeGateway() {
  const state = {
    mode: 'ok', // ok | slow | flaky-p2 | auth
    bodies: [], // 收到的 chat 请求体（观测 model / user / 图片部件 / 页指令）
    pageAttempts: {}, // page -> 次数
    closeEarly: 0, // 客户端提前断连次数
    delayMs: 2,
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
      const userMsg = Array.isArray(body?.messages)
        ? body.messages.find((m) => m.role === 'user')?.content
        : null
      const parts = Array.isArray(userMsg) ? userMsg : []
      const imageParts = parts.filter((p) => p?.type === 'image_url')
      const textPart = parts.find((p) => p?.type === 'text')
      const pageMatch = /第 (\d+) 页/.exec(String(textPart?.text ?? ''))
      const page = pageMatch ? Number(pageMatch[1]) : 1
      state.bodies.push({
        model: body?.model ?? null,
        user: body?.user ?? null,
        stream: body?.stream ?? null,
        temperature: body?.temperature ?? null,
        imageCount: imageParts.length,
        imagePrefix: String(imageParts[0]?.image_url?.url ?? '').slice(0, 22),
        instruction: String(textPart?.text ?? ''),
        roles: (body?.messages ?? []).map((m) => m.role).join(','),
        page
      })
      state.pageAttempts[page] = (state.pageAttempts[page] ?? 0) + 1
      const attempt = state.pageAttempts[page]

      if (state.mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'unauthorized' }))
        return
      }
      if (state.mode === 'flaky-p2' && page === 2 && attempt === 1) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'server_error', message: 'boom(p2 first attempt)' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let finished = false
      res.on('close', () => {
        if (!finished) state.closeEarly += 1
      })
      const frames = 2
      for (let i = 1; i <= frames; i++) {
        if (res.writableEnded || res.destroyed) return
        const piece = state.mode === 'slow' ? `慢${page}-${i}` : `答${page}-${i}`
        res.write(`data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: piece } }] })}\n\n`)
        await sleep(state.mode === 'slow' ? 10 : state.delayMs)
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

const listRows = (database, table, where, limit = 1000) =>
  database.request(`${table}.list`, { where, limit }).then((r) => (Array.isArray(r) ? r : []))

/** 消费识别任务的全部增量（顺序采集） */
async function drain(run, onCancel) {
  const seen = []
  for await (const d of run.handle.iterator) {
    seen.push(d)
    if (onCancel && onCancel(d, seen)) break
  }
  return seen
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const r = new Recorder('scan（Commit 05b：扫描件/图片 AI 识别兜底，打真 scanRecognizer.ts + 真 SSE 服务端 + 真库）')
const servers = []

try {
  const database = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-scan-test',
    requestTimeoutMs: 30_000
  })
  clients.add(database)

  const fake = createFakeGateway()
  servers.push(fake)
  const baseUrl = await fake.listen()

  const projects = createProjectManager({ database, dataDir, logger })
  const knowledge = createKnowledgeManager({ database, dataDir, pdfjsAssets, logger })

  /** 配了多模态的客户端（multimodal 用独立 agentId，服务端可观测「含图请求走的是 multimodal」） */
  const gateway = createGatewayClient({
    baseUrl,
    token: '***',
    models: { text: 'openclaw', multimodal: 'openclaw/mm-ocr' },
    conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key,
    logger
  })
  /** 未配置多模态的客户端（S6 最终防线用例） */
  const gatewayNoMm = createGatewayClient({
    baseUrl,
    token: '***',
    models: { text: 'openclaw', multimodal: null },
    conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key,
    logger
  })
  clients.add(gateway)
  clients.add(gatewayNoMm)

  const recognizer = createScanRecognizer({ gateway, pdfjsAssets, logger })
  const recognizerNoMm = createScanRecognizer({ gateway: gatewayNoMm, pdfjsAssets, logger })
  /** 带预检的（S6）：multimodalConfigured=false → 栅格化前拒 */
  const recognizerPre = createScanRecognizer({
    gateway,
    pdfjsAssets,
    logger,
    multimodalConfigured: () => false
  })

  const project = await projects.createProject({ name: '05b 拾光摄影', industry: '摄影' })
  assert(
    existsSync(SCANNED_FIXTURE),
    `扫描 PDF fixture 必须已提交入库: ${SCANNED_FIXTURE}（node test/fixtures/make-scanned-pdf.mjs 重新生成）`
  )

  // 一张真资料图（sharp 现造 PNG；devDependency，参照 knowledge.accept 现造 docx/xlsx 的做法）
  const { default: sharp } = await import('sharp')
  const imgPath = join(runDir, '价目表截图.png')
  writeFileSync(
    imgPath,
    await sharp({
      create: { width: 200, height: 120, channels: 3, background: { r: 240, g: 240, b: 245 } }
    })
      .png()
      .toBuffer()
  )

  // ── S1 契约与纯函数 ──
  await r.check('S1', 'scanRecognizer 纯 Node 可 import；缺 gateway 即 VALIDATION_ERROR；不 import electron/不发 HTTP/不碰库', async () => {
    assertEq(typeof createScanRecognizer, 'function', '应导出工厂')
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'scanRecognizer.ts'), 'utf-8')
    const code = stripComments(src)
    const bundled = readFileSync(scanPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(code), '源码不应 import electron')
    assert(!/from\s*["']electron["']/.test(bundled), 'bundle 内不应存在 electron')
    assert(!/\bfetch\s*\(|node:(http|https|net)|DatabaseClient|database\.request/.test(code), '本模块不得自己发 HTTP / 碰数据库')
    assert(!/knowledge_items|upsertRow/.test(code), '识别模块不应包含任何落库调用（硬规则 10：只有 commitRecognized 能写）')
    const bad = await outcome(Promise.resolve().then(() => createScanRecognizer({ gateway: null })))
    assertEq(bad.code, 'VALIDATION_ERROR', '缺 gateway 应 VALIDATION_ERROR')
    assert(OCR_GUARDRAILS.includes('一个都不要编') && OCR_GUARDRAILS.includes('逐字符照抄'), 'OCR 护栏应写死保真规则')
    // 纯函数口径
    assertEq(assembleText('image', [{ page: 1, text: '裸文本' }]), '裸文本', '单图不加页头')
    assert(assembleText('pdf', [{ page: 1, text: 'a' }, { page: 2, text: 'b' }]).includes('【第 2 页】'), '多页 PDF 带页分节头')
    assertEq(
      assembleText('pdf', [
        { page: 1, text: 'a' },
        { page: 1, text: 'b' }
      ]),
      'a\nb',
      '同页多图归并一节，**不重复【第 N 页】**（复审「低中」）'
    )
    assertEq(normalizeRecognizedText('```json\n正文\n```'), '正文', '剥代码块围栏')
    assertEq(
      stripProgressMarkers('【正在识别第 1 页 / 共 3 页】\n第一页正文\n【正在识别第 2 页 / 共 3 页】\n（第 2 页识别失败，重试 1 次…）\n第二页正文'),
      '第一页正文\n\n第二页正文',
      'stripProgressMarkers 剥页头与重试提示，保留正文'
    )
    assertEq(stripProgressMarkers('【正在识别：套系单.pdf】\n只有正文'), '只有正文', '单图/单页头也剥')
    return '依赖注入 + 无 electron/HTTP/DB + 纯函数口径 ✓'
  })

  // ── S2 扫描 PDF 端到端：含图请求真发到 multimodal ──
  await r.check('S2', '扫描 PDF（真 fixture）→ 逐页含图请求：model=multimodal、image_url data URI、system 护栏、会话隔离键', async () => {
    const before = fake.state.bodies.length
    const run = await recognizer.recognize(project.id, { filePath: SCANNED_FIXTURE })
    assertEq(run.kind, 'pdf', 'kind 应为 pdf')
    assertEq(run.images.length, 3, '应取到 3 页图像')
    assertEq(run.suggestedTitle, 'min-scanned', '默认标题取文件名')
    const seen = await drain(run)
    const res = await run.handle.result
    const bodies = fake.state.bodies.slice(before)
    assertEq(bodies.length, 3, '3 页应恰好 3 次请求（不合并、不静默少发）')
    for (const b of bodies) {
      assertEq(b.model, 'openclaw/mm-ocr', '含图请求必须走 multimodal 模型（不是 text 默认模型）')
      assertEq(b.imageCount, 1, '每次请求恰含 1 张图')
      assert(/^data:image\/png;base64,/.test(b.imagePrefix), `图片必须是 PNG data URI，实际 ${b.imagePrefix}`)
      assertEq(b.roles, 'system,user', '每页 = system 护栏 + user(指令+图)')
      assertEq(b.stream, true, '必须流式（§六）')
      assertEq(b.temperature, 0, 'OCR 应 temperature=0（忠实转录不发挥）')
      assert(
        /^conv:[^:]+:scan-scan-\d+-[a-z0-9]+-p\d+-i\d+-a\d+$/.test(String(b.user)),
        `识别会话键形状 conv:<pid>:scan-<taskId>-p<页>-i<图序>-a<尝试>: ${b.user}`
      )
    }
    assert(
      bodies.every((b) => b.user !== `conv:${project.id}:${project.conversation_key}`),
      '识别请求绝不能打进商家的 sticky 会话（不污染 Advisor 记忆）'
    )
    const users = new Set(bodies.map((b) => b.user))
    assertEq(users.size, 3, '三页会话键互不相同')
    assertEq(res.aborted, false, '正常完成不应 aborted')
    assert(res.text.includes('【第 1 页】') && res.text.includes('答3-2'), '汇总文本按页分节且含末页内容')
    assert(!res.text.includes('正在识别'), '权威汇总不含进度标记')
    assert(seen.length > 0 && seen.every((d, i) => d.index === i + 1), '增量 index 应严格递增')
    assertEq(res.pages.length, 3, 'pages 三页')
    assertEq(res.chunks, seen.length, 'chunks = 转发增量数')
    assertEq(res.usage, null, 'usage 恒 0 → 直接给 null，不参与任何判定')
    ctx.s2 = { run, res }
    return `3 页 × (model=openclaw/mm-ocr, png dataURI, conv:…:${run.taskId.slice(0, 10)}…)；文本 ${res.text.length} 字`
  })

  // ── S3 分页顺序 ──
  await r.check('S3', '分页发送顺序 = 页序（服务端观测请求顺序与页指令一致）', async () => {
    const pages = fake.state.bodies.filter((b) => String(b.user).includes(ctx.s2.run.taskId)).map((b) => b.page)
    assertDeepEq(pages, [1, 2, 3], '三页请求按 1→2→3 顺序到达')
    assert(ctx.s2.run.images.every((img, i) => img.page === i + 1), '图像清单页序连续')
    const texts = ctx.s2.res.pages.map((p) => p.text)
    assertDeepEq(texts, ['答1-1答1-2', '答2-1答2-2', '答3-1答3-2'], '每页文本按页归位不串行')
    return '1→2→3 严格顺序 ✓'
  })

  // ── S4 资料图（png/jpg/webp + 魔数优先） ──
  await r.check('S4', '资料图识别：单请求、MIME 按魔数不信任扩展名、伪装图/不支持扩展名被拒', async () => {
    const before = fake.state.bodies.length
    const run = await recognizer.recognize(project.id, { filePath: imgPath })
    assertEq(run.kind, 'image', 'png → image')
    await drain(run)
    const res = await run.handle.result
    const bodies = fake.state.bodies.slice(before)
    assertEq(bodies.length, 1, '一张图恰好一次请求')
    assertEq(bodies[0].imagePrefix.startsWith('data:image/png'), true, 'PNG 魔数 → image/png')
    assertEq(res.priceSuspected, false, '无价格文本不误报')
    assert(!res.text.includes('【第'), '单图汇总不加页头')

    // 把 PNG 改名为 .jpg：按魔数仍是 image/png（不信任扩展名）
    const liePath = join(runDir, '假装是jpg.jpg')
    writeFileSync(liePath, readFileSync(imgPath))
    const run2 = await recognizer.recognize(project.id, { filePath: liePath })
    await drain(run2)
    await run2.handle.result
    const b2 = fake.state.bodies[fake.state.bodies.length - 1]
    assertEq(b2.imagePrefix.startsWith('data:image/png'), true, '扩展名撒谎，MIME 按魔数判')

    // 内容不是图片的 .png → FILE_PARSE_ERROR(not-an-image)
    const fakePath = join(runDir, '假图片.png')
    writeFileSync(fakePath, Buffer.from('这是一份文本文件伪装成 png', 'utf-8'))
    const bad = await outcome(recognizer.recognize(project.id, { filePath: fakePath }))
    assertEq(bad.code, 'FILE_PARSE_ERROR', '伪装图应 FILE_PARSE_ERROR')
    assertEq(bad.details.reason, 'not-an-image', 'reason=not-an-image')

    // 不支持的扩展名 → VALIDATION_ERROR
    const gif = join(runDir, '客片.gif')
    writeFileSync(gif, Buffer.from('GIF89a' + 'x'.repeat(64)))
    const badGif = await outcome(recognizer.recognize(project.id, { filePath: gif }))
    assertEq(badGif.code, 'VALIDATION_ERROR', 'gif（客片素材）不在 05b 范围')
    assertEq(badGif.details.reason, 'unsupported-file-type', 'reason=unsupported-file-type')
    assertEq(badGif.details.allowed.length, 5, 'allowed 应列 pdf/png/jpg/jpeg/webp')
    return 'png ✓ / 魔数优先 ✓ / 伪装图与 gif 被拒 ✓'
  })

  // ── S5 大小上限：全部发送前拒绝 ──
  await r.check('S5', '上限三闸（整档 file-too-large / 页数 too-many-pages / 单图 image-too-large）都在发请求前拒', async () => {
    const before = fake.state.bodies.length
    const rBig = createScanRecognizer({ gateway, pdfjsAssets, logger, limits: { maxFileBytes: 1024 } })
    const big = await outcome(rBig.recognize(project.id, { filePath: SCANNED_FIXTURE }))
    assertEq(big.code, 'VALIDATION_ERROR', '超整档上限应拒')
    assertEq(big.details.reason, 'file-too-large', 'reason 可分支')

    const rPages = createScanRecognizer({ gateway, pdfjsAssets, logger, limits: { maxPages: 2 } })
    const tooMany = await outcome(rPages.recognize(project.id, { filePath: SCANNED_FIXTURE }))
    assertEq(tooMany.code, 'VALIDATION_ERROR', '页数超限应拒')
    assertEq(tooMany.details.reason, 'too-many-pages', 'reason=too-many-pages')
    assertEq(tooMany.details.max, 2, 'details 带回上限')

    const rImg = createScanRecognizer({ gateway, pdfjsAssets, logger, limits: { maxImageBytes: 2048 } })
    const imgTooBig = await outcome(rImg.recognize(project.id, { filePath: SCANNED_FIXTURE }))
    assertEq(imgTooBig.code, 'VALIDATION_ERROR', '单图过大应拒')
    assertEq(imgTooBig.details.reason, 'image-too-large', 'reason=image-too-large')
    assertEq(imgTooBig.details.page, 1, '报出是第几页')

    const missing = await outcome(recognizer.recognize(project.id, { filePath: join(runDir, '不存在.pdf') }))
    assertEq(missing.code, 'FILE_NOT_FOUND', '文件不存在 → FILE_NOT_FOUND')
    assertEq(fake.state.bodies.length, before, '以上全部在**发送前**拒绝：服务端零新增请求')
    return '三闸 + FILE_NOT_FOUND 均发送前拒（零请求外泄）✓'
  })

  // ── S6 multimodal 未配置：预检 + 最终防线，都透传且不发请求 ──
  await r.check('S6', 'multimodal 未配置：预检（栅格化前 stage=precheck）与 07 最终防线都报 VALIDATION_ERROR/multimodal-model-not-configured，零请求', async () => {
    const before = fake.state.bodies.length
    // 预检：recognize() 本身就拒（不必等流、不等解码）
    const pre = await outcome(recognizerPre.recognize(project.id, { filePath: SCANNED_FIXTURE }))
    assertEq(pre.code, 'VALIDATION_ERROR', '预检应同步 VALIDATION_ERROR')
    assertEq(pre.details.reason, 'multimodal-model-not-configured', '预检 reason 与 07 同值')
    assertEq(pre.details.stage, 'precheck', '预检标 stage=precheck（排障可区分）')
    assertEq(fake.state.bodies.length, before, '预检路径零请求')

    // 最终防线：07（另一个 bundle）抛出的错误原样透传，包装层靠 code 识别不靠 instanceof
    const run = await recognizerNoMm.recognize(project.id, { filePath: SCANNED_FIXTURE })
    const res = await outcome(run.handle.result)
    assertEq(res.ok, false, '应失败')
    assertEq(res.code, 'VALIDATION_ERROR', '按 07 口径 VALIDATION_ERROR')
    assertEq(res.details.reason, 'multimodal-model-not-configured', 'reason 原样透传（UI 据此翻人话）')
    assertEq(fake.state.bodies.length, before, '绝不能把图偷偷用纯文本模型发出去')
    const scanSrc = stripComments(readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'scanRecognizer.ts'), 'utf-8'))
    assert(!/instanceof\s+AppError\s*[\s\S]{0,40}retriable/.test(scanSrc), '可恢复判定不得依赖跨 bundle instanceof')
    return '预检 + 最终防线双保险，0 请求 ✓'
  })

  // ── S7 流中途真断上游 ──
  await r.check('S7', '中止（AbortController）真断上游：服务端观测 close；已完成页保留、aborted:true、不再产出', async () => {
    fake.state.mode = 'slow'
    fake.state.closeEarly = 0
    fake.state.pageAttempts = {}
    try {
      const run = await recognizer.recognize(project.id, { filePath: SCANNED_FIXTURE })
      const seen = []
      let acc = ''
      let cancelled = false
      for await (const d of run.handle.iterator) {
        seen.push(d)
        acc += d.delta
        // 中止时机：第 2 页的流**已在途**（收到它的增量）——这才是「半途断连」
        if (!cancelled && acc.includes('慢2-')) {
          cancelled = true
          run.cancel()
          break
        }
      }
      const res = await run.handle.result
      assertEq(res.aborted, true, 'aborted 应为 true')
      assertEq(cancelled, true, '前置：中止应真的在第 2 页流中途触发')
      assertEq(res.pages.length, 1, '第 1 页已完成应保留；中止中的第 2 页不完整不入结果')
      assertEq(res.pages[0].text.startsWith('慢1'), true, '已完成页文本保留')
      await sleep(150)
      assert(fake.state.closeEarly >= 1, '上游 socket 应被真断（服务端观测 close）')
      const after = seen.length
      await sleep(60)
      assertEq(seen.length, after, 'cancel 后不再有增量')
      // 幂等：再 cancel 不炸；注册表已注销
      run.cancel()
      assertEq(recognizer.activeTaskCount(), 0, '终结后注册表清空')
      return `第 1 页保留、第 2 页丢弃；服务端断连 ${fake.state.closeEarly} 次`
    } finally {
      fake.state.mode = 'ok'
    }
  })

  // ── S8 事件转发复用 07 ──
  await r.check('S8', '流式增量走 07 事件名与 forwardGatewayStream：chunk/done 按 streamId=taskId 归并，载荷形状一致', async () => {
    const run = await recognizer.recognize(project.id, { filePath: imgPath })
    const events = []
    const sink = {
      send: (channel, payload) => events.push({ channel, payload }),
      isDestroyed: () => false,
      once: () => {}
    }
    const forward = forwardGatewayStream(sink, run.taskId, run.handle)
    await forward.done
    const chunks = events.filter((e) => e.channel === GATEWAY_STREAM_EVENTS.chunk)
    const doneEv = events.find((e) => e.channel === GATEWAY_STREAM_EVENTS.done)
    assertEq(events.some((e) => e.channel === GATEWAY_STREAM_EVENTS.error), false, '成功路径不该有 error 事件')
    assert(chunks.length >= 2, `应有 chunk 事件，实际 ${chunks.length}`)
    assert(chunks.every((e) => e.payload.streamId === run.taskId), 'chunk.streamId = 05b 的 taskId')
    assert(doneEv.payload.streamId === run.taskId, 'done.streamId = taskId')
    assertEq(typeof doneEv.payload.text, 'string', 'done 带汇总 text（确认弹窗的数据源）')
    assert(!String(doneEv.payload.text).includes('正在识别'), 'done.text 是干净权威汇总')
    assertEq(doneEv.payload.aborted, false, 'done.aborted 形状与 07 一致')
    assertEq(GATEWAY_STREAM_EVENTS.chunk, 'marketing:gateway:chunk', '事件名就是 07 定死那三个，不新造')
    return `${chunks.length} chunk + done（streamId=${run.taskId.slice(0, 14)}…）✓`
  })

  // ── S9 失败重试（可恢复） ──
  await r.check('S9', '第 2 页上游 5xx → 自动重试一次成功；流里可见重试提示（不静默）', async () => {
    fake.state.mode = 'flaky-p2'
    fake.state.bodies.length = 0
    fake.state.pageAttempts = {}
    try {
      const run = await recognizer.recognize(project.id, { filePath: SCANNED_FIXTURE })
      const seen = await drain(run)
      const res = await run.handle.result
      assertEq(res.pages.length, 3, '三页最终都齐')
      assertEq(fake.state.pageAttempts[2] ?? 0, 2, '第 2 页恰好 2 次尝试（重试 1 次）')
      assertEq(fake.state.pageAttempts[1], 1, '第 1 页不该被重试')
      const all = seen.map((d) => d.delta).join('')
      assert(all.includes('重试'), '重试应向 UI 明示（不静默）')
      assert(!res.text.includes('重试'), '权威汇总不含重试提示（confirm 入库文本干净）')
      return 'p2: 500→重试→成功；p1/p3 各 1 次 ✓'
    } finally {
      fake.state.mode = 'ok'
      fake.state.pageAttempts = {}
    }
  })

  // ── S10 不可恢复错误不重试 ──
  await r.check('S10', '401（鉴权失败）→ OPENCLAW_AUTH_ERROR 透传且**不重试**（配置/鉴权类绝不重复烧 token）', async () => {
    fake.state.mode = 'auth'
    fake.state.bodies.length = 0
    fake.state.pageAttempts = {}
    try {
      const run = await recognizer.recognize(project.id, { filePath: imgPath })
      const res = await outcome(run.handle.result)
      assertEq(res.code, 'OPENCLAW_AUTH_ERROR', '原码透传（§五）')
      assertEq(fake.state.bodies.length, 1, '恰好 1 次请求：不可恢复错误不重试')
      assertEq(recognizer.activeTaskCount(), 0, '失败终结也要注销注册表')
      return '401 → 1 次请求 → OPENCLAW_AUTH_ERROR ✓'
    } finally {
      fake.state.mode = 'ok'
    }
  })

  // ── S11 确认前不落库 + commitRecognized ──
  await r.check('S11', '识别全程不落库（直读行数不变）；确认后才入库（type/status/原文拷贝）；同文件重复确认走 upsert 覆盖', async () => {
    const before = await countRows(database, 'knowledge_items', { project_id: project.id })
    assertEq(before, 0, 'S2-S10 全程识别后，库里必须仍 0 行（识别绝不自动入库，硬规则 10）')
    assertEq(await countRows(database, 'knowledge_items', {}), 0, '全表 0 行')

    const run = await recognizer.recognize(project.id, { filePath: SCANNED_FIXTURE })
    await drain(run)
    const res = await run.handle.result
    assertEq(await countRows(database, 'knowledge_items', { project_id: project.id }), 0, '识别完成后（未确认）依旧 0 行')

    const confirmed = res.text.replace('答2-1', '256') // 用户校对：改掉疑似错读的数字
    const row = await knowledge.commitRecognized(project.id, {
      filePath: SCANNED_FIXTURE,
      type: 'pdf',
      title: '扫描价目表',
      content: confirmed
    })
    assertEq(row.type, 'pdf', 'type=pdf')
    assertEq(row.status, 'ready', 'status=ready')
    assertEq(row.title, '扫描价目表', '用户给的标题')
    assertEq(row.content, confirmed, '入库的是**人工确认（校对）后**的文本，不是模型原文')
    assert(String(row.source_path).startsWith(`projects/${project.id}/min-scanned.pdf`), 'source_path 相对 dataDir 正斜杠（05a 同口径）')
    assertEq(await countRows(database, 'knowledge_items', { project_id: project.id }), 1, '确认后恰 1 行')
    const copied = join(knowledge.projectDir(project.id), 'min-scanned.pdf')
    assertEq(statSync(copied).size, statSync(SCANNED_FIXTURE).size, '原件拷进 data/projects/<id>/（大小一致）')

    // 同一份文件再确认一次（改了文本）→ upsert 覆盖，不加行、created_at 不变
    const firstCreatedAt = row.created_at
    const row2 = await knowledge.commitRecognized(project.id, {
      filePath: SCANNED_FIXTURE,
      type: 'pdf',
      content: confirmed + '\n补一行校对说明'
    })
    assertEq(row2.id, row.id, '重导入语义：同 source_path 覆盖同一行')
    assertEq(row2.created_at, firstCreatedAt, 'created_at 不被刷新')
    assertEq(await countRows(database, 'knowledge_items', { project_id: project.id }), 1, '覆盖后仍 1 行')

    // 校验分支
    const badType = await outcome(knowledge.commitRecognized(project.id, { filePath: imgPath, type: 'text', content: 'x' }))
    assertEq(badType.code, 'VALIDATION_ERROR', 'commitRecognized 只认 pdf/image')
    const badExt = await outcome(knowledge.commitRecognized(project.id, { filePath: SCANNED_FIXTURE, type: 'image', content: 'x' }))
    assertEq(badExt.code, 'VALIDATION_ERROR', 'type 与扩展名不符要拒（pdf 文件不能报 image）')
    const emptyC = await outcome(knowledge.commitRecognized(project.id, { filePath: SCANNED_FIXTURE, type: 'pdf', content: '   ' }))
    assertEq(emptyC.code, 'VALIDATION_ERROR', '空内容不入库')
    const gone = await outcome(knowledge.commitRecognized(project.id, { filePath: join(runDir, '被移走了.pdf'), type: 'pdf', content: 'x' }))
    assertEq(gone.code, 'FILE_NOT_FOUND', '确认期间原件被移走 → FILE_NOT_FOUND（不建无源条目）')
    assertDeepEq([...RECOGNIZED_TYPES], ['pdf', 'image'], 'RECOGNIZED_TYPES 常量')
    assertEq(await countRows(database, 'knowledge_items', { project_id: project.id }), 1, '校验失败不新增行')
    return '识别 0 行 → 确认 1 行 → 重复确认覆盖（id/created_at 不变）；5 个校验分支全拒 ✓'
  })

  // ── S12 价格 + 标记的正则同源（跨 bundle 双份字面量的静态防漂移） ──
  await r.check('S12', '「价格数字请人工核对」判据本地确定性；store 与主进程的价格/标记正则字面量同源', async () => {
    assertEq(detectPriceSuspect('亲子套系 1999 元整'), true, '数字+元')
    assertEq(detectPriceSuspect('套系A ¥5999'), true, '¥+数字')
    assertEq(detectPriceSuspect('我们主打轻奢外景'), false, '无价格不误报')
    assertEq(detectPriceSuspect('2024 年开业'), false, '年份不算价格')
    const storeSrc = readFileSync(join(repoRoot, 'src', 'stores', 'marketing.ts'), 'utf-8')
    const scanSrc = readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'scanRecognizer.ts'), 'utf-8')
    // 跨行安全的字面量提取：`= /…/flags`（声明名开头、到第一个「regex 字面量收尾」）
    const litOf = (src, decl) => {
      const m = new RegExp(`${decl}\\s*=\\s*/([\\s\\S]+?)/[a-z]*(?:\\r?\\n|\\s;|\\s*$)`).exec(src)
      assert(m, `未找到 ${decl} 的正则字面量`)
      return m[1]
    }
    assertEq(
      litOf(storeSrc, 'export const PRICE_SUSPECT_REGEX'),
      litOf(scanSrc, 'export const PRICE_SUSPECT_PATTERN'),
      '价格正则两处字面量必须一致'
    )
    assertEq(
      litOf(storeSrc, 'export const SCAN_PROGRESS_MARKER_REGEX'),
      litOf(scanSrc, 'export const SCAN_PROGRESS_MARKER_PATTERN'),
      '进度标记正则两处字面量必须一致'
    )
    return '四样本判定 ✓；两组正则字面量同源 ✓'
  })

  // ── S13 可行性探针证据 ──
  await r.check('S13', '探针（真扫描 fixture → getOperatorList → objs → 手写 PNG）复跑通过，证据回写跟踪文件', async () => {
    const res = spawnSync(process.execPath, [join(__dirname, 'scan.probe.mjs')], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 240_000
    })
    assertEq(res.status, 0, `探针必须通过（05b 全量范围的前提）；输出尾部：\n${String(res.stdout || '').slice(-500)}${String(res.stderr || '').slice(-300)}`)
    const probe = JSON.parse(readFileSync(join(__dirname, 'probe-scan-render.json'), 'utf-8'))
    assertEq(probe.ok, true, 'probe-scan-render.json.ok')
    assertEq(probe.checks.length, 4, 'P1-P4 四判据')
    assert(probe.checks.every((c) => c.ok), '四判据全绿')
    return `P1-P4 PASS（P2: ${probe.checks[1].detail.slice(0, 60)}…）`
  })

  // ── S14 静态契约 ──
  await r.check('S14', '三条新通道三处一致 + picker 含资料图 + abort 两路 + 预检 wiring + UI 确认弹窗/四路中止/干净文本', async () => {
    const scanIpcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'scan.ts'), 'utf-8')
    const marketIpcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'marketing.ts'), 'utf-8')
    const ipcIndexSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'index.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    const mainSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
    const storeSrc = stripComments(readFileSync(join(repoRoot, 'src', 'stores', 'marketing.ts'), 'utf-8'))
    const vueSrc = readFileSync(join(repoRoot, 'src', 'views', 'marketing', 'KnowledgeBase.vue'), 'utf-8')
    const knowledgeSrc = readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'knowledgeManager.ts'), 'utf-8')

    const channels = [
      'marketing:knowledge:recognize',
      'marketing:knowledge:recognize:abort',
      'marketing:knowledge:commitRecognized'
    ]
    for (const c of channels) {
      assert(scanIpcSrc.includes(`'${c}'`), `ipc/scan.ts 应声明通道 ${c}`)
      assert(preloadSrc.includes(`'${c}'`), `preload 应暴露通道 ${c}`)
    }
    assert(/MARKETING_SCAN_CHANNELS/.test(ipcIndexSrc), 'ipc/index.ts 应转出 scan 通道表')
    assert(/forwardGatewayStream\(/.test(scanIpcSrc), 'scan.ts 应经 forwardGatewayStream 转发增量')
    assert(!/\.send\(\s*['"]marketing:(?!gateway)/.test(scanIpcSrc), 'scan.ts 不得自造流事件名（只许 07 那三个）')
    // abort 两路定位（复审：栅格化窗口不得空转）
    assert(/cancelTask\(/.test(scanIpcSrc) && /cancelByProject\(/.test(scanIpcSrc), 'abort IPC 应两路定位（taskId / projectId）')
    assert(preloadSrc.includes("'marketing:knowledge:recognize:abort', taskId ?? null, projectId ?? null"), 'preload abort 带双参')
    assert(/aborted:\s*false/.test(scanIpcSrc), 'abort 幂等语义（已结束返回 aborted:false）')
    assert(/export function abortAllScanStreams/.test(scanIpcSrc), '导出 abortAllScanStreams')
    assert(/registeredRecognizer\.cancelAll\(\)/.test(scanIpcSrc), '退出中止应过 recognizer 注册表（覆盖栅格化窗口）')
    // 预检 wiring
    assert(/multimodalConfigured: \(\) => Boolean\(resolveGatewayModels\(\)\.multimodal\)/.test(mainSrc), 'main wiring 注入多模态预检（复用按次解析）')
    // picker 含资料图（复审「小」：png/jpg 至少可选）
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      assert(new RegExp(`'${ext}'`).test(marketIpcSrc), `picker filters 应含 ${ext}（05b 资料图入口）`)
    }
    assert(/资料图/.test(marketIpcSrc), 'picker 应把资料图单列并提示需 AI 识别')
    // 05a 联动：scanned-pdf 不落行现状不变
    assert(/reason:\s*'scanned-pdf'/.test(readFileSync(join(repoRoot, 'electron', 'main', 'marketing', 'parsers', 'documentParsers.ts'), 'utf-8')), '05a 扫描件检测保持')
    assert(!/commitRecognized/.test(knowledgeSrc.match(/async importKnowledge[\s\S]*?\n  \}/)?.[0] ?? ''), 'importKnowledge 未被 05b 改动（不落行现状不变）')

    // store 契约
    for (const name of [
      'scanTask',
      'scanStreaming',
      'scanText',
      'scanCleanText',
      'scanAborted',
      'scanPriceSuspected',
      'scanErrorCode',
      'scanErrorReason',
      'recognizeScan',
      'stopRecognize',
      'clearScan',
      'commitRecognized',
      'disposeScan',
      'scanCallSeq'
    ]) {
      assert(new RegExp(`\\b${name}\\b`).test(storeSrc), `store 应暴露/包含 ${name}`)
    }
    assert(!/error\.message\.includes\(|message\.includes\(/.test(storeSrc), 'store 禁止 message.includes() 判断（§五）')

    // UI：显式触发 + 人话引导 + 确认弹窗 + 价格核对 + 四路中止 + 干净文本入库
    assert(vueSrc.includes('用 AI 识别'), '导入报错处应有「用 AI 识别」按钮（显式触发）')
    assert(vueSrc.includes('multimodal-model-not-configured'), 'UI 应识别 multimodal 未配置 reason')
    assert(vueSrc.includes('支持图片的模型'), 'multimodal 未配置要翻成人话引导去配置（不静默）')
    assert(vueSrc.includes('价格数字请人工核对'), '确认弹窗应有「价格数字请人工核对」显著提示')
    assert(vueSrc.includes('确认入库'), '确认弹窗的落库按钮')
    assert(/confirmContent\.value = marketing\.scanCleanText/.test(vueSrc), '确认弹窗以**剥掉进度标记**的干净文本为基准（复审：中止态防标记入库）')
    assert(/marketing\.scanCleanText/.test(vueSrc), '预览也用干净文本')
    assert(/scannedPdfHit[\s\S]{0,200}scanned-pdf/.test(vueSrc), '按钮出现条件绑定 scanned-pdf/资料图')
    assert(/onBeforeUnmount\([\s\S]{0,200}disposeScan/.test(vueSrc), '组件卸载 → 断上游 + 注销订阅（四路之卸载路）')
    assert(/currentProjectId[\s\S]{0,200}clearScan/.test(vueSrc), '切换商家 → clearScan 中止（四路之切商家路）')
    assert(/stopRecognize\(\)/.test(vueSrc), '停止按钮（四路之停止路）')
    assert(preloadSrc.includes("'marketing:knowledge:recognize', projectId"), 'preload 显式传 projectId（硬规则 9）')
    assert(mainSrc.includes('abortAllScanStreams()'), 'main before-quit 接第四路')
    return '3 通道三处一致；两路 abort；预检 wiring；picker 资料图；store 14 项；UI 触发/人话/价格/确认/干净文本/四路 ✓'
  })

  // ── S15 【复审·中】栅格化窗口中止 ──
  await r.check('S15', '栅格化还没结束就切商家/按停止：cancelByProject 即时命中，PDF 解码后不发任何模型请求，任务以「已中止」收场并注销', async () => {
    // 门控 loadPdfjs：getDocument 挂起，等测试放行——模拟「解码窗口」
    let releaseGate
    const gate = new Promise((r) => (releaseGate = r))
    const real = realPdfjs()
    const gatedRecognizer = createScanRecognizer({
      gateway,
      pdfjsAssets,
      logger,
      loadPdfjs: () =>
        new Proxy(real, {
          get(t, k) {
            if (k === 'getDocument') {
              return (init) => ({
                promise: gate.then(() => t.getDocument(init).promise)
              })
            }
            const v = Reflect.get(t, k)
            return typeof v === 'function' ? v.bind(t) : v
          }
        })
    })
    const before = fake.state.bodies.length
    const p = gatedRecognizer.recognize(project.id, { filePath: SCANNED_FIXTURE })
    // 注册表在栅格化**之前**就有任务（复审修正的核心断言）
    assertEq(gatedRecognizer.activeTaskCount(), 1, '解码窗口内任务已在注册表（不再是空转期）')
    assertEq(gatedRecognizer.cancelTask('scan-does-not-exist'), false, '未知 taskId → false（幂等）')
    const n = gatedRecognizer.cancelByProject(project.id)
    assertEq(n, 1, '按商家取消命中 1 个（渲染端切商家走的就是这条路）')
    releaseGate() // 放行解码；页循环应在 isAborted 处 break
    const res = await outcome(p)
    assertEq(res.ok, false, '中止的 recognize 以错误收场')
    assertEq(res.code, 'OPENCLAW_TIMEOUT', '按 07 中止语义 OPENCLAW_TIMEOUT')
    assertEq(res.details.reason, 'aborted', 'reason=aborted（可分支）')
    assertEq(fake.state.bodies.length, before, '栅格化窗口中止后**一页都不该发**（零模型调用）')
    assertEq(gatedRecognizer.activeTaskCount(), 0, '终结即注销，不泄漏')
    return '解码窗口 abort 即时生效；0 请求；注册表干净 ✓'
  })

  // ── S16 【复审·低中】一页多图语义 ──
  await r.check('S16', '一页两张图：每图一次请求、指令带「本页第 j/2 张图」、会话键 i 段不同、汇总合并为一节（不重复页头）、页数按页计', async () => {
    const mkJpeg = (v) =>
      sharp(Buffer.alloc(320 * 200 * 3, v), { raw: { width: 320, height: 200, channels: 3 } })
        .jpeg({ quality: 80 })
        .toBuffer()
    const jA = await mkJpeg(30)
    const jB = await mkJpeg(200)
    const multiPath = join(runDir, '同页双图.pdf')
    writeFileSync(multiPath, buildScannedPdfMulti([{ width: 320, height: 200, images: [{ jpeg: jA, width: 320, height: 200 }, { jpeg: jB, width: 320, height: 200 }] }]))

    const before = fake.state.bodies.length
    const run = await recognizer.recognize(project.id, { filePath: multiPath })
    assertEq(run.images.length, 2, '两图两张发')
    assertDeepEq(run.images.map((i) => i.page), [1, 1], '都属第 1 页')
    assertDeepEq(run.images.map((i) => i.imageInPage), [1, 2], '页内序号 1/2')
    assertDeepEq(run.images.map((i) => [i.imagesOnPage, i.totalPages]), [[2, 1], [2, 1]], '页/图语义：1 页 2 图')
    await drain(run)
    const res = await run.handle.result
    const bodies = fake.state.bodies.slice(before)
    assertEq(bodies.length, 2, '两次请求')
    assert(bodies[0].instruction.includes('本页第 1/2 张图'), `指令应标张序: ${bodies[0].instruction.slice(0, 60)}`)
    assert(bodies[1].instruction.includes('本页第 2/2 张图'), '第二条标 2/2')
    const users = new Set(bodies.map((b) => b.user))
    assertEq(users.size, 2, '两图会话键不同（i 段）')
    assertEq(res.pages.length, 2, '两条页内文本')
    assertEq((res.text.match(/【第 1 页】/g) ?? []).length, 0, '单页文档**不许**出现重复页分节头（复审）')
    assert(!res.text.includes('第 2 页'), '一页就是一页，没有「第 2 页」')
    // too-many-pages 文案按页不按图：limits.maxPages=1 时 1 页 2 图不该被拒
    const r1 = createScanRecognizer({ gateway, pdfjsAssets, logger, limits: { maxPages: 1 } })
    const run2 = await r1.recognize(project.id, { filePath: multiPath })
    await drain(run2)
    await run2.handle.result
    assertEq(fake.state.bodies.filter((b) => String(b.user).includes(run2.taskId)).length, 2, '1 页限下仍发 2 图')
    return '2 图/1 页：j/k 指令、独立会话、无重复节、按页计数 ✓'
  })

  // ── S17 【复审·低中】内嵌图（BI/ID/EI）扫描件 ──
  await r.check('S17', '内嵌图扫描件（BI/ID/EI 1BPP）能取到图并识别（实测：v3 worker 转译为 paintImageXObject+合成 objs 键；OPS 86/87 分支作为防御保留）', async () => {
    const inlinePath = join(runDir, '内嵌图.pdf')
    writeFileSync(inlinePath, buildInlineImagePdf(200, 160))
    const before = fake.state.bodies.length
    const run = await recognizer.recognize(project.id, { filePath: inlinePath })
    assertEq(run.images.length, 1, '内嵌图应取到（修复前这类文件 no-images 假阴性）')
    assertEq(run.images[0].width, 200, '宽')
    assertEq(run.images[0].height, 160, '高')
    await drain(run)
    const res = await run.handle.result
    assertEq(fake.state.bodies.length, before + 1, '发了一次识别请求')
    assertEq(fake.state.bodies[before].imagePrefix.startsWith('data:image/png'), true, '位图重编码为 PNG')
    assertEq(res.pages.length, 1, '结果一页')
    // 实测事实（写探针时探出，已同步进 §六 与 fixture 注释）：pdfjs v3 对 BI/ID/EI 发的是
    // paintImageXObject + 合成 objId `img_p0_1`（走 page.objs，不走 commonObjs），
    // 而非 OPS 86；取图代码两条都接住（86/87 作防御分支），不赌单一形态。
    return '内嵌图 ✓（v3 实测转译为 paintImageXObject+objs；1BPP→RGBA→PNG→dataURI）'
  })

  // ── S18 全程不变式 ──
  await r.check('S18', '全程不变式：库中唯一行来自人工确认；无空内容行；原文拷贝字节一致', async () => {
    const rows = await listRows(database, 'knowledge_items', {})
    assertEq(rows.length, 1, '全库应恰 1 行（S11 确认入库那条）')
    assertEq(rows[0].status, 'ready', 'status=ready')
    assert(String(rows[0].content).trim().length > 0, '无空内容行（05a 硬要求保持）')
    const copied = join(knowledge.projectDir(project.id), 'min-scanned.pdf')
    assert(readFileSync(copied).equals(readFileSync(SCANNED_FIXTURE)), '入库副本与 fixture 字节一致')
    return `唯一行 id=${String(rows[0].id).slice(0, 8)}…（人工确认产物；副本字节一致）`
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

const result = r.toJSON({ bundle: scanPath, dataDir, nodePath, fixture: SCANNED_FIXTURE, logSample: logs.slice(0, 10) })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-scan.json'), result)
console.log('结果已写入 test/accept-result-scan.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
