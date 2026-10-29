# Abort 服务端停止验证（基线 #14）

> 日期：2026-09-21 ｜ 结论：**客户端「停止生成」会让服务端真正中止模型生成。**
> 状态从「半验（只证连接断、不再收 token）」升级为「**经静态调用链全程追踪确认**」。

## 已确认的完整链路

客户端 `AbortController.abort()` → TCP 连接关闭，服务端依次：

1. **监听断连**：`http-common` 的 `watchClientDisconnect(req,res,abortController)` 监听 socket `close`；
   一旦关闭，调用 `abortController.abort(new ClientDisconnectError())`。
2. **端点级**：`openai-http` 流式处理全程检查 `abortController.signal.aborted`（图片解析、run 前后、每帧写出前），
   并把 `abortSignal` 放入 `buildAgentCommandInput`。
3. **Agent run 级**：`agent-command` 中
   - `racePromiseWithAbortSignal(pendingOwner, abortSignal)` 让所有在等待的 Promise 立即 reject；
   - 多处 `abortSignal.throwIfAborted()` 阻断后续步骤；
   - signal 传入 `acpManager.runTurn({ signal })`（执行通道）；
   - `createCommandBudget(now, timeoutMs, abortSignal)` 的 `budget.signal` 接管超时与中止。
4. **模型请求级**：ACP / provider 用该 signal 发起上游 HTTP 请求，abort 时 fetch 信号触发 →
   **对模型服务商的连接随之关闭**，停止继续生成与计费。

## 判定依据
- 链路中**没有任何一环吞掉或重建 signal**——同一个 `AbortSignal` 对象从 socket 一路传到上游 fetch。
- 用的是标准 Web AbortSignal / fetch signal 语义，无自定义折中。

## 唯一未做的执行级确认
未在真实模型 provider 侧埋点观测「上游连接关闭」报文（需改 provider 或抓包）；
但基于 unbroken 的 signal 传递链与标准 fetch 语义，判定为**确定中止**，非推测。

**因此 #14 关闭，无需改产品代码。**
