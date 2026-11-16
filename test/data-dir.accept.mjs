// test/data-dir.accept.mjs —— 5.0 数据目录覆盖验收（纯 Node，零 npm 依赖）
//
// 覆盖：
//   D1 纯函数优先级：CLAW_DATA_DIR > data-location 覆盖 > 便携模式 > appData 默认 > dev；
//   D2 路径校验：空/相对/非法/指向文件拒绝；不存在则创建；可写探针真的落盘又清掉；
//   D3 覆盖文件读写 round-trip：schema、原子写、坏 JSON/版本不符/相对路径一律按无覆盖；
//   D4 dataDir IPC 行为：信封（含「取消是正常路径」）、错误码、重启只调一次、通道名；
//   D5 生产接线（静态）：configManager 走覆盖解析、index 注册 registrar、preload/Setup 有入口，
//      并锁「立即重启 = 优雅清理后 relaunch」（app.exit 不触发 before-quit）与启动失败 .catch 兜底；
//   D6 覆盖目录不可用（移动盘/U 盘未就绪）：降级到下一优先级并带 overrideUnusable，应用不崩。
//
// 用法：node test/data-dir.accept.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Recorder,
  __dirname,
  assert,
  assertDeepEq,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  writeJson
} from './_lib.mjs'

const r = new Recorder('5.0 · 数据目录覆盖（dataDirBootstrap + dataDir IPC）')

const bootstrap = await import(
  pathToFileURL(bundleEntry('electron/main/dataDirBootstrap.ts', 'data-dir-bootstrap.mjs')).href
)
const {
  DATA_LOCATION_FILE,
  dataLocationFilePath,
  normalizeDataDirCandidate,
  resolveDataDirOverride,
  resolveDataDirWithUsableOverride,
  readDataDirOverride,
  validateDataDir,
  writeDataDirOverride,
  clearDataDirOverride
} = bootstrap

const dataDirIpc = await import(
  pathToFileURL(bundleEntry('electron/main/ipc/host/dataDir.ts', 'data-dir-ipc.mjs')).href
)
const { DATA_DIR_CHANNELS, registerDataDirIpc } = dataDirIpc

const tmpRoot = mkdtempSync(join(tmpdir(), 'umi-datadir-'))
const userData = join(tmpRoot, 'user-data')

/** 路径规整后比较（Windows 盘符大小写/分隔符差异不该让断言假红） */
const norm = (p) => String(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

// ── D1 优先级 ───────────────────────────────────────────────────────────────
await r.check('D1', '优先级：env > 覆盖 > 便携 > appData 默认 > dev；空/相对候选被忽略', async () => {
  const candidates = {
    env: join(tmpRoot, 'A-env'),
    override: join(tmpRoot, 'B-override'),
    portable: join(tmpRoot, 'C-portable'),
    appData: join(tmpRoot, 'D-appdata'),
    dev: join(tmpRoot, 'E-dev')
  }
  assertEq(resolveDataDirOverride(candidates).source, 'env', '有 env 时 env 最高')
  assertEq(resolveDataDirOverride({ ...candidates, env: '' }).source, 'override', 'env 空串被忽略 → 覆盖胜出')
  assertEq(
    resolveDataDirOverride({ ...candidates, env: null, override: '' }).source,
    'portable',
    '覆盖缺失 → 便携模式'
  )
  assertEq(
    resolveDataDirOverride({ ...candidates, env: null, override: null, portable: null }).source,
    'appData',
    '便携不成立 → appData 默认'
  )
  const dev = resolveDataDirOverride({
    env: null,
    override: null,
    portable: null,
    appData: null,
    dev: candidates.dev
  })
  assertEq(dev.source, 'dev', '开发环境默认')
  assertEq(norm(dev.dataDir), norm(candidates.dev), 'dev 路径')

  // 相对路径不能当数据目录（相对 cwd 的路径会随启动方式漂移）
  const relative = resolveDataDirOverride({
    env: 'data',
    override: 'C:relative',
    portable: null,
    appData: candidates.appData,
    dev: null
  })
  assertEq(relative.source, 'appData', '相对路径候选被忽略，回落到下一个合法来源')
  assertEq(normalizeDataDirCandidate('  '), null, '空白字符串无效')
  assertEq(normalizeDataDirCandidate(42), null, '非字符串无效')
  assertEq(normalizeDataDirCandidate(null), null, 'null 无效')
  assert(normalizeDataDirCandidate('D:\\umi data').endsWith('umi data'), '含空格绝对路径合法')
  return '四级优先级 + 非法候选回落正确'
})

// ── D2 路径校验 ─────────────────────────────────────────────────────────────
await r.check('D2', '路径校验：空/相对/指向文件拒绝；不存在则创建；可写探针不残留', async () => {
  assertEq(validateDataDir('').ok, false, '空路径拒绝')
  assertEq(validateDataDir('   ').ok, false, '全空白拒绝')
  assertEq(validateDataDir(undefined).ok, false, 'undefined 拒绝')
  const rel = validateDataDir('relative/data-dir')
  assertEq(rel.ok, false, '相对路径拒绝')
  assert(/绝对路径/.test(rel.error), '错误信息可诊断：' + rel.error)

  // 指向一个文件：必须拒绝（直接当 dataDir 用会在建 config 时炸得很晚）
  const filePath = join(tmpRoot, 'not-a-dir.txt')
  writeFileSync(filePath, 'x', 'utf8')
  const fileResult = validateDataDir(filePath)
  assertEq(fileResult.ok, false, '指向文件拒绝')
  assert(/不是目录/.test(fileResult.error), '错误信息点名不是目录：' + fileResult.error)

  // 不存在 → 自动创建（递归）
  const nested = join(tmpRoot, 'new-root', 'a', 'b')
  const created = validateDataDir(nested)
  assertEq(created.ok, true, '不存在目录可创建：' + (created.ok ? '' : created.error))
  assert(existsSync(nested), '目录真的创建了')
  assertEq(validateDataDir(nested).ok, true, '已存在目录通过')
  const leftovers = readdirSync(nested).filter((name) => name.startsWith('.umi-data-dir-probe-'))
  assertEq(leftovers.length, 0, '可写探针文件被清掉（不污染用户目录）')
  return '三类拒绝 + 创建/可写校验'
})

// ── D3 覆盖文件读写 round-trip ──────────────────────────────────────────────
await r.check('D3', '覆盖文件：写入 schema=1 + 读回；坏 JSON/版本不符/相对路径按无覆盖', async () => {
  const first = join(tmpRoot, 'data-one')
  const second = join(tmpRoot, 'data-two')
  const written = writeDataDirOverride(userData, first)
  assertEq(written.ok, true, '写入成功：' + (written.ok ? '' : written.error))
  const file = dataLocationFilePath(userData)
  assert(existsSync(file), '覆盖文件位于 <userData>/' + DATA_LOCATION_FILE)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assertEq(raw.schema, 1, '写盘带 schema=1')
  assertEq(typeof raw.updatedAt, 'number', '写盘带 updatedAt')
  assertEq(norm(readDataDirOverride(userData)), norm(first), '读回同一目录')

  // 覆盖写：第二次选择覆盖第一次
  assertEq(writeDataDirOverride(userData, second).ok, true, '第二次写入成功')
  assertEq(norm(readDataDirOverride(userData)), norm(second), '读回新目录')
  assertEq(existsSync(`${file}.tmp`), false, '原子写不残留 .tmp')

  // 无效写入：不改变已保存的覆盖
  const badWrite = writeDataDirOverride(userData, 'relative-dir')
  assertEq(badWrite.ok, false, '相对路径写入被拒绝')
  assertEq(norm(readDataDirOverride(userData)), norm(second), '拒绝写入时旧覆盖保持不变')

  // 读的健壮性：坏内容一律按「没有覆盖」而不是抛错（否则启动会被一份坏文件卡死）
  const cases = [
    ['bad-json', '{ 坏 JSON'],
    ['wrong-schema', JSON.stringify({ schema: 99, dataDir: first })],
    ['relative-dir', JSON.stringify({ schema: 1, dataDir: 'relative/dir' })],
    ['non-string', JSON.stringify({ schema: 1, dataDir: 42 })],
    ['empty', JSON.stringify({ schema: 1, dataDir: '' })],
    ['null', 'null']
  ]
  const freshUserData = join(tmpRoot, 'user-data-read-cases')
  mkdirSync(freshUserData, { recursive: true })
  for (const [name, content] of cases) {
    writeFileSync(dataLocationFilePath(freshUserData), content, 'utf8')
    assertEq(readDataDirOverride(freshUserData), null, `${name} 应回落 null（无覆盖）`)
  }
  // 文件不存在
  assertEq(readDataDirOverride(join(tmpRoot, 'no-such-user-data')), null, '文件不存在 → null')

  // 清除后回到无覆盖
  assertEq(clearDataDirOverride(userData).ok, true, '清除成功')
  assertEq(readDataDirOverride(userData), null, '清除后无覆盖')
  assertEq(clearDataDirOverride(userData).ok, true, '重复清除幂等')
  return 'round-trip + 六类脏文件回落'
})

// ── D4 dataDir IPC 行为 ────────────────────────────────────────────────────
await r.check('D4', 'dataDir IPC：信封语义 / 取消是正常路径 / 错误码 / 重启只调一次', async () => {
  const handlers = new Map()
  const ipc = {
    handle(channel, listener) {
      assert(!handlers.has(channel), '通道重复注册：' + channel)
      handlers.set(channel, listener)
    }
  }
  const calls = []
  let chooseResult = null
  let chooseError = null
  let setResult = { ok: true, dataDir: '/new/data' }
  const deps = {
    getCurrent: () => '/old/data',
    getOverride: () => null,
    getOverrideUnusable: () => null,
    chooseDirectory: async (defaultPath) => {
      calls.push(['chooseDirectory', defaultPath])
      if (chooseError) throw chooseError
      return chooseResult
    },
    setOverride: (dir) => {
      calls.push(['setOverride', dir])
      return setResult
    },
    restart: () => calls.push(['restart'])
  }
  registerDataDirIpc(ipc, deps)

  assertEq(handlers.size, 3, 'dataDir.ts 恰好注册 3 个通道')
  assertDeepEq(
    {
      get: DATA_DIR_CHANNELS.get,
      choose: DATA_DIR_CHANNELS.choose,
      restart: DATA_DIR_CHANNELS.restart
    },
    {
      get: 'config:dataDir:get',
      choose: 'config:dataDir:choose',
      restart: 'config:dataDir:restart'
    },
    '通道名符合 <domain>:<entity>:<method> 且小写 domain'
  )

  // 查询：当前目录 + 未生效覆盖 + 覆盖是否本次不可用
  assertDeepEq(
    await handlers.get('config:dataDir:get')(null),
    { ok: true, data: { current: '/old/data', override: null, overrideUnusable: null } },
    'get 返回当前目录、覆盖状态与可用性'
  )

  // 取消：ok:true + data:null（不是错误，UI 不弹错误）
  assertDeepEq(
    await handlers.get('config:dataDir:choose')(null),
    { ok: true, data: null },
    '取消目录选择是正常路径'
  )
  assertEq(calls.filter((c) => c[0] === 'setOverride').length, 0, '取消时不写入覆盖')

  // 选择成功
  chooseResult = '/new/data'
  const chosen = await handlers.get('config:dataDir:choose')(null)
  assertDeepEq(
    chosen,
    { ok: true, data: { dataDir: '/new/data', previous: '/old/data', requiresRestart: true } },
    '选择成功返回新目录 + 需重启'
  )
  assertDeepEq(
    calls.find((c) => c[0] === 'chooseDirectory'),
    ['chooseDirectory', '/old/data'],
    '对话框以当前目录为默认位置'
  )

  // 选到同一目录：不需要重启
  setResult = { ok: true, dataDir: '/old/data' }
  assertEq(
    (await handlers.get('config:dataDir:choose')(null)).data.requiresRestart,
    false,
    '同一目录不要求重启'
  )

  // 校验失败：按错误码回信封（渲染端按 code 分支，不读 message）
  setResult = { ok: false, code: 'VALIDATION_ERROR', error: '数据目录不可写：EACCES' }
  assertDeepEq(
    await handlers.get('config:dataDir:choose')(null),
    { ok: false, error: { code: 'VALIDATION_ERROR', message: '数据目录不可写：EACCES' } },
    '写覆盖失败回错误信封'
  )

  // 对话框本身抛错：不能把英文 invoke 异常直接甩给渲染端
  chooseError = new Error('dialog boom')
  const dialogFail = await handlers.get('config:dataDir:choose')(null)
  assertEq(dialogFail.ok, false, '对话框异常回信封')
  assertEq(dialogFail.error.code, 'DB_ERROR', '未知异常兜底 DB_ERROR')
  assert(/dialog boom/.test(dialogFail.error.message), '错误信息保留原因')

  // 重启：只调一次，回执先返回（真正的 exit 由主进程延迟执行）
  assertDeepEq(
    await handlers.get('config:dataDir:restart')(null),
    { ok: true, data: { restarted: true } },
    'restart 回信封'
  )
  assertEq(calls.filter((c) => c[0] === 'restart').length, 1, 'restart 只调用一次')
  return '3 通道信封语义全覆盖'
})

// ── D5 生产接线（静态） ────────────────────────────────────────────────────
await r.check('D5', '生产接线：configManager 走覆盖、index 注册 registrar、preload/Setup 有入口', async () => {
  const cfgSrc = readFileSync(join(repoRoot, 'electron', 'main', 'configManager.ts'), 'utf8')
  assert(/resolveDataDirWithUsableOverride/.test(cfgSrc), 'configManager 用可用性降级解析覆盖目录')
  assert(/readDataDirOverride/.test(cfgSrc), 'configManager 读 data-location 覆盖')
  assert(/getPath\('userData'\)/.test(cfgSrc), '覆盖文件定位在 userData')
  assert(/getDataDirOverrideUnusable/.test(cfgSrc), 'configManager 暴露不可用覆盖目录给环境页')
  assert(/已保存的数据目录当前不可用/.test(cfgSrc), '不可用覆盖目录要有明确告警日志')

  const hostSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf8')
  assert(/registerDataDirIpc\(\s*ipcMain/.test(hostSrc), 'index.ts 注册 dataDir IPC')
  assert(/writeDataDirOverride\(/.test(hostSrc), 'index.ts 写入覆盖文件')
  assert(/showOpenDialog\(/.test(hostSrc), '选择目录走主进程 dialog')

  // P1（独立对抗审查）：「立即重启」不能裸 app.exit(0)——app.exit 不触发 before-quit，
  // 会跳过插件 disposeHost/flushConfig/disposeDb、终端 killAll、abortRegistry、
  // subprocessRegistry、clawManager.handleAppQuit，可能残留 worker/网关并丢未落盘配置。
  // 锁两件事：① 有可复用的幂等清理入口；② restart 段里顺序必须是 延迟 → 清理 → relaunch → exit。
  assert(/performQuitCleanup/.test(hostSrc), 'index.ts 提供可复用的退出清理入口 performQuitCleanup')
  assert(
    /function performQuitCleanup\(\): Promise<void>/.test(hostSrc),
    '退出清理抽成 performQuitCleanup()（幂等、不含最后的 app.quit）'
  )
  const restartAt = hostSrc.indexOf('restart: () => {')
  assert(restartAt >= 0, 'index.ts 应能找到 registerDataDirIpc 的 restart 回调')
  const restartSlice = hostSrc.slice(restartAt, restartAt + 1200)
  assert(
    /setTimeout\([\s\S]{0,400}performQuitCleanup\(\)/.test(restartSlice),
    '重启必须先延迟让 IPC 回执送达，再走 performQuitCleanup'
  )
  assert(
    /performQuitCleanup\(\)[\s\S]{0,160}app\.relaunch\(\)[\s\S]{0,160}app\.exit\(0\)/.test(
      restartSlice
    ),
    '重启路径顺序必须是 清理 → app.relaunch() → app.exit(0)（直接 exit 会跳过 before-quit 清理）'
  )
  assert(
    !/setTimeout\([\s\S]{0,60}app\.relaunch\(\)/.test(restartSlice),
    '不得再出现「延迟后直接 relaunch」的旧写法（必须先 performQuitCleanup）'
  )
  assert(/dataDirRestartPending/.test(hostSrc), '重启要有连点防护（只允许触发一次 relaunch）')
  // 正常退出也走同一份清理：before-quit 里 preventDefault 后 performQuitCleanup → app.quit
  assert(
    /app\.on\('before-quit'[\s\S]{0,800}performQuitCleanup\(\)\.finally\(\(\) => app\.quit\(\)\)/.test(
      hostSrc
    ),
    'before-quit 必须先 performQuitCleanup() 再 app.quit()（Electron 不 await async 监听器）'
  )
  // 清理体不能自己 app.quit()：否则重启路径会在 relaunch 前被 quit 抢先退出
  const cleanupAt = hostSrc.indexOf('async function runQuitCleanupSteps')
  assert(cleanupAt >= 0, '应能找到 runQuitCleanupSteps（清理步骤本体）')
  const cleanupSlice = hostSrc.slice(cleanupAt, cleanupAt + 6000)
  assert(!/app\.quit\(\)/.test(cleanupSlice), '清理步骤本体不得调用 app.quit()（由调用方决定 quit/relaunch）')
  assert(/quitCleanupDone = true/.test(cleanupSlice), '清理结束（含异常）必须标记 quitCleanupDone')

  // 启动链兜底（独立对抗审查 P1-2）：whenReady 链尾 .catch → 系统对话框报错 + 非 0 退出，
  // 避免初始化异常时「无窗口静默起不来」。
  assert(
    /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\}\)\.catch\(/.test(hostSrc),
    'app.whenReady().then(...) 链尾必须有 .catch 兜底'
  )
  assert(
    /dialog\.showErrorBox\(\s*'启动失败'/.test(hostSrc),
    '启动失败要 dialog.showErrorBox 提示（含原因/日志路径）'
  )
  assert(/app\.exit\(1\)/.test(hostSrc), '启动失败必须以非 0 退出（app.exit(1)）')

  const preloadSrc = readFileSync(join(repoRoot, 'electron', 'preload', 'index.ts'), 'utf8')
  for (const token of [
    "'config:dataDir:get'",
    "'config:dataDir:choose'",
    "'config:dataDir:restart'"
  ]) {
    assert(preloadSrc.includes(token), 'preload 暴露 ' + token)
  }
  assert(/getDataDirInfo:/.test(preloadSrc), 'preload 暴露 config.getDataDirInfo()')
  assert(/chooseDataDir:/.test(preloadSrc), 'preload 暴露 config.chooseDataDir()')
  assert(/restartApp:/.test(preloadSrc), 'preload 暴露 config.restartApp()')

  const setupSrc = readFileSync(join(repoRoot, 'src', 'views', 'Setup.vue'), 'utf8')
  assert(/更改…/.test(setupSrc), 'Setup 数据目录卡有「更改…」')
  assert(/立即重启/.test(setupSrc), 'Setup 有「立即重启」')
  assert(/需重启生效；新目录为空，旧数据仍在原目录/.test(setupSrc), '提示需重启 + 旧数据仍在原目录')
  assert(/config\.chooseDataDir/.test(setupSrc), 'Setup 调 config.chooseDataDir')
  assert(/config\.restartApp/.test(setupSrc), 'Setup 调 config.restartApp')
  assert(/config\.getDataDirInfo/.test(setupSrc), 'Setup 读覆盖状态（重进页面能恢复待重启提示）')
  assert(/overrideUnusable/.test(setupSrc), 'Setup 区分「覆盖目录不可用已临时回退」与「待重启」')
  assert(/当前不可用（磁盘未连接或路径无效）/.test(setupSrc), 'Setup 对不可用覆盖目录有可读提示')
  return 'configManager / index / preload / Setup 全接线'
})

// ── D6 覆盖目录不可用：降级到下一优先级，不让应用起不来 ────────────────────
await r.check('D6', '覆盖目录不可用（移动盘未就绪）→ 降级下一优先级并保留 overrideUnusable', async () => {
  const env = join(tmpRoot, 'E-env')
  const override = join(tmpRoot, 'F-override')
  const portable = join(tmpRoot, 'G-portable')
  const appData = join(tmpRoot, 'H-appdata')

  // 覆盖不可用：跳过覆盖，落到便携；原因带上原路径（UI 要提示磁盘未就绪）
  const fallback = resolveDataDirWithUsableOverride(
    { env: null, override, portable, appData },
    (dir) => norm(dir) !== norm(override)
  )
  assertEq(norm(fallback.dataDir), norm(portable), '覆盖不可用时降级到便携目录')
  assertEq(fallback.source, 'portable', '来源标记为 portable')
  assertEq(norm(fallback.overrideUnusable), norm(override), '保留不可用覆盖路径供 UI 提示')

  // 覆盖可用：正常按优先级命中覆盖，不误报 overrideUnusable
  const normal = resolveDataDirWithUsableOverride(
    { env: null, override, portable, appData },
    () => true
  )
  assertEq(norm(normal.dataDir), norm(override), '覆盖可用时命中覆盖目录')
  assertEq(normal.source, 'override', '来源标记为 override')
  assertEq(normal.overrideUnusable, undefined, '覆盖可用时不得带 overrideUnusable')

  // env 优先级仍最高：覆盖不可用也不影响 CLAW_DATA_DIR
  const withEnv = resolveDataDirWithUsableOverride(
    { env, override, portable, appData },
    () => false
  )
  assertEq(norm(withEnv.dataDir), norm(env), 'CLAW_DATA_DIR 优先级仍最高')
  assertEq(norm(withEnv.overrideUnusable), norm(override), '即使 env 命中也会记录覆盖不可用原因')

  // 相对/空覆盖本就应视作无覆盖，不应被当成「不可用」
  const relative = resolveDataDirWithUsableOverride(
    { env: null, override: 'relative\\dir', portable, appData },
    () => false
  )
  assertEq(norm(relative.dataDir), norm(portable), '相对覆盖目录按无覆盖处理')
  assertEq(relative.overrideUnusable, undefined, '非法覆盖路径不算「磁盘未就绪」')
  return '可用性降级 + overrideUnusable 语义 ✓'
})

rmSync(tmpRoot, { recursive: true, force: true })

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-data-dir.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
