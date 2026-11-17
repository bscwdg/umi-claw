// test/obsidian-local-model.accept.mjs —— 本地向量模型安装器验收（不依赖 electron）
//
// 打真实源码：bundle electron/main/obsidian/localModel.ts，用本地 HTTP 假服务器模拟
// 直连清单的文件下载；自检用注入的 runSelfTest（不加载真实 ONNX；真实 ORT 加载由
// 手工 e2e 覆盖）。
//
// 覆盖：
//   - manifest 校验（schema/strategy/平台/路径/sha256）
//   - 下载成功 → 逐文件落盘 + state.json + status installed
//   - 镜像回退（首个 URL 500 → 第二个可用）
//   - sha256 不符 → LOCAL_MODEL_DOWNLOAD_FAILED，且不留半成品
//   - 取消 → 中止下载、状态未安装
//   - 卸载 → 整个 <dataDir>/models/embedding 删除
//   - 离线导入：未知 zip 拒绝；runtime zip + model zip 按 archive 清单校验后安装
//
// 用法：node test/obsidian-local-model.accept.mjs

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, __dirname, assert, assertEq, bundleEntry, printResult, tmpDir } from './_lib.mjs'

// ── 极简 ZIP 写入（store-only），避免测试引入 npm 依赖 ──
function makeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, data] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let crc = -1
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

const runDir = join(tmpDir, `obsidian-local-model-${Date.now()}`)
rmSync(runDir, { recursive: true, force: true })
mkdirSync(runDir, { recursive: true })

const bundle = bundleEntry('electron/main/obsidian/localModel.ts', 'obsidian-local-model.mjs', {
  externals: ['adm-zip']
})
const { LocalModelManager } = await import(pathToFileURL(bundle).href)

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 假 HTTP 服务器：按路径返回内容/状态码/延迟 ──
const routes = new Map()
const server = createServer((req, res) => {
  const route = routes.get(req.url)
  if (!route) {
    res.writeHead(404).end('not found')
    return
  }
  const timer = setTimeout(() => {
    res.writeHead(route.status, { 'content-type': 'application/octet-stream' })
    res.end(route.body)
  }, route.delayMs || 0)
  req.on('close', () => clearTimeout(timer))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function fileEntry(path, buf, name) {
  return { path, sizeBytes: buf.length, sha256: sha(buf), urls: [`${base}/${name}`] }
}

function makeManifest({ runtimeFile, modelFile, runtimeMirrorBad = false, runtimeMirrorGood = null, modelBad = false }) {
  const runtimeUrls = runtimeMirrorBad
    ? [`${base}/bad`, ...(runtimeMirrorGood ? [`${base}/${runtimeMirrorGood}`] : [])]
    : [`${base}/${runtimeFile.name}`]
  const modelUrls = modelBad ? [`${base}/bad`] : [`${base}/${modelFile.name}`]
  return {
    schema: 1,
    strategy: 'direct',
    runtimes: [{
      id: 'fake-runtime',
      version: '1.0.0',
      platform: 'win32-x64',
      entry: 'node_modules/onnxruntime-node',
      files: [{
        path: 'node_modules/onnxruntime-node/fake.bin',
        sizeBytes: runtimeFile.buf.length,
        sha256: runtimeFile.buf ? sha(runtimeFile.buf) : '',
        urls: runtimeUrls
      }]
    }],
    models: [{
      id: 'fake-model',
      name: 'fake model',
      version: '1.0.0',
      dim: 512,
      files: [{
        path: 'model_quantized.onnx',
        sizeBytes: modelFile.buf.length,
        sha256: modelBad ? sha(Buffer.from('different')) : sha(modelFile.buf),
        urls: modelUrls
      }]
    }]
  }
}

function writeManifest(dir, manifest, name = 'manifest.json') {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8')
  return p
}

function manager(dataDir, manifestPath, archiveManifestPath, overrides = {}) {
  return new LocalModelManager({
    dataDir,
    manifestPath,
    archiveManifestPath,
    nodePath: process.execPath,
    selftestScriptPath: join(runDir, 'noop-selftest.mjs'),
    platform: 'win32',
    arch: 'x64',
    logger: () => {},
    runSelfTest: async () => ({ dim: 512 }),
    ...overrides
  })
}

const recorder = new Recorder('obsidian-local-model')

// ── 1. 下载安装成功 + 卸载 ──
{
  const dir = join(runDir, 'case-install')
  mkdirSync(dir, { recursive: true })
  const runtimeBuf = Buffer.from('fake runtime bytes ' + Date.now())
  const modelBuf = Buffer.from('fake model bytes ' + Date.now())
  routes.set('/rt.bin', { status: 200, body: runtimeBuf })
  routes.set('/md.bin', { status: 200, body: modelBuf })
  const manifest = makeManifest({ runtimeFile: { name: 'rt.bin', buf: runtimeBuf }, modelFile: { name: 'md.bin', buf: modelBuf } })
  const manifestPath = writeManifest(dir, manifest)
  const archivePath = writeManifest(dir, { schema: 1, strategy: 'archive', runtimes: [], models: [] }, 'archive.json')
  // archive 清单要求非空数组；这里只测在线安装，用占位条目避免 validate 提前失败
  const archive = { schema: 1, strategy: 'archive', runtimes: [{ package: 'x.zip', sha256: 'a'.repeat(64) }], models: [{ package: 'y.zip', sha256: 'b'.repeat(64) }] }
  writeFileSync(archivePath, JSON.stringify(archive), 'utf-8')
  const m = manager(join(dir, 'data'), manifestPath, archivePath)
  await recorder.check('L1', '下载安装成功：文件落盘 + state + installed', async () => {
    assertEq(m.getStatus().installed, false)
    await m.install()
    const st = m.getStatus()
    assertEq(st.installed, true, '安装后 installed')
    assertEq(st.model?.dim, 512, '模型维度来自自检')
    const paths = m.getInstalledPaths()
    assert(Boolean(paths), '应能解析安装路径')
    assertEq(readFileSync(join(paths.runtimeDir, 'node_modules/onnxruntime-node/fake.bin')).toString(), runtimeBuf.toString(), 'runtime 文件内容')
    assertEq(readFileSync(join(paths.modelDir, 'model_quantized.onnx')).toString(), modelBuf.toString(), 'model 文件内容')
    assert(existsSync(join(dir, 'data', 'models', 'embedding', 'state.json')), 'state.json 存在')
  })
  await recorder.check('L2', '卸载：整个 models/embedding 删除', async () => {
    await m.remove()
    assertEq(m.getStatus().installed, false)
    assertEq(existsSync(join(dir, 'data', 'models', 'embedding')), false, '卸载后目录应删除')
  })
}

// ── 2. 镜像回退 ──
{
  const dir = join(runDir, 'case-mirror')
  mkdirSync(dir, { recursive: true })
  const runtimeBuf = Buffer.from('mirror runtime ' + Date.now())
  const modelBuf = Buffer.from('mirror model ' + Date.now())
  routes.set('/mirror-ok.bin', { status: 200, body: runtimeBuf })
  routes.set('/md2.bin', { status: 200, body: modelBuf })
  routes.set('/bad', { status: 500, body: Buffer.from('boom') })
  const manifest = makeManifest({
    runtimeFile: { name: 'mirror-ok.bin', buf: runtimeBuf },
    modelFile: { name: 'md2.bin', buf: modelBuf },
    runtimeMirrorBad: true,
    runtimeMirrorGood: 'mirror-ok.bin'
  })
  const manifestPath = writeManifest(dir, manifest)
  const archivePath = writeManifest(dir, { schema: 1, strategy: 'archive', runtimes: [{ package: 'x.zip', sha256: 'a'.repeat(64) }], models: [{ package: 'y.zip', sha256: 'b'.repeat(64) }] }, 'archive.json')
  const m = manager(join(dir, 'data'), manifestPath, archivePath)
  await recorder.check('L3', '镜像回退：首个 URL 500 → 第二个成功', async () => {
    await m.install()
    assertEq(m.getStatus().installed, true)
  })
}

// ── 3. sha256 不符 → 失败且不留半成品 ──
{
  const dir = join(runDir, 'case-hash')
  mkdirSync(dir, { recursive: true })
  const runtimeBuf = Buffer.from('bad runtime ' + Date.now())
  const modelBuf = Buffer.from('bad model ' + Date.now())
  routes.set('/badrt.bin', { status: 200, body: Buffer.from('tampered runtime') })
  routes.set('/badmd.bin', { status: 200, body: Buffer.from('tampered model') })
  const manifest = makeManifest({ runtimeFile: { name: 'badrt.bin', buf: runtimeBuf }, modelFile: { name: 'badmd.bin', buf: modelBuf } })
  const manifestPath = writeManifest(dir, manifest)
  const archivePath = writeManifest(dir, { schema: 1, strategy: 'archive', runtimes: [{ package: 'x.zip', sha256: 'a'.repeat(64) }], models: [{ package: 'y.zip', sha256: 'b'.repeat(64) }] }, 'archive.json')
  const m = manager(join(dir, 'data'), manifestPath, archivePath)
  await recorder.check('L4', 'sha256 不符：抛 LOCAL_MODEL_DOWNLOAD_FAILED，状态未安装', async () => {
    let error = null
    try { await m.install() } catch (e) { error = e }
    assert(Boolean(error), '应抛错')
    assertEq(error.code, 'LOCAL_MODEL_DOWNLOAD_FAILED', '错误码')
    assertEq(m.getStatus().installed, false)
    assertEq(existsSync(join(dir, 'data', 'models', 'embedding', 'runtimes')), false, '失败后不留 runtime 目录')
    assertEq(existsSync(join(dir, 'data', 'models', 'embedding', 'models')), false, '失败后不留 model 目录')
    assertEq(existsSync(join(dir, 'data', 'models', 'embedding', 'state.json')), false, '失败后不写 state')
  })
}

// ── 4. 取消 ──
{
  const dir = join(runDir, 'case-cancel')
  mkdirSync(dir, { recursive: true })
  const runtimeBuf = Buffer.from('slow runtime ' + Date.now())
  const modelBuf = Buffer.from('slow model ' + Date.now())
  routes.set('/slowrt.bin', { status: 200, body: runtimeBuf, delayMs: 3000 })
  routes.set('/slowmd.bin', { status: 200, body: modelBuf, delayMs: 3000 })
  const manifest = makeManifest({ runtimeFile: { name: 'slowrt.bin', buf: runtimeBuf }, modelFile: { name: 'slowmd.bin', buf: modelBuf } })
  const manifestPath = writeManifest(dir, manifest)
  const archivePath = writeManifest(dir, { schema: 1, strategy: 'archive', runtimes: [{ package: 'x.zip', sha256: 'a'.repeat(64) }], models: [{ package: 'y.zip', sha256: 'b'.repeat(64) }] }, 'archive.json')
  const m = manager(join(dir, 'data'), manifestPath, archivePath)
  await recorder.check('L5', '取消安装：中止下载、状态未安装', async () => {
    const p = m.install().then(() => null).catch((e) => e)
    setTimeout(() => m.cancel(), 120)
    const error = await p
    assert(Boolean(error), '取消应抛错')
    assertEq(m.getStatus().installed, false)
  })
}

// ── 5. 离线导入：未知 zip 拒绝 + runtime/model zip 成功 ──
{
  const dir = join(runDir, 'case-import')
  mkdirSync(dir, { recursive: true })
  const runtimeFile = Buffer.from('imported runtime')
  const modelFile = Buffer.from('imported model')
  const runtimeZip = makeZip({
    'pkg/manifest.json': Buffer.from(JSON.stringify({
      schema: 1, kind: 'embedding-runtime', id: 'fake-runtime', version: '1.0.0',
      files: [{ path: 'fake.bin', sizeBytes: runtimeFile.length, sha256: sha(runtimeFile), urls: ['https://example.invalid/fake.bin'] }]
    })),
    'pkg/fake.bin': runtimeFile
  })
  const modelZip = makeZip({
    'pkg/manifest.json': Buffer.from(JSON.stringify({
      schema: 1, kind: 'embedding-model', id: 'fake-model', version: '1.0.0', dim: 512,
      files: [{ path: 'model_quantized.onnx', sizeBytes: modelFile.length, sha256: sha(modelFile), urls: ['https://example.invalid/model_quantized.onnx'] }]
    })),
    'pkg/model_quantized.onnx': modelFile
  })
  const runtimeZipPath = join(dir, 'runtime.zip')
  const modelZipPath = join(dir, 'model.zip')
  writeFileSync(runtimeZipPath, runtimeZip)
  writeFileSync(modelZipPath, modelZip)
  const archive = {
    schema: 1, strategy: 'archive',
    runtimes: [{ id: 'fake-runtime', version: '1.0.0', package: 'runtime.zip', sha256: sha(runtimeZip) }],
    models: [{ id: 'fake-model', version: '1.0.0', package: 'model.zip', sha256: sha(modelZip) }]
  }
  const archivePath = writeManifest(dir, archive, 'archive.json')
  const manifestPath = writeManifest(dir, {
    schema: 1, strategy: 'direct',
    runtimes: [{ id: 'fake-runtime', version: '1.0.0', platform: 'win32-x64', entry: 'x', files: [{ path: 'x', sizeBytes: 1, sha256: 'a'.repeat(64), urls: ['https://example.invalid/x'] }] }],
    models: [{ id: 'fake-model', name: 'fake', version: '1.0.0', dim: 512, files: [{ path: 'model_quantized.onnx', sizeBytes: 1, sha256: 'b'.repeat(64), urls: ['https://example.invalid/y'] }] }]
  })
  const m = manager(join(dir, 'data'), manifestPath, archivePath)
  await recorder.check('L6', '离线导入：未知 zip 拒绝', async () => {
    const unknown = join(dir, 'unknown.zip')
    writeFileSync(unknown, makeZip({ 'pkg/manifest.json': Buffer.from('{}') }))
    let error = null
    try { await m.importFromFile(unknown) } catch (e) { error = e }
    assert(Boolean(error), '未知包应抛错')
    assertEq(error.code, 'LOCAL_MODEL_VERIFY_FAILED')
  })
  await recorder.check('L7', '离线导入：runtime + model 顺序导入后 installed', async () => {
    const r1 = await m.importFromFile(runtimeZipPath)
    assertEq(r1.kind, 'runtime')
    assertEq(m.getStatus().installed, false, '只有 runtime 时未 installed')
    const r2 = await m.importFromFile(modelZipPath)
    assertEq(r2.kind, 'model')
    assertEq(m.getStatus().installed, true)
  })
}

// ── 6. 不支持的平台 ──
{
  const dir = join(runDir, 'case-platform')
  mkdirSync(dir, { recursive: true })
  const manifestPath = writeManifest(dir, {
    schema: 1, strategy: 'direct',
    runtimes: [{ id: 'r', version: '1', platform: 'win32-x64', entry: 'x', files: [] }],
    models: [{ id: 'm', name: 'm', version: '1', dim: 512, files: [] }]
  })
  const m = manager(join(dir, 'data'), manifestPath, join(dir, 'archive.json'), { platform: 'darwin' })
  await recorder.check('L8', '非 win32-x64：install 直接拒绝', async () => {
    let error = null
    try { await m.install() } catch (e) { error = e }
    assert(Boolean(error))
    assertEq(error.code, 'LOCAL_MODEL_UNSUPPORTED')
  })
}

server.close()
const result = recorder.toJSON()
const ok = printResult(result)
rmSync(runDir, { recursive: true, force: true })
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)