#!/usr/bin/env node
// resources/voice/local-tts-bridge.mjs —— OpenClaw tts-local-cli 与用户本地 TTS 实例的桥接
//
// 为什么单独一个脚本：对话内语音由 OpenClaw 网关进程合成，它只能通过 tts-local-cli
// 调本机命令；实例连接信息走宿主下发的热更文件（每次合成都重读，换实例/换音色不重启网关），
// 改地址/音色无需重启；但实例 Key 只走环境变量 UMI_LOCAL_TTS_API_KEY（网关启动时注入一次），
// 换实例或改 Key 必须重启网关，否则旧 Key 会发往新主机；Key 绝不落进热更文件或 openclaw.json。
//
// 用法：node local-tts-bridge.mjs "<文本>" "<输出文件>"
// 合成顺序：先试 OpenAI 兼容 /v1/audio/speech；404/405 说明对端只讲原生协议，
// 再回落 Voicebox 原生 /profiles + /generate/stream。任何失败都以非零退出，
// 交给 OpenClaw 自己的 provider 候选链处理保底，脚本内部不偷偷换供应商。

import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

const REQUEST_TIMEOUT_MS = 110000
const SEGMENT_LIMIT = 400

function readHotSettings() {
  const file = process.env.UMI_LOCAL_TTS_SETTINGS_FILE
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

const HOT = readHotSettings()
// 连接信息只认真源热更文件：宿主从不注入这些值类环境变量，留 env 回退会让机器全局
// 同名变量反向覆盖应用配置。仅 API Key 与热更文件路径走 env（见文件头）。
const BASE_URL = (HOT && HOT.baseUrl) || ''
const VOICE = (HOT && HOT.voice) || ''
const MODEL = (HOT && HOT.model) || 'tts-1'
const RESPONSE_FORMAT = HOT && HOT.responseFormat ? HOT.responseFormat : 'mp3'
const PROFILES_PATH = (HOT && HOT.profilesPath) || ''
const API_KEY = process.env.UMI_LOCAL_TTS_API_KEY || ''

const [text, outPath] = process.argv.slice(2)

if (!text || !outPath) {
  console.error('usage: node local-tts-bridge.mjs "<text>" "<output>"')
  process.exit(2)
}
if (!BASE_URL || !VOICE) {
  console.error('missing local tts settings: baseUrl/voice（检查 UMI_LOCAL_TTS_SETTINGS_FILE）')
  process.exit(2)
}

function authHeaders(extra) {
  return {
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    ...extra
  }
}

/** 与宿主 normalizeExternalBaseUrl 同口径：规范化到 /v1 根。 */
function normalizeBaseUrl(raw) {
  const trimmed = String(raw).trim().replace(/\/+$/, '')
  if (/\/v1$/i.test(trimmed)) return trimmed
  return `${trimmed}/v1`
}

function nativeRoot(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, '')
}

/**
 * 与宿主 openaiSpeech.resolveProfilesUrl 同口径：
 * - 空 → 实例根 /profiles；/ 开头 → 拼在实例根后（保留实例自身子路径）
 * - 完整 http(s) URL → 原样使用，origin 不同即跨主机
 * 跨主机查询不带实例 Key，避免把本机凭据发给第三方主机。
 */
function resolveProfilesUrl(baseUrl, profilesPath) {
  const root = nativeRoot(baseUrl)
  const configured = String(profilesPath || '').trim()
  if (!configured) return { url: `${root}/profiles`, crossHost: false }
  if (configured.startsWith('/')) {
    return { url: `${root}${configured}`, crossHost: false }
  }
  if (/^https?:\/\//i.test(configured)) {
    let target
    try {
      target = new URL(configured)
    } catch {
      throw new Error(`音色查询地址不是合法 URL：${configured}`)
    }
    let instance
    try {
      instance = new URL(root)
    } catch {
      instance = null
    }
    return { url: configured, crossHost: !instance || target.origin !== instance.origin }
  }
  return { url: `${root}/${configured.replace(/^\/+/, '')}`, crossHost: false }
}

function splitLongText(input, limit = SEGMENT_LIMIT) {
  const clean = String(input).replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return [clean]
  const parts = []
  let buf = ''
  for (const sentence of clean.split(/(?<=[。！？!?；;\n])/)) {
    if ((buf + sentence).length > limit && buf) {
      parts.push(buf)
      buf = ''
    }
    if (sentence.length > limit) {
      for (let i = 0; i < sentence.length; i += limit) parts.push(sentence.slice(i, i + limit))
    } else {
      buf += sentence
    }
  }
  if (buf) parts.push(buf)
  return parts
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readErrorDetail(response) {
  try {
    return (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
  } catch {
    return ''
  }
}

function isWav(bytes) {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  )
}

function isMp3(bytes) {
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true
  if (bytes.length < 4) return false
  // MPEG 帧同步：首字节 0xFF，次字节高 3 位全 1；旧写法 &0x12!==0x08 恒真，等于没校验
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
}

/** 解析 WAV 容器块，取 fmt 块与 data 块，兼容带 LIST 等额外块的文件。 */
function parseWav(bytes) {
  if (!isWav(bytes)) throw new Error('原生接口返回的不是 WAV（缺少 RIFF/WAVE 头）')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii')
    const size = view.getUint32(offset + 4, true)
    const bodyStart = offset + 8
    if (id === 'fmt ') fmt = bytes.subarray(bodyStart, bodyStart + Math.min(size, 16))
    if (id === 'data') data = bytes.subarray(bodyStart, bodyStart + size)
    offset = bodyStart + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块')
  return { fmt, data }
}

/** 多段 WAV 只能拼 data 块再重建头；直接 concat 会在中间嵌 RIFF 头，播放器只认第一段。 */
function joinWav(chunks) {
  const parsed = chunks.map(parseWav)
  const fmt = parsed[0].fmt
  // 各段采样率/声道/位深必须一致，否则拼出来的文件头只描述第一段，播放器会播坏
  for (let i = 1; i < parsed.length; i += 1) {
    if (!parsed[i].fmt.equals(fmt)) {
      throw new Error(`分段 WAV 格式不一致（第 1 段与第 ${i + 1} 段 fmt 不同），无法拼接`)
    }
  }
  const totalData = parsed.reduce((sum, item) => sum + item.data.length, 0)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + totalData, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  fmt.copy(header, 20)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(totalData, 40)
  return Buffer.concat([header, ...parsed.map((item) => item.data)])
}

function joinAudio(chunks, format) {
  if (chunks.length === 1) return chunks[0]
  if (format === 'wav') return joinWav(chunks)
  // mp3 是帧结构，裸拼接即可被解码器顺序识别
  return Buffer.concat(chunks)
}

function extractProfileArray(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    for (const key of ['data', 'voices', 'profiles', 'models', 'items']) {
      if (Array.isArray(raw[key])) return raw[key]
    }
  }
  return []
}

function pickString(src, keys) {
  for (const key of keys) {
    const value = src[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeProfiles(raw) {
  return extractProfileArray(raw)
    .filter((item) => item && typeof item === 'object')
    .map((src) => ({
      id: pickString(src, ['id', 'voice_id', 'voiceId', 'model', 'name']),
      name: pickString(src, ['name', 'display_name', 'displayName', 'title', 'id']),
      voiceType: pickString(src, ['voice_type', 'voiceType']).toLowerCase(),
      language: pickString(src, ['language']) || undefined,
      presetEngine: pickString(src, ['preset_engine']) || undefined,
      defaultEngine: pickString(src, ['default_engine']) || undefined,
      sampleCount: typeof src.sample_count === 'number' ? src.sample_count : undefined
    }))
    .filter((profile) => profile.id)
}

function pickProfile(profiles, voice) {
  const target = voice.trim().toLowerCase()
  const exact = profiles.find(
    (profile) => profile.id.toLowerCase() === target || profile.name.toLowerCase() === target
  )
  if (exact) return exact
  // 只做前缀匹配且要求唯一，避免名字含「女声」时选错音色；选不出就报错让用户改配置
  const prefix = profiles.filter(
    (profile) =>
      profile.id.toLowerCase().startsWith(target) || profile.name.toLowerCase().startsWith(target)
  )
  return prefix.length === 1 ? prefix[0] : null
}

/** 引擎派生口径与宿主 openaiSpeech.ts 保持一致：preset→qwen_custom_voice；克隆→qwen+1.7B。 */
function deriveEngine(profile) {
  if (profile.voiceType === 'preset') {
    return { engine: profile.presetEngine || 'qwen_custom_voice' }
  }
  if (profile.voiceType === 'cloned' || profile.voiceType === 'designed') {
    const engine = profile.defaultEngine || 'qwen'
    return engine === 'qwen' ? { engine, modelSize: '1.7B' } : { engine }
  }
  if (profile.presetEngine) return { engine: profile.presetEngine }
  if (profile.defaultEngine) {
    return profile.defaultEngine === 'qwen'
      ? { engine: 'qwen', modelSize: '1.7B' }
      : { engine: profile.defaultEngine }
  }
  return null
}

async function synthesizeOpenAi(segment) {
  const url = `${normalizeBaseUrl(BASE_URL)}/audio/speech`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: MODEL,
      input: segment,
      voice: VOICE,
      response_format: RESPONSE_FORMAT
    })
  })
  if (response.status === 404 || response.status === 405) return null
  if (!response.ok) {
    throw new Error(`OpenAI 兼容接口 HTTP ${response.status}: ${await readErrorDetail(response)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function synthesizeVoicebox(segment) {
  const profilesTarget = resolveProfilesUrl(BASE_URL, PROFILES_PATH)
  const profilesResponse = await fetchWithTimeout(profilesTarget.url, {
    method: 'GET',
    // 跨主机音色查询与宿主同口径：不携带本机实例 Key，避免凭据外发
    headers: profilesTarget.crossHost ? {} : authHeaders({})
  })
  if (!profilesResponse.ok) {
    throw new Error(
      `音色查询 HTTP ${profilesResponse.status}: ${await readErrorDetail(profilesResponse)}`
    )
  }
  const profiles = normalizeProfiles(await profilesResponse.json().catch(() => null))
  if (!profiles.length) throw new Error('音色查询没有返回可用音色')
  const profile = pickProfile(profiles, VOICE)
  if (!profile) {
    throw new Error(
      `找不到唯一音色「${VOICE}」；可用：${profiles.map((item) => item.name).join('、')}`
    )
  }
  if (
    (profile.voiceType === 'cloned' || profile.voiceType === 'designed') &&
    profile.sampleCount === 0
  ) {
    throw new Error(`音色「${profile.name}」还没上传参考音频（sample_count=0），暂不可用`)
  }
  const derived = deriveEngine(profile)
  if (!derived) throw new Error(`音色「${profile.name}」缺少引擎信息（preset_engine/default_engine）`)
  const body = {
    profile_id: profile.id,
    text: segment,
    language: profile.language || 'zh',
    engine: derived.engine
  }
  if (derived.modelSize) body.model_size = derived.modelSize
  const response = await fetchWithTimeout(`${nativeRoot(BASE_URL)}/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`原生合成接口 HTTP ${response.status}: ${await readErrorDetail(response)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function synthesizeSegment(segment) {
  const openAiAudio = await synthesizeOpenAi(segment).catch((error) => {
    // 连接级失败/超时也尝试一次原生接口：部分实例只暴露原生面，
    // 但对 /v1 路径直接拒连（TypeError）或挂住不响应（AbortError）而非 404
    if (error instanceof TypeError || error?.name === 'AbortError') return null
    throw error
  })
  const audio = openAiAudio ?? (await synthesizeVoicebox(segment))
  const format = isWav(audio) ? 'wav' : isMp3(audio) ? 'mp3' : null
  if (!format) throw new Error('本地 TTS 返回的音频无法识别（既不是 WAV 也不是 MP3）')
  return { audio, format }
}

const segments = splitLongText(text)
const outputs = []
for (const segment of segments) {
  outputs.push(await synthesizeSegment(segment))
}
const formats = new Set(outputs.map((item) => item.format))
if (formats.size > 1) {
  throw new Error(`分段合成返回了混合音频格式（${[...formats].join('、')}），无法拼接`)
}
const format = outputs[0].format
const merged = joinAudio(
  outputs.map((item) => item.audio),
  format
)
await writeFile(outPath, merged)
console.error(`ok: ${merged.length} bytes (${format}) -> ${outPath}`)
