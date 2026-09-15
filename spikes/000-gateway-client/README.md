# SPIKE 000 —— OpenClaw Gateway HTTP 客户端可行性

> 对应 PLAN-2.0 第七节 **Commit 00**：验证 Umi Claw 2.0 的 AI 主路线
> （Gateway HTTP → 完整 agent run）是否可用，产出 **Primary / Fallback / Unsupported** 结论。
> 本目录是抛原型，**代码不并入生产**（结论落地时按正常规范重写）。

## 要回答的问题

1. `gateway.http.endpoints.chatCompletions.enabled = true` 后，OpenAI 兼容面是否如文档所述工作？
2. 是否支持 **SSE 流式**、**中途取消（AbortController）**、**结构化错误**（而非超时）？
3. 是否支持**多模态** `image_url`（决定 Commit 05b 能否落地）？
4. `user` 会话粘性能否**复用历史**（决定要不要建本地 `project_messages` 表 + 每轮回灌）？
5. 不同 `user` 之间记忆是否**隔离**（多商家不串味）？
6. HTTP 只绑 `127.0.0.1` 还是 `0.0.0.0`？

## 运行

```bash
# 1) 端点开关（支持热重载，无需重启 Gateway）
#    gateway.http.endpoints.chatCompletions.enabled = true

# 2) 可选：生成一张带文字的测试图（多模态场景）
pwsh -File gen-test-image.ps1

# 3) 跑 Spike（token 取 openClawPaths.ts 的 GATEWAY_TOKEN，勿写入版本库）
node spike-gateway.mjs --token "<GATEWAY_TOKEN>" \
  --base http://127.0.0.1:3213 \
  --image .\s7-test.png \
  --out spike-result.json
```

## 场景与产出

| 场景 | 验证什么 |
|---|---|
| S0 health | 探活基线 |
| S1 models | 端点开关生效（404 → 200）+ 可用模型清单 |
| S2 nonstream | 基本调用可用性 |
| S3 sse | 首字延迟（ttfb）/ 分片数 / 总时长 |
| S4 abort | 中途取消，客户端能正确结束 |
| S5 / S6 | 坏 token / 坏 model → **结构化错误码**（非超时） |
| S7 multimodal | `image_url` 是否被接受、能否读出图中文字 |
| S8 history_replay | 同一 `user=` 第二轮能否复述第一轮暗号 |
| S9 isolation | 不同 `user=` 是否互相不可见 |

## Verdict: VALIDATED

**Question**：Gateway HTTP 能否作为 2.0 的 AI 主路线，并满足流式 / 取消 / 多模态 / 会话复用 / 隔离？

**Evidence**（2026-09-15 16:38–16:41，dev 实例 `http://127.0.0.1:3214`，openclaw 2026.9.4 / Node v24.21.0，见 `spike-result.json`）

| 场景 | 结果 |
|---|---|
| S0 health | 200，97ms |
| S1 models | 200 —— 端点开关**热重载生效**，返回 `openclaw` / `openclaw/default` / `openclaw/main` |
| S2 non-stream | 200，**80304ms**（首次调用，含 agent 冷启动） |
| S3 SSE | 200，**ttfb 1268ms** / 3 chunks / 总计 13632ms，文本正常 |
| S4 abort | **客户端中止成功**（4 chunks 后 abort） |
| S5 坏 token | **401** `{"error":{"message":"Unauthorized","type":"unauthorized"}}` |
| S6 坏 model | **400** `{"error":{"message":"Invalid \`model\`. Use \`openclaw\` or \`openclaw/<agentId>\`.","type":"invalid_request_error"}}` |
| S7 multimodal | **未测**（产品决定：模型必支持多模态；端点 image 通道留给 07 验） |
| S8 history replay | **YES** —— 同一 `user=` 第二轮准确复述暗号 `UMI-ZEBRA-42` |
| S9 isolation | **no leak** —— 跨 user 回答「无（本次对话里你没有给过我暗号）」 |

**What worked**

- 端点开关 `reloadKind=hot`，改完配置**无需重启**即生效（对 Commit 07 的关键利好）
- `Authorization: Bearer <token>` 鉴权；SSE 流式；客户端 `AbortController` 可中止
- 错误是**结构化 JSON**（带 `type` 字段），不是超时——错误码映射可行
- `user` 会话粘性**可回放历史**（⑥ 结论 = A），且**跨 user 隔离干净**

**What failed or surprised us**

1. **首次非流式调用 80.3s**（agent 冷启动）→ 必须走流式，且 Commit 07 应加**预热**。
2. **`usage` 全为 0**（`prompt_tokens/completion_tokens/total_tokens` 都是 0）→ 不能依赖 Gateway 返回的 token 统计，Commit 06 的上下文预算必须**本地估算**。
3. **`model` 取值是 `openclaw` 或 `openclaw/<agentId>`**，不是 provider 模型 id（provider 模型要用别的方式指定）。
4. **客户端 abort 后服务端是否真正停止生成未验证**（本次只验了客户端能正确结束）——列为待办。
5. 应用写出的 `meta.lastTouchedAt` 被 schema 拒绝；OpenClaw 启动时会自愈，但**应在应用侧修**（Commit 07 顺带）。

**Recommendation: ship（Primary）**

Gateway HTTP 作为 **Primary**；直连模型 API 保留为 Fallback（本次未测，因主路线已通）。

回填基线的 5 项：

1. **⑥ = A** → **不建 `project_messages` 表**，也不需要每轮回灌；Commit 02 业务表 10 张。
2. Commit 06：上下文预算用**本地估算**（usage 不可用）。
3. Commit 07：`model` 用 `openclaw` / `openclaw/<agentId>`；加**预热**；端点开关写默认值（热重载已验）。
4. Commit 07：顺带修 `meta.lastTouchedAt` / `lastTouchedVersion:'latest'`（`configManager.ts:703-707`、`downloadManager.ts:1451-1452`）。
5. 新增待办：客户端 abort 后**服务端是否停止生成**（关系到 token 是否白烧）。

## 阻塞点与解法（2026-09-15）

**现象**：从自动化会话内无法开启端点——修改 `gateway.*` 配置的提案被 host 按会话权限策略**拒绝**（非待处理），且不允许绕过（不用 exec 直接改承载本会话的 Gateway 配置，也不重启它）。

**结论（对 Commit 07 有用）**：

1. 开启端点的写入必须由**应用自身**完成——正好对应 Commit 07 的「端点开关默认化 + 老用户迁移」，落点就是 `electron/main/configManager.ts` 里生成 gateway 段的那个位置。
2. 该键 `reloadKind = hot`，**理论上无需重启应用即可生效**；若网关未即时拾取配置变更，回退方案是重启应用。
3. 生产代码不要依赖“用户手动改 JSON”；应用启动时自己写好默认值。

**手工解锁步骤（一次性，SPIKE 用）**：在 `data/config/.openclaw/openclaw.json` 的 `gateway` 段中增加：

```json
"http": { "endpoints": { "chatCompletions": { "enabled": true } } }
```

保存后等几秒（hot reload），`GET /v1/models` 由 404 → 200 即解锁；否则重启应用。

## 已知前置事实（2026-09-15，只读探测）

| 项 | 结果 |
|---|---|
| `GET /health` | 200 `{"ok":true,"status":"live"}` ✓ |
| `GET /v1/models` | 404（端点默认关闭，符合预期） |
| 监听地址 | 仅 `127.0.0.1:3213`（未绑 0.0.0.0）✓ |
| 配置键 | `gateway.http.endpoints.chatCompletions.enabled`（boolean，**reloadKind = hot**） |
| 当前配置 | 打包版与 dev 版 `gateway` 段均只有 `mode` / `auth`，无 `http` 段 |
