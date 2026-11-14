# 更新日志（CHANGELOG）

本日志记录面向使用者的版本变化。开发细节见 `PLAN-2.0.md`。

格式参考 Keep a Changelog，版本号遵循语义化版本。

---

## [4.4.0-dev]（未发布，4.3 之后）— 2026-11-14

> 主题：**大肥鱼内容质量、表情包、跨机迁移与 QQ 群聊**；同时补齐本地 TTS 与界面一致性。真机验收仍由用户执行。
> 插件化 Phase 1（utilityProcess 隔离 + 权限模型原型）并入本开发批次，**feature flag 默认关闭、4.x 不开放第三方安装**；生产 installer/签名包属 Phase 2。
> 4.5 批次的「QQ 群聊单 agent 重构」（见下方「重构与清理」）并入本未发布批次，不单独起版本号。

### 插件化 Phase 1（开发预览，flag off）
- 新增 `UMI_PLUGIN_ISOLATION` 开关（默认 off）；关闭时行为与 4.3.0 一致。
- utilityProcess 子进程协议（init/activate/invoke/service/心跳/退出）与 supervisor 状态机（崩溃退避、5min 熔断、disabled 安全态）。
- manifest 权限（fs/network/services）、默认拒绝 broker、授权持久化/撤销、审计日志、`NODE_OPTIONS` 权限注入、服务桥（ctx.services JSON RPC）。
- 真机负向验证：fs 越界、spawn、worker、dlopen 被拦；宿主 env/数据目录/密钥不泄漏。
- 开发者模式闸门 `UMI_DEV_PLUGINS` / `UMI_DEV_BUILD`（打包版拒绝；仅闸门，不扫描/不加载）。
- 验收：52 套 / 896 项（895 通过 + 1 显式跳过）+ node:test 21；Phase 1 出口口径见 `doc/PLAN-5.0-EXTENSIBILITY.md` §4.1。

### 新增
- **主动消息内容引擎**：每轮 2–10 条候选（生活三卡 + 20 个话题 + 约 100 句台词 + 关系试探），
  精确 hash + 3-gram 近似（>0.72）去重、话题/句式冷却；不再固定复读生活卡第一句。
- **未回复状态机**：未回 0 正常分享；未回 1 按 `relationship.mode` 轻试探（恋人「在忙吗？我想你了」/
  「人呢，怎么不理我」），同 family 48h、同日 1 次；未回 2 换话题；≥3 backoff；用户互动即重置。
- **主动消息频率**：固定/随机间隔（1–720 分钟；1–10、10–30、30–60 分钟，1–3、3–6 小时等区间），
  每日上限最高 60；跨天沿用间隔/去重/未回状态，改设置立即重算今日闸值。
- **表情包**：角色页导入 PNG/JPEG/GIF/WebP（≤10MB、最多 200 张、sha256 去重），情绪/标签/启用/
  归档删除；QQ 发图 `file_type=1` + `msg_type=7`，主动消息文字送达后约 20% 按情绪补图。
- **单文件备份**：角色页导出/导入 zip（设置/状态/关系/解锁/桌宠状态 + 人格 + workspace 日记 + 表情包），
  不含密钥/token/截图/日志/桌宠自定义形象；zip-slip 防护、导入前自动备份、失败回滚、恢复后重载内存态。
- **外部 TTS**：`/models` 404/405 时按“可达待试听”处理（weak 橙色提示，不判失败）；
  新增 Voicebox 原生 `17493` 支持（`/profiles` + `/generate/stream`，自动取 `preset_engine`、固定 WAV）。
- **界面统一**：保存按钮按主题色统一，修复大肥鱼设置页子组件保存按钮显示灰色的问题。
- **QQ 群聊**：私聊与群聊统一由 `feiyu` 一个 agent 处理（删除 4.4 初版的独立 `feiyu-group` agent：
  同一 qqbot 渠道被两个 agent 抢会让渠道页误判「占用」，保存别的渠道还会断开私聊）。群聊行为改为
  可扩展的 **GroupPolicy v1**：回复开关、是否必须 @、群语音开关与每群每天上限、亲密词过滤（替换/拦截）、
  群聊记忆隔离、群历史条数、额外群提示词；默认群语音关、每群每天 2 条、亲密词
  `宝宝/宝贝/亲爱的/老公/老婆/主人`。策略由宿主编译进 `channels.qqbot.groups["*"]` 与随包
  OpenClaw 插件 `feiyu-guard`（`plugins.load.paths` 加载）；插件用官方 hook 只对 QQ 群硬执行
  （`message_sending` 词过滤/回复取消、`reply_payload_sending` 渠道语音、`before_tool_call`
  群语音上传与记忆写入），私聊/未知会话一律放行。群聊称呼仍只用群昵称/「你」，不写私聊日记与长期记忆。
  开启群回复会保留既有 `groupPolicy=allowlist`（不会静默放开所有群，只有原本非白名单才写 `open`）。
  群策略配置由宿主直接读改写 `openclaw.json`（不进 config patch CLI 队列，网关运行时也不会卡配置锁），
  保存后重启网关生效。
- **主动消息质量与渠道**：主动消息改发已绑定渠道、QQ 主动文本直发；话题库从 20 张扩到 40 张并按时段过滤，
  发送前参考最近聊天选话题；生活卡不再硬拼动作旁白；每 6 小时重置后真正开启新一轮，不再复读语料碎片。
- **本地 TTS 表单**：实例可保存、可测试（必填校验、草稿探活、协议补全），按本机适配器在线状态预填默认值；
  原「外部 TTS」统一更名为「本地 TTS」。
- **撤销用户协议入口**：工作设置页「用户协议」卡与宿主「关于」页均在已同意时提供「撤销同意」，
  二次确认后走宿主 `consent:revoke` 单源通道；宿主入口不依赖 work 插件（停用后仍可撤销/查看）。
  撤销后 OpenClaw 无法启动、本地数据不删除，随时可重新同意恢复。

### 修复
- 记忆日记 tags 归一化，修复 `frontmatter.tags 缺少 大肥鱼/日记` 导致写不进 Obsidian；已有 11-07/11-08 日记回填。
- 主动消息跨天 `sentTimes` 合并重复导致未回计数翻倍、提前 backoff。
- 备份 zip bomb：拒绝 `declared=0` 且带压缩数据的条目，并校验实际解包大小。
- 备份导入后 manager 旧内存态覆盖恢复数据；导入后 `reloadFromStore()` 重载 settings/state。
- 表情包自动配图情绪映射中英文不一致导致永远匹配不到；统一为 happy/shy/angry/sad/surprised/miss/sleepy。
- OpenClaw 启动卡在 preparing：插件隔离副本先摘 junction 再改名/删除，整段清理带超时，慢盘/安全软件环境不再挂死。
- QQ 扫码登录前先确保渠道插件已安装并启用，失败不再空跑登录流程。
- 网关 `npm install` 的缓存落到便携 `.npmrc`，不再写用户级 npm 缓存（规避 EPERM）。
- 聊天渠道保存不再把 Vue 代理对象传给 IPC（DataCloneError）。
- 群聊配置同步改在网关 bootstrap 之后串行执行，避免并发 config patch 撞锁（bootstrap 在途时保存
  设置会挂起同步、完成后再补）；话题 hook 按陈述/问句补标点；解冻被冻结的主动消息调度。

### 测试
- `accept:character` 103/103；`accept:sticker` 12/12；`accept:external-tts` 10/10；`accept:ui` 27/27；
  `accept:terminal-sessions` 6/6；新增 `accept:host-ipc` 31/31（env/claw/terminal/config 宿主通道行为级，
  即 P45）、`accept:group-policy` 11/11、`accept:group-config` 14/14、`accept:guard-plugin` 36/36；
  `typecheck:node/web` 0 错；`build` 成功；`check:boundary` 全 0。
- 2026-11-11 最终轮全量复测：**40 套（accept×38 + e2e + smoke）773 条断言 / 0 失败**
  （Recorder 口径：40 个套件 result 求和，不含汇总文件 `accept-result.json` 与 `openclaw-config-writer`
  的 21 条 node:test），packaged smoke 7/7；群聊 patch 另用 `openclaw config patch --dry-run` 在真实
  配置上验过（schema ok、22 个操作；bindings 取自 openclaw.json 全量，保留 ACP/comment）。
- 本轮首测暴露的 `claw-maintenance` 失败项 `plugin-captures-cleanup` **不是环境问题，而是测试断言
  写错了**：原断言 `!existsSync(rename 后的新目标路径)`，但目标目录随整棵树 rename 后必然存在于新位置、
  junction 可用时结构性必红；已改为断言原目标 `built.target` 不存在。修复后首次真正执行「悬空 junction
  的 `.stale-` 副本清理」路径（生产侧未出现卡死），`accept:maintenance` 现 30/30。
  （4.4 基线记录的 677/678 是另一条 `ghost-node-cleanup` 的 WMI/CIM 环境问题，本轮实测该检查 PASS、
  未再复现，两者不要混谈。）

### 重构与清理
- 终端/PTY 会话注册表从主进程入口抽到 `electron/main/terminalSessions.ts`（纯 Node 工厂），
  `index.ts` 从 1,813 行降回 1,753 行，重新满足 J1（≤1,800）判据。
- 删除死代码 `character/stt.ts`（生产零引用）与 `ipc/index.ts` 兼容 barrel（生产依赖 4.2 已归零），
  相关验收断言改指真实模块。
- `clawManager.ts` 2,543 → **1,484 行**：抽出 `electron/main/claw/` 13 个模块（deps/status/probe/
  timeout/spawnEnv/gatewayRuntime/schema/migrations/skills/doctor/reclaim/rollback/types），
  行为零变化，契约与源码断言全保留。
- 群聊单 agent 化：删 `electron/main/character/groupAgent.ts`，新增 `groupPolicy.ts`
  （GroupSettings v1 + 迁移/夹紧 + 群提示词）、`services/characterGroupConfig.ts`（策略 →
  `channels.qqbot.groups["*"]` + `plugins.load.paths`/`plugins.entries["feiyu-guard"]` 的唯一编译/落盘点）
  与随包 `resources/openclaw-plugins/feiyu-guard`（OpenClaw hook 插件：`message_sending` /
  `reply_payload_sending` / `before_tool_call`，只对 QQ 群生效、fail-open）。旧 `feiyu-group` 的
  agent 条目/绑定在启动同步时清理；旧 `workspace-feiyu-group`/`agents/feiyu-group` 与 guard 计数
  状态只在「删除全部数据」时清理。
  存在角色管理的 `groups["*"]` 后，`configManager` 不再用 app.json 旧表单覆盖群聊策略（双真源防护）。

### 已知残差（登记 4.5，不阻塞发版）
- J2 剩余 5 个单文件 >1,500 行未拆（`clawManager.ts` 已拆 2,543 → 1,484，退出名单）：
  `downloadManager.ts` 2,084 / `configManager.ts` 2,127 / marketing `store.ts` 2,001 /
  `VoicePage.vue` 2,418 / `src/character/CharacterPage.vue` 1,970（11-04 `bf84d1f` 起越线）。
- P45 已补 `accept:host-ipc` 31 条（env/claw/terminal/config 行为级）；残留盲区 2 项
  （边界门禁不扫 `electron/main/claw/**`、`getStatus` 的 getConfig 合并判定）登记 4.5。
- consent 历史撤销判定已降级为「已知边界」：v4.1.0 前无撤销 UI、`work:wizard:revokeConsent`
  旧通道无调用方，且 `services/consent.ts` 无 granted 时按 `no-source` 处理，不会产生「撤销被复活」
  错误（详见 `doc/PROGRESS-4.0.md` 4.5 第 3 条）；启动迁移/委托分支仍只有静态断言
  （渲染端撤销流程已由 U26/U27 行为级覆盖）。
- 4.4 功能边界（MCP 无 tag 检索软约束、桌宠接线推迟、批量删除非事务等）
  详见 `doc/PROGRESS-4.0.md` 的 4.4「已知边界」与 4.5 欠账清单。
- 群聊硬拦截由 `feiyu-guard` hook 覆盖（词/回复/语音/记忆写入），仍有边界：记忆隔离只拦
  `write`/`edit`/`apply_patch`（`exec`、cron、memory 专用工具拦不到）；语音识别依赖 ReplyPayload 的
  `audioAsVoice`/`attachments` 元数据（类型丢失时 fail-open 放行）；词过滤是字面 includes；
  真实 QQ 群全链路仍需用户配好凭据后手工验收。

---

## [4.3.0]（未发布，4.2.0 之后）— 2026-11-13

> 主题：**大肥鱼功能补齐**（设置页 / 人格包 / 知识导入）+ **插件化 Phase 0**（API v1 / SDK / 官方插件迁移）。真机手工验收由用户执行。

### 新增
- **角色详细设置页**：主动消息、语音、记忆、关系等已接线参数可直接编辑；未接线项显式 disabled；
  保存带 dirty 保护（不会被状态刷新覆盖未保存修改）。
- **人格包导出/导入**：SOUL/IDENTITY/AGENTS/USER 可备份/迁移；导入前自动备份（保留 3 份），
  校验上限 512KB/文件、2MB/包；AGENTS.md 自动维护「记忆与日记」段与安全边界硬段（AI 明示/危机转介
  不可被导入移除），连续同步不再增长。
- **桌宠形象可导入**：角色页「桌宠形象」支持导入自己的 PNG / JPEG / WebP / GIF（动图会动，≤8MB，
  只做魔数校验、拒绝 SVG），导入后角色页立即预览；桌宠窗口接线恢复后自动使用；可一键恢复默认。
- **记忆与关系管理**：角色页可查看/修正最近 30 天日记、约定/大事记；日记可编辑（只改本地记忆），
  单条删除走归档（不物理删除），不再只能「全部删除」。
- **知识体检 / 检索作用域**：角色页显示 vault/MCP/索引/`大肥鱼/` 笔记数，明确「她现在能不能检索到」；host 预检索只取 `大肥鱼/`，MCP 检索/读取排除 `大肥鱼/归档/`（删除记忆不可回忆），tag 过滤改嵌套前缀匹配（`tag=大肥鱼` 命中 `大肥鱼/*`）；AGENTS 指令限定只查该目录（工具级无 tag 检索仍为软约束，登记 4.4）。
- **本地结构化记忆召回**：问「之前/昨天/约定」时，宿主直接读最近 5 天日记 + 约定/大事记注入上下文，
  不依赖 Obsidian 索引也能记得住；MCP 语义检索仍叠加。
- **知识导入**：把 .md/.txt 写进既有 Obsidian vault 的 `大肥鱼/世界书|角色卡|关系/约定/`（不新增知识库），
  带 frontmatter、同名不覆盖（加序号）、路径穿越/保留名防护、20 个/512KB/2MB 限流；
  导入后可一键重建索引。
- **多渠道聊天**：角色页新增「聊天渠道」，可勾选已配置的单账号外部渠道（QQ / 飞书 / 企微 / 微信…），
  把该渠道内被渠道策略放行的会话（含群聊）路由给大肥鱼（文本）；写 OpenClaw bindings 走官方 CLI
  `agents bind/unbind`，只增删应用创建的 channel 级绑定（用户手工配的 account/peer 绑定保留），
  保存失败回滚，保存后回读校验；多账号/被其它 agent 默认账号或 peer 规则占用的渠道显示为不可选；
  停用只断开应用内勾选的渠道，删除全部才清 feiyu 全部绑定。保存后需重启 OpenClaw 网关生效。
  语音条仍是单向外发，入站语音 STT 未接线。

### 修复
- 设置页不会再用「能点但无效」的假开关（未接线字段全部 disabled 并说明）。
- 旧人格被模板覆盖 / 伪造边界标记绕过 AI 明示 / AGENTS 每次同步增长 4 字节等隐患已修。
- **批量删除不再硬删本机日记**：角色页「删除日记与关系」把 workspace `memory/` 归档到
  `memory-archive/<ts>/memory/`（无 Obsidian vault 时也能找回）；Obsidian 日记/关系笔记仍归档到
  `大肥鱼/归档/`；归档失败保留原目录，不回退硬删。
- **删除全部不再静默成功**：workspace 文件（SOUL/IDENTITY/AGENTS/USER/人格备份等）删除失败时
  收集失败并回传 warning，UI 会显示「清理未完全成功」而不是「全部已删除」。

### 插件化（PLAN-5.0 Phase 0）
- **插件 API v1-RC**：`doc/PLUGIN-API.md` 公开面收窄；`plugin-sdk/` 提供 public / official-* / client* / testing 分层，官方插件全部改从 SDK 引入（host 直连 import 62→0，UI `@/` 直连 23→4，4 处 ConfirmDialog `.vue` 例外）。
- **契约收敛**：migrations DDL 白名单、`ctx.db.request` 表级白名单、会话键 resolver 拆反向依赖、`apiVersion`/`engines.host` 注册期兼容检查、状态文件 schema v1、插件 IPC 统一信封示例。
- **契约测试 / 模板**：新增 `test/plugin-contract.accept.mjs` 与 `templates/plugin/`；`check-plugin-api` ratchet 锁死 host/UI 耦合只准降。
- **边界**：4.x 仍只支持官方内置插件；**不开放第三方安装**，第三方签名/权限/隔离在 5.0 Phase 1+ 继续。

### 测试
- 全量 **54 套 / 903 项检查（902 通过 + 1 显式跳过） / 0 失败**；plugin 71/71；plugin-contract 3/3；plugin-api 3/3；ui 28/28；character 110/110；启动级 E2E 1/1。

---

## [4.2.0]（待发布，4.1.0 之后）— 2026-11-03

> `package.json` / `package-lock.json` version = **4.2.0**；tag 尚未创建。
> 安装包/`win-unpacked` 仍是 **4.1.0** 产物（版本号 bump 之前打的包），正式发布前需按 4.2.0 重打；NSIS 真机安装仍待人工。
>
> 主题：**架构收尾（对使用者零行为变化，除一项体验改善）**。
> 完成 4.1 遗留的残留越界、反向依赖与便携环境诊断三块。

### 体验
- **便携运行环境异常可见**（B2）：便携 Node 被系统限制写入（低完整性 / 目录只读，
  历史实测会让数据库报 `readonly database`、用户只看到「数据存不上」）时，
  现在会在应用顶部显示横幅说明原因，并提供「重装运行环境」按钮（复用既有环境更新流程）。
  此前只有 `data/logs/runtime-probe.log` 一条日志，打包版用户看不到。

### 重构（无行为变化）
- **插件类型依赖清零**（B4）：插件对宿主的 14 处仅类型引用（`gatewayClient` ×13、
  `database/database` ×1）改为引用 `services/gateway/types`、`services/dbTypes`
  的窄接口。边界门禁新增 `pluginHostTypeOnly` 分级计数（当前 0）。
- **拆除宿主对插件域的反向依赖**（B3）：退出流程原先直接调用插件内部
  `abortAllAdvisorStreams` / `abortAllScanStreams` / `abortAllContentGenerations` /
  `abortHotCollectors`（实体在 marketing 插件里）。现在插件在 activate 时自注册
  「中止我的后台任务」，宿主统一 `abortRegistry.abortAll()`。
  `ipc/index.ts` 已标注 `@test-only`（生产依赖归零）。
  （复核补修：两插件 `plugin.json` 的 `inject` 补 `abort`——此前未声明，自注册被静默跳过、
  退出兜底为空；`plugin.accept` 新增 P58 锁「ctx.services 使用 ⊆ inject」。）
- **宿主任意行数指标退役**（B1）：实测宿主 114 文件里仅 3 个零外部引用
  （其中 `index.ts` 是入口），逐字节相同文件 0 对，真可删仅 143 行。
  「总行数」已无法反映模块化程度，改用结构性判据：`index.ts` ≤1,800（4.2 时 **1,800**；4.4 收官后 **1,753**）、
  非 index 单文件 ≤1,500（5 个文件待治理，不阻塞发布）、插件边界 0/0/0。

### 验收
- 双 typecheck 0 错；build 通过；插件边界 `pluginHostBoundary=0` /
  `pluginHostTypeOnly=0` / `managerElectron=0`
- 全量 33 套 **619 PASS / 0 FAIL**（2026-11-03 复核补修后复测；`packaged.smoke` 7/7，
  但验证的是 4.1.0 产物）

### 补充说明（版本口径）
- `v4.1.0` tag（`54e7484`）内含 `f120ef7`「用户协议闸门改宿主单源」
  （提交信息标 `4.1.1`，但 4.1.0 发布说明未单列条目；行为见下）：
  work 插件停用/撤销同意不再导致协议闸门静默失效，`assertConsent()` 与渲染端统一读宿主
  `work.db` 的 `app_meta`，`consent:status/grant/revoke` 为宿主通道，work 插件经
  `ctx.services.consent` 完全委托；`consent.accept` C1–C10 覆盖墓碑、迁移、停用态与撤销。
  （复核补修：work `plugin.json` 的 `inject` 补 `consent`——此前未声明导致
  `ctx.services.consent` 为 undefined、回落插件自库，宿主单源与撤销语义不生效；
  另启动时补跑一次插件库→宿主库迁移，覆盖「work 已启用直接升级启动」的用户，
  避免被重复要求同意 / autoStart 被拦。）

### 已知残差（登记 4.3，不阻塞 4.2 发布）
- J2 单文件 >1,500 行：`clawManager.ts` 2,321 / `downloadManager.ts` 2,043 /
  `configManager.ts` 2,024 / `plugins/marketing/ui/store.ts` 2,001 / `VoicePage.vue` 1,842
  （`index.ts` 1,800 由 J1 约束）；
- `electron/main/ipc/index.ts`（78 行，`@test-only` barrel）待清测试依赖后删除；
- `electron/main/character/stt.ts`（65 行，仅单测引用）待删或写明保留理由；
- **P45**：4.1 结转的 env/claw/terminal/config 宿主通道行为级测试仍未补（4.2 时点；**2026-11-10 已补** `test/host-ipc.accept.mjs` 31 条，见 4.4 测试段）；
- **consent 历史撤销判定**：3.0 升级且 4.0 期间点过撤销的用户，宿主库仍是历史 `granted`、
  无墓碑可判，无法自动区分；需产品定复核策略；
- **撤销入口**：`api.consent.revoke` 已在 preload 暴露，但设置页/宿主 UI 尚无调用入口；
- **consent 接线行为测试**：C10 目前是静态核对；启动迁移、委托分支、渲染端仍缺行为级用例。

### 发布状态
- tag `v4.2.0` 未创建（本地仅 `v1.0.0` / `v4.1.0`）；4.2.0 安装器/`win-unpacked`
  需重新打包；NSIS 与 Windows 真机安装 7 步（RUNBOOK §6）待人工。
- 重打时注意安装器文件名：`release/latest.yml` 的 url 是连字符名
  （`Umi-Claw-Setup-4.1.0.exe`），磁盘实际是 `Umi Claw Setup 4.1.0.exe`（`package.json`
  的 build 未设 `artifactName`）——不对齐会让 4.2.0 自动更新指向不存在的文件。

---

## [4.1.0]（已发布，4.0.2 之后）— 2026-11-03

> `package.json` version = **4.1.0**；tag `v4.1.0` 已打（发布证据见 PROGRESS「4.1 版本级收尾」）。
> 补充：本 tag 内含 `f120ef7`「用户协议闸门改宿主单源」（提交信息标 `4.1.1`，
> 当时发布说明未单列；细节见 4.2.0「补充说明（版本口径）」）。

> 主题：**架构收口（无用户可见行为变化）**。完成 4.0 遗留的组装层与插件边界两块欠账。

### 重构
- **插件边界清零**：域 IPC 全部搬进 `plugins/<id>/main/ipc/`（work 1 个文件 + marketing 8 个文件：6 个搬迁 + gateway 拆分 + ipcTypes，另 services 新增 hostUi），`check:boundary` 从 9 条越界收紧到 **0（硬约束）**；插件不再 import electron，
  宿主 electron 能力经 `services/hostUi`、流透传经 `services/gateway/stream` 注入。
- **宿主装配瘦身**：`electron/main/index.ts` 2,551 → **1,777 行**（≤1,800 目标达成；4.0.2 P2 加 10 行）；61 个 host IPC（4.0.2 P2 起 +2 条 import 通道 = 63）
  拆到 `electron/main/ipc/host/*`，插件装配抽到 `services/pluginRuntime`，宿主服务适配器抽到
  `services/pluginServiceAdapters`。
- 副作用：宿主 `electron/main` 27,463 → **26,373 行**（4.0.2 P2 后；离 V4 ≤26,000 差 373，后续删减）。

### 已知残差（登记 4.2）
- `electron/main/ipc/index.ts` 仍 re-export 插件 registrar（host→plugin 兼容依赖，无环）
  → 4.2 B3 已拆除生产依赖并标 `@test-only`，测试依赖清理登记 4.3；
- 14 处 type-only 宿主类型引用（门禁口径「非 type 越界 0」）→ 4.2 B4 已清零（`pluginHostTypeOnly=0`）；
- 拆分后 env/claw/terminal/config 等宿主通道的行为级测试仍待补（P45）→ 4.2 未做，登记 4.3
  （2026-11-10 已补：`accept:host-ipc` 31 条）。

---

## [4.0.2]（未发布，4.0.1 之后）— 2026-11-03

> 主题：**数据归属收口 + 测试稳定性**。

### 修复
- **work 知识库原件收进插件目录**：新导入写 `<dataDir>/plugins/work/knowledge/<id>/`（与 marketing 的
  `projects/<id>/` 同口径），不再写全局 `<dataDir>/knowledge/`；`source_path` 仍存相对 dataDir。
  **旧文件不自动迁移**：旧条目照常可读（原件只作溯源），旧 `<dataDir>/knowledge` 可手工清理；
  只有新导入进插件目录。
- 测试稳定性：report/content 收尾处 5 处固定 sleep 改 `waitFor`（异步落库/断连/注册表清空不再赌时间）。
- **旧库导入失败对用户可见 + 一键重试**：导入结果写 `<dataDir>/plugins/<id>/import-status.json`；宿主壳
  顶部横幅展示失败原因并提供「重试导入」（`plugin:import:status` / `plugin:import:retry`），重试走插件
  注册的执行器（强制绕过 `.imported` 标记，幂等 upsert）；插件停用即摘除执行器。

### 测试
- 全量验收 32 套 / **607 条断言**；knowledge.work 10/10、knowledge.marketing 23/23

### 已知未做（并入 4.2，4.0.2 不阻塞）
- P5 便携 Node 探针的 GUI 诊断横幅/引导重装入口（当前写日志文件）

---

## [4.0.1]（未发布，待 v4.0.0 tag 之后）— 2026-11-03

> 主题：**停用即止损 + 数据安全加固 + 启动可诊断**。全部为用户可感知或数据安全相关的补丁。

### 修复
- **work 插件停用/退出时中止全部在途 SSE**（问答 / 工具箱 / 日报 / OpenClaw 总结）：之前只停提醒循环，
  通道摘掉后模型仍在产出、继续烧 token；停用中止不计入当天自动总结尝试配额
- **单实例锁**：第二个实例直接退出并把启动请求转给已有窗口；避免两个实例同写 `character/kv.json`
  与插件 KV（跨进程无保护）；锁在 `app.setPath('userData', …)` 之后请求（按实际 userData 生效，
  便携版与安装版互不误伤）；`whenReady` 加守卫，quit 后不会再建窗口/拉 DB worker
- **停用中止不消耗自动总结配额**：停用中止的总结不计入「当天 3 次」；并复位 abort 标志，
  防微任务窗口残留把下一次真实失败误判成「停用中止」
- **pluginKv 并发写不丢键**：同 dataDir 的多个插件实例共享缓存 + 串行写队列（之前后写者会整份抹掉
  先写者的键）；写盘成功后才更新缓存
- **便携 Node 写入探针**：启动时用便携 Node 自检能否写 dataDir（低完整性/只读环境会表现为
  「数据存不上」）；失败区分 EPERM 与超时，告警写入 `<dataDir>/logs/runtime-probe.log`

### 测试
- `ctx.kv` / `ctx.secrets` 首次有真实 ctx 注入断言（命名空间隔离 / round-trip / safeStorage 不可用拒绝）
- 新增 T7/P13/S16/P56/P57/C80/N8：停用中止、单实例锁、探针、pluginKv 并发
- 修复跨午夜假失败（`openclaw-summary` S12 假时钟）与 e2e 固定 sleep 时序 flake（waitFor）
- 全量验收 32 套 / **607 条断言**

### 已知未做（顺延 4.0.2；其中 knowledge 隔离与 P2 已在 4.0.2 完成，P5 GUI 延伸并入 4.2）
- 旧库导入失败的用户可见状态与「重试导入」入口（当前只有日志）
- work 知识库原件路径隔离（仍在全局 `<dataDir>/knowledge`）
- 便携 Node 探针的 GUI 诊断横幅/引导重装入口（当前写日志文件）

---

## [4.0.0]（release/4.0，开发中：阶段 A 已收尾，待 C0.3 真机安装后打 tag）— 2026-11-02

> 主题：**插件化宿主** + 启动可靠性/性能优化。一套代码通过官方内置插件组合出营销（2.0）/ 工作（3.0）能力。

### 插件化
- 控制台（`/dashboard`）与能力中心（`/skills`）导航；插件运行期启停、懒加载、独立路由/IPC/数据迁移
- 2.0 营销域、3.0 工作域装箱为官方内置插件；宿主保留 OpenClaw 管理/渠道/终端/Obsidian/技能/更新等壳能力
- 宿主服务下沉（db / knowledge / context / voice），插件通过 `ctx` 使用，配置与密钥归宿主（gateway 客户端仍在宿主侧，按 WP6/4.1 再下沉）
- work / marketing 域代码搬到 `plugins/<id>/domain/`；重复的文档解析器合并为 `services/knowledge`，
  上下文取舍循环收敛为 `services/context` 内核（两域共用，域侧只提供回调）
- 插件契约补 `secrets` / `kv`（4.0 只有接口：当前无插件消费、无 accept 断言，消费与断言归 4.1）；角色数据迁到 `<dataDir>/character/kv.json`
  （旧 `fish:v2:*` 一次性导入，标记文件防重复；首次导入以旧库为准，可覆盖早期版本的默认值）
- 边界门禁 `scripts/check-boundaries.mjs`（零依赖 ratchet：pluginHostBoundary=11 / managerElectron=0），
  已接入全量验收首套与 CI，覆盖静态 import / export-from / 动态 import / require / 路径穿越

### 启动可靠性与性能
- **就绪态与阶段可视化**：`running`（进程）与 `ready`（/health 200）分离；点击启动即「启动中」；
  Dashboard 展示 preparing/spawning/loading/ready 与预计剩余时间；`statusChange` 推送 `bootPhase/estimateStartupMs`
- **webhook 迁移标记兜底**：无 `legacyWebhook` 时自动补 `meta.migrations.webhookListeners=true`，
  避免每次启动重跑旧迁移（实测可省约 185s 级）；备份 + 原子写回退 + BOM/CRLF 保留，走官方写入串行队列
- **退出应用时保留网关（可选，默认关）**：网关 detached + 日志文件；退出应用不停网关，
  下次启动校验端口 owner / openclaw 版本 / 健康后直接复用（跳过数分钟冷启动）
- **启动 ETA**：记录最近 5 次启动耗时，样本 ≤2 用最近一次、≥3 取最近 3 次中位数
- **网关日志文件 tail**：增量读取、半行 carry、截断检测、stdout/stderr 分流、兼容 pino `msg`
- **语音音色热更**：改音色无需重启网关（`data/voice/tts-bridge.json`，桥接脚本每次合成读取）；
  Key / TTS 模式 / 通道变更仍需重启
- 环境开关：`OPENCLAW_GATEWAY_STARTUP_TRACE` 默认关（`CLAW_OC_STARTUP_TRACE=1` 开启）、
  `OPENCLAW_FS_SAFE_NATIVE_MODE` 覆盖值白名单、`NODE_COMPILE_CACHE` 落 data/cache 并 >512MB 后台清理

### 修复
- adopt 复用网关时不再显示异常的「本次启动耗时」
- 编译缓存清理覆盖默认配置（keep=false 用户同样写缓存）
- 串行配置写入避免任务 reject 时的 unhandledRejection
- 渲染端 `AppConfig` 补 `keepGatewayOnQuit` 字段

### 验收
- 32 套（accept×30 + e2e + smoke）/ 600 条断言；双 typecheck 0 错、build 通过
- 本机 `npm run accept` 全绿（含 hot）；便携 Node 若带低完整性标签（写不了 `test/.tmp`），验收会自动复制到系统临时目录再用（见 `test/_lib.mjs:resolveNodePath`）

---
## [2.0.0]（release/2.0 分支，待发布）

> 主题：从「OpenClaw 管理器」升级为「**AI 营销工作台**」。
> 在不改动原有 OpenClaw 管理能力的前提下，新增一套面向实体店老板的线上获客工具。

### ✨ 全新功能

**营销工作台（新）**
- **商家管理**：可建立多个商家档案（Project），一键切换；每个商家的数据与文件独立隔离，互不串味。
- **商家大脑**：集中填写品牌、定位、客群、语气、关注词等信息，AI 回答和创作时自动带上，不用反复解释"我是谁"。
- **关注词（Watchlist）**：手工维护行业/关注点词库，作为 AI 问答与内容生成的上下文，并支持 AI 推荐扩词、勾选采纳。
- **知识库**：导入文字、Markdown、Word、Excel、PDF、网址链接、FAQ 等资料，本地解析入库，支持关键词检索与资料完整度提示；大文件保留原件。
- **扫描件 AI 识别**：扫描版 PDF / 纯图片资料可显式触发 AI 文字识别，经人工确认后入库。

**AI 创作（新）**
- **AI 顾问（Advisor）**：基于本商家资料的问答，回答有出处、不瞎编；资料不足时主动提示要补充什么；支持流式输出与「停止生成」。
- **上下文引擎**：自动把商家信息 + 知识库 + 关注词 + 平台规则组装成上下文包，预算内全量、超预算智能裁剪。
- **内容中心（Content Center）**：一次生成 **3 个候选版本**供挑选，支持流式生成与中断；可编辑、保存历史版本（含当时提示词快照）、提交审核 → 审核通过 → 标记已发布。
- **双平台工作流**：内置**小红书**与**抖音**两套平台规则模板，生成内容时自动注入；抖音一期提供口播脚本/标题/话题标签文案。
- 所有内容均**人工复制发布**，不自动对外发送。

**热点雷达（新）**
- 多源采集全网热点（头条、B 站等公开数据源 + 节点日历），展示近 24 小时 / 3 天 / 7 天榜单，可按数据源筛选、切换发布视角。
- 热点自动去重、生命周期管理；数据源状态条可见每个来源的成功 / 失败 / 超时。
- **AI 商家匹配评分**：对热点按当前商家与发布平台做相关性打分，分为「值得跟 / 观察 / 不建议 / 待分析」四档，懒评分、可手动重新分析；顶部给出「今日建议」。没有强推内容时坚持宁缺毋滥。
- 榜单热点可一键「带去内容中心」，自动预填选题、来源与建议角度。

**模型与系统**
- **模型预设外置**：内置模型预设快照，开箱可用；支持从 Gitee「**拉取最新**」在线更新预设，立即生效、断网仍有内置兜底。

### 🛡️ 数据与安全
- 结构化数据存入本地 **SQLite**（经便携 Node 子进程，零原生依赖），WAL 模式防损坏，支持自动滚动备份。
- 首启 **Setup 守卫**：环境未就绪时引导完成初始化，已安装则直达工作台。
- 全程不改动 OpenClaw 数据目录与运行时；现有配置、技能、渠道、日志、终端等功能全部保留。

---

## [1.x]

- OpenClaw 便携管理器：零配置启动、图形化配置模型 / 技能 / 渠道、实时日志、内置终端、系统托盘。
- 内置微信渠道；支持企业微信官方插件扫码接入、飞书自建应用长连接。
- Obsidian 知识库：笔记向量化语义检索，以 MCP 工具按需喂给模型。
- 便携模式（U 盘数据随身）、国内镜像加速。

---

### 升级说明
- 老用户直接安装新包即可，安装器会自动搬迁旧版数据目录，无需手动处理。
- 首次使用营销功能需先建立一个商家档案。
