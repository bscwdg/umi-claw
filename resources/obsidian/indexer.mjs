#!/usr/bin/env node
// indexer.mjs -- Obsidian 索引脚本，由主进程用绿色 node 拉起（零依赖）。
// 职责：扫描 vault、解析 front matter、按标题切块、调 embedding API、增量写入向量库。
// 进度通过 stdout 输出 JSON 行（主进程解析转发）；日志走 stderr，不污染 stdout。
//
// 用法：node indexer.mjs --vault <path> --db <path> [--chunk-size 800] [--max-chunks 50]
//       embedding 凭据走环境变量：OBS_EMBEDDING_BASE_URL / OBS_EMBEDDING_API_KEY / OBS_EMBEDDING_MODEL

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  openDb, setMeta, getMeta, getFile, upsertFile, deleteFileChunks,
  insertChunk, deleteFile, allFilePaths, beginTx, commitTx,
  countNotes, countChunks
} from './db.mjs'
import { parseFrontMatter, chunkMarkdown, extractAllTags, relPath } from './markdown.mjs'
import { embed } from './embeddings.mjs'

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

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function log(...a) {
  process.stderr.write('[indexer] ' + a.join(' ') + '\n')
}

/** 递归扫描 vault 下所有 .md（跳过 .obsidian 等隐藏目录） */
function scanVault(vaultPath) {
  const result = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) result.push(full)
    }
  }
  walk(vaultPath)
  return result
}

async function main() {
  const args = parseArgs()
  const vaultPath = args.vault
  const dbPath = args.db
  const chunkSize = parseInt(args['chunk-size'] || '800', 10)
  const maxChunks = parseInt(args['max-chunks'] || '50', 10)
  // 顺手优化：豆包 embedding-large 单批 64。批量超限的 400/422 会在 embeddings.mjs
  // 内部按报错里的 "max N" 自动降批重试（OpenAI 旧版 32、智谱 10 都能自适应）。
  const batchSize = parseInt(args['batch-size'] || '64', 10)
  const embeddingCfg = {
    baseUrl: process.env.OBS_EMBEDDING_BASE_URL,
    apiKey: process.env.OBS_EMBEDDING_API_KEY,
    model: process.env.OBS_EMBEDDING_MODEL,
    adapter: process.env.OBS_EMBEDDING_ADAPTER || 'openai'
  }
  // 不再锁定：收集所有失败原因在 done 里一并输出，不中断后续处理。
  const embedErrors = []
  // 被 maxChunks 截断的笔记路径（原变量名丢失导致 done 引用 undefined，这里补回）
  const truncated = []

  if (!vaultPath || !dbPath) {
    emit({ type: 'error', message: '缺少 --vault 或 --db 参数' })
    process.exit(1)
  }

  const db = openDb(dbPath)
  const needEmbed = !!(embeddingCfg.baseUrl && embeddingCfg.apiKey && embeddingCfg.model)
  if (!needEmbed) {
    log('未配置 embedding 凭据，仅建立文本索引（向量留空，语义检索不可用）')
  }

  // 扫描：--files 指定逗号分隔的绝对路径列表时只处理这些文件（增量模式，
  // 由 mcp-server 的 watcher / 写后触发调用）；否则全量扫描 vault。
  emit({ type: 'progress', phase: 'scanning', processed: 0, total: 0, message: '扫描 vault...' })
  const onlyFiles = args.files
    ? args.files.split(',').map((s) => s.trim()).filter(Boolean)
    : null
  const files = onlyFiles || scanVault(vaultPath)
  const total = files.length
  emit({ type: 'progress', phase: 'scanning', processed: 0, total, message: `共 ${total} 篇笔记` })

  setMeta(db, 'vault_path', vaultPath)
  if (needEmbed) setMeta(db, 'embedding_model', embeddingCfg.model)

  const knownFiles = new Set(allFilePaths(db))
  const currentRel = new Set()
  let processed = 0

  for (const absPath of files) {
    processed++
    const rp = relPath(vaultPath, absPath)
    currentRel.add(rp)

    let stat, content
    try {
      stat = statSync(absPath)
      content = readFileSync(absPath, 'utf-8')
    } catch (e) {
      // 增量模式下文件已不存在 = 已删除，从库中清掉（全量模式由末尾的清理循环兜底）
      if (!existsSync(absPath)) {
        deleteFile(db, rp)
        currentRel.delete(rp)
        log('文件已删除，清理索引:', rp)
      } else {
        log('跳过读取失败:', rp, e.message)
      }
      continue
    }
    const mtime = Math.floor(stat.mtimeMs)
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 16)

    // 增量：mtime + hash 未变则跳过。但向量留空的笔记不算完成——之前 embedding
    // 失败（或建库时没配凭据）的，重跑时必须重新尝试，否则失败一次就永远只有文本索引。
    const existing = getFile(db, rp)
    const unchanged = existing && existing.hash === hash && existing.mtime === mtime
    const missingEmb = needEmbed && !!db.prepare(
      'SELECT 1 FROM chunks WHERE file_path = ? AND embedding IS NULL LIMIT 1'
    ).get(rp)
    if (unchanged && !missingEmb) {
      emit({ type: 'progress', phase: 'embedding', processed, total, message: '跳过（未变） ' + rp })
      continue
    }

    // 切块
    const { data, body } = parseFrontMatter(content)
    let chunks = chunkMarkdown(body, chunkSize)
    if (chunks.length > maxChunks) {
      chunks = chunks.slice(0, maxChunks)
      truncated.push(rp)
      emit({ type: 'progress', phase: 'truncated', processed, total, message: `截断（超出${maxChunks}块上限）: ${rp}` })
    }
    const tags = extractAllTags(data, body)

    // embedding（失败不中断后续笔记，全部错误统一在 done 里上报）
    let embeddings = new Array(chunks.length).fill(null)
    if (needEmbed && chunks.length > 0) {
      try {
        // 顺手优化：分批调用，单批 batchSize 条（豆包支持 64）
        const all = []
        for (let i = 0; i < chunks.length; i += batchSize) {
          const subTexts = chunks.slice(i, i + batchSize).map((c) => c.content)
          const subVecs = await embed(subTexts, embeddingCfg, 'search_document')
          all.push(...subVecs)
        }
        embeddings = all
      } catch (e) {
        embedErrors.push({ file: rp, error: e.message })
        log('embedding 失败:', rp, e.message)
        // 不 throw，继续处理后续笔记
      }
    }

    // 写库（事务）
    beginTx(db)
    deleteFileChunks(db, rp)
    for (let k = 0; k < chunks.length; k++) {
      insertChunk(db, {
        file_path: rp,
        heading_path: chunks[k].heading_path,
        content: chunks[k].content,
        tags: JSON.stringify(tags),
        chunk_index: k,
        embedding: embeddings[k] || null
      })
    }
    upsertFile(db, { path: rp, mtime, size: stat.size, hash, indexedAt: Date.now() })
    commitTx(db)

    emit({ type: 'progress', phase: 'embedding', processed, total, message: rp })
  }

  // 清理已删除的文件。
  // ⚠️ 仅全量扫描模式：--files 增量时 currentRel 只含传入文件，
  // 若照常清理会把库里其余全部笔记删掉。
  if (!onlyFiles) {
    for (const rp of knownFiles) {
      if (!currentRel.has(rp)) {
        deleteFile(db, rp)
        log('清理已删除:', rp)
      }
    }
  }

  // 记录维度
  const firstChunk = db.prepare('SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get()
  if (firstChunk && firstChunk.embedding) {
    setMeta(db, 'embedding_dim', String(firstChunk.embedding.byteLength / 4))
  }
  setMeta(db, 'last_indexed_at', String(Date.now()))

  const noteCount = countNotes(db)
  const chunkCount = countChunks(db)
  const dim = getMeta(db, 'embedding_dim')

  emit({
    type: 'done',
    noteCount,
    chunkCount,
    embeddingDim: dim ? parseInt(dim, 10) : null,
    embedErrors: embedErrors.length ? embedErrors : null,
    embedErrorCount: embedErrors.length,
    truncated
  })
  db.close()
}

main().catch((e) => {
  emit({ type: 'error', message: e.message })
  process.stderr.write('[indexer] 致命错误: ' + e.stack + '\n')
  process.exit(1)
})
