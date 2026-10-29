// test/packaged.smoke.mjs —— Commit 10：打包态静态冒烟（§16.3）
//
// 2.0 的教训：真雷在打包态。对**真实构建产物**（electron-vite build 的 dist-electron/）
// 与随包 resources/ 做静态核对，不重跑业务逻辑（业务由各 accept + e2e 覆盖）。
//
// 断言：
//   ① dist-electron/main/index.js 存在且非空；不含明文测试 token
//   ② dist-electron/preload/index.js：暴露 work.gateway；无 token 字面量、无 Bearer 直连
//   ③ dist-electron/renderer/index.html 存在
//   ④ resources：db-worker.mjs、read-old-db.mjs；pdfjs（build/cmaps/standard_fonts）
//   ⑤ main bundle 引用 db-worker / pdfjs（wiring 没被打包器裁掉路径）
//
// 用法：node test/packaged.smoke.mjs（npm run smoke）；前置 npm run build

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder, __dirname, assert, printResult, writeJson
} from './_lib.mjs'

const repoRoot = join(__dirname, '..')
const outDir = join(repoRoot, 'dist-electron')

const r = new Recorder('Commit 10 · 打包态冒烟')

try {
  await r.check('S1', 'dist-electron/ 构建产物存在（main/preload/renderer）', async () => {
    assert(existsSync(outDir), 'dist-electron/ 存在（先跑 npm run build）')
    assert(existsSync(join(outDir, 'main', 'index.js')), 'dist-electron/main/index.js')
    assert(existsSync(join(outDir, 'preload', 'index.js')), 'dist-electron/preload/index.js')
    assert(existsSync(join(outDir, 'renderer', 'index.html')), 'dist-electron/renderer/index.html')
    const mainBytes = readFileSync(join(outDir, 'main', 'index.js'))
    assert(mainBytes.length > 100_000, `main bundle 体积合理（${mainBytes.length} B）`)
    return '三件套产物就位'
  })

  const mainSrc = readFileSync(join(outDir, 'main', 'index.js'), 'utf-8')
  const preloadSrc = readFileSync(join(outDir, 'preload', 'index.js'), 'utf-8')

  await r.check('S2', 'preload：暴露 work.gateway；无 token 字面量、无 Bearer 直连', async () => {
    assert(preloadSrc.includes('work:gateway:status'), '暴露 gateway status')
    assert(preloadSrc.includes('work:gateway:ensureReady'), '暴露 ensureReady')
    assert(!/GATEWAY_TOKEN\s*=\s*["'][^"']+["']/.test(preloadSrc), 'preload 无 token 字面量')
    assert(!preloadSrc.includes('Bearer '), 'preload 无 Authorization 拼装')
    assert(preloadSrc.includes('exposeInMainWorld'), '走 contextBridge')
    return 'preload 暴露面/无凭据 ✓'
  })

  await r.check('S3', 'main：引用 db-worker/pdfjs；无测试 token', async () => {
    assert(mainSrc.includes('db-worker'), '引用 db-worker 路径')
    assert(mainSrc.includes('pdfjs'), '引用 pdfjs 资产路径')
    assert(!mainSrc.includes('test-token'), '无测试 token')
    return 'main wiring 引用完整 ✓'
  })

  await r.check('S4', 'resources：db-worker / read-old-db / pdfjs 资产就位', async () => {
    assert(existsSync(join(repoRoot, 'resources', 'database', 'db-worker.mjs')), 'db-worker.mjs')
    assert(existsSync(join(repoRoot, 'resources', 'database', 'read-old-db.mjs')), 'read-old-db.mjs')
    const pdfjs = join(repoRoot, 'resources', 'pdfjs')
    assert(existsSync(join(pdfjs, 'build', 'pdf.js')), 'pdfjs build/pdf.js')
    assert(existsSync(join(pdfjs, 'build', 'pdf.worker.js')), 'pdf.worker.js')
    assert(existsSync(join(pdfjs, 'cmaps')), 'cmaps 目录')
    assert(existsSync(join(pdfjs, 'standard_fonts')), 'standard_fonts 目录')
    return '随包资源就位 ✓'
  })

  await r.check('S5', 'renderer：index.html 含挂载点，无内联密钥', async () => {
    const html = readFileSync(join(outDir, 'renderer', 'index.html'), 'utf-8')
    assert(html.includes('id="app"'), '含挂载点')
    assert(!/api[_-]?key\s*=\s*["'][^"']{10,}/i.test(html), 'html 无内联密钥')
    return 'renderer html ✓'
  })
} catch (e) {
  console.error('smoke 自身异常:', e)
}

const result = r.toJSON({})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-smoke.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
