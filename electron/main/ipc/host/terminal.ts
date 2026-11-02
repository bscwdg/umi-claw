// electron/main/ipc/host/terminal.ts —— 终端 / PTY IPC（4.1 WP5-a 第五批：从 index.ts 拆出）
//
// 行为约束（迁移时逐字保留）：
//   - term:run 一次性命令：args 上限 100，stdio 明确 ignore/pipe/pipe，错误转 {code:-1}；
//   - term:pty-start 单例：已有活跃会话先强关，sessionId = session_<Date.now()>，
//     解析失败返回 {error}（不走 pty-chunk，前端此时还没建立 session 会丢消息）；
//   - pty-input 兼容无 sessionId 的旧调用；pty-stop 有 id 杀单个、无 id 全杀；
//   - pty-resize 目前只回 true（标准子进程不支持动态 resize，除非换 node-pty）。

import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface TerminalSessionLike {
  process: ChildProcessWithoutNullStreams
  id: string
}

export interface TerminalIpcDeps {
  spawn: typeof import('node:child_process').spawn
  getRuntimeConfig: () => { nodePath: string; cwd: string }
  resolveRuntime: (runtime?: unknown) => { entryJs: string; env: NodeJS.ProcessEnv; error?: string }
  sessions: {
    size: () => number
    has: (id: string) => boolean
    get: (id: string) => TerminalSessionLike | undefined
    set: (id: string, session: TerminalSessionLike) => void
    delete: (id: string) => void
    firstKey: () => string | undefined
  }
  killSession: (id: string) => boolean
  killAll: () => void
  send: (channel: string, payload: unknown) => void
  log: (line: string) => void
  logError: (...args: unknown[]) => void
}

export function registerTerminalIpc(
  ipc: {
    handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
  },
  deps: TerminalIpcDeps
): void {
  /** 执行一次性命令 (Snapshot) */
  const handleRunCommand = async (_e: unknown, args: string[], runtime?: unknown) => {
    const { nodePath, cwd } = deps.getRuntimeConfig()
    const { entryJs, env, error } = deps.resolveRuntime(runtime)
    if (error) {
      return { stdout: '', stderr: error, code: -1 }
    }
    // 基本的安全检查：限制参数长度，防止缓冲区溢出或极端情况
    if (args.length > 100) {
      return { stdout: '', stderr: '参数过多，拒绝执行', code: -1 }
    }
    return new Promise((resolve) => {
      try {
        const proc = deps.spawn(nodePath, [entryJs, ...args], {
          env,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'] // 明确指定 stdio
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d) => (stdout += d.toString()))
        proc.stderr.on('data', (d) => (stderr += d.toString()))
        proc.on('exit', (code) => {
          resolve({ stdout, stderr, code })
        })
        proc.on('error', (err) => {
          resolve({ stdout: '', stderr: `子进程启动失败: ${err.message}`, code: -1 })
        })
      } catch (e) {
        resolve({ stdout: '', stderr: `执行异常: ${(e as Error)?.message ?? String(e)}`, code: -1 })
      }
    })
  }
  ipc.handle('term:run', handleRunCommand)

  /** 启动交互式 PTY 会话 */
  const handleStartPty = async (
    _event: unknown,
    args: string[],
    _cols?: number,
    _rows?: number,
    runtime?: unknown
  ) => {
    // 单例模式策略：已有活跃会话先关闭，防止资源泄露（多会话需另做 sessionId 管理）
    if (deps.sessions.size() > 0) {
      deps.log('检测到活跃终端会话，正在强制关闭以启动新会话')
      deps.killAll()
    }
    const { nodePath, cwd } = deps.getRuntimeConfig()
    const { entryJs, env, error } = deps.resolveRuntime(runtime)
    const sessionId = `session_${Date.now()}`
    if (error) {
      // 返回带 error 字段的结果而非 null，让前端能拿到具体错误原因。
      // 不走 pty-chunk 发错误消息：前端 listener 按 sessionId 过滤，
      // 此时尚未建立 session，消息会被丢弃。
      return { error }
    }
    try {
      const ptyProc = deps.spawn(nodePath, [entryJs, ...args], {
        env,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'] // 需要 stdin 所以第一个是 pipe
      })
      deps.sessions.set(sessionId, { process: ptyProc, id: sessionId })
      // 实时向前端推送数据
      ptyProc.stdout.on('data', (data) => {
        deps.send('term:pty-chunk', { sessionId, data: data.toString() })
      })
      ptyProc.stderr.on('data', (data) => {
        deps.send('term:pty-chunk', { sessionId, data: data.toString() })
      })
      // 监听进程退出
      ptyProc.on('exit', (exitCode) => {
        deps.send('term:pty-exit', { sessionId, exitCode: exitCode || 0 })
        deps.sessions.delete(sessionId)
      })
      ptyProc.on('error', (err) => {
        deps.logError('PTY 进程错误:', err)
        deps.sessions.delete(sessionId)
      })
      return sessionId
    } catch (err) {
      deps.logError('PTY 启动失败:', err)
      return null
    }
  }
  ipc.handle('term:pty-start', handleStartPty)

  /** 向 PTY 写入输入 */
  const handlePtyInput = (_e: unknown, sessionId: string, data: string) => {
    // 优先 sessionId；没传对时兼容旧逻辑（找任意一个活跃进程，不推荐）
    let proc: ChildProcessWithoutNullStreams | undefined
    if (sessionId && deps.sessions.has(sessionId)) {
      proc = deps.sessions.get(sessionId)?.process
    }
    if (!proc && deps.sessions.size() > 0) {
      const firstKey = deps.sessions.firstKey()
      if (firstKey) proc = deps.sessions.get(firstKey)?.process
    }
    if (proc && proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(data)
    }
  }
  ipc.handle('term:pty-input', handlePtyInput)

  /** 停止 PTY 会话 */
  const handleStopPty = (_e: unknown, sessionId: string) => {
    // 有 sessionId 杀特定的；否则杀所有（兼容旧逻辑）
    if (sessionId && deps.sessions.has(sessionId)) {
      return deps.killSession(sessionId)
    }
    deps.killAll()
    return true
  }
  ipc.handle('term:pty-stop', handleStopPty)

  ipc.handle('term:pty-resize', (_e, _sid: string, _cols: number, _rows: number) => {
    // 标准子进程不支持动态 resize（除非使用 node-pty），这里保持原实现的 no-op
    return true
  })
}
