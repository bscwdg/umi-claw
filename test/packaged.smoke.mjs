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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  Recorder, __dirname, assert, printResult, writeJson
} from './_lib.mjs'

const repoRoot = join(__dirname, '..')
const outDir = join(repoRoot, 'dist-electron')

/** 选一个可用的已解包产物目录：显式 env > release-alt（次选，绕开被占用）> release */
function resolveUnpacked() {
  const candidates = [
    process.env.UMI_PACKAGED_DIR,
    join(repoRoot, 'release-build', 'win-unpacked'),
    join(repoRoot, 'release-alt', 'win-unpacked'),
    join(repoRoot, 'release', 'win-unpacked')
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const r = new Recorder('Commit 10 · 打包态冒烟')

try {
  await r.check('S1', 'dist-electron/ 构建产物存在（main/preload/renderer）', async () => {
    assert(existsSync(outDir), 'dist-electron/ 存在（先跑 npm run build）')
    assert(existsSync(join(outDir, 'main', 'index.js')), 'dist-electron/main/index.js')
    assert(existsSync(join(outDir, 'main', 'pluginProcessChild.js')), 'dist-electron/main/pluginProcessChild.js（B1 子进程入口）')
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

  // ── S6 真实打包产物（release/win-unpacked，存在才跑：先 npm run build:win 或 electron-builder --dir）──
  await r.check('S6', '安装包目录：清单/migrations 在 resources，代码在 asar 且不含插件数据', async () => {
    const unpacked = resolveUnpacked()
    if (!unpacked) {
      if (process.env.UMI_ALLOW_PACKAGE_SKIP === '1') return '跳过（显式允许）'
      assert(false, '缺少解包产物：请先 electron-builder --win --dir（或设 UMI_ALLOW_PACKAGE_SKIP=1）')
      return ''
    }
    const resRoot = join(unpacked, 'resources', 'resources')
    assert(existsSync(join(resRoot, 'plugins', 'work', 'plugin.json')), '包内 work 清单')
    assert(existsSync(join(resRoot, 'plugins', 'marketing', 'plugin.json')), '包内 marketing 清单')
    assert(existsSync(join(resRoot, 'plugins', 'work', 'migrations', '001_init.sql')), '包内 work migrations')
    assert(
      existsSync(join(resRoot, 'plugins', 'marketing', 'migrations', '001_init.sql')),
      '包内 marketing migrations'
    )
    for (const f of ['collector/index.mjs', 'database/db-worker.mjs', 'database/db-worker-marketing.mjs']) {
      assert(existsSync(join(resRoot, f)), `包内 ${f}`)
    }

    const asar = join(unpacked, 'resources', 'app.asar')
    assert(existsSync(asar), 'app.asar 存在')
    const asarBytes = readFileSync(asar)
    assert(asarBytes.length > 500_000, `app.asar 体积合理（${asarBytes.length} B）`)
    const asarText = asarBytes.toString('utf8')
    assert(asarText.includes('work:gateway:status'), 'asar 内含主进程代码（work:gateway:status）')
    // asar 头里列出文件路径：代码在 asar，插件数据（清单/migrations）只在 resources
    assert(/dist-electron\/main\/index\.js/.test(asarText), 'asar 含 dist-electron/main/index.js')
    assert(!asarText.includes('plugins/work/plugin.json'), 'asar 不应打包插件清单')
    assert(!asarText.includes('plugins/work/migrations'), 'asar 不应打包插件 migrations')
    return '打包产物结构正确 ✓'
  })
  // ── S7 角色内容包与依赖（C10；桌宠 M1 已下线，不再为其背书）──
  await r.check('S7', '角色内容包随包（persona/cards/emotions）且 silk 依赖真实进 asar', async () => {
    const unpacked = resolveUnpacked()
    if (!unpacked) {
      if (process.env.UMI_ALLOW_PACKAGE_SKIP === '1') return '跳过（显式允许）'
      assert(false, '缺少解包产物：请先 electron-builder --win --dir（或设 UMI_ALLOW_PACKAGE_SKIP=1）')
      return ''
    }
    const resRoot = join(unpacked, 'resources', 'resources')
    const character = join(resRoot, 'character')
    for (const rel of [
      'persona/SOUL.md.tpl',
      'persona/AGENTS.md.tpl',
      'persona/voice-rules.md',
      'persona/few-shots.v1.json',
      'persona/banned.v1.json',
      'cards/life-cards.v1.json',
      'cards/topics.v1.json',
      'cards/lines.v1.json',
      'emotions.v1.json'
    ]) {
      const file = join(character, rel)
      assert(existsSync(file), `包内角色内容 ${rel}`)
      assert(statSync(file).size > 100, `包内角色内容非空 ${rel}`)
    }
    const asarText = readFileSync(join(unpacked, 'resources', 'app.asar')).toString('utf8')
    // 不能只匹配 package.json 的依赖声明：要真的把 silk-wasm 包目录/资源打进 asar
    assert(/"silk-wasm":\{"files"/.test(asarText), 'asar 内含 silk-wasm 包目录')
    assert(asarText.includes('.wasm'), 'asar 内含 wasm 资源')
    assert(!asarText.includes('doc/research/upstream'), 'asar 不含上游参考库')
    // 内容不能是 101 字节占位：JSON 必须可解析且卡池/六态达数量
    const deck = JSON.parse(readFileSync(join(character, 'cards', 'life-cards.v1.json'), 'utf8'))
    assert(Array.isArray(deck.cards) && deck.cards.length >= 20, '包内生活卡 ≥20 且可解析')
    const emotions = JSON.parse(readFileSync(join(character, 'emotions.v1.json'), 'utf8'))
    assert(Object.keys(emotions.states ?? {}).length === 6, '包内六态定义完整')
    const soulTpl = readFileSync(join(character, 'persona', 'SOUL.md.tpl'), 'utf8')
    assert(/\{\{[a-zA-Z]+\}\}/.test(soulTpl), 'SOUL 模板含变量占位')
    const voiceRules = readFileSync(join(character, 'persona', 'voice-rules.md'), 'utf8')
    assert(voiceRules.includes('风格规则'), 'voice-rules 是规则正文')
    // NOTICE：第三方署名与许可（silk-wasm / codex-deepseek-pet 署名）
    const notice = readFileSync(join(repoRoot, 'NOTICE.md'), 'utf8')
    assert(notice.includes('silk-wasm'), 'NOTICE 列 silk-wasm')
    assert(notice.includes('YunYueSama'), 'NOTICE 保留上游署名')
    assert(notice.includes('CC BY-NC-SA'), 'NOTICE 标注非商业素材边界')
    return '角色资源/桌宠 preload/NOTICE ✓'
  })
} catch (e) {
  // 统一短语：scripts/run-all-accept.mjs 靠它把「套件自身异常」判红（否则 catch 吞掉后 exit 0 假绿）
  console.error('验收脚本自身异常（smoke）:', e)
}

const result = r.toJSON({})
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-smoke.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
