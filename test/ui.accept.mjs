// test/ui.accept.mjs —— UI 层验收（真源码组件级）
//
// 目标：补上「typecheck/build 只证明能编译」的证据缺口——
// 用**真 .vue 源码** + **真 preload 桥**，在 Node 侧真挂载页面，断言：
//   U1 preload 桥面完整（15 个 work 命名空间 + 流式订阅 + 信封解包语义）
//   U2 今日页挂载：调 work:today:get，渲染出问候/待办/记录
//   U3 工作记录页挂载：调 matters.list + records.list，渲染出记录与来源标记
//   U4 报告页挂载：调 reports.list，渲染出报告行与状态徽标
//   U5 工具箱页挂载：调 tools.list，渲染出六个工具
//   U6 工作设置页挂载：调 profile.get + reminder.isEnabled×2 + wizard.status，
//      渲染出完整度与提醒开关状态
//   U7 Context 页挂载：调 context.snapshot，渲染出资料组成与 dropped
//   U8 向导弹窗挂载：调 wizard.status，渲染出隐私说明必过页
//   U9 挂载全程无 Vue 警告（能抓到模板引用不存在字段这类真 bug）
//   U10 流式归并（useWorkStream）：chunk 累积 / done 收口 / 早期 chunk 缓冲
//
// 机制：@vue/compiler-sfc 编译真 SFC → esbuild 打包（vue 共享实例）→
//       vue createRenderer 造对象树宿主真挂载 → 注入 window.api 响应。
//
// 用法：node test/ui.accept.mjs（npm run accept:ui）

import { pathToFileURL } from 'node:url'
import { Recorder, assert, assertEq, printResult, writeJson, __dirname, repoRoot } from './_lib.mjs'
import {
  writeStubs, compileVuePage, importPreloadApi, mountPage, esbuildBundle,
  collectRendererChannels, loadWorkIpcChannels
} from './_ui.mjs'

const r = new Recorder('UI · work 域页面组件级验收')
const stubs = writeStubs()

/** 注入 IPC 响应：channel → 值或 (…args) => 值；同时清空上一轮的调用记录 */
function setIpc(map) {
  globalThis.__ipcResponses = map
  globalThis.__invokes = []
}
/** 记录到的调用 */
function calls() {
  const st = globalThis.__invokes
  return Array.isArray(st) ? st : []
}

let api = null

try {
  // ── U1 真 preload 桥面 ──
  await r.check('U1', '真 preload 桥：15 个 work 命名空间 + 流式订阅 + 信封解包', async () => {
    api = await importPreloadApi({ electronStub: stubs.electronStub, toolkitStub: stubs.toolkitStub })
    const expected = [
      'stream', 'gateway', 'profile', 'matters', 'todos', 'records', 'context',
      'today', 'router', 'reports', 'qa', 'tools', 'knowledge', 'wizard', 'reminder'
    ]
    const missing = expected.filter((k) => !api.work[k])
    assertEq(missing.length, 0, `缺命名空间: ${missing.join(',')}`)
    for (const fn of ['onChunk', 'onDone', 'onError', 'removeAll']) {
      assertEq(typeof api.work.stream[fn], 'function', `stream.${fn}`)
    }
    // 信封解包：成功取 data；失败抛带 code 的错误（不是返回 {ok:false}）
    setIpc({ 'work:profile:get': { profile: { id: 'default' }, completeness: { percent: 0 } } })
    const okVal = await api.work.profile.get()
    assertEq(okVal.profile.id, 'default', '成功解包 data')

    setIpc({ 'work:profile:get': { ok: false, error: { code: 'NOT_FOUND', message: 'x' } } })
    let threw = null
    try { await api.work.profile.get() } catch (e) { threw = e }
    assert(threw, '失败要抛错')
    assertEq(threw.code, 'NOT_FOUND', '抛出的错误带 code（渲染端按 code 分支）')
    return `${expected.length} 命名空间 + 解包语义 ✓`
  })

  // ── 挂载辅助 ──
  async function mount(file, outName, ipcMap) {
    setIpc(ipcMap)
    const bundle = compileVuePage(file, outName, { routerStub: stubs.routerStub })
    const mod = await import(pathToFileURL(bundle).href)
    const res = await mountPage(mod.default, { api })
    if (res.mountError) throw new Error('挂载异常: ' + res.mountError.message)
    return res
  }

  // ── U2 今日页 ──
  await r.check('U2', '今日页挂载：调 today.get，渲染问候/待办/记录', async () => {
    const res = await mount('src/views/work/TodayPage.vue', 'ui-today', {
      'work:today:get': {
        date: '2026-09-23', weekday: 3, greeting: '早上好',
        todos: [
          { id: 't1', title: '写周报', dueDate: '2026-09-23', matterId: null, source: 'manual', overdue: false },
          { id: 't2', title: '遗留事项', dueDate: '2026-09-20', matterId: null, source: 'manual', overdue: true }
        ],
        candidateTodos: [], records: [
          { id: 'r1', content: '完成方案第二版', occurredTime: '09:30', matterId: null }
        ],
        candidateRecords: [],
        report: { exists: false, reportId: null, status: null, canGenerate: false },
        counts: { todos: 2, candidateTodos: 0, records: 1, candidateRecords: 0 }
      }
    })
    const called = calls().map((c) => c.channel)
    assert(called.includes('work:today:get'), `应调 today.get（实际 ${called.join(',')}）`)
    assert(res.html.includes('早上好'), '渲染问候')
    assert(res.html.includes('写周报'), '渲染待办标题')
    assert(res.html.includes('遗留事项'), '渲染逾期待办')
    assert(res.html.includes('完成方案第二版'), '渲染今日记录')
    assert(res.html.includes('09:30'), '渲染记录时间')
    assert(res.html.includes('逾期'), '逾期徽标')
    return '今日页渲染 ✓'
  })

  // ── U3 工作记录页 ──
  await r.check('U3', '工作记录页挂载：调 matters.list + records.list，渲染来源/事项', async () => {
    const res = await mount('src/views/work/RecordsPage.vue', 'ui-records', {
      'work:matters:list': [
        { id: 'm1', name: 'Q3活动', status: 'active', color: '#F59E0B', created_at: 1, updated_at: 1 }
      ],
      'work:records:list': [
        {
          id: 'r1', content: '召开 Q3 启动会', occurred_date: '2026-09-23', occurred_time: '14:00',
          source: 'manual', source_ref: null, status: 'confirmed', matter_id: 'm1',
          confirmed_at: 1, filtered_reason: null, created_at: 1, updated_at: 1
        }
      ]
    })
    const called = calls().map((c) => c.channel)
    assert(called.includes('work:matters:list'), '应调 matters.list')
    assert(called.includes('work:records:list'), '应调 records.list')
    assert(res.html.includes('召开 Q3 启动会'), '渲染记录内容')
    assert(res.html.includes('Q3活动'), '渲染事项名（关联成功）')
    assert(res.html.includes('手动'), '渲染来源标记')
    assert(res.html.includes('14:00'), '渲染时间')
    return '记录页渲染 ✓'
  })

  // ── U4 报告页 ──
  await r.check('U4', '报告页挂载：调 reports.list，渲染报告行与状态', async () => {
    const res = await mount('src/views/work/ReportsPage.vue', 'ui-reports', {
      'work:reports:list': [
        { id: 'p1', type: 'daily', period: '2026-09-23', status: 'confirmed', created_at: 1, updated_at: 1 },
        { id: 'p2', type: 'weekly', period: '2026-W39', status: 'draft', created_at: 2, updated_at: 2 }
      ]
    })
    const called = calls().map((c) => c.channel)
    assert(called.includes('work:reports:list'), '应调 reports.list')
    assert(res.html.includes('2026-09-23'), '渲染日报期')
    assert(res.html.includes('2026-W39'), '渲染周报期')
    assert(res.html.includes('已确认'), '已确认徽标')
    assert(res.html.includes('草稿'), '草稿徽标')
    return '报告页渲染 ✓'
  })

  // ── U5 工具箱页 ──
  await r.check('U5', '工具箱页挂载：调 tools.list，渲染六工具与类型标记', async () => {
    const res = await mount('src/views/work/ToolsPage.vue', 'ui-tools', {
      'work:tools:list': [
        { id: 'minutes', label: '会议纪要', kind: 'productive', needsSource: true, description: '长文本 → 纪要 + 待办' },
        { id: 'polish', label: '润色', kind: 'processing', needsSource: true, description: '改通顺/改语气' },
        { id: 'translate', label: '翻译', kind: 'processing', needsSource: true, description: '中英日互译' }
      ]
    })
    assert(calls().some((c) => c.channel === 'work:tools:list'), '应调 tools.list')
    assert(res.html.includes('会议纪要'), '渲染工具名')
    assert(res.html.includes('润色'), '渲染润色')
    assert(res.html.includes('产出型'), '产出型标记')
    assert(res.html.includes('加工型'), '加工型标记')
    return '工具箱页渲染 ✓'
  })

  // ── U6 设置页 ──
  await r.check('U6', '工作设置页挂载：profile + reminder.isEnabled×2 + wizard.status', async () => {
    const res = await mount('src/views/work/SettingsPage.vue', 'ui-settings', {
      'work:profile:get': {
        profile: {
          id: 'default', call_name: '小北', position: '产品经理', department: null,
          company: null, report_to: null, tone: null, report_style: null, industry: null,
          created_at: 1, updated_at: 1
        },
        completeness: { filled: 2, total: 6, percent: 33, missing: ['department', 'company', 'report_to', 'tone'] }
      },
      'work:reminder:isEnabled': (id) => (id === 'morning' ? true : false),
      'work:wizard:status': { consent: true, completed: true, oldDb: null, oldDbDecision: null }
    })
    const called = calls().map((c) => c.channel)
    assert(called.includes('work:profile:get'), '应调 profile.get')
    assert(called.includes('work:reminder:isEnabled'), '应调 reminder.isEnabled（新通道）')
    assert(called.includes('work:wizard:status'), '应调 wizard.status')
    assert(res.html.includes('33%'), '渲染完整度百分比')
    assert(res.html.includes('补上'), '渲染完整度引导（弱存在感）')
    assert(res.html.includes('产品经理'), '渲染画像字段')
    assert(res.html.includes('今日待办汇总'), '渲染 morning 提醒行')
    assert(res.html.includes('生成今日日报'), '渲染 report 提醒行')
    return '设置页渲染 ✓'
  })

  // ── U7 Context 页 ──
  await r.check('U7', 'Context 页挂载：调 context.snapshot，渲染资料组成与 dropped', async () => {
    const res = await mount('src/views/work/ContextPage.vue', 'ui-context2', {
      'work:context:snapshot': {
        scope: 'latest', builtAt: 1790000000000,
        memory_snapshot: {
          profileSummary: '产品经理 · 某公司',
          matters: [{ id: 'm1', name: 'Q3活动' }],
          todos: [{ id: 't1', title: '写周报', dueDate: '2026-09-23' }],
          records: [{ id: 'r1', occurredDate: '2026-09-23', content: '完成方案' }],
          knowledge: [{ id: 'k1', title: '活动SOP', type: 'faq', truncated: false }],
          historyCount: 2, retrievalMode: 'like',
          budget: { mode: 'full', usedTokens: 1200, budgetTokens: 4000, knowledgeIncluded: 1, knowledgeTotal: 3 }
        },
        inputs: { task: 'daily_report', query: null, conversationKey: 'ck1', anchorDate: null },
        dropped: [{ id: 'k9', title: '超长文档', section: 5, reason: 'over-budget' }]
      }
    })
    assert(calls().some((c) => c.channel === 'work:context:snapshot'), '应调 context.snapshot')
    assert(res.html.includes('daily_report'), '渲染任务')
    assert(res.html.includes('Q3活动'), '渲染事项')
    assert(res.html.includes('写周报'), '渲染待办')
    assert(res.html.includes('活动SOP'), '渲染知识库条目')
    assert(res.html.includes('超长文档'), '渲染 dropped 条目（留痕可见）')
    assert(res.html.includes('超预算'), '渲染裁剪原因')
    assert(!res.html.includes('prompt'), '不暴露 prompt 字样（B1）')
    return 'Context 页渲染 ✓'
  })

  // ── U8 向导弹窗 ──
  await r.check('U8', '向导弹窗挂载：调 wizard.status，渲染隐私说明必过页', async () => {
    const res = await mount('src/views/components/WizardModal.vue', 'ui-wizard', {
      'work:wizard:status': { consent: false, completed: false, oldDb: null, oldDbDecision: null }
    })
    assert(calls().some((c) => c.channel === 'work:wizard:status'), '应调 wizard.status')
    assert(res.html.includes('资料默认仅保存在本地'), '渲染隐私告知原文表述')
    assert(res.html.includes('我已阅读并同意'), '渲染同意勾选')
    return '向导弹窗渲染 ✓'
  })

  // ── U9 无 Vue 警告/错误 ──
  await r.check('U9', '挂载全程无 Vue 警告/错误（模板引用错字段、指令钩子异常都会被抓到）', async () => {
    const res = await mount('src/views/work/TodayPage.vue', 'ui-today2', {
      'work:today:get': {
        date: '2026-09-23', weekday: 3, greeting: '下午好',
        todos: [], candidateTodos: [], records: [], candidateRecords: [],
        report: { exists: false, reportId: null, status: null, canGenerate: false },
        counts: { todos: 0, candidateTodos: 0, records: 0, candidateRecords: 0 }
      }
    })
    // 不只抓 [Vue warn]：指令钩子/渲染期异常会以其他前缀打到 console.error
    const bad = res.warnings.filter((w) =>
      /\[Vue warn\]/.test(w) || /Unhandled error/.test(w) || /TypeError|ReferenceError/.test(w)
    )
    assertEq(bad.length, 0, `Vue 警告/错误: ${bad.slice(0, 3).join(' | ')}`)
    return '无 Vue 警告/错误 ✓'
  })

  // ── U10 流式归并 ──
  await r.check('U10', 'useWorkStream：早期 chunk 缓冲 / 累积 / done 收口', async () => {
    // 直接用真 composable 源码（esbuild 打包后 import）
    const bundle = esbuildBundle(
      repoRoot + '/src/composables/useWorkStream.ts',
      'ui-stream.bundle.mjs',
      { externals: ['vue'] }
    )
    const { useWorkStream } = await import(pathToFileURL(bundle).href)

    // 装一个可控的流事件源
    const handlers = { chunk: [], done: [], error: [] }
    globalThis.window = {
      api: {
        work: {
          stream: {
            onChunk: (cb) => { handlers.chunk.push(cb); return () => {} },
            onDone: (cb) => { handlers.done.push(cb); return () => {} },
            onError: (cb) => { handlers.error.push(cb); return () => {} },
            removeAll: () => {}
          }
        }
      }
    }

    const s = useWorkStream()
    // bind 前先来一个 chunk（模拟 invoke 返回前的早期事件）
    handlers.chunk.forEach((cb) => cb({ runId: 'run1', index: 0, delta: '早' }))
    s.bind('run1')
    assertEq(s.text.value, '早', 'bind 时 flush 早期缓冲')
    handlers.chunk.forEach((cb) => cb({ runId: 'run1', index: 1, delta: '期' }))
    handlers.chunk.forEach((cb) => cb({ runId: 'run2', index: 0, delta: '别人的' }))
    assertEq(s.text.value, '早期', '只累积自己的 runId')
    handlers.done.forEach((cb) => cb({ runId: 'run1', chunks: 2, text: '早期完成', aborted: false }))
    const done = await s.done
    assertEq(done.text, '早期完成', 'done 收口用最终文本')
    assertEq(s.running.value, false, 'done 后 running=false')
    assertEq(s.aborted.value, false, '未中止')
    return '流式归并 ✓'
  })

  // ── U11 通道对齐（mock IPC 测不出的 bug 类型） ──
  //
  // 渲染端调的通道名 vs 主进程真注册的通道名。两者不一致时，mock 验收全绿、
  // typecheck/build 也全绿，但真机一调就报「No handler registered」——
  // 本用例把两边真实集合拉出来对齐。
  await r.check('U11', '通道对齐：渲染端发的通道全部有主进程 handler（反向无孤儿）', async () => {
    // 渲染端：真 preload 桥，逐个叶子函数真调一次，收集实际发出的通道
    globalThis.__invokes = []
    globalThis.__onChannels = []
    setIpc({})
    const { invoked, subscribed } = await collectRendererChannels(api)

    // 主进程：真 ipc/work.ts 注册，收集真实 handler 集合
    globalThis.__handlers = new Map()
    const { registered } = await loadWorkIpcChannels({ electronStub: stubs.electronStub })

    assert(invoked.length >= 55, `渲染端应发出 55+ 通道（实际 ${invoked.length}）`)
    assert(registered.length >= 55, `主进程应注册 55+ handler（实际 ${registered.length}）`)

    // 正向：渲染端会发的，主进程必须都有 handler
    const missing = invoked.filter((ch) => !registered.includes(ch))
    assertEq(missing.length, 0, `渲染端发但主进程未注册: ${missing.join(', ')}`)

    // 订阅通道：主进程推送的必须与渲染端订阅的一致
    for (const ch of ['work:stream:chunk', 'work:stream:done', 'work:stream:error']) {
      assert(subscribed.includes(ch), `渲染端应订阅 ${ch}（实际订阅: ${subscribed.join(',')}）`)
    }

    // 反向：主进程注册的 handler，渲染端应都能触达（防「注册了但没人用」的孤儿通道）
    const orphan = registered.filter((ch) => !invoked.includes(ch))
    assertEq(orphan.length, 0, `主进程注册但渲染端无法触达（孤儿）: ${orphan.join(', ')}`)

    return `渲染端 ${invoked.length} 通道 = 主进程 ${registered.length} handler，全对齐 ✓`
  })
} catch (e) {
  console.error('UI 验收脚本自身异常:', e)
}

const result = r.toJSON({})
const ok = printResult(result)
writeJson(__dirname + '/accept-result-ui.json', result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
