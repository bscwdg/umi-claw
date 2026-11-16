// test/plugin-retry.accept.mjs —— 失败插件重试编排（pluginRetry.ts）行为验收
//
// 为什么单独一套：生产重试不是简单 for-循环 setEnabled——它要处理
//   ① env 自动重试与插件页刷新重试并发（单飞，否则后一轮会 dispose 掉前一轮刚激活的库）；
//   ② disposeFor 等待期间插件被别的路径恢复 / 用户点了停用（逐目标复核，不能覆盖用户意图）；
//   ③ afterEnable 只对真正 activated 的插件调用，失败只日志。
// 这些分支在 pluginRuntime 里是串起来的，但 runtime 依赖 electron，无法纯 Node 实例化；
// 所以把编排抽到 services/pluginRetry.ts，本套直接 bundle 真源码打行为（不是静态正则）。
//
// 用法：node test/plugin-retry.accept.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Recorder, __dirname, assert, assertEq, bundleEntry, printResult, repoRoot, writeJson } from './_lib.mjs'

const mod = await import(
  pathToFileURL(bundleEntry('electron/main/services/pluginRetry.ts', 'plugin-retry-bundle.mjs')).href
)
const { createPluginRetrier, isRetryableCandidate, toRetryCandidates } = mod

const r = new Recorder('5.0 · 失败插件重试编排（pluginRetry）')

/** 可变状态夹具：能被 dispose/retry 回调改写，模拟真实竞态 */
function makeFixture(initial) {
  const statuses = initial.map((s) => ({ ...s }))
  const calls = []
  const logs = []
  let broadcasts = 0
  const find = (id) => statuses.find((s) => s.id === id)
  const host = {
    list: () => statuses.map((s) => ({ ...s })),
    disposeFor: async (id) => {
      calls.push(['dispose', id])
    },
    retry: async (id) => {
      calls.push(['retry', id])
      const s = find(id)
      if (s) s.state = 'activated'
    },
    afterEnable: async (id) => {
      calls.push(['afterEnable', id])
    },
    broadcast: () => {
      broadcasts += 1
    },
    logger: (line) => logs.push(line)
  }
  return { statuses, calls, logs, host, find, broadcastCount: () => broadcasts }
}

// ── R1 可重试判定 ──────────────────────────────────────────────────────────
await r.check('R1', 'isRetryableCandidate / toRetryCandidates：只认「启用 + failed + 非 manifest」', async () => {
  assertEq(isRetryableCandidate({ id: 'a', enabled: true, state: 'failed' }), true, '运行时失败可重试')
  assertEq(
    isRetryableCandidate({ id: 'a', enabled: true, state: 'failed', errorStage: 'manifest' }),
    false,
    '清单级失败不重试'
  )
  assertEq(isRetryableCandidate({ id: 'a', enabled: false, state: 'failed' }), false, '停用不重试')
  assertEq(isRetryableCandidate({ id: 'a', enabled: true, state: 'activated' }), false, '已激活不重试')
  assertEq(isRetryableCandidate(null), false, '空值安全')
  assertEq(isRetryableCandidate(undefined), false, 'undefined 安全')

  const mapped = toRetryCandidates([
    { id: 'a', enabled: true, state: 'failed', error: { code: 'SETUP_REQUIRED', stage: 'activate' } },
    { id: 'b', enabled: true, state: 'failed', error: { code: 'PLUGIN_MANIFEST_MISSING', stage: 'manifest' } },
    { id: 'c', enabled: true, state: 'activated' }
  ])
  assertEq(mapped[0].errorStage, 'activate', 'error.stage 映射到 errorStage')
  assertEq(mapped[1].errorStage, 'manifest', '清单级 stage 保留')
  assertEq(mapped[2].errorStage, undefined, '无 error 时 undefined')
  return '判定函数 ✓'
})

// ── R2 基本链路：dispose → retry → afterEnable → broadcast ───────────────
await r.check('R2', '基本链路：只处理可重试目标；afterEnable 只对 activated；broadcast 一次', async () => {
  const fx = makeFixture([
    { id: 'work', enabled: true, state: 'failed', errorStage: 'activate' },
    { id: 'marketing', enabled: true, state: 'failed', errorStage: 'activate' },
    { id: 'off', enabled: false, state: 'failed' },
    { id: 'bad', enabled: true, state: 'failed', errorStage: 'manifest' },
    { id: 'ok', enabled: true, state: 'activated' }
  ])
  await createPluginRetrier(fx.host).retryFailed()
  assertEq(
    JSON.stringify(fx.calls),
    JSON.stringify([
      ['dispose', 'work'],
      ['retry', 'work'],
      ['dispose', 'marketing'],
      ['retry', 'marketing'],
      ['afterEnable', 'work'],
      ['afterEnable', 'marketing']
    ]),
    '只有两个运行时失败插件走 dispose→retry→afterEnable，且顺序确定'
  )
  assertEq(fx.broadcastCount(), 1, '全部 settle 后广播一次 plugin:changed')
  return '基本链路 ✓'
})

// ── R3 单飞：并发 retryFailed 只用一轮 ────────────────────────────────────
await r.check('R3', '单飞：并发两次 retryFailed 合并为同一轮（不会二次 dispose 刚激活的库）', async () => {
  const fx = makeFixture([{ id: 'work', enabled: true, state: 'failed', errorStage: 'activate' }])
  let releaseDispose
  const gate = new Promise((resolve) => {
    releaseDispose = resolve
  })
  let disposeCount = 0
  const host = {
    ...fx.host,
    disposeFor: async (id) => {
      disposeCount += 1
      await gate
      fx.calls.push(['dispose', id])
    }
  }
  const retrier = createPluginRetrier(host)
  const first = retrier.retryFailed()
  const second = retrier.retryFailed()
  assert(first === second, '第二次调用必须复用同一个 in-flight promise')
  releaseDispose()
  await Promise.all([first, second])
  assertEq(disposeCount, 1, '并发两轮只 dispose 一次（否则会把刚激活的 client 关掉）')
  assertEq(fx.calls.filter((c) => c[0] === 'retry').length, 1, '只真正 activate 一次')
  return '单飞 ✓'
})

// ── R4 dispose 等待期间插件已被别处恢复：不再 retry ─────────────────────
await r.check('R4', 'dispose 期间插件已被别处激活 → enable 前复核跳过（不重复激活）', async () => {
  const fx = makeFixture([{ id: 'work', enabled: true, state: 'failed', errorStage: 'activate' }])
  const host = {
    ...fx.host,
    disposeFor: async (id) => {
      fx.calls.push(['dispose', id])
      fx.find(id).state = 'activated' // 模拟 env 自动重试的另一轮已恢复
    }
  }
  await createPluginRetrier(host).retryFailed()
  assertEq(fx.calls.filter((c) => c[0] === 'retry').length, 0, '已恢复就不再 retry')
  assertEq(fx.broadcastCount(), 1, '仍会广播一次最终状态')
  return '竞态复核（已恢复）✓'
})

// ── R5 dispose 等待期间用户停用：不把停用插件重新启用 ───────────────────
await r.check('R5', 'dispose 期间用户停用 → 不复核通过就不 enable（不覆盖用户意图）', async () => {
  const fx = makeFixture([{ id: 'work', enabled: true, state: 'failed', errorStage: 'activate' }])
  const host = {
    ...fx.host,
    disposeFor: async (id) => {
      fx.calls.push(['dispose', id])
      fx.find(id).enabled = false // 用户点了「停用」
    }
  }
  await createPluginRetrier(host).retryFailed()
  assertEq(fx.calls.filter((c) => c[0] === 'retry').length, 0, '停用插件不得被重试重新启用')
  assertEq(fx.calls.filter((c) => c[0] === 'afterEnable').length, 0, '未激活不补 afterEnable')
  return '竞态复核（用户停用）✓'
})

// ── R6 失败隔离：dispose/retry 抛错不连累其它；afterEnable 抛错不影响 ────
await r.check('R6', '失败隔离：dispose/retry 抛错继续处理其它；afterEnable 抛错只日志', async () => {
  const fx = makeFixture([
    { id: 'a', enabled: true, state: 'failed', errorStage: 'activate' },
    { id: 'b', enabled: true, state: 'failed', errorStage: 'activate' }
  ])
  const host = {
    ...fx.host,
    disposeFor: async (id) => {
      fx.calls.push(['dispose', id])
      if (id === 'a') throw new Error('dispose boom')
    },
    retry: async (id) => {
      fx.calls.push(['retry', id])
      if (id === 'a') throw new Error('retry boom')
      fx.find(id).state = 'activated'
    },
    afterEnable: async (id) => {
      fx.calls.push(['afterEnable', id])
      throw new Error('afterEnable boom')
    }
  }
  await createPluginRetrier(host).retryFailed()
  assertEq(fx.calls.filter((c) => c[0] === 'retry').length, 2, 'a 的 dispose/retry 抛错不影响 b')
  assertEq(fx.find('b').state, 'activated', 'b 正常激活')
  assertEq(fx.calls.filter((c) => c[0] === 'afterEnable').length, 1, 'afterEnable 只对 b 调用')
  assert(fx.logs.some((l) => l.includes('afterEnable 失败')), 'afterEnable 抛错只记日志')
  assertEq(fx.broadcastCount(), 1, '即使有失败也广播最终状态')
  return '失败隔离 ✓'
})

// ── R7 无目标：不广播、不调用任何依赖 ───────────────────────────────────
await r.check('R7', '没有可重试目标时不广播、不触碰 dispose/retry', async () => {
  const fx = makeFixture([
    { id: 'ok', enabled: true, state: 'activated' },
    { id: 'off', enabled: false, state: 'failed' }
  ])
  await createPluginRetrier(fx.host).retryFailed()
  assertEq(fx.calls.length, 0, '没有可重试目标时零副作用')
  assertEq(fx.broadcastCount(), 0, '无目标不广播')
  return '空集 ✓'
})

// ── R8 生产接线（静态）：runtime 必须用本模块，不得再内联第二套 ────────
await r.check('R8', '生产接线：pluginRuntime 用 createPluginRetrier + toRetryCandidates，重试单飞', async () => {
  const runtimeSrc = readFileSync(join(repoRoot, 'electron', 'main', 'services', 'pluginRuntime.ts'), 'utf8')
  assert(/createPluginRetrier/.test(runtimeSrc), 'runtime 导入并使用 createPluginRetrier')
  assert(/toRetryCandidates/.test(runtimeSrc), 'runtime 把 PluginStatus 映射成 retry 候选')
  assert(
    /pluginRetrier\.retryFailed\(\)/.test(runtimeSrc),
    'runtime 的 retryFailedPlugins 委托给 pluginRetrier（单飞/复核在模块内）'
  )
  assert(
    !/disposeFor\(record\.manifest\.id\)/.test(runtimeSrc),
    'runtime 不得再内联旧的 dispose 循环（避免两套编排漂移）'
  )
  const lifecycleSrc = readFileSync(join(repoRoot, 'electron', 'main', 'kernel', 'lifecycle.ts'), 'utf8')
  assert(/async retry\(id: string\): Promise<PluginStatus>/.test(lifecycleSrc), 'lifecycle.retry 状态机入口仍在（生产启用路径）')
  return '接线 ✓'
})

const result = r.toJSON()
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-plugin-retry.json'), result)
console.log('')
console.log(`----- ${result.suite}: ${result.passed}/${result.total}，失败 ${result.failed} -----`)
process.exit(ok ? 0 : 1)
