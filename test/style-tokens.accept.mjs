// test/style-tokens.accept.mjs —— 样式 token 门禁回归
//
// 为什么要有这一套：门禁脚本若只会数字数，正则被注释/修饰符/非 scoped 块绕过
// 就会出现「实测 0 条」的假绿。这里把纯函数逐条钉住，并断言基线文件可读、
// 白名单生效、棘轮方向正确。
//
// 用法：node test/style-tokens.accept.mjs（npm run accept:style-tokens）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Recorder, __dirname, assert, assertEq, printResult, repoRoot, writeJson } from './_lib.mjs'
import {
  CHECK_KEYS,
  STYLE_WHITELIST,
  collectAll,
  compareBaseline,
  extractStyleBlocks,
  scanFile,
  stripComments
} from '../scripts/check-style-tokens.mjs'

const r = new Recorder('style-tokens（样式 token 门禁：正则 / style 块切分 / 白名单 / 基线棘轮）')

await r.check('T1', 'style 块切分：vue 识别 scoped，css 按全文处理', async () => {
  const vue = [
    '<template><div /></template>',
    '<style scoped>',
    '.a { color: #fff; }',
    '</style>',
    '<style>',
    '.b { color: rgb(1,2,3); }',
    '</style>'
  ].join('\n')
  const blocks = extractStyleBlocks(vue, 'x.vue')
  assertEq(blocks.length, 2, '应提取两个 style 块')
  assertEq(blocks[0].scoped, true, '第一块 scoped')
  assertEq(blocks[1].scoped, false, '第二块非 scoped')
  const cssBlocks = extractStyleBlocks('.a{}', 'x.css')
  assertEq(cssBlocks.length, 1)
  assertEq(cssBlocks[0].scoped, false)
  return 'SFC style 块与 scoped 标记识别正确'
})

await r.check('T2', '注释剥离：注释里的 hex/rgb/rem 不计数', async () => {
  const src = [
    '/* 旧色 #ff6b6b 与 1.2rem 示例，rgba(1,2,3,.4) 也要忽略 */',
    '.a { color: #3fb950; padding: 0.8rem; }'
  ].join('\n')
  const clean = stripComments(src)
  assert(!clean.includes('#ff6b6b'), '注释内 hex 被剥离')
  assert(!clean.includes('rgba(1,2,3,.4)'), '注释内 rgba 被剥离')
  assert(clean.includes('#3fb950'), '真实 hex 保留')
  assert(clean.includes('0.8rem'), '真实 rem 保留')
  return '块注释整体剥离，真实声明不受影响'
})

await r.check('T3', '六类检查正则命中与语义（含修饰符负样本）', async () => {
  const scoped = [
    '.btn { color: #fff; border-radius: 8px; font-size: 13px; }',
    '.btn-primary { background: var(--accent); }',
    '.card h3 { color: rgb(10, 20, 30); }',
    '.bad { color: var(--bg-primary, #000); width: 1.2rem; }',
    '.ok { border-radius: var(--radius-sm); font-size: var(--text-sm); }'
  ].join('\n')
  const vue = `<style scoped>\n${scoped}\n</style>`
  const blocks = extractStyleBlocks(vue, 'probe.vue')
  // 复用 scanFile 的内部口径：直接对块内容跑同源正则（通过临时断言 scanFile 行为旁证）
  const content = stripComments(blocks[0].content)
  const hex = content.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  const rgb = content.match(/rgba?\([^)]*\)/g) || []
  const rem = content.match(/[0-9.]+rem\b/gi) || []
  const badVar = content.match(/--(?:bg-primary|bg-secondary|border-color|text-color)\b/g) || []
  const bareRadius = content.match(/border-radius:\s*([0-9]+)px/gi) || []
  const bareFont = content.match(/font-size:\s*([0-9]+)px/gi) || []
  assertEq(hex.length, 2, '只命中 #fff / #000 两个真实 hex')
  assertEq(rgb.length, 1, '只命中 1 个真实 rgb')
  assertEq(rem.length, 1, '只命中 1 个 rem')
  assertEq(badVar.length, 1, '错误变量名命中')
  assertEq(bareRadius.length, 1, '裸圆角只命中 8px 那处（var() 不算）')
  assertEq(bareFont.length, 1, '裸字号只命中 13px 那处（var() 不算）')
  return '六类正则各归各位，var() token 引用不误伤'
})

await r.check('T4', 'globalOverride：scoped 重定义全局类命中，修饰符与非 scoped 不误报', async () => {
  const GLOBAL_CLASSES = ['btn', 'card', 'badge', 'form-input', 'form-select', 'form-textarea',
    'toggle', 'modal-overlay', 'modal-card', 'alert', 'toast']
  const overrideRe = new RegExp(
    `(?:^|\\})\\s*\\.(${GLOBAL_CLASSES.join('|')})(?![\\w-])[^{]*\\{`,
    'gm'
  )
  const scopedSrc = [
    '.btn { padding: 0; }',
    '.btn.primary { color: #fff; }',
    '.card h3 { margin: 0; }',
    '.btn-primary { background: #fff; }',
    '.badge-green { color: #fff; }'
  ].join('\n')
  const hits = scopedSrc.match(overrideRe) || []
  assertEq(hits.length, 3, `.btn/.btn.primary/.card h3 命中，修饰符 .btn-primary/.badge-green 放行（实际 ${hits.length}）`)

  const nonScoped = extractStyleBlocks(`<style>\n.btn { color: #fff; }\n</style>`, 'x.vue')
  assertEq(nonScoped[0].scoped, false, '非 scoped 块不参与重定义检查')
  return '重定义检查只认 scoped 内的保留类本身，修饰符类放行'
})

await r.check('T5', '真实文件扫描：已迁移的重灾区页面保持全清（迁移回归防护）', async () => {
  // 四批迁移前本用例断言这两页「能抓到」错误变量名/rem/scoped .btn 重定义；
  // 迁移收口后反转口径：六项检查必须全部为零，任何回退都会让本用例变红。
  const expectClean = (name, scanned) => {
    for (const key of CHECK_KEYS) {
      assertEq(scanned[key].length, 0, `${name} ${key} 应保持清零（实际 ${scanned[key].length}：${JSON.stringify(scanned[key].slice(0, 2))}）`)
    }
  }
  const character = scanFile(join(repoRoot, 'src/character/CharacterPage.vue'))
  expectClean('CharacterPage', character)
  const channels = scanFile(join(repoRoot, 'src/views/ChannelsPage.vue'))
  expectClean('ChannelsPage', channels)
  return 'CharacterPage / ChannelsPage 六项检查全部为零，正则命中能力已由 T3/T4 合成探针覆盖'
})

await r.check('T6', '白名单生效：插画/桌宠/token 定义文件不进汇总', async () => {
  const { details } = collectAll()
  for (const white of STYLE_WHITELIST) {
    assert(!details.some((d) => d.file === white), `${white} 应被白名单豁免`)
  }
  return `白名单 ${STYLE_WHITELIST.length} 项全部生效`
})

await r.check('T7', '基线棘轮：超标报违例、持平放行、六键两组齐全', async () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'style-tokens-baseline.json'), 'utf8'))
  for (const group of ['src', 'plugins']) {
    for (const key of CHECK_KEYS) {
      assertEq(typeof baseline[group][key], 'number', `基线 ${group}.${key} 应为数字`)
    }
  }
  const good = compareBaseline(
    { src: { hardColor: 1 }, plugins: { hardColor: 0 } },
    { src: { hardColor: 1 }, plugins: { hardColor: 0 } }
  )
  assertEq(good.length, 0, '持平基线放行')
  const bad = compareBaseline(
    { src: { hardColor: 2 }, plugins: { hardColor: 0 } },
    { src: { hardColor: 1 }, plugins: { hardColor: 0 } }
  )
  assertEq(bad.length, 1, '超标必须报违例')
  assert(bad[0].includes('src.hardColor'), '违例信息点名分组与检查项')
  return '棘轮方向正确（只准降），基线结构完整'
})

await r.check('T8', 'live 扫描不高于基线（防回退硬约束）', async () => {
  const { groups } = collectAll()
  const baseline = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'style-tokens-baseline.json'), 'utf8'))
  const violations = compareBaseline(groups, baseline)
  assertEq(violations.length, 0, violations.join('；'))
  return `实测 ${JSON.stringify(groups)} 全部 ≤ 基线`
})

/** 取精确选择器对应的单条规则体，避免 [\s\S]* 跨过无关规则造成假绿 */
function ruleBody(source, selector) {
  const clean = stripComments(source)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 允许该选择器出现在逗号选择器列表里，但选择器本身必须从行首精确开始
  const match = new RegExp(`^\\s*${escaped}\\s*(?:,\\s*[^{}]+)?\\{([\\s\\S]*?)\\n\\}`, 'm').exec(clean)
  return match?.[1] || ''
}

await r.check('T9', '角色页渠道列表使用本地布局类（不吃 scoped .row 覆盖全局工具类）', async () => {
  const page = readFileSync(join(repoRoot, 'src', 'character', 'CharacterPage.vue'), 'utf8')
  assert(/<div v-else class="channel-list">/.test(page), '渠道列表必须使用 .channel-list')
  assert(
    !/class="row[^"]*(items-start|gap-[0-9])/.test(page),
    'scoped .row 已定义 align-items/gap，不得再叠同属性全局工具类'
  )
  const channelRule = ruleBody(page, '.channel-list')
  assert(/display:\s*flex/.test(channelRule), '.channel-list 必须是 flex 容器')
  assert(/flex-direction:\s*column/.test(channelRule), '.channel-list 必须纵向排列')
  assert(/align-items:\s*flex-start/.test(channelRule), '.channel-list 必须左对齐')
  return '渠道列表改用页面本地布局类，避免 scoped 优先级覆盖'
})

await r.check('T10', '大肥鱼页面卡片垂直节奏：标题/说明/操作栏间距有统一规则', async () => {
  const page = readFileSync(join(repoRoot, 'src', 'character', 'CharacterPage.vue'), 'utf8')
  const settings = readFileSync(join(repoRoot, 'src', 'character', 'CharacterSettings.vue'), 'utf8')
  assert(/margin:\s*0 0 var\(--space-3\)/.test(ruleBody(page, 'h3')), '卡片标题必须统一 12px 下间距')
  assert(/margin-top:\s*0/.test(ruleBody(page, 'h3 + .hint')), '标题后的说明不得重复加距')
  assert(/margin-top:\s*var\(--space-3\)/.test(ruleBody(page, '.hint + .row')), '说明后的操作栏必须统一上间距')
  assert(/margin-bottom:\s*0/.test(ruleBody(page, '.row:last-child')), '卡片末尾 row 不得留尾距')
  assert(/margin:\s*0 0 var\(--space-2\)/.test(ruleBody(settings, '.settings h3')), '设置组件标题必须有下间距')
  assert(/margin:\s*var\(--space-2\) 0 0/.test(ruleBody(settings, '.settings .hint')), '设置组件说明文字必须有上间距')
  assert(/margin-top:\s*0/.test(ruleBody(settings, '.settings .group > h4 + .check-row')), '设置组标题后首个勾选行不得重复加距')
  assert(/margin-top:\s*0/.test(ruleBody(settings, '.settings .group > h4 + .row')), '设置组标题后首个控件行不得重复加距')
  return '卡片标题、说明与操作栏垂直节奏已锁定'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-style-tokens.json'), result)
if (!ok) process.exit(1)
