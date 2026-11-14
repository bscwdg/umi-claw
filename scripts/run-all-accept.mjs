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
// 4.0 合并说明：context / knowledge 在 2.0 与 3.0 各自存在同名脚本（add/add），
// 已按域拆到 test/work/* 与 test/marketing/*（见 MERGE-INVENTORY R5），两套都要跑。
const ACCEPT = [
  // 首套跑边界门禁：零依赖、秒级；它必须被自动链路执行，否则 ratchet 只是文档
  ['boundary', 'test/boundary.accept.mjs'],
  // 插件 API 迁移 ratchet（host/UI/hostBridge 三类耦合只准降；PLAN-5.0 A2/A3b）
  ['plugin-api', 'test/plugin-api.accept.mjs'],
  // 样式 token 门禁紧随其后：同为零依赖秒级，卡住硬编码色/rem/错误变量名回退
  ['style-tokens', 'test/style-tokens.accept.mjs'],
  ['db-worker', 'test/db-worker.accept.mjs'],
  ['gateway', 'test/gateway.accept.mjs'],
  ['node-runtime', 'test/node-runtime.accept.mjs'],
  ['maintenance', 'test/claw-maintenance.accept.mjs'],
  // 网关日志落盘（管道 tee / detached 直写 / fd 生命周期），与 maintenance 共用 ClawManager 打桩口径
  ['gateway-log', 'test/gateway-log-files.accept.mjs'],
  // openclaw-qqbot 语音本地路径热修（启动前幂等锚点补丁，fail-open）
  ['qqbot-voice-patch', 'test/qqbot-voice-patch.accept.mjs'],
  ['terminal-sessions', 'test/terminal-sessions.accept.mjs'],
  // P45：宿主 IPC 行为级验收（env / claw / config / terminal 四组通道，fake registrar + 注入 deps）
  ['host-ipc', 'test/host-ipc.accept.mjs'],
  // 4.5：群聊策略（GroupSettings 模型/迁移/编译成 OpenClaw 配置）+ 随包 feiyu-guard hook 插件
  ['group-policy', 'test/group-policy.accept.mjs'],
  ['group-config', 'test/group-config.accept.mjs'],
  ['guard-plugin', 'test/guard-plugin.accept.mjs'],
  ['config-writer', 'test/openclaw-config-writer.accept.mjs'],
  ['work', 'test/work.accept.mjs'],
  ['record', 'test/record.accept.mjs'],
  ['context:work', 'test/context.work.accept.mjs'],
  ['context:marketing', 'test/context.marketing.accept.mjs'],
  ['today', 'test/today.accept.mjs'],
  ['report', 'test/report.accept.mjs'],
  ['openclaw-summary', 'test/openclaw-summary.accept.mjs'],
  ['qatool', 'test/qatool.accept.mjs'],
  ['knowledge:work', 'test/knowledge.work.accept.mjs'],
  ['knowledge:marketing', 'test/knowledge.marketing.accept.mjs'],
  ['project', 'test/project.accept.mjs'],
  ['business', 'test/business.accept.mjs'],
  ['advisor', 'test/advisor.accept.mjs'],
  ['scan', 'test/scan.accept.mjs'],
  ['content', 'test/content.accept.mjs'],
  ['shooting', 'test/shooting.accept.mjs'],
  ['hot', 'test/hot.accept.mjs'],
  ['hotscore', 'test/hotscore.accept.mjs'],
  ['platform', 'test/platform.accept.mjs'],
  ['wizard', 'test/wizard.accept.mjs'],
  ['voice', 'test/voice.accept.mjs'],
  ['external-tts', 'test/external-tts.accept.mjs'],
  ['character', 'test/character.core.accept.mjs'],
  ['character-content', 'test/character-content.accept.mjs'],
  ['sticker', 'test/sticker.accept.mjs'],
  ['plugin', 'test/plugin.accept.mjs'],
  ['plugin-contract', 'test/plugin-contract.accept.mjs'],
  ['plugin-isolation', 'test/plugin-isolation.accept.mjs'],
  ['plugin-permissions', 'test/plugin-permissions.accept.mjs'],
  ['plugin-service-bridge', 'test/plugin-service-bridge.accept.mjs'],
  ['plugin-isolation-manager', 'test/plugin-isolation-manager.accept.mjs'],
  ['plugin-runtime-isolation', 'test/plugin-runtime-isolation.accept.mjs'],
  ['plugin-dev-mode', 'test/plugin-dev-mode.accept.mjs'],
  ['consent', 'test/consent.accept.mjs'],
  ['ui', 'test/ui.accept.mjs']
]
// 全部单模块绿后
const E2E = [
  ['one-day e2e', 'test/one-day.e2e.mjs'],
  ['startup e2e', 'test/startup.e2e.mjs'],
  ['isolation e2e', 'test/plugin-isolation.e2e.mjs']
]
const SMOKE = ['packaged smoke', 'test/packaged.smoke.mjs']

// 套件「自身异常」必须判失败：各套件主体包在 try/catch 里，异常只打一行
// 「验收脚本自身异常」；若断言在异常前还没注册，checks 为空 → printResult 的
// failed=0 会误判绿。这里同时解析子进程输出，出现该标记即失败（2026-11-02 实测
// platform 在 setup 抛异常时曾输出 0/0 且 exit 0）。
const SUITE_CRASH_MARK = '验收脚本自身异常'

function runNode(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, script)], {
      cwd: repoRoot,
      stdio: ['inherit', 'pipe', 'pipe']
    })
    let crashed = false
    const forward = (stream, target) => {
      let tail = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        // 标记可能被切在两个 chunk 之间：带上上一段尾巴再判
        if ((tail + chunk).includes(SUITE_CRASH_MARK)) crashed = true
        tail = (tail + chunk).slice(-SUITE_CRASH_MARK.length)
        target.write(chunk)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    child.on('close', (code) => resolve({ code: code ?? 1, crashed }))
  })
}

async function main() {
  const results = []
  for (const [name, script] of ACCEPT) {
    process.stdout.write(`\n── accept: ${name} ────────────────────────────\n`)
    const { code, crashed } = await runNode(script)
    results.push({ name, code, crashed })
    if (crashed) {
      process.stdout.write(`\n❌ accept: ${name} 脚本自身异常（已判失败，防止 0/0 假绿），中止\n`)
      process.exit(1)
    }
    if (code !== 0) {
      process.stdout.write(`\n❌ accept: ${name} 失败（${code}），中止\n`)
      process.exit(1)
    }
  }

  for (const [name, script] of [...E2E, SMOKE]) {
    process.stdout.write(`\n── ${name} ────────────────────────────\n`)
    const { code, crashed } = await runNode(script)
    results.push({ name, code, crashed })
    if (crashed) {
      process.stdout.write(`\n❌ ${name} 脚本自身异常（已判失败，防止 0/0 假绿），中止\n`)
      process.exit(1)
    }
    if (code !== 0) {
      process.stdout.write(`\n❌ ${name} 失败（${code}），中止\n`)
      process.exit(1)
    }
  }

  process.stdout.write(
    `\n✅ 全部 ${results.length} 套验收通过（accept×${ACCEPT.length} + e2e×${E2E.length} + smoke）\n`
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
