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
const settingsBundle = bundleEntry(
  'electron/main/fish/voice/core/settings.ts',
  'voice-settings.mjs'
)
const languageBundle = bundleEntry(
  'electron/main/fish/voice/core/cloneLanguage.ts',
  'voice-clone-language.mjs'
)
const openclawTtsBundle = bundleEntry(
  'electron/main/fish/voice/core/openclawTts.ts',
  'voice-openclaw-tts.mjs'
)
const emotionBundle = bundleEntry(
  'electron/main/fish/voice/core/emotionOptions.ts',
  'voice-emotion.mjs'
)
const managerMod = await import(pathToFileURL(managerBundle).href)
const cloneMod = await import(pathToFileURL(cloneBundle).href)
const { createVoiceManager } = managerMod
const { VoiceCloneManager } = cloneMod
const { VOICE_ERROR_CODES } = await import(pathToFileURL(errorsBundle).href)
const settingsMod = await import(pathToFileURL(settingsBundle).href)
const languageMod = await import(pathToFileURL(languageBundle).href)
const openclawTtsMod = await import(pathToFileURL(openclawTtsBundle).href)
const emotionMod = await import(pathToFileURL(emotionBundle).href)

const FIXED_NOW = new Date('2026-10-29T10:00:00+08:00').getTime()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** 把已有记录改回 training，模拟「上次训练没跑完就退出」的遗留状态。 */
function getTrainingRecords(records) {
  return records.map((record) => ({
    ...record,
    status: 'training',
    remoteStatus: 1,
    demos: [],
    modelTypes: [],
    activated: false,
    activatedAt: null,
    expiresAt: FIXED_NOW + 7 * 24 * 3600 * 1000
  }))
}

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

await recorder.check('V9', 'endpoint/resource 只放开到官方域名 + /api/v3/，非法值直接拒绝', async () => {
  const manager = makeManager({ fetchImpl: async () => ttsResponse() })
  const catalog = manager.getCatalog()
  const base = settingsMod.DEFAULT_VOICE_SETTINGS

  // 升级到未来 resource：合法，必须放行（不必等发版）
  const upgraded = settingsMod.applyVoiceSettingsPatch(
    base,
    { cloneResourceId: 'seed-icl-3.0' },
    catalog
  )
  assertEq(upgraded.cloneResourceId, 'seed-icl-3.0', '未来 resource 可写入')
  assertEq(upgraded.ttsResourceId, base.ttsResourceId, '未改的字段保持原值')

  const official = settingsMod.applyVoiceSettingsPatch(
    base,
    { ttsEndpoint: 'https://openspeech.bytedance.com/api/v3/plan/tts/bidirectional' },
    catalog
  )
  assertEq(
    official.ttsEndpoint,
    'https://openspeech.bytedance.com/api/v3/plan/tts/bidirectional',
    '官方域名的其他 v3 接口可切换'
  )

  // 这三类必须拒绝：换域名 = 把本地 Key 发到别处
  for (const [label, patch] of [
    ['外部域名', { ttsEndpoint: 'https://evil.example.com/api/v3/tts/unidirectional' }],
    ['非 https', { ttsEndpoint: 'http://openspeech.bytedance.com/api/v3/tts/unidirectional' }],
    ['非 v3 路径', { cloneEndpoint: 'https://openspeech.bytedance.com/v1/tts' }]
  ]) {
    let code = ''
    try {
      settingsMod.applyVoiceSettingsPatch(base, patch, catalog)
    } catch (error) {
      code = error.code
    }
    assertEq(code, VOICE_ERROR_CODES.INVALID_INPUT, `${label}必须拒绝`)
  }

  let resCode = ''
  try {
    settingsMod.applyVoiceSettingsPatch(base, { cloneResourceId: 'bad id' }, catalog)
  } catch (error) {
    resCode = error.code
  }
  assertEq(resCode, VOICE_ERROR_CODES.INVALID_INPUT, '非法 resource 必须拒绝')

  // 旧配置里的非法值要静默回落，不能让页面打不开
  const salvaged = settingsMod.normalizeVoiceSettings(
    { ttsEndpoint: 'https://evil.example.com/api', cloneResourceId: 'bad id' },
    catalog
  )
  assertEq(salvaged.ttsEndpoint, base.ttsEndpoint, '坏 endpoint 回落默认')
  assertEq(salvaged.cloneResourceId, base.cloneResourceId, '坏 resource 回落默认')
  return '官方域名可升级、换域名/非法值被拒、坏配置回落'
})

await recorder.check('V10', '语种放开到 0–21，demo_text 跟随语种', async () => {
  const { VOICE_CLONE_LANGUAGES, normalizeCloneLanguage, defaultDemoText } = languageMod
  assertEq(VOICE_CLONE_LANGUAGES.length, 21, '21 个可用语种')
  const values = VOICE_CLONE_LANGUAGES.map((item) => item.value)
  assertEq(values.includes(18), false, '官方未定义的 18 不提供')
  for (const mustHave of [9, 10, 11, 12, 21]) {
    assert(values.includes(mustHave), `语种 ${mustHave} 必须可选`)
  }
  assertEq(normalizeCloneLanguage(21), 21, '瑞典语保留')
  assertEq(normalizeCloneLanguage(18), 0, '未定义值回落中文')
  assertEq(normalizeCloneLanguage('x'), 0, '非法入参回落中文')

  // demo_text 必须与语种同语种，否则官方侧合成失败
  assertEq(defaultDemoText(0), '你好，我是你的语音助手。', '中文试听文本')
  assert(/^[\u0000-\u007f\s]+$/.test(defaultDemoText(1)), '英文试听文本为英文')
  assert(defaultDemoText(2) !== defaultDemoText(0), '日语试听文本不同于中文')
  assert(defaultDemoText(12).length > 0, '俄语有默认试听文本')
  return '21 语种、demo_text 按语种取默认值'
})

await recorder.check('V11', '训练后由主进程后台轮询推进，页面关掉也不停在训练中', async () => {
  const storage = memoryStore()
  const secrets = secretStore({ tts: 'tts-key-12345678', clone: 'clone-key-12345678' })
  const logs = []
  let statusCalls = 0
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.endsWith('/voice_clone')) {
      return new Response(JSON.stringify({ code: 0, status: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'x-tt-logid': 'LOG-TRAIN-1' }
      })
    }
    if (u.endsWith('/get_voice')) {
      statusCalls += 1
      return new Response(
        JSON.stringify({
          code: 0,
          status: 2,
          speaker_status: [{ model_type: 5, demo_audio: 'https://demo.local/v11.wav' }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'x-tt-logid': 'LOG-STATUS-1' } }
      )
    }
    if (u.startsWith('https://demo.local/')) {
      const wav = Buffer.alloc(44)
      wav.write('RIFF', 0, 'ascii')
      wav.write('WAVE', 8, 'ascii')
      return new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    throw new Error(`unexpected URL ${u}`)
  }

  const voiceManager = createVoiceManager({
    storage,
    secrets,
    cacheDir: join(runDir, 'v11-audio'),
    fetchImpl,
    logger: () => undefined
  })
  const cloneManager = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'v11-voices'),
    voiceManager,
    fetchImpl,
    logger: (message) => logs.push(message),
    pollIntervalMs: 20
  })

  const samplePath = join(runDir, 'v11.wav')
  const wav = Buffer.alloc(1024)
  wav.write('RIFF', 0, 'ascii')
  wav.write('WAVE', 8, 'ascii')
  writeFileSync(samplePath, wav)
  const sample = await cloneManager.registerSample(samplePath)
  const trained = await cloneManager.train({
    token: sample.token,
    consent: true,
    displayName: '后台轮询音色',
    language: 0
  })
  assertEq(trained.status, 'training', '训练提交后处于训练中')
  // 轮询是延迟调度的（pollIntervalMs），不是训练返回时同步查询一次，
  // 所以刚提交时不该有状态查询，等调度触发后才出现。
  assertEq(statusCalls, 0, '提交后先不查，避免阻塞训练响应')

  // 关键：不再手动 refresh，等主进程自己把状态推进一步
  await sleep(200)
  assert(statusCalls >= 1, '后台轮询已自行发起状态查询')
  const records = await cloneManager.list()
  assertEq(records[0].status, 'success', '后台轮询把状态推进到成功')
  assert(records[0].demos.length >= 1, '试听已由后台轮询落盘')
  assert(
    logs.some((line) => line.includes('LOG-STATUS-1')),
    'X-Tt-Logid 已写入脱敏日志'
  )

  // 启动恢复：新实例应能接管遗留的 training 记录
  await storage.set('voice:v1:clones', JSON.stringify(getTrainingRecords(records)))
  const revived = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'v11-voices'),
    voiceManager,
    fetchImpl,
    logger: () => undefined,
    pollIntervalMs: 20
  })
  const before = statusCalls
  const resumed = await revived.resumeTrainingPolls()
  assertEq(resumed, 1, '恢复 1 个遗留训练任务')
  await sleep(120)
  assert(statusCalls > before, '恢复后确实继续轮询')
  return `${statusCalls} 次状态查询，后台轮询 + 启动恢复均生效`
})

await recorder.check('V12', '试听不再写死 model_type 4/5，切到 1.0 资源也能拿到 demo', async () => {
  const storage = memoryStore()
  const secrets = secretStore({ tts: 'tts-key-12345678', clone: 'clone-key-12345678' })
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.endsWith('/get_voice')) {
      return new Response(
        JSON.stringify({
          code: 0,
          status: 2,
          // 声音复刻 1.0 的返回：model_type 1/2/3
          speaker_status: [
            { model_type: 1, demo_audio: 'https://demo.local/v12-1.wav' },
            { model_type: 2, demo_audio: 'https://demo.local/v12-2.wav' },
            { model_type: 3, demo_audio: 'https://demo.local/v12-3.wav' }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (u.startsWith('https://demo.local/')) {
      const wav = Buffer.alloc(44)
      wav.write('RIFF', 0, 'ascii')
      wav.write('WAVE', 8, 'ascii')
      return new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    throw new Error(`unexpected URL ${u}`)
  }

  const voiceManager = createVoiceManager({
    storage,
    secrets,
    cacheDir: join(runDir, 'v12-audio'),
    fetchImpl,
    logger: () => undefined
  })
  const cloneManager = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'v12-voices'),
    voiceManager,
    fetchImpl,
    logger: () => undefined,
    pollIntervalMs: 60_000
  })
  await storage.set(
    'voice:v1:clones',
    JSON.stringify([
      {
        speakerId: 'umi_voice_v12_0001',
        displayName: '1.0 音色',
        status: 'training',
        remoteStatus: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        consentAt: FIXED_NOW,
        sampleHash: 'hash',
        sampleFileName: 'v12.wav',
        language: 0,
        modelTypes: [],
        demos: [],
        activated: false,
        activatedAt: null,
        expiresAt: FIXED_NOW + 7 * 24 * 3600 * 1000,
        availableTrainingTimes: null,
        lastError: null
      }
    ])
  )
  const record = await cloneManager.refresh('umi_voice_v12_0001')
  assertEq(record.status, 'success', '1.0 状态映射正确')
  assertEq(record.demos.length, 3, '1/2/3 三个试听全部落盘（旧实现为 0）')
  assertEq(record.modelTypes.sort().join(','), '1,2,3', '模型版本记录完整')
  return '1.0 资源的 model_type 1/2/3 试听均可下载'
})

await recorder.check('V13', '应用内短提示三态：tagged 仅读被标记事件（旧实现与 always 同行为）', async () => {
  const { shouldSpeakInApp } = openclawTtsMod
  // 关闭
  assertEq(shouldSpeakInApp({ mode: 'off', taggedEligible: true }), false, '关闭时不读')
  // 仅标记事件：只有被标记的才读
  assertEq(shouldSpeakInApp({ mode: 'tagged', taggedEligible: true }), true, 'tagged 读被标记事件')
  assertEq(shouldSpeakInApp({ mode: 'tagged', taggedEligible: false }), false, 'tagged 不读例行通知')
  // 所有短提示：一律读
  assertEq(shouldSpeakInApp({ mode: 'always', taggedEligible: false }), true, 'always 照读')
  // inbound 是 OpenClaw 侧语义，应用内提醒不适用
  assertEq(shouldSpeakInApp({ mode: 'inbound', taggedEligible: true }), false, 'inbound 不触发应用内朗读')
  return 'tagged 与 always 已分开，三档语义各自生效'
})

await recorder.check('V14', '对话内语音走 OpenClaw tts 块：密钥绝不进配置文件', async () => {
  const { buildOpenClawTtsBlock, buildOpenClawTtsEnv } = openclawTtsMod
  const input = {
    conversationTts: 'always',
    resourceId: 'seed-tts-2.0',
    speakerVoice: 'zh_female_vv_uranus_bigtts'
  }
  const block = buildOpenClawTtsBlock(input)
  assertEq(block.auto, 'always', 'auto 透传')
  assertEq(block.provider, 'volcengine', 'provider 固定为火山')
  assertEq(block.providers.volcengine.resourceId, input.resourceId, 
    'resourceId 透传')
  assertEq(block.providers.volcengine.speakerVoice, input.speakerVoice, 
    '音色透传')
  // 关键：写进 openclaw.json 的对象里不能出现任何密钥字段
  const serialized = JSON.stringify(block)
  assertEq(/apiKey|api_key|secret|token/i.test(serialized), false, 'tts 块不含密钥字段')

  // 密钥走环境变量；关闭或没密钥时不注入
  assertEq(Object.keys(buildOpenClawTtsEnv(input, null)).length, 0, '没密钥不注入环境变量')
  const offInput = { ...input, conversationTts: 'off' }
  assertEq(Object.keys(buildOpenClawTtsEnv(offInput, 'k-12345678')).length, 0, '关闭时连密钥都不注入')
  const env = buildOpenClawTtsEnv(input, 'k-12345678')
  assertEq(env.VOLCENGINE_TTS_API_KEY, 'k-12345678', '密钥只出现在环境变量里')
  assertEq(env.VOLCENGINE_TTS_RESOURCE_ID, input.resourceId, 'resourceId 同注入')
  return 'tts 块非密、密钥仅走环境变量、关闭即整体下线'
})

await recorder.check('V15', '选路：预设音色走 seed-tts，克隆音色走 seed-icl（对话内语音同样按类型选）', async () => {
  // 应用内合成路由：speaker 是否在精选目录中
  const calls = []
  const manager = makeManager({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return ttsResponse()
    }
  })
  const catalog = manager.getCatalog()
  const presetId = catalog.voices[0].voiceType

  await manager.speak({ text: '预设音色。', options: { speaker: presetId } })
  assertEq(calls[0].url, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', '预设走 plan 接口')
  assertEq(calls[0].body.req_params.speaker, presetId, '预设音色 ID 透传')

  // 对话内语音的 resource 必须按音色类型解析：
  // 把克隆 speaker 配着 seed-tts 的 resource 交给 OpenClaw，供应商侧会因资源不匹配报错。
  const { buildOpenClawTtsBlock } = openclawTtsMod
  const presetBlock = buildOpenClawTtsBlock({
    conversationTts: 'always',
    resourceId: 'seed-tts-2.0',
    speakerVoice: presetId
  })
  assertEq(presetBlock.providers.volcengine.resourceId, 'seed-tts-2.0', '预设音色的对话语音用 seed-tts')

  const clonedBlock = buildOpenClawTtsBlock({
    conversationTts: 'always',
    resourceId: 'seed-icl-2.0',
    speakerVoice: 'umi_voice_test_0001'
  })
  assertEq(clonedBlock.providers.volcengine.resourceId, 'seed-icl-2.0', '克隆音色的对话语音用 seed-icl')

  // 管理器侧：克隆 speaker 不算预设（决定应用内路由）
  assertEq(typeof catalog.voices.find((v) => v.voiceType === 'umi_voice_test_0001'), 'undefined', '克隆 ID 不在精选目录')
  return '预设→seed-tts / 克隆→seed-icl，两条路由与资源都对应正确'
})

await recorder.check('V16', '情绪：官方取值白名单 + v3 走 context_texts 而非不存在的 emotion 字段', async () => {
  const {
    EMOTION_GROUPS,
    normalizeEmotion,
    emotionInstruction,
    listEmotionValues
  } = emotionMod

  // 两组：中文 24、英文 10（去重后 26 个合法值）
  assertEq(EMOTION_GROUPS.length, 2, '中/英两组')
  assertEq(EMOTION_GROUPS[0].options.length, 24, '中文组 24 个取值')
  assertEq(EMOTION_GROUPS[1].options.length, 10, '英文组 10 个取值')
  // 24(中) + 10(英) = 34，扣除两组的 6 个重叠值（neutral/happy/angry/sad/excited/ASMR）= 28
  assertEq(listEmotionValues().length, 28, '去重后 28 个合法值')

  // 官方枚举抽样
  for (const v of ['happy', 'sad', 'angry', 'tension', 'ASMR', 'vocal-fry', 'authoritative']) {
    assert(listEmotionValues().includes(v), `应有官方取值 ${v}`)
  }

  // 自由文本不再被接受（旧实现是任意 64 字字符串）
  assertEq(normalizeEmotion('happy'), 'happy', '合法值保留')
  assertEq(normalizeEmotion('超级开心'), '', '自由文本回落为空')
  assertEq(normalizeEmotion(''), '', '空串保持为空')

  // v3 的情绪通过自然语言指令下发
  const zh = emotionInstruction('happy', false)
  assert(zh && zh.includes('开心'), '中文指令含情绪语义')
  const en = emotionInstruction('happy', true)
  assert(en && /happy/i.test(en), '英文指令用英文')
  assertEq(emotionInstruction('', false), null, '不指定时不产生指令')
  assertEq(emotionInstruction('bogus', false), null, '非法值不产生指令')

  // 关键回归：请求体里不得再出现 emotion 字段（v3 没有该字段）
  const bodies = []
  const manager = makeManager({
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body))
      return ttsResponse()
    }
  })
  await manager.speak({ text: '情绪测试。', options: { emotion: 'happy' } })
  const rp = bodies[0].req_params
  assertEq(rp.audio_params.emotion, 'happy', 'emotion 位于 audio_params 下（官方路径）')
  // context_texts 必须放在 req_params.additions 里，且 additions 是 JSON 字符串
  assertEq(rp.context_texts, undefined, 'context_texts 不在 req_params 顶层（应在 additions 内）')
  assertEq(typeof rp.additions, 'string', 'additions 是 JSON 字符串')
  const parsed = JSON.parse(rp.additions)
  assert(Array.isArray(parsed.context_texts), 'additions 内含 context_texts')
  assertEq(parsed.context_texts.length, 1, '只下发一条指令')
  assert(parsed.context_texts[0].includes('开心'), '指令携带情绪语义')

  await manager.speak({ text: '无情绪。' })
  assertEq(bodies[1].req_params.additions, undefined, '不指定情绪时不下发 additions')
  return '官方取值、非法值回落、情绪经 req_params.additions 下发'
})

await recorder.check('V17', '音色边界：预设有 emotion、克隆走 model 枚举且无 emotion（按官方文档）', async () => {
  const calls = []
  const storage = memoryStore()
  const secrets = secretStore({ tts: 'tts-key-12345678', clone: 'clone-key-12345678' })
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/voice_clone')) {
      return new Response(JSON.stringify({ code: 0, status: 1 }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      })
    }
    if (u.endsWith('/get_voice')) {
      return new Response(JSON.stringify({ code: 0, status: 2, speaker_status: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      })
    }
    calls.push({ url: u, body: JSON.parse(init.body) })
    return ttsResponse()
  }
  const manager = createVoiceManager({
    storage,
    secrets,
    cacheDir: join(runDir, 'v17-audio'),
    fetchImpl,
    logger: () => undefined
  })
  const cloneManager = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'v17-voices'),
    voiceManager: manager,
    fetchImpl,
    logger: () => undefined,
    pollIntervalMs: 60_000
  })

  // ---- 预设音色：不带 model；emotion 在 audio_params 下；语速也在 audio_params 下 ----
  await manager.speak({ text: '预设。', options: { speedRatio: 1.5, emotion: 'happy' } })
  const preset = calls[0].body.req_params
  assertEq(preset.model, undefined, '预设音色不带 model')
  assertEq(preset.audio_params.speech_rate, 50, '1.5 倍速 → 50（官方 [-50,100]）')
  assertEq(preset.audio_params.emotion, 'happy', '预设 emotion 位于 audio_params 下')
  assertEq(preset.speech_rate, undefined, 'speech_rate 不在 req_params 顶层')
  assertEq(typeof preset.additions, 'string', '预设情绪另发 context_texts')

  // ---- 复刻音色：必须带官方 model 枚举；不带 emotion；不带 context_texts ----
  const samplePath = join(runDir, 'v17.wav')
  const wav = Buffer.alloc(1024)
  wav.write('RIFF', 0, 'ascii')
  wav.write('WAVE', 8, 'ascii')
  writeFileSync(samplePath, wav)
  const sample = await cloneManager.registerSample(samplePath)
  const trained = await cloneManager.train({
    token: sample.token,
    consent: true,
    displayName: 'V17 音色',
    language: 0
  })
  const ready = await cloneManager.refresh(trained.speakerId)
  await cloneManager.activate({
    speakerId: ready.speakerId,
    confirmSlotFee: true,
    text: '启用。'
  })

  await manager.speak({ text: '克隆。', options: { speaker: ready.speakerId, emotion: 'happy' } })
  const cloneCall = calls[calls.length - 1].body.req_params
  assertEq(cloneCall.model, 'seed-tts-2.0-standard', '克隆必带官方 model 枚举')
  assertEq(cloneCall.audio_params.emotion, undefined, '克隆不带 emotion（官方不支持）')
  assertEq(cloneCall.additions, undefined, '克隆不带 context_texts（指定 model 后不支持）')

  return '预设有 emotion+context_texts，克隆走 model 枚举且无情绪指令'
})
await recorder.check('V18', '远端对账：远端缺失/失败/已变化/一致 四态判定正确', async () => {
  const storage = memoryStore()
  const secrets = secretStore({ tts: 'tts-key-12345678', clone: 'clone-key-12345678' })

  // 造 4 条本地记录，分别对应 4 种远端结果
  const base = (speakerId, status, modelTypes) => ({
    speakerId,
    displayName: speakerId,
    status,
    remoteStatus: 1,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    consentAt: FIXED_NOW,
    sampleHash: 'a'.repeat(64),
    sampleFileName: 's.wav',
    language: 0,
    modelTypes,
    demos: [],
    activated: false,
    activatedAt: null,
    expiresAt: FIXED_NOW + 7 * 24 * 3600 * 1000,
    availableTrainingTimes: null,
    lastError: null
  })

  const records = [
    base('umi_voice_gone_0001', 'success', [5]),   // 远端 NotFound
    base('umi_voice_fail_0001', 'success', [5]),   // 远端 Failed
    base('umi_voice_changed_0001', 'training', []) // 远端 Success，本地还记 training
  ]
  await storage.set('voice:v1:clones', JSON.stringify(records))

  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/get_voice')) {
      const body = JSON.parse(init.body)
      const id = body.custom_speaker_id
      // 按 id 返回不同的远端状态
      if (id === 'umi_voice_gone_0001') {
        return new Response(JSON.stringify({ code: 0, status: 0 }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        })
      }
      if (id === 'umi_voice_fail_0001') {
        return new Response(
          JSON.stringify({ code: 0, status: 3, message: '音频质量不达标' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      // changed：远端已 success，且多出 model_type 4
      return new Response(
        JSON.stringify({
          code: 0, status: 2,
          speaker_status: [{ model_type: 4, demo_audio: 'https://demo.local/x.wav' }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (u.startsWith('https://demo.local/')) {
      const wav = Buffer.alloc(44)
      wav.write('RIFF', 0, 'ascii')
      wav.write('WAVE', 8, 'ascii')
      return new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    throw new Error(`unexpected URL ${u}`)
  }

  const voiceManager = createVoiceManager({
    storage,
    secrets,
    cacheDir: join(runDir, 'v18-audio'),
    fetchImpl,
    logger: () => undefined
  })
  const cloneManager = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'v18-voices'),
    voiceManager,
    fetchImpl,
    logger: () => undefined,
    pollIntervalMs: 60_000
  })

  const items = await cloneManager.reconcile()
  assertEq(items.length, 3, '逐条核对，不漏记录')

  const gone = items.find((i) => i.speakerId === 'umi_voice_gone_0001')
  assertEq(gone.verdict, 'remote-missing', '远端 NotFound → remote-missing')
  assert(gone.message.includes('远端已不存在'), '给用户可读结论')

  const failed = items.find((i) => i.speakerId === 'umi_voice_fail_0001')
  assertEq(failed.verdict, 'remote-failed', '远端 Failed → remote-failed')
  assertEq(failed.message, '音频质量不达标', '透出远端失败原因')

  const changed = items.find((i) => i.speakerId === 'umi_voice_changed_0001')
  assertEq(changed.verdict, 'remote-changed', '本地 training / 远端 success → remote-changed')
  assertEq(changed.newModelTypes.length, 1, '识别出远端新试听版本')

  // 一致场景：再补一条本地已是 active、远端也 active 的记录
  await storage.set('voice:v1:clones', JSON.stringify(
    records.concat([{
      ...base('umi_voice_ok_0001', 'active', [5]),
      activated: true,
      activatedAt: FIXED_NOW,
      expiresAt: null
    }])
  ))
  const fetchOk = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/get_voice')) {
      if (JSON.parse(init.body).custom_speaker_id === 'umi_voice_ok_0001') {
        return new Response(
          JSON.stringify({ code: 0, status: 4, speaker_status: [{ model_type: 5 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({ code: 0, status: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      })
    }
    throw new Error(`unexpected ${u}`)
  }
  const cm2 = new VoiceCloneManager({
    storage,
    secrets,
    voicesDir: join(runDir, 'v18-voices2'),
    voiceManager,
    fetchImpl: fetchOk,
    logger: () => undefined,
    pollIntervalMs: 60_000
  })
  const items2 = await cm2.reconcile()
  const okItem = items2.find((i) => i.speakerId === 'umi_voice_ok_0001')
  assertEq(okItem.verdict, 'remote-ok', '本地 active / 远端 active → remote-ok')
  assertEq(okItem.message, '本地与远端一致', '一致时明确告知')

  return '四态判定均正确，且结论可读'
})

const ok = printResult(recorder.toJSON({ cacheDir, catalog: join(repoRoot, 'resources/voice/curated-voices.v1.json') }))
if (!ok) process.exit(1)
