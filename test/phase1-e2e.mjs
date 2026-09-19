// test/phase1-e2e.mjs —— 一期整体测试（Commit 00-12 GUI 端到端，2026-09-20）
//
// 做法：真 Electron（dist-electron 最新产物）+ 真 DB Worker + 真便携 Node + 真网关（127.0.0.1:3213），
// CDP 驱动真实点击流，走老板每日动线：建商家 → 填资料/知识 → Advisor → 热点雷达（真采集+真 AI 评分）
// → 一键带去 Content Center 真生成 3 版 → 审核流 → 全页面巡检。
//
// 安全隔离：
//   - 数据目录用 %TEMP%/umi-phase1-e2e-*（真库 VACUUM INTO 副本 + runtime 目录 junction），不写真库；
//   - app.json 强制 autoStart:false —— **绝不点「启动」按钮**（clawManager.start() 会 taskkill 真 openclaw）；
//   - AI 请求走已存活的 3213 网关；收尾按 PID 结束进程。
//
// 用法：node test/phase1-e2e.mjs          （便携 node 或系统 node ≥24 均可）
// 产物：test/e2e-result.json + test/e2e-screenshots/*.jpg

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const CDP_PORT = Number(process.env.CDP_PORT || 9223)
const shotDir = join(__dirname, 'e2e-screenshots')
const runDir = join(os.tmpdir(), 'umi-phase1-e2e-gui-' + Date.now())
const dataDir = join(runDir, 'data')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString().slice(11, 19)

// ── 1. 隔离数据目录 ─────────────────────────────────────────────────────────
function prepareDataDir() {
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  const portableNode = join(repoRoot, 'data/runtime/node-win32-x64/node.exe')
  const dst = join(dataDir, 'umi-claw.db').replace(/\\/g, '/')
  const src = join(repoRoot, 'data/umi-claw.db').replace(/\\/g, '/')
  const vac = "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('" + src + "');db.exec(\"VACUUM INTO '" + dst + "'\");db.close();"
  const vacPath = join(runDir, 'vac.cjs')
  writeFileSync(vacPath, vac)
  execFileSync(portableNode, [vacPath], { stdio: 'inherit' })
  const cfg = JSON.parse(readFileSync(join(repoRoot, 'data/config/app.json'), 'utf8'))
  cfg.autoStart = false
  writeFileSync(join(dataDir, 'config/app.json'), JSON.stringify(cfg, null, 2), 'utf8')
  execFileSync('cmd', ['/c', 'mklink', '/J', join(dataDir, 'runtime'), join(repoRoot, 'data/runtime')], { stdio: 'inherit' })
  const binDir = join(dataDir, 'openclaw/node_modules/.bin')
  const pkgDir = join(dataDir, 'openclaw/node_modules/openclaw')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(binDir, 'openclaw'), '# e2e marker\n')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.4-e2e' }))
  console.log('[' + now() + '] 数据目录就绪: ' + dataDir)
}

// ── 2. 启动 Electron + CDP ───────────────────────────────────────────────────
let child
function startElectron() {
  const exe = join(repoRoot, 'node_modules/electron/dist/electron.exe')
  if (!existsSync(exe)) throw new Error('electron.exe 不存在，先 npm i')
  child = spawn(exe, ['.', '--remote-debugging-port=' + CDP_PORT, '--disable-gpu', '--disable-gpu-sandbox'], {
    cwd: repoRoot,
    env: { ...process.env, CLAW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (d) => { mainLog.push(d.toString()) })
  child.stderr.on('data', (d) => { mainLog.push(d.toString()) })
  console.log('[' + now() + '] electron pid=' + child.pid)
}
const mainLog = []

async function waitForPage(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('等 CDP page 超时')
}
let ws, msgSeq = 0
function cdp(method, params = {}, timeoutMs = 30000) {
  const id = ++msgSeq
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      ws.removeEventListener('message', h)
      reject(new Error('CDP ' + method + ' 超时(' + timeoutMs + 'ms)'))
    }, timeoutMs)
    const h = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      if (done) return
      done = true
      clearTimeout(timer)
      ws.removeEventListener('message', h)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
    ws.addEventListener('message', h)
    try { ws.send(JSON.stringify({ id, method, params })) } catch (e) { clearTimeout(timer); done = true; reject(e) }
  })
}
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) {
    throw new Error('EVAL ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0].slice(0, 300))
  }
  return r.result?.value ?? null
}
const rendererIssues = []
function hookConsole(stepName) {
  const handler = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') {
      rendererIssues.push({ step: stepName, kind: 'exception', text: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0].slice(0, 300) })
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error')) {
      rendererIssues.push({ step: stepName, kind: 'console.error', text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) })
    }
  }
  ws.addEventListener('message', handler)
}

// ── 3. DOM 助手（真实点击 / Vue v-model 写值 / 轮询等待） ─────────────────────
async function gotoHash(hash) {
  await ev("location.hash = " + JSON.stringify(hash))
  await sleep(900)
}
async function clickByText(textLike, scopeSelector) {
  const expr = "(() => {" +
    "const root = " + (scopeSelector ? "document.querySelector(" + JSON.stringify(scopeSelector) + ") || document" : "document") + ";" +
    "const btns = [...root.querySelectorAll('button,[role=button],.tab,.chip')];" +
    "const b = btns.find(x => x.innerText && x.innerText.trim().includes(" + JSON.stringify(textLike) + ") && !x.disabled && x.offsetParent !== null);" +
    "if (!b) return false; b.click(); return true;" +
    "})()"
  return ev(expr)
}
async function setByPlaceholder(placeholderLike, value, tag = 'input,textarea') {
  const expr = "(() => {" +
    "const els = [...document.querySelectorAll(" + JSON.stringify(tag) + ")];" +
    "const el = els.find(x => (x.placeholder || '').includes(" + JSON.stringify(placeholderLike) + "));" +
    "if (!el) return false;" +
    "el.focus(); el.value = " + JSON.stringify(value) + ";" +
    "el.dispatchEvent(new Event('input', { bubbles: true }));" +
    "el.dispatchEvent(new Event('change', { bubbles: true }));" +
    "return true;" +
    "})()"
  return ev(expr)
}
async function waitUntil(fn, { timeout = 60000, label = 'condition', interval = 700 } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { last = e }
    await sleep(interval)
  }
  throw new Error('等待超时(' + Math.round(timeout / 1000) + 's): ' + label + (last ? ' / ' + last.message : ''))
}
const bodyText = () => ev('document.body.innerText')
// 读热点分组真实条数（「N 条」在 .tier-head，折叠 DOM 每组只渲染前 10 条不能数卡片）
async function readBoard() {
  return ev(`(() => {
    const heads = [...document.querySelectorAll('.tier-group .tier-head')];
    let total = 0; const perGroup = {};
    for (const h of heads) {
      const num = parseInt((h.innerText.match(/[0-9]+ 条/) || ["0"])[0], 10) || 0;
      const name = (h.querySelector('.tier-name') || {}).innerText || h.innerText;
      perGroup[name.trim()] = num; total += num;
    }
    const calEl = [...document.querySelectorAll("h3")].find(x => x.innerText.includes("节点日历"));
    const calendar = calEl ? (parseInt((calEl.innerText.match(/[0-9]+/) || ["0"])[0], 10) || 0) : 0;
    return { total, perGroup, calendar }
  })()`)
}
const shotWarnings = []
async function shot(name) {
  try {
    const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, 45000)
    writeFileSync(join(shotDir, name + '.jpg'), Buffer.from(r.data, 'base64'))
    console.log('  📷 ' + name)
  } catch (e) {
    shotWarnings.push(name + ': ' + e.message)
    console.log('  📷⚠️  截图失败 ' + name + '：' + e.message)
  }
}

// ── 4. 测试记账 ──────────────────────────────────────────────────────────────
const checks = []
async function step(id, name, fn, { shot: shotName } = {}) {
  const t0 = Date.now()
  const before = rendererIssues.length
  console.log('[' + now() + '] ▶ ' + id + ' ' + name)
  try {
    const detail = await fn()
    if (shotName) await shot(shotName)
    const newIssues = rendererIssues.slice(before)
    checks.push({ id, name, ok: true, ms: Date.now() - t0, detail: detail || '', consoleErrors: newIssues })
    console.log('  ✅ ' + (detail || '').toString().slice(0, 160))
  } catch (e) {
    let shotFile = id + '-fail'
    try { await shot(shotFile) } catch {}
    const newIssues = rendererIssues.slice(before)
    checks.push({ id, name, ok: false, ms: Date.now() - t0, detail: String(e && e.message || e), consoleErrors: newIssues, shot: shotFile + '.jpg' })
    console.log('  ❌ ' + String(e && e.message || e))
  }
}
const countByText = (needle) => ev("document.body.innerText.split(" + JSON.stringify(needle) + ").length - 1")

// ── 5. 测试主流程 ────────────────────────────────────────────────────────────
const PROJECT_NAME = '整体测试·光影摄影'
const result = { startedAt: new Date().toISOString(), dataDir, checks }

async function main() {
  rmSync(shotDir, { recursive: true, force: true })
  mkdirSync(shotDir, { recursive: true })
  prepareDataDir()
  startElectron()
  const page = await waitForPage()
  ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(page.webSocketDebuggerUrl)
    sock.addEventListener('open', () => resolve(sock), { once: true })
    sock.addEventListener('error', () => reject(new Error('ws 失败')), { once: true })
  })
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  hookConsole('boot')
  await sleep(8000)

  // T1 启动 / Dashboard ───────────────────────────────────────────────────────
  await step('T1', '启动进控制台（Setup 守卫放行、12 模块就绪、无渲染错误）', async () => {
    const href = await ev('location.href')
    if (!href.includes('#/dashboard')) throw new Error('未进 dashboard: ' + href)
    const txt = await bodyText()
    for (const must of ['控制台', '当前商家', 'AI 营销', '服务端口']) {
      if (!txt.includes(must)) throw new Error('Dashboard 缺「' + must + '」')
    }
    return 'dashboard 渲染正常'
  }, { shot: '01-dashboard' })

  // T2 新建商家（切换器内联表单） ─────────────────────────────────────────────
  await step('T2', '新建商家（当前商家切换器 → ＋ 新建 → 内联表单）', async () => {
    const opened = await clickByText('当前商家')
    if (!opened) throw new Error('打不开商家切换器')
    await sleep(500)
    if (!(await clickByText('＋ 新建'))) throw new Error('无「＋ 新建」按钮')
    await sleep(400)
    if (!(await setByPlaceholder('商家名称', PROJECT_NAME))) throw new Error('无商家名称输入框')
    if (!(await setByPlaceholder('行业（如', '摄影'))) throw new Error('无行业输入框')
    await sleep(200)
    if (!(await clickByText('创建'))) throw new Error('无创建按钮')
    await waitUntil(async () => (await bodyText()).includes(PROJECT_NAME), { timeout: 15000, label: '新商家出现在当前位置' })
    return '商家「' + PROJECT_NAME + '」已创建并选中'
  }, { shot: '02-project-created' })

  // T3 商家大脑：填资料 + 关注词 ───────────────────────────────────────────────
  await step('T3', '商家大脑：填写基本盘 6 项并保存 + 新增关注词', async () => {
    await gotoHash('#/marketing/business')
    await waitUntil(() => ev("!!document.querySelector('input[placeholder*=\"摄影工作室\"]')"), { timeout: 15000, label: '商家表单出现' })
    await setByPlaceholder('如 XX 摄影工作室', '光影婚纱摄影工作室')
    await setByPlaceholder('如 成都', '杭州')
    await setByPlaceholder('婚纱摄影 + 个人写真', '轻奢外景婚纱摄影 + 个人写真，主打自然光纪实风格')
    await setByPlaceholder('25-35 岁备婚女性', '25-35 岁备婚女性，偏好清新自然、轻奢质感')
    await setByPlaceholder('亲切专业', '亲切专业，像朋友给建议，不硬推销')
    await setByPlaceholder('XX 区 XX 路', '杭州市西湖区文三路 88 号')
    await sleep(300)
    if (!(await clickByText('保存'))) throw new Error('无保存按钮')
    await sleep(1500)
    const ok1 = await setByPlaceholder('加一个关注词', '婚纱摄影')
    if (ok1) {
      await sleep(200)
      // 关注词旁的新增按钮（卡片内 .btn-primary，文本动态探测）
      const added = await ev("(() => { const inp = document.querySelector('input[placeholder*=\"加一个关注词\"]'); if (!inp) return 'no-input'; const card = inp.closest('.card'); const b = card && [...card.querySelectorAll('button')].find(x => !x.disabled && /添加|新增|加入|补/.test(x.innerText)); if (!b) return 'no-btn:' + [...card.querySelectorAll('button')].map(x=>x.innerText).join('/'); b.click(); return 'added' })()")
      if (added !== 'added' && added !== 'no-input') throw new Error('关注词新增失败: ' + added)
      await sleep(800)
    }
    await sleep(400)
    const formVals = await ev("(() => { const i = document.querySelector('input[placeholder*=\"摄影工作室\"]'); const tas = [...document.querySelectorAll('textarea')].map(t => t.value); return { name: i ? i.value : '', tas } })()")
    if (formVals.name !== '光影婚纱摄影工作室') throw new Error('名称未回显: ' + JSON.stringify(formVals.name))
    if (!formVals.tas.some((v) => v.includes('备婚女性'))) throw new Error('客群多行文未回显')
    const wl = await bodyText()
    if (!wl.includes('婚纱摄影')) throw new Error('关注词未显示')
    return '6 项资料保存成功（表单值回显）、关注词已加'
  }, { shot: '03-business' })

  // T4 知识库：FAQ 手工录入 + 检索 ─────────────────────────────────────────────
  await step('T4', '知识库：FAQ 文本录入 → 入库 → LIKE 检索命中', async () => {
    await gotoHash('#/marketing/knowledge')
    await waitUntil(() => clickByText('FAQ'), { timeout: 15000, label: '知识库页 + FAQ tab' })
    await sleep(500)
    const faq = 'Q: 拍完多久能选片？\nA: 一般 3-5 个工作日，精修 15 个工作日内交付。'
    if (!(await setByPlaceholder('拍完多久', faq, 'textarea'))) throw new Error('FAQ 文本框未出现')
    if (!(await setByPlaceholder('标题（可选', '选片与交付时效'))) throw new Error('标题框未出现')
    await sleep(200)
    if (!(await clickByText('导入'))) throw new Error('无导入按钮')
    await waitUntil(async () => (await bodyText()).includes('选片与交付时效'), { timeout: 20000, label: 'FAQ 入库回显' })
    await sleep(500)
    await setByPlaceholder('在知识库里搜', '选片')
    await sleep(200)
    if (!(await clickByText('搜索'))) throw new Error('无搜索按钮')
    await waitUntil(async () => {
      const t = await bodyText()
      return t.includes('选片') && (t.includes('命中') || t.includes('1') || t.includes('选片与交付时效'))
    }, { timeout: 15000, label: 'LIKE 检索结果' })
    return 'FAQ 入库并被「选片」检索命中'
  }, { shot: '04-knowledge' })

  // T5 AI Advisor：真 SSE 问答 + 中止按钮存在 ─────────────────────────────────
  await step('T5', 'AI Advisor：基于商家资料真问答（SSE 流式上屏）', async () => {
    await gotoHash('#/marketing/advisor')
    await waitUntil(() => ev("!!document.querySelector('textarea[placeholder*=\"问点什么\"]')"), { timeout: 15000, label: 'Advisor 输入框' })
    await setByPlaceholder('问点什么', '用我填的资料回答：我的店主要做什么业务？目标客群是谁？一句话说清。', 'textarea')
    await sleep(300)
    if (!(await clickByText('发送'))) throw new Error('无发送按钮')
    let sawStop = false
    await waitUntil(async () => {
      const info = await ev("(() => { const msgs = [...document.querySelectorAll('.msg.assistant .msg-text')]; const last = msgs[msgs.length-1]; const stop = !!document.querySelector('button') && [...document.querySelectorAll('button')].some(b => b.innerText.includes('停止生成')); return { n: msgs.length, len: last ? last.innerText.length : 0, stop } })()")
      if (info.stop) sawStop = true
      return info.n >= 1 && info.len >= 15 && !info.stop
    }, { timeout: 150000, label: 'AI 回复完整上屏' })
    const reply = (await ev("(() => { const msgs = [...document.querySelectorAll('.msg.assistant .msg-text')]; return msgs[msgs.length-1].innerText.slice(0, 220) })()")) || ''
    if (!/婚纱|写真|备婚|25|35|女性|纪实/.test(reply)) throw new Error('回复未基于商家资料: ' + reply)
    return (sawStop ? '流式期间出现「停止生成」；' : '') + '回复 grounded：' + reply.replace(/\s+/g, ' ').slice(0, 110)
  }, { shot: '05-advisor' })

  // T6 热点雷达：真榜单渲染 + 窗口/平台/筛选 + 真 AI 首批评分 ─────────────────
  await step('T6', '热点雷达：80 条真热点渲染 + 时间窗/平台/源筛选交互', async () => {
    await gotoHash('#/marketing/hot')
    // 首屏可能触发一轮真采集（listRadar await collectIfDue），榜单数据来自库内 80 条
    await waitUntil(async () => (await bodyText()).includes('待分析') || !!(await ev("document.querySelectorAll('.topic').length")), {
      timeout: 180000, label: '榜单渲染（可能含一轮真采集）'
    })
    const summary = await readBoard()
    result.hotInitial = summary
    if (!summary.total) throw new Error('榜单 0 条')

    // 时间窗切换：24 → 72 → 168，四组条数之和单调不减
    const counts = {}
    for (const [wlabel, hours] of [['近 24 小时', 24], ['近 3 天', 72], ['近 7 天', 168]]) {
      await clickByText(wlabel)
      await sleep(2000)
      counts[hours] = (await readBoard()).total
    }
    result.windowCounts = counts
    if (!(counts[168] >= counts[72] && counts[72] >= counts[24])) throw new Error('时间窗计数非单调: ' + JSON.stringify(counts))

    // 源筛选往返：点第一个具体源，再回「全部」
    const chipName = await ev("(() => { const rows = [...document.querySelectorAll('.filter-row')]; const row = rows.find(r => r.innerText.includes('数据源')) || rows.find(r => [...r.querySelectorAll('button')].some(b => b.innerText.trim().startsWith('全部'))); const tabs = row ? [...row.querySelectorAll('button')] : []; const tab = tabs.find(b => /^(头条|B站|抖音|微博|知乎|百度|快手|聚合)/.test(b.innerText.trim()) && !b.innerText.includes('视角')); return tab ? tab.innerText.trim() : null })()")
    if (chipName) {
      await ev("(() => { const rows = [...document.querySelectorAll('.filter-row')]; const row = rows.find(r => r.innerText.includes('数据源')); const b = row && [...row.querySelectorAll('button')].find(x => x.innerText.trim() === " + JSON.stringify(chipName) + "); if (b) b.click(); return !!b })()")
      await sleep(1500)
      const filtered = (await readBoard()).total
      result.sourceFilter = { chip: chipName, count: filtered }
      await ev("(() => { const rows = [...document.querySelectorAll('.filter-row')]; const row = rows.find(r => r.innerText.includes('数据源')); const b = row && [...row.querySelectorAll('button')].find(x => x.innerText.trim().startsWith('全部')); if (b) b.click(); return !!b })()")
      await sleep(1000)
      if (!filtered) throw new Error('源筛选后 0 条: ' + chipName)
    }

    // 平台切换（评分两平台各一份；切换不报错）
    await clickByText('抖音')
    await sleep(1500)
    const dyText = await bodyText()
    if (dyText.includes('第一轮采集失败')) throw new Error('切抖音出现采集失败条')
    await clickByText('小红书')
    await sleep(1200)
    return '榜单 ' + summary.total + ' 条（' + Object.entries(summary.perGroup).map(([k, v]) => k + v).join('/') + '）、日历 ' + summary.calendar + ' 个；窗口 24h=' + counts[24] + ' 72h=' + counts[72] + ' 7d=' + counts[168] + (result.sourceFilter ? '；源筛选「' + result.sourceFilter.chip + '」=' + result.sourceFilter.count : '')
  }, { shot: '06-hot-radar' })

  await step('T6b', '热点 AI 评分：真网关首批 30 条 SSE 评分落库，四档分组真实分布', async () => {
    // onMounted 已自动触发评分；首批真网 90-225s，最多等 300s 看到首批落库（进度 n/总数，n≥25）
    await waitUntil(async () => {
      const m = (await bodyText()).match(/（(\d+)\/(\d+)）/)
      if (!m) return false
      result.scoreProgress0 = m[0]
      return Number(m[1]) >= 25
    }, { timeout: 300000, label: '首批评分落库（真 SSE，最长 5 分钟）', interval: 2000 })
    await sleep(1500)
    const board = await readBoard()
    const pendingKey = Object.keys(board.perGroup).find((k) => k.includes('待分析'))
    const pendingCount = pendingKey ? board.perGroup[pendingKey] : 0
    const scoredCount = board.total - pendingCount
    if (scoredCount < 25) throw new Error('首批已评条目不足（分组计数 ' + scoredCount + '）: ' + JSON.stringify(board.perGroup))
    const tiers = Object.entries(board.perGroup).map(([k, v]) => k + ' ' + v + ' 条').join(' | ')
    const suggest = await ev("(() => { const el = [...document.querySelectorAll('*')].find(e => e.className && typeof e.className==='string' && e.className.includes('suggest') && e.innerText.includes('今日建议')); return el ? el.innerText.replace(/\s+/g,' ').slice(0, 200) : null })()")
    result.tiersAfterFirstBatch = board.perGroup
    result.suggestionAfterFirstBatch = suggest
    return '进度 ' + result.scoreProgress0 + '；' + tiers + (suggest ? '；今日建议已产出' : '；今日建议暂无（宁缺毋滥）')
  }, { shot: '07-hot-scored' })

  // T7 热点 → Content Center 预填 → 真生成 3 版 → 审核流 ─────────────────────
  await step('T7', '每日动线闭环：热点「带去 Content Center」→ 预填 → 真生成 3 版', async () => {
    // 取一个已评分（非 pending）热点跳转：优先值得跟/观察组的 take-btn
    const jumped = await ev("(() => { const btns = [...document.querySelectorAll('.tier-group .take-btn')]; const groups = [...document.querySelectorAll('.tier-group')]; const pickOrder = ['值得跟', '观察', '不建议']; for (const name of pickOrder) { const g = groups.find(x => x.querySelector('.tier-name').innerText.includes(name)); const b = g && g.querySelector('.take-btn'); if (b) { b.click(); return name } } return null })()")
    if (!jumped) throw new Error('找不到可跳转的热点按钮')
    await waitUntil(async () => (await ev('location.hash')) === '#/marketing/content', { timeout: 10000, label: '跳转 Content Center' })
    await sleep(1200)
    const prefill = await ev("document.querySelector('.prefill-strip') ? document.querySelector('.prefill-strip').innerText.replace(/\s+/g,' ').slice(0,200) : null")
    if (!prefill || !prefill.includes('来自热点雷达')) throw new Error('热点预填条缺失: ' + prefill)
    result.prefill = prefill
    // 生成 3 版（平台默认小红书；topic 留空让 AI 从资料挑点也可，显式给一句更稳）
    await setByPlaceholder('想写什么', '结合这个热点写一条小红书种草笔记的选题方向', 'textarea,input')
    await sleep(300)
    if (!(await clickByText('生成 3 个版本'))) throw new Error('无生成按钮')
    let sawStop = false
    await waitUntil(async () => {
      const stop = await ev("[...document.querySelectorAll('button')].some(b => b.innerText.includes('停止生成'))")
      if (stop) sawStop = true
      const done = await ev("[...document.querySelectorAll('button')].filter(b => b.innerText.includes('采用为正文')).length")
      return done >= 3
    }, { timeout: 300000, label: '3 版真生成完成（最长 5 分钟）', interval: 2500 })
    const slots = await ev("[...document.querySelectorAll('.slot-body,pre')].filter(p => p.closest('div') && p.innerText.length>30).length")
    return '从「' + jumped + '」组跳转；预填：' + prefill.slice(0, 80) + '；3 版完成' + (sawStop ? '（流式期有停止按钮）' : '')
  }, { shot: '08-content-3versions' })

  await step('T7b', 'Content 审核流：采用为正文 → 草稿入库 → 提交审核 → 审核通过 → 标记已发布', async () => {
    if (!(await clickByText('采用为正文'))) throw new Error('无采用按钮')
    await sleep(1200)
    await clickByText('完成（收起面板）')
    await sleep(1200)
    // 生成时草稿已入库（.items .item）；点开第一行进编辑 modal
    const rowOk = await waitUntil(() => ev("!!document.querySelector('.items .item')"), { timeout: 15000, label: '草稿列表行' })
    if (!rowOk) throw new Error('草稿列表为空')
    await ev("document.querySelector('.items .item').click()")
    await waitUntil(() => ev("!!document.querySelector('.modal-mask .modal') && [...document.querySelectorAll('.modal-mask button')].some(b => b.innerText.includes('提交审核'))"), { timeout: 10000, label: '编辑器 modal + 提交审核按钮' })
    const flow = []
    for (const btn of ['提交审核', '审核通过', '标记已发布']) {
      const ok = await waitUntil(() => clickByText(btn, '.modal-mask'), { timeout: 8000, label: btn })
      flow.push(btn + (ok ? '✓' : '✗'))
      await sleep(1000)
    }
    if (flow.some((f) => f.endsWith('✗'))) throw new Error('审核流断点: ' + flow.join(' '))
    const badge = await ev("document.querySelector('.items .item .badge') ? document.querySelector('.items .item .badge').innerText.trim() : ''")
    if (!badge.includes('已发布')) throw new Error('状态徽标未变已发布: ' + badge)
    return '状态流转：' + flow.join(' → ') + '；列表徽标=' + badge
  }, { shot: '09-content-reviewed' })


  // T8 手动「重新分析」触发 force 轮（不等待评完，后端 force 语义由 S12 锁定） ──
  await step('T8', '「重新分析」按钮：空闲态触发 force 轮并进入分析中态', async () => {
    await gotoHash('#/marketing/hot')
    // 回雷达会自动从断点续评（onMounted scheduleScore）。先等评分循环空闲；
    // 真网若间歇超时中断（已知 provider 排队，四重防线之「下次打开续评」），最多重开两轮
    const idleBtn = "(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('重新分析') || x.innerText.includes('AI 分析中')); return b ? { text: b.innerText.trim(), disabled: b.disabled } : null })()"
    let rounds = 0
    while (rounds < 3) {
      try {
        await waitUntil(async () => { const b = await ev(idleBtn); return b && b.text.includes('重新分析') && !b.disabled }, { timeout: rounds === 0 ? 420000 : 240000, label: '评分循环空闲', interval: 3000 })
        break
      } catch {
        rounds += 1
        await gotoHash('#/dashboard'); await sleep(800); await gotoHash('#/marketing/hot'); await sleep(2000)
      }
    }
    const boardIdle = await readBoard()
    result.tiersBeforeForce = boardIdle.perGroup
    // 触发 force 重评（后端 force 水位语义由 accept:hotscore S12 锁定）
    if (!(await clickByText('重新分析'))) throw new Error('无重新分析按钮')
    await waitUntil(async () => (await bodyText()).includes('AI 分析中'), { timeout: 8000, label: '进入分析中态' })
    // force 轮首批 ~45-225s：等到出现进度即证明真在重评
    await waitUntil(async () => /（\d+\/\d+）/.test(await bodyText()), { timeout: 240000, label: 'force 首批进度', interval: 3000 })
    const prog = (await bodyText()).match(/（\d+\/\d+）/)[0]
    return '触发前分组 ' + JSON.stringify(boardIdle.perGroup) + '；force 轮已启动且进度 ' + prog + '（force 全量重评正确性由 S12 锁定）'
  }, { shot: '10-rescore' })

  // T9 全页面巡检（白屏/渲染错误/控制台异常） ─────────────────────────────────
  const patrolPages = [
    ['#/config', '模型配置', ['模型', '配置']],
    ['#/skills', '能力中心', ['技能', '能力']],
    ['#/logs', '运行日志', ['日志']],
    ['#/channelsPage', '渠道', ['渠道', '消息']],
    ['#/terminal', 'OpenClaw 终端', [/终端|OpenClaw|xterm/]],
    ['#/obsidian', 'Obsidian 知识库', [/Obsidian|未启用|知识库/]],
    ['#/about', '关于', [/Umi Claw|版本|v1\.1/]],
    ['#/setup', '环境初始化', [/环境|Node|OpenClaw|初始化/]]
  ]
  for (const [hash, name, needles] of patrolPages) {
    await step('P-' + hash.slice(2), '页面巡检：' + name, async () => {
      await gotoHash(hash)
      await sleep(2500)
      const info = await ev("(() => ({ len: document.body.innerText.trim().length, h: document.querySelector('h1,h2,.title') ? document.querySelector('h1,h2,.title').innerText : '', blank: document.querySelectorAll('*').length }))()")
      if (info.len < 40) throw new Error('疑似白屏（正文仅 ' + info.len + ' 字）')
      const txt = await bodyText()
      const miss = needles.filter((n) => (n instanceof RegExp ? !n.test(txt) : !txt.includes(n)))
      if (miss.length) throw new Error('缺关键内容: ' + miss.join(','))
      return name + ' 渲染正常（' + info.len + ' 字 / ' + info.blank + ' 节点）'
    }, { shot: '11-' + hash.slice(2) })
  }

  // T10 回控制台 + 全量错误审计 ────────────────────────────────────────────────
  await step('T10', '回到控制台，商家卡/AI 营销卡反映真实状态', async () => {
    await gotoHash('#/dashboard')
    await sleep(2000)
    const txt = await bodyText()
    if (!txt.includes(PROJECT_NAME)) throw new Error('当前商家未显示 ' + PROJECT_NAME)
    return '控制台显示「' + PROJECT_NAME + '」'
  }, { shot: '12-dashboard-final' })
}

// ── 6. 收尾 ──────────────────────────────────────────────────────────────────
function shutdown() {
  try {
    if (child && child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } catch {}
}

const t0all = Date.now()
try {
  await main()
} catch (e) {
  console.error('主流程异常:', e)
  checks.push({ id: 'FATAL', name: '主流程异常', ok: false, ms: 0, detail: String(e && e.stack || e) })
} finally {
  await sleep(1500)
  result.finishedAt = new Date().toISOString()
  result.totalMs = Date.now() - t0all
  result.rendererIssues = rendererIssues
  result.shotWarnings = shotWarnings
  const mainErrLines = mainLog.join('').split('\n').filter((l) => /ERROR|Error|error/i.test(l) && !/cache_util|disk_cache|gpu_disk_cache|DevTools/.test(l)).slice(-20)
  result.mainProcessErrorLines = mainErrLines
  const passed = checks.filter((c) => c.ok).length
  result.summary = { total: checks.length, passed, failed: checks.length - passed }
  writeFileSync(join(__dirname, 'e2e-result.json'), JSON.stringify(result, null, 2), 'utf8')
  console.log('\n===== 一期整体测试结果 =====')
  for (const c of checks) console.log((c.ok ? '✅' : '❌') + ' ' + c.id + ' ' + c.name + ' — ' + String(c.detail).slice(0, 140))
  console.log('渲染端错误 ' + rendererIssues.length + ' 条；主进程错误行 ' + mainErrLines.length + ' 行')
  console.log(passed + '/' + checks.length + ' 通过，用时 ' + Math.round(result.totalMs / 1000) + 's；产物 test/e2e-result.json')
  shutdown()
  process.exit(result.summary.failed ? 1 : 0)
}
