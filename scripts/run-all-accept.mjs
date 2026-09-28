// scripts/run-all-accept.mjs —— 一键跑全部单模块验收 + e2e + 冒烟
//
// 顺序：先各单模块 accept（任一失败立即停，不浪费后续），全部绿后再跑
// 「一天」端到端，最后打包态静态冒烟。
//
// 用法：npm run accept
// 退出码：全绿 0；任一失败 1。

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// 单模块验收（顺序：底座 → 上层）
const ACCEPT = [
  ['db-worker', 'test/db-worker.accept.mjs'],
  ['gateway', 'test/gateway.accept.mjs'],
  ['work', 'test/work.accept.mjs'],
  ['record', 'test/record.accept.mjs'],
  ['context', 'test/context.accept.mjs'],
  ['today', 'test/today.accept.mjs'],
  ['report', 'test/report.accept.mjs'],
  ['qatool', 'test/qatool.accept.mjs'],
  ['knowledge', 'test/knowledge.accept.mjs'],
  ['wizard', 'test/wizard.accept.mjs'],
  ['ui', 'test/ui.accept.mjs']
]
// 全部单模块绿后
const E2E = ['one-day e2e', 'test/one-day.e2e.mjs']
const SMOKE = ['packaged smoke', 'test/packaged.smoke.mjs']

function runNode(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, script)], {
      cwd: repoRoot,
      stdio: 'inherit'
    })
    child.on('close', (code) => resolve(code))
  })
}

async function main() {
  const results = []
  for (const [name, script] of ACCEPT) {
    process.stdout.write(`\n── accept: ${name} ────────────────────────────\n`)
    const code = await runNode(script)
    results.push({ name, code })
    if (code !== 0) {
      process.stdout.write(`\n❌ accept: ${name} 失败（${code}），中止\n`)
      process.exit(1)
    }
  }

  for (const [name, script] of [E2E, SMOKE]) {
    process.stdout.write(`\n── ${name} ────────────────────────────\n`)
    const code = await runNode(script)
    results.push({ name, code })
    if (code !== 0) {
      process.stdout.write(`\n❌ ${name} 失败（${code}），中止\n`)
      process.exit(1)
    }
  }

  process.stdout.write(
    `\n✅ 全部 ${results.length} 套验收通过（accept×${ACCEPT.length} + e2e + smoke）\n`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
