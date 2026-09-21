// test/gateway.accept.mjs —— Commit 07 验收：Gateway Client（探活/拉起/SSE/中止/会话隔离/端点开关）
//
// **打真实源码**：esbuild 把 electron/main/gatewayClient.ts（以及会话隔离用的真 ProjectManager +
// 真 DatabaseClient）bundle 成临时 ESM，在纯 Node 里 import；HTTP 侧用**真 Node http 服务端**
// 扮演 Gateway（真 socket、真 SSE 帧、真断连），不注入假 fetch —— 这样测到的是真实的
// fetch/undici 行为（含 cancel 时上游 socket 真的被销毁）。
//
// 配置侧（端点开关默认化 + 老用户迁移 + 待办 #15）打**真 configManager.ts**：
// 用 CLAW_DATA_DIR 指到临时目录，只在 'electron' 这个宿主边界打桩（见 test/fixtures/electron-stub.mjs）。
//
// 覆盖点（对齐 PLAN-2.0.md §二 硬规则 13 / §五 错误码 / §六 已实测事实 / §七 Commit 07 / §九 待办 #15）：
//   - 探活 / 端点开关判据 / 只读快照（零 token：不发 chat、不拉起）
//   - 错误映射：401→AUTH、404→NOT_READY(endpoint-disabled)、400→VALIDATION、5xx→NOT_READY(upstream)
//   - SSE 流式：增量顺序/拼接/usage 透传；**半途 abort：上游连接真断 + aborted:true + 不再产出**
//   - 截断（无 [DONE]）与流内 error 帧 → 明确错误码
//   - 自动拉起（starter 只调一次、单飞）；拉起失败 / 轮询超时 → NOT_READY(start-failed) / TIMEOUT
//   - 端口退让跟随：配置端口被占（health 活但兼容面 404）→ 按 actualPortResolver 跟随实际端口（实测 3213→3214）
//   - 会话隔离 user=conv:<projectId>:<conversation_key>（key 从库里取）+ 注入防护
//   - 多模态模型选择与图片部件校验
//   - SSE→IPC 透传助手：事件序、cancel 后静默、error 事件、渲染进程销毁自动中止
//   - 端点开关默认化 + 老用户迁移幂等且不毁其它字段 + #15 的 meta 修正
//
// 用法：node test/gateway.accept.mjs    （加 --keep-tmp 保留临时目录；npm run accept:gateway）

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
const runDir = join(tmpDir, `gateway-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
mkdirSync(runDir, { recursive: true })

const repoRoot = join(__dirname, '..')

// ── bundle 真源码 ─────────────────────────────────────────────────────────────
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'gateway-client.mjs')
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'project-manager-for-gateway.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'gateway-database.mjs')
// configManager 顶层 import { app, dialog } from 'electron' → 在该边界打桩（其余全是真源码）
// 另外它静态引入 adm-zip（内含 `require('fs')`），打进 ESM bundle 会变成
// "Dynamic require of fs is not supported" → 标成 external，由 Node 按 CJS 加载
const configPath = bundleEntry('electron/main/configManager.ts', 'gateway-config-manager.mjs', {
  alias: ['electron=./test/fixtures/electron-stub.mjs'],
  externals: ['adm-zip']
})
// downloadManager 同样经 configManager 碰到 electron → 同一套桩；adm-zip 是动态 import，标 external
const downloadPath = bundleEntry('electron/main/downloadManager.ts', 'gateway-download-manager.mjs', {
  alias: ['electron=./test/fixtures/electron-stub.mjs'],
  externals: ['adm-zip']
})

const gw = await import(pathToFileURL(gatewayPath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)
const cfgMod = await import(pathToFileURL(configPath).href)
const dlMod = await import(pathToFileURL(downloadPath).href)

const {
  GatewayClient,
  createGatewayClient,
  GATEWAY_ENDPOINTS,
  GATEWAY_STREAM_EVENTS,
  GATEWAY_MODEL_DEFAULT,
  GATEWAY_ABORT_REASON,
  GATEWAY_TIMEOUT_REASONS,
  GATEWAY_DEFAULT_TIMEOUTS,
  CONVERSATION_USER_PREFIX,
  normalizeGatewayModel,
  isValidGatewayModel,
  detectMultimodalCapability,
  selectGatewayModel,
  imageDataPart,
  imageUrlPart,
  textPart,
  messageHasImages,
  buildConversationUser,
  forwardGatewayStream
} = gw
const { DatabaseClient } = dbMod
const { ConfigManager } = cfgMod
const { DownloadManager } = dlMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

// ── 假 Gateway（真 http 服务端，不是假 fetch） ────────────────────────────────
function createFakeGateway() {
  const state = {
    mode: 'ok', // ok | modelsDisabled | auth | badModel | server500 | truncate | streamError
    chunkCount: 6,
    chunkDelayMs: 2,
    healthRequests: 0,
    modelsRequests: 0,
    chatRequests: 0,
    chatBodies: [],
    chunkFramesSent: 0,
    clientClosedEarly: 0,
    port: 0
  }
  const server = createServer(async (req, res) => {
    const url = req.url || ''
    if (url.startsWith(GATEWAY_ENDPOINTS.health)) {
      state.healthRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'live' }))
      return
    }
    if (url.startsWith(GATEWAY_ENDPOINTS.models)) {
      state.modelsRequests += 1
      if (state.mode === 'modelsDisabled') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'not_found', message: 'endpoint disabled' } }))
        return
      }
      if (state.mode === 'modelsGarbage') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('not-json-at-all')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'openclaw' }, { id: 'openclaw/main' }] }))
      return
    }
    if (url.startsWith(GATEWAY_ENDPOINTS.chatCompletions)) {
      state.chatRequests += 1
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        /* 保留 null，由断言暴露 */
      }
      state.chatBodies.push({ headers: req.headers, body, raw })
      if (state.mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'unauthorized' }))
        return
      }
      if (state.mode === 'badModel') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'invalid_request_error', message: 'unknown model' }))
        return
      }
      if (state.mode === 'server500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'internal_error', message: 'boom' }))
        return
      }
      // 非流式：真 Gateway 在 stream=false 时回一整个 JSON（不是 SSE）
      if (body && body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'openclaw',
            choices: [{ message: { role: 'assistant', content: '非流式回复' } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          })
        )
        return
      }
      // 响应头迟迟不来：用于「响应头**之前**中止」的时序用例（G23）
      if (state.mode === 'slowHeaders') await sleep(300)
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let finished = false
      res.on('close', () => {
        if (!finished) state.clientClosedEarly += 1
      })
      for (let i = 1; i <= state.chunkCount; i++) {
        if (res.writableEnded || res.destroyed) return
        if (state.mode === 'streamError' && i === 2) {
          res.write(`data: ${JSON.stringify({ error: { type: 'upstream_error', message: '模型炸了' } })}\n\n`)
          finished = true
          res.end()
          return
        }
        if (state.mode === 'truncate' && i === 3) {
          finished = true
          res.destroy() // 没有 [DONE]：模拟响应被截断
          return
        }
        res.write(
          `data: ${JSON.stringify({ model: 'openclaw', choices: [{ delta: { content: `片${i}` } }] })}\n\n`
        )
        state.chunkFramesSent += 1
        await sleep(state.chunkDelayMs)
      }
      res.write(
        `data: ${JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`
      )
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
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      state.port = server.address().port
      return `http://127.0.0.1:${state.port}`
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

/** 假时钟：每次读时间前进 step（让「就绪轮询」的用例不必真等） */
function fakeClock(stepMs = 500) {
  let t = 1_000_000
  return {
    now: () => {
      t += stepMs
      return t
    }
  }
}

function makeClient(baseUrl, overrides = {}) {
  const client = createGatewayClient({
    baseUrl,
    token: 'test-gateway-token',
    logger,
    sleepImpl: async () => {},
    ...overrides
  })
  clients.add(client)
  return client
}

function makeClientNoTrack(baseUrl, overrides = {}) {
  return createGatewayClient({ baseUrl, token: 'test-gateway-token', logger, ...overrides })
}

async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 造一个「老用户」openclaw.json（含自定义字段），返回路径 */
function writeLegacyOpenClawConfig(targetDataDir, extra = {}) {
  const p = join(targetDataDir, 'config', '.openclaw', 'openclaw.json')
  mkdirSync(dirname(p), { recursive: true })
  const legacy = {
    gateway: {
      mode: 'local',
      auth: { mode: 'token', token: 'legacy-token' },
      customFlag: 'keep-me',
      http: { endpoints: { chatCompletions: { customSubKey: 'keep-sub' } } }
    },
    channels: { customChannelKeep: { appId: 'keep-channel' } },
    customTopLevel: 'keep-top',
    agents: { defaults: { workspace: 'C:/legacy/workspace', custom: 'keep-agent' } },
    meta: { lastTouchedAt: '2026-09-01T00:00:00.000Z', lastTouchedVersion: 'latest', customMeta: 'keep-meta' },
    ...extra
  }
  writeFileSync(p, JSON.stringify(legacy, null, 2), 'utf-8')
  return p
}

const r = new Recorder('gateway（Gateway Client：探活/拉起/SSE/中止/会话隔离，打真 gatewayClient.ts）')
const ctx = {}
const servers = []

try {
  // ── G1 契约与构造 ──
  await r.check('G1', 'gatewayClient.ts 可纯 Node import；端点/事件名/超时契约在位；缺依赖即炸', async () => {
    assert(typeof GatewayClient === 'function', '应导出 GatewayClient')
    assertEq(typeof createGatewayClient, 'function', '应导出 createGatewayClient 工厂')
    assertEq(typeof forwardGatewayStream, 'function', '应导出 SSE→IPC 透传助手')
    const src = readFileSync(join(repoRoot, 'electron', 'main', 'gatewayClient.ts'), 'utf-8')
    const bundled = readFileSync(gatewayPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(src), '源码不应 import electron（token 注入，不 import 宿主 API）')
    assert(!/from\s*["']electron["']/.test(bundled), 'bundle 内不应存在 electron')
    // §六 实测的端点
    assertEq(GATEWAY_ENDPOINTS.health, '/health', 'health 端点应为 /health')
    assertEq(GATEWAY_ENDPOINTS.models, '/v1/models', 'models 端点应为 /v1/models')
    assertEq(GATEWAY_ENDPOINTS.chatCompletions, '/v1/chat/completions', 'chat 端点应为 /v1/chat/completions')
    assertEq(GATEWAY_MODEL_DEFAULT, 'openclaw', '默认 model 应为 openclaw（§六 实测）')
    assertEq(CONVERSATION_USER_PREFIX, 'conv:', '会话隔离键前缀应为 conv:')
    assertEq(GATEWAY_STREAM_EVENTS.chunk, 'marketing:gateway:chunk', 'chunk 事件名')
    assertEq(GATEWAY_STREAM_EVENTS.done, 'marketing:gateway:done', 'done 事件名')
    assertEq(GATEWAY_STREAM_EVENTS.error, 'marketing:gateway:error', 'error 事件名')
    // §六 时序事实：控制面短、数据面等得起
    assert(GATEWAY_DEFAULT_TIMEOUTS.healthTimeoutMs <= 5_000, 'health 超时应短（实测 97ms）')
    assert(
      GATEWAY_DEFAULT_TIMEOUTS.requestTimeoutMs >= 90_000,
      '非流式超时需覆盖 80.3s 冷启动'
    )
    const bad = await outcome(Promise.resolve().then(() => createGatewayClient({ token: 't' })))
    assertEq(bad.code, 'VALIDATION_ERROR', '缺 baseUrl 应 VALIDATION_ERROR')
    const badToken = await outcome(Promise.resolve().then(() => createGatewayClient({ baseUrl: 'http://127.0.0.1:1' })))
    assertEq(badToken.code, 'VALIDATION_ERROR', '缺 token 应 VALIDATION_ERROR')
    return `端点/事件名/超时契约齐全；bundle 无 electron；缺依赖即 VALIDATION_ERROR`
  })

  const fake = createFakeGateway()
  servers.push(fake)
  const baseUrl = await fake.listen()

  // ── G2 探活 ──
  await r.check('G2', '探活：/health 200 即就绪判据之一；连不上 → OPENCLAW_NOT_READY(connect-failed)', async () => {
    const client = makeClient(baseUrl)
    const ok = await client.probe()
    assertEq(ok.ok, true, '服务端在 → 探活应成功')
    assertEq(ok.status, 200, '应回 HTTP 200')
    assert(ok.error === null, '成功时 error 应为 null')
    assertEq(fake.state.healthRequests >= 1, true, '服务端应收到 /health')

    // 未监听的端口：真连接失败（不是超时）
    const dead = makeClient('http://127.0.0.1:1')
    const bad = await dead.probe()
    assertEq(bad.ok, false, '连不上应失败')
    assertEq(bad.error.code, 'OPENCLAW_NOT_READY', '连不上应是 OPENCLAW_NOT_READY')
    assertEq(bad.error.details.reason, GATEWAY_TIMEOUT_REASONS.connect, '原因应为 connect-failed')
    return `探活 200 OK（${ok.ms}ms）；死端口 → ${bad.error.code}/${bad.error.details.reason}`
  })

  // ── G3 端点开关判据 ──
  await r.check('G3', '端点开关：/v1/models 200 才算兼容面开启；404 → endpoint-disabled', async () => {
    const client = makeClient(baseUrl)
    const on = await client.listModels()
    assertEq(on.enabled, true, '开启时 enabled 应为 true')
    assert(on.models.includes('openclaw'), '模型清单应含 openclaw（§六 实测）')

    fake.state.mode = 'modelsDisabled'
    try {
      const off = await client.listModels()
      assertEq(off.enabled, false, '404 时 enabled 应为 false')
      assertEq(off.error.code, 'OPENCLAW_NOT_READY', '应给 OPENCLAW_NOT_READY')
      assertEq(off.error.details.reason, GATEWAY_TIMEOUT_REASONS.endpointDisabled, '原因应为 endpoint-disabled')
      assertEq(off.error.details.status, 404, '应带 HTTP 404')
    } finally {
      fake.state.mode = 'ok'
    }
    return `开启 → 2 个模型；关闭 → ${'endpoint-disabled'}`
  })

  // ── G4 只读快照（零 token） ──
  await r.check('G4', 'getStatus 是只读面：零 token（不发 chat、不触发拉起）', async () => {
    let starterCalls = 0
    const chatsBefore = fake.state.chatRequests
    const client = makeClient(baseUrl, {
      starter: () => {
        starterCalls += 1
        return { started: false }
      }
    })
    const ready = await client.getStatus()
    assertEq(ready.ready, true, '探活 + 兼容面都通 → ready')
    assertEq(ready.endpointsEnabled, true, '应回显端点已开')
    assertEq(ready.port, fake.state.port, '应回显端口')
    assertEq(ready.baseUrl, baseUrl, '应回显 baseUrl')
    assertEq(ready.lastError, null, '成功时 lastError 应为 null')
    assertEq(starterCalls, 0, 'getStatus 不得触发自动拉起')
    assertEq(fake.state.chatRequests, chatsBefore, 'getStatus 不得发 chat 请求（零 token）')

    fake.state.mode = 'modelsDisabled'
    try {
      const notReady = await client.getStatus()
      assertEq(notReady.ready, false, '兼容面关闭 → 不就绪')
      assertEq(notReady.endpointsEnabled, false, '应回显端点未开')
      assert(notReady.lastError && notReady.lastError.code === 'OPENCLAW_NOT_READY', 'lastError 应可读')
      const env = JSON.stringify(notReady)
      assert(!env.includes('test-gateway-token'), '快照里绝不能出现 token（硬规则 13）')
    } finally {
      fake.state.mode = 'ok'
    }
    return `ready=${ready.ready}/port=${ready.port}；零 chat、零拉起；快照无 token`
  })

  // ── G5 错误映射 ──
  await r.check('G5', '错误映射：401→AUTH / 400→VALIDATION / 5xx→NOT_READY(upstream)', async () => {
    const cases = [
      ['auth', 'OPENCLAW_AUTH_ERROR'],
      ['badModel', 'VALIDATION_ERROR'],
      ['server500', 'OPENCLAW_NOT_READY']
    ]
    const seen = []
    for (const [mode, expected] of cases) {
      fake.state.mode = mode
      const client = makeClient(baseUrl)
      const res = await outcome(
        client.chat({ projectId: 'p1', messages: [{ role: 'user', content: 'hi' }], conversationKey: 'k' })
      )
      assertEq(res.ok, false, `${mode} 应失败`)
      assertEq(res.code, expected, `${mode} 应映射为 ${expected}（实际 ${res.code}）`)
      if (mode === 'badModel') {
        assertEq(res.details.upstreamType, 'invalid_request_error', '应带上游 type')
      }
      if (mode === 'server500') {
        assertEq(res.details.reason, GATEWAY_TIMEOUT_REASONS.upstream, '5xx 原因应为 upstream-error')
      }
      seen.push(`${mode}→${res.code}`)
    }
    fake.state.mode = 'ok'
    return seen.join(' / ')
  })

  // ── G6 流式 ──
  await r.check('G6', 'SSE 流式：增量顺序与拼接正确、usage 全 0 透传不炸、result 字段齐', async () => {
    fake.state.mode = 'ok'
    fake.state.chunkCount = 6
    const client = makeClient(baseUrl)
    const handle = client.createChatStream({
      projectId: 'p-stream',
      conversationKey: 'k',
      messages: [{ role: 'user', content: '写点东西' }]
    })
    const deltas = []
    for await (const d of handle.iterator) deltas.push(d)
    const res = await handle.result
    assertEq(deltas.length, 6, '应收到 6 个增量')
    assertEq(deltas.map((d) => d.index).join(','), '1,2,3,4,5,6', '增量序号应连续递增')
    assertEq(deltas.map((d) => d.delta).join(''), '片1片2片3片4片5片6', '拼接文本应按序')
    assertEq(res.text, '片1片2片3片4片5片6', 'result.text 应与增量拼接一致')
    assertEq(res.chunks, 6, 'result.chunks 应为 6')
    assertEq(res.aborted, false, '正常收尾不应是 aborted')
    assertEq(res.model, 'openclaw', '应回显 model')
    assertEq(res.usage.total_tokens, 0, 'usage 恒 0 也要原样透传（§六 实测）')
    // 请求体是流式
    const body = fake.state.chatBodies[fake.state.chatBodies.length - 1].body
    assertEq(body.stream, true, '流式请求 stream 应为 true')
    assertEq(body.model, 'openclaw', '默认 model 应为 openclaw')
    assertEq(body.messages.length, 1, '应带 1 条消息')
    return `6 个增量按序；text=${res.text}；usage.total_tokens=0 透传`
  })

  // ── G7 半途 abort（上游真断连） ──
  await r.check('G7', '半途 abort：上游 socket 真被断开、aborted:true、之后不再产出（不是超时）', async () => {
    fake.state.mode = 'ok'
    fake.state.chunkCount = 80
    fake.state.chunkDelayMs = 15
    fake.state.clientClosedEarly = 0
    fake.state.chunkFramesSent = 0
    try {
      const client = makeClient(baseUrl)
      const handle = client.createChatStream({
        projectId: 'p-abort',
        conversationKey: 'k',
        messages: [{ role: 'user', content: '很长的一段' }]
      })
      const seen = []
      for await (const d of handle.iterator) {
        seen.push(d)
        if (seen.length === 2) handle.cancel()
      }
      const res = await handle.result
      assertEq(seen.length <= 3, true, `cancel 后不应继续产出（实际 ${seen.length} 个增量）`)
      assertEq(res.aborted, true, 'result.aborted 应为 true')
      assertEq(res.aborted && res.chunks <= 3, true, '统计应与实际产出一致')
      await sleep(120)
      assertEq(seen.length <= 3, true, 'cancel 之后仍不应有新增量')
      assertEq(fake.state.clientClosedEarly >= 1, true, '服务端应观测到客户端断连（上游 socket 真断）')
      assertEq(fake.state.chunkFramesSent < 80, true, '服务端不应把 80 帧发完（上游被打断）')
      return `产出 ${seen.length} 个增量后中止；服务端观测断连 ${fake.state.clientClosedEarly} 次，已发 ${fake.state.chunkFramesSent}/80 帧`
    } finally {
      fake.state.chunkCount = 6
      fake.state.chunkDelayMs = 2
    }
  })

  // ── G8 响应被截断 ──
  await r.check('G8', '响应被截断（无 [DONE]）→ OPENCLAW_NOT_READY(stream-truncated)，不静默当成功', async () => {
    fake.state.mode = 'truncate'
    const client = makeClient(baseUrl)
    const res = await outcome(
      client.createChatStream({
        projectId: 'p1',
        conversationKey: 'k',
        messages: [{ role: 'user', content: 'x' }]
      }).result
    )
    assertEq(res.ok, false, '截断应失败')
    assertEq(res.code, 'OPENCLAW_NOT_READY', '截断应是 OPENCLAW_NOT_READY')
    assertEq(res.details.reason, GATEWAY_TIMEOUT_REASONS.streamTruncated, '原因应为 stream-truncated')
    fake.state.mode = 'ok'
    return `${res.code}/${res.details.reason}`
  })

  // ── G9 流内 error 帧 ──
  await r.check('G9', '流内 error 帧 → OPENCLAW_NOT_READY(upstream-error)，不当成正常收尾', async () => {
    fake.state.mode = 'streamError'
    const client = makeClient(baseUrl)
    const res = await outcome(
      client.createChatStream({
        projectId: 'p1',
        conversationKey: 'k',
        messages: [{ role: 'user', content: 'x' }]
      }).result
    )
    assertEq(res.ok, false, '流内 error 应失败')
    assertEq(res.code, 'OPENCLAW_NOT_READY', '流内 error 应是 OPENCLAW_NOT_READY')
    assertEq(res.details.reason, GATEWAY_TIMEOUT_REASONS.upstream, '原因应为 upstream-error')
    fake.state.mode = 'ok'
    return `${res.code}/${res.details.reason}`
  })

  // ── G10 会话隔离 ──
  await r.check('G10', '会话隔离：user=conv:<projectId>:<conversation_key>（key 从库取）+ 注入防护', async () => {
    const database = new DatabaseClient({
      dbPath,
      backupDir,
      workerScriptPath,
      nodePath,
      subprocessName: 'marketing-db-worker-gateway-test',
      requestTimeoutMs: 30_000
    })
    clients.add(database)
    const projects = projMod.createProjectManager({ database, dataDir, logger })
    const project = await projects.createProject({ name: 'C07 会话隔离商家', industry: '摄影' })

    const client = makeClient(baseUrl, {
      conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key
    })
    const res = await client.chat({
      projectId: project.id,
      messages: [{ role: 'user', content: 'hi' }]
    })
    assertEq(res.aborted, false, '非流式调用应正常返回')
    const body = fake.state.chatBodies[fake.state.chatBodies.length - 1].body
    const expected = `${CONVERSATION_USER_PREFIX}${project.id}:${project.conversation_key}`
    assertEq(body.user, expected, 'user 必须是 conv:<projectId>:<conversation_key>')
    assertEq(body.user.includes(project.conversation_key), true, 'conversation_key 应来自 projects 表')

    // 注入防护：任一字段带 ':' 都能伪造别人的会话边界
    const inject = await outcome(Promise.resolve().then(() => buildConversationUser('a:b', 'k')))
    assertEq(inject.code, 'VALIDATION_ERROR', "projectId 带 ':' 应被拒")
    const inject2 = await outcome(Promise.resolve().then(() => buildConversationUser('a', 'b:c')))
    assertEq(inject2.code, 'VALIDATION_ERROR', "conversation_key 带 ':' 应被拒")
    // 渲染端拿不到 token
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    assert(!/GATEWAY_TOKEN/.test(stripComments(preloadSrc)), 'preload 不得引用 GATEWAY_TOKEN（硬规则 13）')
    assert(!/Bearer\s/.test(stripComments(preloadSrc)), 'preload 不得出现 Bearer（调用只留主进程）')
    ctx.projectId = project.id
    return `user=${expected.slice(0, 24)}…（key 来自库）；':' 注入被拒；preload 无 token`
  })

  // ── G11 模型选择 ──
  await r.check('G11', '多模态模型选择：纯文本用 text；含图用 multimodal；未配置/非法一律明确报错', async () => {
    assertEq(selectGatewayModel({ text: 'openclaw' }, false), 'openclaw', '纯文本应选 text')
    assertEq(
      selectGatewayModel({ text: 'openclaw', multimodal: 'openclaw/vision' }, true),
      'openclaw/vision',
      '含图应选 multimodal'
    )
    const missing = await outcome(Promise.resolve().then(() => selectGatewayModel({ text: 'openclaw' }, true)))
    assertEq(missing.code, 'VALIDATION_ERROR', '含图但未配置多模态应报错')
    assertEq(missing.details.reason, 'multimodal-model-not-configured', '应给出可分支的原因')
    for (const bad of ['gpt-4o', 'anthropic/claude', 'openclaw/a/b', '']) {
      const res = await outcome(Promise.resolve().then(() => normalizeGatewayModel(bad)))
      assertEq(res.code, 'VALIDATION_ERROR', `非法 model ${bad} 应被拒`)
    }
    assertEq(isValidGatewayModel('openclaw/main'), true, 'openclaw/<agentId> 合法')
    assertEq(isValidGatewayModel('gpt-4'), false, 'provider 模型 id 不合法（§六：model 是路由键）')
    assertEq(
      detectMultimodalCapability({ input: ['text', 'image'] }),
      true,
      'input 含 image 才算多模态'
    )
    assertEq(detectMultimodalCapability({ input: ['text'] }), false, '纯文本模型不算多模态')
    assertEq(detectMultimodalCapability(null), false, '未配置应为 false（宁可报错也不假装能看图）')
    return `text/multimodal 选择正确；${4} 个非法 model 被拒；能力位判定正确`
  })

  // ── G12 图片请求体 ──
  await r.check('G12', '含图请求：走多模态 model，图片必须是 data URI（外链只告警不静默）', async () => {
    const good = imageDataPart('data:image/png;base64,iVBORw0KGgo=')
    assertEq(good.type, 'image_url', '图片部件类型应为 image_url')
    const badPart = await outcome(Promise.resolve().then(() => imageDataPart('http://x/y.png')))
    assertEq(badPart.code, 'VALIDATION_ERROR', '非 data URI 应被拒')
    assertEq(imageUrlPart('https://x/y.png').type, 'image_url', '外链形态校验通过')
    assertEq(messageHasImages({ role: 'user', content: [textPart('看图'), good] }), true, '应识别含图消息')

    const client = makeClient(baseUrl, { models: { text: 'openclaw', multimodal: 'openclaw/main' } })
    await client.chat({
      projectId: ctx.projectId ?? 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: [textPart('这是什么'), good] }]
    })
    const body = fake.state.chatBodies[fake.state.chatBodies.length - 1].body
    assertEq(body.model, 'openclaw/main', '含图应选多模态模型')
    assertEq(Array.isArray(body.messages[0].content), true, '部件数组应原样发出')
    assertEq(body.messages[0].content[1].type, 'image_url', '图片部件应保留')
    return `含图 → model=${body.model}；部件数组保真；非 data URI 被拒`
  })

  // ── G13 自动拉起（单飞 + 只调一次） ──
  await r.check('G13', '自动拉起：starter 只调一次（并发单飞）；拉起后轮询到就绪；已就绪则不拉', async () => {
    // 先指向死端口（探活必失败），starter 里「把服务端听起来」再返回
    const lazy = createFakeGateway()
    servers.push(lazy)
    await lazy.listen() // 先拿到端口号但还没 listen？——这里直接先 listen，稍后靠 mode 控制
    let starterCalls = 0
    const clock = fakeClock(300)
    const client = makeClientNoTrack(`http://127.0.0.1:${lazy.state.port}`, {
      starter: async () => {
        starterCalls += 1
        lazy.state.mode = 'ok'
        return { started: true }
      },
      sleepImpl: async () => {},
      now: clock.now,
      timers: { readyTimeoutMs: 60_000, readyPollIntervalMs: 1 }
    })

    lazy.state.mode = 'modelsDisabled' // 先在「不就绪」状态
    const [a, b] = await Promise.all([client.ensureReady(), client.ensureReady()])
    assertEq(starterCalls, 1, '并发 ensureReady 应共享同一次拉起（starter 只调一次）')
    assertEq(a.ready, true, '拉起后应轮询到就绪')
    assertEq(b.ready, true, '并发调用应拿到同一结果')
    const again = await client.ensureReady()
    assertEq(again.ready, true, '再次调用应命中就绪缓存')
    assertEq(starterCalls, 1, '就绪后不应重复拉起')

    const freshClient = makeClientNoTrack(`http://127.0.0.1:${lazy.state.port}`, {
      starter: async () => {
        starterCalls += 1
        return { started: true }
      }
    })
    const readyNow = await freshClient.ensureReady()
    assertEq(readyNow.ready, true, '已就绪时 ensureReady 直接返回')
    assertEq(starterCalls, 1, '已就绪时不得调 starter')
    await lazy.close()
    return `starter 调用 ${starterCalls} 次（并发单飞 + 就绪缓存 + 已就绪不拉）`
  })

  // ── G14/G15 拉起失败与轮询超时 ──
  await r.check('G14', '拉起失败 → OPENCLAW_NOT_READY(start-failed)；轮询用尽 → OPENCLAW_TIMEOUT', async () => {
    const dead = createFakeGateway()
    await dead.listen()
    await dead.close() // 端口立刻空出来：探活必失败
    const failing = makeClientNoTrack(`http://127.0.0.1:${dead.state.port}`, {
      starter: async () => {
        throw new Error('clawManager.start() 失败：端口被占')
      }
    })
    const res = await outcome(failing.ensureReady())
    assertEq(res.ok, false, 'starter 抛错应上抛')
    assertEq(res.code, 'OPENCLAW_NOT_READY', '应是 OPENCLAW_NOT_READY')
    assertEq(res.details.reason, GATEWAY_TIMEOUT_REASONS.startFailed, '原因应为 start-failed')

    const never = createFakeGateway()
    servers.push(never)
    await never.listen()
    never.state.mode = 'modelsDisabled' // 永远不就绪
    const clock = fakeClock(1_000)
    const timeoutClient = makeClientNoTrack(`http://127.0.0.1:${never.state.port}`, {
      starter: () => ({ started: true }),
      sleepImpl: async () => {},
      now: clock.now,
      timers: { readyTimeoutMs: 5_000, readyPollIntervalMs: 500 }
    })
    const to = await outcome(timeoutClient.ensureReady())
    assertEq(to.code, 'OPENCLAW_TIMEOUT', '轮询预算用尽应是 OPENCLAW_TIMEOUT')
    assertEq(to.details.reason, GATEWAY_TIMEOUT_REASONS.request, '原因应为 timeout')
    await never.close()
    return `starter 失败→${res.details.reason}；轮询用尽→${to.code}`
  })

  // G15 编号刻意未用：曾把「截断」与「流内 error」写在同一个用例里，拆分后留下了空号（仅编号观感）
  // ── G16 SSE→IPC 透传助手 ──
  await r.check('G16', '透传助手：chunk*N → done 事件序；cancel 后静默；错误走 error 事件；销毁自动中止', async () => {
    const events = []
    const sink = { send: (channel, payload) => events.push({ channel, payload }) }
    fake.state.mode = 'ok'
    fake.state.chunkCount = 4
    const client = makeClient(baseUrl)
    const handle = client.createChatStream({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'x' }]
    })
    const forward = forwardGatewayStream(sink, 'stream-1', handle)
    await forward.done
    const names = events.map((e) => e.channel)
    assertEq(names.filter((n) => n === GATEWAY_STREAM_EVENTS.chunk).length, 4, '应有 4 个 chunk 事件')
    assertEq(names[names.length - 1], GATEWAY_STREAM_EVENTS.done, '最后一个事件应是 done')
    assertEq(events[0].payload.streamId, 'stream-1', '事件应带 streamId')
    assertEq(events[0].payload.index, 1, 'chunk 事件应带序号')
    assertEq(events[events.length - 1].payload.chunks, 4, 'done 事件应带统计')

    // cancel：之后一个事件都不再发
    fake.state.chunkCount = 60
    fake.state.chunkDelayMs = 15
    const events2 = []
    const sink2 = { send: (channel, payload) => events2.push({ channel, payload }) }
    const h2 = client.createChatStream({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'long' }]
    })
    const f2 = forwardGatewayStream(sink2, 'stream-2', h2)
    const wait = setInterval(() => {}, 5)
    await sleep(60)
    const atCancel = events2.length
    f2.cancel()
    await sleep(120)
    clearInterval(wait)
    assertEq(events2.length, atCancel, 'cancel 之后不应再推送任何事件')
    assertEq(
      events2.some((e) => e.channel === GATEWAY_STREAM_EVENTS.done),
      false,
      'cancel 是渲染端发起的，不该回 done'
    )

    // 错误路径 → error 事件
    fake.state.mode = 'truncate'
    const events3 = []
    const h3 = client.createChatStream({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'x' }]
    })
    await forwardGatewayStream({ send: (c, p) => events3.push({ channel: c, payload: p }) }, 'stream-3', h3).done
    const errEvent = events3.find((e) => e.channel === GATEWAY_STREAM_EVENTS.error)
    assert(errEvent, '截断应推 error 事件')
    assertEq(errEvent.payload.error.code, 'OPENCLAW_NOT_READY', 'error 事件应带统一信封')

    // 渲染进程销毁 → 自动中止上游
    fake.state.mode = 'ok'
    fake.state.chunkCount = 60
    fake.state.clientClosedEarly = 0
    const destroyed = { send: () => {}, isDestroyed: () => true }
    const h4 = client.createChatStream({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'x' }]
    })
    await forwardGatewayStream(destroyed, 'stream-4', h4).done
    await sleep(100)
    assertEq(fake.state.clientClosedEarly >= 1, true, 'webContents 已销毁时应中止上游（不白烧 token）')
    fake.state.chunkCount = 6
    fake.state.chunkDelayMs = 2
    return `chunk×4→done；cancel 后 ${atCancel} 个事件不再增长；error 事件带信封；销毁即中止上游`
  })

  // ── G22 模型选择按次解析（复审「中」#1） ──
  await r.check('G22', '模型选择**按次解析**：配置从「无多模态」变「有多模态」后同一个 client 立刻生效', async () => {
    let multimodal = null
    const client = makeClient(baseUrl, { modelsResolver: () => ({ text: 'openclaw', multimodal }) })
    const imageMessages = [{ role: 'user', content: [textPart('这是什么'), imageDataPart('data:image/png;base64,AAA=')] }]
    const before = await outcome(client.chat({ projectId: 'p1', conversationKey: 'k', messages: imageMessages }))
    assertEq(before.code, 'VALIDATION_ERROR', 'resolver 报无多模态时应拒含图请求')
    assertEq(before.details.reason, 'multimodal-model-not-configured', '原因应可分支')
    multimodal = 'openclaw/main' // 等价于用户刚在 Setup 里选了支持图片的模型（主进程没重启）
    const after = await outcome(client.chat({ projectId: 'p1', conversationKey: 'k', messages: imageMessages }))
    assertEq(after.ok, true, '同一个 client 应立刻能用多模态（证明不是启动快照）')
    const body = fake.state.chatBodies[fake.state.chatBodies.length - 1].body
    assertEq(body.model, 'openclaw/main', '应按最新配置选多模态模型')
    // 构造快照路径（models）仍可用，向后兼容
    const snapClient = makeClientNoTrack(baseUrl, { models: { text: 'openclaw', multimodal: 'openclaw/main' } })
    const snap = await snapClient.chat({ projectId: 'p1', conversationKey: 'k', messages: imageMessages })
    assertEq(snap.text, '非流式回复', '快照路径（models）仍应可用，且非流式回复应被正确解析')
    return `无多模态→拒；更新配置后同一 client → model=${body.model}；快照路径仍可用`
  })

  // ── G23 响应头前中止（复审「中」#2） ──
  await r.check('G23', '响应头**之前**中止也按契约 resolve aborted:true（不再 reject 成超时）', async () => {
    fake.state.mode = 'slowHeaders'
    const client = makeClient(baseUrl, { timers: { streamIdleTimeoutMs: 30_000 } })
    const handle = client.createChatStream({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'x' }]
    })
    handle.cancel() // 响应头还没到就中止
    const res = await outcome(handle.result)
    assertEq(res.ok, true, '按契约应当 resolve（不是 reject）')
    assertEq(res.value.aborted, true, 'aborted 应为 true')
    assertEq(res.value.text, '', '没有收到任何增量时 text 应为空')
    const drained = []
    for await (const d of handle.iterator) drained.push(d)
    assertEq(drained.length, 0, '中止后迭代器应直接结束')
    fake.state.mode = 'ok'
    return `aborted=${res.value.aborted}，text 空，迭代器干净收尾`
  })

  // ── G24 就绪缓存作废（复审「低」#1） ──
  await r.check('G24', '调用失败后作废就绪缓存：ensureReady 重新探活/拉起（不再回陈旧快照）', async () => {
    const srv = createFakeGateway()
    servers.push(srv)
    const url = await srv.listen()
    let starterCalls = 0
    const clock = fakeClock(1_000)
    const client = makeClientNoTrack(url, {
      starter: () => {
        starterCalls += 1
        return { started: true }
      },
      sleepImpl: async () => {},
      now: clock.now,
      timers: { readyTimeoutMs: 2_000, readyPollIntervalMs: 100 }
    })
    const ready = await client.ensureReady()
    assertEq(ready.ready, true, '前置：先就绪')
    assertEq(starterCalls, 0, '就绪时不该拉起')
    await srv.close() // 网关中途挂了
    const failed = await outcome(client.chat({ projectId: 'p1', conversationKey: 'k', messages: [{ role: 'user', content: 'x' }] }))
    assertEq(failed.ok, false, '网关已挂，调用应失败')
    const after = await outcome(client.ensureReady())
    assertEq(
      starterCalls,
      1,
      '缓存作废后 ensureReady 必须重新探活→拉起（若仍回陈旧快照，这里会是 0）'
    )
    assertEq(after.code, 'OPENCLAW_TIMEOUT', '拉起后没人监听 → 轮询预算用尽')
    return `失败前 starter=0；失败后重新拉起 starter=${starterCalls}（缓存确已作废）`
  })

  // ── G25 destroyed 事件接线（复审「低」#2） ──
  await r.check('G25', '透传助手真接线 destroyed 事件：窗口销毁即中止上游（冷启动静默期也生效）', async () => {
    fake.state.mode = 'ok'
    fake.state.chunkCount = 60
    fake.state.chunkDelayMs = 25
    fake.state.clientClosedEarly = 0
    try {
      const listeners = {}
      const events = []
      const sink = {
        send: (channel, payload) => events.push({ channel, payload }),
        isDestroyed: () => false, // 关键：只发 destroyed 事件，不靠轮询 isDestroyed
        once: (event, cb) => {
          listeners[event] = cb
        }
      }
      const client = makeClient(baseUrl)
      const handle = client.createChatStream({
        projectId: 'p1',
        conversationKey: 'k',
        messages: [{ role: 'user', content: 'x' }]
      })
      const forward = forwardGatewayStream(sink, 'stream-destroy', handle)
      assertEq(typeof listeners.destroyed, 'function', '助手应注册 destroyed 监听（不再只靠每个 chunk 查一次）')
      await sleep(60)
      listeners.destroyed() // 模拟渲染进程销毁
      await sleep(250)
      const atDestroy = events.length
      assertEq(fake.state.clientClosedEarly >= 1, true, '窗口销毁应中止上游（冷启动静默期不再白烧 token）')
      await sleep(120)
      assertEq(events.length, atDestroy, '销毁后不应再推事件')
      await forward.done
      return `destroyed → 服务端观测断连，共推 ${atDestroy} 个事件后静默`
    } finally {
      fake.state.chunkCount = 6
      fake.state.chunkDelayMs = 2
    }
  })

  // ── G26 temperature 不静默丢弃（复审小瑕疵） ──
  await r.check('G26', 'temperature 超范围/非法 → VALIDATION_ERROR（不静默丢）；合法值进请求体', async () => {
    const client = makeClient(baseUrl)
    for (const bad of [-0.1, 2.5, 'hot', Number.NaN]) {
      const res = await outcome(
        client.chat({
          projectId: 'p1',
          conversationKey: 'k',
          messages: [{ role: 'user', content: 'x' }],
          temperature: bad
        })
      )
      assertEq(res.code, 'VALIDATION_ERROR', `temperature=${String(bad)} 应被拒（不静默丢弃）`)
    }
    await client.chat({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.7
    })
    const body = fake.state.chatBodies[fake.state.chatBodies.length - 1].body
    assertEq(body.temperature, 0.7, '合法 temperature 应进请求体')
    return `4 个非法值全拒；0.7 进 body`
  })

  // ── G27 /v1/models 结构异常不装绿灯（复审小瑕疵） ──
  await r.check('G27', '/v1/models 返回 200 但结构不对 → 不算「已开启」（就绪判定不装绿灯）', async () => {
    fake.state.mode = 'modelsGarbage'
    const client = makeClient(baseUrl)
    const res = await client.listModels()
    assertEq(res.enabled, false, '200 但非 JSON/缺 data 不能算已开启')
    assertEq(res.error.code, 'OPENCLAW_NOT_READY', '应给 OPENCLAW_NOT_READY')
    assertEq(res.error.details.reason, 'unexpected-response', '应带可分支的 reason')
    const status = await client.getStatus()
    assertEq(status.ready, false, '就绪快照不能把结构异常当绿灯')
    fake.state.mode = 'ok'
    return `enabled=false / ready=false / reason=unexpected-response`
  })

 // ── G17 端点开关默认化 ──
  // ── G29 端口退让跟随（实测 3213 被占、实例退让 3214） ──
  await r.check('G29', '配置端口被占（health 活但兼容面 404）→ 跟随 actualPortResolver 的实际端口；解析失败安全', async () => {
    const oldSrv = createFakeGateway()
    const actualSrv = createFakeGateway()
    servers.push(oldSrv, actualSrv)
    const configuredUrl = await oldSrv.listen()
    const actualUrl = await actualSrv.listen()
    oldSrv.state.mode = 'modelsDisabled'
    actualSrv.state.mode = 'ok'
    let resolverCalls = 0
    let starterCalls = 0
    const client = makeClient(configuredUrl, {
      actualPortResolver: () => {
        resolverCalls += 1
        return actualSrv.state.port
      },
      starter: () => {
        starterCalls += 1
        return { started: false, reason: 'already-running' }
      }
    })
    const snap = await client.getStatus()
    assertEq(resolverCalls, 1, '配置端口不就绪时应解析一次实际端口')
    assertEq(snap.ready, true, '跟随实际端口后应就绪')
    assertEq(snap.port, actualSrv.state.port, '快照端口应为锁文件实际端口')
    assertEq(snap.baseUrl, actualUrl, '快照 baseUrl 应指向实际端口')
    assertEq(starterCalls, 0, '只读 getStatus 绝不调 starter')
    const ready = await client.ensureReady()
    assertEq(ready.ready, true, 'ensureReady 应直接拿到跟随结果')
    assertEq(starterCalls, 0, '跟随便就绪时不应拉起')
    const reply = await client.chat({
      projectId: 'p1',
      conversationKey: 'k',
      messages: [{ role: 'user', content: 'hi' }]
    })
    assertEq(reply.text, '非流式回复', 'chat 应打到实际端口')
    assertEq(actualSrv.state.chatRequests, 1, '实际端口应收到 1 次 chat')
    assertEq(oldSrv.state.chatRequests, 0, '旧实例不应收到 chat')
    // resolver 抛错：忽略并回配置端口事实，不阻断
    const client2 = makeClient(configuredUrl, {
      actualPortResolver: () => {
        throw new Error('lock unreadable')
      }
    })
    const snap2 = await client2.getStatus()
    assertEq(snap2.ready, false, '解析器抛错时应回配置端口事实（不就绪）')
    assertEq(snap2.port, oldSrv.state.port, '端口不应被切换')
    // resolver 给同端口：不切换
    const client3 = makeClient(configuredUrl, { actualPortResolver: () => oldSrv.state.port })
    const snap3 = await client3.getStatus()
    assertEq(snap3.ready, false, '同端口不切换，仍不就绪')
    return `跟随 ${oldSrv.state.port}→${actualSrv.state.port}：ready + chat 命中实际端口；解析器抛错/同端口均安全`
  })

  await r.check('G17', '端点开关默认化：应用生成的配置里 chatCompletions.enabled = true', async () => {
    const dir = join(runDir, 'cfg-new')
    mkdirSync(dir, { recursive: true })
    const prev = process.env.CLAW_DATA_DIR
    process.env.CLAW_DATA_DIR = dir
    try {
      const manager = new ConfigManager()
      const p = join(dir, 'config', '.openclaw', 'openclaw.json')
      assert(existsSync(p), '应生成 openclaw.json')
      const json = JSON.parse(readFileSync(p, 'utf-8'))
      assertEq(
        json?.gateway?.http?.endpoints?.chatCompletions?.enabled,
        true,
        '新装配置必须默认开启 OpenAI 兼容面（§六 实测默认 false）'
      )
      assertEq(json.gateway.auth.mode, 'token', '鉴权仍为 token 模式')
      manager.syncOpenClawConfig()
      const again = JSON.parse(readFileSync(p, 'utf-8'))
      assertEq(
        again?.gateway?.http?.endpoints?.chatCompletions?.enabled,
        true,
        '重复同步应保持开启（幂等）'
      )
    } finally {
      if (prev === undefined) delete process.env.CLAW_DATA_DIR
      else process.env.CLAW_DATA_DIR = prev
    }
    return `新装 → enabled=true；二次同步仍 true`
  })

  // ── G18 老用户迁移 ──
  await r.check('G18', '老用户迁移：补上开关、其余字段一字不改、幂等（不毁老配置）', async () => {
    const dir = join(runDir, 'cfg-legacy')
    mkdirSync(dir, { recursive: true })
    const p = writeLegacyOpenClawConfig(dir)
    const prev = process.env.CLAW_DATA_DIR
    process.env.CLAW_DATA_DIR = dir
    try {
      const manager = new ConfigManager() // 构造即同步一次
      const migrated = JSON.parse(readFileSync(p, 'utf-8'))
      assertEq(
        migrated.gateway.http.endpoints.chatCompletions.enabled,
        true,
        '老用户应被补上开关'
      )
      assertEq(migrated.gateway.customFlag, 'keep-me', 'gateway 段自定义字段必须保留')
      assertEq(
        migrated.gateway.http.endpoints.chatCompletions.customSubKey,
        'keep-sub',
        'chatCompletions 下的自定义子键必须保留（不能被整段覆盖）'
      )
      assertEq(migrated.channels.customChannelKeep?.appId, 'keep-channel', 'channels 段自定义内容必须保留')
      assertEq(migrated.customTopLevel, 'keep-top', '顶层自定义字段必须保留')
      assertEq(migrated.agents.defaults.custom, 'keep-agent', 'agents.defaults 自定义字段必须保留')
      // 鉴权 token 由应用自己接管（既有行为：gateway.auth.token = 本应用常量），
      // 这里只断言「模式仍是 token 且值非空」——不谎称它会被保留
      assertEq(migrated.gateway.auth.mode, 'token', '鉴权模式仍为 token')
      assert(
        typeof migrated.gateway.auth.token === 'string' && migrated.gateway.auth.token.length > 0,
        '鉴权 token 应非空（由应用接管，既有行为）'
      )

      manager.syncOpenClawConfig()
      const twice = readFileSync(p, 'utf-8')
      manager.syncOpenClawConfig()
      const thrice = readFileSync(p, 'utf-8')
      assertEq(twice, thrice, '重复同步必须幂等（第二次与第三次字节一致）')
    } finally {
      if (prev === undefined) delete process.env.CLAW_DATA_DIR
      else process.env.CLAW_DATA_DIR = prev
    }
    return `开关补齐 + 4 处自定义字段保留 + 二次同步字节一致`
  })

  // ── G19 待办 #15 ──
  await r.check('G19', '#15：meta 不再写非法字段（删 lastTouchedAt；lastTouchedVersion 写真实版本或省略）', async () => {
    const dir = join(runDir, 'cfg-meta')
    mkdirSync(dir, { recursive: true })
    const p = writeLegacyOpenClawConfig(dir)
    // 让「真实安装版本」可读：<dataDir>/openclaw/node_modules/openclaw/package.json
    const pkgDir = join(dir, 'openclaw', 'node_modules', 'openclaw')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.4' }), 'utf-8')
    const prev = process.env.CLAW_DATA_DIR
    process.env.CLAW_DATA_DIR = dir
    try {
      const manager = new ConfigManager()
      const json = JSON.parse(readFileSync(p, 'utf-8'))
      assertEq('lastTouchedAt' in (json.meta || {}), false, 'lastTouchedAt 不是 schema 字段，必须删掉')
      assertEq(json.meta.lastTouchedVersion, '2026.9.4', '应写真实安装版本，而不是字面量 latest')
      assertEq(json.meta.customMeta, 'keep-meta', 'meta 里其它字段必须保留')

      // 读不到安装版本时：宁可不写该字段，也不写非法值
      rmSync(join(pkgDir, 'package.json'))
      manager.syncOpenClawConfig()
      const without = JSON.parse(readFileSync(p, 'utf-8'))
      assertEq('lastTouchedVersion' in (without.meta || {}), false, '读不到版本时应省略该字段')
      assertEq('lastTouchedAt' in (without.meta || {}), false, '仍然不得写 lastTouchedAt')
    } finally {
      if (prev === undefined) delete process.env.CLAW_DATA_DIR
      else process.env.CLAW_DATA_DIR = prev
    }
    return `lastTouchedAt 已删；lastTouchedVersion=2026.9.4 → 读不到时省略；其它 meta 字段保留`
  })

  // ── G28 #15 的第二处：安装期保底配置（真跑 downloadManager._ensureOpenClawConfig） ──
  await r.check('G28', '#15 第二处：安装期保底配置不再写非法 meta（真跑 downloadManager）', async () => {
    const dir = join(runDir, 'cfg-fallback')
    mkdirSync(dir, { recursive: true })
    const prev = process.env.CLAW_DATA_DIR
    process.env.CLAW_DATA_DIR = dir
    try {
      const configManager = new ConfigManager() // 构造时会写一次合法配置
      const downloadManager = new DownloadManager(configManager)
      const filePath = join(dir, 'config', '.openclaw', 'openclaw.json')
      rmSync(filePath, { force: true }) // 回到「配置缺失」的安装期场景
      downloadManager._ensureOpenClawConfig() // TS private，运行时可达
      assert(existsSync(filePath), '保底配置应被生成')
      const json = JSON.parse(readFileSync(filePath, 'utf-8'))
      assertEq(json?.meta?.lastTouchedAt, undefined, '不得写 lastTouchedAt（schema 非法字段）')
      assertEq(json?.meta?.lastTouchedVersion, undefined, "不得写字面量 'latest'")
      assertEq(json?.gateway?.auth?.mode, 'token', '保底骨架的鉴权模式应在')
      assert(json?.channels?.['openclaw-weixin'], '保底骨架的渠道段应在')
      // 已有配置时不得覆盖
      json.__sentinel = 'keep'
      writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8')
      downloadManager._ensureOpenClawConfig()
      const again = JSON.parse(readFileSync(filePath, 'utf-8'))
      assertEq(again.__sentinel, 'keep', '已存在配置时不得覆盖')
      return '保底配置无非法 meta；已存在配置不被覆盖'
    } finally {
      if (prev === undefined) delete process.env.CLAW_DATA_DIR
      else process.env.CLAW_DATA_DIR = prev
    }
  })

  // ── G20 wiring 与硬规则 13 静态核对 ──
  await r.check('G20', 'wiring：两条只读通道 + preload 面 + 主进程复用 clawManager + token 不出主进程', async () => {
    const ipcSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'gateway.ts'), 'utf-8')
    const ipcIndexSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'index.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf-8')
    const mainSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
    const gatewaySrc = readFileSync(join(repoRoot, 'electron', 'main', 'gatewayClient.ts'), 'utf-8')
    assert(ipcSrc.includes("'marketing:gateway:status'"), '应注册 marketing:gateway:status')
    assert(ipcSrc.includes("'marketing:gateway:ensureReady'"), '应注册 marketing:gateway:ensureReady')
    // 07 只提供透传助手，不注册业务流通道（业务通道归 08/09）
    assert(
      !/ipcMain\.handle\(\s*'marketing:gateway:(chunk|done|error|chat|stream)/.test(ipcSrc),
      '07 不应注册业务流通道（只提供 forwardGatewayStream 助手）'
    )
    assert(ipcIndexSrc.includes('registerGatewayIpc'), 'ipc/index.ts 应转出 registerGatewayIpc')
    assert(preloadSrc.includes("'marketing:gateway:status'"), 'preload 应暴露 status')
    assert(preloadSrc.includes("'marketing:gateway:ensureReady'"), 'preload 应暴露 ensureReady')
    assert(/gateway:\s*\{/.test(preloadSrc), 'preload 应有 marketing.gateway 面')
    // 主进程：starter 复用 clawManager（不另起炉灶）+ token 取自 openClawPaths
    assert(/createMarketingGatewayClient/.test(mainSrc), 'main/index.ts 应构造 Gateway Client')
    assert(/clawManager\.start\(\)/.test(mainSrc), 'starter 必须复用 clawManager.start（§七 原文）')
    assert(/token:\s*GATEWAY_TOKEN/.test(mainSrc), 'token 应由主进程注入')
    assert(!/token:\s*window\./.test(gatewaySrc), '客户端不得从渲染端拿 token')
    return '2 条只读通道 + preload 面 + clawManager 复用 + token 只在主进程'
  })

  // ── G21 真 Gateway 只读探活 ──
  await r.check('G21', '真 Gateway 只读探活（零 token：只 GET /health）', async () => {
    const targets = [3213, 3214]
    for (const port of targets) {
      const client = makeClientNoTrack(`http://127.0.0.1:${port}`, {
        timers: { healthTimeoutMs: 1_500, modelsTimeoutMs: 1_500 }
      })
      const probe = await client.probe()
      if (probe.ok) {
        const models = await client.listModels()
        return `端口 ${port} 探活 200（${probe.ms}ms），兼容面 enabled=${models.enabled}（只读，未调 chat）`
      }
    }
    return 'DEGRADED：本机 3213 / 3214 都没有在跑的 Gateway，真机探活未验（语义与错误映射已由 G2/G3 用真 HTTP 服务端覆盖）'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const server of servers) {
    try {
      await server.close()
    } catch {
      /* 忽略 */
    }
  }
  for (const c of [...clients]) {
    try {
      if (typeof c.dispose === 'function') await c.dispose()
      else if (typeof c.cancel === 'function' && c.iterator) c.cancel()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
}

const result = r.toJSON({ bundle: gatewayPath, dataDir, nodePath, logSample: logs.slice(0, 20) })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-gateway.json'), result)
console.log('结果已写入 test/accept-result-gateway.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
