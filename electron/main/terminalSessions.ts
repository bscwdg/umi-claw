// electron/main/terminalSessions.ts —— 终端/PTY 会话注册表与终止逻辑（从 index.ts 抽出，J1 收敛 ≤1,800 行）
//
// 为什么单独成文件：会话 Map 与 kill 逻辑只依赖 Node child_process、不碰 Electron，
// 抽成工厂后 index.ts 只保留 IPC 装配；退出清理（quitApp / 窗口 closed / runQuitCleanup）
// 与 term IPC 共用同一份注册表，避免再长出第二套会话状态。

import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface TerminalSession {
  process: ChildProcessWithoutNullStreams
  id: string
}

export interface TerminalSessionRegistry {
  sessions: {
    size: () => number
    has: (id: string) => boolean
    get: (id: string) => TerminalSession | undefined
    set: (id: string, session: TerminalSession) => void
    delete: (id: string) => void
    firstKey: () => string | undefined
  }
  killSession: (sessionId: string) => boolean
  killAll: () => void
}

export function createTerminalSessionRegistry(): TerminalSessionRegistry {
  // 使用 Map 管理活跃的终端进程，避免 global 污染和内存泄漏
  const activeSessions = new Map<string, TerminalSession>()

  /**
   * 安全地终止并清理指定的终端会话
   */
  function killSession(sessionId: string): boolean {
    const session = activeSessions.get(sessionId)
    if (!session) {
      // 兼容旧逻辑：传入特定 ID 找不到，视为已清理
      return false
    }

    try {
      const proc = session.process
      if (!proc.killed) {
        // 优先发送 SIGTERM 允许优雅退出
        proc.kill('SIGTERM')

        // 设置超时，如果未退出则强制杀死
        setTimeout(() => {
          if (!proc.killed && proc.pid) {
            try {
              proc.kill('SIGKILL')
            } catch (e) {
              // 忽略进程已退出的错误
            }
          }
        }, 2000)
      }
    } catch (err) {
      console.error(`[PTY] 终止会话 ${sessionId} 时出错:`, err)
    } finally {
      activeSessions.delete(sessionId)
      return true
    }
  }

  /**
   * 清理所有活跃的终端会话（用于应用退出时）
   */
  function killAll(): void {
    const sessionIds = Array.from(activeSessions.keys())
    sessionIds.forEach(id => killSession(id))
  }

  return {
    sessions: {
      size: () => activeSessions.size,
      has: id => activeSessions.has(id),
      get: id => activeSessions.get(id),
      set: (id, session) => {
        activeSessions.set(id, session)
      },
      delete: id => {
        activeSessions.delete(id)
      },
      firstKey: () => activeSessions.keys().next().value
    },
    killSession,
    killAll
  }
}
