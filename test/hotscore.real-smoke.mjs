// test/hotscore.real-smoke.mjs —— Commit 12 真网关冒烟（手动，不入常规回归）
// 复制真实库到临时副本（73 条真热点）+ 造摄影商家 → 真 Gateway(127.0.0.1:3213) 跑两批评分。
// 用法：node test/hotscore.real-smoke.mjs    （跑完临时副本自动删除）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  __dirname,
  bundleEntry,
  resolveNodePath,
  tmpDir,
  workerScriptPath
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, 'hotscore-real-' + Date.now())
const dataDir = join(runDir, 'data')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'umi-claw.db')
const backupDir = join(dataDir, 'backup')
// WAL 模式：用 VACUUM INTO 取 .db + -wal 合并后的完整快照，避免漏数据
const { DatabaseSync } = await import('node:sqlite')
const src = new DatabaseSync(join(__dirname, '..', 'data', 'umi-claw.db'), { readOnly: true })
src.exec("VACUUM INTO '" + dbPath.replaceAll('\\', '/') + "'")
src.close()

const EXTERNALS = ['mammoth', 'exceljs']
const scorePath = bundleEntry('electron/main/marketing/hotScoreManager.ts', 'real-score-manager.mjs', { externals: EXTERNALS })
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'real-context-engine.mjs', { externals: EXTERNALS })
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'real-business-manager.mjs', { externals: EXTERNALS })
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'real-knowledge-manager.mjs', { externals: EXTERNALS })
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'real-project-manager.mjs')
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'real-gateway-client.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'real-database.mjs')

const scoreMod = await import(pathToFileURL(scorePath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const database = new dbMod.DatabaseClient({
  dbPath, backupDir, workerScriptPath, nodePath,
  subprocessName: 'db-worker-hotscore-real', requestTimeoutMs: 60_000
})
try {
  const projects = projMod.createProjectManager({ database, dataDir, logger: () => {} })
  const business = bizMod.createBusinessManager({ database, logger: () => {} })
  const watchlist = bizMod.createWatchlistManager({ database, logger: () => {} })
  const knowledge = knowMod.createKnowledgeManager({ database, dataDir, logger: () => {} })
  const contextEngine = ctxMod.createContextEngine({
    projectManager: projects, businessManager: business, knowledgeManager: knowledge,
    watchlistManager: watchlist, logger: () => {}
  })
  const gateway = gwMod.createGatewayClient({
    baseUrl: 'http://127.0.0.1:3213',
    token: 'https://github.com/bscwdg/umi-claw',
    models: { text: 'openclaw' },
    conversationKeyResolver: async (projectId) => (await projects.getProject(projectId)).conversation_key,
    logger: (m) => console.log('[gw]', m)
  })
  const manager = scoreMod.createHotScoreManager({
    database, contextEngine, gateway, logger: (m) => console.log(m)
  })

  const project = await projects.createProject({ name: '冒烟·光影婚纱摄影', industry: '摄影' })
  await business.upsertBusiness(project.id, {
    name: '光影婚纱摄影工作室', city: '杭州', positioning: '轻奢外景纪实婚纱摄影，主打外景、旅拍',
    tone: '亲切专业', target_customer: '杭州备婚新人，25-35 岁，偏好自然纪实风格'
  })
  await watchlist.addWatch(project.id, '杭州婚纱', 'industry')

  const t0 = Date.now()
  let last = null
  for (let batch = 1; ; batch += 1) {
    try {
      last = await manager.scoreBatch(project.id, 'xiaohongshu')
    } catch (e) {
      console.log('--- 第 ' + batch + ' 批失败（已落库批次保留）---', e.code || e.message)
      break
    }
    console.log('--- 第 ' + batch + ' 批 ---', JSON.stringify({ ...last, suggestion: last.suggestion && { title: last.suggestion.title, m: last.suggestion.matchScore, f: last.suggestion.platformFit } }))
    if (last.remaining <= 0 || last.scored === 0) break
  }
  const r1 = last, r2 = last

  const rows = await database.request('project_hot_topics.list', { where: { project_id: project.id, platform: 'xiaohongshu' }, limit: 5000 })
  const dist = { hot: 0, watch: 0, skip: 0 }
  for (const row of rows) {
    const tier = scoreMod.scoreTier(row.match_score, row.platform_fit)
    dist[tier] = (dist[tier] || 0) + 1
  }
  console.log('--- 档位分布（' + rows.length + ' 条已评）---', JSON.stringify(dist))
  const sample = rows.slice().sort((a, b) => (b.match_score + b.platform_fit) - (a.match_score + a.platform_fit)).slice(0, 3)
  for (const s of sample) {
    const topic = await database.request('hot_topics.get', { keys: { id: s.topic_id }, required: true })
    console.log('\n★', topic.title, '| match', s.match_score, 'fit', s.platform_fit)
    console.log('  reason:', s.reason)
    console.log('  angle:', s.content_angle)
    console.log('  timing:', s.lifecycle_advice)
  }
  const sug = (r2 || r1).suggestion
  if (sug) console.log('\n=== 今日建议 ===\n' + sug.title + '\n理由：' + sug.reason + '\n时机：' + sug.timing)
  console.log('\n总用时', ((Date.now() - t0) / 1000).toFixed(1) + 's')
} finally {
  await database.dispose().catch(() => {})
  rmSync(runDir, { recursive: true, force: true })
}
