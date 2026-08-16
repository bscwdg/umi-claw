// markdown.mjs —— Obsidian markdown 解析与切块，零依赖。
// 提供：front matter 解析、按标题切块、标签提取、wikilink 提取。

/**
 * 解析 YAML front matter（轻量行解析，不引入 yaml 库）。
 * 支持 tags: [a, b] / tags: a / 多行列表。
 * @returns {{data: object, body: string}}
 */
export function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: text }
  const raw = m[1]
  const body = text.slice(m[0].length)
  const data = {}
  const listKeys = new Set(['tags', 'aliases', 'alias'])
  let curListKey = null
  for (const line of raw.split(/\r?\n/)) {
    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem && curListKey) {
      const val = listItem[1].trim().replace(/^["']|["']$/g, '')
      if (val) (data[curListKey] ||= []).push(val)
      continue
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const [, k, v] = kv
    curListKey = null
    let val = v.trim()
    if (val === '') {
      // 可能是后面跟多行列表
      if (listKeys.has(k)) { data[k] = []; curListKey = k }
      else data[k] = ''
      continue
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      val = val.replace(/^["']|["']$/g, '')
    }
    data[k] = val
    if (Array.isArray(val) && listKeys.has(k)) curListKey = k
  }
  return { data, body }
}

/**
 * 按标题层级切块。块超过 chunkSize 时按段落进一步切分。
 * @returns {{heading_path: string, content: string, chunk_index: number}[]}
 */
export function chunkMarkdown(body, chunkSize = 800) {
  // 先剥离代码块/行内代码/HTML 注释，避免其中的 # 行被误判为标题、
  // 或代码内容污染切块边界。注意：剥离后行数可能变少，但不影响切块正确性。
  const stripped = stripCodeAndComments(body)
  const lines = stripped.split(/\r?\n/)
  const chunks = []
  let current = []
  let headingPath = []
  let chunkIndex = 0

  const flush = () => {
    const content = current.join('\n').trim()
    if (content) {
      chunks.push({ heading_path: headingPath.filter(Boolean).join(' / '), content, chunk_index: chunkIndex++ })
    }
    current = []
  }

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flush()
      const level = h[1].length
      const title = h[2].trim()
      headingPath = headingPath.slice(0, level - 1)
      headingPath[level - 1] = title
      current.push(line)
      continue
    }
    current.push(line)
    // 超长块在段落边界（空行）切分
    if (current.join('\n').length >= chunkSize * 1.5 && line.trim() === '') {
      flush()
    }
  }
  flush()

  // 对仍超长的块按段落二次切分
  const refined = []
  chunkIndex = 0
  for (const ch of chunks) {
    if (ch.content.length <= chunkSize * 2) {
      refined.push({ ...ch, chunk_index: chunkIndex++ })
      continue
    }
    const paras = ch.content.split(/\r?\n\r?\n/)
    let buf = ''
    for (const p of paras) {
      if ((buf + '\n\n' + p).length > chunkSize && buf) {
        refined.push({ heading_path: ch.heading_path, content: buf.trim(), chunk_index: chunkIndex++ })
        buf = p
      } else {
        buf = buf ? buf + '\n\n' + p : p
      }
    }
    if (buf.trim()) refined.push({ heading_path: ch.heading_path, content: buf.trim(), chunk_index: chunkIndex++ })
  }
  return refined
}

/** 剥离代码块/行内代码/HTML 注释，避免其中的 # 被误识别为标签 */
function stripCodeAndComments(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')   // 多行代码块
    .replace(/`[^`\n]*`/g, ' ')         // 行内代码
    .replace(/<!--[\s\S]*?-->/g, ' ')    // HTML 注释
}

/** 提取正文内联 #tag（中英文/数字/斜杠连字符），自动跳过代码块 */
export function extractInlineTags(text) {
  return [...(stripCodeAndComments(text).matchAll(/(?:^|[\s(])#([\w一-龥][\w一-龥/-]*)/g))]
    .map((m) => m[1])
}

/** 合并 front matter tags 与正文内联 tag */
export function extractAllTags(frontMatterData, body) {
  const tags = new Set()
  const fmTags = frontMatterData.tags
  if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(t))
  else if (typeof fmTags === 'string' && fmTags) tags.add(fmTags)
  for (const t of extractInlineTags(body)) tags.add(t)
  return [...tags]
}

/** 提取 wikilink [[target|text]] */
export function extractWikilinks(text) {
  const links = []
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  let m
  while ((m = re.exec(text))) {
    links.push({ target: m[1].trim(), text: (m[2] || m[1]).trim() })
  }
  return links
}

/** 规范化笔记路径为 vault 相对路径（统一正斜杠） */
export function relPath(vaultPath, absPath) {
  return absPath.slice(vaultPath.length).replace(/\\/g, '/').replace(/^\//, '')
}
