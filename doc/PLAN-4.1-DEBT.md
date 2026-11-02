# PLAN-4.1-DEBT —— 4.0 插件化减负执行计划（可执行版）

> 状态：**执行中**（2026-11-02 立）｜分支：`release/4.0`
> 定位：`PLAN-4.0.md` 的**施工分册**。4.0 是架构契约（宿主/插件边界、启停语义），本文件是**欠账清偿的执行顺序、每步命令与验收判据**。冲突时以 `PLAN-4.0.md` 为准，本文件不新增架构决定。
> 依据：`PLAN-4.0.md §18.3`（承诺未落地清单）、`§18.4`（发布工程清单）、`§17`（硬规则）
> 关联：`doc/PROGRESS-4.0.md`（施工日志，本文件每完成一包在其中追加一条）、`doc/RUNBOOK-4.0.md`（运维手册）

---

## 〇、为什么有这份文件

4.0 的插件化**结构成立、边界未硬化**：启停语义、构建期装配、DB 隔离都是真的，但域代码仍住宿主目录、插件仍直接 import 宿主内部模块、同名能力有两份实现、仓库没有 lint 门禁。

本计划只做一件事：**把"名义插件化"变成"实测插件化"**，且每一步都留一个可发布点。

不做什么（防止扩散）：

- 不迁 monorepo、不换包管理器（`PLAN-4.0 §10` 已定）
- 不做第三方插件安装、不做运行时插件加载（`§17` 硬规则 3）
- 不做类型化 IPC 生成（`§18.3` 已明确延后，不阻塞）
- 不动启动链路（网关 325s 冷启动的根因在 OpenClaw 通道物化，不在本计划范围）
- 不重写 UI、不改 CSP / contextIsolation / 插件生命周期语义

---

## 一、基线（2026-11-02 阶段 A 收尾实测）

| 指标 | 实测 | 复核命令 | 目标 / 状态 |
| --- | --- | --- | --- |
| 宿主 `electron/main` 代码量 | 26,960 行 | `(Get-ChildItem electron\main -Recurse -Filter *.ts \| Get-Content \| Measure-Object -Line).Lines` | ≤ 26,000（差 960，WP5） |
| `electron/main/index.ts` | 2,551 行 | `(Get-Content electron\main\index.ts).Count` | ≤ 1,800（差 751，WP5） |
| 插件越界 import（非 type、非 kernel/services） | **9 条**（全部是插件 `main.ts` 直引宿主 `ipc/*`；W6-a 已下沉 gateway 纯工具） | `npm run check:boundary` | 0（WP6-b） |
| 门禁可绕过写法 | 已覆盖 static/export-from/dynamic/require + 路径穿越 + 注释掩码/正则字面量/字符串文案/模板字面量/非字面量/typeof | `node test/boundary.accept.mjs` | 8/8 保持 |
| Manager 层 import electron | 0（扫描 `plugins/*/domain` 共 2 个目录） | `npm run check:boundary` | 0 |
| 门禁是否自动执行 | `npm run accept` 首套 + CI verify job | `Select-String .github/workflows/release.yml -Pattern 'check:boundary'` | 必须有（已满足） |
| CI 门禁 | typecheck×2 + boundary + build + accept（Windows），push release/** / tags v* / PR 触发 | `.github/workflows/release.yml` | 保持 |
| accept 套件 | accept×30 + e2e + smoke = **32 套 / 607 条断言** | `npm run accept`（本机已 32/32 全绿，含 hot） | 不减少 |
| 唯一实现 | parsers 3 份合并为 1；context 双实现收敛为 `services/context` 内核 | `Get-FileHash` / 目录结构 | 保持 |
| 明文密钥字面量 | 0（仅 `Config.vue` 的 placeholder 示例） | 见 §三 校验清单 V9 | 0 |

**已确认成立、不要在减负时破坏的东西**：

1. `kernel/plugins.main.generated.ts` 是构建期静态 import，`resources/plugins/` 只有 manifest + migrations。
2. `kernel/lifecycle.ts` 的 LIFO disposer / 激活超时 / 迟到注册拒绝 / 失败隔离。
3. `services/pluginDb.ts` + `db-worker.mjs` 参数化为每插件独立库 + 独立 schema。
4. 21 个 Manager 无一 import `electron`（0 命中），纯 Node 可测——这是验收网能跑的前提。
5. 渲染端 0 处 `error.message.includes()`，错误分支全部走 `code`。

---

## 二、工作包

顺序按**依赖**排，不按收益排：先上闸门（不然后面改动没有安全带），再去重（最便宜先拿收益），再下沉（最贵，必须活在闸门之下），最后搬目录（机械动作收口）。

```
WP0 止血闸门 ──> WP1 零风险去重 ──> WP2 context/knowledge 下沉 ──> WP3 边界硬化+搬迁 ──> WP4 契约补齐
  0.5–1 人天        1–1.5 人天            4–6 人天                  4–5 人天            3–4 人天
                  (可发 4.0.1)                                     (可发 4.0.3)          (4.1)
```

合计 **10.5–14.5 人天**。

---

### WP0 · 止血闸门（0.5–1 人天）

**问题**：CI 只跑 `npm ci` + `build`，打 tag 就能发出一份没跑 typecheck、没跑 accept 的包；工作区还有未提交改动。

#### C0.1 提交工作区改动

```powershell
# 前置：两套 typecheck 均为 0 错；ui.accept 23/23（2026-11-02 已实跑确认）
npm run typecheck:node; npm run typecheck:web
npm run accept:ui
```

| 内容 | 说明 |
| --- | --- |
| `src/views/Dashboard.vue` | `actionLoading` 布尔 → `pendingAction` 三态；按钮文案与真实动作一致（U23 锁住） |
| `test/ui.accept.mjs` | 新增 U23，断言 `pendingAction` 结构与三处复位 |
| `doc/video/umisi-brand-intro/` | 品牌介绍视频脚本/分镜/prompt（已扫描：无密钥、无凭据） |

提交标题：`fix(ui): 控制台按钮文案按动作区分 + 品牌视频脚本入库`

**注意**：`doc/video/` 属内容产物，不是构建输入，但 `resources/` **不能**放它（`§18.5` 已登记 `extraResources` 整目录带包风险）。放 `doc/` 是正确位置。

#### C0.2 CI 补门禁（不引 lint，先补 typecheck + accept）

`.github/workflows/release.yml` 现状：

```yaml
- run: npm ci
- run: npm run build
```

改为（**只在 windows runner 跑 accept**，其他两个 OS 只跑 typecheck + build）：

```yaml
- name: Typecheck
  run: npm run typecheck:node && npm run typecheck:web

- name: Accept (Windows)
  if: runner.os == 'Windows'
  run: npm run accept
  env:
    UMI_ALLOW_PACKAGE_SKIP: '1'   # CI 不产出 NSIS，packaged.smoke 的 S6 显式跳过
```

`UMI_ALLOW_PACKAGE_SKIP=1` 的理由：`test/packaged.smoke.mjs` 在缺 `release/win-unpacked` 时允许显式跳过 S6/S7；CI 里先只保证「源码级 31 套绿」，真机安装留 WP0-C0.3 人工。**注意 accept 前必须先 `npm run build`**：`packaged.smoke` 的 S1 断言 `dist-electron/` 存在，干净 checkout 里没有。

另外新增 PR 触发（现在只有 tag 触发，日常提交无门禁）：

```yaml
on:
  push:
    branches: [release/**]
    tags: ['v*']
  pull_request:
    branches: [master, 'release/**']
```

**出口判据**：

1. 故意改坏一个类型（如给 `TodoManager.create` 传错参数），CI 必须红。
2. 故意删掉一个断言，`accept` 必须红。
3. 两条都验证过了才算 C0.2 完成——**没验证过等于没做**。

#### C0.3 NSIS 真机 7 步（`§18.2` 登记的未执行项）—— **由北执行**

按 `doc/RUNBOOK-4.0.md §6` 执行：干净目录安装 → 首启 → 启停插件 → 覆盖升级 → 卸载残留检查。

**这一项不阻塞 WP1/WP2**（它们不改打包链路），但**阻塞打 tag**。执行后把结果追加到 `doc/PROGRESS-4.0.md`。

---

### WP1 · 零风险去重（1–1.5 人天）｜性价比最高

**证据**（`Get-FileHash` 实测）：

```
4AC05BC6C6DCDD8E378402AF8F8A949607815C8061E69D7D3F6BF6A6E168503F
  electron\main\work\parsers\documentParsers.ts          (22KB)
  electron\main\marketing\parsers\documentParsers.ts     ← 字节完全相同

68DE10520AA0...  work|marketing\parsers\pdfjsAssets.ts    ← 完全相同
4CDBB3A1204B...  work|marketing\parsers\urlParser.ts      ← 完全相同
```

外加一处**错误引用**：`plugins/marketing/main.ts:22` 从 `electron/main/work/parsers/pdfjsAssets` 取 pdfjs 资产——marketing 引 work 的路径，纯属历史遗留。

#### C1.1 下沉到 `electron/main/services/knowledge/`

```powershell
# 目标结构
electron/main/services/knowledge/
├── index.ts                    # 统一导出
└── parsers/
    ├── documentParsers.ts      # 唯一实现（Word/Excel/PDF/TXT）
    ├── pdfjsAssets.ts          # 唯一实现
    └── urlParser.ts            # 唯一实现
```

改动点（**5 个文件 / 10 条 import**，实测；`runtime.ts` 里没有任何 parser import，不要照旧印象改）：

| 文件 | 行 |
| --- | --- |
| `electron/main/work/knowledgeManager.ts` | 30 / 36 / 37 |
| `electron/main/marketing/knowledgeManager.ts` | 52 / 53 / 54 |
| `electron/main/marketing/scanRecognizer.ts` | 55 / 56 |
| `plugins/work/main.ts` | 12 |
| `plugins/marketing/main.ts` | 22（顺手修：它引用的是 `work/parsers`，marketing 引 work 的路径） |

#### C1.2 删除冗余目录

```powershell
Remove-Item electron\main\work\parsers -Recurse
Remove-Item electron\main\marketing\parsers -Recurse
```

**出口判据**（六套必须全绿）：

```powershell
npm run accept:knowledge:work; npm run accept:knowledge:marketing
npm run accept:scan; npm run accept:content
npm run accept:work; npm run accept:shooting
npm run typecheck:node; npm run typecheck:web
```

**回滚**：单提交 revert，无数据影响（纯文件移动）。

**注意（v3 校正，经两轮对抗审查修正）**：`test/_lib.mjs:domainSrc(pluginId, rel)` 的实际行为是「`plugins/<id>/main/<rel>` 存在就用它，否则回落 `electron/main/<rel>`」。两点要说准：

- 它**能**指向 `services/`（第二候选的 `rel` 是自由的：`domainSrc('work','services/pluginDb.ts')` 实测返回该路径），但**表达不了**「新位置在 `services/X`、旧位置在 `marketing/Y`」这种一对多的回落。
- 它返回**绝对路径**，而 `bundleEntry()` 收的是**仓库相对路径**（内部 `join(repoRoot, entryRelPath)`）；直接把返回值传给 `bundleEntry()` 会拼成 `D:\repo\D:\repo\electron\...`（实测）。

所以 WP1 的正确做法是新增一个通用 helper，而不是用 `domainSrc()`：

1. 在 `test/_lib.mjs` 新增 `anySrc(candidates)`：按顺序返回**第一个存在的仓库相对路径**，不存在则返回第一个。WP1 用两个候选（`electron/main/services/knowledge/parsers/X` → `electron/main/marketing/parsers/X`）。
   > WP3 要同时搬 `work/**` 与 `marketing/**` 两棵树，单一回落不够用；`anySrc` 接受数组，正好覆盖。
2. 实测硬编码共 **8 处**（不是 4 处），两类都要改：

| 类型 | 位置 |
| --- | --- |
| `bundleEntry('electron/main/marketing/parsers/...')` | `test/knowledge.marketing.accept.mjs:727`、`:747`、`:924`；`test/scan.accept.mjs:73` |
| `join(repoRoot, 'electron','main','marketing','parsers',...)` + `readFileSync` | 定义在 `test/knowledge.marketing.accept.mjs:58`、`:59`、`:60`；`test/scan.accept.mjs:709`。读取点在 `:956`、`:963`、`:989`、`:995`、`:1008` |

所以 C1 拆成两个提交：**先**加 `anySrc()` 并把 8 处改过去（独立提交、绿了再搬），**再**搬文件。这是规则 G7。

---

### WP2 · context / knowledge 真下沉（4–6 人天）｜唯一可能改坏的一包

这是 `§18.3` 里最贵的一笔账，也是「第三个域进来就得写第三份」的根。

**不要合并两个 700 行文件。** 实测两域的通用面高度重合，但**骨架不同**：

| 项 | work | marketing |
| --- | --- | --- |
| 包结构 | 7 段：①任务指令（永不裁）②画像 ③事项 ④待办 ⑤confirmed 记录 ⑥知识 ⑦对话历史（独立预算，进文本） | 16 个顶层字段，核心键 business / knowledge / watchlist / customer / platform / task |
| 预算测算 | `measureWith()` **只拼知识条目正文 + dropped 标题**再加 `PACK_OVERHEAD_TOKENS`；第 2–5 段不算进账 | `measure()` 渲染**整个 probe pack**（含 `probeMode`） |
| dropped 原因 | 类型里有 `budget`/`empty-content`/`cut-order`，但 **`cut-order` 从未被 push**（死代码，已于 2026-11-03 删除） | `budget`/`empty-content` |

**两个必须知道的事实**（本轮审查实测，写进来免得下一个人重踩）：

1. work 的 `measureWith` 是「代餐测量」：知识块当全包计费，固定五段的占用不在账上；实跑 E4 是 `used=1481 / budget=1540`（余量 59 token），站住是数字凑巧。若无超长条目、循环走完不 break，`usedTokens` 可以真的超预算。
2. `cut-order` 只有类型定义、没有实现（已于 2026-11-03 删除）；§6.2 写的「6→5→4→3→2 裁剪」也不存在（2–5 段从不裁）。

#### 拆分方案：泛型取舍循环（已实现，以代码为准）

> **v3 校正**：v2 写的 `Section`（每段先分配 token 再渲染）是**凭空设计**，
> 读两域真实代码后确认它们不是这个结构。v2 的 `Section`/`SectionContext`/
> `AssembleOptions` 从未被使用，已从 `types.ts` 删除，避免第三个口径。
> 下面是与 `assemble.ts` 实际一致的设计。

两域的真实结构（逐行读 marketing:475-522 / work:402-449 后确认）：

```
mode = 全量渲染是否超预算（marketing 另有 businessOverBudget → 直接 truncated）
for 每条候选（按域侧排序：LIKE 命中优先 / 时间）：
  rest = 剩余候选 → 先按 budget 计入 dropped（未注入清单本身也占预算）
  放得下 → 收下，continue
  放不下 → sliceBudget = budget − 已选渲染 − PACK_OVERHEAD − marker − title
           够 minSliceTokens 就截断收入；然后 break
从尾部让位（保险丝）
```

内核就按这个实现，**泛型**（不认域）：

```ts
// services/context/assemble.ts（已提交 a7c4f0e）
export interface AssembleLoopOptions<T> {
  budgetTokens: number
  markerTokens: number
  overheadTokens: number        // work 48 / marketing 64
  minSliceTokens: number
  allCandidates: T[]
  ranked: Array<{ item: T; matched?: boolean }>
  renderText(chosen: T[], dropped: DroppedEntry[]): string
  measure(text: string): number
  include(item: T, opts: { truncate: boolean; sliceBudget?: number }): T
  toDropped(item: T, reason: DroppedReason): DroppedEntry
  titleTokens(item: T): number
  initialDropped?: DroppedEntry[]
}
export function assembleLoop<T>(opts: AssembleLoopOptions<T>): AssembleLoopResult<T>
```

域侧只需要提供 5 个回调（怎么渲染、怎么打包一条、怎么变 dropped、标题多长、怎么量）。
**域内的 `packItem`/`packKnowledge`/`skeleton`/`probePack` 全部留在域里**——
它们是域语义，不是内核语义。

交接点（W2-d/W2-e 要做的）：
1. 域内 `mode` 决策改成调 `assembleLoop`；
2. `businessOverBudget` 由域算好后作为「强制 truncated」传给内核（内核只接受结论）；
3. `dropped` 的累积语义按域保留：marketing 整体重建，work 累积 push + 过滤。

#### 分步执行（每步单独提交、每步可回滚）

> 编号与旧表冲突已重编：本节用 **W2-a … W2-f**，不再复用 C2.x。

| 步 | 内容 | 出口判据（可机械验证） |
| --- | --- | --- |
| W2-a | 修测试产物重名：`context.work` / `context.marketing` 写同一个 `accept-result-context.json`，knowledge 两份同样重名 → 改成按套件名落盘 | 四个文件名互不相同；跑四套后四份 json 同时存在 |
| W2-b | `types.ts` + `budget.ts`（纯函数、无调用方） | 新增断言进现有 `context.work.accept.mjs`（不新建文件，避免 accept 清单变动）：公式、边界（0 / 负数 / 非整数窗口） |
| W2-c | `assemble.ts`（纯函数、无调用方） | 在同一次测试进程里同时加载旧引擎与新 assemble：用 marketing 真 DB 行构建两遍，**归一化 uuid/时间后**比对 `text`/`usedTokens`/`dropped` 逐字节相等 |
| W2-d | marketing 切 `assemble`（旧实现**先保留**，只切调用点） | `accept:context:marketing` **23 条**断言不改全绿；`ContextPack` 16 个顶层字段与 `budget` 子字段逐字段相等（归一化后快照断言） |
| W2-e | work 切 `assemble`；先补 work 侧等价闸（条目级 `knowledgeIncluded` 快照） | `accept:context:work` 12 条 + `qatool`/`report`/`today` 全绿；**条目级等价断言先红后绿**（证明它抓得住） |
| W2-f | 两域旧 `buildPack` 删除 | 全量 31 套；`git diff --stat` 留数（不写「行数下降」这种不可判定的话） |

#### 需要拍板的 3 个行为变化（不能藏在「重构」里）

| # | 问题 | 选项 |
| --- | --- | --- |
| P1 | work 的 `measureWith` 只测知识块；统一成整包测量后，同一窗口会**少收几条知识** | (a) 接受变化，单独提交并在 CHANGELOG 说明；(b) 给内核加「测量范围」策略，但那会引入域分支，违反参数化约束 |
| P2 | 如果内核按优先级真正截断 2–5 段（现在从不裁），work 第一次会**真的删记录/待办** | (a) 本包只做「不裁固定段」的等价重构，裁剪另立工作包；(b) 一并做，按 G5 单独提交 |
| P3 | work 第 7 段对话历史「独立预算但进文本」 | 内核只负责进预算的段；历史由域侧拼接并另行记 `usedTokens`（保持现状） |

**默认建议**：P1 选 (a)，P2 选 (a)，P3 保持现状——这样 WP2 仍是纯重构，行为变化留到 WP5。
**已拍板（2026-11-03 事实核对回写）**：P1 / P2 保持行为不变（等价重构，选择「域侧保留预算占比与 pack 开销、内核提供 `assembleLoop` + 测量回调」，不引入域分支）；P3 保持——实现见 `services/context/limits.ts` 注释与 PROGRESS 的 WP2 等价性表；`computeBudget` 已于 2026-11-03 接入两域（`window×ratio` 的地板除收敛到内核），ratio/overhead 仍留域侧。

#### 出口判据（整包）

`accept:context:work` 12 条 + `accept:context:marketing` 23 条 + `accept:knowledge:*` 33 条，**断言一条不改**全绿（合计 68 条）；
两域 `ContextPack` 归一化后逐字段相等；全量验收全绿（当时口径 31 套 / 582，现行口径见 §一）。

### WP3 · 边界硬化 + 域代码搬迁（4–5 人天）

分两阶段：**先上闸但不搬，再搬但不改逻辑**。

#### 阶段 A：闸门（1–1.5 天）

**现状**：15 条真越界 import。清单（实测）：

```
plugins/marketing/main.ts:8   ../../electron/main/marketing/runtime
plugins/marketing/main.ts:9   ../../electron/main/ipc/channelRegistrar
plugins/marketing/main.ts:10  ../../electron/main/ipc/marketing
plugins/marketing/main.ts:11  ../../electron/main/ipc/advisor
plugins/marketing/main.ts:12  ../../electron/main/ipc/scan
plugins/marketing/main.ts:13  ../../electron/main/ipc/content
plugins/marketing/main.ts:14  ../../electron/main/ipc/hot
plugins/marketing/main.ts:15  ../../electron/main/ipc/gateway
plugins/marketing/main.ts:20  ../../electron/main/ipc
plugins/marketing/main.ts:22  ../../electron/main/work/parsers/pdfjsAssets
plugins/marketing/main.ts:24  ../../electron/main/pluginDataImport
plugins/work/main.ts:10       ../../electron/main/work/runtime
plugins/work/main.ts:11       ../../electron/main/ipc/work
plugins/work/main.ts:12       ../../electron/main/work/parsers/pdfjsAssets
plugins/work/main.ts:13       ../../electron/main/work/migrate
```

> 注：这 15 条里有 2 条（两个 `pdfjsAssets`）会被 **WP1 自动消掉**（改指 `services/knowledge/parsers`）。WP3 开工时应为 **13 条**。

**C3.1 装 lint**（只装两个包，不引 vue plugin）

> **v4 校正（2026-11-02 阶段 A）**：本段**未按原文执行**。`NODE_ENV=production` 下 `npm i -D` 会删掉 devDependencies（实测 449 packages removed、双 typecheck 变红）。实际落地是零依赖脚本 [check-boundaries.mjs](../../scripts/check-boundaries.mjs) + `scripts/boundary-baseline.json`（ratchet 11/0），覆盖范围比下面的 eslint 配置更严（4 类写法 + 路径归一 + 扫描目录非空校验），并已接入 `npm run accept` 首套与 CI。下面的 eslint 方案仅作历史存档。

```powershell
npm i -D eslint@8 @typescript-eslint/parser@7 @typescript-eslint/eslint-plugin@7
```

规则只守两条边界，不开格式化（避免一次性 2,597 处分号变更）：

```js
// eslint.config.mjs
export default [
  {
    files: ['plugins/**/*.ts', 'plugins/**/*.vue'],
    ignores: ['plugins/*/plugin.json'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/electron/main/*', '!**/electron/main/kernel', '!**/electron/main/kernel/*',
                  '!**/electron/main/services', '!**/electron/main/services/*'],
          message: '插件只能经 ctx 访问宿主：仅允许 electron/main/kernel 与 electron/main/services。见 AGENTS.md §5。'
        }]
      }]
    }
  },
  {
    files: ['electron/main/**/*.ts'],
    rules: {
      // Manager 层禁止 import electron（现状 0 命中，锁住它）
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['electron'],
          importNames: ['app', 'BrowserWindow', 'ipcMain', 'dialog', 'shell', 'session'],
          message: 'Manager 层不得直接使用 Electron 副作用：由 runtime 注入 deps。见 AGENTS.md §5。'
        }]
      }]
    }
  }
]
```

**C3.2 ratchet baseline**

```json
// scripts/boundary-baseline.json
{ "pluginHostBoundary": 11, "managerElectron": 0 }
```

`scripts/check-lint-budget.mjs` 统计当前违规数，**大于 baseline 即失败**；`--update` 才写入新值（只准手动下调）。

CI 加一步：`npm run lint`（= eslint + check-lint-budget）。

**为什么用 ratchet 而不是直接开 error**：直接开 error，现有代码全红，等于逼你一次性搬完 14,500 行——那就变成"大爆炸式重构"，和 WP2 撞车。ratchet 让闸门**今天就能上**，越界数只减不增。

**阶段 A 出口判据**：新增一条越界 import 能立刻被 CI 拦住（拿上面清单里的任意一条复制到 `plugins/work/main.ts` 试一次）。

#### 阶段 B：搬迁（2.5–3.5 天）

| 提交 | 动作 | 守它的测试 |
| --- | --- | --- |
| C3.3 | `electron/main/work/**`（22 文件 7,028 行）→ `plugins/work/domain/**`（实际落地路径；原计划写 `main/**`，已在 WP3 校正）；`ipc/work.ts` 跟着走：**未做**，留 WP6（现 9 条越界） | `accept:work` `accept:record` `accept:today` `accept:report` `accept:qatool` `accept:wizard` `accept:context:work` `accept:knowledge:work` |
| C3.4 | `electron/main/marketing/**`（18 文件 7,430 行）→ `plugins/marketing/domain/**`（同上）；5 个 ipc 文件跟着走：**未做**，留 WP6 | `accept:project` `accept:business` `accept:advisor` `accept:scan` `accept:content` `accept:hot` `accept:hotscore` `accept:platform` `accept:shooting` |
| C3.5 | baseline 归零，规则升 error；`index.ts` 删域装配段 | 全量 `npm run accept`；宿主 ≤ 26,000 行 |

**关键约束**：C3.3 / C3.4 **只移动文件、改 import 路径，一行业务逻辑都不改**。逻辑改动已在 WP2 完成。这样出问题时能确定是"路径错了"而不是"逻辑坏了"。

**搬迁的技术前提（已验证）**：

1. `test/_lib.mjs` 的 `domainSrc()` **只覆盖 `plugins/<id>/main/` ↔ `electron/main/`**：硬编码 `bundleEntry('electron/main/<域>/...')` / `join(repoRoot,'electron','main',...)` 的调用不受保护。WP3 搬前必须先把这些改成 `anySrc([...])`（见 WP1 的 8 处清单与 G7 的实测口径）。
2. `tsconfig.node.json` 的 `include` 是 `plugins/*/main.ts`，需扩为 `plugins/*/main.ts` + `plugins/*/main/**/*.ts`。
3. `plugins/*/plugin.json` 的 `id` 必须与目录名一致（`gen-plugin-entries.mjs` 已强制校验）。
4. **不是「改走 domainSrc」**：两域分别搬进 `plugins/work/domain/**` 与 `plugins/marketing/domain/**`（实际落地；原计划写 `main/**`），`anySrc` 的候选数组按域给：`['plugins/work/domain/work/X','electron/main/work/X']`。开工前先 `Select-String -Path test\*.mjs -Pattern "electron/main/(work|marketing)"` 清出清单（实测域内全写法 93 处 / 22 文件）。

**顺手清掉的小债**（都在本包）：

- `plugins/shared/hostBridge.ts`（1.4KB）实际没被两个插件用起来 → 搬完统一收敛或删除。
- `electron/main/services/` 目前只有 `pluginDb.ts` 一个文件 → 搬完后它就是真正的服务层入口。

---

### WP4 · 契约补齐 + 角色归位（3–4 人天）

**问题**：`kernel/services.ts` 的 `SERVICE_NAMES` = `config / db / openclaw / notifications / voice / hostOps / legacyDb`。**没有 secrets，没有 kv，没有 cli**。所以大肥鱼（21 文件、4,940 行）只能做"宿主模块"，靠 `index.ts:2235` 起 80 多行裸函数注入（chat / generateDiary / searchKnowledge / voice.speakPcm / kv）。每加一个角色能力就往入口塞一段。

#### C4.1 补 services

| 新增服务 | 内容 | 兑现的条款 |
| --- | --- | --- |
| `secrets` | safeStorage 按 `plugin:<id>:<key>` 命名空间，只给 get/set/clear | `§4.2` / `§8.2`（`§18.3` 登记为未实现） |
| `kv` | 偏好类键值读写（替代裸 `metaGet`/`metaSet` 直传） | 让 `app_meta` 的宿主/插件边界显式化 |

#### C4.2 角色数据独立

现状：`fish:v2:*` 落在**宿主 `work.db` 的 `app_meta`**；而 work 域数据早已搬到 `plugins/work/data.db`。宿主保留 `work.db` 只为 voice + character + wizard 活着——"每插件独立库"在这里是半吊子。

动作：迁到 `data/character/db`，一次幂等导入，旧键只读保留一个版本。

#### C4.3 注入抽成 `services/characterHost.ts`

`registerCharacter(deps)` 只收契约对象，`index.ts` 再减 ~200 行。

**出口判据**：`accept:character` 全绿；停用角色后宿主 `work.db` 不再被打开；`index.ts` ≤ 1,800 行。

---

## 三、机械校验清单（每个 WP 结束都跑一遍）

| # | 检查 | 判据 |
| --- | --- | --- |
| V1 | 双 typecheck | 0 错 |
| V2 | 全量验收 | 32 套全绿（607 断言；本机已实跑含 hot） |
| V3 | 插件越界 import | ≤ `scripts/boundary-baseline.json` 的 `pluginHostBoundary`（当前 11；跑 `npm run check:boundary`，已接入 accept/CI） |
| V4 | 宿主代码量 | ≤ 目标（见 §一） |
| V5 | 重复文件 | 0 |
| V6 | Manager 不 import electron | 0 |
| V7 | 构建产物不含插件代码 | 只有 manifest + migrations |
| V8 | 渲染端无 `message.includes()` | 0 |
| V9 | 无明文密钥 | 0（`Config.vue` 的 placeholder 除外） |
| V10 | 无不可见字符 | 0 |

命令（与上表逐项对应；命令里的 `|` 不要写进表格，否则 GFM 会把表格拆坏）：

```powershell
# V3 插件越界 import（只数真违规：非 type-only、且不在 kernel/services 下）
(Get-ChildItem plugins -Recurse -Include *.ts,*.vue |
  Select-String -Pattern "from '.*electron/main/" |
  Where-Object { $_.Line -notmatch 'electron/main/(kernel|services)' -and $_.Line -notmatch 'import type' } |
  Measure-Object).Count

# V6 Manager 层
(Get-ChildItem electron\main\work,electron\main\marketing -Filter *.ts -Recurse |
  Select-String -Pattern "^import .*from 'electron'" | Measure-Object).Count

# V8
(Select-String -Path src\**\*.vue,src\**\*.ts,plugins\**\*.vue,plugins\**\*.ts `
  -Pattern "message\.includes\(" -ErrorAction SilentlyContinue | Measure-Object).Count

# V9（允许 Config.vue 的 placeholder 示例，其余一律 0）
Select-String -Path electron\**\*.ts,src\**\*.ts,src\**\*.vue `
  -Pattern "sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9\._-]{20,}" -ErrorAction SilentlyContinue

# V10（含根目录 *.md 与 doc/）
Get-ChildItem electron,src,plugins,doc -Recurse -Include *.ts,*.vue,*.mjs,*.md | ForEach-Object {
  if ((Get-Content $_.FullName -Raw -Encoding UTF8) -match "[\u200b\u200e\u200f\ufeff]") { $_.FullName }
}
Get-ChildItem *.md | ForEach-Object {
  if ((Get-Content $_.FullName -Raw -Encoding UTF8) -match "[\u200b\u200e\u200f\ufeff]") { $_.FullName }
}
```

---

## 四、与 PLAN-4.0 §18.3 的映射

| `§18.3` 登记项 | 本计划处置 |
| --- | --- |
| knowledge / context 下沉（两份独立实现） | **WP2**（C2.1–C2.4） |
| 类型化 IPC 生成 | 明确不做（不阻塞） |
| `ctx.secrets` 缺失 | **WP4**（C4.1） |
| `contributes.settings` / `commands` 无消费方 | 随 `AGENTS.md` 明确为「已校验、无消费方」，要么补实现要么移除校验——**归入 WP4 的收尾判断，不在本计划主线** |
| 插件只经 `ctx`（无 lint 兜底） | **WP3 阶段 A**（C3.1/C3.2） |
| 停用即中止在途 SSE（work 未修） | 4.0.x 独立修复，不在本计划 |
| 旧库导入失败可见 + 重试 | 4.0.x 独立修复，不在本计划 |
| work 知识库原件写全局 `<dataDir>/knowledge` | 4.0.x 或 RUNBOOK 登记 |

---

## 四·五、执行规则（G1–G10，硬规则；违反即停下来重估）

> 编号用 **G**（Gate）而不是 R：`doc/PROGRESS-4.0.md:88-101` 已有一套「R1–R12」指审查发现项，再叫 R9/R10 会歧义。

| # | 规则 | 来源 |
| --- | --- | --- |
| G1 | **HEAD 不引入新的红**：双 typecheck 0 错 + build 通过 + **相关 accept 绿**；全量 31 套按 G8 在**工作包收尾**必绿。允许的中间态：同一交互内做绿，或 `git stash` / 临时分支（临时分支上的提交可以是红的，合回前必须绿） | 2026-11-02 实测：多文件搬家中途 typecheck 报 TS2307 |
| G2 | **一次只推一个工作包**；包内每个提交都必须满足 G1（「不引入新的红」，不是「全量绿」），不跨包并行 | 避免 WP1/WP2 交叉；与 G1 取同一口径 |
| G3 | **开工前把出口判据写进文档，完成后贴实测数字**，不接受「应该没问题」 | 防止自评 |
| G4 | **搬家与改逻辑绝不放在同一个提交** | 出问题能判定是路径还是逻辑 |
| G5 | **改验收断言必须单独提交**，并写明原断言错在哪 | 防止顺手改断言来绿 |
| G6 | **工作包外发现的问题记进欠账表，不就地修** | 防止范围扩散 |
| G7 | **搬家前先把硬编码路径改成解析 helper**（独立提交、绿了再搬） | `test/*.mjs` 实测：`join` 写法 `'electron','main'` **75 处 / 24 文件**（域内 26 处 / 10 文件，**全部是 marketing**，work 0）；`bundleEntry('electron/main/...')` **158 处 / 30 文件**；代码行合计 **181 行 / 31 文件（去掉注释行后）**；域内全写法 **93 处 / 22 文件**。另有 `'electron','main','ipc'` **21 处**（WP3 搬 ipc 时受影响） |
| G8 | **每包结束跑全量 accept（31 套）**，不是只跑相关套件 | context 是 today/report/qa 的上游 |
| G9 | **每个 commit 前必须派子代理对抗审查**，逐条三态处置后才提交；提交信息带 `对抗审查:` 段（细则 `AGENTS.md §12.1`；纯提交信息修正按 §12.1 例外执行） | 2026-11-02 北拍板 |
| G10 | **每个工作包收尾派两次独立子代理检查**（一次事实核对、一次对抗复核，两次互不可见），结论写进该包的 PROGRESS 条目（细则 `AGENTS.md §12.2`）。WP 内部的阶段 A/B 不单独触发 | 2026-11-02 北拍板 |

---

## 五、决策记录

| # | 决策 | 日期 | 理由 |
| --- | --- | --- | --- |
| D1 | 大肥鱼**不装箱**成 `plugins/character`，保留宿主模块 | 2026-11-02 | 它要 `petWindow` / `screen` / `globalShortcut`，而 `§4.2` 刻意不给插件窗口控制。硬装箱会破掉"官方插件不给窗口"这条边界。做法是依赖走 service 契约（C4.3） |
| D2 | WP2 现在就做，不等第三个域 | 2026-11-02 | WP1 的三个 parsers 已证明重复实现真实存在；67 条断言是现成验收网。等第三个域才做，成本是三个域同时改 |
| D3 | 引 eslint，只装 `eslint` + `@typescript-eslint` 两个包 | 2026-11-02 | 守 import 边界不需要 vue 支持；依赖越少越容易在 CI 上跑稳 |
| D4 | 用 ratchet baseline，不直接开 error | 2026-11-02 | 直接开 error 会逼出"一次性搬 14,500 行"的大爆炸，与 WP2 撞车 |
| D5 | CI 里 `UMI_ALLOW_PACKAGE_SKIP=1` + accept 前先 build | 2026-11-02 | CI 不产出 NSIS；真机安装是 WP0-C0.3 的人工项。先保证源码级 32 套绿。accept 前必须 build，否则 packaged.smoke S1 在干净 checkout 失败 |
| D6 | 门禁用**零依赖脚本**而不是 eslint | 2026-11-02 | `NODE_ENV=production` 下 `npm i -D` 会删 devDependencies（实测 449 packages removed、双 typecheck 变红）。脚本还必须覆盖 dynamic import / export-from / require / 路径穿越（原 import 正则漏这四类） |
| D7 | 阶段 A 收尾**不夹带** WP5/WP6，先发 4.0.0 | 2026-11-02 | WP5/WP6 动启动链与 IPC 注册，是全仓最高回归风险区；先发布可把「从未被独立审查的 diff」冻结在 44 个提交（`7122a94..eed488c`）的可审规模 |

---

## 六、进度

| WP | 状态 | 完成日期 | 发布点 |
| --- | --- | --- | --- |
| WP0 | ✅ 完成（C0.3 待人工） | 2026-11-02 | 4.0.0 打 tag 前置 |
| WP1 | ✅ 完成 | 2026-11-02 | 并入 4.0.0 |
| WP2 | ✅ 完成 | 2026-11-02 | 并入 4.0.0 |
| WP3 | ✅ 完成 | 2026-11-02 | 并入 4.0.0 |
| WP4 | ✅ 完成（C4.3 判据未达，见下） | 2026-11-02 | 并入 4.0.0 |
| 阶段 A 收尾 | ✅ 完成（2026-11-02） | 2026-11-02 | 4.0.0 发布前 |
| WP7（4.0.1/4.0.2） | 🟡 7/8 完成：P1/P4/P5/P6/P7/P8 ✅（P6 于 4.0.2 补完 5 处 waitFor）；P2/P3 顺延 4.0.2 | 见 PROGRESS 4.0.1 段 | 4.0.1/4.0.2 |
| WP5（index.ts ≤1800） | ⬜ 未开始 | — | 4.1 |
| WP6（边界清零） | 🟡 W6-a 完成（11→9）；W6-b 域 ipc 搬插件 / W6-c 基线 0 待做 | 见 PROGRESS 4.1 段 | 4.1 |

> 发布点已重排：原「WP1→4.0.1 / WP2→4.0.2 / WP3→4.0.3 / WP4→4.1」不再成立——四包全部合入同一棵未发布的 `release/4.0`，且 `v1.0.0` 之后没有 tag。现在按 **4.0.0（当前 HEAD + 阶段 A 收尾）/ 4.0.1（WP7）/ 4.1（WP5+WP6）** 发布。
>
> WP4 的判据 `index.ts ≤ 1,800` 仍未达成（2,551），已如实登记，归 WP5，不算 WP4 过关。

---

## 七、4.0.0 发布前收尾（阶段 A，2026-11-02）

| # | 内容 | 证据 |
| --- | --- | --- |
| A1 | 角色旧数据一次性导入接线（C4.2 补完） | `characterKv.ts` 标记文件 + 首次以旧库为准（覆盖被默认值占住的键，覆盖前备份 `.pre-import.bak`，已有备份不覆盖）；**用户主动 reset 不重导、只有 kv.json 缺失/损坏才重导**；`index.ts` 在 `registerCharacter` 前 await 导入 + 2s 超时护栏（超时**取消本轮**，不写 kv/标记）；character 套件 78/78（新增 C73–C79） |
| A2 | 边界门禁补强 + 接入自动链路 | 修 4 类绕过（dynamic/export-from/require/路径穿越）+ 词法掩码（注释/正则字面量/字符串文案/模板内容）+ 非字面量按违规/typeof 放行；`managerElectron` 改扫 `plugins/<id>/domain`、扫描目录为空即失败；`--update` 上调必须 `--allow-raise --note`；新增 `test/boundary.accept.mjs` 8/8；`npm run accept` 首套 + CI `Boundary gate` |
| A3 | 修测试假绿 | `printResult` 在 `total=0` 时判失败；`run-all-accept` 解析子进程输出里的「验收脚本自身异常」判失败（e2e/smoke 文案已统一；2026-11-02 实测 platform 曾 0/0 假绿） |
| A4 | 文档校准 | AGENTS/PLAN/PROGRESS/CHANGELOG 的数字与进度表；`boundary-baseline.json` 说明 |

**尚未完成（阻塞 v4.0.0 tag）**：

1. C0.3 NSIS 真机 7 步（RUNBOOK §6，需人工）；
2. 重新产出 NSIS + 刷新 `release/win-unpacked`（现产物是 2026-11-01 的，smoke S6/S7 校验的是旧包）；
3. 对 `7122a94..eed488c`（**44** 个提交，阶段 A 之前的未审查范围）补一次独立对抗复核（AGENTS §12.1 流程欠账）；
4. 四件套留档必须晚于最终 HEAD。

**阶段 A 明确接受/未修的已知边界**（不阻塞 tag，登记备查）：

- **单实例锁缺失**：全仓无 `requestSingleInstanceLock`，两个应用实例同指一个 dataDir 时 `character/kv.json` 的 `tmp+rename` 无跨进程保护（旧 work.db 走 worker 串行）。（**4.0.1 已修**：`44906bd` 补锁，2 轮复核后改为「在 `setPath('userData')` 之后请求」→ 锁按实际 userData 生效；仍需 C0.3 真机双实例验证。）
- **部分丢失不重导**：只修「kv.json 缺失/损坏」；用户手工删掉部分键不会触发重导（无法与「用户主动重置」区分，有意保守）。
- **marker 损坏**：打日志并跳过（提示删除 marker+kv 后重启可重导）；不自动重导，避免误覆盖用户重置结果。
- **门禁两条已登记边界**（B8 断言锁住）：模板字符串 `${}` 内的动态 import/require 检不出；`if (cond) /re/` 这种 `)` 后的正则字面量不识别——修时同步改 B8 与 AGENTS §5.1。
- **便携 Node 低完整性（环境）**：本机 `data/runtime/node.exe` 被标 Low Mandatory Level，写不了 Medium 目录（测试已自动复制到系统临时目录规避）。**生产侧若真机 runtime 同样被标低完整性，DB 写入会失败**——打 tag 前需按 RUNBOOK 确认打包/便携 runtime 的完整性级别。
- **测试脚本重复（P3，2026-11-03 事实核对登记）**：`test/hotscore.real-smoke.mjs` 与 `test/shooting.real-smoke.mjs` 逐字节相同（不在「parsers 重复文件 0」口径内）；不影响发布，4.0.1 清理或补用途说明。

---

## 八、后续工作包（4.0.1 / 4.1）

### WP7 · 4.0.1 修复（用户可感知 ×3 + 契约/稳定性 ×5，2–3.5 人天）

| # | 修复 | 证据 |
| --- | --- | --- |
| P1 | work 停用中止在途 SSE/提醒 | marketing 有 `stopBackgroundWork()` + `abortAll*`；work 只有 `reminder.stop()`，通道摘了但流还在烧 token |
| P2 | 旧库导入失败可见 + 重试入口 | work/marketing `main.ts` 现在只 `ctx.logger.warn('下次启动重试')`，插件管理页无入口 |
| P3 | knowledge 原件路径隔离 | work 写全局 `<dataDir>/knowledge`；marketing 写 `<dataDir>/projects/<id>`；卸载/迁移会漏 |
| P4 | 单实例锁（入口 `requestSingleInstanceLock`） | 两个实例同指 dataDir 时 `character/kv.json` 的 tmp+rename 无跨进程保护（阶段 A 明确接受，4.0.1） |
| P5 | 便携 Node 低完整性自检 | 本机 `data/runtime/node.exe` 被标 Low IL，写不了 Medium 目录；打包/真机同类问题会表现为「数据存不上」。（4.0.1 只做**检测 + 日志级告警**（`dataDir/logs/runtime-probe.log`）；GUI 横幅/引导重装顺延 4.0.2。） |
| P6 | 测试 flake 台账 + 固定 sleep 清理 | e2e D3 已修（`d2f5ef9`）；`report.accept:281/305`、`content.accept:380` 等「固定 sleep + 读库断言」登记待改 |
| P7 | `ctx.kv` / `ctx.secrets` 接测试断言 | 契约已补但 **0 消费 / 0 accept 断言**（2026-11-03 task-10 P2-1）；在 `plugin.accept` 加注入 kv/secrets 的 P-check（命名空间隔离 / round-trip / safeStorage 不可用语义） |
| P8 | `pluginKv` 并发承诺与实现对齐 | 契约承诺「宿主保证并发安全」，实现是每实例整份 cache + 整文件 rename，可复现丢键（task-10 P2-2）；改为按 dataDir 共享单例 + 串行写队列，或降级承诺并写约束；补断言 |

### WP5 · index.ts ≤ 1800（3–4 人天）

- **W5-a**：`registerIpcHandlers`（`index.ts:1304–1991`，688 行 / 61 个 `ipcMain.handle`）按前缀拆到 `electron/main/ipc/host/{window,claw,config,env,skills,obsidian,terminal}.ts`，`index.ts` 只留 `registerHostIpc(deps)`；`deps` 用 **getter** 形状（`getMainWindow()` 等）保住晚初始化语义。
- **W5-b**：`initPlugins`（472–634，163 行）+ 三个服务工厂 → `electron/main/services/pluginRuntime.ts`，legacy 读库回调显式注入。
- 推演：现状 2,551 → a+b 后约 **1,730 行**；宿主 26,960 → 约 26,147（顺带达成 V4 ≤26,000）；实际以拆完为准。
- 出口判据：`(Get-Content electron\main\index.ts).Count -le 1800`；全量 32 套；61 个通道名逐条不变；双 typecheck 0。
- **不要**引 DI 容器：要注入的只有 ~10 个模块级单例，getter 形状足够且不引入无类型注册表。

### WP6 · 边界清零（2.5–3.5 人天）

- **W6-a（parts）✅ 部分完成（2026-11-03）**：gateway 纯工具已下沉 `services/gateway/parts.ts`（`textPart`/`imageDataPart`/`imageUrlPart`/`GATEWAY_ABORT_REASON` + `GatewayContentPart`），`gatewayClient` 保留 re-export；marketing 两个域 Manager 改从 services 取 → **11 → 9**。原计划中的 `constants/normalize/stream` 三个拆分**未做**（不影响边界目标，可选）。
- **W6-b**：域 ipc 文件搬进 `plugins/<id>/main/ipc/`（`ipc/*.ts` 现在反向 import 插件域类型，搬走同时消掉宿主→插件依赖）→ 9 → **0**。**需拍板**：`work:gateway` 两条通道随插件启停（与 marketing 对齐），按 G4 单独提交 + CHANGELOG 登记。清账时一并处理 `index.ts:701-983` 的 11 处 `import('plugins/work/domain/{wizardManager,reminderManager}')` 内联类型导入，以及 `electron/main/ipc/*` 的 `import type ... from plugins/<id>/domain/*`（均 type-only，运行时无耦合，但属反向依赖）。
- **W6-c**：基线写 0，`check:boundary` 从 ratchet 升为硬 error。

