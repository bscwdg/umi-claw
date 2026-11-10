# PLAN-4.2 —— 4.2 架构收尾（可执行版）

> 状态：**代码与验收完成；发布打包 / NSIS 真机 / tag 待人工**（2026-11-03 收尾）｜基线：`v4.1.0`（`54e7484`，已含 consent 单源 `f120ef7`）
> 定位：`PLAN-4.1-DEBT` 的续册。4.1 完成的是「插件化收尾（结构/边界）」，
> 4.2 做的是**宿主瘦身与残留欠账**。冲突以 `PLAN-4.0` 架构契约为准。
> 关联：`doc/PROGRESS-4.0.md`（施工日志）、`doc/RUNBOOK-4.0.md`（运维）

---

## 〇、起点实测（2026-11-03，HEAD `54e7484`；consent 单源 `f120ef7` 已包含在该 tag 内）

| 指标 | 实测 | 复核命令 | 目标 |
| --- | --- | --- | --- |
| 宿主 `electron/main` | **28,918 行 / 111 文件**（收尾时 29,038 行 / 114 文件） | `(Get-ChildItem electron\main -Recurse -Filter *.ts \| ForEach-Object { (Get-Content $_.FullName).Count } \| Measure-Object -Sum).Sum` | ≤ 26,000（已被 P1 判据取代） |
| `index.ts` | 1,791 行 | `(Get-Content electron\main\index.ts).Count` | ≤ 1,800 ✅ |
| 插件非 type 越界 | **0** | `npm run check:boundary` | 0 ✅ |
| 插件 type-only 越界 | **14** | 见 B4 扫描 | 0 |
| 全量验收 | 33 套 / 616 断言 | `npm run accept` | 不减少（复核补修后实测 33 套 / 619，见 §三） |

> ⚠️ **文档勘误**：`PLAN-4.1-DEBT §一` 记的「26,373」是 4.0.2 时期的数字，
> 4.1 的 WP5/WP6 搬家与 consent 改造后已涨到 28,918。以本表为准。

### 宿主构成（按目录）

| 目录 | 行数 | 占比 |
| --- | --- | --- |
| 根目录（14 文件） | 11,661 | 40% |
| `character/` (21) | 5,357 | 19% |
| `fish/` (20) | 3,567 | 12% |
| `services/` (24) | 3,442 | 12% |
| `kernel/` (11) | 1,920 | 7% |
| `database/` (6) | 1,291 | 4% |
| `ipc/` (13) | 1,154 | 4% |
| `obsidian/` (2) | 526 | 2% |

根目录四大文件：`clawManager` 2,322 / `downloadManager` 2,044 / `configManager` 2,025 /
`gatewayClient` 1,316 —— 合计 7,707 行，是瘦身主战场。

---

## 一、工作包

顺序按**依赖与风险**排，不按收益：先清技术债（便宜、可机械验证），再拆结构，最后做大减法。

```
B4 type-only 越界清零 ──> B3 ipc barrel 拆分 ──> B1 宿主 ≤26,000 ──> B2 GUI 诊断
   0.5 人天                0.5–1 人天            3–5 人天           0.5 人天
```

### B4 · type-only 越界清零（0.5 人天）

**问题**：插件对宿主非白名单模块有 14 处 **仅类型** 引用（门禁放过，但技术上越界）：
`gatewayClient` ×13、`database/database` ×1。契约是「插件只能经 ctx 访问宿主」，
类型依赖同样把插件与宿主实现绑死——宿主换实现，插件编译就断。

**做法**：

| 步 | 内容 | 出口判据 |
| --- | --- | --- |
| B4-a | 把插件需要的 gateway 类型抽到 `services/gateway/types.ts`（已在 services 白名单内） | 13 处引用改指新文件；双 typecheck 0 错 |
| B4-b | `database/database` 的类型（`DatabaseClient`）如需暴露，走 `PluginDbApi` 而非直接 import | 1 处清零 |
| B4-c | 门禁**升级规则**：type-only 也纳入统计（新增 `pluginHostTypeOnly` 计数） | 基线 14 → 0，之后任何新增直接红 |

**为什么先做**：改动小、无行为风险，且把门禁从「值引用」扩到「类型引用」后，
后面 B1/B3 的搬迁不会在被放过的地方埋雷。

### B3 · `ipc/index.ts` 拆 host-only barrel（0.5–1 人天）

**问题**：`ipc/index.ts` 同时 re-export 宿主通道与**插件域**通道
（`registerMarketingIpc` 等从 `plugins/marketing/main/ipc/*` 转出）。生产启动
（`index.ts:47`、`index.ts:57`）也从这里取 `abort*` 清理函数——宿主为了拿两个清理函数，
被迫依赖一个「知道所有插件内部结构」的聚合文件。

**做法**：

| 步 | 内容 | 出口判据 |
| --- | --- | --- |
| B3-a | 宿主需要的 `abort*` 清理函数下沉到 `services/pluginJobs.ts`（或各插件自注册到 ctx.onDispose） | `index.ts` 不再从 `./ipc` 取 |
| B3-b | `ipc/index.ts` 只保留**宿主自有**通道的 re-export；插件域的转出移到 `plugins/<id>/index.ts` | 生产代码对 `ipc/index.ts` 的依赖只剩 0–1 处 |
| B3-c | 若残留仅测试用，标注 `@test-only` 并在门禁里排除 | 无环、无顶层副作用 |

**判据**：`electron/main` 生产代码（非 test）对 `ipc/index.ts` 的 import ≤ 1（且为类型）。

### B1-audit 实测结论（2026-11-03，开工前的死代码审计）

**结论：26,000 这个目标在当前代码结构下不可达，前提假设是错的。**

审计方法：
1. 全仓扫描谁 import 谁（含 plugins/src/test/scripts），找「零引用」的宿主文件；
2. 逐字节相同文件比对（找真重复实现）；
3. 同名函数跨文件统计（找可疑重复）。

实测：

| 指标 | 结果 |
| --- | --- |
| 宿主文件数 | 114 |
| 被引用过的 | 111 |
| **真正零外部引用** | **3** |
| 逐字节相同的文件 | **0 对** |
| 同名函数出现在 ≥3 文件 | 1 个（`withTimeout` ×3，语义不同，非重复） |

三个零引用文件的处置：

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `index.ts` | 1778 | **不是死代码**——它是主进程入口，由 electron-vite 配置直接引用，扫描器看不到 |
| `ipc/index.ts` | 79 | 真可删（已标 @test-only，待 4.3 清测试依赖） |
| `character/stt.ts` | 66 | 真死代码（0 处生产 import；只有 `character.core.accept.mjs` 拿它做单测） |

**所以「删死代码」只能减 143 行**（且 step 2 的 143 行里 78 行是 barrel、65 行是 stt；按内容行计，
两文件以换行结尾时 `split('\n')` 会各多 1）。
删完仍有 28,972 行，距 26,000 还差 **2,972 行**。

### 宿主 29,115 行的诚实分解

| 层 | 行数 | 占比 | 性质 |
| --- | --- | --- | --- |
| 根目录（14 文件） | 11,594 | 39.8% | 壳能力：`clawManager` 2322 / `downloadManager` 2044 / `configManager` 2025 / `gatewayClient` 1262 |
| `character/` | 5,357 | 18.4% | **宿主内置域能力**（D1 决定不装箱） |
| `services/` | 3,680 | 12.6% | 能力层（4.1 新建） |
| `fish/` | 3,567 | 12.3% | 语音（跨域能力） |
| `kernel/` | 1,938 | 6.7% | 插件内核 |
| `database/` | 1,291 | 4.4% | 数据层 |
| `ipc/` | 1,162 | 4.0% | 宿主通道 |
| `obsidian/` | 526 | 1.8% | 知识库集成 |

壳/基础设施（root+kernel+ipc+database+services）= **19,665 行**
宿主内置域能力（character+fish+obsidian）= **9,450 行**

### 为什么 4.1 的「减负」没有降低总量

4.1 WP5/WP6 把 `index.ts` 从 2557 减到 1777（-780 行），但同期**新增**了
`services/` 一批文件（consent / characterKv / characterHost / pluginKv /
pluginSecrets / pluginRuntime / pluginServiceAdapters / runtimeProbe / hostUi /
gateway{parts,stream,types} / dbTypes / abortRegistry）+ `ipc/host/*` 七个文件。

净效果：**代码从 index.ts 搬到了别处，总量反而从 26,373 涨到 29,115（+2,742）**。
这正是 G12 描述的陷阱：搬家不等于瘦身。

### 超尺寸文件实测（P1 的依据）

如果采纳 P1（改判据为「单文件 ≤1500 行」），需要治理的文件实测如下
（2026-11-03 实测：全部 ts/vue 共 224 个文件，>1500 行 6 个，1000–1500 行 5 个；**2026-11-10 更新**：clawManager 已拆到 1,484 行，当前 >1,500 行 **5 个**，见 §四 #7）：

| 文件 | 行数 | 层 |
| --- | --- | --- |
| `electron/main/clawManager.ts` | 2,322 | 宿主壳 |
| `electron/main/downloadManager.ts` | 2,044 | 宿主壳 |
| `electron/main/configManager.ts` | 2,025 | 宿主壳 |
| `plugins/marketing/ui/store.ts` | 2,002 | 插件 UI |
| `src/views/voice/VoicePage.vue` | 1,843 | 宿主页面 |
| `electron/main/index.ts` | 1,801 | 宿主入口（判据 ≤1,800，**超 1 行**） |

次一档（1000–1500）：`gatewayClient` 1,262 / `character/manager` 1,135 /
`ChannelsPage.vue` 1,090 / `marketing/contentManager` 1,082 / `marketing/scanRecognizer` 1,071。

> 注：`index.ts` 1,801 比 4.1 记录的 1,777 涨了 24 行（4.2 B3 的 abort 注册表接线 +
> B2 的探针状态声明）。若 P1 采纳且判据严格为 ≤1,800，需再压 1 行。

---

### P1 已拍板（2026-11-03，北确认）

**采纳 P1：放弃「宿主总行数」指标，改用结构性判据。**

#### 新的 4.2 判据（替代 ≤26,000 总行数）

| # | 判据 | 当前实测 | 状态 |
| --- | --- | --- | --- |
| J1 | `electron/main/index.ts` ≤ 1,800 行 | **1,800** | ✅（B2 后曾涨到 1,801，已压回） |
| J2 | 单文件 ≤ 1,500 行（`index.ts` 由 J1 单独约束，不计入 J2） | **当前 5 个非 index 文件超标**（clawManager 已拆 2543→1484；含 index 共 6 个 >1,500） | ⚠️ 待治理（不阻塞发布） |
| J3 | 插件边界 `pluginHostBoundary=0` / `pluginHostTypeOnly=0` / `managerElectron=0` | 0 / 0 / 0 | ✅ |
| J4 | 全量 accept 全绿 | **33 套 / 619 PASS / 0 FAIL**（2026-11-03 复核补修后复测） | ✅ |

#### J2 待治理清单（2026-11-03 快照 · 4.2 收尾；当前状态见 §四 #7；`index.ts` 由 J1 单独约束）

| 文件 | 行数（2026-11-03 收尾快照） | 超出 | 拆分方向 |
| --- | --- | --- | --- |
| `electron/main/clawManager.ts` | 2,321 | +821 | 进程管理 / 就绪探测 / 日志 tail / adopt 复用 → 可拆 3–4 个 |
| `electron/main/downloadManager.ts` | 2,043 | +543 | 环境下载 / Node 版本 / 受管安装 → 可拆 2–3 个 |
| `electron/main/configManager.ts` | 2,024 | +524 | 配置读写 / openclaw.json 同步 / 渠道配置 → 可拆 2–3 个 |
| `plugins/marketing/ui/store.ts` | 2,001 | +501 | 按切片拆（business/knowledge/hot/content/scan） |
| `src/views/voice/VoicePage.vue` | 1,842 | +342 | 页面拆子组件（设置 / 音色 / 预算 / 克隆） |
| `electron/main/index.ts` | 1,800 | — | 由 J1（≤1,800）约束，✅ 已达标，不计入 J2 |

> J2 的治理不阻塞 4.2 发布：J1/J3/J4 已达成，J2 是**质量改进项**（登记 4.3），
> 建议按「一次拆一个文件、每拆一个跑全量」的节奏推进，不打包成一个大提交。

#### 为什么放弃总行数

实测证据（见 §B1-audit）：
- 宿主 114 个文件里**只有 3 个**零外部引用，其中 `index.ts` 是入口不算死代码；
- 逐字节相同的文件 **0 对**；可疑同名函数仅 `withTimeout`×3（语义不同）；
- **真正可删的只有 143 行**（`ipc/index.ts` 78 + `character/stt.ts` 65），
  删完仍 28,972 行，距 26,000 差 2,972；
- 4.1 的「减负」实测**总量反涨 2,742 行**（`index.ts` −780，但 `services/`+`ipc/host/`
  新增一批）——这正是 G12「搬家不等于瘦身」的实证。

结论：插件化之后「总行数」已经失真，它既不能反映模块化程度，也会诱导「为凑数字而搬家」。
**该守的是边界干净（已 0/0/0）与单文件可读性（J2）。**

---

### 三条可选路径（需拍板）

| 选项 | 做法 | 能否达 ≤26,000 | 代价 |
| --- | --- | --- | --- |
| **P1 改目标定义** | 放弃「总行数」指标，改用结构性指标：单文件 ≤1500 行（现存 5 个超标的：clawManager 2321 / downloadManager 2043 / configManager 2024 / marketing store 2001 / VoicePage 1842）+ index ≤1800（已达成）（2026-11-03 口径；**2026-11-10 更新**：clawManager 已拆 2543→1484，当前 5 个＝downloadManager 2084 / configManager 2116 / marketing store 2001 / VoicePage 2418 / CharacterPage 1970） | 不适用 | 低；承认「总量」不是有效度量 |
| **P2 外置 character/fish** | 把 `character/`(5357) 与 `fish/`(3567) 移出 `electron/main`（如 `electron/modules/`） | 是（29,115-9,450=19,665） | 中；但 **总代码量不变**，只是换目录——违反 G12 精神 |
| **P3 真删功能** | 合并 / 删除壳能力中的冗余实现（需先找出确实冗余的部分） | 待评估 | 高；需逐项确认无行为回退 |

**我的建议：P1。** 理由：
- 实测证明宿主**没有** 3,115 行冗余可删——每条代码都有消费方；
- 「总行数」这个指标在插件化之后已经失真：代码该在哪层，取决于**边界是否干净**
  （插件边界 0/0/0 已达成），而不是总行数；
- 真正该守的是「单文件可读性」（现在 4 个文件超 2000 行，这才是真问题）。

---

### B1 · 宿主 ≤ 26,000 行（3–5 人天）

**这是 4.2 的主体。** 要减 2,918 行。单纯搬文件不减少（`PLAN-4.1` 已确认「只搬不删不会下降」），
必须**真删**。三个候选方向，按性价比排：

| 方向 | 内容 | 预计减 | 风险 |
| --- | --- | --- | --- |
| B1-a | **`fish/voice` 下沉为 services 模块**（3,567 行）：它不是宿主壳能力，而是跨域能力（角色/营销都用） | 3,567 → 归属不变但可标注为 capability 层 | 低 |
| B1-b | **`character/` 精简**（5,357 行）：`manager.ts` 1,134 行偏大，可拆 store/relationship/life 各自的组合 | ~400 | 中 |
| B1-c | **根目录四巨头拆解**（7,707 行）：`clawManager`/`downloadManager`/`configManager` 内部职责混杂 | ~1,500 | 中高 |

> **注意**：B1-a「下沉」**不会减少总行数**（只是归类）。要真减，只能靠 B1-b/B1-c 的
> **合并重复 + 删死代码**。`≤26,000` 这个目标本身需要重新评估是否合理：
> 当前 28,918 里有多少是必要实现、多少是重复，得先量。

**前置**：B1 开工前先做**死代码审计**（`noUnusedLocals` 已开但只能抓文件内；跨文件未引用
需要脚本扫）。审计结果决定 B1 的真实可达目标。

### B2 · 便携 Node GUI 诊断（0.5 人天）

WP7-P5 的 GUI 部分延后至此。核心（检测 + 日志告警）已在 4.0.1 完成，
缺的是「横幅 + 引导重装」。

---

## 二、执行规则

沿用 `PLAN-4.1-DEBT §四·五` 的 G1–G10（含 G9 每提交对抗审查、G10 每包两次独立检查）。
本册补充 3 条：

| # | 规则 | 理由 |
| --- | --- | --- |
| G11 | **基线数字必须现场实测**，不引用文档历史值 | 本次实测 28,918 vs 文档 26,373，差 2,545 |
| G12 | **「下沉/搬家」不计入瘦身指标**，只有删代码才算 | 4.1 已验证「只搬不删不会下降」 |
| G13 | 目标若不可达，**先给出实测分解再改目标**，不许悄悄放宽 | 防止「26,000」变成口号 |

---

## 三、进度

| 包 | 状态 | 实测 | 发布点 |
| --- | --- | --- | --- |
| B4 | ✅ 完成（`b7c5166`） | type-only **14 → 0**；门禁新增 `pluginHostTypeOnly` 分级计数；boundary.accept 9/9 | 4.2.0 |
| B3 | ✅ 完成（`1d0728d`；⚠️ 复核补修：inject 曾漏 `abort`，注册被静默跳过，已补并加 P58 锁住） | 生产 barrel 依赖 **3 → 0**；宿主直调插件 abort **4 → 0**；abort 注册表 + 两插件自注册（补 inject 后真实生效）；barrel 标 @test-only | 4.2.0 |
| B1 | ✅ **已拍板 P1**（`e276db5` + `94e87f0`） | 判据改为结构性：J1 `index` ≤1800 **已达成(1800)**；J2 非 index 单文件（**5 个待治理**；2026-11-10 现状：clawManager 已拆，仍 5 个但名单变为 downloadManager / configManager / marketing store / VoicePage / CharacterPage）；J3 边界 0/0/0 ✓；J4 33 套 / 619 / 0 ✓（4.2 时点） | 4.2.0 |
| B2 | ✅ 完成（`5ddd44f`） | `env:runtimeProbe`（第 8 个 env 通道）+ App 横幅/一键重装；P44 通道 7→8、handler 63→64 | 4.2.0 |
| consent（4.1.0 tag 内含 `f120ef7`） | ✅ 完成（⚠️ 复核补修：work inject 曾漏 `consent`，宿主单源回落插件库；启动迁移曾只挂 afterEnable，已补） | 宿主单源 `consent:status/grant/revoke` + 完全委托 + P1–P5；启动时迁移（P1-1）；consent.accept 10/10、plugin.accept P58 锁注入 | 4.1.0（已在 tag 内） |

### 4.2 已完成部分的验收基线（2026-11-03 收尾复测，HEAD `e88b235`）

```
双 typecheck         0 错
build                通过
边界门禁             pluginHostBoundary=0 / pluginHostTypeOnly=0 / managerElectron=0
全量 accept          33 套 / 619 PASS / 0 FAIL
packaged.smoke       7/7（但 release/ 产物仍是 4.1.0；发布前需按 4.2.0 重打并重跑）
```

### B2 完成记录（`5ddd44f`）

4.0.1 已完成「检测 + 写 `dataDir/logs/runtime-probe.log`」；4.2 补齐了界面：

| 已补齐 | 落点 |
| --- | --- |
| 检测结果推到渲染端 | `index.ts` 的 `runtimeProbeState`（ok/reason/detail/at）→ `ipc/host/env.ts` 新增 `env:runtimeProbe` → preload `api.env.runtimeProbe()` |
| 权限异常横幅 | `src/App.vue` 复用旧库导入失败横幅样式；`onMounted` 立即 + 3s 各读一次 |
| 一键「重装运行环境」 | 复用既有 `env:update` 流程（停网关 → 安装 → 恢复） |

判据：人为把 `data/runtime/node.exe` 标成 Low IL → 启动后横幅可见、可点重装、日志有记录。

## 四、发布状态与待办（2026-11-03 收尾）

**代码与验收已完成；发布闭环未完成，不代做人工与用户决策项。**

| # | 事项 | 状态 / 证据 |
| --- | --- | --- |
| 1 | 4.2.0 重新打包（win-unpacked + 安装器） | ✅ 已完成（2026-11-10 19:09–19:10 实测）：`release/win-unpacked/Umi Claw.exe` FileVersion **4.2.0**（19:09:30）、`release/Umi Claw Setup 4.2.0.exe` **95,190,135 B**（19:10:12）、`release/latest.yml` `version: 4.2.0` |
| 2 | packaged.smoke 在 4.2.0 产物上重跑 | ✅ 已完成：本批最终验证轮 packaged.smoke **7/7、0 失败**（`test/accept-result-smoke.json` 是 gitignore 的最近一轮，会被后续轮覆盖，不作为固定时间戳证据）；S1–S7 全绿；S6/S7 默认取 `release/win-unpacked`（候选顺序实现见 `test/packaged.smoke.mjs`，结果 json 未记录所用路径） |
| 3 | NSIS 安装器 + Windows 真机安装 7 步（RUNBOOK §6） | ⚠️ 安装器已产出（`release/Umi Claw Setup 4.2.0.exe`，95,190,135 B）；Windows 真机 7 步待人工；`release-nsis/` 不存在（构建输出在 `release/`） |
| 4 | tag `v4.2.0` 创建 + push | ⏳ 待用户确认；本地仅 `v1.0.0` / `v4.1.0` |
| 5 | 4.2 版本级两轮独立复核入档 | ✅ 已补跑，见 `doc/PROGRESS-4.0.md`「4.2 版本级收尾复核」 |
| 6 | P45（env/claw/terminal/config 宿主通道行为级测试，4.1 结转） | ✅ 已补（2026-11-10）：新增 `test/host-ipc.accept.mjs` **31 条 check**，已注册 run-all `ACCEPT` 与 `accept:host-ipc`；残留盲区见 `doc/PROGRESS-4.0.md`「4.5 复核补充」 |
| 7 | J2 单文件治理 / `ipc/index.ts` barrel 测试依赖 / `character/stt.ts` 死代码 | ⚠️ **J2 剩余 5 个**（clawManager 已拆 2543→1484；剩 downloadManager 2084 / configManager 2116 / marketing store 2001 / VoicePage 2418 / CharacterPage 1970）；barrel/stt 已完成（4.4 收官 R3/R2） |
| 8 | 安装器文件名与 updater URL 对齐 | ⚠️ **发布通道确认项**（不是已确认的 404）。仓库**无 `electron-updater` 依赖、无 `autoUpdater` 调用**（`package.json` / `electron` / `src` / `plugins` 全 0 命中），`release/latest.yml` 只是 electron-builder 产出的构建产物（url 是连字符安全名 `Umi-Claw-Setup-4.2.0.exe`，磁盘文件名带空格）。若走 GitHub release，上传资产本就按 electron-builder 的安全名（连字符），两者一致；若改自建 feed（`build.publish` 指向自有地址），需设 `artifactName` 把磁盘名对齐到 feed 名。发布通道拍板后按该口径验收 |

### 4.3 欠账清单（登记；4.3 计划文件尚未建立）

> **2026-11-10 收官更新**：本清单的 `ipc/index.ts` barrel、`character/stt.ts`、撤销同意 UI 入口
> 已在 4.4 收官批处理完成（含 terminal-sessions 6 条、ui U26/U27 验收）；J1 回退（index.ts 涨到
> 1,813 行）已修回 1,753。剩余项与 4.4 功能边界统一登记到
> `doc/PROGRESS-4.0.md` 文末「4.5 欠账清单」，以该表为准。

- ~~**P45**：env / claw / terminal / config 宿主通道行为级测试（4.1 结转）~~ ✅ 已完成（2026-11-10：
  `test/host-ipc.accept.mjs` **31 条**，注册 run-all `ACCEPT` 与 `accept:host-ipc`）；残留盲区见 PROGRESS「4.5 复核补充」；
- **J2**：剩余 5 个非 index 单文件 >1,500 行（downloadManager 2,084 / configManager 2,116 /
  marketing-ui store 2,001 / VoicePage 2,418 / `src/character/CharacterPage.vue` 1,970；clawManager 已拆
  2,543→1,484），`index.ts` 1,753 由 J1 约束；
- ~~`electron/main/ipc/index.ts`（78 行，`@test-only`）：清测试依赖后删~~ ✅ 已完成（4.4 收官 R3 整删）；
- ~~`electron/main/character/stt.ts`（65 行）：删或写明保留理由~~ ✅ 已完成（4.4 收官 R2 已删，C56 同步移除）；
- **consent 历史撤销判定**：已降级为「已知边界」——v4.1.0 前无撤销 UI、旧 wizard 通道无调用方，
  且无 granted 时按 `no-source` 处理，不产生「撤销被复活」错误（依据见 `doc/PROGRESS-4.0.md` 4.5 第 3 条）；
- ~~**撤销同意入口**：`api.consent.revoke` 已暴露但无 UI 入口（设置页「复核用户协议」只读）~~
  ✅ 已完成（4.4 收官 R4：work 设置页 + 宿主「关于」页，U26/U27 行为级覆盖）；
- **consent 接线行为测试**：C10 是静态核对；启动迁移、委托分支、渲染端行为级用例待补。
