// scripts/patch-qqbot-voice-path.mjs —— 手动执行 openclaw-qqbot 语音本地路径热修
//
// 与 ClawManager 启动网关前的自动补丁是同一份核心逻辑（electron/main/claw/qqVoicePatch.ts），
// 这里只做「TS 核心临时打包 → 执行 → 打印结果」的薄包装，不复制任何补丁规则。
//
// 用法：
//   node scripts/patch-qqbot-voice-path.mjs [dataDir]
// dataDir 缺省顺序：命令行参数 > $CLAW_DATA_DIR > 仓库内 data/
// 退出码：0=全部已补丁或本轮成功；1=存在跳过（未知版本）或失败；2=脚本环境缺失
//
// 正常情况下无需手动跑：每次启动网关前宿主会自动执行。本脚本用于插件重装后的
// 立即修复、CI 校验与排障。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const dataDir = process.argv[2] || process.env.CLAW_DATA_DIR || join(repoRoot, 'data')

const esbuildBin = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
)
if (!existsSync(esbuildBin)) {
  console.error('[patch] 未找到 esbuild（node_modules 未安装？），无法加载补丁核心逻辑')
  process.exit(2)
}

const outDir = join(tmpdir(), `umi-qqvoice-patch-${process.pid}`)
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'qqVoicePatch.mjs')
const res = spawnSync(
  esbuildBin,
  [
    join(repoRoot, 'electron', 'main', 'claw', 'qqVoicePatch.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    '--log-level=warning',
    `--outfile=${outFile}`
  ],
  { encoding: 'utf-8', shell: process.platform === 'win32', cwd: repoRoot }
)
if (res.status !== 0) {
  console.error(`[patch] esbuild 失败:\n${res.stdout || ''}${res.stderr || ''}`)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(2)
}

const { ensureQqBotVoicePatch } = await import(pathToFileURL(outFile).href)
const summary = await ensureQqBotVoicePatch(
  {
    log: (line, type) => {
      if (type === 'stderr') console.error(line)
      else console.log(line)
    }
  },
  dataDir
)
rmSync(outDir, { recursive: true, force: true })

console.log('[patch] dataDir =', dataDir)
console.log(
  `[patch] scanned=${summary.scanned} patched=${summary.patched} alreadyPatched=${summary.alreadyPatched} unsupported=${summary.unsupported} errors=${summary.errors}`
)
for (const item of summary.results) {
  console.log(
    `  - ${item.status.padEnd(15)} v${item.version} ${item.file}${item.detail ? `（${item.detail}）` : ''}`
  )
}
process.exit(summary.unsupported + summary.errors > 0 ? 1 : 0)
