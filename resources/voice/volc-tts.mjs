#!/usr/bin/env node
// volc-tts.mjs —— 豆包语音合成 2.0（方舟 Agent Plan HTTP 接口）
// 用法：node volc-tts.mjs "<文本>" "<输出文件.mp3>"
// 密钥：VOLCENGINE_TTS_API_KEY 或 OPENAI_API_KEY（方舟 Agent Plan 专属 Key）
// 音色：VOLC_TTS_SPEAKER，默认 zh_female_vv_uranus_bigtts（可换成复刻 SpeakerID）

import { writeFile } from 'node:fs/promises'

const ENDPOINT = process.env.VOLC_TTS_ENDPOINT || 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional'
const RESOURCE_ID = process.env.UMI_VOICE_RESOURCE_ID || process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0'
const SPEAKER = process.env.UMI_VOICE_SPEAKER || process.env.VOLC_TTS_SPEAKER || 'zh_female_vv_uranus_bigtts'
const KEY = process.env.UMI_VOICE_PLAN_KEY || process.env.VOLCENGINE_TTS_API_KEY || process.env.OPENAI_API_KEY

const [text, outPath] = process.argv.slice(2)

if (!text || !outPath) {
  console.error('usage: node volc-tts.mjs "<text>" "<output.mp3>"')
  process.exit(2)
}
if (!KEY) {
  console.error('missing VOLCENGINE_TTS_API_KEY / OPENAI_API_KEY')
  process.exit(2)
}

function splitText(input, limit = 400) {
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

async function synthesize(segment) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-Key': KEY,
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Control-Require-Usage-Tokens-Return': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        req_params: {
          text: segment,
          speaker: SPEAKER,
          audio_params: { format: 'mp3', sample_rate: 24000 }
        }
      }),
      signal: controller.signal
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    const chunks = []
    let usage = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let idx
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).trim()
        pending = pending.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.code && msg.code !== 20000000) {
          throw new Error(`api ${msg.code}: ${msg.message || ''}`)
        }
        if (msg.data) chunks.push(Buffer.from(msg.data, 'base64'))
        if (msg.usage) usage = msg.usage
      }
    }

    const tail = pending.trim()
    if (tail) {
      try {
        const msg = JSON.parse(tail)
        if (msg.code && msg.code !== 20000000) throw new Error(`api ${msg.code}: ${msg.message || ''}`)
        if (msg.data) chunks.push(Buffer.from(msg.data, 'base64'))
      } catch {
        /* ignore trailing partial line */
      }
    }

    if (!chunks.length) throw new Error('no audio data returned')
    return { audio: Buffer.concat(chunks), usage }
  } finally {
    clearTimeout(timer)
  }
}

const parts = splitText(text)
const buffers = []
for (const part of parts) {
  const { audio } = await synthesize(part)
  buffers.push(audio)
}
const all = Buffer.concat(buffers)
await writeFile(outPath, all)
console.error(`ok: ${all.length} bytes -> ${outPath}`)
