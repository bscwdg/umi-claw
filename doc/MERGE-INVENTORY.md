# MERGE-INVENTORY：4.0 基线合并冲突清单（3.0 ← 2.0）

> 生成：2026-10-30 ｜ 配套：`PLAN-4.0.md` §〇.5 / Phase 0.5
> 方法：临时 worktree（`D:\work2026\files\claw-merge`，分支 `tmp/merge-2.0`）以 **release/3.0 为 ours** 合并 **release/2.0**，停在未解决冲突状态；`git diff --cc` 导出 27 份 combined diff 后逐文件归类。**未改动任何 `release/*`。**
> 复现：`git worktree add <dir> -b tmp/merge-2.0 release/3.0 && git -C <dir> merge release/2.0`；清理：`git worktree remove --force <dir>`。

## 一、总量

| 指标 | 数值 |
| --- | --- |
| 冲突文件 | 27 |
| 冲突块 | 168 |
| 其中 add/add（两侧独立创建同名文件） | 14 |
| 2.0 侧无冲突带进的新文件 | 95（`marketing/*` 7313 行、`views/marketing/*` 3054 行、`collector/*` 381 行、10 个验收脚本、`PLAN-2.0.md`） |
| 集中在数据/网关层及依赖它们的验收测试 | 129 块（实现 50 + 测试 79） |

分类与工作量：

| 类 | 内容 | 文件 | 块 | 判断量 |
| --- | --- | --- | --- | --- |
| A | 版本号 / 文档 / 锁文件 | 5 | 15 | 机械 |
| B | 数据库层 | 7 | 65 | **高**（互斥 schema） |
| C | 网关 / IPC 层 | 5 | 53 | 中 |
| D | 宿主接线（main / preload / 路由 / 导航 / Setup） | 7 | 24 | **高**（3 个真互斥点） |
| E | knowledge / context 验收测试 | 3 | 11 | 中（add/add 需拆文件） |

## 二、仲裁规则（先定规则，再逐文件动手）

**R1｜数据库层一律取 3.0。** 3.0 侧有防撞车三件套，丢了就是线上事故：`WORK_DB_FILENAME='work.db'`、`assertSchemaShape()`（8 表形状校验）、`backupDuringInit(sendRaw)`（避免迁移自等死锁）。2.0 的 `database/*` 基本等同 1.0 基线，没有需要保留的结构。

**R2｜两个域各用各的库，不做 schema 并集。** 3.0 是 8 表（profile/matters/todos/activity_log/reports/knowledge/conversations/app_meta），2.0 是 11 表（projects/businesses/knowledge_items/knowledge_chunks/hot_topics/hot_topic_samples/project_hot_topics/project_watchlist/contents/content_versions/app_meta）；**只有 `app_meta` 重叠**，`knowledge` 与 `knowledge_items` 是同义改名。合并方式是把 `db-worker.mjs` 参数化（`--db <path> --schema <work|marketing>`，schema 与 TABLES 白名单成对注入），不是把两套 DDL 拼在一起。

**R3｜网关层以 3.0 `gatewayClient.ts` 为基准，搬 2.0 四件。** 两侧是 add/add 的同构克隆，3.0 更干净（无 Project 耦合、统一 `runId`、会话键形状校验更严）。必须搬：① `forwardGatewayStream` **不吞** `handle.result` 的拒绝；② `deliverable` 字段与 done 透传；③ `projectId → conv:<pid>:<key>` 的拼装与 `:` 注入拒绝（marketing 五个模块依赖）；④ `abortAll*` 导出与 `before-quit` 接线，外加 2.0 的 G10 真库用例。

**R4｜preload 保留 3.0 的 `call<T>`**（带 `code`/`details` 的解包器），`voiceCall` 降为 `const voiceCall = call` 别名；合并后 `window.api` 的 `fish` 顶层键会重复声明（两块各有一个），必须去重。

**R5｜add/add 的验收测试不能"删冲突标记"。** 两侧顶层声明同名（`r`/`repoRoot`/`logger`/`dbMod`/`ok`/`result`），删标记即 SyntaxError，必须拆成两个文件并改脚本键：`accept:knowledge:work` / `accept:knowledge:marketing`（context 同），同步 `scripts/run-all-accept.mjs` 的**显式数组**（它不 glob，漏改就不跑）。

## 三、A 类：版本号 / 文档（15 块，机械）

| 文件 | 块 | 处理 |
| --- | --- | --- |
| `package.json` | 3 | 版本取 `4.0.0`；`scripts` 取**并集**（3.0 的 17 条 + 2.0 的 16 条）；`pdfjs-dist` 两侧各加了一行，去重保留一条 |
| `package-lock.json` | 4 | 不手工合并，`rm -rf node_modules package-lock.json && npm install` 重生成 |
| `.gitignore` | 1 | 内容等价（同一教训的两种措辞），取 3.0 |
| `README.md` | 6 | 两域功能清单并入同一份文档，取并集（不是二选一） |
| `doc/voice/VOICE-REFERENCE-v1.md` | 1 | 取 3.0（「450 个音色」）；2.0 侧是旧数据（「10 个音色」），说明 2.0 的语音文档落后于代码 |

## 四、B 类：数据库层（7 文件 / 65 块，全取 3.0）

| 文件 | 块 | 冲突实质 | 关键点 |
| --- | --- | --- | --- |
| `database/schema.ts` | 1（整文件） | 双实现、互斥 | 见 R2。误取会让营销侧查 `knowledge_items`、工作侧查 `knowledge`，两边都「成功」但互相看不见 |
| `database/migration.ts` | 3 | **版本号撞车**：两代都把 `user_version=2` 用于不同 DDL（3.0 给 todos 加 `remind_at`；2.0 给 contents 加 `content_type`） | 两边都留 → `ALTER TABLE contents` 在 work.db 里必报 `no such table`，整步回滚卡在 0/1；只有 work.db 文件名分离，`user_version` 才重新有单义 |
| `database/database.ts` | 10 | 3.0 单边加固 + 1 处双方同修复 | `WORK_DB_FILENAME` / `assertSchemaShape()` / `backupDuringInit` 三件套必须保留；备份正则取 `^work-` 会让 2.0 旧快照不滚动清理（可接受），反之 work 备份无限增长（不可接受） |
| `database/errors.ts` | 4 | 错误码表语义分叉 | 3.0 删 `HOT_SOURCE_ERROR`、加 `STREAM_TRUNCATED` / `OPENCLAW_INVALID_OUTPUT`（共 12 项）；但 **marketing 代码仍在消费 `HOT_SOURCE_ERROR`** → 本次合并若保留 marketing 代码，需把它作为 deprecated 第 13 项并同步改「恰好 12 项」的断言；若删 marketing 引用则取净 12 项 |
| `resources/database/db-worker.mjs` | 8 | 同一 Worker 承载两个域 | `TABLES` 白名单必须与 schema 同源同决定；`opList()` 的 `{column,direction}` 增强、`knowledge.search` 去 `projectId` 都是 3.0 的净收益，误取 2.0 会让列表接口全量 `VALIDATION_ERROR` |
| `test/db-client.accept.mjs` | 15 | 同脚本两域版本 | 2.0 的 C9b 不必移植（3.0 的 C16 覆盖同一场景）；**C14/C15/C16 是三条真实事故回归，不能丢** |
| `test/db-worker.accept.mjs` | 24 | 同脚本两域版本 + 用例编号整体移位 | 一次性按 W1–W22 重排编号，别按块零散选；`EXPECTED_INDEXES` 必须含迁移追加的索引 |

## 五、C 类：网关 / IPC 层（5 文件 / 53 块）

| 文件 | 块 | 冲突实质 | 仲裁 |
| --- | --- | --- | --- |
| `gatewayClient.ts` | 18 | add/add 同构克隆，差异在**会话键语义**（3.0 收完整 `conv:` 键 vs 2.0 收 projectId 拼装）、流 ID（`runId` vs `streamId`）、事件名（`work:stream:*` vs `marketing:gateway:*`）、`deliverable` | R3：3.0 为体 + 搬四件。**3.0 现存缺陷必修**：`handle.result.catch(() => null)` 会吞掉「落库/解析失败」，让渲染端收到一次成功 done，把未解析原文当正文采用（2.0 已修，有 S4 断言） |
| `ipc/gateway.ts` | 3 | 仅域前缀不同，逻辑逐字相同 | 合并为一个文件两组常量，一次注册 4 条 handler |
| `ipc/index.ts` | 1（整文件） | 纯 re-export 聚合器整体对抗 | 3.0 骨架 + 追加 2.0 export 块；`work:*` / `marketing:*` 前缀正交，可直接挂 |
| `subprocessRegistry.ts` | 2 | 纯注释 | 取 3.0，示例名改中性（`db-worker`），避免下次合并再冲突 |
| `test/gateway.accept.mjs` | 29 | 同一契约（28 个 check，ID/顺序一致），分叉只在 G10 会话隔离、事件名断言、payload 键 | 3.0 为基线 + 2.0 的 G10 改造成 G10b 保留（真起 ProjectManager + DatabaseClient 取 `conversation_key` 的用例不该丢） |

## 六、D 类：宿主接线（7 文件 / 24 块）

| 文件 | 块 | 冲突实质 | 仲裁 |
| --- | --- | --- | --- |
| `electron/main/index.ts` | 9 | ①import / 单例纯增量并集；②**同一函数两域各一份**（4 组：`resolveGatewayModels`、`readActualGatewayPort`、`isProcessAlive`、`triggerVoiceAutoSpeak`）→ TS 重复标识符，编译不过；③3.0 独有改动（consent 闸门、`resourcesRoot()`） | 去重后取并集；consent 闸门、`resourcesRoot()` 取 3.0；`triggerVoiceAutoSpeak` 以 3.0 的 `(text, eventId)` 为体、`eventId` 可选（2.0 版少了 `shouldSpeakInApp` 的 `mode` 判定，会误播/静音） |
| `electron/preload/index.ts` | 6 | 4 块是 `call` vs `voiceCall` 的措辞/缩进；1 块是 helper 实现；**`work` 命名空间整段落在冲突块内** | R4；误取 theirs 会整体丢掉 `window.api.work` → 8 个 work 页面全白 |
| `src/App.vue` | 4 | 导航数据模型互斥：3.0 扁平两段（`workNavItems` 8 + `navItems` 10）vs 2.0 分组 `navGroups`（15 条） | 以 2.0 的 `navGroups` 为唯一数据源，插入「工作」首组；删 `navItems`；CSS 取 3.0 的 `.nav{min-height:0; scrollbar-gutter:stable}`（2.0 缺 `min-height:0`，flex 子项滚不出来） |
| `src/renderer/main.ts` | 1 | 纯追加，无同路径 | 并集（work 9 条 + marketing 5 条） |
| `src/views/Setup.vue` | 2 | `goToDashboard()` 两种互斥实现 | 合成：未完成向导 → 弹 `openWizard()` 并 return；已完成 → `router.push` **并且** `location.reload()`（`setupGuard` 是模块级缓存，不 reload 会被弹回 `/setup`；但 reload 与弹窗不能同帧） |
| `electron/main/configManager.ts` | 1 | 注释级（代码字节一致） | 取中性表述；零风险 |
| `electron/main/downloadManager.ts` | 1 | 注释级，但暴露事实：**两个 DB Worker** | 改成「work / marketing 各一个 worker，退出时都要 `wal_checkpoint`」 |

**合并后 `main/index.ts` ≈ 2,500–2,620 行，其中约 50%（≈1,300 行）是域逻辑直插宿主。** 这段就是 Phase 1/2 要抽的东西，按收益排序：① 每域一个 `register(ctx)` 装配器（当前「单例声明 / 工厂 / IPC 注册 / whenReady 装配 / before-quit 清理」五段在文件里相隔约 1300 行）；② `HostContext`（configManager / clawManager / dataDir / mainWindow / subprocessRegistry / `getStatus`）；③ 共享 `gatewaySupport` / `voiceBootstrap`（4 组重复工具上移）；④ `registerGatewayIpc` 参数化；⑤ 1.0 的 60 个壳通道保持不动。

## 七、三个真互斥点（必须做选择，不能并集）

**M1｜voice 初始化块 —— 并存会启动即崩。** ours（3.0）在 `whenReady` 用 `workDatabase` 初始化 voice；2.0 另有一段 58 行用 `marketingDatabase` 初始化。两块都留 → `registerVoiceIpc` 二次注册同一批 `fish:voice:*` → `Attempted to register a second handler`。取 3.0，voice 存储绑 `work.db`。**遗留**：2.0 存量用户的克隆音色/预算用量留在 marketing 库，需一次性迁移或双读，用户感知为「音色丢失」。

**M2｜`Setup.vue` 的 `goToDashboard`。** 只取 ours → 3.0 的 `setupGuard` 模块级缓存把用户弹回 `/setup`（2.0 用 reload 修的就是这个 bug）；只取 theirs → 首启用户看不到向导。必须合成。

**M3｜`App.vue` 的导航数据模型。** 扁平 vs 分组，必须二选一。另注：`ProjectSwitcher`（营销域组件）已被无条件挂到全局侧栏（位于冲突块外、自动并入），3.0 用户会看到一个无意义的「当前商家」下拉，且它内部调 `window.api.marketing.*` —— 这是「域逻辑直插宿主壳」最显眼的一处，Phase 2 前应加启用态判断。

## 八、跨文件雷区（单看某个文件看不出来）

1. **单例唯一**：合并后全应用只能有一个 `GatewayClient`、一个 `voiceManager`。两个 client = 两个 token 持有者 + 两套 starter/就绪缓存，`ensureReady` 可能各自拉起 OpenClaw（双进程）。`ipc/gateway.ts` 的 `handle()` 先 `removeHandler` 再注册，重复注册**不报错、只静默覆盖**，前端会拿到另一域的快照。
2. **schema 与 TABLES 白名单必须同源同决定**：只改一边 → 白名单放行但列不存在（`no such column`，比 `no such table` 更难查）。
3. **两个库两个 worker**：`createWorkDatabase(work.db)` 与 2.0 的 `createMarketingDatabase(umi-claw.db)` 共用同一个 `db-worker.mjs`。若 marketing client 被保留并初始化，会用 3.0 的 DDL 去迁移 `umi-claw.db` —— 既污染用户 2.0 数据，又破坏向导的旧库只读映射（`resources/database/read-old-db.mjs` 读的正是 `umi-claw.db` 的 `projects/businesses/knowledge_items`）。R2 的参数化是硬前提。
4. **`registerGatewayIpc` 被调用两次**（marketing 在 `registerIpcHandlers` 尾部、work 在 `whenReady`）：只有一套 `*_GATEWAY_CHANNELS` 常量时后注册者顶掉前者，不抛错。必须参数化并保留两套常量。
5. **错误码表是 IPC 信封共用的**：取错一项，整个 renderer 的 `switch` 静默 fallthrough。
6. **验收脚本会 grep 源码字符串**（`gateway.accept` 底部对 ipc/preload/main 的静态断言）：合并后必须与最终命名对齐，否则要么假红挡路，要么有人图省事删断言，把「token 不出主进程」「未注册业务流通道」两条护栏丢了。

## 九、Phase 0.5 执行顺序

| 步 | 做什么 | 完成判据 |
| --- | --- | --- |
| 1 | 落规则：本文件 + `PLAN-4.0.md` §〇.5 / Phase 0.5 | 规则 R1–R5 可引用 |
| 2 | A 类 15 块（版本号 / 锁文件 / 文档） | `npm install` 通过，`package.json` 脚本并集 |
| 3 | B 类 65 块（数据库层）+ R2 的 worker 参数化 | `accept:db-client`、`accept:db-worker` 绿 |
| 4 | C 类 53 块（网关层）+ R3 四件 | `accept:gateway` 绿；`handle.result` 不再被吞 |
| 5 | D 类 24 块（main / preload / 路由 / 导航 / Setup） | 双 typecheck 绿；应用可启动；1.0 壳链路可用 |
| 6 | E 类 11 块 + 拆 5 个同名测试；`run-all-accept` 数组同步 | `npm run accept` 绿（约 44 个脚本） |
| 7 | 收尾：4 组重复函数去重、`before-quit` 补 2.0 的 `abortAll*`、`Package.json` 脚本名对齐 | 4.0 基线可发布 |

## 十、未决（需要拍板，不是合并能解决的）

1. `/dashboard` 标签「控制台」（3.0）vs「工作台」（2.0）；`/skills`「技能管理」vs「能力中心」——产品口径。
2. `HOT_SOURCE_ERROR` 是保留为 deprecated（短期）还是本次合并直接删营销引用（干净）。
3. 2.0 存量用户的语音数据迁移策略（M1 遗留）。
4. marketing 插件默认关闭时，`ProjectSwitcher` 等域组件是否要从壳里彻底摘掉（M3 的产品侧答案）。
