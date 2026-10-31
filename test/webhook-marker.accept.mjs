/**
 * legacy webhook 迁移标记兜底 验收测试（node:test）
 *
 * 覆盖 4.0 5515ea5/10300f5 对 master 移植后的关键行为：
 *   - 纯函数：hasWebhookMigrationMarker / findLegacyWebhookChannels / applyWebhookMigrationMarker
 *   - 文件落盘：不存在/坏 JSON 不动作；无 legacyWebhook 时补 meta.migrations.webhookListeners=true；
 *     先备份（.webhook-marker-bak.<yyyyMMddHHmmss>）、保留 BOM/CRLF/结尾换行、幂等、无 tmp 残留
 *   - legacyWebhook 守卫：telegram/feishu/msteams/nextcloud-talk 有 legacyWebhook 时跳过补标记
 *   - 串行化：ensureWebhookMigrationMarkerFile 通过 serialize 注入挂到统一写入队列
 *   - openClawConfigWriter.runSerializedOpenClawConfigWrite：同一 config 路径的任务串行执行
 *   - 接线（静态断言）：configManager 走同一队列、两处首文件骨架带标记、clawManager 在
 *     syncOpenClawConfig 之后补标记
 *
 * 运行：node --test test/webhook-marker.accept.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const tmpDir = join(repoRoot, 'test', '.tmp')
const markerBundle = join(tmpDir, 'webhook-marker.mjs')
const writerBundle = join(tmpDir, 'openclaw-config-writer.mjs')

const esbuild = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
)

function bundle(entry, outfile) {
  if (existsSync(outfile)) return
  execFileSync(
    esbuild,
    [
      join(repoRoot, 'electron', 'main', entry),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      `--outfile=${outfile}`
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  )
}

bundle('openclawWebhookMarker.ts', markerBundle)
bundle('openClawConfigWriter.ts', writerBundle)

const {
  WEBHOOK_MIGRATION_FLAG,
  HISTORICAL_WEBHOOK_CHANNELS,
  hasWebhookMigrationMarker,
  findLegacyWebhookChannels,
  applyWebhookMigrationMarker,
  ensureWebhookMigrationMarkerFile
} = await import(pathToFileURL(markerBundle).href)

const { runSerializedOpenClawConfigWrite } = await import(pathToFileURL(writerBundle).href)

/** 每个用例一个独立临时目录（不用真实 data/） */
function makeCaseDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claw-marker-'))
  return {
    dir,
    file: join(dir, 'openclaw.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

const BASE_CONFIG = {
  gateway: { mode: 'local' },
  channels: { feishu: { appId: 'a', appSecret: 'b' } },
  skills: { entries: {} }
}

test('常量：官方标记键与历史渠道清单', () => {
  assert.equal(WEBHOOK_MIGRATION_FLAG, 'webhookListeners')
  assert.deepEqual([...HISTORICAL_WEBHOOK_CHANNELS], [
    'telegram',
    'feishu',
    'msteams',
    'nextcloud-talk'
  ])
})

test('纯函数：apply 只增补 meta.migrations.webhookListeners，且幂等', () => {
  const config = structuredClone(BASE_CONFIG)
  const first = applyWebhookMigrationMarker(config)
  assert.equal(first.changed, true)
  assert.equal(first.config.meta.migrations.webhookListeners, true)
  assert.deepEqual(first.config.channels, BASE_CONFIG.channels)

  const second = applyWebhookMigrationMarker(first.config)
  assert.equal(second.changed, false)
  assert.equal(second.config.meta.migrations.webhookListeners, true)
})

test('纯函数：已有其它迁移键时保留，不被覆盖', () => {
  const config = {
    ...structuredClone(BASE_CONFIG),
    meta: { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: '1.2.3' }
  }
  const { changed } = applyWebhookMigrationMarker(config)
  assert.equal(changed, true)
  assert.equal(config.meta.migrations.webhookListeners, true)
  assert.equal(config.meta.migrations.modelPolicyAllowlist, true)
  assert.equal(config.meta.lastTouchedVersion, '1.2.3')
})

test('纯函数：hasWebhookMigrationMarker 只认严格 true', () => {
  assert.equal(hasWebhookMigrationMarker({}), false)
  assert.equal(hasWebhookMigrationMarker({ meta: {} }), false)
  assert.equal(hasWebhookMigrationMarker({ meta: { migrations: {} } }), false)
  assert.equal(hasWebhookMigrationMarker({ meta: { migrations: { webhookListeners: 'true' } } }), false)
  assert.equal(hasWebhookMigrationMarker({ meta: { migrations: { webhookListeners: true } } }), true)
})

test('纯函数：legacyWebhook 深度扫描（含 accounts.<id> 与数组）', () => {
  assert.deepEqual(findLegacyWebhookChannels({}), [])
  assert.deepEqual(findLegacyWebhookChannels({ channels: {} }), [])
  assert.deepEqual(
    findLegacyWebhookChannels({
      channels: { telegram: { legacyWebhook: { url: 'x' } } }
    }),
    ['telegram']
  )
  assert.deepEqual(
    findLegacyWebhookChannels({
      channels: {
        feishu: { accounts: { default: { legacyWebhook: { path: '/hook' } } } },
        msteams: { list: [{ legacyWebhook: 1 }] },
        'nextcloud-talk': { token: 't' }
      }
    }),
    ['feishu', 'msteams']
  )
})

test('文件：不存在 → 不动作、不建备份', async () => {
  const c = makeCaseDir()
  try {
    const res = await ensureWebhookMigrationMarkerFile(c.file)
    assert.deepEqual(res, { changed: false })
    assert.deepEqual(readdirSync(c.dir), [])
  } finally {
    c.cleanup()
  }
})

test('文件：无标记 → 补标记、备份 14 位时间戳、无 tmp 残留', async () => {
  const c = makeCaseDir()
  try {
    writeFileSync(c.file, JSON.stringify(BASE_CONFIG, null, 2), 'utf-8')
    const now = () => Date.UTC(2026, 9, 31, 9, 5, 7) // 任意时刻
    const res = await ensureWebhookMigrationMarkerFile(c.file, { now })

    assert.equal(res.changed, true)
    assert.ok(res.backupPath, '应返回备份路径')
    assert.match(res.backupPath, /openclaw\.json\.webhook-marker-bak\.\d{14}$/)

    const written = JSON.parse(readFileSync(c.file, 'utf-8'))
    assert.equal(written.meta.migrations.webhookListeners, true)
    assert.deepEqual(written.channels, BASE_CONFIG.channels)
    assert.deepEqual(written.skills, BASE_CONFIG.skills)

    const names = readdirSync(c.dir).sort()
    assert.equal(names.filter((n) => n.includes('.webhook-marker-tmp-')).length, 0, '不应残留 tmp')
    assert.equal(names.filter((n) => n.includes('.webhook-marker-bak.')).length, 1, '应恰好一份备份')
  } finally {
    c.cleanup()
  }
})

test('文件：备份内容 = 改写前原文件（可回滚）', async () => {
  const c = makeCaseDir()
  try {
    const original = JSON.stringify(BASE_CONFIG, null, 2)
    writeFileSync(c.file, original, 'utf-8')
    const res = await ensureWebhookMigrationMarkerFile(c.file)
    assert.equal(res.changed, true)
    assert.equal(readFileSync(res.backupPath, 'utf-8'), original)
  } finally {
    c.cleanup()
  }
})

test('文件：保留 BOM / CRLF / 结尾换行', async () => {
  const c = makeCaseDir()
  try {
    const crlf = JSON.stringify(BASE_CONFIG, null, 2).replace(/\n/g, '\r\n')
    const raw = `\uFEFF${crlf}\r\n`
    writeFileSync(c.file, raw, 'utf-8')

    const res = await ensureWebhookMigrationMarkerFile(c.file)
    assert.equal(res.changed, true)

    const after = readFileSync(c.file, 'utf-8')
    assert.ok(after.startsWith('\uFEFF'), 'BOM 应保留')
    assert.ok(after.endsWith('\r\n'), '结尾 CRLF 应保留')
    assert.ok(after.includes('\r\n'), '应使用 CRLF')
    assert.equal(/[^\r]\n/.test(after), false, '不应混入裸 LF')
    assert.equal(JSON.parse(after.replace(/^\uFEFF/, '')).meta.migrations.webhookListeners, true)
  } finally {
    c.cleanup()
  }
})

test('文件：无结尾换行时不擅自添加', async () => {
  const c = makeCaseDir()
  try {
    writeFileSync(c.file, JSON.stringify(BASE_CONFIG, null, 2), 'utf-8')
    await ensureWebhookMigrationMarkerFile(c.file)
    const after = readFileSync(c.file, 'utf-8')
    assert.equal(after.endsWith('\n'), false)
  } finally {
    c.cleanup()
  }
})

test('文件：已带标记 → 零写入、不重复备份（幂等）', async () => {
  const c = makeCaseDir()
  try {
    const withMarker = {
      ...structuredClone(BASE_CONFIG),
      meta: { migrations: { webhookListeners: true } }
    }
    const raw = JSON.stringify(withMarker, null, 2)
    writeFileSync(c.file, raw, 'utf-8')

    const first = await ensureWebhookMigrationMarkerFile(c.file)
    assert.deepEqual(first, { changed: false })
    assert.equal(readFileSync(c.file, 'utf-8'), raw, '文件内容不应变化')
    assert.equal(readdirSync(c.dir).length, 1, '不应产生备份文件')
  } finally {
    c.cleanup()
  }
})

test('文件：有 legacyWebhook → 跳过补标记，交回官方迁移', async () => {
  const c = makeCaseDir()
  try {
    const config = {
      ...structuredClone(BASE_CONFIG),
      channels: {
        ...structuredClone(BASE_CONFIG.channels),
        'nextcloud-talk': { accounts: { main: { legacyWebhook: { path: '/x' } } } }
      }
    }
    const raw = JSON.stringify(config, null, 2)
    writeFileSync(c.file, raw, 'utf-8')

    const res = await ensureWebhookMigrationMarkerFile(c.file)
    assert.equal(res.changed, false)
    assert.deepEqual(res.skippedLegacyChannels, ['nextcloud-talk'])
    assert.equal(readFileSync(c.file, 'utf-8'), raw, '有 legacyWebhook 时不得改写文件')
    assert.equal(readdirSync(c.dir).length, 1, '不应产生备份文件')
  } finally {
    c.cleanup()
  }
})

test('文件：坏 JSON → 不动作并给出 error', async () => {
  const c = makeCaseDir()
  try {
    const raw = '{ not json'
    writeFileSync(c.file, raw, 'utf-8')
    const res = await ensureWebhookMigrationMarkerFile(c.file)
    assert.equal(res.changed, false)
    assert.ok(res.error)
    assert.equal(readFileSync(c.file, 'utf-8'), raw)
  } finally {
    c.cleanup()
  }
})

test('文件：顶层不是对象 → 不动作并给出 error', async () => {
  const c = makeCaseDir()
  try {
    writeFileSync(c.file, '[1,2,3]', 'utf-8')
    const res = await ensureWebhookMigrationMarkerFile(c.file)
    assert.equal(res.changed, false)
    assert.ok(res.error)
  } finally {
    c.cleanup()
  }
})

test('串行化：serialize 注入被调用一次，且任务在队列内执行', async () => {
  const c = makeCaseDir()
  try {
    writeFileSync(c.file, JSON.stringify(BASE_CONFIG, null, 2), 'utf-8')
    const events = []
    const res = await ensureWebhookMigrationMarkerFile(c.file, {
      serialize: async (task) => {
        events.push('enter')
        const out = await task()
        events.push('exit')
        return out
      }
    })
    assert.equal(res.changed, true)
    assert.deepEqual(events, ['enter', 'exit'])
  } finally {
    c.cleanup()
  }
})

test('runSerializedOpenClawConfigWrite：同一 config 路径串行、结果透传', async () => {
  const cfgPath = join(tmpdir(), 'claw-virtual-openclaw.json')
  const order = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const first = runSerializedOpenClawConfigWrite(cfgPath, async () => {
    order.push('a-start')
    await sleep(40)
    order.push('a-end')
    return 'A'
  })
  const second = runSerializedOpenClawConfigWrite(cfgPath, async () => {
    order.push('b-start')
    await sleep(5)
    order.push('b-end')
    return 'B'
  })

  const [a, b] = await Promise.all([first, second])
  assert.equal(a, 'A')
  assert.equal(b, 'B')
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'], '第二批必须等第一批结束')
})

test('runSerializedOpenClawConfigWrite：支持同步任务与异常透传', async () => {
  const cfgPath = join(tmpdir(), 'claw-virtual-openclaw-2.json')
  assert.equal(await runSerializedOpenClawConfigWrite(cfgPath, () => 42), 42)
  await assert.rejects(
    runSerializedOpenClawConfigWrite(cfgPath, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
})

test('接线：configManager 的标记补写挂在官方写入串行队列上', () => {
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'configManager.ts'), 'utf-8')
  assert.match(src, /async ensureWebhookMigrationMarker\(\)/)
  assert.match(src, /runSerializedOpenClawConfigWrite\(this\.openClawConfigPath/)
  assert.match(src, /ensureWebhookMigrationMarkerFile\(this\.openClawConfigPath\)/)
  // 首文件骨架：按 legacyWebhook 守卫补标记（不再无条件 delete meta）
  assert.match(src, /findLegacyWebhookChannels\(existingConfig\)/)
  assert.equal(
    /delete existingConfig\.meta\s*\n/.test(src),
    false,
    '首文件骨架不应再无脑删 meta'
  )
})

test('接线：downloadManager 首文件骨架同口径带标记', () => {
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'downloadManager.ts'), 'utf-8')
  assert.match(src, /findLegacyWebhookChannels\(fullSecureConfig\)/)
  assert.match(src, /applyWebhookMigrationMarker\(/)
})

test('接线：clawManager 在 syncOpenClawConfig 之后、spawn 之前补标记', () => {
  const src = readFileSync(join(repoRoot, 'electron', 'main', 'clawManager.ts'), 'utf-8')
  const syncAt = src.indexOf('await this.configManager.syncOpenClawConfig()')
  const markerAt = src.indexOf('ensureWebhookMigrationMarker()')
  const spawnAt = src.indexOf('this.process = spawn(nodePath')
  assert.ok(syncAt > 0, '应调用 syncOpenClawConfig')
  assert.ok(markerAt > 0, '应调用 ensureWebhookMigrationMarker')
  assert.ok(spawnAt > 0, '应有 spawn')
  assert.ok(syncAt < markerAt, '标记必须在 syncOpenClawConfig 之后')
  assert.ok(markerAt < spawnAt, '标记必须在 spawn 之前')
  assert.match(src, /skippedLegacyChannels/)
})
