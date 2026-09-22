// resources/database/read-old-db.mjs —— 旧库只读映射（PLAN-3.0.md §八 沿用 / 硬规则 17）
//
// 由主进程用**便携 Node** 调用（Electron 主进程 Node 无 node:sqlite）。
//
// 铁律：**只读打开，绝不写旧库**。用 node:sqlite 的 readOnly 模式；
// 读不到/结构不符 → 退出码非 0，由主进程翻译，绝不静默兜底成「迁移成功」。
//
// 输出（stdout 单行 JSON，供 wizardManager.readOldDb 消费）：
//   { mapping: { callName, position, department, company, tone, industry },
//     displayOnlyCount }
//
// 用法：node read-old-db.mjs --dbPath <abs> --version 2.0

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      out[key] = argv[i + 1]
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv)
const dbPath = args.dbPath
const version = args.version

if (!dbPath || !existsSync(dbPath)) {
  console.error(`旧库文件不存在: ${String(dbPath)}`)
  process.exit(2)
}

let db
try {
  // readOnly：物理上无法写，硬规则 17「绝不写旧库」的落实
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (e) {
  console.error(`旧库无法以只读方式打开: ${e?.message || String(e)}`)
  process.exit(3)
}

/** 读一张表的列与首行（表不存在返回 null） */
function readTable(name) {
  try {
    const info = db.prepare(`PRAGMA table_info(${name})`).all()
    if (!info.length) return null
    const cols = info.map((c) => c.name)
    const row = db.prepare(`SELECT * FROM ${name} LIMIT 1`).get()
    return { cols, row }
  } catch {
    return null
  }
}

/** 安全取列（存在且非空才取） */
function pick(table, ...candidates) {
  if (!table || !table.row) return null
  for (const c of candidates) {
    if (table.cols.includes(c)) {
      const v = table.row[c]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

try {
  // 2.0 营销域：businesses（1:1 商家资料）+ projects（项目，含 industry）
  const businesses = readTable('businesses')
  const projects = readTable('projects')

  const mapping = {
    // 2.0 没有「用户本人」的称呼/岗位/部门概念；商家名只能映射到 company
    callName: null,
    position: null,
    department: null,
    company: pick(businesses, 'name', 'brand'),
    tone: pick(businesses, 'tone'),
    industry: pick(projects, 'industry')
  }

  // 统计「仅展示」条目：无法安全映射进工作画像的其余事实行数
  let displayOnlyCount = 0
  for (const t of ['businesses', 'projects', 'knowledge_items', 'project_watchlist', 'knowledge_chunks']) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()
      displayOnlyCount += Number(r?.c ?? 0)
    } catch {
      /* 该旧库无此表，不计 */
    }
  }

  process.stdout.write(JSON.stringify({ mapping, displayOnlyCount }))
} catch (e) {
  console.error(`旧库读取失败: ${e?.message || String(e)}`)
  process.exit(4)
} finally {
  try {
    db?.close()
  } catch {}
}
