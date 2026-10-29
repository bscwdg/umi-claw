/**
 * Commit 02 验收：安装包（打包产物）端到端冒烟
 *
 * 做法：对 `release/win-unpacked/Umi Claw.exe` 加 `--remote-debugging-port`，
 * 用 CDP 在**真实渲染进程**里调真实的 `window.api.marketing.system.*`，
 * 这样测到的是「打包后的 main + preload + db-worker.mjs + 便携 Node + 便携数据目录」整条链路，
 * 不是单元测试的替身。
 *
 * 用法：
 *   node test/packaged-smoke.mjs eval "<js 表达式>"     # 求值并打印结果（JSON）
 *   node test/packaged-smoke.mjs wait                   # 等 CDP 就绪
 *   node test/packaged-smoke.mjs close                  # 优雅关闭应用（Browser.close）
 */
const port = Number(process.env.CDP_PORT || 9222)
const action = process.argv[2]

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return await res.json()
}

async function waitForPage(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const list = await targets()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等待 CDP 目标超时：${lastErr ? lastErr.message : '未出现 page target'}`)
}

async function withWs(fn) {
  const page = await waitForPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败: ' + (e?.message || e))), { once: true })
  })
  let seq = 0
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const onMsg = (ev) => {
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.id !== id) return
        ws.removeEventListener('message', onMsg)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    return await fn(send, page)
  } finally {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

if (action === 'wait') {
  const page = await waitForPage()
  console.log(JSON.stringify({ ok: true, url: page.url, title: page.title }))
} else if (action === 'close') {
  // 浏览器级 target 才能 Browser.close
  const list = await targets()
  const browser = list.find((t) => t.type === 'browser') || { webSocketDebuggerUrl: null }
  if (!browser.webSocketDebuggerUrl) throw new Error('找不到 browser target')
  const ws = new WebSocket(browser.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', (e) => rej(new Error('WS 连接失败: ' + (e?.message || e))), { once: true })
  })
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }))
  await new Promise((r) => setTimeout(r, 800))
  console.log(JSON.stringify({ ok: true, note: 'Browser.close 已发送' }))
} else if (action === 'eval') {
  const expression = process.argv[3]
  if (!expression) throw new Error('缺少表达式')
  const out = await withWs(async (send) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    return r
  })
  if (out.exceptionDetails) {
    console.error('EVAL_EXCEPTION ' + JSON.stringify(out.exceptionDetails))
    process.exit(2)
  }
  console.log(JSON.stringify(out.result?.value ?? null))
} else {
  console.error('用法: node test/packaged-smoke.mjs <eval|wait|close> [表达式]')
  process.exit(1)
}
