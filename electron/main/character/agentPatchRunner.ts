// electron/main/character/agentPatchRunner.ts —— 用官方 CLI 写 agent 条目（主进程用）
//
// `openclaw agents add` 在非交互环境会卡住（实测），改用
// `openclaw config patch --file <tmp>`：非交互、带 schema 校验、单次落盘。
// 失败只影响角色引导，不抛给宿主。

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAgentPatch, CHARACTER_AGENT_ID } from './agentConfig'

export interface CliRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface CliRunner {
  run(args: string[]): Promise<CliRunResult>
}

export interface CliRunnerOptions {
  nodePath: string
  cliPath: string
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
}

/** 起一个官方 CLI 子进程并收集输出（超时杀进程） */
export function createOpenClawCliRunner(options: CliRunnerOptions): CliRunner {
  return {
    run: (args) =>
      new Promise<CliRunResult>((resolve) => {
        const child = spawn(options.nodePath, [options.cliPath, ...args], {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true
        })
        let stdout = ''
        let stderr = ''
        const timeout = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
        }, options.timeoutMs ?? 60_000)
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        child.on('error', (error) => {
          clearTimeout(timeout)
          resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` })
        })
        child.on('close', (code) => {
          clearTimeout(timeout)
          resolve({ code: code ?? -1, stdout, stderr })
        })
      })
  }
}

export interface ApplyAgentPatchOptions {
  runner: CliRunner
  tmpDir: string
  agentId?: string
  workspace: string
}

export interface ApplyAgentPatchResult {
  ok: boolean
  error?: string
}

/** 写临时补丁 → `config patch --file` → 清理临时文件 */
export async function applyAgentPatch(
  options: ApplyAgentPatchOptions
): Promise<ApplyAgentPatchResult> {
  const agentId = options.agentId ?? CHARACTER_AGENT_ID
  const patchPath = join(options.tmpDir, `character-agent-${agentId}.json5`)
  try {
    mkdirSync(options.tmpDir, { recursive: true })
    writeFileSync(patchPath, `${JSON.stringify(buildAgentPatch(agentId, options.workspace))}\n`, 'utf8')
    const result = await options.runner.run(['config', 'patch', '--file', patchPath])
    if (result.code !== 0) {
      // 只回退出码，不把 CLI stderr 原样带进 UI/日志（可能含路径/凭据片段）
      return { ok: false, error: `config patch 失败（exit ${result.code}）` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? String(error) }
  } finally {
    try {
      rmSync(patchPath, { force: true })
    } catch {
      /* ignore */
    }
  }
}

