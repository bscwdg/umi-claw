// electron/main/services/runtimeProbe.ts —— 便携 Node 可用性探针（4.0.1 P5）
//
// 为什么需要：真实用户环境里便携 Node 可能被标成低完整性（Low IL）——它能启动，
// 但写不了普通目录；表现是 DB worker 报 `readonly database` / `unable to open database`，
// 用户只看到「数据存不上」，没有任何线索（本机已实际踩到）。
//
// 做法：启动后用便携 Node **自己**写一个探针文件；失败只写明确告警，绝不阻塞启动。
// 依赖注入 execFile，便于纯 Node 验收。

import { execFile } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

export interface RuntimeProbeResult {
  ok: boolean
  reason: 'ok' | 'probe-failed' | 'timeout'
  detail?: string
}

export interface RuntimeProbeOptions {
  nodePath: string
  probeFile: string
  timeoutMs?: number
  /** 测试注入；默认 node:child_process.execFile */
  execFileImpl?: typeof execFile
}

/** 用便携 Node 写一个临时文件，判断它能否在普通目录落盘（低完整性会失败） */
export function probeNodeWritable(options: RuntimeProbeOptions): Promise<RuntimeProbeResult> {
  const { nodePath, probeFile, timeoutMs = 8000, execFileImpl = execFile } = options
  return new Promise((resolve) => {
    // 先清掉上一次成功留下的探针文件：否则「exit 0 但其实没写」的异常无法暴露
    try {
      rmSync(probeFile, { force: true })
    } catch {
      /* 清不掉就让下面「文件是否生成」的判定去暴露 */
    }
    execFileImpl(
      nodePath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1], 'ok')", probeFile],
      { timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || error).trim()
          const timedOut = error.killed === true || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          resolve({ ok: false, reason: timedOut ? 'timeout' : 'probe-failed', detail })
          return
        }
        const written = existsSync(probeFile)
        try {
          rmSync(probeFile, { force: true })
        } catch {
          /* 清理失败不影响判定；下次启动会先清 */
        }
        resolve(
          written
            ? { ok: true, reason: 'ok' }
            : { ok: false, reason: 'probe-failed', detail: '探针文件未生成（进程退出码 0）' }
        )
      }
    )
  })
}
