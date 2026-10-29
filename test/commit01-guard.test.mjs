/**
 * Commit 01 验收脚本：首启 Setup 守卫行为（零依赖，直接跑真代码）
 *
 * 做法：用 esbuild 把 `src/renderer/setupGuard.ts` 打成临时 ESM，
 * 在纯 Node 里配上真实 `vue-router`（memory history）+ 假 env.check() 跑场景。
 * 不复制守卫逻辑，测的就是生产代码本体。
 *
 * 运行：node test/commit01-guard.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRouter, createMemoryHistory } from 'vue-router'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpDir = join(root, 'test', '.tmp')
const bundle = join(tmpDir, 'setupGuard.mjs')

rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(root, 'src', 'renderer', 'setupGuard.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--external:vue-router',
    `--outfile=${bundle}`,
    '--log-level=warning'
  ],
  { stdio: 'inherit' }
)

const { createSetupGuard } = await import(pathToFileURL(bundle).href)

const routes = ['/dashboard', '/logs', '/config', '/setup', '/marketing/hot'].map((path) => ({
  path,
  component: { render: () => null }
}))

async function runGuard(envResult) {
  let calls = 0
  const errors = []
  const check =
    envResult === 'throw'
      ? async () => {
          calls++
          throw new Error('IPC 挂了')
        }
      : async () => {
          calls++
          return envResult
        }
  const router = createRouter({ history: createMemoryHistory(), routes })
  router.beforeEach(createSetupGuard({ check, onError: (e) => errors.push(e) }))
  return {
    router,
    calls: () => calls,
    errors,
    async goto(path) {
      await router.push(path).catch(() => {})
      return router.currentRoute.value.path
    }
  }
}

const results = []
function check(name, actual, expected) {
  const ok = actual === expected
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}   ->  ${actual}${ok ? '' : `  (期望 ${expected})`}`)
}

const ready = { nodeInstalled: true, openClawInstalled: true, channelsInstalled: true }

// 1-2 环境已就绪：直达 + 守卫只探测一次（模块级缓存）
{
  const g = await runGuard(ready)
  check('已装环境 → /dashboard 直达', await g.goto('/dashboard'), '/dashboard')
  check('已装环境 → /marketing/hot 直达', await g.goto('/marketing/hot'), '/marketing/hot')
  check('env.check 全程只调用一次（缓存）', g.calls(), 1)
}

// 3-5 环境未就绪：弹回 /setup，且 /setup 自身放行（不产生重定向环）
{
  const g = await runGuard({ nodeInstalled: true, openClawInstalled: false })
  check('未装 OpenClaw → 弹回 /setup', await g.goto('/dashboard'), '/setup')
  check('未装 OpenClaw → 目标 /setup 放行', await g.goto('/setup'), '/setup')
  check('未装 OpenClaw → 其他路由仍弹回 /setup', await g.goto('/logs'), '/setup')
  check('未装 OpenClaw 时 env.check 仍只调用一次', g.calls(), 1)
}

// 6 Node 缺失同样视为未就绪
{
  const g = await runGuard({ nodeInstalled: false, openClawInstalled: true })
  check('未装 Node → 弹回 /setup', await g.goto('/dashboard'), '/setup')
}

// 7 env.check 抛异常 → 放行（不把用户锁死）
{
  const g = await runGuard('throw')
  check('env.check 异常 → 放行 /dashboard', await g.goto('/dashboard'), '/dashboard')
  check('env.check 异常被上报（未静默吞掉）', g.errors.length, 1)
}

// 8 channels 不参与判定（待办 #5 口径）
{
  const g = await runGuard({ nodeInstalled: true, openClawInstalled: true, channelsInstalled: false })
  check('仅缺 channels → 放行 /dashboard', await g.goto('/dashboard'), '/dashboard')
}

// 9 Setup 完成后整页 reload 语义：新守卫实例 + 已就绪环境 → 不被弹回
{
  const g = await runGuard(ready)
  check('Setup 完成重载后 → 进 dashboard 不被弹回', await g.goto('/dashboard'), '/dashboard')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n== Commit 01 守卫验收：${results.length - failed.length}/${results.length} 通过 ==`)
rmSync(tmpDir, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
