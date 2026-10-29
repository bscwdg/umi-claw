// test/voice.accept.mjs —— 鱼语音第一期：目录 / Key / 预设 TTS / 缓存 / 预算
//
// 纯 Node 验收，不连真实供应商：
//   - 打真源码 VoiceManager + VolcengineTtsProvider
//   - 假 fetch 验证两种 endpoint / resource 分流
//   - 验证单段 mp3、长文本 PCM→WAV、缓存命中和预算拒绝
//
// 用法：node test/voice.accept.mjs（npm run accept:voice）

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  tmpDir
} from './_lib.mjs'

const runDir = join(tmpDir, `voice-${Date.now()}`)
const cacheDir = join(runDir, 'audio')
mkdirSync(runDir, { recursive: true })

const managerBundle = bundleEntry(
  'electron/main/fish/voice/core/manager.ts',
  'voice-manager.mjs'
)
const errorsBundle = bundleEntry('electron/main/fish/voice/core/errors.ts', 'voice-errors.mjs')
const cloneBundle = bundleEntry(
  'electron/main/fish/voice/core/cloneManager.ts',
  'voice-clone-manager.mjs'
)
const managerMod = await import(pathToFileURL(managerBundle).href)
const cloneMod = await import(pathToFileURL(cloneBundle).href)
const { createVoiceManager } = managerMod
const { VoiceCloneManager } = cloneMod
const { VOICE_ERROR_CODES } = await import(pathToFileURL(errorsBundle).href)

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

function secretStore(keys = {}) {
  const state = {
    tts: keys.tts ?? null,
    clone: keys.clone ?? null
  }
  return {
    state,
    async get(kind) {
      return state[kind] ?? null
    },
    async set(kind, value) {
      state[kind] = value.trim()
      return { hasKey: true, tail: `****${state[kind].slice(-4)}` }
    },
    async clear(kind) {
      state[kind] = null
      return { hasKey: false, tail: null }
    },
    async status() {
      return {
        encryptionAvailable: true,
        tts: state.tts
          ? { hasKey: true, tail: `****${state.tts.slice(-4)}` }
          : { hasKey: false, tail: null },
        clone: state.clone
          ? { hasKey: true, tail: `****${state.clone.slice(-4)}` }
          : { hasKey: false, tail: null }
      }
    }
  }
}

function responseFromLines(lines) {
  const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  const bytes = new TextEncoder().encode(payload)
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
  return new Response(body, {
    status: 200,
    headers: { 'x-tt-logid': 'voice-test-log' }
  })
}

function ttsResponse({ format = 'mp3', byte = 65 } = {}) {
  return responseFromLines([
    {
      code: 0,
      message: '',
      data: Buffer.from(Buffer.from([byte, byte + 1, byte + 2, byte + 3])).toString('base64')
    },
    {
      code: 20000000,
      message: 'OK',
      usage: { text_words: format === 'pcm' ? 2 : 4 }
    }
  ])
}

function makeManager({
  fetchImpl,
  keys = { tts: 'tts-key-12345678', clone: 'clone-key-12345678' },
  now = () => new Date('2026-10-29T10:00:00+08:00').getTime()
} = {}) {
  return createVoiceManager({
    storage: memoryStore(),
    secrets: secretStore(keys),
    cacheDir,
    now,
    fetchImpl,
    logger: () => undefined
  })
}

const recorder = new Recorder('voice')

await recorder.check('V1', '默认设置、全量目录、Key 状态可用', async () => {
  const manager = makeManager({ fetchImpl: async () => ttsResponse() })
  const settings = await manager.getSettings()
  const catalog = manager.getCatalog()
  assertEq(settings.defaultSpeaker, 'zh_female_vv_uranus_bigtts', '默认音色')
  assertEq(settings.autoSpeak, 'off', '自动朗读默认关')
  assertEq(settings.hasTtsKey, true, 'TTS Key 状态')
  assertEq(settings.hasCloneKey, true, '语音服务 Key 状态')
  assert(catalog.voices.length >= 100, `音色目录不少于 100（实际 ${catalog.voices.length}）`)
  assert(catalog.voices.some((voice) => voice.isDefault), '存在默认音色')
  assert(
    catalog.voices.every((voice) => voice.voiceType && voice.name),
    '精选音色字段完整'
  )
  return '10 个精选音色、两把 Key 状态正常'
})

await recorder.check('V2', '预设 TTS 走 plan endpoint / seed-tts-2.0，并缓存命中', async () => {
  const calls = []
  const manager = makeManager({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return ttsResponse({ byte: 70 })
    }
  })
  const first = await manager.speak({ text: '你好，测试一下。' })
  const second = await manager.speak({ text: '你好，测试一下。' })
  const audio = await manager.readAudio(first.audioId)
  assertEq(calls.length, 1, '第二次命中缓存')
  assertEq(calls[0].url, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', 'plan URL')
  assertEq(calls[0].body.req_params.speaker, 'zh_female_vv_uranus_bigtts', '默认 speaker')
  assertEq(calls[0].body.req_params.audio_params.format, 'mp3', '单段 mp3')
  assertEq(first.cached, false, '首次未命中')
  assertEq(second.cached, true, '第二次命中')
  assertEq(first.route, 'preset', '预设路由')
  assertEq(audio.mime, 'audio/mpeg', 'mp3 mime')
  assert(audio.bytes.length > 0, '音频可读')
  return 'plan 路由、缓存和音频读取正常'
})

await recorder.check('V3', '克隆音色走 /api/v3/tts/unidirectional + seed-icl-2.0', async () => {
  const calls = []
  const manager = makeManager({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
      return ttsResponse({ byte: 80 })
    }
  })
  const result = await manager.speak({
    text: '这是克隆音色测试。',
    options: { speaker: 'umi_voice_abc123' }
  })
  assertEq(result.route, 'cloned', '克隆路由')
  assertEq(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', '克隆 URL')
  assertEq(calls[0].headers['X-Api-Resource-Id'], 'seed-icl-2.0', '克隆 resource')
  assertEq(calls[0].headers['X-Api-Key'], 'clone-key-12345678', '使用语音服务 Key')
  return '克隆音色 endpoint / Key / resource 分流正确'
})

await recorder.check('V4', '长文本分段后使用 PCM 拼接并生成 WAV', async () => {
  const calls = []
  const manager = makeManager({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url: String(url), format: body.req_params.audio_params.format, text: body.req_params.text })
      return ttsResponse({ format: body.req_params.audio_params.format, byte: 90 })
    }
  })
  const text = '这是一段用于测试长文本切分和音频拼接的文字。'.repeat(20)
  const result = await manager.speak({ text })
  const audio = await manager.readAudio(result.audioId)
  assert(calls.length >= 2, '长文本被切成多段')
  assert(calls.every((call) => call.format === 'pcm'), '长文本全部请求 PCM')
  assertEq(audio.mime, 'audio/wav', '输出 WAV')
  assertEq(Buffer.from(audio.bytes.subarray(0, 4)).toString('ascii'), 'RIFF', 'WAV 头')
  assert(result.audioId.endsWith('.wav'), '缓存扩展名')
  return `${calls.length} 段 PCM → 单个 WAV`
})

await recorder.check('V5', '预算超限在主进程拒绝，不调用供应商', async () => {
  let calls = 0
  const manager = makeManager({
    fetchImpl: async () => {
      calls += 1
      return ttsResponse()
    }
  })
  await manager.updateSettings({ dailyCharLimit: 3 })
  const usage = await manager.getBudget()
  await manager.updateSettings({ dailyCharLimit: usage.chars + 3 })
  let code = ''
  try {
    await manager.speak({ text: '这段文字肯定超过预算' })
  } catch (error) {
    code = error.code
  }
  assertEq(code, VOICE_ERROR_CODES.BUDGET_EXCEEDED, '预算错误码')
  assertEq(calls, 0, '超预算不发请求')
  return '预算拒绝发生在 HTTP 之前'
})

await recorder.check('V6', '缺 Key、非法音频 ID 与克隆鉴权测试', async () => {
  const manager = makeManager({
    keys: { tts: null, clone: 'clone-key-12345678' },
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 45001107, message: 'SpeakerID未找到' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  })
  let keyCode = ''
  try {
    await manager.speak({ text: '缺 key' })
  } catch (error) {
    keyCode = error.code
  }
  assertEq(keyCode, VOICE_ERROR_CODES.KEY_REQUIRED, '缺 TTS Key')
  let audioCode = ''
  try {
    await manager.readAudio('../../etc/passwd')
  } catch (error) {
    audioCode = error.code
  }
  assertEq(audioCode, VOICE_ERROR_CODES.NOT_FOUND, '非法 audioId 不越界')
  const tested = await manager.test('clone')
  assertEq(tested.ok, true, '语音服务鉴权通过')
  return 'Key 闸门、audioId 白名单和 clone 鉴权正常'
})

await recorder.check('V7', '文本清洗与分段边界', async () => {
  const manager = makeManager({ fetchImpl: async () => ttsResponse() })
  const text = '😀 你好  世界。'
  const result = await manager.speak({ text })
  assertEq(result.chars, 6, 'emoji 移除、空白压缩后 6 字')
  return 'emoji/多空白已清洗'
})

await recorder.check('V8', '克隆训练、试听下载、转正闸门、删除全链路', async () => {
  const storage = memoryStore()
  const secrets = secretStore({ tts: 'tts-key-12345678', clone: 'clone-key-12345678' })
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('/voice_clone')) {
      assertEq(init.method, 'POST', 'train method')
      const body = JSON.parse(init.body)
      assertEq(body.speaker_id, 'custom_speaker_id', '后付费固定 speaker_id')
      assert(/^umi_voice_/.test(body.custom_speaker_id), '自定义 speaker id')
      assert(body.audio.data.length > 10, 'base64 样本')
      return new Response(JSON.stringify({ code: 0, status: 1, available_training_times: 15 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    if (u.endsWith('/get_voice')) {
      return new Response(
        JSON.stringify({
          code: 0,
          status: 2,
          speaker_status: [
            { model_type: 4, demo_audio: 'https://demo.local/m4.wav' },
            { model_type: 5, demo_audio: 'https://demo.local/m5.wav' }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (u.startsWith('https://demo.local/')) {
      const wav = Buffer.alloc(44)
      wav.write('RIFF', 0, 'ascii')
      wav.write('WAVE', 8, 'ascii')
      return new Response(wav, {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' }
      })
    }
    if (u.endsWith('/api/v3/tts/unidirectional')) {
      return ttsResponse({ byte: 77 })
    }
    throw new Error(`unexpected URL ${u}`)
  }

  const voiceManager = createVoiceManager({
    storage,
    secrets,
    cacheDir: join(runDir, 'clone-audio'),
    fetchImpl,
    logger: () => undefined
  })
  const cloneManager = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'voices'),
    voiceManager,
    fetchImpl,
    logger: () => undefined,
    pollIntervalMs: 60_000
  })
  const samplePath = join(runDir, 'sample.wav')
  const wav = Buffer.alloc(1024)
  wav.write('RIFF', 0, 'ascii')
  wav.write('WAVE', 8, 'ascii')
  writeFileSync(samplePath, wav)
  const sample = await cloneManager.registerSample(samplePath)
  const validation = await cloneManager.validate(sample.token)
  assertEq(validation.ok, true, '样本预检')
  const trained = await cloneManager.train({
    token: sample.token,
    consent: true,
    displayName: '验收音色',
    language: 0
  })
  assertEq(trained.status, 'training', '训练中')
  assertEq(trained.consentAt > 0, true, '授权时间记录')
  const ready = await cloneManager.refresh(trained.speakerId)
  assertEq(ready.status, 'success', '训练成功')
  assertEq(ready.demos.length, 2, '下载两个 ICL 2.0 试听')
  const demo = await cloneManager.readDemo(ready.speakerId, 5)
  assertEq(demo.mime, 'audio/wav', '试听 mime')
  assert(demo.bytes.length > 0, '试听可读')

  let gateCode = ''
  try {
    await voiceManager.speak({
      text: '未转正前不能直接合成',
      options: { speaker: ready.speakerId }
    })
  } catch (error) {
    gateCode = error.code
  }
  assertEq(gateCode, VOICE_ERROR_CODES.CLONE_FAILED, '首次合成闸门')

  let confirmCode = ''
  try {
    await cloneManager.activate({
      speakerId: ready.speakerId,
      confirmSlotFee: false
    })
  } catch (error) {
    confirmCode = error.code
  }
  assertEq(confirmCode, VOICE_ERROR_CODES.INVALID_INPUT, '必须确认槽位费')

  const activated = await cloneManager.activate({
    speakerId: ready.speakerId,
    confirmSlotFee: true,
    text: '正式启用测试。'
  })
  assertEq(activated.route, 'cloned', '转正使用克隆路由')
  const after = await cloneManager.list()
  assertEq(after[0].activated, true, '转正状态落库')
  assertEq(after[0].status, 'active', '已启用状态')

  await voiceManager.speak({
    text: '转正后可以正常朗读。',
    options: { speaker: ready.speakerId }
  })
  const removed = await cloneManager.remove(ready.speakerId)
  assertEq(removed.remoteDelete, 'unsupported', '远端删除明确不支持')
  assertEq((await cloneManager.list()).length, 0, '本地记录删除')
  return `${calls.length} 次供应商调用，训练→试听→转正→删除闭环通过`
})

const ok = printResult(recorder.toJSON({ cacheDir, catalog: join(repoRoot, 'resources/voice/curated-voices.v1.json') }))
if (!ok) process.exit(1)
