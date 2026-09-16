// test/project.accept.mjs —— Commit 03 验收：Project CRUD + conversation_key + 切换持久化
//
// **打真实源码**：esbuild 把 electron/main/marketing/projectManager.ts bundle 成临时 ESM，
// 在纯 Node 里 import，注入真 DatabaseClient（真 db-worker.mjs 子进程）+ 临时 dataDir。
// 刻意「不抄一份 Manager 逻辑」，因此验证的正是生产代码路径。
//
// 断言贴着 PLAN-2.0.md §十「删除 Project（v1.10 修订）」的真实语义写，
// 而不是只测 SQL 层：先目录后行 / 失败不删行 / 幂等重试 / 物理删除 / 级联清空。
//
// 用法：node test/project.accept.mjs    （加 --keep-tmp 保留临时目录）

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath,
  writeJson
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, `project-${Date.now()}`)
const dataDir = join(runDir, 'data')
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
const projectsDir = join(dataDir, 'projects')
const altRoot = join(runDir, 'alt')
mkdirSync(runDir, { recursive: true })

const managerPath = bundleEntry('electron/main/marketing/projectManager.ts', 'projectManager.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'project-database.mjs')
const mod = await import(pathToFileURL(managerPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)
const { ProjectManager, createProjectManager, CURRENT_PROJECT_META_KEY, PROJECTS_SUBDIR } = mod
const { DatabaseClient } = dbMod

const clients = new Set()
const logs = []
const logger = (m) => logs.push(String(m))

function makeClient(overrides = {}) {
  const client = new DatabaseClient({
    dbPath,
    backupDir,
    workerScriptPath,
    nodePath,
    subprocessName: 'marketing-db-worker-project-test',
    requestTimeoutMs: 30_000,
    ...overrides
  })
  clients.add(client)
  return client
}

function makeManager(database, dir = dataDir, extra = {}) {
  return createProjectManager({ database, dataDir: dir, logger, ...extra })
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (v) => typeof v === 'string' && UUID_V4.test(v)

/** 统一把「抛错」变成可断言的结构 */
async function outcome(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (e) {
    return { ok: false, code: e && e.code, message: (e && e.message) || String(e), details: e && e.details }
  }
}

function countRows(database, table, projectId) {
  return database
    .request(`${table}.count`, { where: { project_id: projectId } })
    .then((r) => Number(r && r.count))
}

/**
 * 用 PowerShell 以 FileShare.None 持住目录内文件的句柄 —— Windows 上最接近
 * 「目录被别的程序占用」的真实模拟（Node 自己的 fs.open 带 FILE_SHARE_DELETE，删得掉，模拟不了）。
 * 返回 { child, marker, locked }；locked=false 表示本环境做不到 → 用例降级。
 */
async function holdFileLock(targetPath, markerPath) {
  if (process.platform !== 'win32') return { child: null, locked: false, why: '非 Windows 平台' }
  const q = (p) => `'${p.replace(/'/g, "''")}'`
  const script = [
    `$f = [System.IO.File]::Open(${q(targetPath)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)`,
    `[System.IO.File]::WriteAllText(${q(markerPath)}, 'locked')`,
    'Start-Sleep -Seconds 120',
    '$f.Close()'
  ].join('\n')
  let child
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch (e) {
    return { child: null, locked: false, why: `powershell 启动失败: ${e.message}` }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return { child, locked: true, why: '' }
    if (child.exitCode !== null) break
    await sleep(100)
  }
  try {
    child.kill()
  } catch {
    /* 忽略 */
  }
  return { child: null, locked: false, why: '未能建立 FileShare.None 句柄（marker 未出现）' }
}

function releaseLock(lock) {
  if (lock && lock.child) {
    try {
      lock.child.kill()
    } catch {
      /* 忽略 */
    }
  }
}

const r = new Recorder('project（Project CRUD + conversation_key + 切换持久化，打真 projectManager.ts）')
let main = null
let manager = null
const ctx = {}

try {
  // ── P1 真源码可纯 Node import ──
  await r.check('P1', 'projectManager.ts 可纯 Node import（依赖注入，无 electron 顶层引用）', async () => {
    assert(typeof ProjectManager === 'function', '应导出 ProjectManager')
    assertEq(typeof createProjectManager, 'function', '应导出 createProjectManager 工厂')
    const src = readFileSync(managerPath, 'utf-8')
    assert(!/from\s*["']electron["']/.test(src), 'bundle 内不应存在 electron import')
    assertEq(CURRENT_PROJECT_META_KEY, 'current_project_id', 'current_project_id 键名应为 §四 白名单键')
    assertEq(PROJECTS_SUBDIR, 'projects', '子目录应为 data/projects')
    return `bundle=${managerPath.replace(/^.*[\\/]/, '')}`
  })

  // ── P2 create：字段齐全 + conversation_key + 目录 ──
  await r.check('P2', 'create：id/conversation_key 为 uuid、status=active、时间戳齐全、目录已建', async () => {
    main = makeClient()
    manager = makeManager(main)
    await main.ping() // 惰性建库

    const created = await manager.createProject({ name: '  拾光摄影  ', industry: '摄影', description: '县城人像写真' })
    ctx.a = created
    assert(isUuid(created.id), `id 应为 uuid，实际 ${created.id}`)
    assert(isUuid(created.conversation_key), `conversation_key 应为 uuid，实际 ${created.conversation_key}`)
    assert(created.id !== created.conversation_key, 'id 与 conversation_key 不应相同')
    assertEq(created.name, '拾光摄影', 'name 应 trim')
    assertEq(created.industry, '摄影', 'industry 应落库')
    assertEq(created.description, '县城人像写真', 'description 应落库')
    assertEq(created.status, 'active', 'status 应为 active')
    assert(typeof created.created_at === 'number' && created.created_at > 0, 'created_at 应为数字时间戳')
    assertEq(created.updated_at, created.created_at, '新建时 updated_at 应等于 created_at')

    const dir = join(projectsDir, created.id)
    assert(existsSync(dir), `应顺手建好 data/projects/<id>/ 目录: ${dir}`)
    assertEq(manager.projectDir(created.id), dir, 'projectDir() 应与 §三 目录策略一致')
    return `id=${created.id.slice(0, 8)}… key=${created.conversation_key.slice(0, 8)}… dir=data/projects/<id>`
  })

  // ── P3 create：空名校验 + 可选文本归一 ──
  await r.check('P3', 'create：空名/空白名 → VALIDATION_ERROR；可选字段空白归一为 null', async () => {
    const before = (await manager.listProjects()).length
    for (const bad of ['', '   ', undefined, null, 42]) {
      const out = await outcome(manager.createProject({ name: bad }))
      assertEq(out.ok, false, `name=${JSON.stringify(bad)} 应失败`)
      assertEq(out.code, 'VALIDATION_ERROR', `name=${JSON.stringify(bad)} 应回 VALIDATION_ERROR`)
      assertEq(out.details && out.details.field, 'name', 'details.field 应为 name')
    }
    const blank = await manager.createProject({ name: '空可选字段店', industry: '   ', description: '' })
    assertEq(blank.industry, null, '空白 industry 应归一为 null')
    assertEq(blank.description, null, '空串 description 应归一为 null')
    const after = await manager.listProjects()
    assertEq(after.length, before + 1, '只有合法的那次应该落库（校验失败不得产生行）')
    ctx.blank = blank
    return `5 次非法入参全部 VALIDATION_ERROR；空白可选字段 → null`
  })

  // ── P4 list / get / 不存在 ──
  await r.check('P4', 'list（按 created_at 升序）/ get；不存在 → NOT_FOUND', async () => {
    const list = await manager.listProjects()
    assert(Array.isArray(list), 'list 应返回数组')
    assertEq(list.length, 2, `应有 2 个 project（实际 ${list.length}）`)
    for (let i = 1; i < list.length; i++) {
      assert(list[i - 1].created_at <= list[i].created_at, 'list 应按 created_at 升序')
    }
    const got = await manager.getProject(ctx.a.id)
    assertEq(got.conversation_key, ctx.a.conversation_key, 'get 应返回同一会话键')

    const miss = await outcome(manager.getProject('ghost-project'))
    assertEq(miss.ok, false, '不存在应失败')
    assertEq(miss.code, 'NOT_FOUND', '不存在应回 NOT_FOUND')
    assertEq(miss.details && miss.details.projectId, 'ghost-project', 'details 应带 projectId')
    return `list=${list.length} 条；NOT_FOUND details.projectId ✓`
  })

  // ── P5 update：白名单 + conversation_key 不变 + id/created_at 不可改 ──
  await r.check('P5', 'update：只改白名单字段、刷新 updated_at、conversation_key/id/created_at 不变', async () => {
    await sleep(5) // 保证时间戳能区分
    const updated = await manager.updateProject(ctx.a.id, {
      name: '拾光摄影·二店',
      description: null
    })
    assertEq(updated.name, '拾光摄影·二店', 'name 应更新')
    assertEq(updated.description, null, 'description 应置空')
    assertEq(updated.industry, '摄影', '未传的字段不应被清掉')
    assert(updated.updated_at > ctx.a.updated_at, 'updated_at 应刷新')
    assertEq(updated.created_at, ctx.a.created_at, 'created_at 不可改')
    assertEq(updated.id, ctx.a.id, 'id 不可改')
    assertEq(updated.conversation_key, ctx.a.conversation_key, 'conversation_key 必须保持不变')
    assertEq(updated.status, 'active', 'status 不受 update 影响')

    // 禁止改身份字段：静默忽略会变成「改了但没生效」的幽灵 bug，必须炸在入口
    for (const patch of [{ conversation_key: 'forged' }, { id: 'forged' }, { created_at: 1 }, { status: 'x' }]) {
      const out = await outcome(manager.updateProject(ctx.a.id, patch))
      assertEq(out.ok, false, `${Object.keys(patch)[0]} 应被拒绝`)
      assertEq(out.code, 'VALIDATION_ERROR', `${Object.keys(patch)[0]} 应回 VALIDATION_ERROR`)
    }
    const emptyName = await outcome(manager.updateProject(ctx.a.id, { name: '  ' }))
    assertEq(emptyName.code, 'VALIDATION_ERROR', '改名成空应回 VALIDATION_ERROR')
    const miss = await outcome(manager.updateProject('ghost-project', { name: 'x' }))
    assertEq(miss.code, 'NOT_FOUND', '更新不存在应回 NOT_FOUND')

    const after = await manager.getProject(ctx.a.id)
    assertEq(after.conversation_key, ctx.a.conversation_key, '被拒的更新不得污染会话键')
    return `updated_at ${ctx.a.updated_at} → ${updated.updated_at}；4 个身份字段全部拒绝`
  })

  // ── P6 多 project 的 conversation_key 互不相同 ──
  await r.check('P6', '多 Project 的 conversation_key 互不相同（会话隔离前提，§六）', async () => {
    const made = []
    for (let i = 0; i < 4; i++) made.push(await manager.createProject({ name: `多店-${i}` }))
    const list = await manager.listProjects()
    const keys = list.map((p) => p.conversation_key)
    assertEq(new Set(keys).size, keys.length, `conversation_key 不应重复（${keys.length} 行 / ${new Set(keys).size} 唯一）`)
    assert(keys.every(isUuid), '全部 conversation_key 应为 uuid')
    const ids = list.map((p) => p.id)
    assertEq(new Set(ids).size, ids.length, 'id 不应重复')
    return `${list.length} 个 project，conversation_key 唯一且全为 uuid`
  })

  // ── P7 setCurrent / getCurrent 跨实例持久化（模拟重启） ──
  await r.check('P7', 'setCurrent/getCurrent：落 app_meta 且跨 DatabaseClient 实例（重启）仍在', async () => {
    const set = await manager.setCurrentProject(ctx.a.id)
    assertEq(set.currentProjectId, ctx.a.id, 'setCurrentProject 应回写 id')
    assertEq(await main.metaGet(CURRENT_PROJECT_META_KEY), ctx.a.id, '应写在 app_meta.current_project_id')
    const cur = await manager.getCurrentProject()
    assertEq(cur && cur.id, ctx.a.id, 'getCurrentProject 应返回该 project')
    assertEq(cur.conversation_key, ctx.a.conversation_key, 'getCurrentProject 应带会话键（§六 拼 user 用）')

    // 模拟重启：销毁 Worker → 新 client → 新 manager，只读元数据
    await main.dispose()
    clients.delete(main)
    const restarted = makeClient()
    const manager2 = makeManager(restarted)
    const afterRestart = await manager2.getCurrentProject()
    assertEq(afterRestart && afterRestart.id, ctx.a.id, '重启后当前 Project 应仍在')
    assertEq(await restarted.metaGet(CURRENT_PROJECT_META_KEY), ctx.a.id, '重启后元数据应可读')
    main = restarted
    manager = manager2
    return `pid 已重启；current_project_id=${ctx.a.id.slice(0, 8)}… 仍可读`
  })

  // ── P8 清空 / 非法切换 ──
  await r.check('P8', 'setCurrentProject(null) 清空；指向不存在 → NOT_FOUND（不制造悬空指针）', async () => {
    const miss = await outcome(manager.setCurrentProject('ghost-project'))
    assertEq(miss.code, 'NOT_FOUND', '设置不存在应回 NOT_FOUND')
    assertEq(await main.metaGet(CURRENT_PROJECT_META_KEY), ctx.a.id, '失败的切换不得改动元数据')

    const cleared = await manager.setCurrentProject(null)
    assertEq(cleared.currentProjectId, null, '清空应回 null')
    assertEq(await main.metaGet(CURRENT_PROJECT_META_KEY), null, '清空后 metaGet 应为 null')
    assertEq(await manager.getCurrentProject(), null, '清空后 getCurrentProject 应为 null')
    return 'NOT_FOUND 拒绝 + 清空生效'
  })

  // ── P9 删除：先目录后行 + 级联清空 + 不误伤其他 project ──
  await r.check('P9', 'delete：删目录 → 删行 → 级联清结构化数据；不动其他 Project', async () => {
    const victim = await manager.createProject({ name: '待删摄影' })
    const keeper = await manager.createProject({ name: '保留女装' })
    const now = Date.now()
    await main.request('businesses.create', {
      data: { id: `biz-${victim.id}`, project_id: victim.id, name: '待删店', created_at: now, updated_at: now }
    })
    await main.request('knowledge_items.create', {
      data: { id: `kb-${victim.id}`, project_id: victim.id, title: '价目表', type: 'text', created_at: now, updated_at: now }
    })
    await main.request('businesses.create', {
      data: { id: `biz-${keeper.id}`, project_id: keeper.id, name: '保留店', created_at: now, updated_at: now }
    })
    const dir = manager.projectDir(victim.id)
    assert(existsSync(dir), '删除前目录应存在')

    const res = await manager.deleteProject(victim.id)
    assertEq(res.dirRemoved, true, 'dirRemoved 应为 true')
    assertEq(res.rowDeleted, true, 'rowDeleted 应为 true')
    assert(!existsSync(dir), '目录应已物理删除')
    assertEq(await outcome(manager.getProject(victim.id)).then((o) => o.code), 'NOT_FOUND', '行应已删除')
    assertEq(await countRows(main, 'businesses', victim.id), 0, 'businesses 应被级联清空')
    assertEq(await countRows(main, 'knowledge_items', victim.id), 0, 'knowledge_items 应被级联清空')
    assertEq(await countRows(main, 'businesses', keeper.id), 1, '其他 Project 的 business 不应受影响')
    assert(existsSync(manager.projectDir(keeper.id)), '其他 Project 的目录不应受影响')
    ctx.keeper = keeper
    return `目录已删 + 行已删 + 级联 2 表清零；邻店数据完好`
  })

  // ── P10 幂等重试：目录已不存在仍能删行 ──
  await r.check('P10', 'delete 幂等：目录已不存在（上次删到一半）时直接删行', async () => {
    const half = await manager.createProject({ name: '半删店' })
    const dir = manager.projectDir(half.id)
    rmSync(dir, { recursive: true, force: true }) // 模拟「目录已删、行没删成」
    assert(!existsSync(dir), '前置：目录应已手工移除')
    const res = await manager.deleteProject(half.id)
    assertEq(res.dirRemoved, false, '目录本就不存在，dirRemoved 应为 false')
    assertEq(res.rowDeleted, true, '仍应删掉 DB 行')
    assertEq((await outcome(manager.getProject(half.id))).code, 'NOT_FOUND', '行应已删除')
    return '目录缺失不阻塞删行（幂等）'
  })

  // ── P11 删除当前 Project → current 清空 ──
  await r.check('P11', '删除当前 Project → 清空 current_project_id；删非当前则不动', async () => {
    const cur = await manager.createProject({ name: '当前店' })
    const other = await manager.createProject({ name: '非当前店' })
    await manager.setCurrentProject(cur.id)

    const resOther = await manager.deleteProject(other.id)
    assertEq(resOther.currentCleared, false, '删非当前 project 不应动 current')
    assertEq(await main.metaGet(CURRENT_PROJECT_META_KEY), cur.id, 'current 应保持不变')

    const resCur = await manager.deleteProject(cur.id)
    assertEq(resCur.currentCleared, true, '删当前 project 应清空 current')
    assertEq(await main.metaGet(CURRENT_PROJECT_META_KEY), null, 'current_project_id 应被清空')
    assertEq(await manager.getCurrentProject(), null, 'getCurrentProject 应为 null')
    return `currentCleared 语义正确：非当前=false，当前=true 且元数据已清空`
  })

  // ── P12 目录被占用 → 不删行 + DB_ERROR + 重试后成功 ──
  await r.check('P12', '目录被占用 → 不删行、报 DB_ERROR(project-dir-remove-failed)、释放后重试成功', async () => {
    const busy = await manager.createProject({ name: '被占用店' })
    const dir = manager.projectDir(busy.id)
    const now = Date.now()
    await main.request('businesses.create', {
      data: { id: `biz-${busy.id}`, project_id: busy.id, name: '占位', created_at: now, updated_at: now }
    })
    const lockedFile = join(dir, 'price-list.txt')
    writeFileSync(lockedFile, '套系价目表', 'utf-8')
    const marker = join(runDir, 'lock-marker.txt')
    const lock = await holdFileLock(lockedFile, marker)

    if (!lock.locked) {
      // 环境做不到 → 明确降级，不伪装成通过（Remediation 见 check 明细）
      return `DEGRADED：未能模拟目录占用（${lock.why}）；已跳过占用路径，其余语义由 P9/P10/P11 覆盖`
    }

    const logsBefore = logs.length
    const failed = await outcome(manager.deleteProject(busy.id))
    assertEq(failed.ok, false, '目录被占用时应报错（不得声称删除成功）')
    assertEq(failed.code, 'DB_ERROR', '应回 DB_ERROR（不新造错误码）')
    assertEq(failed.details && failed.details.reason, 'project-dir-remove-failed', 'details.reason 应标明目录删除失败')
    assertEq(failed.details && failed.details.path, dir, 'details.path 应带目录路径')
    assert(existsSync(dir), '目录应仍在')
    assertEq((await outcome(manager.getProject(busy.id))).ok, true, 'DB 行必须保留（先目录后行：目录失败即止）')
    assertEq(await countRows(main, 'businesses', busy.id), 1, '级联不得发生——行还在，子数据也应在')
    const retryLogs = logs.slice(logsBefore).filter((m) => /删除 Project 目录失败/.test(m))
    assert(retryLogs.length >= 1, `应记录重试日志（实际 ${retryLogs.length} 条）`)

    // 释放占用 → 幂等重试应成功
    releaseLock(lock)
    await sleep(600)
    const retried = await outcome(manager.deleteProject(busy.id))
    assertEq(retried.ok, true, `释放后重试应成功：${retried.message || ''}`)
    assert(!existsSync(dir), '重试后目录应已删除')
    assertEq(await countRows(main, 'businesses', busy.id), 0, '重试成功后级联应生效')
    return `占用期：code=${failed.code} reason=${failed.details.reason} 行保留；重试日志 ${retryLogs.length} 条；释放后删除成功`
  })

  // ── P13 删除不存在 → NOT_FOUND ──
  await r.check('P13', 'delete 不存在 → NOT_FOUND（不无声成功）', async () => {
    const out = await outcome(manager.deleteProject('ghost-project'))
    assertEq(out.ok, false, '应失败')
    assertEq(out.code, 'NOT_FOUND', '应回 NOT_FOUND')
    return `code=${out.code}`
  })

  // ── P14 conversation_key 生命周期：删除不复活旧键 ──
  await r.check('P14', 'conversation_key 生命周期：删除后同名重建 → 新键，绝不复活旧键', async () => {
    const first = await manager.createProject({ name: '同名品牌' })
    const firstKey = first.conversation_key
    await manager.deleteProject(first.id)
    const second = await manager.createProject({ name: '同名品牌' })
    assert(second.conversation_key !== firstKey, '新 Project 必须拿到新 conversation_key')
    assertEq(second.id === first.id, false, 'id 也应是新的')
    const list = await manager.listProjects()
    assert(!list.some((p) => p.conversation_key === firstKey), '已删 Project 的会话键不应出现在库里')
    return `旧键已随物理删除消失；新键 ${second.conversation_key.slice(0, 8)}…`
  })

  // ── P15 悬空 current_project_id 自愈 ──
  await r.check('P15', '悬空 current_project_id（指向已删行）→ 读取时自愈清空，不报错', async () => {
    await main.metaSet(CURRENT_PROJECT_META_KEY, 'ghost-project')
    const cur = await outcome(manager.getCurrentProject())
    assertEq(cur.ok, true, '自愈后不应抛错')
    assertEq(cur.value, null, '应返回 null')
    assertEq(await main.metaGet(CURRENT_PROJECT_META_KEY), null, '悬空指针应被清空')
    return '读取即自愈：返回 null 且元数据已清'
  })

  // ── P16 创建失败回滚目录（不留孤儿目录） ──
  await r.check('P16', 'create 失败（SETUP_REQUIRED）→ 回滚目录，不留孤儿目录', async () => {
    const badRoot = join(altRoot, 'setup')
    const badClient = makeClient({
      dbPath: join(badRoot, 'umi-claw.db'),
      backupDir: join(badRoot, 'backup'),
      nodePath: join(badRoot, 'runtime', 'node-win32-x64', 'node.exe')
    })
    const badManager = makeManager(badClient, join(badRoot, 'data'))
    const before = existsSync(join(badRoot, 'data', 'projects'))
      ? readdirSync(join(badRoot, 'data', 'projects')).length
      : 0
    const out = await outcome(badManager.createProject({ name: '不该留下目录' }))
    assertEq(out.ok, false, '应失败')
    assertEq(out.code, 'SETUP_REQUIRED', '应回 SETUP_REQUIRED（错误码不得被吞成 DB_ERROR）')
    const projectsRoot = join(badRoot, 'data', 'projects')
    const after = existsSync(projectsRoot) ? readdirSync(projectsRoot).length : 0
    assertEq(after, before, `失败后不应残留目录（${before} → ${after}）`)
    clients.delete(badClient)
    await badClient.dispose().catch(() => {})
    return `code=${out.code}；目录数 ${before} → ${after}`
  })

  // ── P17 全新 dataDir：目录按需创建 ──
  await r.check('P17', '全新 dataDir：create 按需创建 data/projects/<id>/（§三 目录策略）', async () => {
    const freshRoot = join(altRoot, 'fresh')
    const freshClient = makeClient({
      dbPath: join(freshRoot, 'umi-claw.db'),
      backupDir: join(freshRoot, 'backup')
    })
    const freshData = join(freshRoot, 'data')
    const freshManager = makeManager(freshClient, freshData)
    assertEq(existsSync(join(freshData, 'projects')), false, '前置：projects 目录不应存在')
    const created = await freshManager.createProject({ name: '全新店' })
    const expected = join(freshData, 'projects', created.id)
    assertEq(freshManager.projectDir(created.id), expected, 'projectDir 应按注入的 dataDir 解析')
    assert(existsSync(expected), '目录应按需创建')
    assertEq((await freshManager.listProjects()).length, 1, '空库应只有这 1 条')
    await freshClient.dispose()
    clients.delete(freshClient)
    return expected.replace(/^.*[\\/]data[\\/]/, 'data/')
  })

  // ── P18 IPC / preload / store 静态契约（无 electron 依赖，只能静态核对） ──
  await r.check('P18', 'IPC / preload / store 通道名与契约一致（静态核对，避免漂移）', async () => {
    const channels = [
      'marketing:project:list',
      'marketing:project:get',
      'marketing:project:create',
      'marketing:project:update',
      'marketing:project:delete',
      'marketing:context:getCurrentProject',
      'marketing:context:setCurrentProject'
    ]
    const ipcSrc = readFileSync(join(__dirname, '..', 'electron', 'main', 'ipc', 'marketing.ts'), 'utf-8')
    const preloadSrc = readFileSync(join(__dirname, '..', 'electron', 'preload', 'index.ts'), 'utf-8')
    for (const c of channels) {
      assert(ipcSrc.includes(`'${c}'`), `ipc/marketing.ts 应声明通道 ${c}`)
      assert(preloadSrc.includes(`'${c}'`), `preload/index.ts 应暴露通道 ${c}`)
    }
    assert(/MARKETING_PROJECT_CHANNELS/.test(ipcSrc) && /MARKETING_CONTEXT_CHANNELS/.test(ipcSrc), '应导出两个通道表')
    assert(/registerMarketingIpc\([\s\S]*projectManager/.test(ipcSrc), 'registerMarketingIpc 应接收 projectManager')

    const storeSrc = readFileSync(join(__dirname, '..', 'src', 'stores', 'marketing.ts'), 'utf-8')
    // 去掉行注释：注释里写明「禁止 message.includes()」，不能拿注释当违规证据
    const storeCode = storeSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const name of ['projects', 'currentProjectId', 'currentProject', 'loading', 'error', 'load', 'create', 'rename', 'remove', 'select']) {
      assert(new RegExp(`\\b${name}\\b`).test(storeSrc), `store 应暴露 ${name}`)
    }
    assert(!/error\.message\.includes\(|message\.includes\(/.test(storeCode), 'store 禁止用 message.includes() 判断错误（只看代码，注释不算）')
    assert(/case\s|\w+\s*:\s*'[^']*'/.test(storeSrc), 'store 应按 code 取文案')
    return `7 个通道名三处一致；store 契约 10 项齐全且未用 message.includes`
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
} finally {
  for (const c of [...clients]) {
    try {
      await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
}

const result = r.toJSON({
  bundle: managerPath,
  dataDir,
  nodePath,
  logSample: logs.slice(0, 12)
})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-project.json'), result)
console.log('结果已写入 test/accept-result-project.json')

if (ok && !process.argv.includes('--keep-tmp')) {
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.exit(ok ? 0 : 1)
