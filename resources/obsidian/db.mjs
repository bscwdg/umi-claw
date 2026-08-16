// db.mjs —— Obsidian 向量库（sqlite）封装，indexer 与 mcp-server 共用。
// 零依赖：仅用 node:sqlite（Node 22+ 内置）。embedding 以 Float32Array 存取为 BLOB。
//
// 表结构：
//   meta(key, value)              —— embedding 模型/维度/最后索引时间等元数据
//   files(path, mtime, size, hash, indexed_at) —— 文件快照，增量索引用
//   chunks(id, file_path, heading_path, content, tags, chunk_index, embedding BLOB, norm REAL)
//
// 修复 #1（全表加载）：原 loadAllChunks 把全库 chunk + embedding 一次性 load 到 JS
// 内存，vault 一大就 OOM。现在新增 searchTopK()，按 norm DESC 粗筛 limit*5 候选，
// 再 JS 端做精确 cosine 排序，JS 内存只持有候选而非全库。chunks 表新增 norm 列做索引。

import { DatabaseSync } from 'node:sqlite'

const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
  'CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, hash TEXT, indexed_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, heading_path TEXT, content TEXT, tags TEXT, chunk_index INTEGER, embedding BLOB)'
  // 注意：norm 列与 idx_chunks_norm 索引在 openDb() 里迁移后创建，避免在 ALTER 之前引用不存在的列
]

/** 打开并初始化向量库；自动迁移 norm 列。WAL/synchronous 为 best-effort */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  // busy_timeout：watcher 触发的增量 indexer 与 mcp-server 读库并发时，
  // 避免写锁冲突直接抛 SQLITE_BUSY（默认 0 = 立即失败）
  try { db.exec('PRAGMA busy_timeout = 5000') } catch { /* 忽略 */ }
  try { db.exec('PRAGMA journal_mode = WAL') } catch { /* 忽略不支持的卷 */ }
  try { db.exec('PRAGMA synchronous = NORMAL') } catch { /* 忽略 */ }
  for (const sql of SCHEMA_STATEMENTS) db.exec(sql)

  // 迁移：如果 chunks 表没有 norm 列，加上（SQLite ALTER ADD COLUMN 不会重建表）
  const cols = db.prepare("PRAGMA table_info(chunks)").all()
  const hasNorm = cols.some((c) => c.name === 'norm')
  if (!hasNorm) {
    db.exec('ALTER TABLE chunks ADD COLUMN norm REAL')
    db.exec('UPDATE chunks SET norm = 0 WHERE norm IS NULL')
  }
  // 迁移后建索引（包含新列）
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_norm ON chunks(norm) WHERE norm IS NOT NULL')

  // 一次性预热：把已有 chunk 的 norm 算出来（indexer 之后也会写，幂等）
  _prewarmNorms(db)

  return db
}

function _prewarmNorms(db) {
  const missing = db.prepare(
    'SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND (norm IS NULL OR norm = 0)'
  ).all()
  if (!missing.length) return
  const upd = db.prepare('UPDATE chunks SET norm = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const r of missing) {
      const vec = toF32(r.embedding)
      let s = 0
      for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i]
      upd.run(Math.sqrt(s), r.id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── 元数据 ──
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : null
}
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value))
}

// ── Float32Array <-> BLOB ──
export function f32ToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}
/** BLOB -> Float32Array。byteOffset 非 4 字节对齐时视图构造会抛错，退化为逐元素拷贝 */
function toF32(buf) {
  if (!buf) return null
  if (buf.byteOffset % 4 === 0 && buf.byteLength % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  }
  const out = new Float32Array(Math.floor(buf.byteLength / 4))
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}
export function blobToF32(buf) {
  return toF32(buf)
}

// ── 文件表 ──
export function upsertFile(db, f) {
  db.prepare(
    'INSERT INTO files(path,mtime,size,hash,indexed_at) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,hash=excluded.hash,indexed_at=excluded.indexed_at'
  ).run(f.path, f.mtime, f.size, f.hash, f.indexedAt)
}
export function getFile(db, path) {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path)
}
export function deleteFile(db, path) {
  db.prepare('DELETE FROM chunks WHERE file_path = ?').run(path)
  db.prepare('DELETE FROM files WHERE path = ?').run(path)
}
export function allFilePaths(db) {
  return db.prepare('SELECT path FROM files').all().map((r) => r.path)
}

// ── 文本块 ──
export function deleteFileChunks(db, filePath) {
  db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath)
}
export function insertChunk(db, c) {
  // 计算 norm 一并写入（避免后续预热）
  const emb = c.embedding
  let n = null
  if (emb) {
    let s = 0
    for (let i = 0; i < emb.length; i++) s += emb[i] * emb[i]
    n = Math.sqrt(s)
  }
  db.prepare(
    'INSERT INTO chunks(file_path,heading_path,content,tags,chunk_index,embedding,norm) VALUES(?,?,?,?,?,?,?)'
  ).run(c.file_path, c.heading_path, c.content, c.tags, c.chunk_index, emb ? f32ToBlob(emb) : null, n)
}

// ── 计数 ──
export function countNotes(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM files').get().c
}
export function countChunks(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM chunks').get().c
}

// ── 向量数学 ──
export function norm(vec) {
  let s = 0
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i]
  return Math.sqrt(s)
}
export function cosine(a, b, aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (aNorm * bNorm)
}

// ── 检索：分页精确扫描 + 有界 top-K ──
//
// 修复 #1（全表加载）：早期版本把全库 chunk + embedding 一次性 load 到 JS 内存，
// vault 一大就 OOM。后来曾改为 ORDER BY norm DESC 粗筛 limit*5 候选，但 norm 与
// 查询相似度无任何相关性——低范数的 chunk 无论多相关都进不了候选，大库下召回
// 莫名变差。现在改为按 id 分页全扫（每页 1000 行），JS 端算精确 cosine，top-K
// 用长度 ≤ limit 的有序数组维护：
//   内存：O(limit + 页大小)，与全库规模无关
//   召回：精确 top-K（等价全表 cosine 排序）
const PAGE_SIZE = 1000

/**
 * 检索 top-K 相似 chunk。
 * @param {DatabaseSync} db
 * @param {Float32Array} queryVec  query 向量
 * @param {number} limit           返回数量
 * @param {string|null} tag        可选 tag 过滤
 * @returns {Array<{id,file_path,heading_path,content,tags,score}>}
 */
export function searchTopK(db, queryVec, limit, tag) {
  const dim = queryVec.length
  // 维度一致性：meta.embedding_dim 与 query vector 长度必须一致，否则 top-K 会脏
  const metaDim = parseInt(getMeta(db, 'embedding_dim') || '0', 10)
  if (metaDim && metaDim !== dim) {
    throw new Error(
      `embedding 维度不一致：库内 ${metaDim}，query ${dim}。` +
      `请用新模型重建索引（删除 index.db 后重跑 indexer）`
    )
  }

  const qNorm = norm(queryVec)
  const wantTag = tag ? tag.replace(/^#/, '') : null
  const stmt = db.prepare(
    'SELECT id, file_path, heading_path, content, tags, embedding, norm ' +
    'FROM chunks WHERE embedding IS NOT NULL AND norm IS NOT NULL AND norm > 0 ' +
    'AND id > ? ORDER BY id LIMIT ' + PAGE_SIZE
  )

  // best 按 score 升序维护（best[0] 是当前第 limit 名），长度封顶 limit
  const best = []
  let lastId = -1
  for (;;) {
    const rows = stmt.all(lastId)
    if (!rows.length) break
    for (const r of rows) {
      lastId = r.id
      if (wantTag) {
        try { if (!JSON.parse(r.tags || '[]').includes(wantTag)) continue } catch { continue }
      }
      const buf = r.embedding
      if (!buf || buf.byteLength / 4 !== dim) continue
      const vec = toF32(buf)
      const score = cosine(queryVec, vec, qNorm, r.norm)
      if (best.length < limit) {
        best.push({ id: r.id, file_path: r.file_path, heading_path: r.heading_path, content: r.content, tags: r.tags, score })
        best.sort((a, b) => a.score - b.score)
      } else if (score > best[0].score) {
        best[0] = { id: r.id, file_path: r.file_path, heading_path: r.heading_path, content: r.content, tags: r.tags, score }
        // 只有 1 个元素被换掉，插入排序式的下潜即可，无需全排
        for (let i = 0; i < best.length - 1 && best[i].score > best[i + 1].score; i++) {
          const t = best[i]; best[i] = best[i + 1]; best[i + 1] = t
        }
      }
    }
    if (rows.length < PAGE_SIZE) break
  }
  best.reverse()  // 升序 -> 降序
  return best
}

/**
 * @deprecated 旧接口：一次性 load 全库 embedding，vault 大了 OOM。
 * 保留以便回退，但已不推荐使用。请改用 searchTopK。
 */
export function loadAllChunks(db) {
  console.warn('[db] loadAllChunks 已弃用，请改用 searchTopK。一次性全表加载会 OOM。')
  const rows = db.prepare('SELECT id,file_path,heading_path,content,tags,embedding FROM chunks').all()
  const out = []
  for (const r of rows) {
    const emb = blobToF32(r.embedding)
    out.push({
      id: r.id,
      file_path: r.file_path,
      heading_path: r.heading_path,
      content: r.content,
      tags: r.tags,
      embedding: emb,
      norm: emb ? norm(emb) : 0
    })
  }
  return out
}

// ── 事务 ──
export function beginTx(db) { db.exec('BEGIN') }
export function commitTx(db) { db.exec('COMMIT') }
export function rollbackTx(db) { try { db.exec('ROLLBACK') } catch {} }
