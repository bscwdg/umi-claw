// test/shooting.real-smoke.mjs —— 二阶段真网关冒烟（手动，不入常规回归）
// 全新临时库 + 造摄影商家 → 真 Gateway(127.0.0.1:3213) 生成一份分镜脚本，
// 验证 JSON 契约在真模型上成立（假网关测不出模型跑偏）。不碰真库、不花真商家额度。
// 用法：node test/shooting.real-smoke.mjs    （跑完临时目录自动删除）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  resolveNodePath,
  sleep,
  tmpDir,
  workerScriptPath
} from './_lib.mjs'

const nodePath = resolveNodePath()
const runDir = join(tmpDir, 'shooting-real-' + Date.now())
const dataDir = join(runDir, 'data')
const backupDir = join(dataDir, 'backup')
mkdirSync(dataDir, { recursive: true })
const dbPath = join(dataDir, 'umi-claw.db')

const EXTERNALS = ['mammoth', 'exceljs']
const contentPath = bundleEntry('electron/main/marketing/contentManager.ts', 'real-shoot-manager.mjs', { externals: EXTERNALS })
const contextPath = bundleEntry('electron/main/marketing/contextEngine.ts', 'real-shoot-context.mjs', { externals: EXTERNALS })
const businessPath = bundleEntry('electron/main/marketing/businessManager.ts', 'real-shoot-business.mjs', { externals: EXTERNALS })
const knowledgePath = bundleEntry('electron/main/marketing/knowledgeManager.ts', 'real-shoot-knowledge.mjs', { externals: EXTERNALS })
const projectPath = bundleEntry('electron/main/marketing/projectManager.ts', 'real-shoot-project.mjs')
const gatewayPath = bundleEntry('electron/main/gatewayClient.ts', 'real-shoot-gateway.mjs')
const databasePath = bundleEntry('electron/main/database/database.ts', 'real-shoot-database.mjs')

const contentMod = await import(pathToFileURL(contentPath).href)
const ctxMod = await import(pathToFileURL(contextPath).href)
const bizMod = await import(pathToFileURL(businessPath).href)
const knowMod = await import(pathToFileURL(knowledgePath).href)
const projMod = await import(pathToFileURL(projectPath).href)
const gwMod = await import(pathToFileURL(gatewayPath).href)
const dbMod = await import(pathToFileURL(databasePath).href)

const clients = []
const database = new dbMod.DatabaseClient({
  dbPath, backupDir, workerScriptPath, nodePath,
  subprocessName: 'db-worker-shooting-real', requestTimeoutMs: 60_000
})
clients.push(database)
try {
  const projects = projMod.createProjectManager({ database, dataDir, logger: (m) => console.log(m) })
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
  clients.push(gateway)
  const manager = contentMod.createContentManager({
    database, contextEngine, gateway, logger: (m) => console.log(m)
  })

  const project = await projects.createProject({ name: '冒烟·拾光摄影', industry: '摄影' })
  await business.upsertBusiness(project.id, {
    name: '拾光摄影工作室', city: '杭州',
    positioning: '轻奢外景纪实婚纱摄影，主打外景、旅拍',
    tone: '亲切专业', target_customer: '杭州备婚新人，25-35 岁，偏好自然纪实风格'
  })
  await knowledge.createKnowledge(project.id, {
    title: '套系价目表', type: 'text',
    content: '婚纱套系 5999 元，含 30 张精修；亲子套系 1999 元。'
  })

  console.log('--- 发起单路分镜脚本生成（真网关，耐心等）---')
  const t0 = Date.now()
  const run = await manager.generate(project.id, {
    platform: 'douyin',
    contentType: 'shooting_script',
    businessLine: 'photography',
    topic: '用 30-60 秒讲清 5999 婚纱套系'
  })
  for await (const d of run.streams[0].iterator) {
    /* 消费上屏 */
  }
  const settled = await run.streams[0].result
  console.log('--- done（' + (Date.now() - t0) / 1000 + 's）---')
  console.log(settled.deliverable)

  assertEq(typeof settled.deliverable, 'string', 'deliverable 渲染文本')
  assert(settled.deliverable.includes('镜头'), '渲染含分镜')

  const versions = await manager.listVersions(project.id, run.contentId)
  assertEq(versions.length, 1, '1 个版本行')
  const parsed = JSON.parse(versions[0].content)
  assertEq(typeof parsed.title, 'string', 'title')
  assert(parsed.title.length > 0, 'title 非空')
  assertEq(typeof parsed.hook, 'string', 'hook')
  assert(Array.isArray(parsed.shots), 'shots 数组')
  assert(parsed.shots.length >= 1 && parsed.shots.length <= 30, 'shots 1-30（实际 ' + parsed.shots.length + '）')
  for (const shot of parsed.shots) {
    assertEq(typeof shot.shot, 'string', 'shot 画面')
    assertEq(typeof shot.voiceover, 'string', 'voiceover 口播')
    assert(shot.durationSec >= 1 && shot.durationSec <= 300, 'durationSec 1-300（实际 ' + shot.durationSec + '）')
    assertEq(shot.index, parsed.shots.indexOf(shot) + 1, 'index 连续')
  }
  assertEq(typeof versions[0].rendered_content, 'string', '版本视图重渲染')
  assert(versions[0].prompt.includes('"shots"'), 'prompt 快照含 JSON 契约')

  const row = await manager.getContent(project.id, run.contentId)
  assertEq(row.content_type, 'shooting_script')
  assertEq(row.content, null, '不自动采用')

  console.log('\n✅ 真网关冒烟通过：JSON 契约、防护上限、版本/正文分离均成立')
} catch (e) {
  console.error('\n❌ 真网关冒烟失败:', e)
  process.exitCode = 1
} finally {
  for (const c of [...clients]) {
    try {
      if (typeof c.dispose === 'function') await c.dispose()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(200)
  if (!process.argv.includes('--keep-tmp')) {
    try {
      rmSync(runDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  process.exit(process.exitCode ?? 0)
}
