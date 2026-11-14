# Umi Claw 扩展性计划（PLAN-5.0-EXTENSIBILITY v1.1）

> 状态：草案 v1.1（2026-11-13，依据两轮独立对抗审查修订，并经第三轮复审）｜定位：4.x → 5.0 的第三方插件路线图、不可逆决策记录与工作包拆解
> 关系：`PLAN-4.0.md` 是宿主/内置插件的架构契约；本文件接管「第三方插件方向」。冲突时以本文件 §10 为准，其余仍按 `PLAN-4.0.md`。
> 决策输入：2026-11-13 产品负责人确认的 9 条不可逆决策（§1）；两轮对抗审查摘要见附录 D（原始报告为本地临时文件，不入库）。
> 编号说明：v1.0 曾用 `PLAN-4.5`，与仓库既有「4.5 群聊重构/4.5 欠账」标签撞车，v1.1 更名 `PLAN-5.0`。
> 原则：**先验证隔离前提，再冻结 API；先冻结 API，再安装。**

---

## 〇、结论与边界

### 0.1 目标

未来允许用户**自行安装/复制第三方插件**，并且：

- 插件能力按 manifest 授权，默认拒绝；
- 插件在独立进程运行，崩溃/死循环不拖垮宿主；
- 宿主升级不批量杀死插件；
- 出现安全问题可禁用/吊销/下架；
- 官方插件与第三方插件使用**同一套 API**。

### 0.2 v1 的诚实边界（对抗审查 P0-2/P0-4 修订）

**v1 不做「任意不可信代码」承诺，只做「受控第三方」：**

- `utilityProcess` + Node permission model 能约束 `fs` / `child_process`（**仅 `env.NODE_OPTIONS` 生效，`execArgv` 实测无效**），且**必须把入口目录写进 `--allow-fs-read`**（否则入口加载即 exit 1）；连带的 `worker_threads` / native addon / `process.binding` 也被拦，但 `process._linkedBinding` 仍可用（残余）；
- **不能约束 TCP 外连**（实测：permission model 下 loopback 与 `example.com:80` 均 CONNECTED；Node 20.16 无 net 权限项）；`child-process-gone` 对 utilityProcess 21 次终止 0 触发，必须监听 `UtilityProcess.exit` + 应用层心跳；
- 因此 v1 的第三方插件必须经过**签名/审核/权限声明**，网络能力只承诺「宿主代理 + 域名白名单 + 静态审查」，不承诺「恶意代码无法直连网络」；
- 真正的不可信沙箱（OS 级网络/文件隔离）列为 Phase 3 研究项，不纳入 5.0 承诺；
- 对外文案不要写「插件沙箱」，写「进程隔离 + 最小权限 + 可撤销」。

### 0.3 非目标（v1）

- 公开插件市场（v1 只做侧载 + 官方/伙伴签名目录）；
- 第三方任意 Vue UI（v1 只做无界面 + `configSchema` 设置页；iframe UI 到 Phase 3）；
- 第三方 native module / `postinstall` / 任意子进程；
- 把权限门禁说成杀毒/沙箱；
- 重写宿主 UI，迁 pnpm workspace（Phase 2 前保持单 `package.json`）。

### 0.4 版本与分支策略

| 阶段 | 版本 | 分支 | 说明 |
| --- | --- | --- | --- |
| Phase 0 | 4.3.0 | `feat/plugin-api`（基于当前 codex/voice HEAD；voice 合并后 rebase 到 release/4.0） | API v1 + SDK + 契约收敛；**不开放第三方安装** |
| Phase 1 | 4.4.0-dev | `feat/plugin-isolation` → 合回 4.x | 隔离/权限原型，feature flag 默认 off |
| Phase 2 | 5.0.0-beta.2 | `release/5.0`（beta.1 时切） | 签名包、侧载安装、更新/回滚、设置页 |
| Phase 3 | 5.x | `release/5.0` | 第三方 UI iframe、市场/审核、OS 级隔离研究 |

> 不在现在切 `release/5.0`：4.x 的 hotfix/voice 仍在活跃（近期 2 天 9 提交），长分支会同时踩合并与审查债。Phase 0 用短分支，A2/A3 分小步合回。

---

## 一、不可逆决策（2026-11-13 确认，v1.1 修订）

| # | 决策 | v1.1 修订 |
| --- | --- | --- |
| D1 | **双轨执行模型** | 官方插件可继续 in-process；第三方进 `utilityProcess`；两者同一套 API，API 从第一天按 RPC 设计 |
| D2 | **插件 API 全 async** | 仅约束**第三方可见面**；官方 internal 可保留同步。事件/流式必须有 RPC 契约，不依赖 Electron `event.sender` |
| D3 | **第三方 UI v1 不做** | 只做无界面 + `configSchema` 自动设置页；任意 UI 到 Phase 3 iframe |
| D4 | **权限默认拒绝** | 第三方可见面改 **allowlist**，不是 denylist；`consent`/`abort`/`hostOps`/`legacyDb` 不对第三方开放 |
| D5 | **包格式与信任** | 签名信封含 `keyId`/`alg`；宿主维护 keyring 与吊销列表（**不放包内**）；v1 支持「官方签名 + 伙伴白名单 + 自签 TOFU（首次确认指纹、变更告警）」；包带 `apiVersion`/`engines.host`/`permissions`/hash；宿主自身代码签名进发布清单 |
| D6 | **v1 只侧载** | 文件/目录/URL + 官方静态索引；不做公开市场 |
| D7 | **第三方 JS-only** | 禁 native/`postinstall`/任意子进程；`fs` 用 Node permission model（**只走 `NODE_OPTIONS` 生效，execArgv 在 utilityProcess 无效**）约束；子进程 env **显式白名单构造，不继承 `process.env`**；**网络不承诺强隔离**（见 0.2） |
| D8 | **兼容承诺** | `apiVersion` major + `engines.host`；承诺 N / N-1、至少 6 个月弃用窗口 |
| D9 | **v1 是受控第三方** | 不是「任意不可信代码」平台；审核/签名/可撤销是产品前提，不是可选项 |

---

## 二、目标形态（v1）

### 2.1 运行时

```text
main process
├── kernel / plugin host（官方插件，in-process，保持现状）
├── plugin process supervisor（Phase 1）
│   └── utilityProcess：第三方插件 main（**CJS canonical**；`.mjs`/ESM 实测可用）
├── capability broker（Phase 1）
│   └── allowlist + 权限校验 + 会话命名空间 + 审计
├── host services（db / openclaw / config / notifications / voice / secrets / kv ...）
└── ipc（宿主通道 + plugin:<id>:* + 插件租约通道）
renderer
├── 宿主 UI（不变）
├── 官方插件 UI（构建期 import，不变）
└── 第三方设置页（configSchema 自动生成）
```

### 2.2 第三方可见面（allowlist）

| 能力 | v1 | 说明 |
| --- | --- | --- |
| `db` | ✅ 参数化 CRUD + `metaGet/metaSet` | 无 `path` / `request` / `backup` / 裸 SQL；迁移由宿主按 DDL 白名单执行 |
| `kv` | ✅ 本插件命名空间 | |
| `config` | ✅ async get/set/all/onChange | 受 `configSchema` 校验 |
| `secrets` | ✅ 本插件命名空间 | 仅 key 列表，不返回宿主密钥 |
| `notifications` | ✅ 仅标题/正文 | |
| `openclaw` | ✅ 仅模型调用 | 会话键由 broker 重写为 `conv:plugin:<id>:*`；不返回 port/baseUrl；不可发渠道 |
| `http` | ✅ 宿主代理 + 域名白名单 | 直连网络不可强制，见 0.2 |
| `dialog` | ✅ 仅 `pickFile` | 不暴露 BrowserWindow/ipcMain |
| `host` | ✅ `version`/`platform` | 不含 `dataDir/paths`（仅官方 internal） |
| `jobs` / `logger` / `registerIpc` / `onDispose` | ✅ | |
| `consent` / `abort` / `hostOps` / `legacyDb` / `ctx.host.dataDir/paths` | ❌ | 仅官方 internal |
| `registerChannelIpc` | ❌ v1 | 第三方用 `registerIpc`（`plugin:<id>:*`），不租历史命名空间 |

### 2.3 信任模型

| 类型 | 运行位置 | 信任级别 | 权限 |
| --- | --- | --- | --- |
| 官方内置插件 | 主进程 | 可信 | 现有契约 + Node 权限 |
| 第三方插件（v1） | `utilityProcess` + Node permission model | **受控/可审核** | allowlist + manifest 授权 |
| 第三方 UI（Phase 3） | sandboxed iframe | 不可信 | postMessage 能力桥 |

---

## 三、Phase 0：隔离前提 + 契约冻结 + 官方插件吃狗粮（9–13 周，单人；部分 WP 可并行到 6–8 周）

> 对抗审查 P0-1：**B0 必须与 A1 并行，不能排到第 4 周**。A1 先出 v1-RC，B0 ADR 通过后再冻结。

| WP | 工作 | 产出 | 验收 | 预估 |
| --- | --- | --- | --- | --- |
| A0 | **基线冻结与文档契约修订** | 基线 commit/分支；干净 `test/.tmp`；TEMP 说明；双 typecheck + accept + boundary 留档；AGENTS/PLAN-4.0 修订（§10） | 基线可复现；数字单一来源；文档修订单独提交 | 1–2 天 |
| A0b/B0 | **隔离 spike（与 A1 并行，时间盒 1 周）** | utilityProcess：CJS/ESM 入口、Node permission model（fs/child_process）、TCP 残余风险、崩溃/重启、MessagePort 性能；ADR | ADR 通过才能冻结 API；负向测试可复现 | 1 周 |
| A1 | **API v1-RC** | `doc/PLUGIN-API.md`：公开面 allowlist、async 规则、事件/流 RPC、DB/迁移白名单、权限 manifest、SDK 注入、版本/弃用 | 评审通过；B0 ADR 后升 v1-final | 5–7 天 |
| A2 | **SDK 抽取（三层）** | `plugin-sdk/`：`public` / `official` / `client` / `testing` 子路径；alias + build + 注入机制（当前仅骨架，alias/注入/ratchet 待 A3b 前完成） | 只做骨架/alias/门禁：`pluginHostImport`（65 值 + 15 type = 80 行 / 39 文件）、`pluginUiHostImport`（23 运行时 + 3 类型）、`hostBridgeConsumers`（12）三套独立 ratchet；迁移交 A3b/A6 | 8–10 天 |
| A3a | **kernel/API 收敛** | async 化、onDemand、settings/commands、capabilities、voice、migrations、`ctx.host` 拆公开/内部、hostBridge、raw ipcMain、`db.request`、宿主反向读库、gen 清理、通道租约 | 每项有断言；boundary 绿；无行为回归 | 8–10 天 |
| A3b | **官方插件迁移** | 80 行 host import / 39 文件；23 处 `@/` UI import（含 `useAgreementGate`/`useWizardGate` 单例风险） | 分小批；每批 accept 绿；UI 行为不变 | 8–10 天 |
| A4 | **兼容元数据与状态 schema** | `apiVersion` / `engines.host`；状态文件 schema 版本；不兼容拒绝 | 老状态可迁移；错误码明确 | 2–3 天 |
| A5 | **契约测试/模板** | `test/plugin-contract.accept.mjs`；`templates/plugin/`；注册进 run-all | 模板可跑；契约测试覆盖 v1 公开面 | 3–5 天 |
| A6 | **官方插件收尾** | work/marketing/hello 全部走 SDK；文档/迁移指南 | 0 条非 SDK 宿主 import（UI 仅 4 处 ConfirmDialog `.vue` 例外）；accept 绿 | 5–8 天 |
| A7 | **文档与培训** | 插件开发/发布/API 变更记录 | 评审通过 | 2 天 |

### 3.1 A3a 明细（v1.1 修订）

1. **async 化**：**第三方可见面** async（`config`/`notifications`/`hostOps` 的 public 包装）；官方 in-process internal 可保留同步，Phase 0 不强制迁移；Phase 1 前再决定是否统一。同步面至少 4 API/6 调用点。
2. **事件/流式 RPC**：9 处 `handleEvent` 依赖 `event.sender`；第三方不得拿 Electron event；插件流通过 supervisor 的事件通道投递。
3. **`onDemand`**：真懒激活或删除；删除会影响 `plugin.accept` P18。
4. **`contributes.settings` / `commands`**：补消费或删字段。
5. **`capabilities` 与 `inject` 合并**：allowlist；工作插件声明但不 inject 的能力要能解释。
6. **`voice`**：补工厂或移除类型；不留给第三方。
7. **`migrations`**：字段与实现对齐；第三方迁移只允许 `CREATE TABLE/INDEX`、`ALTER TABLE ADD COLUMN`，禁 `ATTACH/PRAGMA/VACUUM/INSERT` 等；宿主执行前白名单校验。
8. **`ctx.host` 拆分**：公开 `version/platform`；`dataDir/paths` 仅官方 internal。
9. **`hostBridge` 收窄**：只暴露按插件 id 的 `invoke`；`hostUi.ts` 的裸 `ipcMain`/`dialog` 收 internal；SDK 提供 `dialog.pickFile`（写入 §2.2 allowlist 与附录 A）。
10. **删原始 `ipcMain` 兜底**：`work.ts` 的 `defaultRegistrar` 仅测试可用。
11. **`ctx.db.request`**：第三方不可见；官方只允许 `<table>.<op>` 白名单（**必须含 `<table>.upsert`**，`pluginDataImport` 在用），禁 `migrate`/`maintenance.vacuumInto` 任意路径。
12. **宿主反向读插件库清零**：`index.ts` 的 `conversation_key`、`consent.ts` 的 `wizard_consent` 改为插件注册 provider；注意 consent 在插件激活前/停用后仍需可读（U27）。
13. **通道租约**：work 76 条租约通道（P37 实测）；marketing 通道 A3a 前重新统计；第三方不租历史命名空间；宿主只保留 `work:gateway:*` 这一套。
14. **gen/三份真相**：清理已删插件的 `resources/plugins/<id>`；生成表/清单/state 一致性校验。
15. **插件 id 保留字与数据根**：官方数据根 `<dataDir>/plugins/<id>/`；第三方 `<dataDir>/plugin-data/<id>/`（隔离，防止卸载/删除碰官方数据）；保留 id（host/plugin/system/...）；覆盖「删除全部数据」、宿主备份、卸载导出。
16. **门禁扩容**：renderer 插件→宿主 `src/**`；`plugins/**` 的 `node:fs`/`node:child_process`/裸 electron；`templates/`、`plugin-sdk/` 纳入 typecheck。

### 3.1.1 A3a 实施状态（2026-11-13）

已落地（有断言/测试）：
- migrations DDL 白名单（CREATE TABLE/INDEX/ALTER ADD COLUMN + 黑名单；STRICT 可解析）
- `ctx.db.request` 白名单（表级 CRUD + `knowledge.search`；禁 migrate/maintenance/shutdown）
- gen 清理已删插件的 `resources/plugins/<id>`（空插件列表不清）
- host→plugin 反向依赖：会话键 resolver 注册表（marketing activate 注册、onDispose 摘除）
- 删除 work 插件原始 `ipcMain` fallback、`hostUi` 不再导出裸 `ipcMain`
- `scripts/check-plugin-api.mjs` + baseline + `test/plugin-api.accept.mjs`（ratchet 已注册 run-all）
- 验收：47 套 / 854 项 + node:test 21（当时基线，全绿）

未完成（下次 A3a 续）：
- 第三方可见面 async 化 + 事件/流式 RPC（依赖 B1）
- `onDemand` 真懒激活；`contributes.settings/commands` 消费
- `capabilities` 与 `inject` 合并；`ctx.host` 公开/内部拆分
- `hostBridge` 收窄与 UI 宿主 import 收敛（23 处）
- consent 的 host→work 插件库反向读（登记，A3b 处理）
- `knowledge.search` 在 marketing 插件库的 pre-existing 缺口（单独修）

### 3.1.2 A3b 官方插件迁移（2026-11-13）

- 79 处 `electron/main/**` import / 38 文件已迁到 `plugin-sdk/src/official-*`（按宿主模块拆子路径，避免 barrel 把 mammoth/electron 链进 domain bundle）。
- `check-plugin-api` ratchet：**host import 0**（值 0 / type 0）；UI host import 23→4（+2 type；4 处 ConfirmDialog .vue 直连属测试管线例外）；hostBridge consumers 13（useWorkStream 移入插件后必须经 hostBridge；官方 UI 内部，Phase 1 前不动）。
- 未完成：UI 的 `@/` 宿主 import 仅剩 4 处 ConfirmDialog（等 UI 测试管线支持跨 .vue 或组件下沉）；hostBridge 收窄/下沉留 Phase 1；`@umi/plugin-sdk/*` alias/宿主注入（B1）。
- 验收：plugin.accept 71/71、plugin-contract 3/3、plugin-api 3/3、ui 28/28、build 通过；全量 accept 47 套/854 项（当时基线）全绿（含启动级 E2E）。

### 3.1.3 A4/A5 兼容与契约（2026-11-13）

- A4：`apiVersion`（缺省 1，<= HOST_API_VERSION）+ `engines.host` 范围解析/注册期拒绝；`plugins-state.json` v1 wrapper（旧 flat 兼容）。
- A5：`templates/plugin/`（manifest/main/migrations/README）+ `test/plugin-contract.accept.mjs`（3 项），已注册 run-all。
- 官方 plugin.json 加 `apiVersion: 1`；契约测试验证模板只依赖 public SDK、activate→IPC→jobs→dispose 全链路。
- 剩余：第三方权限/configSchema（A3a/B2）、N/N-1 兼容矩阵（Phase 1）。

### 3.1.4 B0 ADR 定稿（Phase 0 出口评审）

> 来源：`data/tmp/analysis/b0-isolation-adr.md` 的 spike 结论 + Phase 0 收尾评审。状态：**定稿**（2026-11-13）。

| # | 决策 | 依据 / 残余风险 |
| --- | --- | --- |
| B0-1 | 第三方插件运行时 = **Electron `utilityProcess`，单插件单进程**；官方插件继续 in-process | Electron 30.5.1 / Node 20.16 实测；启动 140–180ms、IPC <0.5ms、RSS 45–50MB |
| B0-2 | **不是沙箱**：隔离目标是「故障/权限收敛 + 可审计」，不是对抗恶意代码 | Node 权限模型只覆盖 fs/child_process/worker/native；TCP 与 `process._linkedBinding` 仍可绕过 |
| B0-3 | 权限只走 `env.NODE_OPTIONS`（`execArgv` 无效）；`--allow-fs-read` 必须含插件入口目录；子进程 env 显式白名单 | spike 实测；B2 实现 |
| B0-4 | 入口 **CJS canonical**；ESM 通过 CJS `import()` 动态加载 | Node 20.16 下 utilityProcess + ESM 入口兼容性不稳，CJS 最稳 |
| B0-5 | 崩溃检测：监听 `UtilityProcess.exit` + 心跳；**不使用 `child-process-gone`**（对 utilityProcess 不触发）；状态机 `stopped/starting/running/stopping/crashed/disabled`，退避 1/2/4s，5min≥3 次熔断，配置/权限错误直接 disabled | B1 实现；B0 spike 证据 |
| B0-6 | v1 **不开放第三方 UI**（schema 设置页除外）；第三方网络请求**不做强制拦截**，在授权页/文档明示残余风险 | 与 §0.2 边界一致 |
| B0-7 | feature flag `UMI_PLUGIN_ISOLATION=1` 显式开启，默认 off；关闭时行为与 4.3 完全一致 | B5 + Phase 1 出口 |

Phase 0 出口评审：B0 ADR 通过 → API v1-final 冻结（后续不兼容变更升 major）。
评审记录（2026-11-13）：事实核对（`phase0-factcheck.md` / `phase0-factcheck-a3a.md`）与对抗复核（`phase0-adversarial.md`）；正式结论以本节为准，证据文件仅作复现附件（`data/` 不入库）。
冻结范围**仅官方内置插件**：4.x 没有第三方发现/安装路径，kernel 仍向 built-in 注入全部服务；第三方 trust/权限/隔离在 Phase 1 落地，不属于 v1 已冻结承诺。

### 3.1.5 Phase 0 范围裁剪与 Phase 1 交接（诚实清单）

Phase 0 的目标是「官方插件吃狗粮 + 契约/兼容/契约测试」；以下计划项**未在 Phase 0 完成**，明确移交 Phase 1，不阻塞 4.3.0：

- A2：`@umi/plugin-sdk/*` alias / build external / 宿主注入机制未做；仓内插件暂用相对 `plugin-sdk/src/*` 路径（迁移本身已完成）。
- A3a 剩余：async/事件流 RPC、`onDemand`、`contributes.settings/commands` 消费、`capabilities`/`inject` 合并、`ctx.host` 公开/内部拆分、hostBridge 收窄（13 consumers）、consent host→work 反向读、marketing `knowledge.search` 缺口、数据根统一 `<dataDir>/plugins/<id>/`/保留 id。
- A6：host import 0；UI 仅 4 处 ConfirmDialog `.vue` 直连（`.ts` SDK 无法 re-export SFC；由 ratchet 锁死，不再新增）。
- A7：文档/PLAN/AGENTS 已评审；4.3.0 **只升版本号，未生成 tag/安装包**（发布产物待用户真机验收后出）。
- 门禁扩容（`plugins/**` 的 node:fs/child_process、templates/plugin-sdk typecheck）与 SDK 内部 host import 白名单已部分落地；完整负向门禁随 Phase 1 B2/B4。

### 3.2 Phase 0 出口判据

- [x] 基线（分支/commit/命令/TEMP）可复现：`codex/voice-local-external-conversation`，4.3.0 收尾 commit（见 PROGRESS 2026-11-13 条目）；`TEMP=%LOCALAPPDATA%\Temp` + 清 `test/.tmp`；`node scripts/run-all-accept.mjs` 留档；accept 全绿
- [x] 双 typecheck 0 错；boundary 0/0/0 且扫描 2 个域目录（非空）
- [x] 官方插件 0 条非 SDK 宿主 import（host 0/0）；UI `@/` 仅 4 处 ConfirmDialog `.vue` 例外（`.ts` SDK 不能 re-export SFC；ratchet 锁死，不再新增）
- [x] `plugin-contract.accept.mjs` 注册进 run-all，覆盖 v1 公开面（模板 manifest/依赖面/activate→IPC→jobs→dispose）
- [x] API v1 官方面冻结：B0 ADR §3.1.4 定稿、`PLUGIN-API.md` 标 v1.0；permissions/configSchema/async/onDemand 明确列 Phase 1 增量，不改已冻结签名
- [x] 用户可见行为不变：现有 accept 全绿 + **启动级 E2E**（`test/startup.e2e.mjs` 真 Electron whenReady）+ one-day e2e 真 Worker；ui.accept 是 mock，不单独作证

**Phase 0 出口评审**（2026-11-13）：事实核对 + 对抗复核两份独立报告（`data/tmp/analysis/phase0-*.md`）；代码/验收达标；出口文档、4.3.0 基线、启动级 E2E、API 冻结口径已按意见补齐。**通过。**

---

## 四、Phase 1：隔离与权限原型（12–16 周）

> 对抗审查 P0-2/P0-5：utilityProcess 不是沙箱；B1 前必须确认权限模型与 CJS/ESM 入口；崩溃恢复要有状态机。

| WP | 工作 | 产出 | 验收 | 预估 |
| --- | --- | --- | --- | --- |
| B1 | **插件进程骨架** | supervisor、child entry（CJS canonical；CJS 可 `import()` ESM）、RPC、ctx 代理、生命周期、日志隔离、崩溃状态机（`stopped/starting/running/stopping/crashed/disabled`；退避 1/2/4s，5min≥3 次熔断；配置/权限错误直接 disabled 不重试；监听 `UtilityProcess.exit` + 心跳，不依赖 `child-process-gone`） | hello 子进程 activate/deactivate；崩溃/死循环可恢复；宿主不动 | 3 周 |
| B2 | **权限模型** | manifest allowlist、授权 UI、broker、审计、撤销；**只走 `env.NODE_OPTIONS` 注入**（禁 `execArgv`）；`--allow-fs-read` 必须含插件包入口目录；子进程 env 显式白名单 | 未授权调用 `PLUGIN_PERMISSION_DENIED`；撤销立即生效；缺 allowlist 时入口加载失败可见 | 3 周 |
| B3 | **服务桥接** | db（宿主托管）、openclaw（会话命名空间 + 模型代理 + 配额）、config、notifications、secrets、kv、http（域名白名单）、dialog.pickFile | 示例插件全链路；拿不到宿主路径/密钥/渠道/其他插件数据 | 3 周 |
| B4 | **安全与性能** | 负向测试：越权 fs、读别的插件、spawn、worker/native、env 泄漏、**直连 net（预期仍成功，记录残余风险）**、`_linkedBinding` 残余、恶意 configSchema、死循环 | 可拦的拦住；不可拦的写清残余风险；宿主存活；单进程启动中位 ~140–180ms、IPC <0.5ms、RSS ~45–50MB | 2 周 |
| B5 | **开发者模式** | `UMI_DEV_PLUGINS=1` + `UMI_DEV_BUILD=1`；打包版即使设 env 也拒绝 | 打包版拒绝；dev 有显式风险提示 | 1 周 |

### 4.1 Phase 1 出口判据

- [x] 第三方样例在 utilityProcess 跑通（`plugin-isolation.e2e`）；官方插件仍 in-process，accept 绿
- [x] fs/child_process/worker/dlopen 越权被拦（B4 真机）；网络残余风险写入 B0 ADR/权限提示
- [x] 崩溃/心跳 hang/启动失败有状态机与 disabled 安全态（B1/B4）
- [x] feature flag 默认 off，关闭时行为与 4.3 一致（B1 I7/I8 + 全量回归）

> 口径限定（2026-11-14 独立检查）：item1 是 `UMI_ISOLATION_PROBE` 测试探针的 utilityProcess E2E，**不是生产 installer 已启动 supervisor**；item4 是默认 off 且关闭路径不变，flag on 的生产接线、dev 读根收窄、junction 拒绝、生产 installer 均登记 Phase 2。不得对外表述为“生产隔离已上线”。

### 4.2 B1 实施状态（2026-11-13）

- `pluginProcessProtocol.ts`：JSON RPC（init/activate/deactivate/ping/invoke/shutdown → ready/activated/result/pong/log），两端 type guard。
- `pluginProcessChild.ts`：CJS canonical 子进程入口；Node-only（Electron `process.parentPort` / Node `process.send` 双 transport）；`ctx` 最小面（logger/host/config/jobs/registerIpc）；activate/dispose/错误退出。
- `pluginSupervisor.ts`：`stopped/starting/running/stopping/crashed/disabled`；`exit` 监督（不依赖 `child-process-gone`）；心跳 ping/pong；启动失败 disabled；退避 1/2/4s；5min≥3 次熔断。
- `pluginIsolation.ts`：`UMI_PLUGIN_ISOLATION=1` 显式开启，默认 off；`pluginRuntime.isolationEnabled()` 暴露但**不 fork**（B2/B3 服务桥后启用）。
- 构建：electron-vite main 双入口，`dist-electron/main/pluginProcessChild.js`（6.9KB）。
- 验收：`test/plugin-isolation.accept.mjs` 17/17（状态机、崩溃/熔断、心跳 hang、pong id、stale generation、disabled/reset、真 Node child 协议、parentPort MessageEvent、flag off）。
- 未完成（B2/B3）：真实 `utilityProcess.fork` 接线、权限 allowlist、服务代理；B1 只冻结协议与状态机。

### 4.3 B2 实施状态（2026-11-13）

- manifest `permissions`：`fs.read` / `fs.write` 相对路径（禁绝对路径/`..`）、`network`（精确/`*.` 通配）、`services`；未知键/非法值 **fail-closed**。
- 授权存储 `<dataDir>/plugin-permissions.json`（schema v1，坏文件按未授权）；`plugin:permissions:list/grant/revoke` IPC；grant **只授予 manifest 已申请权限**，UI 不能扩权；`PluginManager.vue` 增加权限提示/授权/撤销按钮。
- broker：默认拒绝；fs 读含插件包目录，写只允许 dataDir 子路径；network/services allowlist；每次判定写 `<dataDir>/plugin-audit.log`（无 payload/密钥）。
- `NODE_OPTIONS` 注入 `--experimental-permission --allow-fs-read=<包目录,申明读路径> --allow-fs-write=<申明写路径>`；子进程 env 白名单（PATH/SystemRoot/TEMP/TMP/LANG/TZ；**不含 HOME/USERPROFILE/APPDATA**），**不透传宿主 dataDir/API key/云密钥**。
- 测试：`test/plugin-permissions.accept.mjs` 10/10（manifest/store/broker/audit/env/空格路径真 Electron/损坏 grant）。
- 未完成（B3/B4）：真实 `utilityProcess` 启动时接 env；服务调用 broker 接入；越权负向用例；撤销后进程重启语义。

### 4.4 B3 实施状态（2026-11-14）

- 协议新增 `service`/`service-result`；child `ctx.services` 为 Proxy，调用转发到宿主；supervisor `onService` 回包。
- `pluginServiceBridge`：先过 B2 broker（未授权 `PLUGIN_PERMISSION_DENIED`），按 method 调宿主 serviceFactories；未知服务/方法/危险属性 NOT_FOUND；AppError 跨 bundle 按 code 透传。
- `createUtilityProcessFork`：真实 `utilityProcess.fork` + cwd + 权限 env；`pluginRuntime.callPluginService` 接线。
- 真机 E2E：`plugin-isolation.e2e` 启动真实 Electron，utilityProcess 加载 fixture，插件 `ctx.services.kv.get` 经宿主返回，invoke 成功。
- 测试：`plugin-service-bridge` 8/8；`plugin-isolation.e2e` 1/1；全量 51 套/888 项（887 通过 + 1 显式跳过）。
- 未完成（B4/B5）：事件流 RPC、HTTP/dialog/secrets 完整代理、越权负向、性能、开发者模式。

### 4.5 B4 实施状态（2026-11-14）

- 真机负向（真实 Electron utilityProcess + permission env）：fs 越界读 host secret `ERR_ACCESS_DENIED`；`child_process.execSync` / `worker_threads` / `process.dlopen` 被拒；宿主 `UMI_SECRET_SENTINEL`/`HOME`/`CLAW_DATA_DIR` 不传，PATH 保留。
- child 服务调用超时 `serviceTimeoutMs`（默认 30s）可注入；supervisor `onService` 也有超时；S7/S8 验证不回包时按 `PLUGIN_OPERATION_FAILED` 失败。
- Electron bootstrap 只读根：child 入口目录、resources、dist、app path；app path 仅 dev 必需，安装期收窄待 Phase 2。
- 测试：`plugin-service-bridge` 8/8；`plugin-isolation.e2e` 1/1（负向断言内置）；全量 51 套/890 项（889 通过 + 1 显式跳过）。
- 未完成（B5/Phase 2）：开发者模式、生产 installer 启动 supervisor、事件流/HTTP/dialog、性能上限。

### 4.6 B5 实施状态（2026-11-14）

- `devMode.ts`：`UMI_DEV_PLUGINS=1` 才开 plugins，`UMI_DEV_BUILD=1` 且 plugins 开才开 build；**打包版即使设 env 也拒绝**。
- 接线：`plugin:dev-mode`（`{ok,data}` 信封）+ preload `plugins.devMode()` + 管理页风险横幅。
- 本批只做闸门与提示，不扫描/不加载 dev-plugins、不新增安装入口；扫描/源码构建留 Phase 2。
- 测试：`plugin-dev-mode` 4/4；全量 54 套/940 项（939 通过 + 1 显式跳过）。
- 未做/登记：UI 横幅可达性无 E2E；dev-plugins 扫描/源码构建 Phase 2。

### 4.7 Phase 2 起点提醒

---

## 五、Phase 2：包格式、安装/更新/回滚、兼容（16–20 周，单人；部分 WP 可并行）

| WP | 工作 | 产出 | 验收 | 预估 |
| --- | --- | --- | --- | --- |
| C1 | **包格式与签名** | `.umi-plugin` zip；`plugin.json` + `main.js` + `migrations/` + icon + `SIGNATURE`（keyId/alg）；`umi-plugin pack`；官方/伙伴/自签 TOFU；宿主 keyring/吊销列表（不入包）；宿主自身代码签名进发布清单 | 签名失败拒绝；TOFU 指纹确认/变更告警；keyring/吊销可查；zip-slip/bomb 防护 | 3 周 |
| C2 | **安装/卸载/更新/回滚** | 侧载文件/URL；原子安装；版本目录；**二进制 + 数据快照回滚**（范围：db/kv/secrets/config；时点：升级前；保留：最近 N 份；恢复顺序：停插件→WAL checkpoint→还原→迁移校验）；卸载保留/导出数据；安全模式 | 安装→启用→更新→回滚全链路；数据不丢；快照可校验 | 3–4 周 |
| C3 | **兼容与状态** | 兼容矩阵；状态 schema 迁移；弃用告警 | 不兼容拒绝；N/N-1 测试 | 2 周 |
| C4 | **静态目录** | 签名 JSON 索引（官方/伙伴）；更新检查；吊销列表 | 无市场入口；可离线校验 | 1–2 周 |
| C5 | **测试与文档** | 安装 e2e、打包冒烟、安全审查、用户文档 | 5.0.0-beta.2 清单全绿 | 2 周 |
| C6 | **第三方设置页** | `configSchema` 子集渲染（类型/默认值/label/枚举；禁任意 HTML；深度/大小/正则上限）；A1 定义 `permissions` 与 db/config/openclaw 的服务映射 | 恶意 schema 不执行代码；设置可读写；未授权服务不可见 | 2 周 |
| C7 | **UI 可行性 spike** | 1 周 iframe/sandbox 评估：主题 token、路由回退、插槽、postMessage、性能 | 决定 Phase 3 是否继续/缩小 | 1 周 |
| C8 | **运营最小集** | 插件日志落盘/脱敏/PII 保留期、崩溃计数、安全模式、kill switch/吊销（来源：C4 签名索引 + 本地吊销名单）、崩溃归因 | 5.0-beta 出事故可禁用/回滚 | 2–3 周 |

### 5.0 执行顺序与 P0 契约冻结（2026-11-14 已拍板）

**已批准**：发布者三档（official / partner / self-TOFU）；keyring 本地存储，不接外部服务；版本节奏 `alpha.1 → alpha.2 → beta.1 → beta.2 → GA`；**冻结原则**：本 P0 契约冻结后，C1–C8 只按本契约实现，不再改包格式/信任/路径语义；签名 canonical 与包格式由 C1 的 golden vector/契约测试固化。

**执行顺序（先地基后功能）**：

1. **P0 契约冻结**（本批）：来源模型、包格式、信任模型、路径布局、状态 schema。
2. **P1 生产隔离接线**：`pluginRuntime` 真正管理 supervisor，isolated 生命周期；验收 fixture 走 runtime，不再只走测试探针。
3. **P2 安全边界补洞**：授权更新求交、撤销重启、junction/reparse、dev 读根收窄、服务桥能力面、invoke 错误码。
4. **C1 包格式与签名** → **C2 安装/卸载/更新/回滚**。
5. C3（兼容/状态）、C6（设置页）、C4（静态索引）、C8（运营）并行；C5（测试/文档）最后收口；C7（UI spike）并行但不阻塞。
6. GA 收口：安全审查、签名证书、干净机器矩阵、回滚/kill switch 演练。

**版本门**：

| 版本 | 触发 |
| --- | --- |
| 4.4.0-dev | Phase 1 完成（已封版 ac59459） |
| 5.0.0-alpha.1 | P0 契约 + P1 隔离 runtime 接线 + P2 安全基线（C2 语义残余登记） |
| 5.0.0-alpha.2 | C1 签名包绿 |
| 5.0.0-beta.1 | C2 安装/更新/回滚绿（切 `release/5.0`） |
| 5.0.0-beta.2 | C3/C4/C6/C8/C5 出口全绿 |
| 5.0.0 GA | 安全审查/发布清单绿 |

**P0 契约冻结**：

1. **来源与生命周期**
   - `PluginRuntimeKind = 'builtin' | 'isolated'`；官方插件永远 `builtin`，第三方永远 `isolated`。
   - 安装态记录：`{ id, version, packageDir, dataDir, trustLevel, keyId, status, installedAt, updatedAt }`。
   - 状态沿用 `stopped/starting/running/stopping/crashed/disabled`；安装态新增 `installing/broken` 由 C2 使用。
2. **包布局**（`.umi-plugin` = zip，根目录即包根）
   - 必选：`plugin.json`、`main.js`、`SIGNATURE`；可选：`migrations/`、`icon.png`、`README.md`。
   - 禁止：`node_modules/`、`.git/`、绝对路径、`..`、反斜杠路径、符号链接/junction、重复/大小写折叠冲突条目。
   - `plugin.json` 在 v1 基础上扩展（不破坏官方 v1）：`id/version/name/apiVersion/engines/permissions/configSchema`；签名相关字段只放 `SIGNATURE`，不进 manifest。
3. **签名格式（Ed25519）**
   - `SIGNATURE` JSON 固定字段：`{schema:1,keyId,alg:"ed25519",createdAt,files:[{path,sha256}],publicKey?,signature}`。
   - 签名原文 = `JSON.stringify({schema,keyId,alg,createdAt,files})`，字段顺序固定为上述顺序；`files` 按 `path` UTF-8 升序；无空白；UTF-8 无 BOM；`createdAt` 为 ISO-8601 UTC（`YYYY-MM-DDTHH:mm:ss.sssZ`）；`sha256` 小写 hex；`signature` 标准 base64。
   - `files` 必须**精确覆盖** zip 中除 `SIGNATURE` 外的全部条目（不允许未列出的额外文件）；`SIGNATURE` 自身不参与哈希。
   - `publicKey`：official/partner 包可省略（由 keyring 按 keyId 解析）；self 包必须携带 SPKI DER 的 base64；TOFU fingerprint = `sha256(SPKI DER)` 小写 hex。
   - 验签前做 zip-slip/bomb/大小/数量/重复条目检查；解压/加载只使用签名 `files` 列表，不信任 zip 元数据（external attrs/压缩方式/mtime/目录项）。
4. **信任模型**
   - 三档：`official`、`partner`、`self`；未签名包仅 dev 加载（由 C2 实现；B5 仅闸门，不扫描/不加载）。
   - 本地 keyring：`<dataDir>/plugin-keys.json`（keyId→SPKI/等级/fingerprint）；吊销：`<dataDir>/plugin-revocations.json`。
   - official/partner 根公钥随包：`<resources>/plugin-keys/<keyId>.json`；轮换由 C4 签名索引发布，不联网拉取。
   - 自签 TOFU：`<dataDir>/plugin-trust.json` 记录 fingerprint firstSeen/lastSeen；首次确认后指纹变更必须二次确认。
5. **路径布局**
   - 官方 builtin：包 `<resources>/plugins/<id>/`（不参与安装器）；第三方包：`<dataDir>/plugin-packages/<id>/<version>/`（版本目录不可原地修改）。
   - 数据：官方 `<dataDir>/plugins/<id>/`；**第三方 `<dataDir>/plugin-data/<id>/`**（与官方命名空间隔离，卸载/删除不会碰官方数据）。
   - 快照：`<dataDir>/plugin-backups/<id>/<timestamp>/`（默认保留最近 5 份）；安装态：`<dataDir>/plugin-install-state.json`。
   - **child 入口与权限注入**：实际启动入口用宿主 app 内 `pluginProcessChild.js`（Electron utilityProcess 不能从 dataDir 外部入口启动）；安装时复制一份到 `<dataDir>/plugin-runtime/<hostVersion>/` 作备份/诊断。权限用 **`NODE_OPTIONS` + 相对 cwd（child 入口目录）** 注入；`execArgv` 在 Electron 30 utilityProcess 下实测不生效。已知限制：路径中含空格的 dataDir/用户名无法注入，显式抛 `PLUGIN_PERMISSION_CONFIG_INVALID`（不降级放行）。
   - 所有路径解析后必须 `realpath` 校验在允许根内；reparse point 在安装期拒绝。
6. **权限与状态**
   - `permissions` 只允许公开服务 `db/openclaw/notifications/config/kv/secrets/voice`；`http/dialog` 在 C6 实现后再追加；`consent/abort/hostOps/legacyDb` 永不对第三方开放。
   - 授权只能收窄：升级时新 grant = 旧 grant ∩ 新 manifest；新增权限必须重新授权；撤销后 C2 停/重启进程。
   - 状态：既有进程六态不变；安装态 `installing/broken`；`PluginStatus` 增加 `runtimeKind/trustLevel/keyId`（只读展示），现有 `source`（manifest 路径）语义不变。
   - 安装/更新/回滚/卸载全部写审计；密钥/密码不落盘明文。
   - **4.x 边界**：P0/C1–C8 只在 5.0 分支生效；4.x 不扫描第三方包、不提供安装入口、不加载未签名代码。

### 5.1 Phase 2 出口判据

### 5.1 Phase 2 出口判据

- [ ] 官方/伙伴签名包可安装/更新/回滚/卸载；自签包需 TOFU 指纹确认；未签名包仅 dev 可加载
- [ ] 回滚同时覆盖二进制与数据快照（或明确声明向前兼容）
- [ ] 不兼容包明确拒绝；吊销列表生效
- [ ] 设置页只渲染 schema，不执行任意代码
- [ ] 5.0.0-beta.2 干净机器安装/卸载冒烟

---

## 六、Phase 3：UI 隔离与市场（后置）

- D1：第三方 UI 走 sandboxed iframe + postMessage 能力桥；主题/路由/插槽/性能单独评估。
- D2：公共市场、发布者身份、审核、下架、安全公告。
- D3：`umi plugin dev` CLI、dev-only HMR。
- D4：OS 级隔离研究（网络/文件），不进入 5.0 承诺。

> 开始条件：Phase 2 稳定 ≥1 个版本 + 明确的第三方 UI 需求 + C7 spike 结论。

---

## 七、里程碑与日程（v1.1 修订，估算 ×1.5–2）

| 里程碑 | 内容 | 版本 | 预估（1 人） |
| --- | --- | --- | --- |
| M0 | 基线冻结 + 文档契约修订 | — | 3–5 天 |
| M1 | Phase 0 完成：API v1 + SDK + 官方插件 | 4.3.0 | 9–13 周（可并行到 6–8 周） |
| M2 | Phase 1 完成：隔离/权限原型（flag off） | 4.4.0-dev | 12–16 周 |
| M3 | Phase 2 完成：签名包 + 侧载 + 设置页 | 5.0.0-beta.2 | 16–20 周 |
| M4 | 5.0.0 GA：安全审查 + 运营最小集 + 回滚预案 | 5.0.0 | 2–3 周 |

> 总工期（单人）：约 9–12 个月到 5.0.0-beta；2 人并行可压到 6–8 个月。估算按 WP 人天相加 + 审查/回归 buffer。

**头 3 周排期**：

1. 第 1 周：A0 基线；A1 v1-RC 起草；B0 spike 并行（时间盒 1 周）。
2. 第 2 周：B0 ADR；A1 冻结；A2 SDK 三层骨架 + 门禁 ratchet。
3. 第 3 周：A3a 第 1 批（async/事件 RPC/db 白名单）；A0 文档修订提交。

---

## 八、质量门禁与数字口径

| 门禁 | 内容 |
| --- | --- |
| typecheck | `npm run typecheck:node` / `typecheck:web` |
| 回归 | `npm run accept`；**TEMP 指向系统临时目录 + 清理 `test/.tmp`**；结果留档 |
| 边界 | `npm run check:boundary`（0/0/0，扫描目录非空） |
| 契约 | `test/plugin-contract.accept.mjs`（注册进 run-all） |
| 安全 | `test/plugin-security.accept.mjs`（Phase 1 起） |
| 打包 | `npm run build` + packaged smoke |
| 审查 | AGENTS §12：每 commit 对抗审查；每 WP 两次独立检查 |

**数字口径**：2026-11-13 干净基线（codex/voice HEAD，TEMP 指向系统临时目录 + 清空 `test/.tmp`）：**54 套**（ACCEPT 50 + e2e×4 + smoke）、accept result **940 项（939 通过 + 1 显式跳过）** + `node:test` **21 条** = **953**。AGENTS/RUNBOOK 已同步该口径（2026-11-14 Phase 1 收尾）；release/4.0 在 voice 合并后复核。后续以每次留档为准。

---

## 九、风险登记（v1.1 新增）

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| API 冻结早于隔离验证，契约返工 | 高 | B0 提前并行；A1 v1-RC；ADR 通过才冻结 |
| utilityProcess 不是安全沙箱 | 高 | v1 定位受控第三方；fs/child_process 用 Node permission model；网络残余风险入 ADR |
| 插件 migrations 任意 SQL/ATTACH/VACUUM | 高 | DDL 白名单；第三方无 `db.request/path/backup`；迁移前备份；断言 |
| 签名信任不闭合/宿主无代码签名 | 高 | keyId/keyring/吊销；C1 前定发布者模型；宿主签名进发布清单 |
| 基线不可复现/并发 accept 互踩 | 高 | TEMP + `test/.tmp` 清理；结果留档；CI 单跑 |
| 官方插件 80 import/39 文件 + 23 UI import 迁移回归 | 中高 | 三层 SDK + ratchet + 分批迁移；gate 单例单独验证 |
| hostBridge/raw ipcMain 逃生门 | 高 | A3a 封堵；A3b 迁移；门禁 |
| 事件/流式 RPC 设计缺失 | 高 | A1 补契约；B1 实现；9 处 handleEvent 逐条改 |
| 反向读库/consent 时序 | 中高 | 插件注册 provider；保留停用后读路径；U27 |
| 运营/支持空白 | 中高 | Phase 2 C8 最小集；kill switch/吊销 |
| 长分支 diverges | 中 | 短分支 + flag + 分小步合回 |
| 估算偏乐观 | 中 | v1.1 已 ×1.5–2；每 WP 留 buffer |

---

## 十、与现有文档/硬规则的关系（必须显式修订）

| 文档/条款 | 现状 | 本计划修订 |
| --- | --- | --- |
| `PLAN-4.0.md §〇 第2条` | 只做官方内置插件 | 4.x 保持；5.0 起由本计划接管受控第三方 |
| `PLAN-4.0.md §〇 第3条` | 不做第三方安装/市场/签名/审核/沙箱 | 由本计划接管：4.x 仍禁止；5.0 起分阶段开放签名侧载 + 审核/吊销，不做公开市场（v1） |
| `PLAN-4.0.md §〇 第9条` | 不做 permissions/清单哈希/插件沙箱 | 由本计划修订为「allowlist + 权限 broker + 进程隔离 + 签名」，不是沙箱 |
| `PLAN-4.0.md §4.2` | 扁平 `PluginContext` | 拆 public/internal；第三方 allowlist |
| `PLAN-4.0.md §5.1/§5.2` | 构建期装配 | 官方不变；第三方 main 允许隔离进程运行时加载 |
| `PLAN-4.0.md §5.3` | 明确不做通用 `plugin:invoke` 反射桥 | 现行 `window.api.plugins.invoke` 已存在；第三方改为插件绑定通道；本条款需回写 |
| `PLAN-4.0.md §十七-2` | 插件只经 ctx | 保持；新增权限 broker 与 allowlist |
| `PLAN-4.0.md §十七-3` | 渲染端构建期装配 | 第三方 UI 到 Phase 3 iframe；4.x 仍禁止 |
| `AGENTS.md §1` | 只做官方内置插件 | 5.0 起分阶段开放受控第三方 |
| `AGENTS.md §4.2` | IPC 契约 | 增加插件进程 RPC/事件 |
| `AGENTS.md §5.1/§5.2` | 插件形状/边界 | 增加 SDK 三层与权限 manifest |
| `AGENTS.md §7.1` | 验收先断言 | 新 accept 必须注册 run-all |
| `AGENTS.md §9#7` | 禁止新增第三方安装入口 | 5.0 起按本计划约束开放；4.x 仍禁止 |
| `AGENTS.md §12` | 对抗审查 | 全部 WP 沿用 |
| `PLAN-3.0.md` 硬规则 24 | 禁新增状态表 | JSON 状态文件，不新增 DB 表 |
| `doc/PLAN-4.2.md` | 当前欠账 | A3a 与欠账合并排序，不新开平行架构 |

> 修订在 A0 一次完成，单独提交 `docs(4.3)`；正文冻结的 `PLAN-4.0` 只加引用与修订指针。

---

## 十一、待定项与 spike 清单

| # | 待定 | 何时定 | 判据 |
| --- | --- | --- | --- |
| 1 | utilityProcess CJS/ESM 入口 | **B0 实测（ADR 草案待评审）** | CJS canonical；`.mjs`/ESM 可用；CJS 可 `import()` ESM |
| 2 | Node permission model 的 fs/子进程边界 | **B0 实测（ADR 草案待评审）** | `NODE_OPTIONS` 生效、`execArgv` 无效；入口目录必须在 allowlist |
| 3 | 网络残余风险的接受方式 | **B0 实测（ADR 草案待评审）** | 不承诺网络；签名/审核/代理白名单降险；对外不写“沙箱” |
| 4 | 进程粒度：单插件 vs 信任组 | **B0 实测（ADR 草案待评审）** | 单插件单进程；懒激活 + 并发上限 4–6；不做信任组共享 |
| 5 | 第三方 DB 迁移 DDL 白名单 | A1/A3a | 官方迁移全通过 |
| 6 | 签名发布者模型（官方/伙伴/自签） | C1 前 | keyring/吊销可验证 |
| 7 | configSchema 子集与渲染安全 | A1/C6 | 恶意 schema 用例 |
| 8 | iframe UI 可行性 | C7 | spike |
| 9 | 运营最小集（日志/安全模式/吊销） | C8 | 事故演练 |

---

## 附录 A：API v1 公开面（v1.1 allowlist）

```ts
// 第三方可见（async）
interface PluginContextV1 {
  id: string
  version: string
  host: { version: string; platform: string }   // 不含 dataDir/paths
  logger: PluginLogger
  jobs: PluginJobs
  config: PluginConfigApi
  services: {
    db?: PluginDbApiV1        // CRUD + meta；无 path/request/backup
    kv?: PluginKvApi
    secrets?: PluginSecretsApi
    notifications?: NotificationsApi
    openclaw?: OpenClawProxyApi
    http?: PluginHttpApi
    dialog?: PluginDialogApi   // 仅 pickFile
  }
  registerIpc(method: string, handler: PluginIpcHandler): void // 事件/流类型由 A1 定义
  onDispose(fn: () => void | Promise<void>): void
}
```
- 第三方拿不到 `consent/abort/hostOps/legacyDb/ctx.host.dataDir/paths/registerChannelIpc`。
- 事件/流式：`registerIpc` 的响应支持 chunk/done/error 信封；不传 Electron event。
- 会话命名空间：宿主强制 `conv:plugin:<id>:*`。

## 附录 B：manifest v2（草案）

```json
{
  "id": "example",
  "name": "示例插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "host": ">=5.0.0 <6.0.0" },
  "permissions": {
    "data": "own",
    "kv": true,
    "secrets": [],
    "db": true,
    "config": true,
    "openclaw": { "model": true, "channels": [] },
    "notifications": false,
    "http": [],
    "channels": []
  },
  "configSchema": { "type": "object", "properties": {} },
  "activation": ["onStartup"]
}
```

## 附录 C：包格式（草案）

```text
example-1.0.0.umi-plugin (zip)
├── plugin.json
├── main.js            # CJS canonical；ESM（.mjs / type=module）实测可用
├── migrations/        # 可选；DDL 白名单
├── icon.png
└── SIGNATURE          # 签名 JSON（见 §5.0）
<dataDir>/plugin-packages/<id>/<version>/   # 第三方包安装目录
<dataDir>/plugins/<id>/                     # 插件数据（官方/第三方同根）
<dataDir>/plugin-backups/<id>/<timestamp>/  # 升级前数据快照
<dataDir>/plugin-install-state.json         # 安装态 JSON（不新增 DB 表）
<dataDir>/plugin-keys.json                  # 本地 keyring
<dataDir>/plugin-trust.json                 # 自签 TOFU
<dataDir>/plugin-revocations.json           # 吊销列表
```

## 附录 D：对抗审查 P0 处置

| 审查 | P0 | 处置 |
| --- | --- | --- |
| plan-review-1 | SDK 无处安放/迁移量 80 import/39 文件 | 采纳：SDK 三层 + ratchet + A3b 分批 |
| plan-review-1 | D2 与流式/租约矛盾 | 采纳：A1 补事件/流 RPC；D2 仅约束第三方面 |
| plan-review-1 | §10 修订不足/编号错 | 采纳：§10 扩表；更正引用；更名 PLAN-5.0 |
| plan-review-1 | 基线不可复现/数字口径 | 采纳：A0 定义基线/TEMP/test.tmp；数字以实测为准 |
| plan-review-1 | utilityProcess 非沙箱 | 采纳：0.2 诚实边界；D7 修订；B0 负向 spike |
| plan-review-2 | A1 早于 B0 | 采纳：B0 提前并行；A1 先 RC |
| plan-review-2 | migrations 任意 SQL | 采纳：DDL 白名单 + 第三方 DB API 收窄 |
| plan-review-2 | 签名不可闭合 | 采纳：D5 keyring/吊销/发布者模型；C1 前定 |
| plan-review-2 | 运营最小集缺失 | 采纳：C8 |
| plan-review-2 | 回滚无数据回滚 | 采纳：C2 二进制 + 快照 |
