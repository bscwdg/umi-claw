// electron/main/claw/probe.ts —— 网关就绪/端口探活
//
// 为什么独立：就绪判定是「进程在 ≠ 能开网页」这条结论的唯一来源（实测 spawn 后
// 加载插件/渠道可达数分钟），而它只是几个短超时的 TCP/HTTP 探测，与 ClawManager
// 的状态管理无关；拆出来后可以脱离 electron 直接测端口行为。

import { execFile } from 'child_process'
import { get as httpGet } from 'node:http'
import { connect as netConnect } from 'node:net'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** 端口当前被哪个 PID 监听（复用前身份校验，避免 pid 复用误认/误杀） */
export async function findPidListeningOnPort(port: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true })
      for (const line of stdout.split('\n')) {
        if (!/LISTENING/i.test(line)) continue
        const cols = line.trim().split(/\s+/)
        const local = cols[1] ?? ''
        const pid = Number(cols[cols.length - 1])
        if (!local.endsWith(`:${port}`)) continue
        if (Number.isFinite(pid) && pid > 0) return pid
      }
      return undefined
    }
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      windowsHide: true
    })
    const pid = Number(stdout.split('\n').find((v) => v.trim()))
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** TCP 端口是否已监听（HTTP 服务在听、但 /health 还没 200 → 插件/渠道加载中） */
export function probePortOpen(port: number, timeoutMs = 800): Promise<boolean> {
  const target = Number(port) || 3213
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const socket = netConnect({ host: '127.0.0.1', port: target })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => {
        socket.destroy()
        done(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        done(false)
      })
      socket.once('error', () => done(false))
    } catch {
      done(false)
    }
  })
}

/**
 * 探测网关是否真正可用（`GET /health` 200）。
 *
 * 用短超时的 http 请求而不是「进程是否存活」：openclaw spawn 后要加载插件/渠道/状态库，
 * 进程在但端口没监听是常态（实测可达数分钟），只有 /health 通才算能开网页。
 */
export function fetchHealthOk(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const req = httpGet({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
        res.resume()
        done(res.statusCode === 200)
      })
      req.on('timeout', () => {
        req.destroy()
        done(false)
      })
      req.on('error', () => done(false))
    } catch {
      done(false)
    }
  })
}
