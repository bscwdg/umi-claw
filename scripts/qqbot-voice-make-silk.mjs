#!/usr/bin/env node
// scripts/qqbot-voice-make-silk.mjs —— mp3/wav → QQBot 可发的 SILK（16k 单声道）
//
// 用法：
//   node scripts/qqbot-voice-make-silk.mjs <input.mp3|input.wav> [out.silk]
//
// 依赖：ffmpeg（PATH 或 FFMPEG 环境变量）、仓库依赖 silk-wasm。
// 输出头必须是 0x02 + "#!SILK_V3"；这是 QQBot 语音条与普通 SILK 文件的关键差异。
// 如果输入已经是带这个头的 SILK，会直接复制到输出，不重复转码。

import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SILK_MAGIC = Buffer.from('#!SILK_V3', 'ascii')
const SAMPLE_RATE = 16000

function findFfmpeg() {
  return process.env.FFMPEG || 'ffmpeg'
}

function runFfmpeg(args) {
  return new Promise((resolvePromise, reject) => {
    execFile(findFfmpeg(), args, (error, _stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `ffmpeg 执行失败：${error.message}\n${String(stderr || '').slice(0, 500)}\n` +
              '请把 ffmpeg 放进 PATH，或设置 FFMPEG=C:\\path\\ffmpeg.exe'
          )
        )
      } else {
        resolvePromise()
      }
    })
  })
}

function hasSilkHeader(buf) {
  return buf.length >= 10 && buf[0] === 0x02 && buf.subarray(1, 10).equals(SILK_MAGIC)
}

async function loadSilkEncoder() {
  try {
    return await import('silk-wasm')
  } catch (error) {
    throw new Error(
      '找不到 silk-wasm：请先在仓库根目录执行 npm install（不要 --omit=optional）。' +
        `原始错误：${error.message}`
    )
  }
}

async function main() {
  const inputArg = process.argv[2]
  if (!inputArg || inputArg === '--help' || inputArg === '-h') {
    console.log('用法: node scripts/qqbot-voice-make-silk.mjs <input.mp3|input.wav> [out.silk]')
    console.log('环境变量: FFMPEG=C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe（不在 PATH 时）')
    return
  }
  const input = resolve(inputArg)
  if (!existsSync(input)) throw new Error(`输入文件不存在：${input}`)
  const output = resolve(
    process.argv[3] || input.replace(/\.(mp3|wav|m4a|ogg|flac|aac)$/i, '') + '.silk'
  )
  if (output === input) throw new Error('输出路径不能和输入相同（会覆盖原音频）')

  const inputBuf = await fs.readFile(input)
  if (hasSilkHeader(inputBuf)) {
    await fs.mkdir(dirname(output), { recursive: true })
    await fs.writeFile(output, inputBuf)
    console.log(`[ok] 输入已是 SILK，直接复制：${output}（${inputBuf.length} bytes）`)
    return
  }
  if (inputBuf.subarray(0, 9).equals(SILK_MAGIC)) {
    throw new Error(
      '输入是普通 SILK（缺 0x02 头），QQBot 语音条不能直接用；请提供 mp3/wav 重新生成'
    )
  }

  const { encode } = await loadSilkEncoder()
  const dir = await fs.mkdtemp(join(tmpdir(), 'qqbot-silk-'))
  const pcmPath = join(dir, 'voice.pcm')
  try {
    await runFfmpeg([
      '-y',
      '-i',
      input,
      '-vn',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      pcmPath
    ])
    const pcm = await fs.readFile(pcmPath)
    if (!pcm.length) throw new Error('ffmpeg 输出的 PCM 为空（输入可能没有音轨）')
    const result = await encode(pcm, SAMPLE_RATE)
    const silk = Buffer.from(result.data)
    if (!hasSilkHeader(silk)) {
      throw new Error(
        `silk-wasm 输出缺少 0x02 + #!SILK_V3 头（实际头：${silk.subarray(0, 10).toString('hex')}）`
      )
    }
    await fs.mkdir(dirname(output), { recursive: true })
    await fs.writeFile(output, silk)
    console.log(
      `[ok] ${input} -> ${output}\n` +
        `     时长 ${Math.round(result.duration)}ms，SILK ${silk.length} bytes，16kHz 单声道`
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(`[error] ${error.message}`)
  process.exit(1)
})
