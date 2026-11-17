// resources/obsidian/local-embedding.mjs —— 本地向量模型（ONNX Runtime + bge-small-zh）
//
// 由 indexer / mcp-server / search 通过 embeddings.mjs 的 local adapter 调用。
// 零 npm 依赖：运行时从数据目录按绝对路径 createRequire，tokenizer 用 vocab.txt 自实现
// （与工具目录 tools/verify-runtime.mjs 同口径，避免再引入一个原生 tokenizer 包）。
//
// 用法（host 注入 env）：
//   OBS_EMBEDDING_ADAPTER=local
//   OBS_EMBEDDING_LOCAL_RUNTIME_DIR=<dataDir>/models/embedding/runtimes/<id>/<ver>
//   OBS_EMBEDDING_LOCAL_MODEL_DIR=<dataDir>/models/embedding/models/<id>/<ver>
//
// 模型规格：BERT-small，hidden 512、max 512 token；CLS pooling + L2 norm；
// query 侧加 BGE 指令前缀，document 侧不加。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import os from 'node:os'

export const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'
const MAX_LEN = 512
const MAX_CHARS_PER_TOKEN = 100
let _cache = null

function verifyPackageDir(dir, label) {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${label} 缺少完整性清单 manifest.json，请重新安装本地模型`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 完整性清单无法解析：${error.message}`)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${label} 完整性清单为空`)
  }
  for (const file of manifest.files) {
    const p = join(dir, ...String(file.path).split('/'))
    if (!existsSync(p)) throw new Error(`${label} 文件缺失：${file.path}`)
    const data = readFileSync(p)
    if (data.length !== file.sizeBytes) throw new Error(`${label} 文件大小不符：${file.path}`)
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== file.sha256) throw new Error(`${label} 文件校验失败（可能被篡改）：${file.path}`)
  }
}

function assertDirs(cfg) {
  if (!cfg?.runtimeDir || !cfg?.modelDir) {
    throw new Error('本地 embedding 缺少运行时/模型目录（OBS_EMBEDDING_LOCAL_RUNTIME_DIR / OBS_EMBEDDING_LOCAL_MODEL_DIR）')
  }
  const modelFile = join(cfg.modelDir, 'model_quantized.onnx')
  const vocabFile = join(cfg.modelDir, 'vocab.txt')
  if (!existsSync(modelFile)) throw new Error(`本地模型文件不存在：${modelFile}`)
  if (!existsSync(vocabFile)) throw new Error(`本地模型 vocab.txt 不存在：${vocabFile}`)
  if (!existsSync(join(cfg.runtimeDir, 'node_modules', 'onnxruntime-node'))) {
    throw new Error(`本地 embedding 运行时不存在：${cfg.runtimeDir}`)
  }
  // 从数据目录加载原生 .node 前必须复验逐文件哈希（防止目录被替换/同步污染）
  verifyPackageDir(cfg.runtimeDir, '本地运行时')
  verifyPackageDir(cfg.modelDir, '本地模型')
}

function isChinese(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

function basicTokenize(text) {
  let spaced = ''
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)
    if (isChinese(cp)) spaced += ` ${ch} `
    else if (/\s/u.test(ch)) spaced += ' '
    else spaced += ch
  }
  const out = []
  for (const token of spaced.trim().split(/\s+/)) {
    if (!token) continue
    let cur = ''
    for (const ch of token) {
      if (/\p{P}/u.test(ch)) {
        if (cur) {
          out.push(cur)
          cur = ''
        }
        out.push(ch)
      } else {
        cur += ch
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

function wordPiece(token, tokenToId, unkId) {
  if ([...token].length > MAX_CHARS_PER_TOKEN) return [unkId]
  const chars = [...token]
  const ids = []
  let start = 0
  while (start < chars.length) {
    let end = chars.length
    let found = null
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('')
      const id = tokenToId.get(piece)
      if (id !== undefined) {
        found = id
        break
      }
      end--
    }
    if (found === null) return [unkId]
    ids.push(found)
    start = end
  }
  return ids
}

/**
 * 纯函数：文本 → input_ids / attention_mask（方便单测，不加载模型）。
 * 与 transformers BertTokenizer(do_lower_case=false, tokenize_chinese_chars=true) 对齐。
 */
export function encodeText(text, vocabLines, { maxLen = MAX_LEN } = {}) {
  const tokenToId = new Map()
  for (let i = 0; i < vocabLines.length; i++) {
    if (vocabLines[i] !== '') tokenToId.set(vocabLines[i], i)
  }
  const cls = tokenToId.get('[CLS]')
  const sep = tokenToId.get('[SEP]')
  const unk = tokenToId.get('[UNK]')
  if (cls === undefined || sep === undefined || unk === undefined) {
    throw new Error('vocab.txt 缺少 [CLS]/[SEP]/[UNK]')
  }
  const ids = [cls]
  for (const token of basicTokenize(text)) {
    for (const id of wordPiece(token, tokenToId, unk)) ids.push(id)
  }
  ids.push(sep)
  const trimmed = ids.length > maxLen ? [...ids.slice(0, maxLen - 1), sep] : ids
  return {
    ids: trimmed,
    attentionMask: new Array(trimmed.length).fill(1),
    tokenTypeIds: new Array(trimmed.length).fill(0)
  }
}

function getCache(cfg) {
  const key = `${cfg.runtimeDir}|${cfg.modelDir}`
  if (_cache && _cache.key === key) return _cache
  assertDirs(cfg)
  const requireFromRuntime = createRequire(join(cfg.runtimeDir, 'index.js'))
  const ort = requireFromRuntime('onnxruntime-node')
  const modelPath = join(cfg.modelDir, 'model_quantized.onnx')
  const vocabLines = readFileSync(join(cfg.modelDir, 'vocab.txt'), 'utf8').split(/\r?\n/)
  const threads = Math.max(2, Math.min(4, Math.floor((os.cpus?.().length || 4) / 2)))
  const sessionPromise = ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
    logSeverityLevel: 3
  })
  _cache = { key, ort, sessionPromise, vocabLines }
  return _cache
}

function toInt64(ort, values) {
  return new ort.Tensor('int64', BigInt64Array.from(values.map((v) => BigInt(v))), [1, values.length])
}

async function encodeOne(text, cfg) {
  const cache = getCache(cfg)
  const session = await cache.sessionPromise
  const { ids, attentionMask, tokenTypeIds } = encodeText(text, cache.vocabLines)
  const feeds = {
    input_ids: toInt64(cache.ort, ids),
    attention_mask: toInt64(cache.ort, attentionMask),
    token_type_ids: toInt64(cache.ort, tokenTypeIds)
  }
  const outputMap = await session.run(feeds)
  const name = session.outputNames.find((n) => n.includes('last_hidden_state')) || session.outputNames[0]
  const output = outputMap[name]
  const hidden = output.dims[output.dims.length - 1]
  const data = output.data
  const vector = new Float32Array(hidden)
  let norm = 0
  for (let i = 0; i < hidden; i++) {
    const v = data[i]
    vector[i] = v
    norm += v * v
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < hidden; i++) vector[i] /= norm
  return vector
}

/**
 * 批量向量化。purpose='search_query' 时自动加 BGE 指令前缀。
 * @returns {Promise<Float32Array[]>}
 */
export async function embedLocal(texts, cfg, purpose = 'search_document') {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const out = []
  for (const text of texts) {
    const input = purpose === 'search_query' && !String(text).startsWith(QUERY_INSTRUCTION)
      ? QUERY_INSTRUCTION + text
      : text
    out.push(await encodeOne(String(input ?? ''), cfg))
  }
  return out
}
