// collector/index.mjs —— 热点采集短命子进程入口（PLAN-2.0.md §七 Commit 11 / 硬规则 12）
//
// 职责边界：**只抓取 + stdout 按行输出 JSON**。不写库（落库统一由主进程 hotManager → DB Worker，
// 守硬规则 8）、不依赖 Gateway、不 import electron。主进程以短命子进程方式调用，超时直接 kill。
//
// 每行一个来源的描述：
//   { source, sourcePlatform, origin:'board'|'calendar', ok:true, items:[{title,heat,rank,url,fid?}] }
//   { source, sourcePlatform, origin, ok:false, error:string }
// 进度/排障信息走 stderr，stdout 只允许 JSON 行（manager 整段 JSON.parse 每行）。
//
// 配置（命令行优先，其次环境变量）：
//   --base <url>          DailyHotApi 实例（自部署 6688 / 公共实例）；不给则跳过聚合协议
//   --routes a,b,c        聚合路由（默认 douyin,weibo,bilibili,zhihu,toutiao,baidu,kuaishou）
//   --toutiao-url <url>  头条直连端点覆盖（测试指向本地假服务）
//   --bili-url <url>      B站直连端点覆盖
//   --calendar-path <p>   节点日历 JSON 覆盖
//   --now <ISO>           覆盖当前时间（节点日历窗口测试）
//   --timeout-ms <n>      单请求超时（默认 8000）
//   --sources a,b,c       只跑指定来源（calendar/toutiao/bilibili/dailyhot）

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectToutiao } from './sources/toutiao.mjs'
import { collectBilibili } from './sources/bilibili.mjs'
import { collectCalendar } from './sources/calendar.mjs'
import { collectDailyHotRoute, DEFAULT_ROUTES } from './sources/dailyhot.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function argValue(name, envName) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env[envName] || null
}

function emit(descriptor) {
  process.stdout.write(JSON.stringify(descriptor) + '\n')
}

// 失败兜底描述符必须与 adapter 成功时的 source/sourcePlatform 完全一致
// （状态条按这两个键归因；dailyhot:<route> 的平台键就是路由名）。
function failureDescriptor(name) {
  if (name === 'builtin-calendar') return { source: 'builtin-calendar', sourcePlatform: 'calendar', origin: 'calendar' }
  if (name === 'toutiao-web') return { source: 'toutiao-web', sourcePlatform: 'toutiao', origin: 'board' }
  if (name === 'bilibili-web') return { source: 'bilibili-web', sourcePlatform: 'bilibili', origin: 'board' }
  if (name.startsWith('dailyhot:')) return { source: name, sourcePlatform: name.slice('dailyhot:'.length), origin: 'board' }
  return { source: name, sourcePlatform: name, origin: 'board' }
}

async function runOne(name, fn, fallback) {
  try {
    const d = await fn()
    // 成功描述符必须显式带 ok:true（manager 按 ok 分流；adapter 只产 source/origin/items）
    emit(Object.assign({ ok: true }, d))
    process.stderr.write('[collector] OK ' + name + ' n=' + (d.items ? d.items.length : 0) + '\n')
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e)
    // 失败描述符必须与成功时同 source/sourcePlatform（dailyhot 成功时 source 带 host，
    // 不能退回 job 名，否则状态条归因错位）；fallback 由 main 按实际 base 预给。
    emit(Object.assign({ ok: false, error: msg }, fallback || failureDescriptor(name)))
    process.stderr.write('[collector] FAIL ' + name + ': ' + msg + '\n')
  }
}

async function main() {
  const timeoutMs = Number(argValue('timeout-ms', 'HOT_TIMEOUT_MS')) || 8000
  const sources = (argValue('sources', 'HOT_SOURCES') || 'calendar,toutiao,bilibili,dailyhot')
    .split(',').map(function (s) { return s.trim() }).filter(Boolean)
  const enabled = new Set(sources)
  const jobs = []

  if (enabled.has('calendar')) {
    const calendarPath = argValue('calendar-path', 'HOT_CALENDAR_PATH') || join(here, 'calendar.json')
    if (!existsSync(calendarPath)) {
      emit({ source: 'builtin-calendar', sourcePlatform: 'calendar', origin: 'calendar', ok: false, error: 'calendar.json 不存在: ' + calendarPath })
    } else {
      jobs.push(runOne('builtin-calendar', function () {
        return collectCalendar({ calendarPath, now: argValue('now', 'HOT_NOW') })
      }))
    }
  }

  if (enabled.has('toutiao')) {
    jobs.push(runOne('toutiao-web', function () {
      return collectToutiao({ url: argValue('toutiao-url', 'HOT_TOUTIAO_URL'), timeoutMs })
    }))
  }

  if (enabled.has('bilibili')) {
    jobs.push(runOne('bilibili-web', function () {
      return collectBilibili({ url: argValue('bili-url', 'HOT_BILIBILI_URL'), timeoutMs })
    }))
  }

  if (enabled.has('dailyhot')) {
    const base = argValue('base', 'HOT_DAILYHOT_BASE')
    if (base) {
      let dailyHost = base.replace(/\/$/, '')
      try { dailyHost = new URL(base).host } catch { /* 保留原串 */ }
      const routes = (argValue('routes', 'HOT_DAILYHOT_ROUTES') || DEFAULT_ROUTES.join(','))
        .split(',').map(function (s) { return s.trim() }).filter(Boolean)
      for (const route of routes) {
        jobs.push(runOne(
          'dailyhot:' + route,
          function () { return collectDailyHotRoute(route, { base, timeoutMs }) },
          { source: 'dailyhot:' + dailyHost, sourcePlatform: route, origin: 'board' }
        ))
      }
    } else {
      process.stderr.write('[collector] SKIP dailyhot：未配置 base（自部署实例或公共实例恢复后在配置里填写）\n')
    }
  }

  await Promise.allSettled(jobs)
}

main().then(function () {
  process.exit(0)
}).catch(function (e) {
  process.stderr.write('[collector] 致命错误: ' + ((e && e.message) || e) + '\n')
  process.exit(2)
})
