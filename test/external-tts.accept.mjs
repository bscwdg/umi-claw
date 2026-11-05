// test/external-tts.accept.mjs —— 外部 OpenAI Audio Speech 接入与云端回落
//
// 纯 Node 验收，不连真实 TTS：
//   - 外部实例 JSON 与独立加密 Key
//   - URL 归一化 / 请求体 / Bearer / 音频响应 / 错误码
//   - external 路由、缓存、失败冷却、auto 回落火山云

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const { normalizeExternalBaseUrl, createOpenAISpeechProvider } = speechMod

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

await recorder.check('E1', '设置默认 cloud；外部实例 ID 白名单清洗', async () => {
  const normalized = normalizeVoiceSettings({}, catalog)
  assertEq(normalized.speakRoute, 'cloud', '默认朗读路由')
  assertEq(normalized.externalProviderId, '', '默认不选外部实例')
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
  assertEq(noModelsProbe.ok, false, '/models 204 不误报成功')
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
  assertEq(badJsonProbe.ok, false, '/models 坏 JSON 不误报成功')
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
    label: '外部实例',
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
      assertEq(init.headers.Authorization, 'Bearer external-key-12345678', '外部 Key')
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
  const first = await manager.speak({ text: '外部测试。' })
  const second = await manager.speak({ text: '外部测试。' })
  assertEq(first.engine, 'external', 'external engine')
  assertEq(first.route, 'external', 'external route')
  assertEq(first.providerId, service.id, 'provider id')
  assertEq(second.cached, true, '外部音频缓存命中')
  assertEq(externalCalls, 1, '第二次不请求外部')
  assertEq(cloudCalls, 0, '外部模式不请求云端')

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
  assertEq(fallback.fallback.reason, '外部 TTS 正在失败冷却', '回落原因可见')
  assertEq(externalCalls, 3, '两次失败后第三次不再打外部')
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
  assertEq(externalCalls, 3, '显式 external 冷却期不再打外部')
  assertEq(cloudCalls, 3, '显式 external 不偷偷回落云端')

  failExternal = false
  const retry = await manager.testExternalService(service.id)
  assertEq(retry.audio.engine, 'external', '冷却后试听可真实恢复')
  assertEq(externalCalls, 4, '冷却后试听绕过冷却并真实请求外部')
  return 'external / auto 路由、缓存与冷却正确'
})

await recorder.check('E5', '外部实例 CRUD 通过 Manager，删除时清理 Key', async () => {
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

await recorder.check('E6', '语音页已接入外部实例管理、测试连接与试听入口', async () => {
  const vue = readFileSync(
    join(repoRoot, 'src/views/voice/VoicePage.vue'),
    'utf8'
  )
  assert(vue.includes('应用内朗读路由'), '路由控件')
  assert(vue.includes('外部 TTS 服务'), '外部服务卡片')
  assert(vue.includes('api.external.save'), '保存调用')
  assert(vue.includes('api.external.probe'), '测试连接调用')
  assert(vue.includes('api.external.test'), '试听调用')
  assert(vue.includes('api.external.remove'), '删除调用')
  return 'VoicePage 外部实例操作入口已装配'
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
  assertEq(pcm.engine, 'external', 'PCM 仍走外部实例')
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

const result = recorder.toJSON({ runDir })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-external-tts.json'), result)
if (!ok) process.exit(1)
