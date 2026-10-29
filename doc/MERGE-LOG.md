# MERGE-LOG：4.0 基线合并执行记录（3.0 ← 2.0）

> 执行：2026-10-30 ｜ worktree `D:\work2026\files\claw-merge`（分支 `tmp/merge-2.0`，ours = `release/3.0`）
> 依据：`doc/MERGE-INVENTORY.md`（27 文件 / 168 冲突块的归类与仲裁）
> 状态：**代码合并完成，work 域全绿；marketing 域代码已并入、数据层待接（见 §五）**

## 一、验证结果

| 验证项 | 结果 |
| --- | --- |
| `tsc -p tsconfig.web.json` | **0 错误** |
| `tsc -p tsconfig.node.json` | 1 个**既有**错误（`fish/voice/core/manager.ts:27` 未使用的 `OpenClawTtsChannelSetting`；该文件在两分支字节相同，不是本次合并引入） |
| `accept:db`（db-worker + db-client） | **38/38 通过** |
| `accept:gateway` | **29/29 通过** |
| `accept:work` | **20/20 通过** |
| `accept:ui` | **17/17 通过** |
| `accept:knowledge:marketing` | 6/23（失败全部落在「DB 表不存在」，见 §五） |

## 二、逐类处理（与清单的偏差都记在这里）

### A 类（版本号 / 文档 / 锁文件）

- `package.json`：版本 → `4.0.0`；脚本文本取 3.0 为基，新增 `accept:project / business / advisor / scan / content / shooting / hot / hotscore / platform`，并把 context/knowledge 拆成 `:work` / `:marketing` 两套。
- `package-lock.json`：取 3.0 原文，**未重生成**（worktree 的 `node_modules` 是指向主仓的 junction，就地 `npm install` 会污染主仓依赖），留到打包前重生成。
- `README.md`：取 3.0。⚠️ 2.0 的营销域功能说明尚未并集（文档债，不阻塞代码）。
- `.gitignore` / `doc/voice/VOICE-REFERENCE-v1.md`：取 3.0（内容等价或 2.0 侧数据过期）。

### B 类（数据库层，7 文件 / 65 块）

- 全部取 3.0。`WORK_DB_FILENAME='work.db'`、`assertSchemaShape()`、`backupDuringInit(sendRaw)` 三件套完整保留。
- **唯一偏离清单**：`errors.ts` 保留 `HOT_SOURCE_ERROR` 作为**第 13 项（deprecated）**——营销 `hotManager.ts` 与 `stores/marketing.ts` 仍在消费，删了直接编译不过。`test/db-worker.accept.mjs` 的「恰好 12 项 / 不含 HOT_SOURCE_ERROR」断言同步改为「13 项 / 含」。
- `db-worker.mjs` 的 TABLES 白名单仍是 work 的 8 表（见 §五）。

### C 类（网关 / IPC 层，5 文件 / 53 块）

- `gatewayClient.ts`：以 3.0 为体，搬入 2.0 四件——① `forwardGatewayStream` 不再吞 `handle.result` 的拒绝（3.0 现存缺陷：会把解析/落库失败伪装成成功 done）；② `GatewayStreamResult.deliverable` 与 done 透传；③ `buildConversationUser()` 与 `GatewayChatInput.projectId`（营销五个模块依赖）；④ 单例约束下不再保留 `createMarketingGatewayClient`。
- `ipc/gateway.ts`：`WORK_GATEWAY_CHANNELS` + `MARKETING_GATEWAY_CHANNELS` 两套常量并存，**一次** `registerGatewayIpc` 注册 4 条（避免 `removeHandler` 静默覆盖）。
- `ipc/index.ts`：3.0 骨架 + 追加营销域 7 组导出（含 `abortAll*` / `activeScanCount`）。
- `subprocessRegistry.ts`：取 3.0（纯注释差异）。
- `test/gateway.accept.mjs`：取 3.0（29/29 绿）。⚠️ 2.0 独有的 **G10b**（真起 ProjectManager 从 projects 表取 `conversation_key`）尚未移植，留作补测。

### D 类（宿主接线，7 文件 / 24 块）

- `src/App.vue`：**以 3.0 为体**（保留用户协议闸门、向导门、语音自动朗读），导航改为 `navGroups` 并插入 `ProjectSwitcher`；标签按 2026-10-30 拍板：`/dashboard` → **控制台**，`/skills` → **能力中心**。
- `src/views/Setup.vue`：取 3.0。**M2 的消解方式是「不迁 `setupGuard`」**——2.0 给 `goToDashboard` 加 `location.reload()` 是为了清 `setupGuard` 的模块级缓存，而 3.0 用向导 gate、没有 `setupGuard`，所以合并后既不需要 reload 也不会有「被弹回 /setup」的 bug。`src/renderer/setupGuard.ts` 文件保留但未接线。
- `src/renderer/main.ts`：3.0 的 9 条 work 路由 + 2.0 的 5 条 marketing 路由，无同路径冲突。
- `electron/preload/index.ts`：3.0 的 `call<T>`（带 code/details）为唯一解包器，2.0 的 `voiceCall` 统一改为 `call`；插入营销命名空间（约 213 行）。`window.api.fish` 只保留一份。
- `electron/main/index.ts`：见 §三。
- `configManager.ts` / `downloadManager.ts`：取 3.0（纯注释差异；后者注释已改为「work / marketing 各一个 DB worker」）。

### E 类（knowledge / context 验收测试）

- **没有按子目录拆**（`test/work/*` 方案已试过并回退）：脚本里 `repoRoot = join(__dirname, '..')`、`_lib.mjs` 相对引用、`fixtures/*` 都被目录深度写死，挪一层就全断。改为**平铺命名**：
  - `test/context.work.accept.mjs` / `test/context.marketing.accept.mjs`
  - `test/knowledge.work.accept.mjs` / `test/knowledge.marketing.accept.mjs`
- `scripts/run-all-accept.mjs` 的显式数组同步（它不 glob，漏改就不跑）。
- `test/ui.accept.mjs` U11：gateway 面现在一次注册两域通道，而本套件只加载 work 域 IPC，故孤儿检查改为**按域过滤**，并对 `marketing:gateway:*` 显式断言「确实注册了」——护栏没有被删除，只是把跨域事实写进了断言。

## 三、main/index.ts（2562 行，0 冲突标记）

- 单 `GatewayClient`：删除 `createMarketingGatewayClient` 与 `marketingGatewayClient` 单例，营销域改注入 `conversationKeyResolver`（按 projectId 取 `conversation_key`）。
- `registerGatewayIpc` 只调用一次。
- voice 初始化只保留 3.0 那一段（绑 `work.db`），2.0 的 58 行 `marketingDatabase` 版本整段删除（否则 `fish:voice:*` 二次注册启动即崩）。
- 保留 3.0 的 consent 闸门、`resourcesRoot()`、reminder/push 栈；删除 4 组重复函数（`resolveGatewayModels` / `readActualGatewayPort` / `isProcessAlive` / `triggerVoiceAutoSpeak`）。

## 四、清单之外多做的一件事

`resources/database/db-worker-marketing.mjs`（2.0 原样 721 行，11 表白名单）+ `test/_lib.mjs` 新增 `marketingWorkerScriptPath` + 11 个营销验收脚本改用它。

理由：两域 schema 互斥，一个 worker 的白名单放不下两套表。但这只是**半个 R2**——真正卡住的是 §五。

## 五、未完成 / 已知缺口（按优先级）

1. **marketing 数据层（阻塞营销域可用）**：`DatabaseClient` 的 schema 与 migration 是**客户端侧**的（`database/schema.ts` + `migration.ts`，只有 work 8 表）。换 worker 只解决了白名单，迁移仍按 work schema 跑 → 营销库里没有 `projects` 表，报 `no such table: projects`。
   修法：给 `DatabaseClient` 加 `schemaId: 'work' | 'marketing'`，按 id 选 `schema/migration` 模块，`assertSchemaShape()` 按 schema 断言；营销 schema/migration 直接从 `release/2.0` 取对应文件。预计 0.5–1 人天，之后营销 11 个验收套件才可能转绿。
2. `test/gateway.accept.mjs` 的 G10b 未移植。
3. `README.md` 待并集；`package-lock.json` 待重生成。
4. 2.0 存量用户的语音数据：按 2026-10-30 拍板**直接删除、不做迁移**；voice 存储改绑 `work.db`。需要在发布说明里写清楚。
5. `tsc` 那个既有错误（`fish/voice/core/manager.ts:27` 未使用类型导入）留待顺手清理。
