// test/host-ipc.accept.mjs —— 宿主 IPC 行为级验收（P45：env / claw / config / terminal）
//
// 背景：4.1 WP5-a 把宿主通道从 index.ts 拆到 ipc/host/*.ts，拆出的文件把依赖全部注入。
// 已有的静态断言（plugin.accept.mjs 的 handler 守恒、ui.accept.mjs 的通道名）只能证明
// 「handler 注册了」，证明不了「闸门真的挡住、顺序真的对、敏感信息真的没进日志」。
// 本套件用 esbuild bundle **真源码** → fake registrar 收 handler → 注入 fake deps 调用，
// 断言行为与负向分支（该拒绝的真拒绝 / 该调的不调）。
//
// 覆盖（源码实际注册 28 个 handler：env 8 / claw 7 / config 8 / term 5）：
//   env 8：check/init/update/updateNode/checkLatest/getInfo/nodeVersions/runtimeProbe
//   claw 7：start/stop/restart/status/waitReady/openWeb/get-token
//   config 8：get/save/reset/getDataDir/getPresetModels/refreshModelPresets/getModelPresetsInfo/openDataDir
//   term 5：run/pty-start/pty-input/pty-stop/pty-resize（任务书的 create/write/kill/list 是语义名）
//
// 用法：node test/host-ipc.accept.mjs    （npm run accept:host-ipc）

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
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

// bundle 只做一次：路径留给结果 JSON，避免文件末尾再 bundle 一遍（同一份源码跑 8 次 esbuild）
const bundlePaths = {
  env: bundleEntry('electron/main/ipc/host/env.ts', 'host-ipc-env.mjs'),
  claw: bundleEntry('electron/main/ipc/host/claw.ts', 'host-ipc-claw.mjs'),
  config: bundleEntry('electron/main/ipc/host/config.ts', 'host-ipc-config.mjs'),
  terminal: bundleEntry('electron/main/ipc/host/terminal.ts', 'host-ipc-terminal.mjs')
}

const envMod = await import(pathToFileURL(bundlePaths.env).href)
const clawMod = await import(pathToFileURL(bundlePaths.claw).href)
const configMod = await import(pathToFileURL(bundlePaths.config).href)
const terminalMod = await import(pathToFileURL(bundlePaths.terminal).href)

const { registerEnvIpc } = envMod
const { registerClawIpc } = clawMod
const { registerConfigIpc } = configMod
const { registerTerminalIpc } = terminalMod

// 与 env.ts 的常量逐字一致：拿它对比「第二次调用返回什么」才证明闸门文案没漂移
const ENV_BUSY = '已有环境任务在进行中，请等待当前任务完成'

// ─── 通用工具 ────────────────────────────────────────────────────────────────

/** fake registrar：收集 channel → listener，并提供同步/异步调用入口 */
function makeRegistrar() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, listener) {
      assert(!handlers.has(channel), `通道重复注册: ${channel}`)
      handlers.set(channel, listener)
    },
    call(channel, ...args) {
      const listener = handlers.get(channel)
      if (!listener) throw new Error(`未注册的通道: ${channel}`)
      return listener(null, ...args)
    }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 给 IPC 调用加超时兜底。
 * 为什么需要：护栏被删后 handler 会返回一个永不 resolve 的 Promise（例如 term:run 直接
 * spawn 完等 exit），套件表现为「进程挂死 exit 13 / 0 FAIL / 无诊断」，验收链路只会看到
 * 非 0 退出而不知道哪条断言的护栏没了。Promise.race 把「挂死」变成一条可读的失败断言。
 */
async function withTimeout(value, { timeout = 2000, label = 'IPC 调用' } = {}) {
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超时（${timeout}ms）——handler 可能挂死（护栏被删/回归？）`)),
          timeout
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 统一记录一次依赖调用：无参记字符串，有参记 [name, arg]（便于断言顺序与参数） */
function logCall(calls, name, arg) {
  calls.push(arg === undefined ? name : [name, arg])
}

const callNames = (calls) => calls.map((c) => (Array.isArray(c) ? c[0] : c))
const countCall = (calls, name) => callNames(calls).filter((n) => n === name).length
const callArgs = (calls, name) =>
  calls
    .filter((c) => (Array.isArray(c) ? c[0] === name : c === name))
    .map((c) => (Array.isArray(c) ? c[1] : undefined))
const callArg = (calls, name) => {
  const found = calls.find((c) => (Array.isArray(c) ? c[0] === name : c === name))
  return Array.isArray(found) ? found[1] : undefined
}

function assertCalled(calls, name, message) {
  assert(countCall(calls, name) > 0, message ?? `应调用 ${name}（实际调用：${callNames(calls).join(' → ')}）`)
}

function assertNotCalled(calls, name, message) {
  assertEq(countCall(calls, name), 0, message ?? `不应调用 ${name}（实际调用：${callNames(calls).join(' → ')}）`)
}

/** 断言一组调用按给定顺序出现（允许中间夹别的调用） */
function assertOrder(calls, names, message) {
  const seq = callNames(calls)
  let at = -1
  for (const name of names) {
    const idx = seq.indexOf(name, at + 1)
    assert(
      idx > at,
      `${message ?? '调用顺序不成立'}：期望 ${names.join(' → ')}，实际 ${seq.join(' → ')}`
    )
    at = idx
  }
}

const flagValues = (calls) =>
  calls.filter((c) => Array.isArray(c) && c[0] === 'setUpdateInFlight').map((c) => c[1])

// ─── env 套件 fake deps ─────────────────────────────────────────────────────

function makeEnvDeps(over = {}) {
  const calls = []
  const rollbackArgs = []
  const state = { running: over.running === true, schemaReads: 0, isReady: null }
  const push = (name, arg) => logCall(calls, name, arg)

  const download = {
    checkEnvironment: async () => {
      push('checkEnvironment')
      return over.checkEnvironment ?? { ok: true }
    },
    initEnvironment: async (options) => {
      push('initEnvironment', options)
      if (over.initGate) return over.initGate
      if (typeof over.initResult === 'function') return over.initResult(options)
      return { ...(over.initResult ?? { success: true }) }
    },
    updateOpenClaw: async (options) => {
      push('updateOpenClaw', options)
      if (over.updateGate) return over.updateGate
      if (typeof over.updateResult === 'function') return over.updateResult(options)
      return { ...(over.updateResult ?? { success: true }) }
    },
    restoreOpenClawBackup: async () => {
      push('restoreOpenClawBackup')
      return over.restore ?? { restored: false }
    },
    discardOpenClawBackup: () => {
      push('discardOpenClawBackup')
    },
    checkLatestVersion: async (options) => {
      push('checkLatestVersion', options)
      return over.latest ?? { latest: '9.9.9' }
    },
    getEnvInfo: () => {
      push('getEnvInfo')
      return over.envInfo ?? { env: true }
    },
    getNodeVersions: async (options) => {
      push('getNodeVersions', options)
      return over.nodeVersions ?? { versions: [] }
    },
    updateNodeRuntime: async (options) => {
      push('updateNodeRuntime', options)
      if (typeof over.nodeResult === 'function') return over.nodeResult(options)
      return { ...(over.nodeResult ?? { success: true }) }
    }
  }

  const claw = {
    getStatus: () => {
      push('getStatus')
      return { running: state.running }
    },
    start: async () => {
      push('start')
      if (over.startThrows) throw new Error(over.startThrows)
      const result =
        typeof over.startResult === 'function'
          ? over.startResult()
          : { ...(over.startResult ?? { success: true }) }
      state.running =
        over.startRunningAfter !== undefined ? over.startRunningAfter : result.success !== false
      return result
    },
    stop: async () => {
      push('stop')
      // 可控的停网关：用于验证「stop 未 resolve 前不得进入下一步」（去掉 await 的回归会被抓）
      if (over.stopGate) await over.stopGate
      state.running = false
      return { stopped: true }
    },
    prepareForDoctor: async () => {
      push('prepareForDoctor')
      return { prepared: true }
    },
    readSchemaVersions: async () => {
      push('readSchemaVersions')
      state.schemaReads += 1
      return state.schemaReads === 1
        ? (over.schemaBefore ?? { work: 1 })
        : (over.schemaAfter ?? over.schemaBefore ?? { work: 1 })
    },
    runDoctorFix: async () => {
      push('runDoctorFix')
      return { ...(over.doctor ?? { success: true }) }
    },
    probeStartup: async (isReady) => {
      push('probeStartup')
      state.isReady = isReady
      return over.probe ?? { ok: true, reason: 'ready' }
    }
  }

  const deps = {
    download,
    claw,
    gatewayReady: async () => {
      push('gatewayReady')
      return over.gatewayReady ?? true
    },
    setUpdateInFlight: (value) => {
      push('setUpdateInFlight', value)
    },
    decideRollback: (probe, dataMigrated) => {
      push('decideRollback')
      rollbackArgs.push({ probe, dataMigrated })
      return over.rollback ?? { rollback: false, reason: '默认不回滚' }
    }
  }
  // runtimeProbe 在 env.ts 里是可选依赖：不注入时应返回 null（渲染端不显示横幅）
  if (over.runtimeProbe !== undefined) deps.runtimeProbe = over.runtimeProbe

  return { deps, calls, state, rollbackArgs }
}

// ─── claw 套件 fake deps ────────────────────────────────────────────────────

function makeClawDeps(over = {}) {
  const calls = []
  const logs = []
  const push = (name, arg) => logCall(calls, name, arg)
  const files = over.files ?? new Map()
  const home = over.home ?? join('C:', 'Users', 'tester')
  const dataDir = over.dataDir ?? join('D:', 'umi-data')
  const paths = {
    config: join(dataDir, 'config', '.openclaw', 'openclaw.json'),
    home: join(home, '.openclaw', 'openclaw.json'),
    data: join(dataDir, 'openclaw', 'openclaw.json')
  }

  const deps = {
    isEnvUpdateInFlight: () => {
      push('isEnvUpdateInFlight')
      return over.inFlight === true
    },
    envUpdateInProgressError: over.updateError ?? 'OpenClaw 正在更新，请等待更新完成后再启动',
    assertConsent: async () => {
      push('assertConsent')
      if (over.consentError) throw over.consentError
    },
    start: async () => {
      push('start')
      return over.startResult ?? { success: true, pid: 4242 }
    },
    stop: async () => {
      push('stop')
      // 可控的停网关：验证 restart 在 stop 未 resolve 前不得 start
      if (over.stopGate) await over.stopGate
      return over.stopResult ?? { stopped: true }
    },
    getStatus: () => {
      push('getStatus')
      return over.status ?? { running: true, ready: true }
    },
    waitReady: async (timeoutMs) => {
      push('waitReady', timeoutMs)
      return { ready: true, timeoutMs }
    },
    getPort: () => {
      push('getPort')
      return over.port ?? 3213
    },
    openExternal: async (url) => {
      push('openExternal', url)
      return over.openExternalResult ?? { opened: true }
    },
    configDir: (dir) => {
      push('configDir', dir)
      return join(dir, 'config', '.openclaw')
    },
    getDataDir: () => {
      push('getDataDir')
      return dataDir
    },
    getHomeDir: () => {
      push('getHomeDir')
      return home
    },
    fileExists: (path) => {
      push('fileExists', path)
      return files.has(path)
    },
    readFile: (path) => {
      push('readFile', path)
      if (!files.has(path)) throw new Error('ENOENT: ' + path)
      return files.get(path)
    },
    log: (line) => {
      push('log', line)
      logs.push(line)
    }
  }

  return { deps, calls, logs, files, paths, home, dataDir }
}

// ─── config 套件 fake deps ──────────────────────────────────────────────────

function makeConfigDeps(over = {}) {
  const calls = []
  const push = (name, arg) => logCall(calls, name, arg)
  const config = over.config ?? { port: 3213, launchOnBoot: true }
  const dataDir = over.dataDir ?? join('D:', 'umi-data')

  const deps = {
    getConfig: () => {
      push('getConfig')
      return config
    },
    saveConfig: async (partial) => {
      push('saveConfig', partial)
      if (typeof over.saveResult === 'function') return over.saveResult(partial)
      return { ...(over.saveResult ?? { ...partial, launchOnBoot: true }) }
    },
    resetConfig: async () => {
      push('resetConfig')
      if (typeof over.resetResult === 'function') return over.resetResult()
      return { ...(over.resetResult ?? config) }
    },
    applyLoginItemSettings: (launchOnBoot) => {
      push('applyLoginItemSettings', launchOnBoot)
    },
    getDataDir: () => {
      push('getDataDir')
      return dataDir
    },
    getPresetModels: (configName) => {
      push('getPresetModels', configName)
      return over.presets ?? [{ id: 'fast-model' }]
    },
    refreshModelPresets: () => {
      push('refreshModelPresets')
      return over.refresh ?? { refreshed: true }
    },
    getModelPresetsInfo: () => {
      push('getModelPresetsInfo')
      return over.info ?? { source: 'remote' }
    },
    openDataDir: (dir) => {
      push('openDataDir', dir)
      return over.openResult ?? { opened: true }
    }
  }

  return { deps, calls, config, dataDir }
}

// ─── terminal 套件 fake deps（不真正 spawn） ────────────────────────────────

function makeFakeProc(over = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = {
    destroyed: over.destroyed === true,
    writes: [],
    write(data) {
      this.writes.push(data)
    }
  }
  return proc
}

function makeTerminalDeps(over = {}) {
  const calls = []
  const push = (name, arg) => logCall(calls, name, arg)
  const sessions = new Map()
  const spawned = []
  const runtimeConfig = over.runtimeConfig ?? {
    nodePath: join('D:', 'runtime', 'node.exe'),
    cwd: join('D:', 'openclaw')
  }
  const resolved = over.resolve ?? {
    entryJs: join('D:', 'openclaw', 'entry.js'),
    env: { OPENCLAW_HOME: 'D:/umi-data/config' }
  }
  for (const id of over.initialSessions ?? []) sessions.set(id, { id, process: makeFakeProc() })

  const deps = {
    spawn: (...args) => {
      push('spawn', args)
      if (over.spawnThrows) throw new Error(over.spawnThrows)
      const proc = makeFakeProc(over.procOptions ?? {})
      spawned.push(proc)
      return proc
    },
    getRuntimeConfig: () => {
      push('getRuntimeConfig')
      return runtimeConfig
    },
    resolveRuntime: (runtime) => {
      push('resolveRuntime', runtime)
      return resolved
    },
    sessions: {
      size: () => {
        push('sessions.size')
        return sessions.size
      },
      has: (id) => {
        push('sessions.has', id)
        return sessions.has(id)
      },
      get: (id) => {
        push('sessions.get', id)
        return sessions.get(id)
      },
      set: (id, session) => {
        push('sessions.set', id)
        sessions.set(id, session)
      },
      delete: (id) => {
        push('sessions.delete', id)
        sessions.delete(id)
      },
      firstKey: () => {
        push('sessions.firstKey')
        return sessions.keys().next().value
      }
    },
    killSession: (id) => {
      push('killSession', id)
      sessions.delete(id)
      return over.killResult ?? true
    },
    killAll: () => {
      push('killAll')
      sessions.clear()
    },
    send: (channel, payload) => {
      calls.push(['send', channel, payload])
    },
    log: (line) => {
      push('log', line)
    },
    logError: (...args) => {
      push('logError', args)
    }
  }

  return { deps, calls, sessions, spawned, runtimeConfig, resolved }
}

// ─── 验收 ───────────────────────────────────────────────────────────────────

const r = new Recorder('host-ipc')

try {
  // ════════════════════════ env：8 通道 ════════════════════════

  await r.check('E1', 'env 注册 8 通道；只读通道原样透传；runtimeProbe 缺省 null、注入后透出', async () => {
    const { deps, calls } = makeEnvDeps({
      checkEnvironment: { ready: false },
      latest: { latest: '2026.11.1' },
      envInfo: { ok: 'info' },
      nodeVersions: { versions: ['v24.22.1'] }
    })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)

    assertDeepEq(
      [...reg.handlers.keys()].sort(),
      [
        'env:check',
        'env:checkLatest',
        'env:getInfo',
        'env:init',
        'env:nodeVersions',
        'env:runtimeProbe',
        'env:update',
        'env:updateNode'
      ].sort(),
      'env 通道集合必须是这 8 个'
    )
    assertEq(reg.handlers.size, 8, 'env 恰好 8 个 handler（禁止偷偷多注册）')

    assertDeepEq(await reg.call('env:check'), { ready: false }, 'env:check 透传 checkEnvironment')
    assertDeepEq(await reg.call('env:checkLatest', { id: 'core' }), { latest: '2026.11.1' })
    assertDeepEq(callArg(calls, 'checkLatestVersion'), { id: 'core' }, 'env:checkLatest 透传 options')
    assertDeepEq(await reg.call('env:getInfo'), { ok: 'info' }, 'env:getInfo 透传 getEnvInfo')
    assertDeepEq(await reg.call('env:nodeVersions', { id: 'node' }), { versions: ['v24.22.1'] })
    assertDeepEq(callArg(calls, 'getNodeVersions'), { id: 'node' })
    assertEq(await reg.call('env:runtimeProbe'), null, '未注入 runtimeProbe 时必须返回 null')

    const probe = { ok: false, reason: 'probe-failed', detail: 'EPERM', at: 1700000000000 }
    const { deps: deps2 } = makeEnvDeps({ runtimeProbe: () => probe })
    const reg2 = makeRegistrar()
    registerEnvIpc(reg2, deps2)
    assertEq(await reg2.call('env:runtimeProbe'), probe, 'runtimeProbe 结果原样透出')
    return '8 通道 + 6 个只读透传 + runtimeProbe 两态'
  })

  await r.check('E2', 'env 单飞闸双向：init/update/updateNode 共用同一把闸，在途第二个只回执不碰 deps', async () => {
    const gate = deferred()
    const { deps, calls } = makeEnvDeps({ initGate: gate.promise })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)

    const first = withTimeout(reg.call('env:init', { useMirror: true }), { label: 'E2 首个 env:init' })
    // 失败路径（断言提前抛、gate 永不 resolve）下 2s 后会有一次超时拒绝：提前挂 handler 防止
    // unhandled rejection 污染输出；成功路径不受影响（gate 会先 resolve）。
    first.catch(() => {})
    const second = await withTimeout(reg.call('env:init', {}), { label: 'E2 第二个 env:init（单飞回执）' })
    assertDeepEq(
      second,
      { success: false, error: ENV_BUSY, inFlight: true },
      '并发第二次必须返回单飞回执（不排队、不 await）'
    )
    assertEq(countCall(calls, 'initEnvironment'), 1, '第二次调用不得再进 deps.initEnvironment')
    assertDeepEq(flagValues(calls), [true], '在途期间 setUpdateInFlight 必须置位')

    // 跨通道共用同一把闸（正向：init 在途 → update / updateNode 都不能进；写同一安装目录/状态库）
    const blockedUpdate = await withTimeout(reg.call('env:update', {}), { label: 'E2 init 在途时 env:update' })
    assertDeepEq(blockedUpdate, { success: false, error: ENV_BUSY, inFlight: true }, 'init 在途时 env:update 也被挡')
    assertNotCalled(calls, 'updateOpenClaw', '被闸门挡住的 update 不得进 deps.updateOpenClaw')
    const cross = await withTimeout(reg.call('env:updateNode', { version: 'v24.22.1' }), {
      label: 'E2 init 在途时 env:updateNode'
    })
    assertDeepEq(cross, { success: false, error: ENV_BUSY, inFlight: true }, 'init 在途时 updateNode 也被挡')
    assertNotCalled(calls, 'updateNodeRuntime', '被闸门挡住的 updateNode 不得动运行时')

    gate.resolve({ success: true })
    assertDeepEq(await first, { success: true }, '闸门内的任务正常完成')
    assertDeepEq(flagValues(calls), [true, false], '任务结束后 setUpdateInFlight 复位')

    assertDeepEq(
      await withTimeout(reg.call('env:init', {}), { label: 'E2 闸门释放后再次 env:init' }),
      { success: true },
      '首次任务结束后闸门释放，可再次进入'
    )
    assertEq(countCall(calls, 'initEnvironment'), 2, '释放后第二次真进 deps')

    // 反向：update 在途时 init / updateNode 也必须被挡（同一把闸的另一方向，只正向测等于没测）
    const updateGate = deferred()
    const reverse = makeEnvDeps({ updateGate: updateGate.promise })
    const regReverse = makeRegistrar()
    registerEnvIpc(regReverse, reverse.deps)
    const updateFirst = withTimeout(regReverse.call('env:update', {}), { label: 'E2 首个 env:update' })
    updateFirst.catch(() => {})
    const blockedInit = await withTimeout(regReverse.call('env:init', {}), {
      label: 'E2 update 在途时 env:init'
    })
    assertDeepEq(blockedInit, { success: false, error: ENV_BUSY, inFlight: true }, 'update 在途时 init 被挡')
    const blockedNode = await withTimeout(regReverse.call('env:updateNode', {}), {
      label: 'E2 update 在途时 env:updateNode'
    })
    assertDeepEq(blockedNode, { success: false, error: ENV_BUSY, inFlight: true }, 'update 在途时 updateNode 被挡')
    assertEq(countCall(reverse.calls, 'initEnvironment'), 0, '被挡的 init 不得进 deps.initEnvironment')
    assertEq(countCall(reverse.calls, 'updateNodeRuntime'), 0, '被挡的 updateNode 不得进 deps.updateNodeRuntime')
    updateGate.resolve({ success: true })
    assertDeepEq(await updateFirst, { success: true }, 'update 闸门内的任务正常完成')
    return '单飞双向 + 跨三个通道 + 释放'
  })

  await r.check('E3', 'env 任务抛异常时：错误向上抛、闸门与 setUpdateInFlight 都复位', async () => {
    let round = 0
    const { deps, calls } = makeEnvDeps({
      initResult: () => {
        round += 1
        if (round === 1) throw new Error('init boom')
        return { success: true }
      }
    })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)

    let rejected = null
    try {
      await reg.call('env:init', {})
    } catch (e) {
      rejected = e
    }
    assert(rejected, 'env:init 异常必须向上抛（不能吞成 success 回执）')
    assert(String(rejected.message).includes('init boom'), '原始错误信息必须保留')
    assertDeepEq(flagValues(calls), [true, false], '异常路径 finally 必须复位 setUpdateInFlight')
    assertEq(countCall(calls, 'initEnvironment'), 1)

    assertDeepEq(await reg.call('env:init', {}), { success: true }, '异常后闸门必须释放（否则环境永久卡死）')
    assertEq(countCall(calls, 'initEnvironment'), 2, '异常后第二次能真进 deps')
    return '异常上抛 + 闸门/标记双复位'
  })

  await r.check('E4', 'env:init：停网关 → 初始化 → 恢复，setUpdateInFlight 全程置位；没在跑则不动网关', async () => {
    const { deps, calls } = makeEnvDeps({ running: true })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)

    const result = await reg.call('env:init', { useMirror: true })
    assertDeepEq(result, { success: true }, '初始化成功原样返回')
    assertOrder(
      calls,
      ['setUpdateInFlight', 'getStatus', 'stop', 'initEnvironment', 'start', 'setUpdateInFlight'],
      '初始化链路顺序固定：置位 → 停网关 → 初始化 → 起网关 → 复位'
    )
    assertDeepEq(flagValues(calls), [true, false], 'setUpdateInFlight 先置位后复位')
    assertDeepEq(callArg(calls, 'initEnvironment'), { useMirror: true }, 'options 原样透传')

    const off = makeEnvDeps({ running: false })
    const regOff = makeRegistrar()
    registerEnvIpc(regOff, off.deps)
    await regOff.call('env:init', {})
    assertNotCalled(off.calls, 'stop', '网关没在跑时不得 stop')
    assertNotCalled(off.calls, 'start', '网关没在跑时不得 start（不凭空拉起）')

    // 时序：stop 未 resolve 前绝不能开始初始化（assertOrder 只看同步 push，去掉 await 仍会绿）
    const stopGate = deferred()
    const gated = makeEnvDeps({ running: true, stopGate: stopGate.promise })
    const regGated = makeRegistrar()
    registerEnvIpc(regGated, gated.deps)
    const initing = withTimeout(regGated.call('env:init', {}), { label: 'E4 停网关中的 env:init' })
    initing.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertCalled(gated.calls, 'stop', '停网关必须先发生')
    assertNotCalled(gated.calls, 'initEnvironment', 'stop 还没 resolve 就初始化了（env:init 丢了 await）')
    stopGate.resolve()
    assertDeepEq(await initing, { success: true })
    assertOrder(
      gated.calls,
      ['setUpdateInFlight', 'getStatus', 'stop', 'initEnvironment', 'start'],
      'stop resolve 后才允许初始化与恢复'
    )
    return '顺序 + 置位 + 未运行不扰动 + stop 未 resolve 不前进'
  })

  await r.check('E5', 'env:init 网关恢复分支：失败转 warning、进程真在跑不误报、初始化失败拼进 error', async () => {
    // a) start 返回 success:false 且进程确实没起来 → 初始化成功转 warning
    const a = makeEnvDeps({
      running: true,
      startResult: () => ({ success: false, error: 'port busy' })
    })
    const regA = makeRegistrar()
    registerEnvIpc(regA, a.deps)
    const resA = await regA.call('env:init', {})
    assertEq(resA.success, true, '网关重启失败不改变初始化结果本身')
    assert(String(resA.warning).includes('网关重启失败：port busy'), '失败原因必须转 warning（不能吞）')
    assertEq(resA.error, undefined, '成功结果不应带 error')

    // b) start 返回 success:false 但进程确实在跑（'已在运行中'）→ 不得误报
    const b = makeEnvDeps({
      running: true,
      startResult: () => ({ success: false, error: '已在运行中' }),
      startRunningAfter: true
    })
    const regB = makeRegistrar()
    registerEnvIpc(regB, b.deps)
    const resB = await regB.call('env:init', {})
    assertEq(resB.success, true)
    assertEq(resB.warning, undefined, '以「进程是否真在跑」为准，success:false 不能直接当重启失败')

    // c) 初始化失败 + 重启抛异常 → 两段信息都拼进 error
    const c = makeEnvDeps({
      running: true,
      initResult: () => ({ success: false, error: '装不上' }),
      startThrows: 'EPERM'
    })
    const regC = makeRegistrar()
    registerEnvIpc(regC, c.deps)
    const resC = await regC.call('env:init', {})
    assertEq(resC.success, false)
    assert(String(resC.error).includes('装不上'), '原初始化错误必须保留')
    assert(String(resC.error).includes('网关重启失败：EPERM'), '重启失败必须拼进 error（UI 失败分支只显示 error）')
    return '成功转 warning / 已运行不误报 / 失败拼接'
  })

  await r.check('E6', 'env:update 成功链路：停网关→prepareForDoctor→迁移判断→探针→丢快照，并按原状态恢复', async () => {
    const probe = { ok: true, reason: 'ready', at: 1 }
    const { deps, calls, state, rollbackArgs } = makeEnvDeps({
      running: true,
      probe,
      rollback: { rollback: false, reason: '探针 ok' },
      schemaBefore: { work: 1, marketing: 1 },
      schemaAfter: { work: 2, marketing: 2 }
    })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)

    const result = await reg.call('env:update', { useMirror: false })
    assertEq(result.success, true)
    assertEq(result.warning, undefined)
    assertOrder(
      calls,
      [
        'setUpdateInFlight',
        'getStatus',
        'stop',
        'prepareForDoctor',
        'updateOpenClaw',
        'readSchemaVersions',
        'runDoctorFix',
        'readSchemaVersions',
        'probeStartup',
        'decideRollback',
        'discardOpenClawBackup'
      ],
      '更新链路顺序固定（回滚判据在探针之后，快照在探测 ok 后才丢）'
    )
    assertDeepEq(flagValues(calls), [true, false])
    assertDeepEq(callArg(calls, 'updateOpenClaw'), { useMirror: false })
    assertEq(countCall(calls, 'readSchemaVersions'), 2, '迁移前后各量一次 schema 版本')
    assertEq(rollbackArgs.length, 1, '回滚判据只问一次')
    assertEq(rollbackArgs[0].probe, probe, '真实探针结果原样交给判据（不能是常量）')
    assertEq(rollbackArgs[0].dataMigrated, true, 'schema 变了 → dataMigrated=true')
    assertEq(typeof state.isReady, 'function', 'probeStartup 必须拿到 isReady 回调（/health 200 判据）')
    assertEq(await state.isReady(), true, 'isReady 应走 deps.gatewayReady')
    assertCalled(calls, 'gatewayReady', '探针就绪判据必须真的调 gatewayReady')
    assertCalled(calls, 'discardOpenClawBackup', '探测 ok → 候选版本正式生效，快照可删')
    assertNotCalled(calls, 'start', 'wasRunning=true 且探针 ok → 不得重复 start')
    assertEq(countCall(calls, 'stop'), 1, '只在更新前停一次网关（探针拉起的不再手动停）')

    // b) 更新前网关没在跑：探针把它拉起来验证后必须恢复原状（停掉），且不 start
    const b = makeEnvDeps({
      running: false,
      probe,
      rollback: { rollback: false, reason: '探针 ok' }
    })
    const regB = makeRegistrar()
    registerEnvIpc(regB, b.deps)
    const resB = await regB.call('env:update', {})
    assertEq(resB.success, true)
    assertCalled(b.calls, 'prepareForDoctor', '网关没在跑也必须清残留（doctor 要独占状态库）')
    assertCalled(b.calls, 'discardOpenClawBackup')
    assertEq(countCall(b.calls, 'stop'), 1, '更新前没停过，探针验证后要停一次恢复原状')
    assertNotCalled(b.calls, 'start', '原本没在跑 → 更新后不得 start')

    // c) schema 版本没变 → dataMigrated 必须 false（判据不能恒为 true，否则「未迁移却拒绝回滚」）
    const c = makeEnvDeps({
      running: true,
      probe,
      rollback: { rollback: false, reason: '探针 ok' },
      schemaBefore: { work: 3, marketing: 2 },
      schemaAfter: { work: 3, marketing: 2 }
    })
    const regC = makeRegistrar()
    registerEnvIpc(regC, c.deps)
    assertEq((await regC.call('env:update', {})).success, true)
    assertEq(c.rollbackArgs.length, 1)
    assertEq(
      c.rollbackArgs[0].dataMigrated,
      false,
      'schema 一字未变 → dataMigrated=false（判据必须按实际比较，不能写死 true）'
    )
    return '成功链路顺序 + schema 迁移判断（true/false 两态）+ 两态恢复'
  })

  await r.check('E7', 'env:update 回滚分支：探针自退+判据允许 → 自动回滚，绝不丢快照', async () => {
    const probe = { ok: false, refused: false, reason: '进程自退' }
    const { deps, calls } = makeEnvDeps({
      running: true,
      probe,
      rollback: { rollback: true, reason: '数据未迁移' },
      schemaBefore: { work: 1 },
      schemaAfter: { work: 1 },
      restore: { restored: true, version: '2026.10.1' }
    })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)

    const result = await reg.call('env:update', {})
    assertEq(result.success, false, '回滚后整体结果必须为失败（UI 要提示稍后重试）')
    assertEq(result.rolledBack, true, 'rolledBack 必须透出')
    assertEq(result.currentVersion, '2026.10.1', '回滚目标版本透出')
    assert(String(result.error).includes('已自动回滚'), 'error 必须说明已回滚')
    assertNotCalled(calls, 'discardOpenClawBackup', '回滚分支绝不能删快照')
    assertCalled(calls, 'restoreOpenClawBackup')
    assertOrder(calls, ['restoreOpenClawBackup', 'start'], '回滚后按原状态重启网关')
    assertEq(countCall(calls, 'start'), 1)

    // b) 快照不可用 → 降级为 warning（保留新版本），仍尝试恢复网关
    const b = makeEnvDeps({
      running: true,
      probe,
      rollback: { rollback: true, reason: '数据未迁移' },
      restore: { restored: false }
    })
    const regB = makeRegistrar()
    registerEnvIpc(regB, b.deps)
    const resB = await regB.call('env:update', {})
    // 现状锁定：restore=false 时 success 保持 true（只加 warning）——已在 PROGRESS 4.5 复核补充登记，
    // 若将来产品决定「回滚失败应判失败」，改这里前先改生产代码与 PROGRESS。
    assertEq(resB.success, true, '快照缺失时降级为警告，更新本身仍算成功')
    assert(String(resB.warning).includes('回滚快照不可用'), '必须明确告知快照不可用')
    assertEq(resB.rolledBack, undefined, '没能回滚就不许报 rolledBack')
    assertCalled(b.calls, 'start', '更新成功后按原状态恢复网关')
    return '回滚成功 / 快照缺失降级'
  })

  await r.check('E8', 'env:update 不贸然回滚：refused 时保留新版本；探针未就绪时不 start', async () => {
    // a) 进程自退但回滚不安全（数据已迁移）→ 保留新版本 + 说清补救动作
    const a = makeEnvDeps({
      running: true,
      probe: { ok: false, refused: true, reason: '进程自退' },
      rollback: { rollback: false, reason: '数据已迁移，回滚会让旧二进制读不了新库' }
    })
    const regA = makeRegistrar()
    registerEnvIpc(regA, a.deps)
    const resA = await regA.call('env:update', {})
    assertEq(resA.success, true)
    assert(String(resA.warning).includes('数据已迁移，回滚会让旧二进制读不了新库'), '判据给的理由必须透出')
    assert(String(resA.warning).includes('保留新版本'), '必须说明保留新版本')
    assertNotCalled(a.calls, 'restoreOpenClawBackup', '判据拒绝时绝不能回滚')
    assertNotCalled(
      a.calls,
      'discardOpenClawBackup',
      'refused 分支绝不能丢快照——那是用户唯一还能回滚的路径（审查实测：加 discard 原本不红）'
    )
    assertCalled(a.calls, 'start', '新版本保留且更新成功 → 恢复网关')

    // b) 进程还在但迟迟没就绪 → 证据不足不判死；gatewayRunning 避免重复 start
    const b = makeEnvDeps({
      running: true,
      probe: { ok: false, reason: '等待 /health 超时' },
      rollback: { rollback: false, reason: '证据不足' }
    })
    const regB = makeRegistrar()
    registerEnvIpc(regB, b.deps)
    const resB = await regB.call('env:update', {})
    assertEq(resB.success, true)
    assert(String(resB.warning).includes('未在预期时间内就绪'), '必须说明未就绪而非失败')
    assertNotCalled(b.calls, 'start', '探针拉起的网关还在跑 → 不得再 start')
    assertEq(countCall(b.calls, 'stop'), 1, '只在更新前停一次（后续不重复停）')
    assertNotCalled(
      b.calls,
      'discardOpenClawBackup',
      '未就绪（非 ok）分支同样不得丢快照（审查实测：加 discard 原本不红）'
    )
    return 'refused 保留新版本 / 未就绪不重复 start（两分支都不丢快照）'
  })

  await r.check('E9', 'env:update 失败与边角：更新失败不重启、unchanged 照常重启、doctor 失败仅 warning', async () => {
    // a) 更新本身失败且没回滚 → 环境不确定，不贸然重启
    const a = makeEnvDeps({ running: true, updateResult: { success: false, error: '镜像全挂' } })
    const regA = makeRegistrar()
    registerEnvIpc(regA, a.deps)
    const resA = await regA.call('env:update', {})
    assertEq(resA.success, false)
    assertNotCalled(a.calls, 'readSchemaVersions', '更新失败不得继续跑迁移判断')
    assertNotCalled(a.calls, 'runDoctorFix')
    assertNotCalled(a.calls, 'probeStartup')
    assertNotCalled(a.calls, 'restoreOpenClawBackup')
    assertNotCalled(a.calls, 'start', '更新失败且未回滚 → 不得 start（环境不确定）')
    assertCalled(a.calls, 'prepareForDoctor', 'prepareForDoctor 在更新前，失败也会执行')

    // b) unchanged（Node 预检在动手前中止）→ 环境没动过，照常重启
    const b = makeEnvDeps({
      running: true,
      updateResult: { success: false, unchanged: true, warning: 'Node 预检未过' }
    })
    const regB = makeRegistrar()
    registerEnvIpc(regB, b.deps)
    const resB = await regB.call('env:update', {})
    assertEq(resB.unchanged, true)
    assertCalled(b.calls, 'start', 'unchanged：环境没动过，必须恢复网关')
    assertNotCalled(b.calls, 'readSchemaVersions')

    // c) doctor 非 0 退出但探针 ok → 只 warning，不能当回滚判据
    const c = makeEnvDeps({
      running: true,
      doctor: { success: false, error: '插件白名单过期' },
      probe: { ok: true, reason: 'ready' }
    })
    const regC = makeRegistrar()
    registerEnvIpc(regC, c.deps)
    const resC = await regC.call('env:update', {})
    assertEq(resC.success, true, 'doctor 失败不改变可用性结论')
    assert(String(resC.warning).includes('数据库迁移（doctor --fix）未正常结束：插件白名单过期'), 'doctor 失败要说明并保留 warning')
    assertCalled(c.calls, 'discardOpenClawBackup', '真判据是启动探针，探测 ok 仍丢快照')
    return '失败不重启 / unchanged 重启 / doctor 仅 warning'
  })

  await r.check('E10', 'env:updateNode：停网关→更新运行时→恢复；重启失败转 warning；没在跑不扰动', async () => {
    const { deps, calls } = makeEnvDeps({ running: true })
    const reg = makeRegistrar()
    registerEnvIpc(reg, deps)
    const result = await reg.call('env:updateNode', { version: 'v24.22.1', useMirror: true })
    assertDeepEq(result, { success: true })
    assertOrder(
      calls,
      ['setUpdateInFlight', 'getStatus', 'stop', 'updateNodeRuntime', 'start', 'setUpdateInFlight'],
      'Node 更新顺序固定：置位 → 停网关 → 换运行时 → 起网关 → 复位'
    )
    assertDeepEq(callArg(calls, 'updateNodeRuntime'), { version: 'v24.22.1', useMirror: true })
    assertDeepEq(flagValues(calls), [true, false])

    // 重启失败（抛）→ 结果保留 + warning
    const b = makeEnvDeps({ running: true, startThrows: 'port busy' })
    const regB = makeRegistrar()
    registerEnvIpc(regB, b.deps)
    const resB = await regB.call('env:updateNode', {})
    assertEq(resB.success, true, '网关重启失败不改变 Node 更新结果')
    assert(String(resB.warning).includes('网关重启失败：port busy'))

    // 没在跑 → 不停/不起
    const c = makeEnvDeps({ running: false })
    const regC = makeRegistrar()
    registerEnvIpc(regC, c.deps)
    await regC.call('env:updateNode', {})
    assertNotCalled(c.calls, 'stop', '网关没在跑时不得 stop')
    assertNotCalled(c.calls, 'start', '网关没在跑时不得 start')
    return '顺序 + 重启失败 warning + 未运行不扰动'
  })

  // ════════════════════════ claw：7 通道 ════════════════════════

  await r.check('C1', 'claw 注册 7 通道；start 透传、stop/status 只读不查协议', async () => {
    const { deps, calls } = makeClawDeps({ startResult: { success: true, pid: 777 } })
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)

    assertDeepEq(
      [...reg.handlers.keys()].sort(),
      [
        'claw:get-token',
        'claw:openWeb',
        'claw:restart',
        'claw:start',
        'claw:status',
        'claw:stop',
        'claw:waitReady'
      ].sort(),
      'claw 通道集合必须是这 7 个'
    )
    assertEq(reg.handlers.size, 7, 'claw 恰好 7 个 handler')
    assertDeepEq(await reg.call('claw:start'), { success: true, pid: 777 }, 'start 结果原样透出')
    assertOrder(calls, ['isEnvUpdateInFlight', 'assertConsent', 'start'], 'start 必须先过两个闸门')
    assertDeepEq(await reg.call('claw:stop'), { stopped: true }, 'stop 透传')
    assertDeepEq(await reg.call('claw:status'), { running: true, ready: true }, 'status 透传')
    assertEq(countCall(calls, 'assertConsent'), 1, 'stop/status 是只读通道，不该再查协议')
    return '7 通道 + 透传 + 只读通道无协议门'
  })

  await r.check('C2', 'claw:start/restart 未同意协议 → consent-required 且绝不启动/先停', async () => {
    const { deps, calls } = makeClawDeps({ consentError: new Error('请先同意用户协议') })
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)

    assertDeepEq(
      await reg.call('claw:start'),
      { success: false, reason: 'consent-required', error: '请先同意用户协议' },
      '未同意协议必须返回 consent-required 信封（前端据此弹协议窗）'
    )
    assertNotCalled(calls, 'start', '协议闸门未通过时绝不能调 deps.start')

    const restarted = await reg.call('claw:restart')
    assertEq(restarted.success, false)
    assertEq(restarted.reason, 'consent-required')
    assertNotCalled(calls, 'stop', '协议闸门未通过时 restart 也不得先 stop（不能把在跑的网关停掉）')
    assertNotCalled(calls, 'start')
    assertEq(countCall(calls, 'assertConsent'), 2, '两个入口都必须过协议闸门')
    return '两个启动入口都被协议闸门挡住'
  })

  await r.check('C3', 'claw:start/restart 环境更新在途 → 拒绝且不查协议、不动进程', async () => {
    const error = 'OpenClaw 正在更新，请等待更新完成后再启动'
    const { deps, calls } = makeClawDeps({ inFlight: true, updateError: error })
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)

    assertDeepEq(await reg.call('claw:start'), { success: false, error }, '更新在途必须拒绝 start')
    assertDeepEq(await reg.call('claw:restart'), { success: false, error }, '更新在途必须拒绝 restart')
    assertNotCalled(calls, 'assertConsent', '更新闸门在协议检查之前（负向：不该再走协议）')
    assertNotCalled(calls, 'start', '更新在途绝不能拉进程')
    assertNotCalled(calls, 'stop', '更新在途 restart 不得先 stop（doctor 正在用状态库）')
    assertEq(countCall(calls, 'isEnvUpdateInFlight'), 2)
    return '更新闸门优先于协议检查，且零进程副作用'
  })

  await r.check('C4', 'claw:restart = stop 后 start（顺序固定且 stop 未 resolve 前不 start），返回值来自 start', async () => {
    const { deps, calls } = makeClawDeps({ startResult: { success: true, pid: 666 } })
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)
    assertDeepEq(await reg.call('claw:restart'), { success: true, pid: 666 }, 'restart 返回 start 的结果')
    assertOrder(
      calls,
      ['isEnvUpdateInFlight', 'assertConsent', 'stop', 'start'],
      'restart 必须先 stop 再 start（顺序反了会起两个网关）'
    )
    assertEq(countCall(calls, 'stop'), 1)
    assertEq(countCall(calls, 'start'), 1)

    // 时序：stop 未 resolve 前绝不能 start（assertOrder 只看同步 push，去掉 await 仍会绿）
    const stopGate = deferred()
    const gated = makeClawDeps({ stopGate: stopGate.promise })
    const regGated = makeRegistrar()
    registerClawIpc(regGated, gated.deps)
    const restarting = withTimeout(regGated.call('claw:restart'), { label: 'C4 stop 中的 claw:restart' })
    restarting.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertCalled(gated.calls, 'stop', 'stop 必须已经发生')
    assertNotCalled(gated.calls, 'start', 'stop 未 resolve 就 start 了（restart 丢了 await）')
    stopGate.resolve()
    assertDeepEq(await restarting, { success: true, pid: 4242 }, 'stop resolve 后才 start 并透出结果')
    assertOrder(gated.calls, ['assertConsent', 'stop', 'start'], 'stop resolve 后才允许 start')
    return 'stop → start 顺序 + stop 未 resolve 不前进'
  })

  await r.check('C5', 'claw:waitReady 参数校验：只转发正有限数，非法/非正数一律 undefined', async () => {
    const { deps, calls } = makeClawDeps()
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)
    const cases = [
      [5000, 5000],
      [1.5, 1.5],
      [undefined, undefined],
      [0, undefined],
      [-1, undefined],
      [NaN, undefined],
      [Infinity, undefined],
      ['5000', undefined],
      [null, undefined]
    ]
    const forwarded = []
    for (const [input, expected] of cases) {
      const result = await reg.call('claw:waitReady', input)
      assertEq(result.timeoutMs, expected, `waitReady(${String(input)}) 应转发 ${String(expected)}`)
      forwarded.push(expected)
    }
    assertDeepEq(
      callArgs(calls, 'waitReady'),
      forwarded,
      'deps.waitReady 实际收到的参数必须逐个一致（非法值不能穿透给 clawManager）'
    )
    return `${cases.length} 个输入逐个校验`
  })

  await r.check('C6', 'claw:openWeb 拼 localhost:port 并透出 openExternal 结果', async () => {
    const { deps, calls } = makeClawDeps({ port: 3213, openExternalResult: { opened: 'web' } })
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)
    assertDeepEq(await reg.call('claw:openWeb'), { opened: 'web' }, 'openExternal 的结果必须 await 后透出')
    assertEq(callArg(calls, 'openExternal'), 'http://localhost:3213', 'URL 必须是 localhost:port（不写死端口）')
    assertEq(countCall(calls, 'getPort'), 1, '端口只取一次')
    return 'localhost:3213 拼接正确'
  })

  await r.check('C7', 'claw:get-token 只读标准路径（命中即停）且 token 绝不进日志/控制台', async () => {
    const { deps, calls, logs, files, paths } = makeClawDeps()
    const reg = makeRegistrar()
    registerClawIpc(reg, deps)
    const token = 'tok-SECRET-1234567890'
    files.set(paths.config, JSON.stringify({ gateway: { token } }))
    files.set(paths.home, JSON.stringify({ gateway: { token: 'HOME-TOKEN' } }))
    files.set(paths.data, JSON.stringify({ gateway: { token: 'DATA-TOKEN' } }))

    // 直接 console.* 打 token 是最容易漏的泄密路径：调用期间临时接管 console，
    // 抓所有 stdout/stderr 文本（审查实测：生产代码 console.log(configJson) 时原套件仍绿）
    const originalConsole = { log: console.log, error: console.error, warn: console.warn }
    const consoleLines = []
    const capture = (...args) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    }
    let result
    try {
      console.log = capture
      console.error = capture
      console.warn = capture
      result = await withTimeout(reg.call('claw:get-token'), { label: 'claw:get-token' })
    } finally {
      console.log = originalConsole.log
      console.error = originalConsole.error
      console.warn = originalConsole.warn
    }

    assertDeepEq(result, { success: true, token }, '命中环境变量配置目录的 token')
    assertDeepEq(callArgs(calls, 'readFile'), [paths.config], '命中即停：不得继续读家目录/数据目录变体')
    assertDeepEq(callArgs(calls, 'fileExists'), [paths.config], '按优先级探测，命中后不再探测其它路径')
    for (const line of logs) {
      assert(!String(line).includes(token), 'token 绝不能出现在日志里（3.0 安全硬约束）')
    }
    for (const line of consoleLines) {
      assert(!line.includes(token), 'token 绝不能出现在 console 输出里（直打 stdout 也会被抓到）：' + line)
    }
    assert(String(logs[0]).includes('开始扫描'), '扫描开始要有审计日志')
    assert(String(logs[1]).includes(paths.config), '命中路径进日志便于排障')

    // 静态兜底：源码里任何 console.* 调用行都不得带 configJson/token（动态接管只覆盖本次调用路径）
    const clawSrc = readFileSync(join(repoRoot, 'electron', 'main', 'ipc', 'host', 'claw.ts'), 'utf-8')
    const consoleCallLines = clawSrc
      .split('\n')
      .filter((line) => /console\.(log|error|warn|info|debug)\(/.test(line))
    for (const line of consoleCallLines) {
      assert(
        !/configJson|token/i.test(line),
        'claw.ts 的 console 调用不得携带 configJson/token：' + line.trim()
      )
    }
    return `只读 1 个路径，日志 ${logs.length} 行 / console ${consoleLines.length} 行均不含 token`
  })

  await r.check('C8', 'claw:get-token 回退与失败分支：家目录/数据目录、缺文件、缺 token、非法 JSON', async () => {
    // a) 家目录回退 + gateway.auth.token 兼容
    const a = makeClawDeps()
    a.files.set(a.paths.home, JSON.stringify({ gateway: { auth: { token: 'AUTH-TOKEN' } } }))
    const regA = makeRegistrar()
    registerClawIpc(regA, a.deps)
    assertDeepEq(await regA.call('claw:get-token'), { success: true, token: 'AUTH-TOKEN' })
    assertDeepEq(
      callArgs(a.calls, 'fileExists'),
      [a.paths.config, a.paths.home],
      '按 env → home 顺序探测'
    )
    assertDeepEq(callArgs(a.calls, 'readFile'), [a.paths.home], '只读命中的家目录路径')

    // b) dataDir 变体回退
    const b = makeClawDeps()
    b.files.set(b.paths.data, JSON.stringify({ gateway: { token: 'DATA' } }))
    const regB = makeRegistrar()
    registerClawIpc(regB, b.deps)
    assertDeepEq(await regB.call('claw:get-token'), { success: true, token: 'DATA' })
    assertDeepEq(
      callArgs(b.calls, 'fileExists'),
      [b.paths.config, b.paths.home, b.paths.data],
      '前两个都没命中才探 dataDir 变体'
    )

    // c) 全找不到 → 失败并列出已检查路径，且不读文件
    const c = makeClawDeps()
    const regC = makeRegistrar()
    registerClawIpc(regC, c.deps)
    const miss = await regC.call('claw:get-token')
    assertEq(miss.success, false)
    assertEq(miss.token, undefined, '失败时绝不能返回 undefined token 冒充成功')
    for (const p of [c.paths.config, c.paths.home, c.paths.data]) {
      assert(String(miss.error).includes(p), '错误必须列出已检查路径：' + p)
    }
    assertNotCalled(c.calls, 'readFile', '没有文件时不得读文件')

    // d) 文件存在但缺 gateway.token
    const d = makeClawDeps()
    d.files.set(d.paths.config, JSON.stringify({ gateway: { port: 3213 } }))
    const regD = makeRegistrar()
    registerClawIpc(regD, d.deps)
    const noToken = await regD.call('claw:get-token')
    assertEq(noToken.success, false)
    assert(String(noToken.error).includes('缺少 gateway.token'), '必须明确是缺字段而不是文件不存在')

    // e) 非法 JSON → 失败信封，不能抛到 IPC
    const e = makeClawDeps()
    e.files.set(e.paths.config, '{ not json')
    const regE = makeRegistrar()
    registerClawIpc(regE, e.deps)
    const invalid = await regE.call('claw:get-token')
    assertEq(invalid.success, false)
    assert(String(invalid.error).length > 0, '非法 JSON 必须转成失败信封')
    return '2 个回退路径 + 3 个失败分支'
  })

  // ════════════════════════ config：8 通道 ════════════════════════

  await r.check('K1', 'config 注册 8 通道；config:get 原样透出且不写开机自启', async () => {
    const { deps, calls, config } = makeConfigDeps()
    const reg = makeRegistrar()
    registerConfigIpc(reg, deps)

    assertDeepEq(
      [...reg.handlers.keys()].sort(),
      [
        'config:get',
        'config:getDataDir',
        'config:getModelPresetsInfo',
        'config:getPresetModels',
        'config:openDataDir',
        'config:refreshModelPresets',
        'config:reset',
        'config:save'
      ].sort(),
      'config 通道集合必须是这 8 个'
    )
    assertEq(reg.handlers.size, 8, 'config 恰好 8 个 handler')
    assertEq(await reg.call('config:get'), config, 'config:get 原样透出 AppConfig')
    assertNotCalled(calls, 'applyLoginItemSettings', '只读 get 不得写开机自启项（负向）')
    return '8 通道 + get 只读'
  })

  await r.check('K2', 'config:save 拆包：config 干净、false 的同步/落盘状态必须透出、按 launchOnBoot 同步自启', async () => {
    const saved = {
      port: 4000,
      launchOnBoot: true,
      openClawSyncOk: false,
      openClawSyncError: 'sync failed',
      appConfigSavedOk: false,
      appConfigSaveError: 'disk full'
    }
    const { deps, calls } = makeConfigDeps({ saveResult: saved })
    const reg = makeRegistrar()
    registerConfigIpc(reg, deps)
    const partial = { port: 4000 }
    const result = await reg.call('config:save', partial)

    assertEq(result.openClawSyncOk, false, '同步失败必须透出 false（前端据此提示）')
    assertEq(result.openClawSyncError, 'sync failed')
    assertEq(result.appConfigSavedOk, false, '落盘失败必须透出 false')
    assertEq(result.appConfigSaveError, 'disk full')
    assertEq(result.config.port, 4000, 'config 里保留真实配置字段')
    assertEq(result.config.launchOnBoot, true)
    for (const key of ['openClawSyncOk', 'openClawSyncError', 'appConfigSavedOk', 'appConfigSaveError']) {
      assert(!(key in result.config), '状态字段不得混进干净 config：' + key)
    }
    assertDeepEq(callArg(calls, 'saveConfig'), partial, '前端传入的 partial 必须原样（深比较）交给 configManager')
    assertEq(callArg(calls, 'applyLoginItemSettings'), true, '保存后必须按 launchOnBoot 同步开机自启')
    // 现状锁定：即使 openClawSyncOk/appConfigSavedOk=false 仍调用 applyLoginItemSettings——
    // 已在 PROGRESS 4.5 复核补充登记，改产品语义前先改生产代码与本断言。
    return '拆包形状 + false 透出 + 自启同步'
  })

  await r.check('K3', 'config:save/reset 缺省语义：状态缺省视为成功（true/null），reset 同样拆包并同步自启', async () => {
    const { deps, calls } = makeConfigDeps({
      saveResult: { port: 3213, launchOnBoot: false },
      resetResult: {
        port: 3213,
        launchOnBoot: true,
        openClawSyncOk: false,
        openClawSyncError: 'reset sync',
        appConfigSavedOk: false,
        appConfigSaveError: 'reset save'
      }
    })
    const reg = makeRegistrar()
    registerConfigIpc(reg, deps)

    const saved = await reg.call('config:save', { port: 3213 })
    assertEq(saved.openClawSyncOk, true, '缺省必须视为同步成功（不能说谎）')
    assertEq(saved.appConfigSavedOk, true)
    assertEq(saved.openClawSyncError, null, '缺省错误必须是 null 而不是 undefined')
    assertEq(saved.appConfigSaveError, null)
    assertEq(saved.config.launchOnBoot, false)
    assertEq(callArg(calls, 'applyLoginItemSettings'), false, 'launchOnBoot=false 也要同步（关掉自启）')

    const reset = await reg.call('config:reset')
    assertEq(reset.openClawSyncOk, false, 'reset 与 save 同口径拆包')
    assertEq(reset.appConfigSavedOk, false)
    assertEq(reset.openClawSyncError, 'reset sync')
    assertEq(reset.config.port, 3213)
    assert(!('openClawSyncOk' in reset.config), 'reset 的 config 同样要干净')
    assertOrder(
      calls,
      ['saveConfig', 'applyLoginItemSettings', 'resetConfig', 'applyLoginItemSettings'],
      '保存/重置后都要同步开机自启项'
    )
    assertDeepEq(
      callArgs(calls, 'applyLoginItemSettings'),
      [false, true],
      '两次同步的值分别来自 save/reset 的 launchOnBoot'
    )
    return '缺省 true/null + reset 同口径'
  })

  await r.check('K4', 'config 数据目录与模型预设通道：getDataDir/openDataDir 用同一路径、预设透传', async () => {
    const dataDir = join('D:', 'umi-data-custom')
    const { deps, calls } = makeConfigDeps({
      dataDir,
      presets: [{ id: 'm1' }],
      refresh: { refreshed: 2 },
      info: { count: 2 },
      openResult: { opened: 'dir' }
    })
    const reg = makeRegistrar()
    registerConfigIpc(reg, deps)

    assertEq(await reg.call('config:getDataDir'), dataDir)
    assertDeepEq(await reg.call('config:openDataDir'), { opened: 'dir' }, '透出 shell.openPath 结果')
    assertEq(callArg(calls, 'openDataDir'), dataDir, '打开目录必须用 getDataDir() 的路径（不能硬编码）')
    assertDeepEq(await reg.call('config:getPresetModels', 'fast'), [{ id: 'm1' }])
    assertEq(callArg(calls, 'getPresetModels'), 'fast', 'configName 原样透传')
    assertDeepEq(await reg.call('config:refreshModelPresets'), { refreshed: 2 })
    assertDeepEq(await reg.call('config:getModelPresetsInfo'), { count: 2 })
    return '数据目录同源 + 三个预设通道透传'
  })

  // ════════════════════════ terminal：5 通道 ════════════════════════

  await r.check('T1', 'terminal 注册 5 通道（term:run / pty-start / pty-input / pty-stop / pty-resize）', () => {
    const { deps } = makeTerminalDeps()
    const reg = makeRegistrar()
    registerTerminalIpc(reg, deps)
    assertDeepEq(
      [...reg.handlers.keys()].sort(),
      ['term:pty-input', 'term:pty-resize', 'term:pty-start', 'term:pty-stop', 'term:run'].sort(),
      'terminal 通道集合必须是这 5 个'
    )
    assertEq(reg.handlers.size, 5, 'terminal 恰好 5 个 handler')
    return '5 通道齐备'
  })

  await r.check('T2', 'term:run 护栏：运行时解析失败/参数超限都拒绝执行且不 spawn（100 边界放行）', async () => {
    const a = makeTerminalDeps({ resolve: { entryJs: '', env: {}, error: '找不到运行时' } })
    const regA = makeRegistrar()
    registerTerminalIpc(regA, a.deps)
    assertDeepEq(
      await withTimeout(regA.call('term:run', ['run'], undefined), { label: 'term:run 解析失败分支' }),
      { stdout: '', stderr: '找不到运行时', code: -1 },
      '解析失败 → code -1 且原因透出'
    )
    assertNotCalled(a.calls, 'spawn', '解析失败时绝不能 spawn（负向）')
    assertEq(a.spawned.length, 0)

    const b = makeTerminalDeps()
    const regB = makeRegistrar()
    registerTerminalIpc(regB, b.deps)
    const tooMany = Array.from({ length: 101 }, (_, i) => `arg${i}`)
    // 超时兜底：若参数护栏被删，handler 会 spawn 后等 exit 永不 resolve，整轮验收会静默挂死
    // （审查实测：删护栏 → exit 13 / 0 FAIL / 无诊断）。withTimeout 把它变成一条可读失败。
    assertDeepEq(
      await withTimeout(regB.call('term:run', tooMany), { label: 'term:run 101 参数（护栏）' }),
      { stdout: '', stderr: '参数过多，拒绝执行', code: -1 },
      '101 个参数 → 拒绝'
    )
    assertNotCalled(b.calls, 'spawn', '参数超限时绝不能 spawn')
    assertEq(b.spawned.length, 0)

    // 恰好 100 个参数是允许边界（>100 才拒绝）
    const atLimit = Array.from({ length: 100 }, (_, i) => `arg${i}`)
    const pending = withTimeout(regB.call('term:run', atLimit), { label: 'term:run 100 参数（边界）' })
    assertEq(countCall(b.calls, 'spawn'), 1, '恰好 100 个参数应放行（边界语义 >100）')
    assertEq(b.spawned[0] instanceof EventEmitter, true, 'spawn 返回真进程形对象')
    b.spawned[0].emit('exit', 0)
    await pending
    return '两个拒绝分支 + 100 参数边界（带超时兜底）'
  })

  await r.check('T3', 'term:run 一次性命令：显式 stdio、stdout/stderr 拼接、退出码透出', async () => {
    const { deps, calls, spawned, runtimeConfig, resolved } = makeTerminalDeps()
    const reg = makeRegistrar()
    registerTerminalIpc(reg, deps)

    const pending = withTimeout(reg.call('term:run', ['run', '--json'], { kind: 'configured' }), {
      label: 'term:run 成功路径'
    })
    assertEq(spawned.length, 1, '应 spawn 一次')
    const proc = spawned[0]
    const spawnArgs = callArg(calls, 'spawn')
    assertEq(spawnArgs[0], runtimeConfig.nodePath, '用运行时配置的 nodePath')
    assertDeepEq(spawnArgs[1], [resolved.entryJs, 'run', '--json'], '入口脚本 + 参数原样拼接')
    assertEq(spawnArgs[2].cwd, runtimeConfig.cwd, 'cwd 来自 getRuntimeConfig')
    assertDeepEq(spawnArgs[2].env, resolved.env, 'env 来自 resolveRuntime')
    assertDeepEq(
      spawnArgs[2].stdio,
      ['ignore', 'pipe', 'pipe'],
      '一次性命令必须显式 stdio（stdin ignore）'
    )
    assertDeepEq(callArg(calls, 'resolveRuntime'), { kind: 'configured' }, 'runtime 参数透传给 resolveRuntime')

    proc.stdout.emit('data', Buffer.from('he'))
    proc.stdout.emit('data', Buffer.from('llo'))
    proc.stderr.emit('data', Buffer.from('warn'))
    proc.emit('exit', 2)
    assertDeepEq(await pending, { stdout: 'hello', stderr: 'warn', code: 2 }, 'stdout/stderr 拼接 + 退出码')
    return 'spawn 参数 + 流拼接 + 退出码'
  })

  await r.check('T4', 'term:run 异常分支：进程 error 事件与 spawn 同步抛都转成 code -1', async () => {
    const a = makeTerminalDeps()
    const regA = makeRegistrar()
    registerTerminalIpc(regA, a.deps)
    const pending = withTimeout(regA.call('term:run', ['run']), { label: 'term:run error 事件' })
    a.spawned[0].emit('error', new Error('boom'))
    assertDeepEq(
      await pending,
      { stdout: '', stderr: '子进程启动失败: boom', code: -1 },
      'error 事件必须 resolve 成 code -1（不能挂住前端 await）'
    )

    const b = makeTerminalDeps({ spawnThrows: 'spawn EPERM' })
    const regB = makeRegistrar()
    registerTerminalIpc(regB, b.deps)
    assertDeepEq(
      await regB.call('term:run', ['run']),
      { stdout: '', stderr: '执行异常: spawn EPERM', code: -1 },
      'spawn 同步抛必须转成 code -1'
    )
    return 'error 事件 + 同步抛两个分支'
  })

  await r.check('T5', 'term:pty-start 单例：先强关旧会话、sessionId 形状正确、pty 需要 stdin pipe', async () => {
    const a = makeTerminalDeps({ initialSessions: ['session_old'] })
    const regA = makeRegistrar()
    registerTerminalIpc(regA, a.deps)
    const sessionId = await regA.call('term:pty-start', ['run'], 120, 30, { kind: 'default' })
    assertEq(typeof sessionId, 'string', '成功必须返回 sessionId 字符串')
    assert(/^session_\d+$/.test(sessionId), 'sessionId 形状必须是 session_<Date.now()>')
    assertCalled(a.calls, 'killAll', '单例策略：已有活跃会话先强关（防资源泄露）')
    assert(String(callArg(a.calls, 'log')).includes('检测到活跃终端会话'), '强关要有日志')
    assertEq(a.sessions.size, 1, '旧会话被清理、新会话恰好注册一个')
    assertEq(a.sessions.has(sessionId), true, '新会话按 sessionId 入册')
    const spawnArgs = callArg(a.calls, 'spawn')
    assertDeepEq(
      spawnArgs[2].stdio,
      ['pipe', 'pipe', 'pipe'],
      'PTY 需要写 stdin，所以stdio第一个必须是 pipe'
    )
    assertDeepEq(callArg(a.calls, 'resolveRuntime'), { kind: 'default' }, 'runtime 参数透传')

    // b) 解析失败 → 返回 {error}（不走 pty-chunk，前端此时还没有 session）
    const b = makeTerminalDeps({
      resolve: { entryJs: '', env: {}, error: '没有运行时' },
      initialSessions: ['session_old']
    })
    const regB = makeRegistrar()
    registerTerminalIpc(regB, b.deps)
    assertDeepEq(
      await regB.call('term:pty-start', ['run']),
      { error: '没有运行时' },
      '解析失败必须返回 {error}'
    )
    assertNotCalled(b.calls, 'spawn', '解析失败绝不能 spawn')
    assertEq(b.spawned.length, 0)
    // 现状锁定：旧会话在解析前就被 killAll 强关（见 env 注释同款说明）。若产品决定改成
    // 「解析成功再关旧会话」，先改生产代码，再改本断言——已在 PROGRESS 4.5 复核补充登记。
    assertCalled(b.calls, 'killAll', '现状行为：旧会话在解析前就被强关（锁住，避免悄悄改动）')
    assertEq(b.sessions.size, 0, '失败时不得注册半成品会话')
    return '单例 + 形状 + 失败分支'
  })

  await r.check('T6', 'term:pty-start 流式转发与清理：pty-chunk/pty-exit 频道、退出/错误自动注销', async () => {
    const a = makeTerminalDeps()
    const regA = makeRegistrar()
    registerTerminalIpc(regA, a.deps)
    const sessionId = await regA.call('term:pty-start', ['run'])
    const pty = a.spawned[0]
    pty.stdout.emit('data', Buffer.from('out'))
    pty.stderr.emit('data', Buffer.from('err'))
    const sends = a.calls.filter((c) => Array.isArray(c) && c[0] === 'send')
    const chunks = sends.filter((c) => c[1] === 'term:pty-chunk')
    assertEq(chunks.length, 2, 'stdout/stderr 都要转成 pty-chunk')
    assertDeepEq(chunks[0][2], { sessionId, data: 'out' }, 'stdout chunk 形状')
    assertDeepEq(chunks[1][2], { sessionId, data: 'err' }, 'stderr chunk 形状')
    assertEq(a.sessions.has(sessionId), true, '运行中会话在册')
    pty.emit('exit', null)
    const exits = a.calls
      .filter((c) => Array.isArray(c) && c[0] === 'send')
      .filter((c) => c[1] === 'term:pty-exit')
    assertEq(exits.length, 1, '退出要发 pty-exit')
    assertDeepEq(exits[0][2], { sessionId, exitCode: 0 }, 'exitCode null → 0')
    assertEq(a.sessions.has(sessionId), false, '退出后会话必须注销（否则单例会误杀后续）')

    // 进程 error 事件 → logError + 注销
    const b = makeTerminalDeps()
    const regB = makeRegistrar()
    registerTerminalIpc(regB, b.deps)
    const sessionB = await regB.call('term:pty-start', ['run'])
    b.spawned[0].emit('error', new Error('pty boom'))
    assertCalled(b.calls, 'logError', 'PTY 进程错误必须进 logError')
    assertEq(b.sessions.has(sessionB), false, '错误后会话必须注销')
    return 'chunk/exit 频道 + 退出/错误注销'
  })

  await r.check('T7', 'term:pty-input：命中 sessionId 写入、未知 id 回落首个会话、destroyed stdin 不写', async () => {
    const { deps, calls, sessions } = makeTerminalDeps()
    const reg = makeRegistrar()
    registerTerminalIpc(reg, deps)
    const procA = makeFakeProc()
    sessions.set('session_a', { id: 'session_a', process: procA })

    assertEq(await reg.call('term:pty-input', 'session_a', 'ls'), undefined, 'pty-input 无返回值')
    assertDeepEq(procA.stdin.writes, ['ls'], '命中 sessionId 写入对应进程')

    // 未知 sessionId 但存在活跃会话 → 兼容旧逻辑：落到第一个
    const procB = makeFakeProc()
    sessions.set('session_b', { id: 'session_b', process: procB })
    await reg.call('term:pty-input', 'missing', 'pwd')
    assertDeepEq(procA.stdin.writes, ['ls', 'pwd'], '未知 id 回落到首个活跃会话')
    assertDeepEq(procB.stdin.writes, [], '不得误写到其它会话')

    // stdin 已销毁 → 不写（避免 EPIPE 崩主进程）
    const dead = makeFakeProc({ destroyed: true })
    sessions.set('session_dead', { id: 'session_dead', process: dead })
    await reg.call('term:pty-input', 'session_dead', 'x')
    assertDeepEq(dead.stdin.writes, [], 'stdin destroyed 时必须跳过写入')

    // 无任何会话 → 静默返回，不抛
    const empty = makeTerminalDeps()
    const regEmpty = makeRegistrar()
    registerTerminalIpc(regEmpty, empty.deps)
    assertEq(await regEmpty.call('term:pty-input', 'nope', 'y'), undefined, '无会话时静默返回')
    return '命中 / 回落 / destroyed / 空表'
  })

  await r.check('T8', 'term:pty-stop：命中 killSession、无 id 或未知 id 走 killAll（旧兼容语义）', async () => {
    const { deps, calls, sessions } = makeTerminalDeps({ killResult: false })
    const reg = makeRegistrar()
    registerTerminalIpc(reg, deps)
    sessions.set('session_a', { id: 'session_a', process: makeFakeProc() })

    assertEq(await reg.call('term:pty-stop', 'session_a'), false, 'killSession 返回值必须原样透出')
    assertEq(callArg(calls, 'killSession'), 'session_a')
    assertNotCalled(calls, 'killAll', '命中 id 时不得全杀')

    await reg.call('term:pty-stop', 'missing')
    assertCalled(calls, 'killAll', '未知 id → 回落全杀（旧兼容语义）')
    assertEq(countCall(calls, 'killSession'), 1, '未知 id 不得进 killSession')

    assertEq(await reg.call('term:pty-stop'), true, '无 id → 全杀并返回 true')
    assertEq(await reg.call('term:pty-stop', ''), true, '空 id 等同无 id → 全杀')
    assertEq(countCall(calls, 'killAll'), 3, '未知 id / 无参 / 空串各触发一次 killAll')
    return '单杀 / 全杀三入口'
  })

  await r.check('T9', 'term:pty-resize 是 no-op：恒 true 且无 spawn/kill/send 副作用（允许 log）', async () => {
    const { deps, calls } = makeTerminalDeps()
    const reg = makeRegistrar()
    registerTerminalIpc(reg, deps)
    assertEq(await reg.call('term:pty-resize', 'session_x', 120, 30), true, '标准子进程不支持 resize，保持 true')
    for (const name of ['spawn', 'killAll', 'killSession', 'send', 'logError']) {
      assertNotCalled(calls, name, `resize 不得触发 ${name}（纯 no-op，允许 log）`)
    }
    return '恒定 true + 无进程/广播副作用'
  })
} catch (e) {
  console.error('验收脚本自身异常:', e)
}

const result = r.toJSON({ bundle: bundlePaths })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-host-ipc.json'), result)
process.exitCode = ok ? 0 : 1
