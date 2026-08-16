#!/usr/bin/env node
// mcp-server.mjs -- Obsidian MCP server（stdio），由 OpenClaw 拉起（零依赖）。
// 自实现 MCP JSON-RPC over stdio（newline-delimited JSON），不引入 @modelcontextprotocol/sdk。
// 工具：search_notes / read_note / list_notes / create_note / update_note / get_backlinks / get_tags
//
// 用法：node mcp-server.mjs --vault <path> --db <path>
//       embedding 凭据走环境变量（OpenClaw 启动时注入 env）

import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { openDb, cosine, norm, searchTopK } from './db.mjs'
import { parseFrontMatter, extractWikilinks } from './markdown.mjs'
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

const args = parseArgs()
const vaultPath = args.vault
const dbPath = args.db

// 修复 #2（symlink 越权）：用 realpathSync 解析 vault 真实路径，后续所有路径
// 校验都以真实路径为准，避免 symlink 逃逸到 vault 之外的文件。
let realVaultPath
try {
  realVaultPath = realpathSync(vaultPath)
} catch (e) {
  process.stderr.write('[mcp] 无法解析 vault 路径: ' + e.message + '\n')
  process.exit(1)
}

function getEmbeddingCfg() {
  return {
    baseUrl: process.env.OBS_EMBEDDING_BASE_URL,
    apiKey: process.env.OBS_EMBEDDING_API_KEY,
    model: process.env.OBS_EMBEDDING_MODEL,
    adapter: process.env.OBS_EMBEDDING_ADAPTER || 'openai'
  }
}

let db = null
function ensureDb() {
  if (!db) db = openDb(dbPath)
  return db
}

/** 把相对 vault 的路径解析为绝对路径，realpath 后严格 startsWith 校验，防 symlink 越权 */
function resolveVaultPath(rel) {
  const cleaned = (rel || '').replace(/\\/g, '/').replace(/^\//, '')
  // 1) 先用 resolve 拼绝对路径（不解链）
  const abs = resolve(vaultPath, cleaned)
  // 2) realpath 跟随所有符号链接拿到真实路径（这是修复点：原代码不跟随 symlink）
  let real
  try {
    real = realpathSync(abs)
  } catch (e) {
    // 文件不存在（新建场景）-- 暂时不报错，让 create_note 处理；这里只校验上层目录
    const parentAbs = resolve(abs, '..')
    let realParent
    try { realParent = realpathSync(parentAbs) } catch { realParent = parentAbs }
    const vp = realVaultPath.replace(/\\/g, '/')
    const pp = realParent.replace(/\\/g, '/')
    if (pp !== vp && !pp.startsWith(vp + '/')) {
      throw new Error('路径越界，禁止访问 vault 之外：' + rel)
    }
    return abs  // 返回原始 abs 给 create_note 写新文件
  }
  // 3) 严格 startsWith 校验（已跟随 symlink）
  const vp = realVaultPath.replace(/\\/g, '/')
  const ap = real.replace(/\\/g, '/')
  if (ap !== vp && !ap.startsWith(vp + '/')) {
    throw new Error('路径越界，禁止访问 vault 之外：' + rel)
  }
  // 返回 realpath 后的路径，read_note / create_note 都基于此
  return real
}

// ── 工具定义 ──
// search_notes 的描述随主动检索开关（OBS_PROACTIVE_SEARCH，默认开）切换：
// 开 = 强指令，问题可能相关就先检索；关 = 中性描述，等用户明确要求。
const SEARCH_NOTES_DESC_PROACTIVE =
  '在用户的 Obsidian 知识库中语义检索笔记片段。返回最相关的若干文本块（含文件相对路径、标题层级、内容片段、相似度分数）。' +
  '重要：无需用户明确要求，只要问题可能涉及用户的个人知识、过往记录、想法、项目资料、读书/会议笔记等内容，就应主动先调用本工具检索，再结合检索结果回答。' +
  '用户的笔记、想法、日常记录都存放在本知识库中--当用户问「我之前记过/写过/说过什么」这类问题时，指的是本知识库的内容，应优先用本工具检索，而不是其他记忆类工具；若本工具未命中，再回退使用其他记忆类工具检索。' +
  '用户的很多背景信息记录在知识库中而不是对话上下文里，不检索就回答很可能遗漏或编造。'
const SEARCH_NOTES_DESC_NEUTRAL =
  '在 Obsidian 知识库中语义检索笔记片段。返回最相关的若干文本块（含文件相对路径、标题层级、内容片段、相似度分数）。用于回答关于用户笔记内容的问题。'

const TOOLS = [
  {
    name: 'search_notes',
    description: process.env.OBS_PROACTIVE_SEARCH === '0' ? SEARCH_NOTES_DESC_NEUTRAL : SEARCH_NOTES_DESC_PROACTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索查询（自然语言）' },
        limit: { type: 'integer', description: '返回结果数，默认 5', default: 5 },
        tag: { type: 'string', description: '可选：只检索带某标签的块' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_note',
    description: '读取一篇笔记的完整内容。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '笔记相对 vault 的路径，如 notes/xxx.md' } },
      required: ['path']
    }
  },
  {
    name: 'list_notes',
    description: '列出知识库中已索引的笔记（可按文件夹或标签过滤）。',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: '可选：限定文件夹（相对 vault）' },
        tag: { type: 'string', description: '可选：限定标签' }
      }
    }
  },
  {
    name: 'create_note',
    description: '创建一篇新笔记，自动添加 front matter。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记相对路径，如 daily/2026-08-06.md' },
        content: { type: 'string', description: '笔记正文（markdown）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：标签列表' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'update_note',
    description: '更新一篇已存在笔记的正文（保留原 front matter）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'get_backlinks',
    description: '获取指向某篇笔记的反向链接（哪些笔记通过 [[wikilink]] 引用了它）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'get_outgoing_links',
    description: '获取某篇笔记通过 [[wikilink]] 引用的其他笔记。返回引用的目标列表，已在 vault 中存在的会标注解析后的文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记相对 vault 的路径（含 .md 后缀或不带均可）' }
      },
      required: ['path']
    }
  },
  {
    name: 'get_tags',
    description: '获取知识库中所有标签及其出现次数。',
    inputSchema: { type: 'object', properties: {} }
  }
]

// ── 工具实现 ──
async function searchNotes({ query, limit = 5, tag }) {
  const embeddingCfg = getEmbeddingCfg()
  if (!embeddingCfg.baseUrl || !embeddingCfg.apiKey || !embeddingCfg.model) {
    return '未配置 embedding 凭据，无法语义检索。请在 Umi Claw 的「知识库」页配置 embedding 模型并重建索引。'
  }
  const qVec = await embedOne(query, embeddingCfg)
  if (!qVec) return 'query 向量化失败'
  const d = ensureDb()
  // 修复 #1：改用 searchTopK（粗筛 + JS 精确 cosine），不再一次性 load 全库 embedding。
  let scored
  try {
    scored = searchTopK(d, qVec, Math.max(limit * 3, 15), tag)  // 多取一些以供多样性剪枝
  } catch (e) {
    return '检索失败：' + e.message
  }

  // 多样性：每篇笔记最多 2 个 chunk，避免一篇长笔记占满 top-K
  const diverse = []
  const seen = new Map()
  for (const hit of scored) {
    const n = seen.get(hit.file_path) || 0
    if (n >= 2) continue
    seen.set(hit.file_path, n + 1)
    diverse.push(hit)
    if (diverse.length >= limit) break
  }

  if (!diverse.length) return '无匹配结果'
  return diverse
    .map((s) => `## ${s.file_path}${s.heading_path ? ' › ' + s.heading_path : ''}\n相似度: ${s.score.toFixed(3)}\n\n${s.content}`)
    .join('\n\n---\n\n')
}

function readNote({ path }) {
  const abs = resolveVaultPath(path)
  if (!existsSync(abs)) return '笔记不存在：' + path
  return readFileSync(abs, 'utf-8')
}

function listNotes({ folder, tag }) {
  const d = ensureDb()
  let rows = d.prepare('SELECT path FROM files').all().map((r) => r.path)
  if (folder) {
    const f = folder.replace(/\\/g, '/').replace(/\/$/, '')
    rows = rows.filter((p) => p.startsWith(f + '/') || p === f)
  }
  if (tag) {
    // tag 去 # 前缀；单次查询全部 tags 再内存过滤，避免 N+1
    const t = tag.replace(/^#/, '')
    const allTagRows = d.prepare('SELECT DISTINCT file_path, tags FROM chunks').all()
    const fileSet = new Set(
      allTagRows
        .filter((r) => {
          try { return JSON.parse(r.tags || '[]').includes(t) } catch { return false }
        })
        .map((r) => r.file_path)
    )
    rows = rows.filter((p) => fileSet.has(p))
  }
  return rows.length ? rows.join('\n') : '无笔记（或尚未索引）'
}

// ── 增量索引（修复 #3：写后不索引）──
//
// create_note / update_note 写入后，调用 triggerIncrementalIndex(absolutePath)，
// 去抖后由 indexer.mjs 子进程重建该文件。watcher 负责 vault 内外部修改。
// 设计点：
//   - 去抖 1.5s 避免重复触发
//   - indexer 是独立子进程，不动 db.mjs 的 prepared statement cache
//   - indexer 遇到 embedding 错误不会中断，原始错误已 collect 到 embedErrors

const _indexerTimers = new Map()  // absPath -> Timeout
function triggerIncrementalIndex(absPath, debounceMs = 1500) {
  if (!existsSync(absPath)) return  // 删除场景走 watcher 路径
  if (_indexerTimers.has(absPath)) clearTimeout(_indexerTimers.get(absPath))
  _indexerTimers.set(absPath, setTimeout(() => {
    _indexerTimers.delete(absPath)
    _runIndexer([absPath])
  }, debounceMs))
}

/** 运行 indexer 子进程；paths 为绝对路径数组，传 --files 让 indexer 只处理变动文件 */
function _runIndexer(paths) {
  if (!paths || !paths.length) return
  // 跟 mcp-server.mjs 同目录的 indexer.mjs。
  // 必须用 fileURLToPath：URL.pathname 会把空格/中文等百分号编码
  // （如 C:\Program Files -> C:/Program%20Files），spawn 会拿到假路径。
  const indexerScript = fileURLToPath(new URL('./indexer.mjs', import.meta.url))
  const env = {
    ...process.env,
    OBS_EMBEDDING_BASE_URL: process.env.OBS_EMBEDDING_BASE_URL,
    OBS_EMBEDDING_API_KEY: process.env.OBS_EMBEDDING_API_KEY,
    OBS_EMBEDDING_MODEL: process.env.OBS_EMBEDDING_MODEL,
    OBS_EMBEDDING_ADAPTER: process.env.OBS_EMBEDDING_ADAPTER || 'openai'
  }
  const child = spawn(process.execPath, [indexerScript, '--vault', vaultPath, '--db', dbPath, '--files', paths.join(',')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdoutBuf = ''
  child.stdout.on('data', (d) => { stdoutBuf += d.toString() })
  child.stderr.on('data', (d) => { process.stderr.write('[indexer] ' + d.toString()) })
  child.on('exit', (code) => {
    if (code !== 0) {
      process.stderr.write(`[mcp] 增量索引退出码 ${code}：${stdoutBuf.slice(-500)}\n`)
    }
  })
}

function createNote({ path, content, tags }) {
  if (content && content.length > 1_000_000) throw new Error('内容超过 1MB 上限')
  const abs = resolveVaultPath(path)
  if (existsSync(abs)) throw new Error('笔记已存在：' + path)
  mkdirSync(resolve(abs, '..'), { recursive: true })
  const fm = tags && tags.length ? `---\ntags: [${tags.join(', ')}]\n---\n\n` : ''
  writeFileSync(abs, fm + content, 'utf-8')
  // 修复 #3：写后自动增量索引
  triggerIncrementalIndex(abs)
  return '已创建：' + path + '\n（1.5s 后自动增量索引）'
}

function updateNote({ path, content }) {
  if (content && content.length > 1_000_000) throw new Error('内容超过 1MB 上限')
  const abs = resolveVaultPath(path)
  if (!existsSync(abs)) throw new Error('笔记不存在：' + path)
  const orig = readFileSync(abs, 'utf-8')
  const m = orig.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  const fm = m ? m[0] : ''
  writeFileSync(abs, fm + content, 'utf-8')
  // 修复 #3：写后自动增量索引
  triggerIncrementalIndex(abs)
  return '已更新：' + path + '\n（1.5s 后自动增量索引）'
}

// ── 文件 watcher（修复 #3：外部编辑也能自动索引）──
//
// 启动 fs.watch 监听 vault 根目录，递归覆盖所有 .md 变化。
// Windows 上 fs.watch 偶尔会重复触发，依赖 _indexerTimers 去抖。
let _watcher = null
function startWatcher() {
  if (_watcher) return
  try {
    _watcher = watch(realVaultPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const lower = filename.toLowerCase()
      // 只关注 .md，过滤 .obsidian 等隐藏目录
      if (!lower.endsWith('.md')) return
      if (lower.includes('.obsidian' + sep) || lower.startsWith('.obsidian' + sep)) return
      const abs = resolve(realVaultPath, filename)
      if (eventType === 'rename') {
        // 新增/删除都走 indexer 增量（删除时 indexer 会从 db 清理）
        triggerIncrementalIndex(abs, 2000)
      } else {
        triggerIncrementalIndex(abs, 1500)
      }
    })
    _watcher.on('error', (e) => {
      process.stderr.write('[mcp] watcher 错误: ' + e.message + '（已停止，请检查 vault 路径）\n')
    })
    process.stderr.write('[mcp] 文件 watcher 已启动，监听 ' + realVaultPath + '\n')
  } catch (e) {
    process.stderr.write('[mcp] 启动 watcher 失败: ' + e.message + '（外部文件变更需手动重建索引）\n')
  }
}

/**
 * 规范化 wikilink 目标，用于反向链接匹配。
 * 处理 Obsidian 链接规范：
 *   - [[foo#Section]] -> foo（剥离锚点）
 *   - [[foo bar]] -> foo-bar（空格转连字符）
 *   - 统一小写（Obsidian 链接大小写不敏感）
 */
function normalizeTarget(t) {
  return t.split('#')[0].trim().toLowerCase().replace(/\s+/g, '-')
}

function getBacklinks({ path }) {
  const d = ensureDb()
  const targetNorm = normalizeTarget(path.replace(/\.md$/i, ''))
  const targetName = targetNorm.split('/').pop()
  const rows = d.prepare('SELECT DISTINCT file_path, content FROM chunks').all()
  const hits = new Set()
  for (const r of rows) {
    const links = extractWikilinks(r.content || '')
    if (links.some((l) => {
      const n = normalizeTarget(l.target)
      return n === targetNorm || n === targetName
    })) {
      hits.add(r.file_path)
    }
  }
  return hits.size ? [...hits].join('\n') : '无反向链接'
}

function getOutgoingLinks({ path }) {
  const d = ensureDb()
  if (!path) throw new Error('缺少 path 参数')
  const norm = path.replace(/\.md$/i, '').replace(/\\/g, '/')
  const chunks = d.prepare('SELECT content FROM chunks WHERE file_path = ?').all(norm)
  if (!chunks.length) return '未找到该笔记（未索引或路径不正确）：' + path
  const seen = new Set()
  const refs = []
  for (const r of chunks) {
    for (const l of extractWikilinks(r.content || '')) {
      const t = l.target.trim()
      if (t && !seen.has(t)) { seen.add(t); refs.push(t) }
    }
  }
  if (!refs.length) return '无出链'
  const allFiles = d.prepare('SELECT path FROM files').all().map(r => r.path)
  const fileByNorm = new Map()
  for (const f of allFiles) fileByNorm.set(normalizeTarget(f.replace(/\.md$/i, '')), f)
  const lines = refs.map((t) => {
    const n = normalizeTarget(t)
    const hit = fileByNorm.get(n) || fileByNorm.get(n.split('/').pop())
    return hit ? (hit + '  <-  ' + t) : ('(未解析) ' + t)
  })
  return lines.join('\n')
}

function getTags() {
  const d = ensureDb()
  // 按 file_path 去重：同一笔记的标签只计一次，避免被多块重复计数
  const rows = d.prepare('SELECT DISTINCT file_path, tags FROM chunks').all()
  const counter = {}
  for (const r of rows) {
    let tags = []
    try { tags = JSON.parse(r.tags || '[]') } catch {}
    for (const t of tags) counter[t] = (counter[t] || 0) + 1
  }
  const sorted = Object.entries(counter).sort((a, b) => b[1] - a[1])
  return sorted.length ? sorted.map(([t, c]) => `#${t} (${c})`).join('\n') : '无标签'
}

async function callTool(name, args) {
  switch (name) {
    case 'search_notes': return await searchNotes(args || {})
    case 'read_note': return readNote(args || {})
    case 'list_notes': return listNotes(args || {})
    case 'create_note': return createNote(args || {})
    case 'update_note': return updateNote(args || {})
    case 'get_backlinks': return getBacklinks(args || {})
    case 'get_outgoing_links': return getOutgoingLinks(args || {})
    case 'get_tags': return getTags(args || {})
    default: throw new Error('未知工具：' + name)
  }
}

// ── MCP JSON-RPC over stdio ──
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handleMessage(msg) {
  const { id, method, params } = msg

  // 通知（无 id）不响应
  if (method === 'notifications/initialized') return

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'obsidian-knowledge-base', version: '1.0.0' }
      }
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const { name, arguments: callArgs } = params || {}
    callTool(name, callArgs || {}).then((text) => {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } })
    }).catch((e) => {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误: ' + e.message }], isError: true } })
    })
    return
  }
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
    return
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } })
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
}

let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      handleMessage(JSON.parse(line))
    } catch (e) {
      process.stderr.write('[mcp] 解析请求失败: ' + e.message + '\n')
    }
  }
})
process.stdin.on('end', () => process.exit(0))

process.stderr.write('[mcp] obsidian server 已启动, vault=' + vaultPath + ', db=' + dbPath + '\n')

// 修复 #3：启动 watcher，外部文件变更也能自动增量索引
startWatcher()
