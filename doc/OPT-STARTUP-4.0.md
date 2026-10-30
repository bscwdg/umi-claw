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

## 3. 优化计划（按性价比排序）

> **2026-10-30 修订**：用户确认渠道（含微信/企微）都在用 → 原「精简插件」项作废，改为「调查重复构建 + 降低重启频率」。

### 批次 1（P0：用户可感知最快，先做）

#### 1.1 「打开网页」等就绪 + 启动进度（原 1.2，提前）
- 验证：记录动作前后 `plugin-captures` 的文件数/体积；重启网关记录 spawn→首个 `/health` 200 秒数；确认飞书收发仍正常。
- 回滚：`openclaw plugins enable <id>`（uninstall 的情况需重装）。

#### 1.2 「打开网页」等就绪 + 启动进度

- 主进程：
  - `clawManager` 加 `waitReady(timeoutMs)`：轮询 `http://127.0.0.1:<port>/health`（300–500ms/次），返回是否就绪与耗时。
  - 新增 IPC `claw:waitReady`；`getStatus` 增加 `starting`（已 spawn 未就绪）/`startingSince`/`ready`。
  - `claw:openWeb` 保持打开浏览器，但前端改为「先等就绪再打开」。
- 渲染端：
  - `stores/claw.ts`：新增 `starting`、`startedAt` 语义修正（spawn 与 ready 分开）。
  - `src/views/Dashboard.vue`：未就绪时「打开网页」禁用 + 显示「启动中 12s…」；就绪后提示「已就绪」。
  - `src/views/voice/VoicePage.vue:792` 的「重启网关」：重启后自动等待并在就绪时 toast。
- 预期：真实耗时不变，但**不再出现空白页/误判卡死**；用户能等到明确的「已就绪」。
- 验证：`ui.accept` 增加「未就绪禁用打开网页」的静态/组件断言；手动重启观察文案与按钮状态；全量验收回归。

### 批次 2（P1：调查可压缩项 + 减少重复成本）

#### 2.0 调查「重复构建 / 缓存复用」（新增，收益未知但可能最大）

- 现象：同一次 boot 里 feishu 插件被构建两次（50k 文件 / 147 MB）；`native/admission-*` 还有 15 个目录各含 node_modules。
- 调查项：
  1. 记录每次启动后 `captures/` 下各 build 目录数量与耗时（对比两次重启是否稳定翻倍）；
  2. 查 openclaw 是否有插件构建缓存/复用开关（`openclaw plugins build --help`、`plugins list --verbose`、`cache/` 目录只有 control-ui-assets，疑似未复用）；
  3. 检查应用侧 `syncOpenClawConfig` 的 CLI patch 是否也触发同一套构建（对比「保存配置前后 captures 目录数」）。
- 产出：要么找到开关/复用方式（收益大），要么确认是 openclaw 上游行为 → 记录限制，转向「少重启」。

#### 2.1 captures 清理加时间预算

- 现状：`_cleanStalePluginCaptures`（`clawManager.ts:284`）串行 `fs.rm` 所有 stale 副本，Windows 上数万小文件可能分钟级，**阻塞 spawn**。
- 改法：最多阻塞 3–5s；剩余目录转后台继续删（不 await），日志区分「已清理 / 后台清理中」。
- 预期：最坏情况不再因为清理把启动拖成分钟级；目录仍会收敛。
- 风险：后台清理与启动并发 → 需保持「先 rename 再 rm」的既有安全口径（已实现）。

#### 2.2 启动埋点（让「慢」可量化）

- `_spawnGateway` 记 `spawnAt`；`waitReady` 首次 200 记 `readyAt`；
- 写日志面板与 `data/logs/`：`[gateway] 启动耗时 12.3s（spawn→health）`；
- 附带记录 `plugin-captures` 文件数与体积（启动前后各一次，采样即可）。
- 预期：下次再慢能直接定位是「spawn 前准备」还是「openclaw boot」。

#### 2.3 配置 patch 后台化（替代原「去抖」）

> 原计划是「去抖 + 串行队列」，但单次保存的收益很小；真正影响体感的是**保存时阻塞**。
- 改法：`saveConfig` 仍然先落 `app.json`（不丢配置），patch 改为「串行队列 + 后台执行 + 状态提示」；`clawManager.start()` 前 `flushPendingPatch()` 兜底，保证重启前一定落盘。
- 风险：保存后立刻看 `openclaw.json` 可能还没更新（几百 ms 到数秒）；重启前 flush 可消除「读到旧配置」风险；进程崩溃窗口内 app.json 已落盘，下次启动会补。
- 备选：若你更在意「保存即同步」，可保留同步 patch，只做串行队列（不合并），收益有限。

### 批次 3（P2：openclaw 侧继续压缩 boot）

- `skills.entries` 40 条：用应用已具备的技能开关（`configManager` 的 skills patch 通道）关掉不用的，观察 boot 变化（每关一批测一次）。
- `mcp.servers`（obsidian）：进程树显示 20:49:26 才起，可能已懒加载；确认是否可再延后/按需。
- `openclaw plugins list/inspect`：确认三渠道 + providers 之外没有多余插件参与 boot。
- 注意：`openclaw plugins reload` 只热重载插件，不是配置热重载；`tts` 块仍需重启生效。

### 批次 4（P3：架构级，长期）

- **语音热更**：把 bridge 的 `UMI_VOICE_SPEAKER`/Key 从「网关进程 env」改为「`volc-tts.mjs` 每次合成时读设置文件」；这样至少「改音色/Key」不必重启网关（`tts.auto`/`provider` 变更仍需）。
- **两阶段启动**：先轻量 spawn 再后台 patch/校验；或评估 `openclaw gateway install`（systemd/schtasks 常驻）避免每次冷启动（与当前便携式分发冲突，需单独评估）。

---

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

## 5. 需要拍板的点

1. ~~企微/微信插件是否在用~~ → **已确认在用，插件保留**（原「精简插件」作废）。
2. 「配置 patch」选哪种：**后台化 + 重启前 flush**（推荐，保存不卡）还是保持同步（保存即写，但每次要等）？
3. 是否同意加「启动中/已就绪」状态（会改 Dashboard 与语音页文案）？
4. 是否允许先做**只读调查**（批次 2.0：统计 captures、试 `plugins build --help` 等，不改配置），再决定是否值得动 openclaw 侧？

---

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
