// test/terminal-sessions.accept.mjs —— 终端/PTY 会话注册表验收（J1：从 index.ts 抽出的 terminalSessions.ts）
//
// **打真实源码**：esbuild bundle 真 terminalSessions.ts（仅依赖 node:child_process 类型，纯 Node 工厂），
// 真起便携 node 进程验证 SIGTERM 终止，不 mock 被测逻辑。
//
// 覆盖：
//   T1 空注册表：零会话语义 + 未知 id killSession 返回 false + killAll 不抛
//   T2 会话 Map 五件套：size/has/get/set/delete/firstKey
//   T3 killSession：真进程收到 SIGTERM、返回 true、条目从注册表删除
//   T4 killSession 未知 id 返回 false 且不动其它会话
//   T5 killAll：注册会话全部收到终止信号，未注册的无辜进程收不到任何 kill
//   T6 静态契约：index.ts 只做装配（createTerminalSessionRegistry），新模块不碰 electron
//
// 环境说明：本机（Node v24 + 安全软件）父进程不回收子进程退出事件——OS 层 tasklist 已验证
// 进程被 TerminateProcess 收掉，但 child.exitCode 一直为 null。因此终止类断言以确定性的
// killed/signalCode（kill 是否作用于正确进程）为准，exitCode 仅作 best-effort 观测并记录降级。
//
// 用法：node test/terminal-sessions.accept.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import {
  Recorder,
  __dirname,
  assert,
  assertEq,
  bundleEntry,
  printResult,
  repoRoot,
  resolveNodePath,
  waitFor,
  writeJson
} from './_lib.mjs'

const recorder = new Recorder('terminal-sessions（终端/PTY 会话注册表）')
const mod = await import(
  pathToFileURL(bundleEntry('electron/main/terminalSessions.ts', 'terminal-sessions.mjs')).href
)
const { createTerminalSessionRegistry } = mod

function spawnIdleNode() {
  return spawn(resolveNodePath(), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

// 退出事件在部分机器不被父进程回收：best-effort 等 3s，返回 exitCode 是否真的更新
async function observeExit(child) {
  try {
    await waitFor(() => child.exitCode !== null, { timeout: 3000, label: '子进程退出事件' })
    return true
  } catch {
    return false
  }
}

await recorder.check('T1', '空注册表语义 + 未知 id 清理安全', () => {
  const registry = createTerminalSessionRegistry()
  assertEq(registry.sessions.size(), 0, '初始 size=0')
  assert(!registry.sessions.has('nope'), '初始 has=false')
  assertEq(registry.sessions.get('nope'), undefined, '初始 get=undefined')
  assertEq(registry.sessions.firstKey(), undefined, '初始 firstKey=undefined')
  assertEq(registry.killSession('nope'), false, '未知 id 返回 false')
  registry.killAll()
  return '空表清理不抛、不误报'
})

await recorder.check('T2', '会话 Map 五件套', () => {
  const registry = createTerminalSessionRegistry()
  const fake = { id: 'session_a', process: { killed: false, kill: () => true } }
  registry.sessions.set('session_a', fake)
  assertEq(registry.sessions.size(), 1, 'set 后 size=1')
  assert(registry.sessions.has('session_a'), 'has=true')
  assertEq(registry.sessions.get('session_a'), fake, 'get 原样返回')
  assertEq(registry.sessions.firstKey(), 'session_a', 'firstKey 命中')
  registry.sessions.delete('session_a')
  assert(!registry.sessions.has('session_a'), 'delete 后 has=false')
  return 'Map 语义与 IPC 适配器形状一致'
})

await recorder.check('T3', 'killSession 向真进程发 SIGTERM 并删除条目', async () => {
  const registry = createTerminalSessionRegistry()
  const child = spawnIdleNode()
  await waitFor(() => child.pid !== undefined, { label: '子进程启动' })
  registry.sessions.set('session_real', { id: 'session_real', process: child })
  assertEq(registry.killSession('session_real'), true, '命中返回 true')
  assertEq(child.killed, true, '子进程应收到 kill')
  const reaped = await observeExit(child)
  if (reaped) assertEq(child.signalCode, 'SIGTERM', '退出回收后信号应为 SIGTERM')
  assert(!registry.sessions.has('session_real'), '终止后条目删除')
  return `pid=${child.pid} 收到 SIGTERM，条目删除；exitCode 回收=${reaped}`
})

await recorder.check('T4', 'killSession 未知 id 不影响其它会话', async () => {
  const registry = createTerminalSessionRegistry()
  const child = spawnIdleNode()
  await waitFor(() => child.pid !== undefined, { label: '子进程启动' })
  registry.sessions.set('keep', { id: 'keep', process: child })
  assertEq(registry.killSession('missing'), false, '未知 id 返回 false')
  assert(registry.sessions.has('keep'), '在册会话不受影响')
  assertEq(child.killed, false, '在册进程未被误杀')
  registry.killAll()
  assertEq(child.killed, true, 'killAll 后在册进程收到 kill')
  const reaped = await observeExit(child)
  return `未知 id 零副作用；exitCode 回收=${reaped}`
})

await recorder.check('T5', 'killAll 只清注册会话，无辜进程存活', async () => {
  const registry = createTerminalSessionRegistry()
  const first = spawnIdleNode()
  const second = spawnIdleNode()
  const innocent = spawnIdleNode()
  await waitFor(
    () => first.pid !== undefined && second.pid !== undefined && innocent.pid !== undefined,
    { label: '三个子进程启动' }
  )
  registry.sessions.set('a', { id: 'a', process: first })
  registry.sessions.set('b', { id: 'b', process: second })
  registry.killAll()
  assertEq(first.killed && second.killed, true, '两个注册进程都收到 kill')
  assertEq(registry.sessions.size(), 0, 'killAll 后注册表清空')
  assertEq(innocent.killed, false, '未注册进程不得被误杀')
  assertEq(innocent.signalCode, null, '无辜进程不得收到任何信号')
  innocent.kill('SIGKILL')
  return `注册 pid=${first.pid}/${second.pid} 收到 kill，无辜 pid=${innocent.pid} 未被触碰`
})

await recorder.check('T6', '静态契约：index.ts 只装配，注册表模块不碰 electron', () => {
  const indexSrc = readFileSync(join(repoRoot, 'electron', 'main', 'index.ts'), 'utf-8')
  assert(
    indexSrc.includes("from './terminalSessions'") &&
      indexSrc.includes('createTerminalSessionRegistry()'),
    'index.ts 必须从 terminalSessions 装配注册表'
  )
  assert(!indexSrc.includes('activeTerminalSessions'), 'index.ts 不得再内联会话 Map')
  assert(!indexSrc.includes('function killTerminalSession'), 'kill 逻辑不得回迁 index.ts')
  const registrySrc = readFileSync(join(repoRoot, 'electron', 'main', 'terminalSessions.ts'), 'utf-8')
  assert(!/from 'electron'|require\('electron'\)/.test(registrySrc), '注册表模块禁止 import electron')
  return '装配边界与纯 Node 约束成立'
})

const result = recorder.toJSON({ runDir: __dirname })
const ok = printResult(result)
writeJson(join(__dirname, 'accept-result-terminal-sessions.json'), result)
if (!ok) process.exit(1)
