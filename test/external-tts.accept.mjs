// test/external-tts.accept.mjs —— 本地 OpenAI Audio Speech 接入与云端回落
//
// 纯 Node 验收，不连真实 TTS：
//   - 本地实例 JSON 与独立加密 Key
//   - URL 归一化 / 请求体 / Bearer / 音频响应 / 错误码
//   - external 路由、缓存、失败冷却、auto 回落火山云

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  waitFor,
  writeJson
} from './_lib.mjs'

const runDir = join(tmpDir, `external-tts-${Date.now()}`)
mkdirSync(runDir, { recursive: true })

const managerBundle = bundleEntry(
  'electron/main/fish/voice/core/manager.ts',
  'external-voice-manager.mjs'
)
const errorsBundle = bundleEntry(
  'electron/main/fish/voice/core/errors.ts',
  'external-voice-errors.mjs'
)
const settingsBundle = bundleEntry(
  'electron/main/fish/voice/core/settings.ts',
  'external-voice-settings.mjs'
)
const storeBundle = bundleEntry(
  'electron/main/fish/voice/external/externalServiceStore.ts',
  'external-service-store.mjs'
)
const secretBundle = bundleEntry(
  'electron/main/fish/voice/external/localSecretStore.ts',
  'external-secret-store.mjs'
)
const speechBundle = bundleEntry(
  'electron/main/fish/voice/external/openaiSpeech.ts',
  'external-openai-speech.mjs'
)

const managerMod = await import(pathToFileURL(managerBundle).href)
const errorsMod = await import(pathToFileURL(errorsBundle).href)
const settingsMod = await import(pathToFileURL(settingsBundle).href)
const storeMod = await import(pathToFileURL(storeBundle).href)
const secretMod = await import(pathToFileURL(secretBundle).href)
const speechMod = await import(pathToFileURL(speechBundle).href)

const { createVoiceManager } = managerMod
const { VOICE_ERROR_CODES } = errorsMod
const { DEFAULT_VOICE_SETTINGS, normalizeVoiceSettings } = settingsMod
const { createExternalServiceStore } = storeMod
const { createExternalVoiceSecretStore } = secretMod
const {
  normalizeExternalBaseUrl,
  normalizeProfilesPath,
  resolveProfilesUrl,
  createOpenAISpeechProvider
} = speechMod

function memoryStore() {
  const data = new Map()
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      if (value === null) data.delete(key)
      else data.set(key, value)
    }
  }
}

function cloudSecrets() {
  const state = { tts: 'tts-key-12345678', clone: 'clone-key-12345678' }
  return {
    state,
    async get(kind) {
      return state[kind] ?? null
    },
    async set(kind, value) {
      state[kind] = value
      return { hasKey: true, tail: '****' + value.slice(-4) }
    },
    async clear(kind) {
      state[kind] = null
      return { hasKey: false, tail: null }
    },
    async status() {
      return {
        encryptionAvailable: true,
        tts: { hasKey: !!state.tts, tail: state.tts ? '****' + state.tts.slice(-4) : null },
        clone: {
          hasKey: !!state.clone,
          tail: state.clone ? '****' + state.clone.slice(-4) : null
        }
      }
    }
  }
}

function fakeEncryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
    decryptString: (buffer) => {
      const text = Buffer.from(buffer).toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return Buffer.from(text.slice(4), 'base64').toString('utf8')
    }
  }
}

function ttsResponse() {
  const payload =
    JSON.stringify({
      code: 0,
      message: '',
      data: Buffer.from([1, 2, 3, 4]).toString('base64')
    }) +
    '\n' +
    JSON.stringify({ code: 20000000, message: 'OK', usage: { text_words: 4 } }) +
    '\n'
  const bytes = new TextEncoder().encode(payload)
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    }),
    { status: 200, headers: { 'x-tt-logid': 'external-cloud-log' } }
  )
}

function externalAudio(bytes = [0xff, 0xfb, 0x90, 0x64]) {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' }
  })
}

function externalWav() {
  const wav = Buffer.alloc(64)
  wav.write('RIFF', 0, 'ascii')
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt16LE(2, 28)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(20, 40)
  return new Response(wav, {
    status: 200,
    headers: { 'Content-Type': 'audio/wav' }
  })
}

const catalog = {
  version: 'test',
  updatedAt: '2026-11-04',
  provider: 'volcengine',
  model: 'test',
  endpoint: 'test',
  source: { title: 'test', url: 'test' },
  selectionPolicy: [],
  voices: [
    {
      order: 1,
      name: 'Vivi',
      voiceType: 'zh_female_vv_uranus_bigtts',
      scene: '通用',
      gender: 'female',
      languageSummary: '中文',
      capabilities: [],
      isDefault: true
    }
  ]
}

const recorder = new Recorder('external-tts')

await recorder.check('E1', '设置默认 cloud；本地实例 ID 白名单清洗', async () => {
  const normalized = normalizeVoiceSettings({}, catalog)
  assertEq(normalized.speakRoute, 'cloud', '默认朗读路由')
  assertEq(normalized.externalProviderId, '', '默认不选本地实例')
  assertEq(DEFAULT_VOICE_SETTINGS.speakRoute, 'cloud', '默认值常量')
  const bad = normalizeVoiceSettings(
    { speakRoute: 'bogus', externalProviderId: 'not-an-id' },
    catalog
  )
  assertEq(bad.speakRoute, 'cloud', '非法路由回落 cloud')
  assertEq(bad.externalProviderId, '', '非法实例 ID 清空')
  return '设置清洗正确'
})

await recorder.check('E2', 'OpenAI 适配器：URL、请求体、Bearer、音频与错误码', async () => {
  assertEq(
    normalizeExternalBaseUrl('http://127.0.0.1:8091'),
    'http://127.0.0.1:8091/v1',
    '无 /v1 自动补全'
  )
  assertEq(
    normalizeExternalBaseUrl('http://127.0.0.1:8091/v1/'),
    'http://127.0.0.1:8091/v1',
    '已有 /v1 不重复'
  )
  // 本机/局域网服务最常见的填法：只写主机:端口（不带协议头）
  assertEq(
    normalizeExternalBaseUrl('192.168.31.36:7860'),
    'http://192.168.31.36:7860/v1',
    '省略协议自动补 http:// 并补 /v1'
  )
  assertEq(
    normalizeExternalBaseUrl('localhost:7860'),
    'http://localhost:7860/v1',
    'localhost:port 不能被误当成 scheme'
  )
  // 合法但少一个斜杠的 http 写法不能被补成 http://http/...
  assertEq(
    normalizeExternalBaseUrl('http:/example.com'),
    'http://example.com/v1',
    'http:/ 单斜杠仍按 http 解析'
  )
  assertEq(
    normalizeExternalBaseUrl('http:example.com'),
    'http://example.com/v1',
    'http: 无斜杠仍按 http 解析'
  )
  let schemeCode = ''
  try {
    normalizeExternalBaseUrl('mailto:a@example.com')
  } catch (error) {
    schemeCode = error.code
  }
  assertEq(schemeCode, VOICE_ERROR_CODES.INVALID_INPUT, 'mailto: 等非 http 协议拒绝')
  let code = ''
  try {
    normalizeExternalBaseUrl('ftp://example.com')
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.INVALID_INPUT, '非 http(s) 拒绝')

  const calls = []
  const service = {
    id: 'ext:00000000-0000-4000-8000-000000000001',
    kind: 'openai-speech',
    label: 'test',
    baseUrl: 'http://127.0.0.1:8091/v1',
    model: 'qwen3-tts',
    voice: 'Chelsie',
    responseFormat: 'mp3',
    createdAt: 1,
    updatedAt: 1
  }
  const provider = createOpenAISpeechProvider(
    service,
    'external-key',
    async (url, init) => {
      calls.push({ url: String(url), init })
      return externalAudio()
    }
  )
  const result = await provider.synthesize({
    text: '你好。',
    voice: 'Chelsie',
    speedRatio: 1.2
  })
  assertEq(result.extension, 'mp3', '按 Content-Type 识别 mp3')
  assertEq(result.mime, 'audio/mpeg', 'mime')
  assertEq(calls[0].url, 'http://127.0.0.1:8091/v1/audio/speech', 'speech URL')
  assertEq(calls[0].init.headers.Authorization, 'Bearer external-key', 'Bearer')
  const body = JSON.parse(calls[0].init.body)
  assertEq(body.model, 'qwen3-tts', 'body model')
  assertEq(body.input, '你好。', 'body input')
  assertEq(body.voice, 'Chelsie', 'body voice')
  assertEq(body.response_format, 'mp3', 'body format')
  assertEq(body.speed, 1.2, 'body speed')

  const unauthorized = createOpenAISpeechProvider(
    service,
    null,
    async () => new Response('bad key', { status: 401 })
  )
  try {
    await unauthorized.synthesize({ text: 'x', voice: 'v' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.AUTH_ERROR, '401 映射鉴权错误')

  const rateLimited = createOpenAISpeechProvider(
    service,
    null,
    async () => new Response('slow down', { status: 429 })
  )
  try {
    await rateLimited.synthesize({ text: 'x', voice: 'v' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.RATE_LIMITED, '429 映射限流错误')

  const upstreamFailed = createOpenAISpeechProvider(
    service,
    null,
    async () => new Response('boom', { status: 500 })
  )
  try {
    await upstreamFailed.synthesize({ text: 'x', voice: 'v' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.PROVIDER_ERROR, '5xx 映射供应商错误')

  const badResponse = createOpenAISpeechProvider(
    service,
    null,
    async () =>
      new Response('not audio', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  try {
    await badResponse.synthesize({ text: 'x', voice: 'v' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE, '非音频响应拒绝')

  const fakeAudio = createOpenAISpeechProvider(
    service,
    null,
    async () =>
      new Response('not-audio', {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
      })
  )
  try {
    await fakeAudio.synthesize({ text: 'x', voice: 'v' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE, '伪音频内容拒绝')

  const invalidFrame = createOpenAISpeechProvider(
    service,
    null,
    async () =>
      new Response(Buffer.from([0xff, 0xfb, 0x00, 0x00]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
      })
  )
  try {
    await invalidFrame.synthesize({ text: 'x', voice: 'v' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE, '非法 MP3 帧头拒绝')

  const noModels = createOpenAISpeechProvider(
    service,
    null,
    async () => new Response(null, { status: 204 })
  )
  const noModelsProbe = await noModels.probe()
  assertEq(noModelsProbe.ok, true, '/models 204 按「可达但需试听」处理')
  assertEq(noModelsProbe.weak, true, '/models 204 标记 weak')
  const validModels = createOpenAISpeechProvider(
    service,
    null,
    async () =>
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  const validModelsProbe = await validModels.probe()
  assertEq(validModelsProbe.ok, true, '/models 有效 JSON 判定成功')
  const badJson = createOpenAISpeechProvider(
    service,
    null,
    async () =>
      new Response('{bad json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  const badJsonProbe = await badJson.probe()
  assertEq(badJsonProbe.ok, true, '/models 坏 JSON 按「可达但需试听」处理')
  assertEq(badJsonProbe.weak, true, '/models 坏 JSON 标记 weak')

  // 用户真实场景：Gradio/自定义 TTS 可能 404/405、HTML 或空 200；都算可达待试听
  const weakCases = [
    ['404', () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })],
    ['405', () => new Response('', { status: 405 })],
    [
      '200 HTML',
      () =>
        new Response('<html>gradio</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        })
    ],
    [
      '200 空 body',
      () => new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } })
    ]
  ]
  for (const [label, makeResponse] of weakCases) {
    const provider = createOpenAISpeechProvider(service, null, async () => makeResponse())
    const probe = await provider.probe()
    assertEq(probe.ok, true, `${label} 可达但 /models 不兼容时不算失败`)
    assertEq(probe.weak, true, `${label} 标记 weak（需试听）`)
  }

  // 真实错误仍必须抛：401 不能因为返回了 HTTP 响应就被当作“可达待试听”
  const unauthorizedProbeProvider = createOpenAISpeechProvider(
    service,
    null,
    async () =>
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  let unauthorizedCode = ''
  try {
    await unauthorizedProbeProvider.probe()
  } catch (error) {
    unauthorizedCode = error.code
  }
  assertEq(unauthorizedCode, VOICE_ERROR_CODES.AUTH_ERROR, 'probe 遇 401 仍抛鉴权错误')

  // Voicebox 原生接口：/v1/models 404，但 /profiles 200 → 直接支持 /generate/stream
  const nativeRequests = []
  const nativeProvider = createOpenAISpeechProvider(
    { ...service, baseUrl: 'http://127.0.0.1:17493' },
    null,
    async (url, init) => {
      const target = String(url)
      if (target.endsWith('/v1/models')) return new Response('{}', { status: 404 })
      if (target.endsWith('/profiles')) {
        return new Response(
          JSON.stringify([
            {
              id: 'profile-vivian',
              name: 'Vivian 中文女声',
              language: 'zh',
              preset_engine: 'qwen_custom_voice'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (target.endsWith('/generate/stream')) {
        nativeRequests.push({ url: target, body: JSON.parse(String(init?.body ?? '{}')) })
        return externalWav()
      }
      return new Response('not found', { status: 404 })
    }
  )
  const nativeProbe = await nativeProvider.probe()
  assertEq(nativeProbe.ok, true, 'Voicebox /profiles 可读时探活通过')
  assertEq(nativeProbe.weak, undefined, 'Voicebox 原生探活是强成功，不是 weak')
  const nativeAudio = await nativeProvider.synthesize({
    text: '你好',
    voice: 'Vivian 中文女声'
  })
  assertEq(nativeAudio.extension, 'wav', 'Voicebox 原生返回 WAV')
  assertEq(nativeRequests.length, 1, '调用 /generate/stream')
  assertEq(nativeRequests[0].body.profile_id, 'profile-vivian', '按名称解析 profile_id')
  assertEq(nativeRequests[0].body.engine, 'qwen_custom_voice', 'engine 使用 preset_engine')
  assert(
    nativeRequests[0].body.profile_id && !nativeRequests[0].url.includes('/v1/generate/stream'),
    '原生接口走根路径 /generate/stream，不在 /v1 下'
  )

  // 真 OpenAI 404：原生也不可用时，错误必须保留原 speech 的 404，而不是只报 profiles 404
  const true404 = createOpenAISpeechProvider(
    { ...service, baseUrl: 'http://127.0.0.1:17494' },
    null,
    async (url) => {
      const target = String(url)
      if (target.endsWith('/audio/speech')) return new Response('speech not found', { status: 404 })
      return new Response('profiles not found', { status: 404 })
    }
  )
  let true404Code = ''
  let true404Message = ''
  try {
    await true404.synthesize({ text: '你好', voice: 'Vivian' })
  } catch (error) {
    true404Code = error.code
    true404Message = String(error.message)
  }
  assertEq(true404Code, VOICE_ERROR_CODES.PROVIDER_ERROR, '真 404 不伪装成成功')
  assert(true404Message.includes('HTTP 404'), '真 404 错误保留原 speech 状态')
  assert(true404Message.includes('profiles not found') === false, '原生 profiles 404 不覆盖原错误')

  // /profiles 401 时探活不能报“可达”
  const profiles401 = createOpenAISpeechProvider(
    { ...service, baseUrl: 'http://127.0.0.1:17495' },
    null,
    async (url) => {
      const target = String(url)
      if (target.endsWith('/v1/models')) return new Response('{}', { status: 404 })
      return new Response('unauthorized', { status: 401 })
    }
  )
  let profiles401Code = ''
  try {
    await profiles401.probe()
  } catch (error) {
    profiles401Code = error.code
  }
  assertEq(profiles401Code, VOICE_ERROR_CODES.AUTH_ERROR, '原生 /profiles 401 探活抛鉴权错误')

  return '适配器协议与错误映射正确'
})

await recorder.check('E3', '实例 JSON 不含 Key，独立加密文件可读写删', async () => {
  const servicesPath = join(runDir, 'external-services.json')
  const secretsPath = join(runDir, 'external-secrets.bin')
  const store = createExternalServiceStore(servicesPath)
  const saved = await store.save({
    label: '家里 GPU',
    baseUrl: 'http://192.168.1.20:8091',
    model: 'Qwen/Qwen3-TTS',
    voice: 'Chelsie',
    responseFormat: 'wav'
  })
  assertEq((await store.list()).length, 1, '实例已保存')
  assertEq((await store.get(saved.id)).voice, 'Chelsie', '实例可读')
  const servicesRaw = readFileSync(servicesPath, 'utf8')
  assert(!servicesRaw.includes('external-key-12345678'), '实例 JSON 不含 Key')

  const secrets = createExternalVoiceSecretStore(secretsPath, fakeEncryption())
  await secrets.set(saved.id, 'external-key-12345678')
  assertEq(await secrets.get(saved.id), 'external-key-12345678', 'Key 可读')
  const secretRaw = readFileSync(secretsPath, 'utf8')
  assert(!secretRaw.includes('external-key-12345678'), '加密文件不含明文')

  const [a, b] = await Promise.all([
    store.save({
      label: 'A',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'm',
      voice: 'v',
      responseFormat: 'mp3'
    }),
    store.save({
      label: 'B',
      baseUrl: 'http://127.0.0.1:2/v1',
      model: 'm',
      voice: 'v',
      responseFormat: 'mp3'
    })
  ])
  assertEq((await store.list()).length, 3, '并发创建不丢实例')
  await Promise.all([secrets.set(a.id, 'key-A'), secrets.set(b.id, 'key-B')])
  assertEq(await secrets.get(a.id), 'key-A', '并发 Key A 不丢')
  assertEq(await secrets.get(b.id), 'key-B', '并发 Key B 不丢')

  const blockingFile = join(runDir, 'blocking-file')
  writeFileSync(blockingFile, 'not-a-directory')
  const brokenStore = createExternalServiceStore(join(blockingFile, 'services.json'))
  let saveFailed = false
  try {
    await brokenStore.save({
      label: 'bad',
      baseUrl: 'http://127.0.0.1:3/v1',
      model: 'm',
      voice: 'v',
      responseFormat: 'mp3'
    })
  } catch {
    saveFailed = true
  }
  assertEq(saveFailed, true, '落盘失败必须向上报错')
  assertEq((await brokenStore.list()).length, 0, '落盘失败不返回成功实例')

  await secrets.delete(saved.id)
  assertEq(await secrets.get(saved.id), null, '删除 Key')
  assertEq(await store.remove(saved.id), true, '删除实例')
  return '实例与 Key 物理隔离'
})

await recorder.check('E4', 'Manager external 路由、缓存、失败冷却与 auto 回落', async () => {
  const servicesPath = join(runDir, 'manager-services.json')
  const secretsPath = join(runDir, 'manager-secrets.bin')
  const store = createExternalServiceStore(servicesPath)
  const externalSecrets = createExternalVoiceSecretStore(secretsPath, fakeEncryption())
  const service = await store.save({
    label: '本地实例',
    baseUrl: 'http://127.0.0.1:8091/v1',
    model: 'qwen3-tts',
    voice: 'Chelsie',
    responseFormat: 'mp3'
  })
  await externalSecrets.set(service.id, 'external-key-12345678')

  let externalCalls = 0
  let cloudCalls = 0
  let failExternal = false
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/audio/speech')) {
      externalCalls += 1
      assertEq(init.headers.Authorization, 'Bearer external-key-12345678', '本地 Key')
      if (failExternal) return new Response('boom', { status: 500 })
      return externalAudio()
    }
    cloudCalls += 1
    return ttsResponse()
  }
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets,
    cacheDir: join(runDir, 'audio'),
    fetchImpl,
    logger: () => undefined
  })
  await manager.updateSettings({
    speakRoute: 'external',
    externalProviderId: service.id
  })
  const first = await manager.speak({ text: '本地测试。' })
  const second = await manager.speak({ text: '本地测试。' })
  assertEq(first.engine, 'external', 'external engine')
  assertEq(first.route, 'external', 'external route')
  assertEq(first.providerId, service.id, 'provider id')
  assertEq(second.cached, true, '本地音频缓存命中')
  assertEq(externalCalls, 1, '第二次不请求本地')
  assertEq(cloudCalls, 0, '本地模式不请求云端')

  await manager.updateSettings({ speakRoute: 'auto' })
  failExternal = true
  const autoFirst = await manager.speak({ text: '失败一。' })
  assertEq(autoFirst.engine, 'cloud', 'auto 首次失败立即回落云端')
  assert(autoFirst.fallback.reason.includes('HTTP 500'), '首次失败原因可见')
  const autoSecond = await manager.speak({ text: '失败二。' })
  assertEq(autoSecond.engine, 'cloud', 'auto 第二次失败仍回落云端')
  const fallback = await manager.speak({ text: '冷却后自动回落。' })
  assertEq(fallback.engine, 'cloud', 'auto 回落云端')
  assertEq(fallback.route, 'preset', '云端预设路由')
  assertEq(fallback.fallback.reason, '本地 TTS 正在失败冷却', '回落原因可见')
  assertEq(externalCalls, 3, '两次失败后第三次不再打本地')
  assertEq(cloudCalls, 3, '两次失败各自回落，冷却期仍回落')

  await manager.updateSettings({ speakRoute: 'external' })
  let cooldownCode = ''
  try {
    await manager.speak({ text: '显式 external 不应回落。' })
  } catch (error) {
    cooldownCode = error.code
  }
  assertEq(
    cooldownCode,
    VOICE_ERROR_CODES.EXTERNAL_COOLDOWN,
    '显式 external 冷却期直接报错'
  )
  assertEq(externalCalls, 3, '显式 external 冷却期不再打本地')
  assertEq(cloudCalls, 3, '显式 external 不偷偷回落云端')

  failExternal = false
  const retry = await manager.testExternalService(service.id)
  assertEq(retry.audio.engine, 'external', '冷却后试听可真实恢复')
  assertEq(externalCalls, 4, '冷却后试听绕过冷却并真实请求本地')
  return 'external / auto 路由、缓存与冷却正确'
})

await recorder.check('E5', '本地实例 CRUD 通过 Manager，删除时清理 Key', async () => {
  const servicesPath = join(runDir, 'manager-crud-services.json')
  const secretsPath = join(runDir, 'manager-crud-secrets.bin')
  const store = createExternalServiceStore(servicesPath)
  const externalSecrets = createExternalVoiceSecretStore(secretsPath, fakeEncryption())
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets,
    cacheDir: join(runDir, 'crud-audio'),
    fetchImpl: async () => ttsResponse(),
    logger: () => undefined
  })
  const saved = await manager.saveExternalService({
    label: 'CRUD',
    baseUrl: 'http://127.0.0.1:9000',
    model: 'model',
    voice: 'voice',
    responseFormat: 'mp3',
    apiKey: 'crud-key-123456'
  })
  assertEq(saved.hasKey, true, '保存 Key 状态')
  assertEq(saved.keyTail, '****3456', 'Key 尾号')
  assertEq((await manager.listExternalServices()).length, 1, '列表')
  await manager.removeExternalService(saved.id)
  assertEq((await manager.listExternalServices()).length, 0, '删除实例')
  assertEq(await externalSecrets.get(saved.id), null, '删除实例同时清 Key')
  return 'CRUD 与 Key 生命周期正确'
})

await recorder.check('E6', '语音页已接入本地实例管理、必填校验、草稿测试与试听入口', async () => {
  const vue = readFileSync(
    join(repoRoot, 'src/views/voice/VoicePage.vue'),
    'utf8'
  )
  assert(vue.includes('应用内朗读路由'), '路由控件')
  assert(vue.includes('本地 TTS 服务'), '本地服务卡片')
  assert(vue.includes('api.external.save'), '保存调用')
  assert(vue.includes('api.external.probe'), '测试连接调用')
  assert(vue.includes('api.external.probeDraft'), '未保存草稿的测试连接调用')
  assert(vue.includes('api.external.test'), '试听调用')
  assert(vue.includes('api.external.remove'), '删除调用')
  // 必填项要在界面上标出来；默认值只在探测到本机适配器时异步填入
  assert(vue.includes('实例名称 *'), '实例名称必填标记')
  assert(vue.includes('服务地址 *'), '服务地址必填标记')
  assert(vue.includes('LOCAL_ADAPTER_DEFAULTS'), '默认值单一定义（避免多处硬编码）')
  assert(vue.includes("baseUrl: 'http://127.0.0.1:7862'"), '默认地址指向本机适配器')
  assert(vue.includes('detectLocalAdapterDefaults'), '仅探测到本机适配器时才填默认值')
  assert(vue.includes('externalFormTouched'), '用户输入后不得被异步默认值覆盖')
  assert(
    vue.includes("externalForm.baseUrl = service?.baseUrl ?? ''"),
    '新表单初始为空（未探测到适配器时不预填连不上的地址）'
  )
  assert(vue.includes("externalForm.model = service?.model ?? ''"), '编辑态模型取已存值')
  assert(vue.includes('external-form-actions'), '按钮行样式类')
  assert(vue.includes('function validateExternalForm'), '表单必填校验函数存在')
  assert(vue.includes("missing.push('实例名称')"), '必填校验覆盖实例名称')
  assert(vue.includes('externalFormError.value = invalid'), '校验失败写行内错误')
  // 草稿通道必须主进程/preload 两端都有，且主进程真的注册了 handler（只断言常量会假绿）
  const ipcSrc = readFileSync(join(repoRoot, 'electron/main/fish/voice/ipc.ts'), 'utf8')
  const preloadSrc = readFileSync(join(repoRoot, 'electron/preload/index.ts'), 'utf8')
  assert(
    ipcSrc.includes("externalProbeDraft: 'fish:voice:external:probeDraft'"),
    '主进程通道常量含 probeDraft'
  )
  assert(
    ipcSrc.includes('handle(VOICE_CHANNELS.externalProbeDraft'),
    '主进程真的注册了 probeDraft handler（不是只声明常量）'
  )
  assert(
    preloadSrc.includes("'fish:voice:external:probeDraft'"),
    'preload 暴露 fish:voice:external:probeDraft'
  )
  // 音色查询：可手填查询地址 + 查询按钮 + 主进程/preload 双通道装配
  assert(vue.includes('音色查询接口（可空）'), '音色查询地址输入框')
  assert(vue.includes('api.external.queryProfiles'), '查询音色调用')
  assert(vue.includes('externalForm.profilesPath'), '查询地址随表单状态保存')
  assert(
    ipcSrc.includes("externalProfilesQuery: 'fish:voice:external:profilesQuery'"),
    '主进程通道常量含 profilesQuery'
  )
  assert(
    ipcSrc.includes('handle(VOICE_CHANNELS.externalProfilesQuery'),
    '主进程真的注册了 profilesQuery handler（不是只声明常量）'
  )
  assert(
    preloadSrc.includes("'fish:voice:external:profilesQuery'"),
    'preload 暴露 fish:voice:external:profilesQuery'
  )
  // 在途查询失效守卫：地址变化/关表单使序号递增，迟到回包按序号丢弃，防止旧主机音色回填
  assert(vue.includes('externalProfilesSeq'), '查询序号状态存在')
  assert(vue.includes('function staleExternalProfiles'), '地址变化使在途查询失效的函数存在')
  assert(
    vue.includes('if (seq !== externalProfilesSeq) return'),
    '迟到回包按序号丢弃（成功与失败两条路径都要守）'
  )
  // 对话内语音通道单选：auto/本地实例/火山标准/桥接 四档，保底子单选只在本地实例档出现
  assert(vue.includes('role="radiogroup" aria-label="对话内语音通道"'), '通道选择是单选组')
  assert(
    vue.includes('本地 TTS 实例（17493 等自建服务）'),
    '本地 TTS 实例单选项文案'
  )
  assert(
    vue.includes('自动（按已配置可用列表顺序选，失败自动切下一个）'),
    '自动档文案体现候选链顺序选路'
  )
  assert(
    vue.includes('v-if="voiceForm.conversationChannel === \'local-external\'"'),
    '失败保底只在本地实例通道下展示'
  )
  assert(vue.includes('失败保底'), '失败保底分组标题')
  assert(vue.includes('降级火山标准接口（推荐）'), '保底：降级火山标准接口')
  assert(vue.includes('不降级，直接报错'), '保底：不降级直接报错')
  assert(
    vue.includes('v-model="voiceForm.conversationFallback"'),
    '保底策略与表单状态双向绑定'
  )
  // 保底选择必须随主表单保存，且两个设置加载器都要回填（漏一个就会出现界面回显默认值）
  assert(
    vue.includes('conversationFallback: voiceForm.conversationFallback,'),
    'conversationFallback 随语音设置保存透传'
  )
  assert(
    vue.includes('voiceForm.conversationFallback = next.conversationFallback'),
    'refreshSettings 回填保底策略'
  )
  assert(
    vue.includes('voiceForm.conversationFallback = nextSettings.conversationFallback'),
    '首屏加载器回填保底策略'
  )
  return 'VoicePage 本地实例操作/必填/草稿测试入口已装配'
})

await recorder.check('E10', '草稿连接测试：不保存实例、不写 Key；省略协议自动补全', async () => {
  const calls = []
  const servicesPath = join(runDir, 'draft-services.json')
  const store = createExternalServiceStore(servicesPath)
  const draftSecretsPath = join(runDir, 'draft-secrets.bin')
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets: createExternalVoiceSecretStore(draftSecretsPath, fakeEncryption()),
    cacheDir: join(runDir, 'draft-audio'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify({ data: [{ id: 'tts-1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    },
    logger: () => undefined
  })
  const result = await manager.probeExternalDraft({
    baseUrl: '192.168.31.36:7860',
    apiKey: 'draft-key'
  })
  assertEq(result.ok, true, '草稿探活成功')
  assertEq(calls[0].url, 'http://192.168.31.36:7860/v1/models', '省略协议也会补全到 /v1/models')
  assertEq(calls[0].headers.Authorization, 'Bearer draft-key', '草稿 Key 只进本次请求头')
  assertEq((await manager.listExternalServices()).length, 0, '草稿测试不保存实例')
  assertEq(existsSync(servicesPath), false, '草稿测试不创建实例 JSON')
  assertEq(existsSync(draftSecretsPath), false, '草稿测试不创建 Key 文件')
  assertEq(
    existsSync(servicesPath) ? readFileSync(servicesPath, 'utf8').includes('draft-key') : false,
    false,
    '草稿 Key 不落盘'
  )

  let badCode = ''
  try {
    await manager.probeExternalDraft({ baseUrl: 'ftp://example.com' })
  } catch (error) {
    badCode = error.code
  }
  assertEq(badCode, VOICE_ERROR_CODES.INVALID_INPUT, '非 http(s) 草稿地址拒绝')

  // 编辑已有实例时 Key 留空：地址没变复用已存 Key；地址变了不得把旧凭据发到新主机
  const reuseCalls = []
  const reusePath = join(runDir, 'draft-reuse-services.json')
  const reuseSecrets = createExternalVoiceSecretStore(
    join(runDir, 'draft-reuse-secrets.bin'),
    fakeEncryption()
  )
  const reuseManager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: createExternalServiceStore(reusePath),
    externalSecrets: reuseSecrets,
    cacheDir: join(runDir, 'draft-reuse-audio'),
    fetchImpl: async (url, init) => {
      reuseCalls.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    },
    logger: () => undefined
  })
  const stored = await reuseManager.saveExternalService({
    label: '复用 Key',
    baseUrl: 'http://127.0.0.1:9100',
    model: 'model',
    voice: 'voice',
    apiKey: 'stored-key-123456'
  })
  await reuseManager.probeExternalDraft({ baseUrl: '127.0.0.1:9100', id: stored.id })
  assertEq(
    reuseCalls[0].headers.Authorization,
    'Bearer stored-key-123456',
    '编辑态地址未变：草稿测试复用已存 Key'
  )
  await reuseManager.probeExternalDraft({ baseUrl: '127.0.0.1:9101', id: stored.id })
  assertEq(
    reuseCalls[1].headers.Authorization,
    undefined,
    '地址变了：不得把旧主机的 Key 发给新地址'
  )
  return '草稿探活不落盘、Key 不持久化、非法地址拒绝、编辑态安全复用 Key'
})

await recorder.check('E7', '地址变更清 Key；非法参数；PCM 请求强制 WAV 且不串缓存', async () => {
  const servicesPath = join(runDir, 'safety-services.json')
  const secretsPath = join(runDir, 'safety-secrets.bin')
  const store = createExternalServiceStore(servicesPath)
  const externalSecrets = createExternalVoiceSecretStore(secretsPath, fakeEncryption())
  const saved = await createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets,
    cacheDir: join(runDir, 'safety-audio'),
    fetchImpl: async () => {
      throw new Error('unused')
    },
    logger: () => undefined
  }).saveExternalService({
    label: '安全边界',
    baseUrl: 'http://127.0.0.1:9100',
    model: 'model',
    voice: 'voice',
    responseFormat: 'mp3',
    apiKey: 'sensitive-key'
  })
  assertEq(saved.hasKey, true, '首次保存 Key')

  const requests = []
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets,
    cacheDir: join(runDir, 'safety-audio'),
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null
      requests.push({ url: String(url), body, headers: init.headers })
      return body?.response_format === 'wav' ? externalWav() : externalAudio()
    },
    logger: () => undefined
  })
  await manager.updateSettings({
    speakRoute: 'external',
    externalProviderId: saved.id
  })

  // 地址变化但没填新 Key：旧 Key 必须清除，不能发往新主机。
  const moved = await manager.saveExternalService({
    id: saved.id,
    label: saved.label,
    baseUrl: 'http://127.0.0.1:9101/v1',
    model: saved.model,
    voice: saved.voice,
    responseFormat: saved.responseFormat
  })
  assertEq(moved.hasKey, false, '改地址后旧 Key 被清除')
  assertEq(await externalSecrets.get(saved.id), null, '旧 Key 不再可读')

  let code = ''
  try {
    await manager.speak({ text: '非法引擎。', options: { engine: 'local' } })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.INVALID_INPUT, '非法 engine 显式报错')
  try {
    await manager.speak({ text: '非法实例。', options: { providerId: 'bad' } })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.INVALID_INPUT, '非法 providerId 显式报错')
  assertEq(requests.length, 0, '非法参数不发起 HTTP')

  const normal = await manager.speak({ text: '同一段格式测试。' })
  assertEq(normal.mime, 'audio/mpeg', '默认实例格式 mp3')
  const pcm = await manager.speak({
    text: '同一段格式测试。',
    options: { format: 'pcm', sampleRate: 16000 }
  })
  assertEq(pcm.mime, 'audio/wav', 'PCM 请求得到 WAV')
  assertEq(pcm.engine, 'external', 'PCM 仍走本地实例')
  const speechCalls = requests.filter((r) => r.url.endsWith('/audio/speech'))
  assertEq(speechCalls.at(-1).body.response_format, 'wav', 'PCM 请求强制 response_format=wav')
  assertEq(speechCalls.length, 2, '不同输出格式不串缓存')

  await manager.removeExternalService(saved.id)
  const settingsAfterDelete = await manager.getSettings()
  assertEq(settingsAfterDelete.speakRoute, 'cloud', '删除选中实例后回 cloud')
  assertEq(settingsAfterDelete.externalProviderId, '', '删除后清实例选择')

  code = ''
  try {
    await manager.updateSettings({ speakRoute: 'external' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.INVALID_INPUT, 'external 模式无实例保存即拒绝')
  return 'Key/格式/参数/删除路由边界正确'
})

await recorder.check('E8', 'Key 加密不可用时保存失败并回滚实例', async () => {
  const servicesPath = join(runDir, 'encryption-services.json')
  const secretsPath = join(runDir, 'encryption-secrets.bin')
  const store = createExternalServiceStore(servicesPath)
  const unavailableSecrets = createExternalVoiceSecretStore(secretsPath, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  })
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets: unavailableSecrets,
    cacheDir: join(runDir, 'encryption-audio'),
    fetchImpl: async () => ttsResponse(),
    logger: () => undefined
  })
  let code = ''
  try {
    await manager.saveExternalService({
      label: '加密不可用',
      baseUrl: 'http://127.0.0.1:9200/v1',
      model: 'm',
      voice: 'v',
      responseFormat: 'mp3',
      apiKey: 'cannot-persist'
    })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.ENCRYPTION_UNAVAILABLE, 'Key 写入失败错误码')
  assertEq((await manager.listExternalServices()).length, 0, 'Key 写入失败回滚实例')
  return 'safeStorage 不可用时不留下半装实例'
})

await recorder.check('E9', '删除 Key 失败时保留实例，不制造半删状态', async () => {
  const servicesPath = join(runDir, 'delete-key-services.json')
  const store = createExternalServiceStore(servicesPath)
  const throwingSecrets = {
    async get() {
      return 'stored-key'
    },
    async set() {
      return { hasKey: true, tail: '****key' }
    },
    async delete() {
      throw new errorsMod.VoiceError(
        VOICE_ERROR_CODES.ENCRYPTION_UNAVAILABLE,
        'simulated delete failure'
      )
    },
    async status() {
      return { hasKey: true, tail: '****key' }
    }
  }
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets: throwingSecrets,
    cacheDir: join(runDir, 'delete-key-audio'),
    fetchImpl: async () => ttsResponse(),
    logger: () => undefined
  })
  const saved = await manager.saveExternalService({
    label: '删除失败',
    baseUrl: 'http://127.0.0.1:9300/v1',
    model: 'm',
    voice: 'v',
    responseFormat: 'mp3'
  })
  let code = ''
  try {
    await manager.removeExternalService(saved.id)
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.ENCRYPTION_UNAVAILABLE, 'Key 删除失败向上报错')
  assertEq((await manager.listExternalServices()).length, 1, 'Key 删除失败时实例仍在')
  return '删除失败不留下半删实例'
})

await recorder.check('E11', '音色查询地址归一化、listProfiles 解析与克隆音色合成', async () => {
  // normalizeProfilesPath：空/同主机路径/完整 URL/非法形态
  assertEq(normalizeProfilesPath(undefined), '', 'undefined 回落空串')
  assertEq(normalizeProfilesPath('   '), '', '空白回落空串')
  assertEq(normalizeProfilesPath('/v2/voices'), '/v2/voices', '同主机路径原样保留')
  assertEq(
    normalizeProfilesPath('http://192.168.1.9:9000/voices'),
    'http://192.168.1.9:9000/voices',
    '完整 URL 保留'
  )
  for (const bad of [
    '//host/path',
    'ftp://192.168.1.9/x',
    '不是地址',
    'http://user:pass@192.168.1.9/voices'
  ]) {
    let badCode = ''
    try {
      normalizeProfilesPath(bad)
    } catch (error) {
      badCode = error.code
    }
    assertEq(badCode, VOICE_ERROR_CODES.INVALID_INPUT, `非法查询地址拒绝：${bad}`)
  }

  // resolveProfilesUrl：默认 /profiles、同主机路径、跨主机标记
  const defaultTarget = resolveProfilesUrl('http://127.0.0.1:8091/v1', undefined)
  assertEq(defaultTarget.url, 'http://127.0.0.1:8091/profiles', '默认查询地址在服务根路径')
  assertEq(defaultTarget.crossHost, false, '默认地址不跨主机')
  const pathTarget = resolveProfilesUrl('http://127.0.0.1:8091/v1', '/v2/voices')
  assertEq(pathTarget.url, 'http://127.0.0.1:8091/v2/voices', '同主机路径拼到实例根')
  assertEq(pathTarget.crossHost, false, '同主机路径不跨主机')
  const crossTarget = resolveProfilesUrl(
    'http://127.0.0.1:8091/v1',
    'http://192.168.1.9:9000/voices'
  )
  assertEq(crossTarget.crossHost, true, '不同 origin 标记跨主机')

  const profilesService = {
    id: 'ext:00000000-0000-4000-8000-000000000002',
    kind: 'openai-speech',
    label: 'query',
    baseUrl: 'http://127.0.0.1:17493/v1',
    model: 'voicebox',
    voice: 'Vivian',
    responseFormat: 'wav',
    createdAt: 1,
    updatedAt: 1
  }
  const profilesBody = {
    profiles: [
      {
        id: 'preset-1',
        name: 'Vivian 明亮女声',
        voice_type: 'preset',
        language: 'zh',
        preset_engine: 'qwen_custom_voice'
      },
      {
        id: 'cloned-1',
        name: '我的克隆音色',
        voice_type: 'cloned',
        language: 'zh',
        default_engine: 'qwen',
        sample_count: 3
      },
      {
        id: 'cloned-empty',
        name: '空克隆',
        voice_type: 'cloned',
        default_engine: 'qwen',
        sample_count: 0
      },
      {
        id: 'designed-1',
        name: '文字设计音色',
        voice_type: 'designed',
        language: 'zh',
        default_engine: 'qwen',
        sample_count: 1
      }
    ]
  }
  const queryCalls = []
  const queryProvider = createOpenAISpeechProvider(
    profilesService,
    'query-key-12345678',
    async (url, init) => {
      queryCalls.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify(profilesBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  )
  const result = await queryProvider.listProfiles(undefined)
  assertEq(result.profiles.length, 4, '解析 {profiles:[]} 包裹结构')
  assertEq(result.sourceUrl, 'http://127.0.0.1:17493/profiles', '实际查询地址回传')
  assertEq(
    queryCalls[0].headers.Authorization,
    'Bearer query-key-12345678',
    '同主机查询携带实例 Key'
  )
  const preset = result.profiles.find((item) => item.id === 'preset-1')
  assertEq(preset.engine, 'qwen_custom_voice', '预设音色派生 preset 引擎')
  assertEq(preset.usable, true, '预设音色默认可用')
  const cloned = result.profiles.find((item) => item.id === 'cloned-1')
  assertEq(cloned.engine, 'qwen', '克隆音色派生 qwen 引擎')
  assertEq(cloned.modelSize, '1.7B', '克隆音色带 1.7B model_size')
  assertEq(cloned.usable, true, '有样本的克隆音色可用')
  const emptyClone = result.profiles.find((item) => item.id === 'cloned-empty')
  assertEq(emptyClone.usable, false, 'sample_count=0 的克隆音色不可用')
  assert(!!emptyClone.unavailableReason, '不可用原因非空')
  const designed = result.profiles.find((item) => item.id === 'designed-1')
  assertEq(designed.engine, 'qwen', '设计音色与克隆共用 qwen 引擎派生')
  assertEq(designed.modelSize, '1.7B', '设计音色带 1.7B model_size')
  assertEq(designed.usable, true, '有样本的设计音色可用')

  // 跨主机查询：实例即使配了 Key 也不能外发
  const crossCalls = []
  const crossProvider = createOpenAISpeechProvider(
    profilesService,
    'query-key-12345678',
    async (url, init) => {
      crossCalls.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify([{ id: 'x', name: 'X' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  )
  const crossResult = await crossProvider.listProfiles('http://192.168.1.9:9000/voices')
  assertEq(crossResult.crossHost, true, '跨主机结果带标记')
  assertEq(crossCalls[0].headers.Authorization, undefined, '跨主机请求不携带 Key')

  // 跨主机 401/403：文案必须说明「不带 Key 被拒」，不能误导成实例 Key 错误
  const cross401Provider = createOpenAISpeechProvider(
    profilesService,
    'query-key-12345678',
    async () => new Response('forbidden', { status: 401 })
  )
  let cross401Message = ''
  try {
    await cross401Provider.listProfiles('http://192.168.1.9:9000/voices')
  } catch (error) {
    cross401Message = String(error.message)
  }
  assert(cross401Message.includes('不会携带本机实例的 API Key'), '跨主机 401 文案说明剥头原因')

  // unknown 类型语义：只有 preset_engine 的老数据按该引擎合成且不带 model_size；
  // 无任何引擎字段时不静默发请求（deriveVoiceboxEngine 返回 null，合成时报错）
  const unknownProvider = createOpenAISpeechProvider(
    { ...profilesService, baseUrl: 'http://127.0.0.1:17497/v1' },
    null,
    async (url) =>
      new Response(
        JSON.stringify([
          { id: 'legacy-1', name: '老音色', preset_engine: 'qwen_custom_voice' },
          { id: 'no-engine', name: '无引擎' }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  )
  const unknownResult = await unknownProvider.listProfiles(undefined)
  const legacy = unknownResult.profiles.find((item) => item.id === 'legacy-1')
  assertEq(legacy.voiceType, 'unknown', '缺 voice_type 归一为 unknown')
  assertEq(legacy.engine, 'qwen_custom_voice', 'unknown 信任服务端 preset_engine')
  assertEq(legacy.modelSize, undefined, 'preset 引擎不带 model_size')
  const noEngine = unknownResult.profiles.find((item) => item.id === 'no-engine')
  assertEq(noEngine.usable, true, 'unknown 缺 sample_count 不按不可用拦截')
  assertEq(noEngine.engine, undefined, '无引擎字段时不臆造引擎')

  // 空数组/无法识别结构 → BAD_RESPONSE，不能返回空成功
  const emptyProvider = createOpenAISpeechProvider(
    { ...profilesService, baseUrl: 'http://127.0.0.1:17494/v1' },
    null,
    async () => new Response('[]', { status: 200 })
  )
  let emptyCode = ''
  try {
    await emptyProvider.listProfiles(undefined)
  } catch (error) {
    emptyCode = error.code
  }
  assertEq(emptyCode, VOICE_ERROR_CODES.EXTERNAL_BAD_RESPONSE, '空音色列表按坏响应处理')

  // 克隆音色走 Voicebox 原生合成：engine=qwen + model_size=1.7B
  const nativeCalls = []
  const nativeProvider = createOpenAISpeechProvider(
    { ...profilesService, baseUrl: 'http://127.0.0.1:17495/v1' },
    null,
    async (url, init) => {
      const target = String(url)
      if (target.endsWith('/audio/speech')) {
        return new Response('no openai face', { status: 404 })
      }
      if (target.endsWith('/profiles')) {
        return new Response(
          JSON.stringify([
            {
              id: 'cloned-1',
              name: '我的克隆音色',
              voice_type: 'cloned',
              language: 'zh',
              default_engine: 'qwen',
              sample_count: 3
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (target.endsWith('/generate/stream')) {
        nativeCalls.push(JSON.parse(String(init?.body ?? '{}')))
        return externalWav()
      }
      return new Response('not found', { status: 404 })
    }
  )
  const clonedAudio = await nativeProvider.synthesize({ text: '用克隆声音说', voice: 'cloned-1' })
  assertEq(clonedAudio.extension, 'wav', 'Voicebox 原生固定返回 WAV')
  assertEq(nativeCalls.length, 1, '发起一次原生合成')
  assertEq(nativeCalls[0].profile_id, 'cloned-1', '按 id 解析克隆 profile')
  assertEq(nativeCalls[0].engine, 'qwen', '克隆音色 engine=qwen')
  assertEq(nativeCalls[0].model_size, '1.7B', '克隆音色带 model_size=1.7B')

  // 实例配了跨主机查询地址：原生合成前的 /profiles 拉取也必须剥掉 Key
  const crossNativeCalls = []
  const crossNativeProvider = createOpenAISpeechProvider(
    {
      ...profilesService,
      baseUrl: 'http://127.0.0.1:17498/v1',
      profilesPath: 'http://192.168.1.9:9000/profiles'
    },
    'query-key-12345678',
    async (url, init) => {
      const target = String(url)
      if (target.endsWith('/audio/speech')) return new Response('x', { status: 404 })
      if (target === 'http://192.168.1.9:9000/profiles') {
        crossNativeCalls.push({ url: target, headers: init?.headers })
        return new Response(
          JSON.stringify([
            {
              id: 'preset-9',
              name: '跨主机预设',
              voice_type: 'preset',
              preset_engine: 'qwen_custom_voice'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (target.endsWith('/generate/stream')) return externalWav()
      return new Response('not found', { status: 404 })
    }
  )
  await crossNativeProvider.synthesize({ text: '你好', voice: 'preset-9' })
  assertEq(crossNativeCalls.length, 1, '原生合成走配置的跨主机查询地址')
  assertEq(
    crossNativeCalls[0].headers.Authorization,
    undefined,
    '原生合成的跨主机 /profiles 拉取同样剥离 Key'
  )

  // 不可用的克隆音色（sample_count=0）拒绝合成
  const unusableProvider = createOpenAISpeechProvider(
    { ...profilesService, baseUrl: 'http://127.0.0.1:17496/v1' },
    null,
    async (url) => {
      const target = String(url)
      if (target.endsWith('/audio/speech')) return new Response('x', { status: 404 })
      if (target.endsWith('/profiles')) {
        return new Response(
          JSON.stringify([
            { id: 'cloned-empty', name: '空克隆', voice_type: 'cloned', sample_count: 0 }
          ]),
          { status: 200 }
        )
      }
      return new Response('not found', { status: 404 })
    }
  )
  let unusableCode = ''
  let unusableMessage = ''
  try {
    await unusableProvider.synthesize({ text: '你好', voice: 'cloned-empty' })
  } catch (error) {
    unusableCode = error.code
    unusableMessage = String(error.message)
  }
  // synthesize 的 OpenAI 404 fallback 会把 voicebox 内部错误统一包成 PROVIDER_ERROR，
  // 但不可用原因必须透传给用户（与 E2 的真 404 包装行为保持一致）
  assertEq(unusableCode, VOICE_ERROR_CODES.PROVIDER_ERROR, '不可用克隆音色合成失败')
  assert(unusableMessage.includes('暂不可用'), '不可用原因透传到错误文案')

  // 实例存储：profilesPath 随实例持久化，空串表示清除
  const profilesStore = createExternalServiceStore(join(runDir, 'profiles-store.json'))
  const savedWithPath = await profilesStore.save({
    label: '自定义查询',
    baseUrl: 'http://127.0.0.1:9200',
    model: 'voicebox',
    voice: 'Vivian',
    profilesPath: '/v2/voices'
  })
  assertEq(savedWithPath.profilesPath, '/v2/voices', '查询地址随实例保存')
  const cleared = await profilesStore.save({ id: savedWithPath.id, profilesPath: '' })
  assertEq(cleared.profilesPath, undefined, '空串清除已保存的查询地址')
  return '查询地址归一化、音色解析、克隆合成与持久化正确'
})

await recorder.check('E12', 'Manager 草稿音色查询不落盘；Key 复用与跨主机剥离', async () => {
  const servicesPath = join(runDir, 'profiles-query-services.json')
  const secretsPath = join(runDir, 'profiles-query-secrets.bin')
  const calls = []
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: createExternalServiceStore(servicesPath),
    externalSecrets: createExternalVoiceSecretStore(secretsPath, fakeEncryption()),
    cacheDir: join(runDir, 'profiles-query-audio'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers })
      return new Response(
        JSON.stringify({ data: [{ id: 'p1', name: '音色一', voice_type: 'preset' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    },
    logger: () => undefined
  })

  // 纯草稿：表单 Key 只进本次请求头，不创建实例/密钥文件
  const draft = await manager.queryExternalProfiles({
    baseUrl: '192.168.31.36:17493',
    apiKey: 'draft-query-key'
  })
  assertEq(draft.profiles[0].id, 'p1', '草稿查询返回音色')
  assertEq(
    calls[0].url,
    'http://192.168.31.36:17493/profiles',
    '省略协议补全后打默认 /profiles'
  )
  assertEq(calls[0].headers.Authorization, 'Bearer draft-query-key', '草稿 Key 进本次请求头')
  assertEq((await manager.listExternalServices()).length, 0, '草稿查询不保存实例')
  assertEq(existsSync(servicesPath), false, '草稿查询不创建实例 JSON')
  assertEq(existsSync(secretsPath), false, '草稿查询不创建 Key 文件')

  // 编辑态：地址未变复用已存 Key；自定义同主机路径拼到实例根
  const saved = await manager.saveExternalService({
    label: '编辑态',
    baseUrl: 'http://127.0.0.1:9301',
    model: 'voicebox',
    voice: 'p1',
    apiKey: 'stored-query-key-1234'
  })
  await manager.queryExternalProfiles({
    baseUrl: '127.0.0.1:9301',
    id: saved.id,
    profilesPath: '/v2/voices'
  })
  assertEq(calls[1].url, 'http://127.0.0.1:9301/v2/voices', '自定义查询路径拼到实例根')
  assertEq(
    calls[1].headers.Authorization,
    'Bearer stored-query-key-1234',
    '同主机编辑态复用已存 Key'
  )

  // 跨主机：已存 Key 不得外发
  await manager.queryExternalProfiles({
    baseUrl: '127.0.0.1:9301',
    id: saved.id,
    profilesPath: 'http://192.168.1.9:9000/voices'
  })
  assertEq(calls[2].url, 'http://192.168.1.9:9000/voices', '跨主机打完整 URL')
  assertEq(calls[2].headers.Authorization, undefined, '跨主机查询剥离 Key')

  // 安全护栏：改了服务地址（即使查询地址留空、同主机判定为不跨域）也不得复用旧 Key，
  // 否则删掉 manager 的 baseUrl 比较就会把凭据发到新主机
  await manager.queryExternalProfiles({ baseUrl: '127.0.0.1:9302', id: saved.id })
  assertEq(calls[3].url, 'http://127.0.0.1:9302/profiles', '改地址后打新主机默认 /profiles')
  assertEq(calls[3].headers.Authorization, undefined, '改地址后草稿查询不复用旧 Key')

  let badCode = ''
  try {
    await manager.queryExternalProfiles({ baseUrl: 'ftp://example.com' })
  } catch (error) {
    badCode = error.code
  }
  assertEq(badCode, VOICE_ERROR_CODES.INVALID_INPUT, '非 http(s) 地址拒绝')
  return '草稿查询不落盘、Key 复用/剥离与非法地址拒绝正确'
})

await recorder.check('E13', 'local-tts-bridge 脚本：OpenAI 优先、404 回落原生、失败非零退出', async () => {
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const scriptPath = join(repoRoot, 'resources', 'voice', 'local-tts-bridge.mjs')
  const settingsFile = join(runDir, 'local-bridge-settings.json')

  function wavBytes(dataSize = 20) {
    const wav = Buffer.alloc(44 + dataSize)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8, 'ascii')
    wav.write('fmt ', 12, 'ascii')
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36, 'ascii')
    wav.writeUInt32LE(dataSize, 40)
    for (let i = 0; i < dataSize; i += 1) wav[44 + i] = i % 256
    return wav
  }
  // ID3 头 + 一帧 MPEG 同步头，过脚本的 isMp3 校验即可
  const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64])

  const requests = []
  let mode = 'openai'
  const server = await new Promise((resolve) => {
    const created = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        let openAiRaw = ''
        req.on('data', (chunk) => {
          openAiRaw += chunk
        })
        req.on('end', () => {
          requests.push({
            path: req.url,
            auth: req.headers.authorization || null,
            body: JSON.parse(openAiRaw)
          })
          if (mode === 'openai') {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
            res.end(mp3Bytes)
            return
          }
          res.writeHead(404)
          res.end('not found')
        })
        return
      }
      if (req.method === 'GET' && req.url === '/profiles') {
        requests.push({ path: req.url, auth: req.headers.authorization || null })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify([
            {
              id: 'p-1',
              name: '测试克隆1',
              voice_type: 'cloned',
              language: 'zh',
              default_engine: 'qwen',
              sample_count: 1
            }
          ])
        )
        return
      }
      if (req.method === 'POST' && req.url === '/generate/stream') {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
        })
        req.on('end', () => {
          requests.push({
            path: req.url,
            body: JSON.parse(raw),
            auth: req.headers.authorization || null
          })
          if (mode === 'fail') {
            res.writeHead(500)
            res.end('boom')
            return
          }
          res.writeHead(200, { 'Content-Type': 'audio/wav' })
          res.end(wavBytes())
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    created.listen(0, '127.0.0.1', () => resolve(created))
  })
  const port = server.address().port
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      voice: 'p-1',
      model: 'tts-2',
      responseFormat: 'mp3',
      profilesPath: ''
    })
  )

  function runBridge(text) {
    return new Promise((resolve) => {
      const out = join(runDir, `bridge-out-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
      const child = spawn(process.execPath, [scriptPath, text, out], {
        env: {
          ...process.env,
          UMI_LOCAL_TTS_SETTINGS_FILE: settingsFile,
          UMI_LOCAL_TTS_API_KEY: 'local-key-123456'
        }
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      // spawn 级失败（脚本路径错等）也要落成失败结论，不能让验收进程直接崩
      child.on('error', (error) => resolve({ code: -1, out, stderr: String(error), exists: false, bytes: null }))
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ code: -2, out, stderr: stderr + '\n[test] bridge 超时被杀', exists: existsSync(out), bytes: null })
      }, 30000)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, out, stderr, exists: existsSync(out), bytes: existsSync(out) ? readFileSync(out) : null })
      })
    })
  }

  try {
    // ① OpenAI 兼容面可用：直接打 /v1/audio/speech，带实例 Key，不查 profiles
    const openAi = await runBridge('你好，OpenAI 面。')
    assertEq(openAi.code, 0, 'OpenAI 面成功退出')
    assert(openAi.exists, '产出音频文件')
    assert(openAi.bytes.equals(mp3Bytes), '音频字节原样落盘')
    assertEq(requests[0].path, '/v1/audio/speech', '先打 OpenAI 兼容面')
    assertEq(requests[0].auth, 'Bearer local-key-123456', '携带实例 Key')
    assertEq(requests[0].body.model, 'tts-2', 'OpenAI 面请求带 model')
    assertEq(requests[0].body.input, '你好，OpenAI 面。', 'OpenAI 面请求带 input')
    assertEq(requests[0].body.voice, 'p-1', 'OpenAI 面请求带 voice')
    assertEq(requests[0].body.response_format, 'mp3', 'OpenAI 面请求带 response_format')
    assertEq(
      requests.some((item) => item.path === '/profiles'),
      false,
      'OpenAI 面可用时不得查询音色列表'
    )

    // ② OpenAI 面 404：回落 Voicebox 原生 profiles + generate/stream，引擎按克隆音色派生
    mode = 'native'
    const native = await runBridge('你好，原生面。')
    assertEq(native.code, 0, '原生面成功退出')
    assert(native.bytes.subarray(0, 4).toString('ascii') === 'RIFF', '原生面产出 WAV')
    const profileCall = requests.find((item) => item.path === '/profiles')
    const generateCall = requests.find((item) => item.path === '/generate/stream')
    assert(profileCall, '回落时先查音色列表')
    assertEq(profileCall.auth, 'Bearer local-key-123456', '音色查询同样带 Key')
    assert(generateCall, '调用原生合成接口')
    // 与宿主 openaiSpeech.synthesizeVoicebox 同契约：原生 /generate/stream 不带 Authorization
    assertEq(generateCall.auth, null, '原生合成接口不携带 Key')
    assertEq(generateCall.body.profile_id, 'p-1', 'profile_id 取选中音色')
    assertEq(generateCall.body.engine, 'qwen', '克隆音色引擎为 qwen')
    assertEq(generateCall.body.model_size, '1.7B', '克隆音色带 1.7B model_size')

    // ③ 两条路都失败：非零退出，交给 OpenClaw 候选链保底，不产空文件
    mode = 'fail'
    const failed = await runBridge('注定失败。')
    assert(failed.code !== 0, `失败必须非零退出（实际 ${failed.code}）`)
    assertEq(failed.exists, false, '失败不产出音频文件')

    // ④ 长文本分段：两段 WAV 重建容器头，data 长度为两段之和
    mode = 'native'
    const longText = '语'.repeat(450)
    const generateBefore = requests.filter((item) => item.path === '/generate/stream').length
    const joined = await runBridge(longText)
    assertEq(joined.code, 0, '长文本合成成功')
    const generateDelta =
      requests.filter((item) => item.path === '/generate/stream').length - generateBefore
    // 差值计数：只看本次运行，避免被前面阶段的累计调用污染（450 字按 400 上限切两段）
    assertEq(generateDelta, 2, `长文本本次分段恰好两次（实际 ${generateDelta}）`)
    assertEq(joined.bytes.subarray(0, 4).toString('ascii'), 'RIFF', '拼接结果仍是 WAV')
    assertEq(joined.bytes.readUInt32LE(40), 40, 'data 块大小=两段之和（20+20）')
    assertEq(joined.bytes.readUInt32LE(4), joined.bytes.length - 8, 'RIFF 尺寸已重算')
    return 'OpenAI 优先/原生回落/失败退出/长文本 WAV 拼接 均正确'
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await recorder.check('E14', 'local-tts-bridge 补充：405 回落、跨主机剥 Key、子路径保留、MP3 多段与 fmt 守卫', async () => {
  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const scriptPath = join(repoRoot, 'resources', 'voice', 'local-tts-bridge.mjs')
  const settingsFile = join(runDir, 'local-bridge-settings-e14.json')

  function wavBytes(dataSize, sampleRate) {
    const wav = Buffer.alloc(44 + dataSize)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8, 'ascii')
    wav.write('fmt ', 12, 'ascii')
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(sampleRate, 24)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36, 'ascii')
    wav.writeUInt32LE(dataSize, 40)
    return wav
  }
  const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64])

  const seen = { openai: [], profiles: [], generate: [] }
  let openaiStatus = 404
  let generateKind = 'wav'
  let generateCalls = 0
  const handler = (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      seen.openai.push({ auth: req.headers.authorization || null })
      res.writeHead(openaiStatus)
      res.end('x')
      return
    }
    if (req.method === 'GET' && (req.url === '/profiles' || req.url === '/v2/voices')) {
      seen.profiles.push({ url: req.url, auth: req.headers.authorization || null })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            id: 'p-9',
            name: '预设音色',
            voice_type: 'preset',
            language: 'zh',
            preset_engine: 'qwen_custom_voice',
            sample_count: 0
          }
        ])
      )
      return
    }
    if (req.method === 'POST' && req.url === '/generate/stream') {
      req.on('data', () => undefined)
      req.on('end', () => {
        generateCalls += 1
        seen.generate.push({ auth: req.headers.authorization || null, n: generateCalls })
        if (generateKind === 'mp3') {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
          res.end(mp3Bytes)
          return
        }
        if (generateKind === 'mixed') {
          res.writeHead(200, { 'Content-Type': 'audio/wav' })
          res.end(wavBytes(20, generateCalls % 2 ? 16000 : 8000))
          return
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(wavBytes(20, 16000))
      })
      return
    }
    res.writeHead(404)
    res.end()
  }
  const main = await new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const cross = await new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const port = main.address().port
  const crossPort = cross.address().port

  function writeSettings(extra) {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        version: 1,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        voice: 'p-9',
        model: 'tts-1',
        responseFormat: 'wav',
        profilesPath: '',
        ...extra
      })
    )
  }
  function runBridge(text) {
    return new Promise((resolve) => {
      const out = join(runDir, `bridge-e14-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
      const child = spawn(process.execPath, [scriptPath, text, out], {
        env: {
          ...process.env,
          UMI_LOCAL_TTS_SETTINGS_FILE: settingsFile,
          UMI_LOCAL_TTS_API_KEY: 'local-key-123456'
        }
      })
      child.on('error', (error) =>
        resolve({ code: -1, exists: false, bytes: null, stderr: String(error) })
      )
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ code: -2, exists: existsSync(out), bytes: null, stderr: 'timeout' })
      }, 30000)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          code,
          exists: existsSync(out),
          bytes: existsSync(out) ? readFileSync(out) : null
        })
      })
    })
  }

  try {
    // ① OpenAI 面 405（而非 404）同样回落原生面
    openaiStatus = 405
    writeSettings({})
    const r405 = await runBridge('405 回落。')
    assertEq(r405.code, 0, '405 后回落原生面成功')
    assertEq(r405.bytes.subarray(0, 4).toString('ascii'), 'RIFF', '原生面产出 WAV')
    assert(seen.profiles.length >= 1, '405 触发了音色查询')

    // ② 跨主机完整 URL：profiles 打到另一端口且剥离实例 Key
    openaiStatus = 404
    const beforeCross = seen.profiles.length
    writeSettings({ profilesPath: `http://127.0.0.1:${crossPort}/v2/voices` })
    const crossRun = await runBridge('跨主机查询。')
    assertEq(crossRun.code, 0, '跨主机查询链路成功')
    const crossCalls = seen.profiles.slice(beforeCross)
    assertEq(crossCalls.length, 1, '跨主机只发一次音色查询')
    assertEq(crossCalls[0].url, '/v2/voices', '查询打到跨主机地址')
    assertEq(crossCalls[0].auth, null, '跨主机音色查询不带 Key')

    // ③ 同主机绝对路径：拼在实例根后（保留路径）且带 Key
    const beforeSame = seen.profiles.length
    writeSettings({ profilesPath: '/v2/voices' })
    const sameRun = await runBridge('同主机子路径。')
    assertEq(sameRun.code, 0, '同主机子路径链路成功')
    const sameCalls = seen.profiles.slice(beforeSame)
    assertEq(sameCalls[0].url, '/v2/voices', '绝对路径拼在实例根后')
    assertEq(sameCalls[0].auth, 'Bearer local-key-123456', '同主机查询带 Key')

    // ④ MP3 长文本两段：帧结构裸拼，长度翻倍且仍是 ID3 头
    generateKind = 'mp3'
    writeSettings({ responseFormat: 'mp3', profilesPath: '' })
    const mp3Join = await runBridge('语'.repeat(450))
    assertEq(mp3Join.code, 0, 'MP3 多段合成成功')
    assertEq(mp3Join.bytes.length, mp3Bytes.length * 2, '两段 MP3 裸拼长度翻倍')
    assertEq(mp3Join.bytes.subarray(0, 3).toString('ascii'), 'ID3', 'MP3 头保留')

    // ⑤ 各段 fmt 不一致：拒绝拼接，非零退出且不产文件
    generateKind = 'mixed'
    writeSettings({ responseFormat: 'wav' })
    const mixed = await runBridge('语'.repeat(450))
    assert(mixed.code !== 0, `fmt 不一致必须非零退出（实际 ${mixed.code}）`)
    assertEq(mixed.exists, false, 'fmt 不一致不产出坏文件')
    return '405 回落/跨主机剥 Key/子路径/MP3 拼接/fmt 守卫 均正确'
  } finally {
    await new Promise((resolve) => main.close(() => resolve()))
    await new Promise((resolve) => cross.close(() => resolve()))
  }
})

await recorder.check('E15', '对话通道自检信封/保底武装文案，删除实例后通道下线并触发配置重写', async () => {
  const servicesPath = join(runDir, 'selftest-services.json')
  const secretsPath = join(runDir, 'selftest-secrets.bin')
  const store = createExternalServiceStore(servicesPath)
  const extSecrets = createExternalVoiceSecretStore(secretsPath, fakeEncryption())
  const service = await store.save({
    label: '自检实例',
    baseUrl: 'http://127.0.0.1:8095/v1',
    model: 'qwen3-tts',
    voice: 'Chelsie',
    responseFormat: 'mp3'
  })
  await extSecrets.set(service.id, 'external-key-12345678')

  let externalFail = false
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/audio/speech')) {
      if (externalFail) return new Response('boom', { status: 500 })
      return externalAudio()
    }
    return ttsResponse()
  }
  const localHot = join(runDir, 'selftest-local.json')
  let notifyCount = 0
  const manager = createVoiceManager({
    storage: memoryStore(),
    secrets: cloudSecrets(),
    externalServices: store,
    externalSecrets: extSecrets,
    cacheDir: join(runDir, 'selftest-audio'),
    localBridgeScriptPath: 'local-tts-bridge.mjs',
    localBridgeSettingsPath: localHot,
    bridgeScriptPath: 'volc-tts.mjs',
    bridgeSettingsPath: join(runDir, 'selftest-bridge.json'),
    fetchImpl,
    onSettingsChanged: () => {
      notifyCount += 1
    },
    logger: () => undefined
  })
  await manager.updateSettings({
    conversationTts: 'always',
    conversationChannel: 'local-external',
    conversationFallback: 'volcengine',
    externalProviderId: service.id
  })
  await waitFor(() => existsSync(localHot), { label: '自检 manager 本地热更文件落盘' })

  // 先测失败信封：缓存还没命中，外部 500 必须落成 ok:false 而不是抛异常
  externalFail = true
  const bad = await manager.testOpenClawChannel()
  assertEq(bad.ok, false, '本地实例失败时自检返回失败信封')
  assertEq(bad.channel, 'local-external', '失败信封仍带通道标签')
  externalFail = false

  // clone Key 在位：保底武装，文案承诺候选链降级
  const okResult = await manager.testOpenClawChannel()
  assertEq(okResult.ok, true, '本地实例自检成功')
  assertEq(okResult.channel, 'local-external', '成功信封带通道标签')
  assert(/候选链降级火山标准接口/.test(okResult.message), '保底武装时承诺降级')
  assert(okResult.audio, '成功带回试听音频')

  // 清掉 clone Key：本地仍可用，但文案不得再承诺保底
  await manager.clearKey('clone')
  const noFallback = await manager.testOpenClawChannel()
  assertEq(noFallback.ok, true, '无 clone Key 本地实例仍可用')
  assert(/保底不会生效/.test(noFallback.message), '无 clone Key 如实提示保底未武装')

  // fail 档：文案切换为不降级
  await manager.setKey('clone', 'clone-key-12345678')
  await manager.updateSettings({ conversationFallback: 'fail' })
  const failMode = await manager.testOpenClawChannel()
  assert(/未开启保底，失败将直接报错/.test(failMode.message), 'fail 档文案正确')

  // 删除当前实例：通道收回 auto、选择清空、同步块脱离本地 CLI、热更文件清理、通知型重写触发
  const beforeRemove = notifyCount
  await manager.removeExternalService(service.id)
  const after = await manager.getSettings()
  assertEq(after.conversationChannel, 'auto', '删除实例后对话通道收回 auto')
  assertEq(after.externalProviderId, '', '删除实例后清空实例选择')
  const status = await manager.getOpenClawStatus()
  assert(
    status.effective === 'volcengine' || status.effective === 'bridge',
    '删除后 auto 在火山候选里选路'
  )
  assert(
    manager.buildOpenClawTtsConfigSync().provider !== 'tts-local-cli',
    '同步块不再走本地 CLI'
  )
  await waitFor(() => !existsSync(localHot), { label: '删除实例后本地热更文件被清' })
  assert(notifyCount > beforeRemove, '删除触发通知型刷新（重写 openclaw.json 摘掉陈旧块）')
  return '自检信封/保底文案/删除下线收口 均正确'
})

const result = recorder.toJSON({ runDir })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-external-tts.json'), result)
if (!ok) process.exit(1)
