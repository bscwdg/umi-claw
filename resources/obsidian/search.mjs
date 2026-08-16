#!/usr/bin/env node
// search.mjs -- 检索测试脚本，由主进程用绿色 node 拉起（零依赖）。
// 与 mcp-server 的 search_notes 完全同一条检索链路（embedOne + searchTopK），
// 结果以单行 JSON 输出到 stdout，供「知识库」页的检索测试面板直接调用，
// 无需重启 OpenClaw 即可验证索引效果。
//
// 用法：node search.mjs --db <path> --query <text> [--limit 5] [--tag xxx]
//       embedding 凭据走环境变量：OBS_EMBEDDING_BASE_URL / _API_KEY / _MODEL / _ADAPTER

import { openDb, searchTopK } from './db.mjs'
import { embedOne } from './embeddings.mjs'

function parseArgs() {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1]
      i++
    }
  }
  return args
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const args = parseArgs()
const dbPath = args.db
const query = args.query || ''
// limit 夹在 1..20：测试面板用，防误传超大值把候选集拉爆
const limit = Math.max(1, Math.min(parseInt(args.limit || '5', 10) || 5, 20))
const tag = args.tag || null

try {
  if (!dbPath) throw new Error('缺少 --db 参数')
  if (!query) throw new Error('缺少 --query 参数')

  const cfg = {
    baseUrl: process.env.OBS_EMBEDDING_BASE_URL,
    apiKey: process.env.OBS_EMBEDDING_API_KEY,
    model: process.env.OBS_EMBEDDING_MODEL,
    adapter: process.env.OBS_EMBEDDING_ADAPTER || 'openai'
  }
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error('未配置 embedding 凭据，请先在「知识库」页配置并保存')
  }

  const t0 = Date.now()
  const vec = await embedOne(query, cfg)
  if (!vec) throw new Error('query 向量化失败')

  const db = openDb(dbPath)
  let hits
  try {
    hits = searchTopK(db, vec, limit, tag)
  } finally {
    db.close()
  }

  out({
    ok: true,
    tookMs: Date.now() - t0,
    hits: hits.map((h) => ({
      filePath: h.file_path,
      headingPath: h.heading_path || null,
      content: h.content,
      tags: (() => { try { return JSON.parse(h.tags || '[]') } catch { return [] } })(),
      score: Number(h.score.toFixed(4))
    }))
  })
} catch (e) {
  out({ ok: false, error: e.message })
  process.stderr.write('[search] ' + (e.stack || e.message) + '\n')
  process.exit(1)
}
