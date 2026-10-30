# OpenClaw 启动/重启慢：诊断与优化计划

> 状态：**只做了诊断，未改代码、未改配置**（2026-10-30）。
> 适用：`D:\work2026\files\claw-desktop`（4.0 开发态，数据目录 `data/`）。
> 关联：`doc/RUNBOOK-4.0.md`（运维手册）、`doc/voice/OPENCLAW-VOICE-GUIDE.md`（语音链路）。

---

## 1. 现象与结论

**现象**：控制台点「启动 / 重启」后，到浏览器能打开 OpenClaw 网页（`http://127.0.0.1:3213`）要等很久（分钟级）。

**结论**：慢在 **OpenClaw 网关冷启动**，不在应用重启，也不在浏览器。根因是**每次启动（以及每次配置 patch）都要把受管插件整体复制到隔离目录**：

- 当前 `data/config/.openclaw/tmp/plugin-captures/` 里 **1 个活跃副本 = 401,118 个文件 / 228.1 MB**（创建于 20:42:46，即网关启动期间）。
- `electron/main/clawManager.ts:284` 的注释已写明：「OpenClaw 每个新进程启动前都会把渠道插件整体复制到该目录做隔离加载……副本越多，OpenClaw 启动时自己的目录巡检也越慢，是**冷启动从十几秒劣化到数分钟**的原因之一」。
- `electron/main/openClawConfigWriter.ts:22` 注释同样写明：短命 CLI（config patch）冷启动**也要复制插件隔离副本**，`PATCH_TIMEOUT_MS = 300_000`（5 分钟预算）。

## 2. 实测基线（有据可查）

### 2.1 启动时序（openclaw 状态库 `gateway_boot_lifecycle` + 进程创建时间）

| 本地时间 | 事件 | 距 spawn |
|---|---|---|
| 20:41:27 | 网关进程 spawn（PID 19476） | — |
| 20:44:49 | `gateway_boot_lifecycle` 首次记录该 boot | +3m22s |
| 20:48:35 | `config-snapshot` / `openclaw.json.last-good` / cron authority 锁 | +7m08s |
| 20:49:26 | 才 spawn job-launcher / obsidian MCP / sqlite worker | +7m59s |
| 20:51:25 | **重启后第一条 agent 运行**（真正可用） | **+9m58s** |

> `gateway_boot_lifecycle.completed_at_ms` 为 null：openclaw 没落「就绪」时间戳，上表用后续事件反推；「20:40:23 → 20:51:25 没有 agent 活动」是较硬的旁证。

### 2.2 受管插件占地（`data/config/.openclaw/npm/projects`）

| 插件目录 | 文件数 | 体积 |
|---|---|---|
| openclaw-feishu-* | 19,571 | 73.7 MB |
| wecom-wecom-openclaw-plugin-* | 16,176 | 18.4 MB |
| tencent-weixin-openclaw-weixin-* | 16,058 | 6.6 MB |
| openclaw-deepseek-provider-* | 15,078 | 0.1 MB |
| openclaw-longcat-provider-* | 15,076 | 0.0 MB |
| openclaw-volcengine-provider-* | 15,076 | 0.1 MB |

`openclaw.json` 里 `plugins.entries` 实际启用了**三个**：`feishu`、`wecom-openclaw-plugin`、`openclaw-weixin`；
但 `channels` 只配了 **feishu** —— 企微/微信属于「装着并启用、但没在用」。

配置规模：`skills.entries` 40 条、`models.providers` 6 个、`agents` 2 个、`mcp.servers` 1 个（obsidian）。

### 2.3 应用侧为什么「网页打不开」

- `clawManager.start()`：spawn 后**立刻** `return { success: true }`（`clawManager.ts:426/613-628`），不等端口就绪。
- `getStatus()` 的 `running` 只是 `!!this.process`（`clawManager.ts:672`），前端据此显示「运行中」。
- `claw:openWeb` 只做 `shell.openExternal('http://localhost:3213')`（`electron/main/index.ts` 的 IPC 处理器），不等 `/health`。
- `src/stores/claw.ts:71/95` 在 `start/restart` 成功后直接把 `running=true`，没有「启动中」态。

⇒ 端口没监听时点「打开网页」= 连接被拒/空白页，体感就是「很慢/没反应」。

### 2.4 补充：boot 期复制明细（2026-10-30 晚追加）

用户确认**企微/微信等渠道都要用**，所以「精简插件」不可行。进一步拆了活跃 capture：

| capture 子目录 | 文件数 | 体积 | 创建时间 |
|---|---|---|---|
| openclaw-model-catalog-* | 45,221 | 0.2 MB | 20:48:55 |
| openclaw-plugin-build-88Vj93（feishu） | 25,230 | 73.6 MB | 20:44:24 |
| openclaw-plugin-build-DAlikc（feishu，**第二次**） | 25,277 | 73.7 MB | 20:47:31 |
| openclaw-plugin-build-6Jj9ux（wecom） | 17,320 | 18.4 MB | 20:48:24 |
| openclaw-plugin-build-3XlwcS（weixin） | 16,913 | 6.6 MB | 20:47:54 |
| 3 × provider 插件 | 各 ~15,075 | 各 0.1 MB | 20:48:42–57 |

另外 `native/admission-*` 有 15 个目录（各含 `content` + `node_modules`），也是启动期生成。

结论：**同一个飞书插件在 boot 中被构建/复制了两次**（约 5 万文件 / 147 MB），且 provider 插件每个也带 1.5 万文件；
这是 openclaw 启动期行为，属于「可比精简插件更值得调查」的方向（见批次 2）。

---

## 3. 优化计划（2026-10-30 决策后定稿）

### 决策记录

| 决策 | 结论 |
|---|---|
| 精简渠道插件（原 1.1） | **作废**：企微/微信等渠道都在用 |
| 配置 patch 后台化/去抖（原 2.3） | **不做**：保持现状（保存即同步 patch） |
| 「启动中/已就绪」状态（原 1.2） | **做** |
| 启动埋点 | **做**（与就绪态同批，用来量化「慢多少」） |
| 只读调查（重复构建/缓存） | 待确认（不改配置，只统计） |

### 批次 1（现在做：就绪态 + 埋点，不改启动行为）

**1.1 启动埋点（先量化）**
- `clawManager._spawnGateway()` 记录 `spawnAt`；
- 首次 `GET /health` 200 记录 `readyAt`，计算 `spawn → ready` 秒数；
- 写入日志面板一行：`[gateway] 启动耗时 623.4s（spawn→health）`，同时落 `data/logs/`；
- 可选采样：启动前后 `plugin-captures` 文件数/体积（诊断用，默认只记一次）。
- 文件：`electron/main/clawManager.ts`。
- 风险：极低（只加日志与计时）。

**1.2 「启动中 / 已就绪」状态**
- 主进程：
  - `clawManager.waitReady(timeoutMs)`：轮询 `http://127.0.0.1:<port>/health`（300–500ms/次），返回 `{ ready, elapsedMs }`；
  - 新增 IPC `claw:waitReady`；
  - `getStatus()` 增加 `starting`（进程在但未就绪）/`startingSince`/`ready`；
  - 重启失败/超时：透出明确错误（启动超时、exit 78、端口占用），前端可显示并引导看日志。
- 渲染端：
  - `src/stores/claw.ts`：新增 `starting`、`ready`、`startedAt/readyAt`；`start()/restart()` 成功后进入「启动中」，轮询/waitReady 后才置「已就绪」；
  - `src/views/Dashboard.vue`：「打开网页」在未就绪时禁用，按钮旁显示「启动中 32s…」；就绪后恢复并提示「已就绪」；
  - `src/views/voice/VoicePage.vue:792`「重启网关」：重启后自动等待，就绪 toast「网关已就绪（耗时 xx s）」。
- 失败路径：若 `waitReady` 超时或进程退出，显示「启动失败/超时」+「查看日志」入口，不无限转圈。
- 风险：中低（跨 3 个渲染文件 + 1 个主进程文件；需覆盖失败分支）。

**1.3 验收**
- 双 typecheck、`npm run build`；
- `plugin.accept`（61/61）与全量 19 套（368/368）回归；
- `ui.accept` 增加断言：未就绪时「打开网页」禁用、就绪后可用、文案含「启动中」；
- 人工：重启网关，记录「点击 → 界面显示已就绪」秒数，与日志里的 `spawn→health` 对齐；确认失败场景（如端口被占用）能给出错误而不是一直转圈。

### 批次 2（待确认：只读调查，不改配置）

- 统计多次启动的 `captures/` 目录数/文件数/耗时，确认「飞书被构建两次」是否稳定复现；
- `openclaw plugins list --verbose` / `plugins inspect`、`plugins build --help`：找是否有可复用缓存或开关；
- 对比「保存配置前后」captures 目录数，确认 CLI patch 是否也触发同一套构建；
- 产出：若能压缩则给实施方案与预期收益；若不能则记录为 openclaw 上游限制，转向「减少重启次数 / 语音热更」。

### 批次 3（可选：低风险清理）

- `_cleanStalePluginCaptures`（`clawManager.ts:284`）加 3–5s 阻塞上限，剩余转后台删除（保持「先 rename 再 rm」口径）。

### 批次 4（长期，暂不做）

- 语音热更：bridge 脚本每次读设置文件，改音色/Key 不必重启网关；
- 两阶段启动/常驻服务评估。

## 4. 验收与度量（DoD）

**基线（本次实测）**
- captures：401,118 文件 / 228.1 MB
- spawn → 首条 agent 活动：≈ 9m58s
- 应用启动（主进程 → 插件 worker）：≈ 6–7s（18:54:06 → 18:54:12/13）

**目标**
- 批次 1 后：不再出现「显示运行中但网页打不开」；记录到真实启动耗时（spawn→health）
- 批次 2.0 后：明确 captures 是否有可复用/去重空间；有则给出数据，没有则记录上游限制
- 批次 2.3 后：保存配置不再阻塞在 patch 上（重启前有 flush 兜底）
- 任何批次都不得破坏：全量 19 套 accept（当前 368/368）、`plugin.accept`（61/61）、`one-day.e2e`（11/11）、`packaged.smoke`（6/6）、双 typecheck、`npm run build`

**人工验证**
- 重启网关 → 记录「点击 → 网页可打开」秒数；
- 飞书通道收发正常；语音（对话内 TTS）正常；模型切换正常；
- `data/plugins-state.json` 当前是 `{"work": false}`，确认工作域是否应启用（与本次优化无关，但会影响启动期插件激活）。

---

## 5. 决策记录（已拍板）

1. 渠道（企微/微信/飞书等）**都在用** → 不精简、不卸载插件。
2. 配置 patch **保持现状**（保存即同步），不做后台化/去抖。
3. 「启动中/已就绪」状态 + 启动埋点 **做**（批次 1）。
4. 重复构建/缓存复用：先做只读调查（批次 2），有数据后再决定是否动 openclaw 侧。

## 6. 复现/度量命令（只读）

```powershell
# captures 占地
$caps = 'data\config\.openclaw\tmp\plugin-captures'
Get-ChildItem $caps -Directory | ForEach-Object {
  $n = [System.IO.Directory]::GetFiles($_.FullName,'*','AllDirectories').Length
  "{0}  {1} 文件" -f $_.Name, $n
}

# 网关 boot 记录（需 node:sqlite）
# 见本次诊断：data/config/.openclaw/state/openclaw.sqlite → gateway_boot_lifecycle

# 当前是否就绪
Invoke-WebRequest -Uri 'http://127.0.0.1:3213/health' -UseBasicParsing | Select-Object -Expand StatusCode
```