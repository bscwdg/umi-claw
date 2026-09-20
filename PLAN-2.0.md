# Umi Claw 2.0 施工基线（持续记录）

> 本文档是 2.0 的唯一规划基线，随开发进度持续更新。
> 基线版本：v1.33 ｜ 更新日期：2026-09-20 ｜ 状态：**Commit 00-12（含 05a/05b）全部通过验收；一期功能收官，剩整体测试**

## 修订记录

| 版本 | 日期 | 要点 |
|------|------|------|
| v1.33 | 2026-09-20 | **Commit 12 完成（AI 商家匹配，一期功能收官）**：新增 `electron/main/marketing/hotScoreManager.ts`（注入 DB + 06 ContextEngine + 07 Gateway，**不 import electron、不发裸 HTTP**，与 11 的 hotManager 保持「采集不碰 AI」边界）——①**懒评分**：只评当前 project × 发布平台（xiaohongshu/douyin 各一行缓存，防抖音源热点在小红书虚高适配）近 **7 天在榜 board 热点**（日历节点不花评分钱），**每批 ≤30 条**（超量按 heat/rank 取前 30，渲染端打开雷达自动续批评完），**24h TTL** 内零模型调用短路，手动「重新分析」force 无视 TTL；②**一次非流式 chat 评一批**（temperature 0.2），system=事实护栏（只能依据 Context Pack、资料无据宁低分并写「资料不足」、严禁脑补价格承诺）+ 商家资料 + 平台规则（`renderPackRuleSection`），user=编号热点清单，严格 JSON 数组契约（idx/match_score/platform_fit/reason/content_angle/lifecycle_advice）；③**传输走 SSE 逐帧拼 JSON（自测修正，原方案非流式）**：真网关（127.0.0.1:3213，deepseek-v4-flash 经 OpenClaw）实测 30 条/批详细中文输出约 90-225s，**非流式 120s 整体超时会整批挂掉、续批永不启动**；改 `createChatStream`（只有 chunk 间 120s 空闲超时、无整体超时），独立会话键 `hot-score-<platform>-<uuid>`（每批唯一，同 key 实测会在网关排队导致第二批空闲超时），prompt 收紧输出（reason≤30 字/angle≤25 字/advice≤15 字、紧凑单行 JSON）。④**容错双层**：单条 idx 越界/重复/分数非法/缺字段只计 failed 丢弃留下批，好条目照落 `project_hot_topics.upsert`；整次网关错误（OPENCLAW_NOT_READY 等）**原样透传**、JSON 不可解析/全条目非法抛 VALIDATION_ERROR，渲染端黄条降级裸榜不挡 11 任何功能；**断点续评**：成功批次落库后 scored_at 刷新、TTL 内不再入选，失败条目不落库，下次打开/补试只评未评条目，不重复花钱；store 续批循环加批间退让 1.5s + 单批失败退让 3s 补试一次（真网实测 provider 间歇空闲超时，非确定性故障可当场自愈）；④评分读表与写表均走分页助手（不重引入 5000 截断）；⑤IPC 增 `marketing:hot:score`（§五原契约预留行落地），preload/store 贯通，store `runHotScoring` 续批循环 + 代际令牌（切商家/切平台作废旧循环）+ 同 key single-flight；listRadar 加 `windowHours`（24/72/168，v1.11 时间窗切换，与 7 天评分窗独立）；⑥HotCenter：**四档分组**（🔥值得跟 match≥70 且 fit≥70 双门槛 / 👀观察任一 40-69 / ❌不建议双低 / ⏳待分析，阈值双端静态锁定）+ 分组内按总分排序、组折叠 + **顶部「今日建议」卡**（24h 窗 hot 档取 (match+fit) 最高、平分看 heat/rank，1 主推+理由+时机+一键带去 Content Center，无合格推荐不硬凑）+ 时间窗 tabs + 「重新分析」按钮 + 评分进度/失败可观测。⑦验收新增 `test/hotscore.accept.mjs` **10/10**（S1-S10：候选选取/heat Top30/日历过期排除/Context Pack 真注入、TTL 短路+续批、force、双平台隔离、部分失败、整败透传、垃圾 JSON、纯函数四档/清洗/解析/时机、今日建议排序与窗口、静态契约）；11 的 H12 负向断言（「score 归 12 不开」）更新为已开；双 typecheck 0 错，回归 11 套（hot 16/16、hotscore 10/10 + 既有 10 套）全绿，`npm run build` 通过（HotCenter chunk 18.8→28.6 kB，零新依赖/零新表列/worker 白名单零改）。**真网关冒烟（`test/hotscore.real-smoke.mjs`，复制真实库 73 条真热点到临时副本、造摄影商家、不碰真库不花真商家额度）**：30 条/批 SSE 全量 JSON 解析 0 失败、评分质量符合护栏（弱相关给低分并写「资料不足，鲸鱼摄影非婚纱客片」类理由、无脑补），档位分布 watch/skip 合理、无强相关时今日建议返回 null（宁缺毋滥实测成立）；多轮实测第二批约 1/3 概率撞网关空闲超时（provider 排队），已由「唯一会话键+批间退让+失败补试+断点续评」四重防线覆盖，彻底消除率归一期整体测试继续观察。⏳ 真 Electron GUI 点击流未做（同 08-11，归一期整体测试）；真网耗时偏长（70 条约 3-6 分钟）是后台任务+分批上屏，可接受，若 provider 长期如此可在二期把默认批量从 30 下调（v1.8「≤30」允许）|
| v1.32 | 2026-09-19 | **Commit 11 完成（热点采集与浏览，主进程 + 渲染端）**：①**SPIKE 结论改写供给线**（证据 `spikes/011-hot-sources/`，可复跑）——官方 `api-hot.imsyy.top` 已 NXDOMAIN、Vercel 镜像被墙、社区镜像全灭；抖音匿名接口被风控不可靠、知乎 401、微博 403、DailyHotApi 上游无小红书；**头条 hot-board 公开 JSON 直连稳定 50 条、B站 popular 公开 JSON 稳定 20 条（均免登录/免 Cookie）**，经用户拍板走**方案 A：内置直连为默认 + 保留 DailyHotApi 聚合协议**（base 可配，缺省**跳过不是失败**，自部署 6688 即插即用；默认路由收敛为 douyin/weibo/zhihu/baidu/kuaishou 五个直连未覆盖的长尾，头条/B站不双线重复抓）；②交付 `resources/collector/`（零 npm 依赖、只 stdout JSONL、不写库不碰 electron）+ `hotManager.ts`（60s tick + ≥60min 时间差 + powerResume + 打开即刷、single-flight、同源指纹+批内包含合并、五档生命周期、24 条采样、7 天落榜清理且 contents 引用例外、listRadar 近 24h board/calendar + 评分 LEFT 关联）+ `ipc/hot.ts` 三通道（list/get/refresh，**score 归 12**）+ preload `marketing.hot` 面 + 主进程 wiring（before-quit abort）+ `HotCenter.vue`（Top20/源筛选/发布视角/状态条三态/日历分区/一键带去 Content Center）+ store hot 切片 + 路由换真页；③**修了两个真 bug**：collector 成功描述符漏 `ok:true`（manager 全误判全源失败）、single-flight check-then-await 竞态（`isDue()` await 后未复查 inFlight，定时 tick 与打开页相撞会双采集）；④验收 `accept:hot` **12/12**（H1-H12，打真 hotManager + 真 collector + 真 Worker + 真 Node http 假端点），双 typecheck 0 错，`npm run build` 通过（HotCenter chunk 产出，extraResources 整目录随包零改动），回归 10 套全绿（content C10 路由护栏由 Placeholder 更新为 HotCenter 后 12/12），真外网冒烟头条 50/B站 20/日历 3；详见「Commit 11 落点与验收」。**5 条口径**：①`source_platform`=榜单出处（toutiao/bilibili/聚合路由名/calendar），成功与失败描述符严格同键；②跨平台同事件不物理合并（v1.9 不变）；③dailyhot 未配置=跳过态，状态条成功/失败/跳过三态分开；④小红书视角明示「综合榜+节点日历」，不假装存在专属榜（v1.12 降级口径）；⑤带去 Content Center 的六字段 payload 已实装，11 阶段 content_angle/lifecycle_advice 恒 null（无评分）。⏳ 真 Electron GUI 点击流未做（同 08/09/10）；SPIKE 清单项「行业命中率 ≥3 条 match≥70」归 12 有评分后量化；打包态 collector 冒烟由 extraResources 静态断言覆盖，win-unpacked CDP 留一期整体测试。**提交前 8 角度复审 11 项已全部修复并补 H13-H16 回归**：A1 exit→close 防 stdio 丢尾、A2 dailyhot 成败描述符同 host、A3 缺测不覆盖旧热度、A4 日历改本地时区；C1/C2/A5 用 listAllRows 分页消灭 5000 截断（另加 UNIQUE 回退防线）、C3 过期节点主动下线、C4/C5 失败可观测与跳过误报、C6 store 竞态令牌（12 前拆雷）、③URL 白名单、⑧定时器退出清理；验收升至 accept:hot 16/16；**第二轮用户复查 8 项亦全部处理**：缺测采样改如实写 null（修假趋势/死代码）、状态条 chip key 去重、listRadar 加 skipCollect 消灭全源失败后双采集、onMounted 容错 + loadError 提示、采样查询从两批全量降为 count+末 3 条/溢出旧行、run-shared.bat 按用户指示不动（提交排除）、产物 churn 按仓库先例；复测 accept:hot 16/16、双 typecheck 0 错、回归 10 套全绿、build 通过、外网冒烟头条 50/B站 20/日历 3 |
| v1.31 | 2026-09-19 | **Commit 10 完成（双平台工作流，主进程 + 渲染端提示，无新表/无新通道/worker 零改动）**：新增 `marketing/platformRules.ts`（小红书=图文笔记三件套、抖音=口播脚本/标题/话题且写死「不做视频」两套模板 + `getPlatformRule`/`renderPlatformRuleSection`，非法平台 VALIDATION_ERROR）；Context Pack 加 `platformRule` 附加字段（§六 六键契约不变；**模板不进 `renderContextPackText`、不占 60% 预算，属预留 40%**）；09 生成每路 user 指令与版本 prompt 快照、08 Advisor system 均注入规则区块；ContentCenter 平台 tabs 下加双平台工作流提示；`accept:platform` **7/7**（P1-P7，打真 4 模块 + 真 Worker + 真 SSE），`typecheck:node`/`web` 0 错，回归 content 12/12 · context 22/22 · advisor 10/10 · db 31/31 · project 18/18 · business 16/16 · knowledge 23/23 · gateway 27/27 · scan 18/18；详见「Commit 10 落点与验收」。**5 条口径**：①规则是主进程内部数据，同 Context Pack 不上 IPC（preload/ipc/白名单三处静态断言）；②两模板互不串味（图文笔记/口播脚本双向断言，P2/P5/P6）；③抖音边界在模板与 UI 双处写死，两平台均人工复制发布（硬规则 10）；④快照拼同一规则区块，「当时提示词」可复盘平台口径；⑤三角度仍各一条独立请求、规则每路必带。⏳ 真界面点击流未做（同 08/09）；模板文案质量待人工试用标定，调优只改 platformRules.ts 一处。另：`package-lock.json` 被 npm 顺带对齐（lock 停在 1.0.0、缺 05a/05b 的 exceljs/mammoth/pdfjs-dist；现 1.1.0 补齐），非本提交新增依赖决策 |
| v1.30 | 2026-09-18 | **Commit 09 完成（Content Center，主进程 + 渲染端）**：`marketing/contentManager.ts` + `ipc/content.ts` + preload `marketing.content` 面 + `ContentCenter.vue` + store content 切片 + `useContentPrefill.ts`（11 的热点 payload 接收端，路径先行）+ 路由换真页；`accept:content` **12/12**（C1-C12），`typecheck:node`/`web` 0 错，回归 db 31/31 · worker 18/18 · project 18/18 · business 16/16 · knowledge 23/23 · context 22/22 · gateway 27/27 · advisor 10/10 · scan 18/18；详见「Commit 09 落点与验收」。**本提交的 7 条口径**：①一次 3 版 = 三个固定角度（直给/场景/异议）各起一条独立流式请求（temperature 0.8，护栏 system 兜事实），不搞「一次请求要三段」的脆弱拆分；②**先落库后 done**（result resolve 前落版本行，source=ai 必带 prompt 快照；中止/失败/空产出不落版本）；③并发版本号防重（per-contentId promise 链串行化「读最大号→写行」，表上无 UNIQUE 约束）；④会话键 `content-<genTaskId>-a<i>`，三路不共用 sticky、不污染 Advisor 记忆（05b 同课）；⑤**不自动发布**（硬规则 10）：状态机全人工推进，`status→published` 自动补 `published_at`（v1.13 复用状态列），空正文拒发布，退回保留最近发布时刻；⑥停止/切商家/卸载/退出**四路中止**（两路定位 genTaskId/projectId，幂等不双计）；⑦`sourceTopicId` 显式预检（`reason='source-topic-not-found'`），update 白名单不含溯源列（身份不可改）。**§五 content 行补齐至 9 方法**（本提交扩面 3 条：delete / generate:abort / versions，先例 v1.28）。⏳ 真界面点击流未做（本机无桌面通道，同 08）；平台规则模板注入归 10 |
| v1.29 | 2026-09-18 | **05b 复审收尾（北 7 条裁定）**：①「Commit 05b 落点与验收」代码围栏收口包住全部清单行（首行后误闭合的根因是会话显示截断；knowledgeManager 行的路径前缀实际文件本就完整，非丢字）；②顶部版本行与本行同步——规则：每加一行修订，同一次编辑内更新顶部版本行（v1.22-v1.27 六次漏同步、顶行停在 v1.21，05b 完成消息因此误报过基线状态）；③§五 commitRecognized 改具名 `input` 参数（消除 `title?` 排在必选 `content` 前的 TS 非法形状；字段形状进注释）；④v1.28 行一处形近错字更正为「识别兜底」；⑤AHx 的 `>` 一律按规范表述为 **EOD 结束符**（ISO 32000-1 §7.4.4.1，出现即终止解码，非「非法字符」），PLAN 与 fixture/accept 注释同口径；⑥探针证据回写仓库跟踪文件 `test/probe-scan-render.json`（S13 每次复跑重生成，时间戳 churn 属预期），`.tmp` 落盘不再作基线证据；⑦§七 05a 验收补充的 pdfjs 措辞与 :581 引述统一（删去多余的 worker 定语；worker 打包态 §六 已实测，不是未验项）。 |
| v1.28 | 2026-09-18 | **Commit 05b 完成（aeb5f75）+ 三项文档漂移拍板落基线**：①**05b 扫描件/资料图 AI 识别兜底**：`marketing/scanRecognizer.ts`（pdfjs 取图 → 零依赖手写 PNG → 逐页流式 multimodal；探针 P1-P4 **PASS → 不降级**）+ `marketing:knowledge:{recognize, recognize:abort, commitRecognized}` + 确认弹窗（价格数字人工核对提示）+ 四路中止；`accept:scan` **18/18**（S13 内置探针复跑），回归 knowledge 23/23 · gateway 27/27 · advisor 10/10 · db 31/31 · context 22/22，两端 typecheck 0 错；详见「Commit 05b 落点与验收」。②**§五 knowledge 行补齐至 11 方法**——漂移自 05a 就存在（§五 只列 6 个，05a 已开 import/pickFile 共 8），一次改齐；§七 05a 清单行同步。③**§七 05a 误导句改写**：「条目标 FILE_PARSE_ERROR 待 05b」与「条目标红可重导入」→「失败信封回传、**不落库行**，reason=scanned-pdf 亮 05b 入口」（与 K9 断言及 05a 完成记录「不落行不落文件」拉齐；注记会被下一个人无视，改原句才断得了根）。④**§六 新增「PDF 内嵌图取图实测」**：v3 对 BI/ID/EI 转译成 `paintImageXObject`+合成 objs 键（img_p0_1），**不发 OPS 86/87**；AHx 的 `>` 是 **EOD 结束符**（ISO 32000-1 §7.4.4.1，出现即终止解码）；证据引 S13/S17 可复跑用例 + fixture 构造脚本（探针复跑回写仓库文件 `test/probe-scan-render.json`）。⑤**顶部基线版本行补上**（停在 v1.21 失联 6 版，每次修订漏同步的惯性要防）。待拍板三项（#26 顺带关闭：05b 已交）经复审建议全批 |
| v1.27 | 2026-09-17 | **Commit 08 完成**（AI Advisor，主进程 + 渲染端）：`marketing/advisorManager.ts` + `ipc/advisor.ts` + preload `marketing.advisor` 面 + `AdvisorPanel.vue` + store advisor 切片 + 路由换真页；`accept:advisor` **10/10**，`typecheck:node`/`web` 0 错，回归 gateway 27/27 · context 22/22 · db 31/31 · project 18/18 · business 16/16 · knowledge 23/23。**本提交的 3 条口径**：①每轮只发 system+user（不回灌历史，§六 结论 A）；②扩词候选**不写库**，勾选后走 04 的 `addWatch`；③停止生成/切商家/卸载/退出**四路都中止上游**（`before-quit` 里 `abortAllAdvisorStreams`）。⏳ 真界面点击流未做（本机无桌面通道） |
| v1.26 | 2026-09-17 | **Commit 08 主进程半边完成**（渲染端进行中）：`marketing/advisorManager.ts`（`ask` 组装 Context Pack→SSE / 事实护栏 system prompt / 资料缺口入 prompt / `suggestWatchlist` 扩词候选 + 本地清洗）+ `ipc/advisor.ts`（`marketing:advisor:{ask,abort,watchCandidates}`，流式增量走 07 事件名，`abort` 真断上游）+ preload `marketing.advisor` 面 + main wiring（含退出时 `abortAllAdvisorStreams()`）；`accept:advisor` **10/10**（真库 + 真 SSE 服务端 + 真 ContextEngine/GatewayClient），typecheck:node 0 错。两个自查修正留痕：测试脚手架漏注入 `conversationKeyResolver` 导致 5 项假红；A7 样本只有 28 字而误判「超长被丢」（期望应为 4 个可用）。渲染端（store 切片 / `AdvisorPanel.vue` / 路由）在子会话 `commit08-advisor-ui`，完成后再回填 08 的完整落点与验收。 |
| v1.25 | 2026-09-17 | **#25 打包态端到端补做完成（7/7）**：真产物 `release/win-unpacked` + CDP 驱真渲染进程 + 便携数据目录（预置便携 Node、预写 `autoStart:false` 且端口改 3299 避开真机）——P1 建库 11 表/uv=1、P2 打包 preload 真暴露 `marketing.gateway.{status,ensureReady}` 且面内无 token、P3 `status` 真发 HTTP 并正确判非就绪（connect-failed）、P4/P5 打包态 Project/Knowledge/LIKE 检索/Watchlist/当前商家、**P6 打包启动即同步（chatCompletions.enabled=true 且 meta 无非法字段）**、P7 打包 main 里 06/07 两模块真被构造；残留打包进程 0。**新增安全阀（已写进脚本与基线）**：`clawManager.start()` 内含 `_killGhostProcesses()`（`taskkill /f /im openclaw.exe`）会误杀本机在跑的 OpenClaw → 冒烟预写 `autoStart:false`、绝不调 `claw:*`/`ensureReady`、收尾只按 PID 结束 |
| v1.24 | 2026-09-17 | **#22 / #25 / #27 拍板与落地**：①**#22 路径 A** —— `marketing:gateway:{status,ensureReady}` **纳入 §五 契约**（§五 补 `gateway:` 一行 + 写明「Context Pack 不上面」「SSE 增量不注册业务通道」两条边界）；②**#27** —— `Setup.vue` 按钮文案「前往控制台」→「前往工作台」（与 #2 口径一致）；③**#25** —— 打包态端到端补做（`build:win` 产物 + CDP 驱真渲染进程 + 便携数据目录，结果见「Commit 07 落点与验收」的打包态一节） |
| v1.23 | 2026-09-17 | **#15 补完第二处 + 陈年口子盘点**：①**#15 第二处修复** —— `downloadManager._ensureOpenClawConfig()` 的**安装期保底配置**仍在写 `lastTouchedVersion:'latest'` + `lastTouchedAt`（v1.21 只修了 configManager，属**半修**），现改为**不写 `meta`**（`meta` 由 configManager 启动同步时按真实安装版本补，同一字段只在那一处写）；真跑 `downloadManager` 的 G28 固定（保底配置无非法 meta + 已存在配置不被覆盖）；`accept:gateway` 26 → **27/27**。②陈年口子核对：#2（label 改名）**已落地**（`App.vue:105-123`）、#5（放宽 Setup 完成判定）**已落地**（`Setup.vue:193-194` 只看 node+openClaw，`channelsInstalled` 仅决定按钮文案）；仅剩 `Setup.vue` 的「前往控制台」文案与 #2 不一致（待拍板）。③新增待拍板项 #24/#25/#26（提交策略 / 补打包态端到端时机 / 05b 与 08 的先后） |
| v1.22 | 2026-09-17 | **Commit 07 外部复审 10 条逐条核实**：**6 条属实已修**（①**中** 模型能力启动快照 → `modelsResolver` 按次重读配置，Setup/换 provider 后无需重启主进程；②**中** abort 在响应头前后语义不一 → 统一 resolve `{aborted:true}`；③**低** 就绪缓存永不过期 → 任何「没成」的调用作废缓存（不自动重试 POST，避免白花 token）；④**低** `once('destroyed')` 只声明未接线 → 真接线，冷启动静默期关窗也能中止上游；⑤**小** temperature 超范围被静默丢弃 → `VALIDATION_ERROR`；⑥**小** `/v1/models` 200 非 JSON 被当开启 → 结构不符即 `enabled:false`）。**4 条判定为可接受/无影响，记录在待办 #23**（429 码语义、非流式读体不在超时内、SSE 不拼多行 data、用例跳号）。验收 `accept:gateway` 20 → **26/26**（新增 G22-G27 把上述行为固定住），回归 db 31/31 · project 18/18 · business 16/16 · knowledge 23/23 · context 22/22，两端 typecheck 0 错 |
| v1.21 | 2026-09-16 | **Commit 07 完成**（Gateway Client）：`gatewayClient.ts`（探活/端点开关判据/自动拉起单飞/就绪轮询/SSE 流式/中止/会话隔离/多模态模型选择）+ `ipc/gateway.ts`（**只两条只读通道** status / ensureReady）+ 透传助手 `forwardGatewayStream` + **端点开关默认化与老用户迁移**（`configManager` 唯一入口，幂等、只动一个叶子键）+ **待办 #15 修复**（`meta.lastTouchedAt` 删除、`lastTouchedVersion` 写真实安装版本）；`accept:gateway` 新增 **20/20**；回归 db 31/31 · project 18/18 · business 16/16 · knowledge 23/23 · context 22/22。**两处写进基线的修正**：① 流式响应体已开始后的传输中断 → `stream-truncated`（而不是 `connect-failed`，后者会把「网关在跑但流断了」误导成「去环境初始化」）；② 确认 abort 会真断上游（假服务端观测到 close 事件，已发 2/80 帧），#14 由「⬜ 待验」降为「🟡 半验」 |
| v1.20 | 2026-09-16 | **Commit 06 完成**（Context Engine）：`marketing/contextEngine.ts` + 主进程 wiring + `accept:context` **22/22**；§六「**预算内全量打包、超预算退化为 LIKE 裁剪**」落地，本地 token 估算器替代 Gateway 的 `usage`（恒 0）；**账本 = 实际渲染文本**（首版按逐条估算写，验收 C9/C10 立刻抓到「账面 2400 刚好、渲染后 2454 超了」——区块头/条数行/未注入清单本身都占预算，故改为每次候选组合真渲染 `probePack/measure` + 尾部让位保险丝）；**本提交不新增 IPC 通道**（§五 无 context pack 面，消费方是主进程 07/08/09，主进程留 `getMarketingContextEngine()` 唯一取用点）；回归 db 31/31 · project 18/18 · business 16/16 · knowledge 23/23 |
| v1.19 | 2026-09-16 | **Commit 05a 完成**（Knowledge 知识库）：`knowledgeManager` + `parsers/`（docx/xlsx/pdf/url）+ `KnowledgeBase.vue` + `marketing:knowledge:*` 8 通道 + pdfjs 运行时资产入包；验收 **21/21**（该提交之后的两笔 05a 修复又补了 2 项用例，现为 **23/23**），**打包态端到端**通过（安装包内导入真中文 PDF → `ready`、正文 7030 字、中文关键词命中）。**依赖三坑已写死**：① `mammoth` 需要 `@xmldom/xmldom@0.8.x`（仓库顶层是 `docx` 要的 0.9.10，0.9 强制 mimeType → 必须嵌套副本）；② `pdfjs-dist` 必须 **v3**（v4+ ESM-only，主进程 CJS 打不进去）；③ pdfjs 必须带 `cMapUrl`/`cMapPacked`/`standardFontDataUrl`，否则中文抽出 0 字 |
| v1.18 | 2026-09-16 | **Commit 04 完成**（Business 1:1 + 资料完整度 + Watchlist）：`marketing/businessManager.ts`（BusinessManager + WatchlistManager）+ `marketing:business:*` / `marketing:watchlist:*` + `BusinessBrain.vue`（完整度卡 + 基本盘表单 + 关注词区）+ 摄影行业预设；验收 **16/16**，**打包态端到端**通过（存资料 → Watchlist 满 10 后第 11 个被拒 → 重启资料与关注词全在 → 删 Project 级联清空，并用直读库核对 `businesses=0 / project_watchlist=0 / current=null / integrity=ok`）；回归 `accept:db` 31/31、`accept:project` 18/18 不受影响。**口径拍板**：完整度 = `name/brand/city/positioning/target_customer/tone` 六项等权（**排除 address/phone**，联系方式不属于「AI 认识你」的语义信息） |
| v1.17 | 2026-09-16 | **Commit 03 完成**（Project CRUD + conversation_key 生成 + 切换持久化 app_meta）：`marketing/projectManager.ts` + `marketing:project:*` / `marketing:context:*` 七条通道 + Pinia store + 侧边栏切换器；验收 **18/18** 且**打包态端到端**通过（新建 → 设为当前 → 优雅退出 → **重启后仍是当前商家** → 改名时 key/created_at 不变 → 删除后目录/行/current 三者全清）。**新发现回填**：`isAppError()` 的 `instanceof` 在**模块实例不唯一**时假阴性（测试各模块各自 bundle；生产里 rollup 可能把 `errors.ts` 拆进不同 chunk），会把 SETUP_REQUIRED / NOT_FOUND 静默降级成 DB_ERROR，而渲染端按 code 分支 —— 已把 `errorCodeOf()` 上提到 `errors.ts` 供所有 Manager 复用，并修掉 `toErrorEnvelope()` 同类假阴性 |
| v1.16 | 2026-09-16 | **外部复审 3 项逐条核实**：①**P2 真缺陷已修** —— Worker 初始化失败（ping 超时 / 迁移抛错）时只置标志位、**未回收刚 spawn 的子进程**，会留下游离 Worker，且下次 `ensureReady()` 再拉一个 → 双 Worker 同库，违反硬规则 8；修法 `reapFailedChild()`（kill + 反注册 + 清 child），并补回归用例 **C13**（负向验证：还原旧代码时 C13 必红）；②**P1 测试脆弱已修** —— `countWorkerProcesses()` 在拿不到 WMI 权限的环境返回 0，导致 C4/C5 **假阴性**；改为查询不可靠时返回 `null`（不可知）并降级 `process.kill(pid, 0)` 判活；③**P3 不成立** —— `electron/preload/index.d.ts` 无需补 `api.marketing`（`Api = typeof api` 从实现推导），探针文件实测 `typecheck:web` 0 错；④`setupGuard.ts` 注释笔误（`channelsInstalled` 指个人微信插件，非企微）。验收脚本现为 **31/31** |
| v1.15 | 2026-09-15 | **Commit 01/02 完成并过验收**（01 守卫 12/12、02 验收 30/30、`build:win` 出包 + 打包态端到端冒烟），4 项回填：①**发现根 `npm run typecheck` 是空转**（tsconfig 为 `files:[] + references`）→ 新增 `typecheck:node`/`typecheck:web` 逐项目检查后才暴露 6 个被掩盖的真错（已修），后续提交一律走逐项目检查；②IPC 返回信封定为 `{ok:true,data}` / `{ok:false,error:{code,message,details?}}`（§五 信封的超集）；③02 实际落点补记：新增 `database/errors.ts`（§五 错误码表）+ `ipc/` 目录 + `marketing.system` 最小面（dbStatus/ping/metaGet/metaSet，业务 CRUD 仍归 03/04）+ `test/` 验收脚本入仓；④01 守卫抽成独立模块 `src/renderer/setupGuard.ts`（便于自动化验收）。另：打包态实测事实已补入 §六 |
| v1.14 | 2026-09-15 | **Commit 00 SPIKE 通过（VALIDATED）**，5 项实测结论回填：①⑥=**A 可回放** → **`project_messages` 表作废**、不需回灌，Commit 02 业务表回到 10 张；②`usage` 恒为 0 → Commit 06 上下文预算改用**本地估算**（不能依赖 Gateway token 统计）；③`model` 取值是 `openclaw` / `openclaw/<agentId>`（非 provider 模型 id）+ **端点开关 hot reload 已验**，均写入 Commit 07；④首次非流式 **80.3s 冷启动**、SSE 首字 1.27s → 必须流式 + 07 加预热；⑤新增两条待办：客户端 abort 后服务端是否停止生成、应用 `meta.lastTouchedAt` 被 schema 拒绝（07 顺带修）。另：只读探测确认 Gateway 仅绑 `127.0.0.1` |
| v1.13 | 2026-09-15 | 第五份评审 5 项全部核实属实并修复：①**依赖倒置**——Watchlist 的 AI 扩词依赖 Gateway（07），原写在 04（依赖 02/03）不成立，改为 04 只做手工增删 + 行业预设词 + 上限 10 词（3d→2.5d），AI 扩词移到 08（1.5d→2d），总盘不变；②**发布标记落字段**——`contents` 增 `published_at` + `effect_note`（不新增布尔列，复用 `status='published'`，避免两个真相来源）；③**Context Pack 补 `watchlist[]`**，06 行同步；④`origin` 标注 `watch` 为 2.1 预留（一期不产生）；⑤**完整度卡片范围**——04 只统计 Business 维度，Knowledge 维度随 05 接入 |
| v1.12 | 2026-09-15 | 四轮讨论并入：①新增「产品智能原则」（§一 子节）：5 个动作 + 3 杠杆 + 4 不做；②数据源定稿三条供给线（榜单聚合 API / 自建节点日历 / Watchlist 不采集）+ `hot_topics` 增 `origin` 列 + 小红书降级口径写死 + collector 目录结构；③Watchlist 轻量版进一期（`project_watchlist` 表 + AI 扩词推荐 + 上限 10 词，不采集）；④新增「2.1 阶段预留」（行业趋势 + 同行观察，含路径与红线）；⑤Commit 04/09/11/12 内容扩充、估时上调，总盘 23 → 约 27 人天，提交数不变（14） |
| v1.11 | 2026-09-15 | 两处一行级冲突修复：①UI 验收口径统一——12 的展示 = 评分三档（🔥值得跟/👀观察/❌不建议）+ ⏳待分析态（未评分热点不进三档）；②落榜清理加引用排除——被 contents.source_topic_id 引用的热点不删（NOT IN 子查询），防止 SET NULL 在 7 天后冲掉三期 Analytics 溯源；被保留行数 ≤ 内容数，成本可忽略 |
| v1.10 | 2026-09-15 | 第五轮评审 9 项（赶在 user_version=1 建表前）：①Context Pack 检索策略写死——预算内 knowledge 全量打包，超预算才 LIKE 裁剪（约占模型上下文 60%，06 定阈值）；②contents 增 source_topic_id（FK→hot_topics，ON DELETE SET NULL）+ 索引；③knowledge_items 增 UNIQUE(project_id, source_path)，重导入按此 upsert；④结论 B 时 project_messages 必须回灌最近 10 轮（20 条）随请求发送，sticky user 的 Memory ≠ 对话转录；⑤新增硬规则 13：GATEWAY_TOKEN 只留主进程，渲染端永不直连 3213；⑥Worker 崩溃写请求不自动重试（仅 Manager 预生成主键的 upsert 可重试）；⑦删 project 删行失败语义纠正（保留行+报错+幂等重试，不存在「凭目录重建」）；⑧09 Content Center 同样要 AbortController 停止生成；⑨12 续评规则（超 30 按 heat 取前 30、分批续评）+「⏳待分析」分组；11 验收补安装包内 collector 冒烟（复用 obsidianManager.getScriptPath 的 dev/安装包路径解析）；另明确一期每日动线=Advisor+热点雷达+Content Center，今日任务/日历留二期 |
| v1.9 | 2026-09-15 | 第四轮评审 16 项并入，基线封版：①Commit 表加「依赖」列（02 不依赖 01，可并行）；②新增硬规则 12：collector 只做 adapter+stdout JSON，不碰库/不做业务判断/永不改成 Agent 任务；③评分 24h TTL（仅手动重算或落榜重现才重评）；④数据源健康状态入 app_meta + 页面顶部状态条；⑤去重范围钉死为同源内标题归一化，跨平台同事件不物理合并（聚合二期）；source 仅追溯不参与身份；⑥热点页 UI 规格：默认近 24h（可切 3/7 天）、默认 Top20、三档分组（🔥值得跟 match≥70 且 fit≥70 / 👀观察 40-69 / ❌不建议）；⑦热点→Content Center 携带结构化 payload（09 落地，11 占位）；⑧热点情报永不自动入知识库；⑨页面定名「🔥 热点雷达」，内部 hot* 标识不变；⑩project_hot_topics 字段封板 |
| v1.8 | 2026-09-15 | 第三方评审 12 项全部并入：①collector 改为只抓取+stdout JSON，落库统一经 DB Worker（消除与硬规则 8 的冲突），marketing/ 补 hotManager.ts；②hot_topics.platform 改名 source_platform（来源平台），project_hot_topics 增发布平台列 platform、主键改 (project_id, topic_id, platform) 每平台一行；③05 只交付 05a（2.5d），05b 移到 07 后独立提交（1.5d，总盘 23d 不变）；④采样保留策略（最近 24 条/热点 + 落榜 7 天清理）；⑤11 并行期「带去 Content Center」占位；⑥12 评分边界（30 条/次、仅近 7 天在榜、部分失败降级）；⑦第八节导航营销(4)→(5)、补第 5 条 marketing 路由与 hotManager；⑧合规红线升为硬规则 11；⑨image 边界限定带文字资料图（客片/商品图归二期 Assets）；⑩定时改为 last_hot_fetch_at 时间差判断防睡眠漂移；⑪00⑦补多模态模型选择规则；⑫提交序列 13→14（00-12 + 05b） |
| v1.7 | 2026-09-15 | ① 平台一期扩为**小红书 + 抖音双平台**（抖音一期只做口播文案/标题/话题，不做视频），Commit 10 估时 1.5d→2d；② **热点中心进一期**：新增 Commit 11 热点采集与浏览（2.5d）+ Commit 12 AI 商家匹配（1.5d）；③ 新增 3 张表 hot_topics / hot_topic_samples / project_hot_topics 并入 user_version=1（业务表 6→9）；④ 后台定义拍板：**仅应用运行时主进程每小时定时采集 + 打开页面立即刷新**，不做关机后任务计划；采集独立于 Gateway（零依赖 collector 脚本），AI 评分才走 Agent；⑤ 评分懒计算（打开页面对当前 project 批量评分 + 落库缓存，禁止 fan-out 全商家）；红线：只用公开聚合源，不做登录/Cookie 抓取；一期合计约 23 人天 |
| v1.6 | 2026-09-15 | 知识库文档格式放开：05 从「仅 text/markdown/url/faq」改为「文字层文档本地确定性解析（docx/xlsx/pdf）+ 扫描件 AI 多模态识别兜底（显式触发、结果人工确认）」；type 枚举放开；05 拆 05a/05b，估时 2d→4d；新增依赖 mammoth/exceljs/pdfjs-dist；00 验收加 ⑦多模态支持验证；明确多模态不进默认解析管线、价格类内容必须确定性抽取 |
| v1.5 | 2026-09-15 | 补 AI Advisor（Commit 08）交付边界定义；Commit 00 验收增加「对话历史回放」验证项⑥，project_messages 表按验证结论决定是否并入 user_version=1 初始 schema（02 开工前定，零迁移成本） |
| v1.4 | 2026-09-15 | 两轮评审并入：① SQLite 定稿方案 B（node:sqlite 子进程），原 00 与 05-SPIKE 合并为「Gateway Client 原型」；② 4 缺口拍板：businesses 1:1+UNIQUE、conversation_key 入 projects 表、Setup 完成后 reload 防 守卫弹回、删 project 先目录后行；③ 新增：DB Worker 单例与协议、统一错误码、projectId 显式传参、Human-in-the-loop、子进程注册表（含 obsidian db.mjs 信号处理，列为硬规则 3 的明确例外）、VACUUM INTO 备份、trigram 保留 LIKE 兜底、异步任务事件命名预留、Commit 表加人天列；Commit 序列 12 → 11 |
| v1.3 | 2026-09-15 | 修正：02 验收去掉 03/04 的 CRUD；方案 B 补两项风险；495 行措辞更正；新增待办 #7 DB 滚动快照 |
| v1.2 | 2026-09-15 | 评审 6 修正：Schema 计数、switch 职责归位、检索策略、Setup Guard 去掉 channelsInstalled、user_version 迁移、Commit 02 验收写死；补充 app_meta、Commit 00 验证、content_versions.prompt；SQLite 选型列为待决策 |
| v1.1 | 2026-09-15 | 首版施工基线：定位、硬规则、目录策略、数据层、IPC、调用链、Commit 计划与 Commit 01 落点 |

---

## 〇、总原则（v1.4 新增）

```text
先保证 OpenClaw 稳定可用，
再让 AI 调用稳定可用，
再让 AI 知道商家是谁，
最后才让 AI 帮商家做营销。

任何新功能如果会破坏现有 OpenClaw 能力、
增加首启复杂度、增加数据迁移风险，
优先延期，而不是为了 2.0 一次做完。
```

## 一、定位（锁死，不再讨论）

```text
Umi Claw = 小白友好的 OpenClaw 桌面管理器 + AI 营销工作台

     OpenClaw 管理          AI 营销工作台
     「让它能用」           「让它有用」
          └───────┬────────┘
              OpenClaw Agent 引擎
```

**Project 定义（v1.4 拍板）**：Project = **一个独立商家 / 品牌 / 门店的 AI 工作空间**，不是一次性活动。

```text
正确：Project = 我的摄影店 / XX女装 / XX餐厅
错误：Project = 国庆活动 / 双十一推广（活动属于 Project 下的内容与策略，二期实现）
```

一个 Project 包含：Business（1:1）、Knowledge、Assets、Contents；二期再加 Strategy / Topics / Calendar / Analytics / Learning。

**一期每日动线（v1.10 明确）**：老板每天打开应用的核心动作 = 在 🔥 热点雷达发现选题 → Content Center 出稿/改稿 → 拿不准时问 AI Advisor。今日任务、日历排期、主动推送（D2/D3）全部留二期，一期首页不为「还没建的功能」留入口。

### 产品智能原则（v1.12 新增）

**判断标准：更智能 = 更少让老板解释自己。** 他填过的，AI 必须记住并用上；他没填的，AI 主动问；他改过的，AI 要学到。

AI 的四个输入（Business / Knowledge / 平台规则 / 任务）+ 两个待补（老板的历史稿件、什么有效）。一期把重心放在**上下文质量**而非模型能力——这是最便宜的智能杠杆。

一期的 5 个具体动作（折进现有 Commit，不新增编号）：

| 动作 | 说明 | 落点 |
| --- | --- | --- |
| 资料完整度卡片 | 「AI 认识你 60%，补上价目表可到 80%」——把锅甩回可行动的事（v1.13：04 只统计 Business 维度，Knowledge 维度随 05 接入） | 04 |
| 生成前主动追问缺口 | 要写价格但知识库没有 → 不硬编，提示补充或换角度 | 08/09 |
| 一次生成 3 个版本 | 3 个角度/3 种语气供选，选中与改稿都是偏好样本 | 09 |
| 雷达「今日建议」 | 把 30 条榜收敛成「今天建议跟 A，因为…，后天发」+ 备选 | 12 |
| 极简发布标记 | 「已发布」+ 可选效果备注（v1.13：复用 `status='published'`，落 `published_at` / `effect_note`）；三期 Learning 唯一的真实标签来源 | 09 |

三个杠杆（按性价比）：① 上下文质量 > 模型能力；② 结构化输出 + 固定 rubric（可校准/可缓存/可解释）；③ 闭环反馈（采纳哪个版本、改了什么、发没发）。

四条不做：① **不硬编**——资料里没有的价格/承诺/卖点一个都不编，宁可显示「资料里没有」；② **不全自动**——不自动发、不自动回（硬规则 10）；③ **不让模型干确定性的活**——价格提取、去重、统计一律本地/规则；④ **不堆页面**——一期 5 页够了，把「今日建议」做透比加功能值钱。

## 二、十三条硬规则（违反任何一条 → 停下来重新评估）

1. `data/openclaw` 不动。
2. `data/runtime` 不动。
3. `/obsidian` 路由与 `electron/main/obsidian/` 不动（Obsidian 挂到 OpenClaw 导航组）。**v1.4 明确例外**：给 `resources/obsidian/db.mjs` 增加进程信号优雅退出处理属于纯增量、不改现有行为，允许并与 marketing DB Worker 共用子进程注册表。
4. 现有 OpenClaw 安装、启动、配置、Skills、Channels、Logs、Terminal 等功能一个不删。
5. Commit 02 必须完成 Windows 安装包中的 DB Worker 冒烟测试，失败不得进入 Commit 03。
6. **Commit 00（Gateway Client 原型）未通过，不得开始 Commit 06 Context Engine 及之后所有 AI 功能。**
7. SQLite 已定稿方案 **B（`node:sqlite` 子进程）**；禁止引入 better-sqlite3 等原生模块工具链。
8. **DB Worker 全局单例常驻**：整个应用只有一个 `db-worker.mjs` 子进程，所有 Manager 经其访问数据库；严禁每次 IPC 调用 spawn 一个 node 进程。
9. **projectId 显式传参**：Manager 层每个业务方法必须显式接收 projectId，禁止从全局 currentProject 隐式推断。
10. **Human-in-the-loop**：不做自动回复、不做自动发布；AI 产出一律经人工审核/人工复制发布；涉及价格与活动变更的内容必须人工确认。
11. **热点采集合规红线（v1.8）**：只使用公开聚合数据源（DailyHotApi 类公开榜单接口）；禁止任何要求用户登录、填写 Cookie、或绕过平台访问控制的抓取；数据仅作内部选题参考。
12. **Collector 边界（v1.9）**：`hot-collector.mjs` 只做数据源适配（每个来源一个 adapter 文件）与标准化 stdout JSON；禁止写 SQLite、禁止去重/生命周期/评分等任何业务判断、禁止依赖 Gateway 或调用 Agent——**热点采集永不改成 Agent 任务**。业务逻辑全部在 hotManager 侧。
13. **Gateway 凭据与调用边界（v1.10）**：`GATEWAY_TOKEN` 与 Gateway HTTP 调用只允许存在于主进程；渲染进程永不持有 token、永不直连 `127.0.0.1:3213`，一律经 IPC → Manager → Gateway Client。

## 三、目录策略

**第一阶段不搬任何现有文件。** `electron/main/*.ts` 保持平铺，新代码新增目录：

```text
electron/main/
├── （现有 7 个 .ts 原样保留；obsidian/ 子目录不动）
├── marketing/          ← 新增
│   ├── projectManager.ts
│   ├── businessManager.ts
│   ├── knowledgeManager.ts
│   ├── contentManager.ts
│   └── hotManager.ts        ← Commit 11：调度 collector、经 DB Worker 落库、去重/生命周期/采样清理
├── database/           ← 新增（Commit 02）
│   ├── database.ts     # DB Worker 客户端（单例、断线重连、请求序列化）
│   ├── schema.ts
│   └── migration.ts
├── subprocessRegistry.ts   ← 新增（便携 Node 子进程注册表 + 统一优雅关闭）
└── ipc/                ← 新增
    ├── marketing.ts
    └── index.ts

resources/
├── database/
│   └── db-worker.mjs   ← 新增：零依赖，node:sqlite，stdio JSON 协议，单例常驻
└── collector/
    └── hot-collector.mjs ← 新增（Commit 11）：零依赖，仅 fetch 公开聚合源并按行 stdout 输出 JSON；**不写库**（落库统一 hotManager → DB Worker，守硬规则 8）；不依赖 Gateway，主进程定时器以短命子进程方式调用
```

data 目录冻结现状，只新增三项：

```text
data/
├── config/  logs/  openclaw/  runtime/   ← 冻结，不动
├── projects/      ← 新增（商家原始文件：knowledge/assets 原文等）
├── backup/        ← 新增（VACUUM INTO 滚动快照，保留最近 5 份）
└── umi-claw.db    ← 新增（SQLite，结构化数据）
```

若未来统一为 `data/runtime/openclaw`，必须独立版本任务（迁移检测 → 备份 → 复制 → 配置更新 → 健康检查 → 失败回滚），不属于 2.0 MVP。
## 四、数据层：SQLite（v1.4 定稿方案 B）

### 选型结论

采用方案 B：**`node:sqlite` 子进程**（Electron 30 内置 Node 20 无 node:sqlite，因此必须走便携 Node）。

决策依据：`resources/obsidian/db.mjs` 已在 1.0 生产验证 node:sqlite DatabaseSync + WAL + busy_timeout，spawn 便携 Node + stdio JSON 是仓库内既成模式；零原生构建、零 electron-rebuild、打包天然可用，规避非管理员 Windows 上 VS Build Tools 风险。代价（全异步 DB 访问）在 Vue → Pinia → IPC → Manager 分层中零成本。

两个专属风险及对策：

1. **DB 子进程会被运行时更新流程强杀**：对策见「子进程注册表」——`_stopRuntimeProcesses()` 前置优雅关闭；Worker 异常退出后 Database 客户端自动重启并重放未完成请求（幂等查询直接重试）。
2. **新机首启无 Node**：DB **惰性初始化**——应用启动不建库、不拉起 Worker；首次 marketing IPC 调用时才 spawn 建库；Node 缺失时返回 `SETUP_REQUIRED` 错误（统一错误码，见第五节），前端引导去 Setup，绝不阻塞应用启动。

### DB Worker 协议（Commit 02 定死）

单例常驻子进程，请求/响应按行（JSONL）收发：

```json
请求：{ "id": "req-001", "method": "project.list", "params": {} }
成功：{ "id": "req-001", "ok": true, "data": [] }
失败：{ "id": "req-001", "ok": false, "error": { "code": "DB_ERROR", "message": "..." } }
```

- `database.ts` 维护请求队列（id → resolve/reject + 超时 30s）、Worker 单例、断线自动重启一次；method 白名单分发，禁止前端传 SQL。
- **崩溃重试语义（v1.10）**：Worker 异常退出后自动重启；**读请求自动重试，写请求默认不自动重试**（防重复写入），直接返回 DB_ERROR 由上层决定；唯一例外是 Manager 预生成主键的 upsert（INSERT OR REPLACE/ON CONFLICT，天然幂等）可安全重试。
- Worker 侧写操作串行执行（DatabaseSync 本身同步），读操作不做额外并发。
- 优雅关闭：父进程发 `{ "method": "shutdown" }` → Worker 执行 `PRAGMA wal_checkpoint(TRUNCATE)` + close → exit(0)；3s 未退出再由 `_stopRuntimeProcesses` 强杀。

### 子进程注册表（subprocessRegistry.ts）

- 所有「便携 Node 拉起的常驻/长任务子进程」（marketing db-worker、obsidian indexer）启动即注册：`{ name, pid, gracefulStop(): Promise<void> }`。
- `downloadManager._stopRuntimeProcesses()` 改为：**先逐个调用注册表 gracefulStop（等待上限 3s）→ 再按 ExecutablePath 精确 taskkill / pkill**。
- 同步给 `resources/obsidian/db.mjs` 补 `process.on('SIGTERM'/'SIGINT')` 与 stdin shutdown 指令（硬规则 3 例外）；mcp-server 由 OpenClaw 自身拉起，不纳入我们的注册表。

### 连接约定

- Worker 启动执行 `PRAGMA foreign_keys=ON`、`PRAGMA journal_mode=WAL`、`PRAGMA busy_timeout=5000`。
- 结构迁移用 `PRAGMA user_version`（初始 1），`migration.ts` 顺序升级；不另建版本表。
- 外键列全部建索引；渲染端永不直接碰 DB。
- 结构化数据进库；大文件留文件系统，库存 `source_path`。
- `config/app.json` 保持不动。

### 第一版 Schema（10 张业务表 + 1 张元数据表；user_version = 1）

v1.4 变更：projects 增 `conversation_key`；businesses 对 project_id 加 **UNIQUE**（1:1 定稿）。v1.6 变更：knowledge_items.type 放开（见 05 边界）。

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT,
    description TEXT, status TEXT DEFAULT 'active',
    conversation_key TEXT NOT NULL,          -- 创建时生成的 uuid；OpenClaw 会话隔离 user=conv:<projectId>:<此值>
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE businesses (                    -- 与 project 1:1；多门店/多品牌二期再拆
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
    name TEXT, brand TEXT, city TEXT, address TEXT, phone TEXT,
    positioning TEXT, target_customer TEXT, tone TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE knowledge_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,                      -- v1.6：text/markdown/url/faq/docx/xlsx/pdf/image；文字层本地解析，扫描件走 AI 兜底
    source_path TEXT, source_name TEXT, content TEXT,
    status TEXT DEFAULT 'ready',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, source_path)         -- v1.10：手输 text/faq 的 path 为 NULL（NULL 互不冲突）；文件/URL 重导入按此键 upsert，天然防同份文件重复
);
CREATE TABLE knowledge_chunks (   -- 预留 RAG，二期向 resources/obsidian 切块对齐；第一阶段仅 LIKE 检索
    id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL, content TEXT NOT NULL, metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
);
CREATE TABLE contents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT, platform TEXT,               -- platform = 发布平台：xiaohongshu / douyin
    topic TEXT,                              -- 选题/主题文案（人工填写或 AI 生成，与热点溯源分开）
    source_topic_id TEXT,                    -- v1.10：来源于热点雷达时溯源 hot_topics.id；热点清理时 SET NULL，不带走内容
    content TEXT,
    status TEXT DEFAULT 'draft',             -- draft/review/approved/published/archived
    published_at INTEGER,                    -- v1.13：发布标记；复用 status='published'，不另设布尔列（避免两个真相来源）
    effect_note TEXT,                        -- v1.13：老板手填效果备注（不错/一般/没动静），三期 Learning 的结果标签
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(source_topic_id) REFERENCES hot_topics(id) ON DELETE SET NULL
);
CREATE TABLE content_versions (   -- Learning 地基：source=ai 必须带 prompt 快照；source=user 的 prompt 为 NULL
    id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
    version INTEGER NOT NULL, content TEXT NOT NULL, source TEXT,
    prompt TEXT,                             -- source=ai：本次 Context Pack 快照；source=user：NULL
    created_at INTEGER NOT NULL,
    FOREIGN KEY(content_id) REFERENCES contents(id) ON DELETE CASCADE
);
-- v1.8 热点中心三表：热点是全局数据（无 project_id），相关性是 Project × 发布平台数据
CREATE TABLE hot_topics (                     -- 全局热点，抓一次所有 Project 共享
    id TEXT PRIMARY KEY,
    source_platform TEXT NOT NULL,           -- 来源平台（榜单出处：douyin/weibo/bilibili…），与 contents.platform（发布平台）区分
    source TEXT NOT NULL,                    -- 聚合源标识，仅用于追溯/排障，不参与热点身份与去重
    origin TEXT NOT NULL DEFAULT 'board',    -- v1.12：来源类别 board=榜单 / calendar=节点日历 / watch=关注词（一期只产前两者，watch 为 2.1 预留）
    title TEXT NOT NULL,
    url TEXT,
    fingerprint TEXT NOT NULL,               -- 去重指纹 = source_platform + 标题归一化（仅同源内去重）
    heat REAL,                               -- 最新热度（历史在 samples 表）
    rank INTEGER,                            -- 最新榜单名次
    lifecycle TEXT,                          -- new/rising/breaking/peak/long_tail，由采样序列计算
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    UNIQUE(source_platform, fingerprint)     -- v1.9：跨平台同事件不物理合并（各平台各一行，二期再做 cluster 聚合）
);
CREATE TABLE hot_topic_samples (             -- 时间序列：趋势/生命周期判定至少需 2-3 次采样
    id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
    sampled_at INTEGER NOT NULL, heat REAL, rank INTEGER,
    FOREIGN KEY(topic_id) REFERENCES hot_topics(id) ON DELETE CASCADE
);
CREATE TABLE project_hot_topics (            -- 按 Project × 发布平台的 AI 懒评分缓存（同热点两平台各一行，不重复花钱）
    project_id TEXT NOT NULL, topic_id TEXT NOT NULL,
    platform TEXT NOT NULL,                  -- 发布平台：xiaohongshu / douyin
    match_score INTEGER,                     -- 商家相关度 0-100
    platform_fit INTEGER,                    -- 该发布平台的适配度 0-100
    reason TEXT, content_angle TEXT, lifecycle_advice TEXT,
    scored_at INTEGER NOT NULL,              -- v1.9：24h TTL，期内不重评；表结构就此封板，不再加列
    PRIMARY KEY(project_id, topic_id, platform),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(topic_id) REFERENCES hot_topics(id) ON DELETE CASCADE
);
CREATE TABLE project_watchlist (  -- v1.12：老板关注的行业词；只喂 AI 评分/生成上下文，不触发任何采集
    project_id TEXT NOT NULL, keyword TEXT NOT NULL,
    type TEXT,                               -- industry / product / audience / region
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, keyword),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE app_meta (           -- 仅存应用级全局状态（白名单），禁止塞业务数据
    key TEXT PRIMARY KEY, value TEXT          -- 允许：current_project_id / last_open_page / db_* / hot_last_fetch_at / hot_source_status / hot_source_error
);
CREATE INDEX idx_businesses_project   ON businesses(project_id);
CREATE INDEX idx_knowledge_project    ON knowledge_items(project_id);
CREATE INDEX idx_chunks_knowledge     ON knowledge_chunks(knowledge_id);
CREATE INDEX idx_contents_project     ON contents(project_id);
CREATE INDEX idx_contents_topic       ON contents(source_topic_id);
CREATE INDEX idx_versions_content     ON content_versions(content_id);
CREATE INDEX idx_samples_topic_time    ON hot_topic_samples(topic_id, sampled_at);
CREATE INDEX idx_hot_topics_seen       ON hot_topics(source_platform, last_seen_at);
CREATE INDEX idx_project_hot_score     ON project_hot_topics(project_id, platform, match_score);
CREATE INDEX idx_watchlist_project     ON project_watchlist(project_id, enabled);
```

### 对话历史存储（Commit 00 已定：结论 A）

Commit 00 实测（2026-09-15，dev 实例 3214）：同一 `user=conv:<projectId>:<conversation_key>` 的第二轮请求**准确复述了第一轮暗号**（`UMI-ZEBRA-42`）；换一个 `user=` 问同样问题则回答「无（本次对话里你没有给过我暗号）」。

**结论 A —— 不建本地消息表。** AI Advisor 的续聊历史完全由 OpenClaw 的 sticky `user` 会话承载，**也不需要「每轮回灌最近 N 轮」**。

- **`project_messages` 表作废**（不并入 user_version=1）；Commit 02 业务表为 **10 张**。
- 若未来出现「切换 Project 后历史错乱」或「需要跨设备同步对话」，再作为独立版本任务评估；当前粘性会话已满足一期需求。
- ⚠️ 待办：客户端 abort 后**服务端是否真正停止生成**未验证（关系到 token 是否白烧），见第九节。
### 检索策略

- 第一阶段：SQLite LIKE 关键词检索。零配置，中文友好，α 数据量足够。
- v2 迁移（user_version=2）：FTS5 + trigram tokenizer（SQLite ≥ 3.34）。**已确认坑：trigram 对 <3 字符的查询无效，中文双字词（如"减肥"）搜不到——迁移后 LIKE 必须保留为兜底分支**，不能 FTS 化后删 LIKE。FTS5 默认 unicode61 会把整段中文当单 token，不可直接用。
- 语义检索（Embedding）后置，复用 `resources/obsidian/` 的 indexer/embeddings 链路，不引入外部向量库。

### 备份（待办 #7 定稿）

- 不 copy 三文件，用 `VACUUM INTO 'data/backup/umi-claw-<ts>.db'`：在线一致性快照，自动含 WAL checkpoint，一句 SQL。
- 触发时机：应用启动时（距上次备份 >24h）与 Schema 迁移前；保留最近 5 份，超出删最旧。

## 五、IPC API 与统一错误规范（v1.4 新增）

```ts
window.api = {
  claw, config, models, skills, channels,   // 现有，不动
  marketing: {
    project:  { list, get, create, update, delete },
    context:  { getCurrentProject, setCurrentProject },   // current_project_id 存 app_meta（白名单内）
    business: { get(projectId), upsert(projectId, data) },// 1:1，无独立 list/create
    knowledge:{ list(projectId), get, create(projectId, data), update, delete(projectId, id), search(projectId, query),
                import(projectId, input), pickFile(),                                                       // 05a（v1.28 补入 §五）：文件/URL 导入——解析失败只回错误信封**不落库行**；取消选择=filePath:null 不是错误
                recognize(projectId, {filePath,type?}), abortRecognize(taskId|null, projectId|null),        // 05b：**显式触发**识别（扫描 PDF/资料图）；产出**待确认文本、不落库**；流式增量**复用 07 事件名**（chunk/done/error，streamId=taskId）不新造事件；abort 两路定位——栅格化窗口里还没有 taskId 时按 projectId 取消该商家在途任务（UI 约束：同商家同时至多一个识别）
                commitRecognized(projectId, input) },                                                      // 05b：**人工确认后唯一写入口**（硬规则 10）；input={filePath, type:'pdf'|'image', title?, content}；type=pdf/image、status=ready；同 (project_id,source_path) upsert 覆盖
    content:  { list(projectId, {status?,platform?,limit?}), get, create(projectId, data), update,             // 09（v1.30 补齐至 9 方法）：list 新→旧；update 白名单 title/platform/topic/content/status/published_at/effect_note（source_topic_id 是身份不可改）
                delete(projectId, id),                                                                        // 09 扩面：删除幂等（跨 project/不存在 → deleted:false 不报错）；版本随 FK 级联清
                generate(projectId, spec), abortGenerate(genTaskId|null, projectId|null),                     // 09：一次 3 版（直给/场景/异议）三路并行流式，streamId=`<genTaskId>-<角度key>`，增量复用 07 事件名；abort 两路定位（同 05b 口径），幂等
                saveVersion(projectId, id, input, {activate?}), versions(projectId, id) },                    // 09 扩面：source=user 手改（prompt=NULL）/ai（必带 prompt 快照，§四）；activate=同时写回正文；versions=历史面板（version 升序）
    hot:      { list(projectId, {platform, force?}), get(topicId), refresh(), score(projectId, platform) },  // platform=发布平台(xiaohongshu/douyin)；list 返回热点+当前 project/该平台缓存评分；refresh=立即采集；score=懒评分
    gateway:  { status, ensureReady },   // Commit 07（v1.24 拍板纳入）：只读就绪面（零 token：只发 GET /health + GET /v1/models）+ 幂等拉起（探活→按需调 clawManager→就绪轮询）；baseUrl/token 只在主进程（硬规则 13）
  }
}
// Manager 层签名全部显式 projectId（硬规则 9）；二期再扩 assets/strategy/calendar/analytics/learning
```

**两条「刻意不设渲染端通道」的边界（v1.20 / v1.24 拍板）**：

- **Context Pack（06）不上面**：它是主进程内部数据结构，消费方是 07/08/09 的主进程代码（主进程留 `getMarketingContextEngine()` 作唯一取用点）；将来若要「AI 看见什么」预览页，先改本节再动 IPC。
- **SSE 增量不注册业务通道（07）**：07 只定事件名（`marketing:gateway:chunk` / `done` / `error`）并导出 `forwardGatewayStream(webContents, streamId, iterator)` 助手，**注册归 08/09 自己的业务通道**（advisor / content）。

**统一错误码**（Manager 抛出 → IPC 透传 → 渲染端按 code 分支，禁止 `error.message.includes()` 判断）：

| code | 含义 | 前端典型处理 |
|---|---|---|
| VALIDATION_ERROR | 参数不合法 | 表单内联提示 |
| NOT_FOUND | 资源不存在 | 404/返回列表 |
| CONFLICT | 冲突（如 business 已存在） | 冲突提示 |
| DB_ERROR | Worker 查询失败（重试后仍败） | 通用错误 + 日志 |
| SETUP_REQUIRED | 便携 Node 不存在，Worker 无法启动 | 引导去环境初始化 |
| OPENCLAW_NOT_READY | Gateway 探活/拉起失败 | 显示启动引导 |
| OPENCLAW_TIMEOUT | 调用超时 | 重试按钮 |
| OPENCLAW_AUTH_ERROR | Gateway token 鉴权失败 | 配置指引 |
| FILE_NOT_FOUND / FILE_PARSE_ERROR | 原始文件缺失/解析失败 | 知识条目标红 |

IPC 失败统一信封：`{ code, message, details? }`。

**异步任务事件命名（只定形状，v1 不实现任务基础设施）**：未来批量生成/素材分析等走 `taskId` + 事件 `marketing:task:<id>`（payload: progress/completed/error）；v1 单次内容生成仍走 SSE → IPC 透传通道，不预建派发器。
## 六、AI 调用链与 Context Pack

```text
用户 → Content Center → 当前 Project
     → Business + Knowledge + 平台规则
     → Context Pack（组装上下文包）
     → OpenClaw Agent（Gateway HTTP 主路线，由 Commit 00 原型验证）
     → AI 内容 → 人工审核 → 人工复制发布
```

Context Pack：`{ business, knowledge[], watchlist[], customer, platform, task }`（v1.13 增 `watchlist`）一次组装、一次调用。**直接模型 API（如 DeepSeek HTTP）只作 Fallback**，会丢失 Agent/Skill/Tool/Memory 能力。

**Knowledge 检索策略（v1.10 写死，06 实现）**：α 阶段商家资料量小，**预算内全量打包**——先估算 business + 全部 ready knowledge 的 token，占所选模型上下文窗口 ≤60%（其余留给对话历史、生成与平台规则，具体阈值 06 按模型定）时全部注入，不做检索；超预算才退化为 LIKE 关键词裁剪（按 query 命中排序截断并标注截断）。理由：顾问类问题（「客户嫌贵怎么回」）与文档标题（「套系价目表」）常无字面重合，LIKE 检索会漏掉最相关资料；全量注入才能验证「AI 认识这个商家」。

### 已实测事实（2026-09-15，OpenClaw 2026.9.4）

**只读探测（安装版，端口 3213）**

- `GET /health` → 200 `{"ok":true,"status":"live"}`；`GET /v1/models` → **404**：OpenAI 兼容面默认关闭。
- 监听地址：**仅 `127.0.0.1:3213`**，未绑 `0.0.0.0` ✅（Commit 00 验收第 8 条）。
- 开关默认值应写入配置生成处（`configManager.ts` 约 :473 gateway 段）并覆盖老用户迁移（Commit 07）。

**Commit 00 SPIKE 实测（dev 实例，端口 3214；证据 `spikes/000-gateway-client/spike-result.json`）**

- 开启：`gateway.http.endpoints.chatCompletions.enabled = true`；鉴权 `Authorization: Bearer <GATEWAY_TOKEN>`。
- **`reloadKind = hot`：改配置后无需重启即生效**（实测 `/v1/models` 404 → 200）。
- `GET /v1/models` 返回 **`openclaw` / `openclaw/default` / `openclaw/main`** —— **`model` 取值是 `openclaw` 或 `openclaw/<agentId>`，不是 provider 模型 id**。
- 非流式**首次**调用 **80.3s**（agent 冷启动）；SSE **首字 1268ms**、总 13.6s → **产品必须走流式**，Commit 07 需加**预热**。
- 错误是**结构化 JSON**：坏 token → `401 {"type":"unauthorized"}`；坏 model → `400 {"type":"invalid_request_error"}`。
- **`usage` 恒为 0**（`prompt_tokens`/`completion_tokens`/`total_tokens`）→ **不能依赖 Gateway 返回的 token 统计**；Commit 06 的上下文预算改用**本地估算**。
- `user` 会话粘性**可回放历史**（⑥=A）、跨 user **隔离干净**（详见「对话历史存储」）。
- 客户端 `AbortController` 可中止流；服务端是否真正停止生成**未验证**（见第九节）。

**打包态端到端实测（2026-09-15，Commit 02 验收产出）**

- 打包应用加 `--remote-debugging-port` 后可用 **CDP 驱动真实渲染进程**调真 IPC，**不需要 GUI 截图通道**（Node 22+ 自带 `WebSocket` 即可，无需 puppeteer/playwright）。
- 便携模式确认：exe 同级存在 `data/` → 数据目录 = `<exe同级>/data`；便携 Node 路径 = `<dataDir>/runtime/node-<platform>-<arch>/node.exe`（冒烟前需先就位运行时，否则 `SETUP_REQUIRED`）。
- 实测链路：建库 11 表 / uv=1 / WAL / FK=on（sqlite 3.53.4）→ 写样例 → **优雅退出后 WAL 截断（`-wal`/`-shm` 消失）** → 重启读回、`migrated:false`。
- 关闭链路：`closeAction='ask'` 时窗口关闭被主进程拦截 → 渲染层确认框 → `resolveClose('exit')` 才真正退出（CDP 冒烟即走此路径，同时验证 before-quit → 注册表优雅停止）。
- Electron 的 CDP 只暴露 page target，**没有 browser target**（`Browser.close` 不可用）。

### PDF 内嵌图取图实测（2026-09-18，Commit 05b 验收产出）

- **`page.getOperatorList()` 完成即图像就绪**：`paintImageXObject` / `paintImageXObjectRepeat` 的位图从 `page.objs.get(objId)` 取（await 兼容 Promise/直返两形态），kind 1/2/3 = 1bit 灰度 / RGB24 / RGBA32。
- **BI/ID/EI 内嵌图不直发 OPS 86/87**（修正外部复审断言的前提）：pdfjs **v3** 的 worker 把内嵌图转译为 `paintImageXObject` + 合成 objId（形如 `img_p0_1`，**走 `page.objs`，`commonObjs` 里没有**）。OPS 86/87（`paintInlineImageXObject(Group)`，args[0] 直挂位图）是 worker 另一条路径（addImageOps）的形态——两条都接住，**不赌 pdfjs 内部实现**（05b 取图代码即此口径）。
- **AHx（ASCIIHexDecode）的 `>` 是 EOD 结束符**（ISO 32000-1 §7.4.4.1）：出现即终止解码——内容里夹 `>` 表现为**截断**（pdf.js 告警 "EOD marker not found, searching for /EI/" 即找不到 EOD 时的兜底路径）；构造内嵌图样本时行分隔只用空白。
- 证据（**可复跑**）：`npm run accept:scan` 的 **S13**（探针 P1-P4：逐页取图 / 手写 PNG 逐字节往返 / dataURI 过 07 校验 / 文字层 PDF 零图反向判据）与 **S17**（纯内嵌图扫描件端到端）；fixture 构造脚本 `test/fixtures/make-scanned-pdf.mjs`（含 `buildInlineImagePdf`）就是可复现 spec。探针复跑回写 `test/probe-scan-render.json`（仓库跟踪文件，时间戳 churn 属预期）。

### 会话隔离

- `user` 格式 `conv:<projectId>:<conversation_key>` 从第一天写死；**conversation_key 是 project 创建时生成的 uuid、持久化于 projects 表**（不放 app_meta，删 project 即随级联清除）。
- 每次打开复用同一 key：既防多 Project 间 Memory 串味，也保同 Project 的连续记忆。

### Fallback 规则

仅当 Gateway 多次探活且自动拉起均失败后才允许直连模型；UI 明示「当前未经过 OpenClaw，Skill / 知识库 / Memory 不可用」。

### 热点中心架构（Commit 11/12，v1.7 拍板）

```text
采集（不依赖 AI / Gateway）          评分（依赖 Context Engine + Gateway）
主进程定时触发 / 打开页面             打开热点中心 → 当前 project × 当前发布平台
→ hot-collector.mjs（只抓取）         → 未评分热点批量一次 Agent 调用（≤30 条）
→ stdout JSON → hotManager            → JSON 评分落 project_hot_topics（每平台一行）
→ DB Worker → hot_topics + samples    → 页面按分排序 + 推荐理由 + 一键带去 Content Center
```

- **后台定义（已拍板）**：仅应用运行时工作——主进程每分钟 tick，但**是否采集按 `app_meta.hot_last_fetch_at` 时间差判断（≥60 分钟才跑）**，不用 setInterval 直接计时（防机器睡眠唤醒后漂移/连跑）；打开热点页时同样看时间差决定是否立即刷新；另在系统唤醒（`powerResume`）事件后补一次检查。不做应用退出后的任务计划/常驻服务（二期如需，同一 collector 脚本可挂 Windows 任务计划，本期不实现）。
- **数据源三条供给线（v1.12 定稿）**：
  1. **榜单**（`origin=board`）：公开聚合 API（DailyHotApi 类），实测**无需认证直接调用**，覆盖 50-60+ 源（抖音热点 / 微博热搜 / 百度 / 头条 / 知乎 / B站 / 快手等）；collector 的 **base URL 可配置**——默认公开实例，高级用户可自部署（Docker/Vercel，本地 6688 端口）。
  2. **节点日历**（`origin=calendar`）：**自建 JSON**（节日 / 换季 / 大促 / 场景季，带提前量），零抓取、零鉴权、零失效、命中率 100%；走同一 `hot_topics` 与同一评分管线。对摄影店 / 女装店的实用价值高于全网热榜。
  3. **Watchlist**（`origin=watch`）：老板填的关注词，**一期只喂 AI 上下文，不触发任何采集**（表见 schema `project_watchlist`）。
- **v1.32 供给线修订（SPIKE 实测后，用户拍板方案 A）**：公共 DailyHotApi 实例 2026-09-19 全灭（官方域名 NXDOMAIN、镜像被墙/不可达），榜单供给改为两条腿——**头条/B站官方公开 JSON 直连为默认内置源**（免登录免 Cookie，实测稳定 50/20 条；adapter 各自带 UA、不做任何签名），**DailyHotApi 聚合协议保留但降级为可选项**（`config.hot.dailyhotBaseUrl` 缺省即跳过、状态条显示「已跳过」而非失败；自部署 6688 或公共实例恢复后填地址即插即用；默认路由去掉头条/B站，避免与直连双线重复）。实际产物文件名 `resources/collector/index.mjs`（硬规则 12 不变）；实现中钉死两条契约：**成功描述符必须显式 `ok:true`**、**single-flight 在 `isDue()` await 之后复查 inFlight**（均由 accept:hot 负向/并发断言锁定）。
- **小红书降级口径（v1.12 写死）**：小红书**没有公开、稳定、免鉴权的热点出口**（平台策略，非技术难度；第三方聚合源版本间时有时无）。Commit 11 SPIKE 实测两种结果均有预案——**验得通**则纳入，雷达双平台对称；**验不通**则降级为「综合榜 + AI 语义判断 + 节点日历」，并在 UI 明示小红书侧选题来源，**不得假装小红书有专属榜单**。影响可控：内容生产靠平台规则 Skill + 商家资料（不依赖小红书数据），`platform_fit` 本就由 AI 语义判断。
- **collector 结构（v1.12）**：`resources/collector/index.mjs` + `sources/*.mjs`（每来源一个 adapter），沿用硬规则 12。**红线：不做任何要求登录 / Cookie 的抓取。**
- **生命周期**：由 `hot_topic_samples` 时间序列计算（同热点 ≥2 次采样才能判 rising/breaking/peak/long_tail），首次入库标 `new`；跨源/跨标题去重靠 fingerprint + 标题相似度聚类。
- **采样保留与清理（v1.11 修订）**：每热点最多保留最近 24 条 samples；`last_seen_at` 超过 7 天（落榜）的 hot_topics 整行删除（级联清 samples 与评分），清理随每次采集后执行。**例外：被内容引用过的热点不删**——删除条件加 `AND id NOT IN (SELECT source_topic_id FROM contents WHERE source_topic_id IS NOT NULL)`，否则 7 天后级联 SET NULL 会冲掉 contents.source_topic_id，三期 Analytics 的热点溯源地基失效；保留行数 ≤ 累计内容数，成本可忽略。
- **评分懒计算（硬约束）**：严禁热点入库后向所有 project fan-out 调 LLM（O(热点×商家) 成本不可接受）；仅打开页面对当前 project × 发布平台的未评分热点批量评分（一次调用评多条），失败降级为裸榜（OPENCLAW_NOT_READY 不阻塞浏览）。
- **评分缓存 TTL（v1.9）**：`scored_at` 在 24h 内一律不重评（直接用缓存）；只有两种情况重算——用户点「手动重新分析」、或该热点落榜后重新上榜。成本模型就此闭合。
- **去重范围（v1.9 钉死）**：v1 只做**同源内**标题归一化（去特殊符号/统一大小写/剥平台前缀词）+ 阈值合并；**跨平台同一事件不物理合并**（抖音/微博各保留各的行，这样才回答得了「哪个平台最火」）。跨源 cluster 聚合需要额外表，二期再做，v1 接受同事件被各平台分别评分。
- **护栏沿用 Advisor**：推荐理由/选题角度只能基于 Business + Knowledge，资料不支持就明示；热点内容不自动发布，一键仅带入 Content Center 生成草稿，仍走人工审核（硬规则 10）。
- `platform_fit` 按 project_hot_topics.platform（发布平台）分别评分缓存；评分 prompt 中体现该平台适配性，防止抖音/微博源热点在小红书得到虚高适配分。
- **Commit 11 页面降级**：11 是纯工程、可早于 09 交付；热点页「带去 Content Center」按钮在 09 上线前占位禁用，11 不得提前实现内容生成。**【v1.32 实际情况：09/10 均已上线，11 直接交付可用跳转；占位降级条款未被触发】**
- **Commit 12 评分边界（v1.8）**：每次批量调用最多 30 条，仅评近 7 天在榜（last_seen_at）且当前 project × 平台未评分（或超过 24h TTL 且手动触发）的热点；返回 JSON 部分条目解析失败时，成功条目照常落库、失败条目留待下次重试，整次调用失败才降级为裸榜。
- **热点雷达页 UI 规格（v1.11 统一口径，12 的验收标准）**：时间范围默认近 24h（可切 3 天/7 天）；默认只展示 Top 20；**评分三档 + 一个待分析态**——🔥 值得跟（match_score ≥ 70 **且** platform_fit ≥ 70，双门槛防高相关低适配误推）/ 👀 观察（任一分数 40–69）/ ❌ 不建议（均 < 40）/ ⏳ 待分析（尚未评分，不参与三档，续评后自动归位）；底层数字全部保留可查，分组只是展示层。
- **数据源健康状态（v1.9）**：每个数据源的最后成功时间/错误写 `app_meta.hot_source_status / hot_source_error`（不建表）；热点雷达页顶部显示各源「正常 · N 分钟前 / 异常已降级」状态条，单源失败不拖垮整页与其他源。
- **热点 → Content Center（v1.9）**：09 落地跳转，携带结构化 payload `{ topic_id, title, source_platform, platform, content_angle, lifecycle_advice }` 预填充生成表单；11 阶段按钮只占位禁用。**【v1.32：11 已实装该跳转（前端字段名 topicId/contentAngle/lifecycleAdvice 驼峰），11 无评分故后两字段恒 null；按钮对所有热点（含未评分、日历节点）可用，仅预填选题，生成/发布仍全人工】** **热点情报永不自动写入 Knowledge Base**（External Intelligence ≠ Merchant Knowledge，概念见第十节），只有老板人工采纳后才可能成为商家资料。

### AI Advisor 定义（Commit 08 交付边界）

**定位**：营销工作台内的 grounded 对话入口——老板用自然语言提问（卖点怎么讲、客户嫌贵怎么回、给几个内容角度），AI 基于**当前 Project 的 Business + Knowledge** 回答。它是 06 Context Engine 与 07 Gateway Client 的第一个真实消费者，用来证明「AI 认识这个商家」。

交付物：

- 聊天面板：消息流 + SSE 流式渲染 + 「停止生成」（AbortController；组件卸载或切换商家时必须中止上游请求，避免白烧 token）。
- 每轮请求 = Context Pack（business 摘要 + 命中的 knowledge 片段 + 平台/任务说明）+ 用户消息，经 07 调 Gateway，`user=conv:<projectId>:<conversation_key>`。
- 复用 07 的探活/自动拉起/统一错误码；切换 Project 即换 conversation_key，记忆天然隔离。
- 事实护栏：价格/套餐/承诺只能引用知识库；资料中没有就明示「资料里没有，建议补充」，禁止编造。

明确不做（v1）：

- 不做结构化内容生产（选题→平台规格→成稿→版本→审核归 Commit 09 Content Center）；
- 不做数据复盘型建议（v1 无发布数据，属第三阶段 Analytics）；
- 不做自动回复/自动发送（硬规则 10），Advisor 只服务老板本人；
- 不做主动任务执行。

对话历史存储按本节上方「对话历史存储」预案，由 Commit 00 验收⑥的结论拍板。

## 七、Commit 计划（14 个提交：00-12 + 05b；合计约 27 人天；v1.9 加依赖列、v1.12 上调估时）

| # | 主题 | 内容 | 估时 | 依赖 | 负责人 | 状态 |
|---|------|------|------|------|------|------|
| 00 | SPIKE：Gateway Client 原型 —— **✅ 2026-09-15 通过（VALIDATED / Primary）** | 开 chatCompletions → 完整链路 5 场景 + 多模态/模型选择 + CLI/直连快速对比 → **结论：Primary = Gateway HTTP；直连保留 Fallback；⑥=A 不建 project_messages；`usage` 恒 0（06 改本地估算）；`model`=`openclaw`/`openclaw/<agentId>`；SSE 首字 1.27s / 冷启动 80s（07 加预热）** | 0.5d | — | | ⬜ |
| 01 | UI / 导航骨架 —— **✅ 2026-09-15 完成** | Sidebar 4 组（工作台/营销5/OpenClaw6/系统2，to 值不变）、Dashboard 三卡（状态卡 + 当前商家 + AI 营销）、`/marketing/*` 5 条占位路由（共用 `Placeholder.vue`）、**首启 Setup 守卫**（独立模块 `setupGuard.ts`，判定 `nodeInstalled && openClawInstalled`）+ Setup 完成后 reload、10 条旧路由保留 | 1.5d | —（与 02 并行） | | ✅ |
| 02 | DB Worker + 构建 —— **✅ 2026-09-15 完成** | schema/migration + `db-worker.mjs` 单例（零依赖 JSONL，84 白名单方法）+ `database.ts` 客户端（惰性初始化/队列/30s 超时/断线重启/读重试写不重试）+ 子进程注册表接入（`_stopRuntimeProcesses` 前置优雅停止）；**`build:win` 出包（81.8MB）+ 打包态端到端冒烟通过（验收见下）** | 2d | —（与 01 并行） | | ✅ |
| 03 | Project —— **✅ 2026-09-16 完成** | projectManager + store + CRUD + conversation_key 生成 + 切换持久化 app_meta（落点与验收见下） | 1d | 02 | | ✅ |
| 04 | Business —— **✅ 2026-09-16 完成** | businessManager + BusinessBrain.vue + 摄影行业首套字段 + upsert/级联删除验收 + 资料完整度卡片（Business 维度）+ Watchlist（手工增删 / 行业预设词 / 上限 10 词 / 不采集）；落点与验收见下 | 2.5d | 02、03 | | ✅ |
| 05 | Knowledge（仅 05a） —— **✅ 2026-09-16 完成** | knowledgeManager + KnowledgeBase.vue + 文字层文档解析（docx/xlsx/pdf/url/faq）+ 导入/重导入 + LIKE 检索 + Knowledge 维度完整度；落点与验收见下 | 2.5d | 02、03 | | ✅ |
| 06 | Context Engine —— **✅ 2026-09-16 完成** | Business + Knowledge + **Watchlist** + Platform → Context Pack（落点与验收见下） | 1d | 00、04、05 | | ✅ |
| 07 | Gateway Client —— **✅ 2026-09-16 完成** | 端点开关默认化 + 老用户迁移、探活、自动拉起（**复用 clawManager 启停，不另起炉灶**）、就绪轮询、SSE→IPC 透传、会话隔离、多模态模型选择（落点与验收见下；顺带修待办 #15） | 2d | 00 | | ✅ |
| 05b | 扫描件 AI 识别兜底 —— **✅ 2026-09-18 完成**（探针 PASS，扫描 PDF 全量实现未降级） | 复用 07：扫描 PDF/带文字资料图的「用 AI 识别」显式触发 + 识别结果人工确认后入库；00⑦ 结论为不支持则只做提示（落点与验收见下） | 1.5d | 05a、07（与 08 并行） | | ✅ |
| 08 | AI Advisor —— **✅ 2026-09-17 完成**（主进程 + 渲染端） | Grounded 营销问答面板（边界见第六节）：Context Pack + SSE + 停止生成 + 事实护栏；对话历史按 00⑥ 结论；**+ Watchlist AI 扩词推荐（候选词生成 + 用户勾选，v1.13 由 04 移入）**（落点与验收见下） | 2d | 06、07 | | ✅ |
| 09 | Content Center —— **✅ 2026-09-18 完成**（主进程 + 渲染端） | AI 生成（SSE 流式 + **AbortController「停止生成」**，规格同 08：组件卸载/切换必须中止上游）→ 编辑 → 版本（prompt 快照）→ 人工审核；**接收热点雷达结构化 payload 预填充（v1.9），source_topic_id 溯源（v1.10）**；**一次生成 3 个版本供选 + 极简发布标记（v1.12）**（落点与验收见下） | 3d | 06、07、08 | | ✅ |
| 10 | 双平台工作流 —— **✅ 2026-09-19 完成**（主进程 + 渲染端提示） | **小红书 + 抖音**平台适配（两套平台规则模板：挂 `pack.platformRule`，注入 09 生成指令/版本快照与 08 Advisor system）；抖音一期只做口播脚本/标题/话题标签文案层，不做视频；均人工复制发布（落点与验收见下） | 2d | 09 | | ✅ |
| 11 | 热点采集与浏览（🔥 热点雷达） —— **✅ 2026-09-19 完成**（主进程 + 渲染端） | SPIKE 改写供给线（公共聚合实例全灭→头条/B站官方公开 JSON **直连为默认**，聚合协议保留可配；见 v1.32）+ collector adapters（只抓取 stdout JSON，硬规则 12）+ hotManager 经 Worker 落库 + 时间差定时/唤醒补检/打开即刷（single-flight）+ 三表（02 已建，worker 零改）+ **同源内**去重 + 生命周期 + 采样保留(24 条)/落榜清理(7 天，contents 引用例外) + 数据源状态条（成功/失败/跳过三态）+ HotCenter 雷达页（近 24h/Top20/源筛选/发布视角；「带去 Content Center」已实装六字段 payload）；节点日历自建 adapter（origin=calendar）；extraResources 整目录随包零改；不依赖 Gateway（落点与验收见下） | 3d | 02（可与 03-06 并行） | | ✅ |
| 12 | AI 商家匹配 | 当前 project × 平台懒评分（≤30 条/次、近 7 天在榜、24h TTL；**待评超 30 条按 heat 取前 30，每次打开雷达续评一批直到评完**）+ JSON 落库 + 部分失败容错 + 整体失败降级裸榜 + 分组（🔥/👀/❌ + **⏳ 待分析**）+ 手动重新分析 + 事实护栏；**雷达顶部「今日建议」摘要（1 条主推 + 理由 + 时机）（v1.12，✅ 已落地）** —— **✅ 2026-09-20 完成（落点与验收见下）** | 2d | 06、07、11 | | ✅ |

顺序备注：00 必须第一；**01 与 02 互不依赖、可并行**；03/04/05 依赖 02；06 必须在 00 结论之后；07 之后插入 05b（可与 08 并行），08/09/10 顺序推进；**11 是纯工程，02 完成后即可与 03-06 并行（跳转按钮占位到 09）；12 必须在 06/07/11 之后**。一期做完再整体测试，后续迭代优化。

### Commit 03 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/projectManager.ts    新增（注入式依赖，不 import electron，纯 Node 可 bundle 测试）
electron/main/ipc/{marketing,index}.ts       新增 marketing:project:* / marketing:context:* 通道
electron/preload/index.ts                    api.marketing.project.{list,get,create,update,delete}
                                             api.marketing.context.{getCurrentProject,setCurrentProject}
electron/main/index.ts                       工厂 + wiring（dataDir / DatabaseClient / logger）
src/stores/marketing.ts                      新增 Pinia store
src/views/components/ProjectSwitcher.vue     新增：侧边栏切换器（切换 / 新建 / 重命名 / 删除 + 危险确认弹窗）
src/composables/useProjectSwitcher.ts        新增：切换器开关单例（工作台卡片可复用同一面板）
src/App.vue / src/views/Dashboard.vue        挂载切换器；「当前商家」卡接真实数据
test/project.accept.mjs + `npm run accept:project`   18 项验收（打真 projectManager.ts）
```

**验收（独立复跑）**：`accept:project` **18/18**；`typecheck:node` / `typecheck:web` 0 错；Commit 02 回归 `accept:db` **31/31** 不受影响。

**打包态端到端（真安装包产物 + CDP 驱动真渲染进程调真 IPC，非替身）**：
新建 `E2E 摄影工作室`（id / conversation_key 均为 uuid，`data/projects/<id>/` 已建）→ 设为当前 →
**优雅退出**（WAL 截断）→ **重启后当前商家仍是它** → 改名（`conversation_key` / `created_at` 不变，current 仍指同一 id）→
删除（`dirRemoved` / `rowDeleted` / `currentCleared` 全 true，列表清空、目录消失）。复现脚本 `test/packaged-smoke.mjs`。

**关键设计决策**

- 删除顺序逐字按 §十：**目录删不掉时行必然还在**（P12 实测：占用期回 `DB_ERROR(project-dir-remove-failed)` + 行与子数据保留 + 释放句柄后重试成功）；顺序反了行就没了。
- `currentBefore` 必须在删行**之前**取，否则拿不到「原本指向谁」这个事实；清空失败不反转已成功的删除，残留悬空指针由读路径自愈兜底。
- `conversation_key` 创建即定、`update` 白名单外一律 VALIDATION_ERROR（静默丢弃会变成「改了但没生效」的幽灵 bug）；删除后同名重建拿**新键**，绝不复活旧键。
- `Project` 契约**不含 conversation_key** —— §六 的 `user=conv:<projectId>:<key>` 拼装在主进程（硬规则 13），渲染端拿不到也不需要。

⏳ **未覆盖**：①「删行失败」分支需在 DELETE 执行中途让 Worker 崩溃（竞态不可靠），仅代码审阅；②store 的三条降级语义（load 部分降级 / create 后 select 失败仍返回 project / remove 同步本地 current）无单测（仓库无 vitest）；③UI 点击流本机无桌面通道未做（IPC 面已由打包端到端覆盖）。

### Commit 04 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/businessManager.ts   新增：BusinessManager（get / upsert / delete）+ WatchlistManager（list / add / remove / setEnabled）
electron/main/ipc/marketing.ts               +marketing:business:{get,upsert,delete} · marketing:watchlist:{list,add,remove,setEnabled}
electron/preload/index.ts                    api.marketing.business.* / api.marketing.watchlist.*
electron/main/index.ts                       工厂 + wiring
src/stores/marketing.ts                      +business / completeness / watchlist 三切片
src/constants/photographyPresets.ts          新增：摄影行业预设（定位 6 / 客群 6 / 语气 5 / 关注词 10）
src/views/marketing/BusinessBrain.vue        新增：完整度卡 + 基本盘表单（预设筹码可点选）+ Watchlist 区
src/renderer/main.ts                         /marketing/business 由占位页换真页
test/business.accept.mjs + `npm run accept:business`   16 项验收（打真 businessManager.ts）
```

**验收（独立复跑）**：`accept:business` **16/16**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、`accept:project` **18/18** 均不受影响。

**打包态端到端（真安装包 + CDP 驱动真渲染进程调真 IPC）**：
新建商家 → `business.upsert` 存 4 字段 → 读回一致且 `created_at` 稳定 → Watchlist 加满 **10 个** →
第 11 个 **VALIDATION_ERROR(max:10)** → 重复词 **CONFLICT** → 删一个后第 11 个加入成功 →
**优雅退出 → 重启后资料与 10 个词全在** → 删 Project → `business.get` 回 `null`、关注词清空、
`dirRemoved` / `rowDeleted` / `currentCleared` 全 true；**直读库复核** `projects=0 / businesses=0 / project_watchlist=0 / current_project_id=null / integrity_check=ok`。

**关键设计决策**

- **upsert 的 ON CONFLICT 目标**：worker 的 `businesses.upsert` 冲突目标是主键 `id`，**打不到 `project_id UNIQUE`**。故先按 project_id 读既有行 → 用它的 `id` 走 upsert（真正的单语句 `INSERT … ON CONFLICT(id) DO UPDATE`）；首插走 create，并发撞 `UNIQUE(project_id)`（worker 把 UNIQUE 映射为 CONFLICT）→ 回落更新路径重试一次。**「同 project 反复 upsert 只有一行」由 `UNIQUE(project_id)` 兜底**（B4/B5 两路都验证），**没有为此改 worker**。
- **`created_at` 必须显式回传**：`ON CONFLICT DO UPDATE` 会把未提供的列一并写成 excluded 值，漏掉它等于每次保存都把「创建时间」刷成现在。
- **未传字段 = PATCH 保留旧值**；显式 `null` / 空串才清空（PUT 式「未传即清空」会让部分调用者误删数据）。
- **完整度口径**：`name / brand / city / positioning / target_customer / tone` 六项**等权**，**排除 address / phone**（联系方式不属于「AI 认识你」的语义信息）；Knowledge 维度归 05。跨 tsconfig 无法共享常量 → store 与 manager 各留一份，由 B16 做**静态一致性核对**防漂移；`missing` 返回字段名，卡片渲染用 `BUSINESS_FIELD_LABELS`。
- **错误语义分开**：读无行 → `null`；写目标不存在 → `NOT_FOUND`（防「点了没反应还说成功」）；`remove` / `deleteBusiness` **幂等**（`removed:false` / `deleted:false`，重复点删不弹错）；`type` 非法 → VALIDATION_ERROR（不静默归一，避免污染喂给 AI 的分类）。
- **不采集**：Watchlist 只作 AI 上下文，B15 对模块源码做静态扫描（7 类网络特征 0 命中）。

⏳ **未覆盖**：①UI 点击流本机无桌面通道未做（IPC 面已由打包端到端覆盖）；②完整度常量跨 tsconfig 双份（有 B16 静态核对兜底，但仍是两份）；③Watchlist 无批量导入/导出（不在基线范围）。

### Commit 05a 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/knowledgeManager.ts        新增：list/get/create/update/delete/search + import（本地解析一次入库）
electron/main/marketing/parsers/documentParsers.ts 新增：docx(mammoth) / xlsx(exceljs) / pdf(pdfjs) / text / markdown / faq
electron/main/marketing/parsers/urlParser.ts       新增：HTML→文本（去 script/style、实体解码、块级转行）
electron/main/marketing/parsers/pdfjsAssets.ts     新增：pdfjs 资产 dev/安装包双路径解析
electron/main/ipc/marketing.ts + preload + index.ts  marketing:knowledge:{list,get,create,update,delete,search,import,pickFile}（v1.28 注：§五 已补齐至 11 方法——05a 当时没同步 §五 造成两口径并存，05b 的 3 条入 §五 时一并改齐）
src/stores/marketing.ts                            +knowledge 九件套 + knowledgeCompleteness + overallCompleteness
src/views/marketing/KnowledgeBase.vue              新增：四路导入（文件/文本/网址/FAQ）+ 拖拽 + LIKE 检索 + 列表预览 + 删除
src/renderer/main.ts                               /marketing/knowledge 由占位页换真页
resources/pdfjs/                                   4.54 MB：cmaps 1.11MB(169 个 .bcmap) + standard_fonts 0.74MB + build/pdf.worker.js(2.01MB) + build/pdf.js(0.68MB)
test/knowledge.accept.mjs + `accept:knowledge`     23 项验收（打真 knowledgeManager.ts；v1.19 记录为 21 项，后续两笔 05a 修复补了 2 项）
test/fixtures/{make-minimal-pdf.mjs,min-text-layer.pdf}  提交级最小 PDF fixture（710 字节）
```

**验收（独立复跑，非自述）**：`accept:knowledge` **23/23**（v1.19 时的 21/21 是当时实际值，之后两笔 05a 修复补了 2 项用例；套件当前规模以 23 为准）；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、`accept:project` **18/18**、`accept:business` **16/16**；
**K8 用真中文文字层 PDF 跑实** → 一份 8 页国标 PDF 抽出 **3015 个汉字**，关键词「国卫生部」命中。

**打包态端到端（真安装包 + CDP 驱动真渲染进程调真 IPC）**：安装包内导入真中文 PDF →
`status=ready`、正文 **7030 字**、`source_name` 正确、列表 1 条、中文关键词「值域代码」检索命中（snippet 为真实中文）。
→ 满足 05a 验收补充项「**安装包环境（非 dev）pdfjs 可用**」。

**关键设计决策**

- **重导入 upsert 键与路径**：键 = `UNIQUE(project_id, source_path)`；worker 的 upsert 冲突目标是主键 `id`、打不到该唯一键 → 先按键查既有行、用它的 `id` 走 `INSERT … ON CONFLICT(id) DO UPDATE`，并发撞键回落重试一次（与 businessManager 同构）；**`created_at` 必须显式带回**，否则每次重导入都刷掉首次导入时间。`source_path` 存**相对 dataDir 的正斜杠路径**（`projects/<id>/<净化文件名>`），URL 类存原始 URL，text/markdown/faq 存 `NULL`。
- **扫描件检测**：抽样页面文字量≈0 → `FILE_PARSE_ERROR` + `reason=scanned-pdf`，**不落行、不落文件**（K9 断言库里 0 空内容行、0 孤儿文件）；`doc/xls` 老格式 → `VALIDATION_ERROR` + 提示另存为新格式。
- **parser 与 electron 解耦**：manager/parsers 不 import electron，pdfjs 资产路径由 `pdfjsAssets.ts` 注入解析（dev 用 `app.getAppPath()/resources`，打包用 `process.resourcesPath/resources`），因此纯 Node 可测（K20 断言 dev/pack 两条路径 + bundle 内无 pdfjs 静态引入）。
- **url 类口径**：只做 http(s) 单次 GET + 本地 HTML→文本，**不跟 Cookie、不调第三方 API、不做站点特化**（K21 静态扫描 5 类网络特征 0 命中）。

⏳ **未覆盖**：①K8 默认 SKIPPED（需 `KNW_PDF_SAMPLE` 指真中文 PDF，本机已跑实并把结果记在此处）；②UI 点击流本机无桌面通道未做（IPC 面已由打包端到端覆盖）；③**仓库 `package-lock.json` 与 `node_modules` 存在既存漂移** —— 本次依赖（mammoth/exceljs/pdfjs-dist）是「隔离安装 + 只补不覆盖」补入的（新增 34 包、0 覆盖），**未执行 `npm install`**（dry-run 显示它会删掉 471 个包，含 electron-builder 的依赖）；锁漂移修复留作独立动作。

### Commit 07 落点与验收（✅ 2026-09-16）

```text
electron/main/gatewayClient.ts        新增：GatewayClient（probe / listModels / getStatus / ensureReady / chat / createChatStream / cancel）
                                      + 模型选择纯函数（selectGatewayModel / normalizeGatewayModel / detectMultimodalCapability）
                                      + 图片部件（imageDataPart / imageUrlPart）+ buildConversationUser + forwardGatewayStream 透传助手
electron/main/ipc/gateway.ts          新增：marketing:gateway:{status,ensureReady}（**只两条只读/幂等通道**）
electron/main/ipc/index.ts            + registerGatewayIpc / MARKETING_GATEWAY_CHANNELS 转出
electron/preload/index.ts             + api.marketing.gateway.{status,ensureReady}（只拿快照，拿不到 token）
electron/main/index.ts                + wiring：createMarketingGatewayClient（token 注入 / starter 复用 clawManager.start /
                                        conversationKeyResolver 走 projectManager 取 conversation_key）
electron/main/configManager.ts        + 端点开关默认化与老用户迁移；#15：删 meta.lastTouchedAt、lastTouchedVersion 写真实安装版本
test/gateway.accept.mjs + `npm run accept:gateway`   20 项验收（真 http 服务端 + 真 configManager + 真 ProjectManager）
test/fixtures/electron-stub.mjs       新增：只在 'electron' 宿主边界打桩（configManager 顶层 import { app, dialog }）
test/_lib.mjs                         + bundleEntry 的 `alias` 能力（把某模块名换成桩文件）
```

**验收（独立复跑，非自述）**：`accept:gateway` **26/26**（含外部复审响应新增的 6 项）；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、`accept:project` **18/18**、`accept:business` **16/16**、`accept:knowledge` **23/23**、
`accept:context` **22/22** 均不受影响。

**关键设计决策**

- **真 HTTP 服务端，不注入假 fetch**：验收用 Node http 起真服务端（真 socket、真 SSE 帧、真断连），
  因此测到的是真实 fetch/undici 行为——G7 才证得了「cancel 会真的销毁上游 socket」（服务端观测到 close，且只发出 2/80 帧）。
- **流式响应体已开始后的传输中断 = `stream-truncated`，不是 `connect-failed`**（本提交修正）：
  网关明明在跑、流到一半断掉，若报 `connect-failed`，前端按 §五 会引导去「环境初始化」——既误导，
  也丢掉「已收到一部分内容」这个事实。超时与主动中止仍按各自语义优先。
- **端点开关写在 `_syncOpenClawConfig`（配置生成与同步的唯一入口）**：新装与老用户同一条路径，
  只写 `gateway.http.endpoints.chatCompletions.enabled` 这一个叶子键，展开已有子对象 → **幂等且不毁其它字段**
  （验收 G17/G18 断言了自定义 gateway 字段、chatCompletions 子键、channels、agents、顶层字段全保留，且两次同步字节一致）。
  实测确认 `reloadKind = hot`（§六），故不需要重启网关。
- **#15 修法**：`meta.lastTouchedAt` 根本不是 schema 字段（`meta` 是 `additionalProperties: false`），直接删；
  `lastTouchedVersion` 语义是「最后写这份配置的 OpenClaw 版本」，改为读 `data/openclaw/node_modules/openclaw/package.json`
  写真实版本，**读不到就整键省去**——宁可没有该字段，也不写非法值。
- **会话隔离键只在主进程拼**：`conversationKeyResolver` 由主进程用 `projectManager` 读 `projects.conversation_key`，
  渲染端拿不到也传不了；`buildConversationUser` 拒收含 `':'` 的字段（能伪造别人的会话边界 → 跨 Project 串 Memory）。
- **07 只交付透传层，不注册业务流通道**：`forwardGatewayStream(webContents, streamId, iterator)` + 事件名常量
  （chunk/done/error）给 08/09 用；IPC 只开 `marketing:gateway:{status,ensureReady}`（理由是 §五 错误码
  `OPENCLAW_NOT_READY` 的前端处理必须有一个只读就绪面）。**待拍板**：这两条是否该等 08 一起开。
- **多模态选择是「宁可报错也不假装看得见」**：`models.multimodal` 未配置时，含图请求直接
  `VALIDATION_ERROR` + `details.reason='multimodal-model-not-configured'`，不降级成纯文本发出去。

**外部复审响应（2026-09-17，10 条逐条核实 → 6 修 4 存）**

- **中①「配置快照在启动时固化」属实**：客户端在 `app.whenReady` 构造时把 `models.multimodal` 算死，
  而 Setup 完成只走渲染端 `location.reload()`（主进程不重启，PLAN v1.4 已定的做法）→ 05b 的扫描件识别会被
  `multimodal-model-not-configured` 拒到用户完全重启 App。**修法**：新增 `modelsResolver`，**每次组请求时重读配置**
  （`index.ts` 的 `resolveGatewayModels()`）；G22 固定（同一个 client，配置一变即生效）。
- **中②「abort 两种时序语义不一」属实**：响应头之前 `cancel()` 会 reject（`OPENCLAW_TIMEOUT/aborted`），
  之后才 resolve `{aborted:true}`，与 `GatewayStreamHandle` 的注释契约相矛盾。**修法**：catch 里识别 `scope.cancelled`
  统一 resolve；G23 固定（响应头前中止 → `aborted:true`、text 空、迭代器干净收尾）。
- **低①「就绪缓存永久有效」属实**：缓存只在 ready 时写入、从不过期，网关中途崩掉后 `ensureReady()` 会直接回陈旧快照
  （连 starter 都不调）。**修法**：任何「没成」的调用都作废缓存（connect-failed / timeout / 401/403/404/429/5xx）；
  **刻意不自动重试**——重试 POST 会再生成一次、白花 token，由 08 的「重试」按钮走 `ensureReady` 重新探活/拉起。G24 固定。
- **低②「destroyed 自动中止没接线」属实**：`once` 只在接口里声明、实现只靠每个 chunk 查 `isDestroyed()`，
  而冷启动静默期（实测最长 80.3s）根本没有 chunk 到达。**修法**：真注册 `webContents.once('destroyed', cancel)`；G25 固定。
- **小 temperature 静默丢弃**（超范围不报错）→ 改为 `VALIDATION_ERROR`（与 businessManager「不静默丢」同口径）；G26 固定。
- **小 `/v1/models` 200 但非 JSON 被判 `enabled:true`** → 结构不符即 `enabled:false` + `reason='unexpected-response'`；G27 固定。
- **不修的 4 条**（见待办 #23）：429 码语义（§五 码表无「限流」码，已带 `details.reason='rate-limited'` 供前端分支）、
  非流式读体不在超时保护内（主路径是 SSE，逐帧重新计时）、SSE 不拼多行 `data:`（OpenClaw 单帧单行 JSON）、用例跳号（仅观感）。

**打包态端到端（#25，2026-09-17 补做 → 7/7）**

```text
test/packaged-gateway.smoke.mjs   新增：真产物 release/win-unpacked + CDP 驱真渲染进程 + 便携数据目录
test/packaged-smoke-07.json       结果落盘（7 项）
```

- P1 建库 **11 表 / uv=1**（打包态便携 Node + `db-worker.mjs`）· P2 打包 preload 真暴露 `marketing.gateway.{status,ensureReady}` 且面内无 token ·
  P3 `status` **真发 HTTP** 并正确判「未就绪」（`OPENCLAW_NOT_READY/connect-failed`，零 token、不触发拉起）·
  P4/P5 打包态 Project / Knowledge / LIKE 检索 / Watchlist / 当前商家全通 ·
  P6 **打包启动即同步**：`openclaw.json` 里 `chatCompletions.enabled=true` 且 `meta` 无非法字段（= #17 + #15 在真产物里落地）·
  P7 打包 main 里 06/07 两模块真被构造（`[context] Context Engine 就绪` / `[gateway] Gateway Client 就绪`）· 残留打包进程 **0**。
- ⚠️ **安全阀（必须保留）**：`clawManager.start()` 内含 `_killGhostProcesses()` → `taskkill /f /im openclaw.exe`，在开发机上会误杀**正在运行**的 OpenClaw（含托管会话的实例）。故冒烟脚本：预写便携 `app.json`（`autoStart:false` + `port:3299` 避开真机 3213）、**绝不调** `claw:*` / `marketing:gateway:ensureReady`、收尾只按 **PID** 结束本进程。以后跑同类冒烟沿用这三条。

### Commit 05b 落点与验收（✅ 2026-09-18）

```text
electron/main/marketing/scanRecognizer.ts    新增（~1000 行，注入式、不 import electron/不发 HTTP/不碰库）：pdfjs 取图（objs + OPS 86/87 防御分支）→ 零依赖手写 PNG → 逐页（含同页多图归组）流式识别；上限三闸（20MB/12页/6MB 图）；activeTasks 注册表先于栅格化
electron/main/ipc/scan.ts                    新增：marketing:knowledge:{recognize, recognize:abort, commitRecognized} + abortAllScanStreams；增量经 07 forwardGatewayStream
electron/main/ipc/marketing.ts               picker 增「资料图（png/jpg/jpeg/webp）」过滤器组
electron/main/marketing/knowledgeManager.ts  +commitRecognized（人工确认后唯一写入口；同 source_path upsert 覆盖）
electron/main/index.ts                       工厂/wiring（multimodalConfigured 预检复用 resolveGatewayModels）+ before-quit abortAllScanStreams
electron/preload/index.ts                    +knowledge.{recognize, abortRecognize, commitRecognized}；流订阅复用 advisor 的 onChunk/onDone/onError（07 全局事件名）
src/stores/marketing.ts                      +scan 切片：代际守卫 scanCallSeq（防栅格化窗口切商家回写串台）、scanCleanText（剥进度标记）、abort 两路
electron/main/marketing/KnowledgeBase.vue    「用 AI 识别」→识别面板→确认弹窗（校对后文本入库；「价格数字请人工核对」显著提示）；四路中止之停止/切商家/卸载
test/scan.accept.mjs + `accept:scan`         18 项（真源码 bundle + 真 SSE 服务端 + 真库直读）
test/scan.probe.mjs（P1-P4 探针，S13 复跑）+ fixtures/make-scanned-pdf.mjs（扫描/同页多图/内嵌图三形态）
```

**验收（独立复跑）**：`accept:scan` **18/18**；回归 `accept:knowledge` **23/23**、`accept:gateway` **27/27**、`accept:advisor` **10/10**、`accept:db` **31/31**、`accept:context` **22/22**；`typecheck:node` / `typecheck:web` 0 错。

**关键设计决策**

- **探针先行（P1-P4 PASS）→ 全量实现不降级**：`getOperatorList()`→`page.objs`→zlib 手写 PNG **逐字节无损往返**实测成立（证据口径见 §六 新小节）；若探针失败本提交降级为「只收图片文件 + 按钮置灰」。
- **人在回路落在方法边界**：scanRecognizer 源码级零落库路径（S1 静态扫描），确认前直读库断言 0 行、确认后才 1 行（S11）；唯一写入口 commitRecognized 复用 05a 的 upsert 键与拷贝语义（同文件重复确认覆盖、created_at 不动）。
- **一页一请求 + 识别会话键 `conv:<pid>:scan-<taskId>-p<页>-i<图序>-a<重试>`**：不把 OCR 转录灌进商家 Advisor 的 sticky 历史，后图也「看不见」前图（防成本翻倍/串读）；同页多图按页归组汇总，**页数上限按页不按图计**（S16）。
- **multimodal 双保险**：预检（注入 `multimodalConfigured`，栅格化**前**拒、`stage='precheck'`，零请求零解码）+ 07 按次解析最终防线；两条路同 payload（reason=multimodal-model-not-configured），绝不静默降级纯文本（S6）。
- **只重试可恢复错误**（NOT_READY/TIMEOUT 各 1 次、流内明示「重试」）；401/配置类原码透传绝不重试（S9/S10）；判定用 `errorCodeOf` 不跨 bundle `instanceof`。
- **中止全生命周期即时**：注册表先于栅格化（S15 门控 getDocument：解码期 cancelByProject 命中 → 解码完 0 请求）；abort IPC 两路定位（taskId/projectId）；四路 = 停止按钮/切商家/卸载（渲染端代际守卫 + clearScan 双参 abort）/退出（before-quit）；cancel 返回「首次作废」使两本账去重计数。
- **价格不盲信模型**：本地正则定 `priceSuspected`（主进程/store 双份字面量由 S12 静态同源核对），确认弹窗「价格数字请人工核对」；进度标记只进直播流，权威汇总与确认基准都不含（scanCleanText 兜底中止态）。

⏳ **未覆盖 / 已知风险**：①真 Gateway + 真多模态模型端到端未做（本机 3213 兼容面未开，与 08 同状态）；识别质量（护栏遵守/表格串行）需人工试用样本标定。②真界面点击流未做（本机无桌面通道）。③资料图（非 PDF 页）不降采样——jpg/webp 零依赖解不了码，超 6MB dataURI 闸即拒并提示降分辨率。④中止粒度按页——单页 getOperatorList 进行中不可打断（实测亚秒级，无真实卡死形态）。

### Commit 08 落点与验收（✅ 2026-09-17）

```text
electron/main/marketing/advisorManager.ts   新增：AdvisorManager（ask / buildSystemPrompt / suggestWatchlist）+ parseWatchCandidates（脏输出容忍）
electron/main/ipc/advisor.ts                新增：marketing:advisor:{ask,abort,watchCandidates} + summarizePack + abortAllAdvisorStreams
electron/main/ipc/index.ts                  + 转出 advisor 面
electron/preload/index.ts                   + api.marketing.advisor.{ask,abort,watchCandidates,onChunk,onDone,onError}
electron/main/index.ts                      + 工厂/单例/wiring（注入 06 引擎 + 07 客户端 + 04 Watchlist）+ before-quit 中止在途流
src/stores/marketing.ts                     + advisor 切片（消息流/发送/停止/扩词候选/按 streamId 归并订阅/dispose）；ERROR_TEXT 改为导出
src/views/marketing/AdvisorPanel.vue        新增：聊天面板（流式渲染 + 停止生成 + 「AI 看见了什么」摘要 + 缺口提示 + 扩词候选勾选）
src/renderer/main.ts                        /marketing/advisor 由占位页换真页
test/advisor.accept.mjs + `npm run accept:advisor`   10 项验收（打真 advisorManager.ts + 真 Node SSE 服务端）
```

**验收（独立复跑，非自述）**：`accept:advisor` **10/10**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:gateway` **27/27**、`accept:context` **22/22**、`accept:db` **31/31**、`accept:project` **18/18**、
`accept:business` **16/16**、`accept:knowledge` **23/23** 均不受影响。

**关键设计决策**

- **每轮只发 system + user 两条**：历史由 OpenClaw 的 sticky `user=conv:<projectId>:<conversation_key>` 承载
  （§六 结论 A），本地**不建消息表、不回灌**。A2 直接断言 `messages.length === 2`。
- **事实护栏写在 system prompt**（§一「不硬编」）：只能引用资料；资料里没有就直说「资料里没有，建议补充」；
  不编造；内容一律人工确认后手动发布。**资料缺口（`businessCompleteness.missing`）也入 prompt**，
  这样「生成前主动追问缺口」不靠模型自觉。
- **扩词候选不写库**：`suggestWatchlist` 只产出候选（含 `existing` 标记），勾选后走 04 的 `addWatch`
  （上限 10 / 去重 / CONFLICT 语义全部复用，不在 08 里另造一套规则）；模型脏输出（围栏/夹解释/重复/非法 type/超长）
  在本地清洗，**解析不出数组就抛 `VALIDATION_ERROR` + `reason='candidates-unparsable'`**——
  静默给空列表会把「模型抽风」伪装成「真没什么可关注」。
- **停止生成是真断上游**：`abort(streamId)` 使上游 socket 断开（07 已验），因此「不再白烧 token」有据；
  **四路都中止**：用户点停止、切换商家（面板 watch）、组件卸载（`onBeforeUnmount`）、应用退出
  （`before-quit` → `abortAllAdvisorStreams()`）。
- **流订阅按 streamId 归并**：`onChunk/onDone/onError` 是全局订阅（事件名由 07 定死），store 只订一次并按当前
  streamId 过滤，多面板/多流不会串台；`disposeAdvisor()` 在卸载时注销。
- **错误按 code 分支**（§五）：`OPENCLAW_NOT_READY` / `SETUP_REQUIRED` 时面板给「去启动 OpenClaw」按钮，
  它调 07 的 `marketing:gateway:ensureReady`（探活→按需拉起→就绪轮询）——这也是 07 只读面在 UI 上的第一个真实用途。
- **界面边界**：面板只做展示与交互；Context Pack 组装、护栏、模型调用全在主进程（硬规则 13），
  渲染端拿不到 token、也拿不到资料正文（只拿 `summarizePack` 的数量/模式/预算摘要）。

⏳ **未覆盖 / 已知风险**：①**真界面点击流未做**（本机无桌面通道）——打包态端到端（真产物 + CDP 驱真面板）留待补；
②模型是否真遵守事实护栏只能人工试用 + 后续 Learning 反馈，自动化只验到「护栏与缺口确实进了 prompt」；
③扩词候选的 `reason` 仅透传展示，未参与排序或去重权重。
②「客户端 abort 后**服务端是否停止生成**」只验到「上游连接真断」（假服务端），真 Gateway + 真模型调用未验（§九 #14）；
③G21 真机探活实测本机 3213 有 Gateway 在跑（探活 200），但**兼容面 enabled=false**——真机上 `chatCompletions` 仍是关的
  （老配置迁移要等应用真正跑一次 `_syncOpenClawConfig`，它不在本验收的临时目录里）。

### Commit 09 落点与验收（✅ 2026-09-18）

```text
electron/main/marketing/contentManager.ts   新增：ContentManager（CRUD + listVersions/saveVersion + generate 三路并行 + cancelGeneration/cancelByProject/cancelAll）+ wrapHandleSaveVersion（先落库后 done）+ buildGenerationMessages/buildPromptSnapshot（纯函数，验收直接断言）
electron/main/ipc/content.ts                新增：marketing:content:{list,get,create,update,delete,generate,generate:abort,saveVersion,versions}（§五 扩面 3 条：delete/abort/versions）+ abortAllContentGenerations
electron/main/ipc/index.ts                  + 转出 content 面
electron/preload/index.ts                   + api.marketing.content.{list,get,create,update,delete,generate,abortGenerate,saveVersion,versions}
electron/main/index.ts                      + 工厂/单例/wiring（注入 06 引擎 + 07 客户端 + DatabaseClient）+ before-quit abortAllContentGenerations（四路之退出路）
src/stores/marketing.ts                     + content 切片（列表/CRUD/版本/生成三槽位按 streamId 归并订阅/代际守卫/停止/清空/dispose）+ CONTENT_STATUSES/CONTENT_STATUS_LABELS 导出
src/composables/useContentPrefill.ts        新增：热点雷达 payload 接收端（模块级单例 set/consume 一次性；不走 router query——payload 含中文长文本；11 的按钮上线前路径先行）
src/views/marketing/ContentCenter.vue       新增：生成表单（平台/选题/补充）+ 三路流式面板（采用为正文）+ 内容列表（状态/平台过滤）+ 编辑弹窗（状态机人工推进 + 价格核对警告 + 版本历史 + 「当时提示词」）
src/renderer/main.ts                        /marketing/content 由占位页换真页
test/content.accept.mjs + `npm run accept:content`   12 项验收（C1-C12；打真 contentManager.ts + 真 Node SSE 服务端 + 真 DB Worker 直读行数）
```

**验收（独立复跑，非自述）**：`accept:content` **12/12**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、worker 半边 **18/18**、`accept:project` **18/18**、`accept:business` **16/16**、
`accept:knowledge` **23/23**、`accept:context` **22/22**、`accept:gateway` **27/27**、`accept:advisor` **10/10**、
`accept:scan` **18/18** 均不受影响（结果 JSON 均为同日复跑回写）。

**关键设计决策**

- **一次 3 版 = 3 条独立流式请求**（§一 产品智能 / v1.12）：三个固定角度（直给卖点/场景故事/异议处理）写死在
  `CONTENT_GENERATION_ANGLES`，各起一条请求、各自成版本——不搞「一次请求要三段」的脆弱拆分
  （模型分节不可靠、截断互相拖累）；temperature 0.8（创作允许发挥），事实护栏在 system 兜底（08 同源、面向成稿）。
- **先落库后 done**：每条流包一层 `wrapHandleSaveVersion`，`result` resolve **前**完成版本落行
  （source=ai 必带 prompt 快照 = Context Pack 全文 + 本版角度，§四 v1.10）——渲染端收到 done 立即刷新版本必读得到；
  **中止/失败/空产出（含剥围栏后为空，`FILE_PARSE_ERROR` + `reason='empty-generation'`）不落版本**：
  半截稿子不是「供选版本」。
- **并发版本号防重**：三路并行完成会同读同一 maxVersion（表上无 UNIQUE(content_id,version) 拦不住）；
  per-contentId promise 链把「读最大号→写新行」锁成互斥段（C3 断言版本号恰为 {1,2,3}）。
- **会话键 `content-<genTaskId>-a<i>`**：三路并行不共用商家 sticky（同 user 并发写会话历史会互相穿插，05b 同课），
  也不进 Advisor 记忆；每轮只发 system + user（同 08 口径 A）。
- **不自动发布（硬规则 10）**：状态机 draft/review/approved/published/archived 全人工推进、无自动跳转；
  `status→published` 自动补 `published_at`（v1.13 复用状态列不设布尔列，唯一真相来源），空正文拒发布
  （`reason='publish-without-content'`）；退回 draft 保留最近发布时刻；UI 明示「复制发布由老板自己完成」。
- **四路中止**：停止生成（`cancelGeneration(genTaskId)`）、切商家/渲染端 await 期间失联
  （`cancelGenerationByProject(projectId)`，两路定位同 05b）、组件卸载（dispose + clearGenerate）、
  应用退出（`before-quit` → `abortAllContentGenerations()`）；全部幂等不双计（C12）。
- **热点溯源**：`sourceTopicId` 落库前显式验行存在（FK 天书翻成 `VALIDATION_ERROR` +
  `reason='source-topic-not-found'`，C9）；update 白名单不含 `source_topic_id`（身份与溯源不可改）。
- **db-worker 零改动**：本提交只消费既有 generic CRUD 白名单（contents/content_versions 02 已建，11 表不变），
  业务判断全在 manager（硬规则 8/12 精神，C10 静态断言白名单未扩）。

⏳ **未覆盖 / 已知风险**：①真界面点击流未做（本机无桌面通道，同 08）；②平台规则模板注入归 Commit 10
（本提交只把 `platform` 交给引擎与指令文本）；③热点 payload 真值路径要等 11 上线（当前仅测试与带 payload 跳转触达）；
④生成质量（三角度是否真有区分度、护栏是否被遵守）只能人工试用 + 三期 Learning 反馈，自动化只验到「护栏/资料/角度确实进了 prompt」。

过程留痕：C4 首轮把 contents 行数基线取在 `generate` 之后，而 generate 开头就落草稿（三路共写载体），
期望 +3 实际 +2 假红——计数基线已改为 generate 之前取（注释在用例内，防止复犯）。

### Commit 10 落点与验收（✅ 2026-09-19）

```text
electron/main/marketing/platformRules.ts   新增：双平台规则纯数据模块（PLATFORM_LABELS + 小红书/抖音两套模板 + getPlatformRule/getPlatformScope/renderPlatformRuleSection；非法平台 VALIDATION_ERROR；不 import electron、不发 HTTP、不落库）
electron/main/marketing/contextEngine.ts    + ContextPack.platformRule 附加字段（platform=null 则 null；§六 CONTEXT_PACK_KEYS 六键不变）；模板**不进 renderContextPackText**（不占 60% 预算，属预留 40%）
electron/main/marketing/contentManager.ts   + buildGenerationMessages 每路 user 末尾注入「发布平台规则」区块；buildPromptSnapshot 同步（版本「当时提示词」复盘得到平台口径）；护栏第 3 条改指平台规则结构
electron/main/marketing/advisorManager.ts   + buildSystemPrompt 带平台时追加同一规则区块（保留原「本次面向的发布平台：id」行，A2 口径不变）
src/views/marketing/ContentCenter.vue       + 平台 tabs 下工作流提示（小红书=图文笔记三件套不产图；抖音=口播三件套、写死不做视频；均自行人工复制发布）
package.json                                + accept:platform 脚本
test/platform.accept.mjs + `npm run accept:platform`   7 项验收（P1-P7；打真 platformRules/contextEngine/contentManager/advisorManager + 真 DB Worker + 真 Node SSE 假 Gateway）
```

**验收（独立复跑，非自述）**：`accept:platform` **7/7**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:content` **12/12**、`accept:context` **22/22**、`accept:advisor` **10/10**、
`accept:db` **31/31**、`accept:project` **18/18**、`accept:business` **16/16**、
`accept:knowledge` **23/23**、`accept:gateway` **27/27**、`accept:scan` **18/18** 均不受影响
（结果 JSON 均为同日复跑回写）。

**关键设计决策**

- **规则是主进程内部数据，不上 IPC**：与 Context Pack 同边界（§五 v1.20），preload 无新面、
  content/advisor IPC 零改动、**db-worker 白名单零扩展、11 张表不变**（P7 三处静态断言）；
  渲染端只有一行写死的工作流提示文案，不引主进程模块。
- **模板不进 60% 预算**：§六 预留 40% 本就包含「平台规则」；`renderContextPackText` 不含模板，
  预算探针账本因此与 06 完全一致——P3 用 2 万字假模板断言渲染 token 分毫不变，规则再长也挤不掉商家资料。
- **互不串味**：小红书模板只讲图文笔记（标题/正文/话题），抖音模板只讲口播三件套（口播脚本/标题/话题，
  写死「不做视频」）；P2（纯函数 × 三角度 × 两平台）与 P5/P6（端到端请求体与落库快照）双向断言
  「我有他无」，防止以后改模板时互相污染。
- **快照同源**：`buildPromptSnapshot` 在 Pack 之后拼同一规则区块——版本「当时提示词」能复盘
  当时的平台口径（§四 v1.10 prompt 快照职责的延伸，C3 旧断言「快照带平台」依旧绿）。
- **抖音边界双处写死**：模板正文 + UI 提示都明示「一期只做文案层、不做视频」「人工复制发布」，
  不留给生成端自由发挥；两平台都不自动发布（硬规则 10，09 状态机不变）。
- **三角度机制不动**：仍是直给/场景/异议各一条独立流式请求（09 口径①），规则区块每路必带；
  temperature、会话键 `content-<genTaskId>-a<i>`、四路中止全部维持。

⏳ **未覆盖 / 已知风险**：①真界面点击流未做（本机无桌面通道，同 08/09）；②模板文案的实际出稿质量
（字数/结构/合规遵守度）只能人工试用标定，后续调优只改 `platformRules.ts` 一处、P1 关键词随之更新；
③Advisor 面板不传平台时不带规则（设计如此，顾问问答不挑平台）；④`package-lock.json` 本次被 npm
顺带对齐（committed lock 停在 1.0.0、缺 05a/05b 引入的 exceljs/mammoth/pdfjs-dist；现对齐 1.1.0 并补齐三项），
非本提交的依赖决策，提交时可单列或并入，不影响运行时。

### Commit 11 落点与验收（✅ 2026-09-19）

```text
spikes/011-hot-sources/                   SPIKE 证据：spike-hot.mjs 可复跑 + spike-result.json（各源可达性/字段/条数）
resources/collector/index.mjs             新增：短命子进程入口（参数/环境双通道；--sources/--base/--routes/
                                          --toutiao-url/--bili-url/--calendar-path/--now/--timeout-ms；
                                          成功描述符显式 ok:true，dailyhot 无 base 只 stderr SKIP）
resources/collector/sources/util.mjs      fetchJson（8s 超时、非 2xx/非 JSON 抛错）、toHeat（万/亿文案兜底）、makeItem/finalizeItems
resources/collector/sources/toutiao.mjs   头条 hot-board 直连（平台键 toutiao，默认源）
resources/collector/sources/bilibili.mjs  B站 popular 直连（平台键 bilibili，默认源）
resources/collector/sources/dailyhot.mjs  DailyHotApi 协议（平台键=路由名；DEFAULT_ROUTES 收敛为 5 个长尾）
resources/collector/sources/calendar.mjs + calendar.json（22 节点，leadDays 提前量窗口，UTC 解析防跨日）
electron/main/marketing/hotManager.ts     新增：spawn collector + JSONL 解析 + 时间差/single-flight/超时 kill；
                                          同源指纹去重 + 批内包含合并 + upsert + samples 追加/裁剪(24)；
                                          生命周期 new/rising/breaking/peak/long_tail；7 天清理（contents 引用例外）；
                                          listRadar 近 24h board/calendar + project×平台评分 LEFT 关联；
                                          不 import electron、不发 HTTP、不直写 SQL（依赖全部注入）
electron/main/ipc/hot.ts                  新增：marketing:hot:list/get/refresh 三通道 + abortHotCollectors（score 归 12）
electron/main/database/errors.ts          + HOT_SOURCE_ERROR
electron/main/index.ts                    wiring：dev/安装包双路径解析 collector（extraResources 零改）、便携 Node、
                                          config.hot.dailyhotBaseUrl 按次读、60s tick、powerMonitor resume、before-quit abort
electron/preload/index.ts                 + marketing.hot 面（list/get/refresh，无 score）
src/stores/marketing.ts                   + hot 切片（hotRadar/hotLoading/hotRefreshing/hotError + load/refresh/clear）+ HOT_SOURCE_ERROR 文案
src/views/marketing/HotCenter.vue         新增真页：状态条三态 / 发布视角 / 源筛选 / Top20（可展开）/ 生命周期徽章 /
                                          日历分区 / 一键带去 Content Center（六字段 payload）/ 小红书降级口径明示
src/renderer/main.ts                     /marketing/hot 由 Placeholder 换 HotCenter
test/hot.accept.mjs + package.json        16 项验收（H1-H16；H13-H16 为提交前第三方复审补的回归）+ accept:hot
```

**验收（独立复跑，非自述）**：`accept:hot` **16/16**（H1-H12 + 复审 H13-H16）；`typecheck:node` / `typecheck:web` 0 错；`npm run build` 通过
（renderer 产出 HotCenter chunk；collector 随 `resources/` 整目录 extraResources，打包配置零改动）；回归
`accept:db` **31/31**、`accept:project` **18/18**、`accept:business` **16/16**、`accept:knowledge` **23/23**、
`accept:context` **22/22**、`accept:gateway` **27/27**、`accept:advisor` **10/10**、`accept:scan` **18/18**、
`accept:platform` **7/7**、`accept:content` **12/12**（C10 热点路由护栏由「仍指 Placeholder」更新为「已换 HotCenter」）。
真外网冒烟（便携 Node 直跑真 adapter）：头条 50 条、B站 20 条、日历 3 节点。

**关键设计决策**

- **方案 A：直连为主 + 聚合协议保留**：SPIKE 证明公共聚合实例在当前网络环境全灭，而头条/B站自家公开 JSON
  免登录稳定可取；直连 adapter 成为默认源，DailyHotApi 降级为「配了 base 才启用」的可选线（覆盖抖音/微博/知乎/百度/快手长尾）。
  红线不变：只用公开端点、不带 Cookie、不绕风控、任何鉴权要求按该源失败处理。
- **成功/失败/跳过三态**：成功描述符必须显式 `ok:true`（本轮真 bug：adapter 返回值漏字段导致 manager 全误判失败）；
  未配 base 的 dailyhot **不产生失败描述符**，状态条显示「已跳过」并给自部署提示；全源失败才抛 HOT_SOURCE_ERROR，
  且**不推进 `hot_last_fetch_at`**（下个 tick/打开页立即重试），部分失败只写错误串、榜单照常。
- **并发安全**：single-flight 不仅入口同步判一次，`isDue()` await 回来后必须**复查 inFlight**
  （本轮真 bug：定时 tick 与打开雷达相撞时两个 collector 并发起跑，H7 负向断言锁定）。
- **同源去重不跨源**：指纹 = source_platform + 标题归一化（剥前缀词/标点、压空白、只留字母数字 CJK）；
  批内短串被长串包含（归一化后 ≥6 字）合并为信息更全的一条，热度/名次取更显著者；跨平台同事件各保一行。
  日历用稳定 `cal:<id>` 指纹，不参与生命周期判定。
- **生命周期只看采样序列**：new（首采样）→ breaking（热度翻倍且冲进前 10）/ rising（涨 15%）/ long_tail（跌 15%）/ peak（其余），
  heat 缺失保持原状不瞎判；判定依据取最近两次 sample，与当前库行状态解耦。
- **落榜清理的引用例外（v1.11）**：清理在 JS 侧取 contents.source_topic_id 集合做豁免（worker 只支持等值/IS NULL，α 内容量小），
  被引用热点连同样本保留；未引用者随 FK CASCADE 清 samples/评分（H11 级联断言）。
- **采集独立于 Gateway 且不写库**：collector 零 npm 依赖、只 stdout JSONL（进度走 stderr）；落库全部经 DB Worker generic CRUD，
  worker 白名单零扩展（02 建的三表 + app_meta 三键），manager bundle 后纯 Node 可验收（H12 静态断言）。
- **11 不开评分**：`project_hot_topics` 只做 LEFT 关联（11 恒 null），`marketing:hot:score` 通道不存在；
  发布视角（小红书/抖音）当前只影响跳转预填，为 12 的 project×平台评分留好接缝。

**提交前第三方复审修复（8 角度，11 项；H13-H16 + H12 静态锁定）**

- **A1 间歇丢尾部 JSON**：collector 子进程由 `child.on('exit')` 改 `'close'`——exit 时 stdio 可能未 flush，
  会随机丢最后一行数据源（表现为「未返回任何数据源」）。
- **A2 dailyhot 失败归因错位**：失败兜底曾退回 job 名 `dailyhot:<route>`，成功时 source 是 `dailyhot:<host>`；
  现由 main 按实际 base 预给 fallback，成败严格同 source/平台键（H13）。
- **A3 缺测不砸行值**：某轮 heat/rank/url 字段缺失时**行上**沿用最近已知值（保展示与排序）；
  但**采样序列如实写 null**（旧实现连采样也沿用旧值=伪造趋势点，第二轮复查 1 修正）（H14）。
- **A4 日历本地时区**：节点日期由 UTC 构造改为**本地零点**——东八区节点当天 00:00-08:00 打开时，
  UTC 还是前一天，窗口错一位（H13 本地零点边界断言）。
- **C1/C2/A5 消灭 5000 截断假设**：`listAllRows` 分页助手（5000/页、100 页保险丝）用于存量指纹、
  contents 引用集、雷达与评分读取；另加 UNIQUE 冲突→按指纹回退更新的防线。后果分别是：
  C1 单平台超 5000 行后采集**永久卡死**（CONFLICT + 不推进 last_fetch + 无可见错误）；
  C2 击穿 v1.11「被引用热点不删」、静默 SET NULL 三期溯源；A5 雷达漏行（H15 直连 SQLite 造 5001 行夹具；H16 造 5001 条 contents）。
- **C3 过期节点次日下榜**：日历源本轮未见的节点主动把 last_seen_at 打到清理阈值前，同轮清理收敛
  （被 contents 引用的仍享 v1.11 豁免），不再以「提前备稿窗口内」标题滞留最长 24h（H16）。
- **C4/C5/⑥ 失败可观测 + 死代码**：「立即刷新」改走 `refreshHot()`（全源失败会显式 reject）再重载榜单，
  store hotError 与首轮失败红条接通；「聚合源未配置」提示加 lastStatus 守卫，首轮整体失败不再误报跳过。
- **C6 竞态令牌（12 的定时雷）**：store 加 `hotCallSeq`，切商家后迟到响应不覆盖当前视图——
  11 评分恒 null 无症状，12 上线即会「B 店页显示 A 店相关度」。
- **③ openUrl 协议白名单**：外部榜单 url 只放行 http(s)，防 javascript:/file: 经系统浏览器打开。
- **⑧ 定时器清理**：hot tick 定时器在 before-quit 显式 clearInterval，退出清理途中不再起新 collector。

**第二轮用户复查修复（8 项；H14 改写 + H12 静态锁定，accept:hot 仍 16/16）**

- **复查 1（功能性，最毒）缺测假采样**：persistSource 缺测轮原用旧值补采样点（heatNow===heatPrev），
  上升热点被误判 peak，且 classifyLifecycle 的 heatNow===null 保阶段分支永不触发（死代码）。
  改为采样如实写 heat:null（行 heat/rank 仍沿用旧值，A3 展示口径不变）；recomputeLifecycle 缺测轮零查询
  直接保阶段，非缺测轮只取末 3 条并向前找最近非空 heatPrev——一次缺测不会冻住后续趋势（H14 改写）。
- **复查 2 状态条 chip 重复 key**：dailyhot 多路由成败描述符 source 同为 dailyhot:<host>，v-for key 重复、
  ✓/✗ 可能与平台错位；key 改 sourcePlatform + '|' + source（H12 锁定）。
- **复查 3 全源失败时「立即刷新」双采集**：失败不推进 last_fetch，刷新后 reload 又起第二轮完整采集，
  按钮卡 ~90s 且双倍连打上游。listRadar 新增 skipCollect（只读库不采集），贯通 ipc/preload/store，
  forceRefresh 在 refreshHot 之后以 skipCollect 读库（H12 四处静态锁定）。
- **复查 4 mounted 无容错**：marketing.load() 抛错会中断整个挂载回调、reload 不执行、页面空白无提示；
  现包 try/catch + loadError 红条，雷达加载仍照常尝试（H12 锁定）。
- **复查 5/6 采样查询量级**：recomputeLifecycle 原每热点每轮两次全量拉采样表（各最多 5000 行，
  70 热点 × 每小时 ≈ 140 次冗余查询），改 count + 只取末 3 条；pruneSamples 改 count + 只拉溢出旧行；
  cleanupExpired 读 contents 含正文字段（worker 不支持列裁剪）补量级假设注释，截断风险已随 C2 分页消除。
- **复查 7 run-shared.bat 私有路径**：用户本机改动，按本人指示不还原、提交时排除。
- **复查 8 验收产物 churn**：accept-result-*.json / probe-scan-render.json 时间戳重写，
  按仓库先例一直随提交入库，本次照旧（必要时可分开提交）。

⏳ **未覆盖 / 已知风险**：①真 Electron GUI 点击流未做（本机无桌面自动化通道，同 08/09/10）；②打包态未跑 win-unpacked CDP
冒烟（随包事实由 H12 extraResources/双路径静态断言覆盖，留一期整体测试）；③热点排序依赖各平台自报热度数值，
跨平台数值口径不可直接比较（头条数万级 vs B站播放量），11 仅按数值降序展示，「哪个平台最火」的严格对比留二期 cluster；
④抖音/微博等长尾的实际可取性取决于自部署实例质量，默认状态下雷达只有头条/B站/日历三线，这是合规红线下的有意取舍。

### Commit 12 落点与验收（✅ 2026-09-20）

```text
electron/main/marketing/hotShared.ts        新增：listAllRows 分页拉全 + compareHeatRank（采集/评分单一真相，复审 6/8）
electron/main/marketing/hotScoreManager.ts 新增：AI 懒评分（注入 DB+ContextEngine+Gateway；不 import electron、不发裸 HTTP）
                                           候选选取（近 7 天 board、日历不评、heat Top30）/ 24h TTL / force /
                                           一次 SSE 调用评一批（逐帧拼 JSON；护栏+资料+平台规则 prompt）/
                                           双层容错（单条丢弃、整败抛错信封）/ upsert project_hot_topics /
                                           纯函数 scoreTier/coerceScore/parseScoreItems/timingFor/pickTodaySuggestion
electron/main/marketing/hotManager.ts      listRadar 加 windowHours（24/72/168）；采集侧零改动，评分经 LEFT 关联自动可见
electron/main/ipc/hot.ts                   marketing:hot:score 通道（registerHotIpc 加 scoreManager 参数）
electron/preload/index.ts                  hot.score；hot.list options 加 windowHours
electron/main/index.ts                     createMarketingHotScoreManager wiring（02 DB + 06 引擎 + 07 网关注入）
src/stores/marketing.ts                    runHotScoring 续批循环 + 代际令牌 + 同 key single-flight；
                                           hotScoring/hotScoreError/hotSuggestion/hotScoreProgress；切平台清旧建议
src/views/marketing/HotCenter.vue          四档分组（🔥/👀/❌/⏳，双门槛）+ 今日建议卡 + 时间窗 tabs +
                                           「重新分析」+ 评分进度/失败黄条；分组阈值与后端静态锁定
test/hotscore.accept.mjs + accept:hotscore 14 项验收（真 hotScoreManager + 真 ContextEngine + 真 Worker + 假 Gateway）
```

**评分契约（v1.8/v1.9/v1.11/v1.12 落地口径）**

- **懒评分、不 fan-out**：只对当前 project × 当前发布平台评；热点全局共享、评分按 project×平台缓存；
  候选窗固定近 7 天在榜 board 热点，与展示窗（24h/3d/7d 可切）相互独立；日历节点是确定要跟的备稿节点，不评。
- **每批 ≤30、续批评完**：待评超 30 按 heat（再 rank）取前 30；store 打开雷达自动续批，remaining=0 停；
  24h TTL 内打开只走 DB（零模型调用），仍返回最新「今日建议」；手动「重新分析」force 无视 TTL（首批 30 + 续批）。
- **一次调用一批（SSE 传输，自测修正）**：走 `createChatStream` 逐帧拼完整 JSON（temperature 0.2）
  ——真网实测 30 条详细中文评分 90-225s，非流式 120s 整体超时会整批挂；流式只有 chunk 空闲超时。
  会话键每批一个 `hot-score-<platform>-<uuid>`（不进 Advisor sticky 历史、不互相排队）；写死文本模型。
- **批间韧性**：批间退让 1.5s；单批失败退让 3s 补试一次、再败显黄条终止；成功批次 TTL 内不重评，
  天然断点续评（见 v1.33 真网冒烟记录）。
- **双层容错**：坏条目（idx 越界/重复/分数非 0-100 整数/缺双分）只计 failed、留下批评，好条目照落；
  整次网关错误原样透传错误码（前端据此显示黄条、榜单照常用）、整包不可解析或全条目非法抛 VALIDATION_ERROR。
- **四档分组（展示层，数字全保留）**：🔥 match≥70 **且** fit≥70（双门槛，防高相关低适配误推）；
  👀 任一 40-69；❌ 双 <40；⏳ 未评分。阈值在前后端两处静态断言锁定（hotscore S10）。
- **今日建议**：24h 窗内 hot 档取 (match+fit) 最高、平分看 heat/rank；reason 用评分理由，
  timing 优先模型 lifecycle_advice、缺失按本地五档生命周期兜底；无合格推荐返回 null（宁缺毋滥）。
- **边界**：hotManager 仍不引用 GatewayClient（S10 静态断言）；project_hot_topics 仍是 02 封板的 9 列；
  worker 白名单零改（走既有 upsert/list/count）；零新 npm 依赖；评分不触发任何采集。

**验收（独立复跑，非自述）**：`accept:hotscore` **14/14**（S1-S11 + 第三轮复审新增 S12 force 水位/S13 漏回续批/S14 Pack 缓存；S11 打通评分→listRadar LEFT 关联/三时间窗/project×平台隔离/增量只评新条）；`accept:hot` 在 H12 改为「score 已随 12 开通」后仍 **16/16**；
`typecheck:node` / `typecheck:web` 0 错；回归 db/project/business/knowledge/context/gateway/advisor/scan/content/platform
十套全绿；`npm run build` 通过；**真网关冒烟通过**（real-smoke 脚本，真 73 条热点副本，30 条/批 JSON 解析 0 失败、护栏质量与四档分布合理，详见 v1.33 行；间歇空闲超时由四重防线覆盖，彻底消除率继续观察）。⏳ 真 Electron GUI 点击流同 08-11 留一期整体测试。

**第三轮复审修复（2026-09-20，第三方 10 条：1-4/6-10 全修，问题 5 run-shared.bat 本机路径用户拍板不动，提交时排除）**

- **① 重新分析只重评第一批 → force 水位**：force 调用在内存记 `pid|平台 → now` 水位，续批虽改回非 force，评分早于水位的旧分仍判 stale；配合 remaining 真实重算，35/600 条都能跨续批全部重评，又不会把 TTL 新鲜行无限重评（S12 锁定）。
- **② 续批捕获旧 windowHours → getter**：`runHotScoring` 改收 `getWindowHours()`，每批评完按当前 tab 重读榜单，多批评分期间切窗不再回退视图。
- **③ 非法条目提前终止续批 → remaining 落库后重算**：remaining 改为「落库后仍 stale 的候选数」，模型漏回/非法条目计入（S5 期望值由错误的 30 修正为 33；S13 锁定漏回 3 条时 remaining=8 且好条目不重复评分）。
- **④ guard 耗尽静默退出 → 可见提示**：20 批（>600 候选）耗尽后置 `hotScoreError` 黄条「已分析 N/总数，其余稍后重新打开雷达自动续评」，进度保留。
- **⑥/⑧ 分页与排序单一真相**：新建 `hotShared.ts`（`listAllRows` 5000 分页 + 100 页保险丝、`compareHeatRank`），hotManager 删私有拷贝与 cmpBoard；选批/今日建议平分兜底共用；HotCenter 的 cmpScore 平分兜底补齐 rank→last_seen 同口径（跨 tsconfig 不能共享代码，S10 静态锁定双份一致）。
- **⑦ 每批全表扫+重建 Pack → 60s TTL 缓存**：按 `pid|平台` 缓存热点表与 Context Pack（`project_hot_topics` 仍每批重读保证 stale 新鲜）；`cacheTtlMs:0` 可关，S14 锁定两批只构建 1 次 Pack、过期 force 重建。
- **⑨ 30 次串行写库 → `Promise.all` 一排并发**（client 按请求 id 多路复用，worker 单连接串行落库，upsert 幂等、主键互不相同）。
- **⑩ 展开态跨视角串用 → 切发布平台/切商家重置 `expandedGroups` 与 `sourceFilter`**。

### Commit 06 落点与验收（✅ 2026-09-16）

```text
electron/main/marketing/contextEngine.ts   新增：ContextEngine（buildContextPack）+ renderContextPackText
                                           + 本地 token 估算（estimateTokens / sliceToTokenBudget）
                                           + summarizeBusiness / computeBusinessCompleteness（复用 04 的六项常量）
electron/main/index.ts                     工厂 + wiring（createMarketingContextEngine + getMarketingContextEngine 取用点）
test/context.accept.mjs + `npm run accept:context`   22 项验收（打真 contextEngine.ts + 真四 Manager + 真 DB Worker）
```

**验收（独立复跑，非自述）**：`accept:context` **22/22**；`typecheck:node` / `typecheck:web` 0 错；
回归 `accept:db` **31/31**、`accept:project` **18/18**、`accept:business` **16/16**、`accept:knowledge` **23/23** 均不受影响。

**关键设计决策**

- **账本 = 实际渲染文本**：预算判定不是「固定开销 + 逐条估算」硬凑，而是每个候选组合都真渲染一次
  `renderContextPackText` 再估算（`probePack` / `measure`），末尾还有一道保险丝循环从尾部让位。
  理由：首版按逐条估算写，C9/C10 立刻抓到「账面 2400 刚好、渲染后 2454 超了」——
  区块头、条数行、「未注入清单」**本身都占预算**，靠估算猜必然在边界上错。
- **超预算条目不静默丢**：未入选的 ready 条目全部落 `dropped[]`（`reason='budget'`），
  渲染文本里也有「【本次未注入的资料】」一段（最多 3 个标题 + 「等 N 条」——这段文字本身占预算，
  所以显示有界，避开「被裁的越多、剩余空间越少」的自我强化）；空内容条目 `reason='empty-content'`。
- **不裁剪 business**：预算只作用于 knowledge。business 自身超预算时记日志并让 knowledge 空载
  （`budget.businessOverBudget=true`），而不是把商家资料砍一半 —— business 是「AI 认识你」的核心（§一）。
- **本地 token 估算口径**（§六：Gateway 的 `usage` 恒 0）：中日韩/全角 1 token/字、ASCII 1/4 字符、
  换行 1、其余 1.5，向上取整。**保守侧是刻意选的**（高估只少塞资料，低估会真超窗）；
  窗口由调用方传（`contextWindowTokens`），默认 128k——因为 §六 实测 `model` 取值是 `openclaw` / `openclaw/<agentId>`，
  **映射不到 provider 模型 id**，引擎不假装知道真实窗口。
- **只打包 `status='ready'`**；`enabled=0` 的关注词不进包；`businessCompleteness.missing` 直接供 08/09
  「生成前主动追问缺口」用；完整度常量**复用** `businessManager.BUSINESS_COMPLETENESS_FIELDS`（不留第二份真相）。
- **不新增 IPC 通道**：§五 的 `marketing.context` 是 current-project 切换（03 已交付），Context Pack 是主进程内部结构，
  消费方是 07/08/09。主进程留 `getMarketingContextEngine()` 作为唯一取用点，防止各处自建第二个引擎（账本/日志会分家）。
- **错误码透传**：引擎只经四个 Manager 读数据，`NOT_FOUND`（project 不存在）/ `SETUP_REQUIRED`（便携 Node 缺失）
  原样上抛，不被包装成 `DB_ERROR`（C15/C16 在 **bundle 后的模块** 上断言，防跨 bundle 身份假阴性）。

⏳ **未覆盖 / 已知风险**：①**打包态端到端未做** —— 本提交没有渲染端面，CDP 冒烟无从驱动（03/04/05a 的 e2e 靠 IPC 面）；
②token 估算器是启发式，与真实分词器有偏差（未引入 tiktoken 类依赖，见待办 #21）；
③`listLimited` 只在单次读入触到 worker 上限 5000 时标记，未做分页读全（α 阶段商家资料量远小于此）。

### Commit 11 数据源 SPIKE（v1.12 新增）

```text
[x] 榜单聚合源可用性（2026-09-19 实测，证据 spikes/011-hot-sources/，可复跑）：
    · 官方演示域名 api-hot.imsyy.top 已 NXDOMAIN；Vercel 镜像连接被墙；社区公共镜像全灭
    · 抖音匿名接口被风控（时好时坏，不作默认源）、知乎 401、微博 403；本机无 Docker、6688 无服务
    · 头条 hot-board 公开 JSON 直连稳定 50 条、B站 popular 公开 JSON 稳定 20 条：免登录/免 Cookie
      → 经用户拍板走方案 A：内置直连为默认源，DailyHotApi 聚合协议保留（base 可配、缺省跳过）
[x] 小红书源实测：无公开、稳定、免鉴权的热点出口（平台策略）→ 执行 v1.12 降级口径（综合榜 + 节点日历），
    HotCenter 在小红书视角下明示来源，不假装存在专属榜单；DailyHotApi 上游亦无小红书路由
[x] 节点日历 adapter：calendar.json 内置 22 个节点（2026/2027 农历按年写死），fid 走 cal:<id> 指纹，
    accept H2 落 origin=calendar 行（无热度、无生命周期）
[ ] 行业命中率：每天 50 条榜中，被摄影/女装行业评到 match≥70 的有 ≥3 条 —— 归 Commit 12（需 AI 评分后量化；
    11 无评分能力，若不足按预案补来源/调口径）
[x] 空态规则：无在榜热点时显示「今天没有值得跟的」+ 节点日历分区兜底（HotCenter）
[x] base URL 可配置：collector --base / HOT_DAILYHOT_BASE，主进程 config.hot.dailyhotBaseUrl 按次读（改配置无需重启）；
    公共实例恢复后填地址即插即用，默认路由收敛为 douyin/weibo/zhihu/baidu/kuaishou（直连已覆盖头条/B站）
```

### Commit 00 验收（✅ 2026-09-15 通过 → Primary）

```text
[x] chatCompletions 开启后 POST /v1/chat/completions 带 Bearer Token 成功，SSE 收到完整文本
[x] ② 就绪判定：/health 返回 200（97ms）可作为就绪判据；超时/重试参数留 07 定
[x] ③ SSE 中途断开 → 客户端正确结束并区分（4 chunks 后 abort 成功）
[x] ④ 坏 model / 坏 token → 结构化错误码（400 invalid_request_error / 401 unauthorized），非超时
[x] ⑤ 两个不同 user= 交叉对话 → OpenClaw Memory 不串（no leak）
[x] ⑥ 同一 user= 新连接 → 【结论 A】可回放历史 → 不建 project_messages、不需回灌
[x] Gateway HTTP 只绑定 127.0.0.1（非 0.0.0.0）
[—] ① Gateway 未启动 → 自动拉起：本次未覆盖（dev 实例已启动）；由 Commit 07 复用 clawManager 实现时验收
[—] ⑦ 多模态：按产品决定未测（模型必支持多模态）；端点 image 通道留 07 验证
[—] CLI / 直连对比：主路线已判定 Primary，未单独测（直连保留 Fallback）
```

### Commit 02 验收（✅ 2026-09-15 通过，2026-09-16 复审补 C13 后 **31/31**；`npm run accept:db` 一键重跑）

```text
[x] 惰性初始化：首次 marketing IPC 才拉 Worker 建库 —— C2 dbExists=false / C3 tables=11 + uv=1 + wal；应用启动不建库、不阻塞
[x] 10 张业务表 + app_meta 齐备、user_version=1、**无 project_messages** —— C3 / W4 schema.info
[x] Worker 单例：连续 20 次 IPC 只存在一个 node 子进程 —— C4（OS 层进程计数=1）
[x] foreign_keys=ON 级联删除 + businesses UNIQUE(project_id) —— W7（级联清空，hot_topics 不受影响）/ W8 CONFLICT
[x] migration 0→1 实测并幂等；WAL 生效；强杀后库不损坏 —— W2/W3/W6/W14（integrity_check=ok）
[x] Worker 被强杀后自动重启：读自动重试成功、写不自动重试 —— C5；例外（预生成主键 upsert）可重试 —— C6
[x] shutdown 优雅退出（checkpoint→close→exit 0）；注册表先于 taskkill —— W16（wal=0B）/ W17 / W18 + C12 全链路
[x] 🔥 安装包冒烟：**打包态端到端**（win-unpacked 真应用 + CDP 驱动真渲染进程调真 IPC）——
    建库 11 表 / uv=1 / WAL / FK=on → 写样例数据 → 优雅退出（-wal/-shm 消失）→ **重启数据仍在**（migrated=false）
    —— 复现脚本 `test/packaged-smoke.mjs`
[x] VACUUM INTO 备份链路可用、保留最近 5 份 —— W13 / C9
[x] data/openclaw、data/runtime 零影响；既有安装实例全程不受影响 —— 仓库 data/ 无改动

[x] 初始化失败回收 Worker：不留游离进程、可安全重试 —— C13（v1.16 复审 P2 修复的回归用例；负向验证：还原旧代码时 C13 判红）

⏳ 未覆盖（北已拍板不单独补，v1.15）：
[—] 真 NSIS 安装 + GUI 点击流：跑的是等价 win-unpacked 产物；03 完成后一次性人工过
[—] _stopRuntimeProcesses 端到端触发（只在 env:updateNode 流程走到）：契约由 C12 + diff 覆盖
```

### Commit 05（Knowledge）边界（v1.6 修订）

**总原则：导入时本地确定性解析一次 → 文本存 `knowledge_items.content`，原文件留 `data/projects/<id>/` 存 `source_path`；运行时不再解析，重新导入覆盖。schema 不加表，只放开 type 枚举。**

**多模态不进默认解析管线**：模型视觉只作显式触发的兜底，不做默认解析器。理由：① docx/xlsx/文字层 PDF 本地抽取确定、免费、忠实；② 模型有上下文上限，长文档照样要分页切块；③ 表格（价目表）可能串行/错读——**涉及价格的内容必须确定性抽取，不得走模型识别**；④ 解析不应依赖 Gateway 在跑或模型支持图。

分两步交付（**Commit 05 只交付 05a；05b 在 Commit 07 之后作为独立提交，编号 05b**）：

- **05a（约 2.5d）文字层文档全收**，新增依赖：`mammoth`（docx→文本）、`exceljs`（xlsx 按 sheet → Markdown 表）、`pdfjs-dist`（PDF 文字层，纯 JS 主进程运行，worker 打包路径进安装包冒烟）：
  - 支持 `text / markdown / url / faq / docx / xlsx / pdf`（doc/xls 老格式 v1 不支持，提示另存为新格式）；
  - url 类只做正文/HTML 到文本的轻量抽取；
  - PDF 抽取后做**扫描件检测**（抽样页面文字量≈0）→ **不落任何库行**：失败以错误信封回渲染端（`FILE_PARSE_ERROR` + `reason='scanned-pdf'`，K9 锁定「0 空内容行、0 孤儿文件」），UI 在报错处亮 05b 的「用 AI 识别」入口；不得静默存入空内容。（v1.28 校正：原句「条目标 FILE_PARSE_ERROR 待 05b」暗示库里有失败行，与 05a 实现不符）
- **05b（约 1.5d）扫描件/图片 AI 识别兜底**：
  - 仅扫描 PDF 与**带文字的资料图**（价目表截图、海报、产品说明图等）；客片/商品图等营销素材归二期 Assets，不在本功能范围。UI 提供「用 AI 识别」按钮，**用户显式触发**（Human-in-the-loop），识别文本入库前必须人工确认；
  - 大文件分页/切块发送、大小上限、失败重试；可行性以 Commit 00 验收⑦结论为准——不支持图则降级为明确提示，不阻塞 05a；
  - 解析失败统一以 `FILE_PARSE_ERROR` 信封回传，**不落库行**；「可重导入」= 对同一文件再走一次导入（v1.28 校正：原句「条目标红可重导入」暗示库里有失败行可标红，与实现不符）。✅ 05b 已按此实现（见「Commit 05b 落点与验收」）。

05a 验收补充：docx 套系单、xlsx 价目表、文字层 PDF 各一份真实样本导入后 LIKE 可检索且数字/表格无串行；安装包环境（非 dev）pdfjs 可用。

第二阶段：Assets / Calendar / Strategy+Topics（策略→选题→素材→内容→日历→人工发布）。
第三阶段：Analytics + Learning（数据反馈 → 风格学习 → 生成闭环）。

### 2.1 阶段预留（v1.12 新增）

**定位**：在热点雷达之上补「行业层」与「同行层」（三层结构：全网热点 / 行业热点 / 同行观察）。**不进一期**，编号就叫 2.1（不用 11b，避免提交序列混乱）。

**2.1 要做的事**：
- 行业趋势：把榜单里的行业信号 + 关键词趋势，做成「我的行业在发生什么」；
- 同行市场观察：**关键词层面的市场信号，不是抓同行账号内容**；
- 雷达加「行业」Tab（一期不做空壳 Tab，首页不为未建功能留入口）。

**数据路径与可行性（红线写死）**：

| 路径 | 可行性 | 说明 |
| --- | --- | --- |
| 从综合榜里筛行业信号 | ✅ 现成 | 零新增成本，一期评分管线已在做 |
| 搜索联想词 suggest | 🟡 待 SPIKE | 通常公开，但可能有签名校验；验不通就放弃 |
| 百度指数 / 微信指数 | ❌ 不做 | 需要登录，撞硬规则 11 |
| 爬同行账号内容 | 🚫 红线 | 需登录态 / Cookie，工程量大、数据噪声高，不做 |

**成本控制（2.1 开工即生效）**：观察词**全局去重成一个词池**，一个词只采一次、多商家共享结果（与 `hot_topics` 全局共享同理），严禁 O(商家 × 词) 的 fan-out 采集。

---

### 2.1 头号任务：拍摄脚本生成（2026-09-20 标杆「卜一摄影工作室/服饰」拍板）

**背景（标杆事实）**：实体店位置偏、需线上获客，真痛点不是发布、不是矩阵，而是「**不知道拍什么、怎么拍、怎么发高质量引流内容**」。北裁定：**不做自动发布、不做矩阵号**（现有 2 主号 + 3 探店号暂不建模）。

**一句话定义**：输入「业务线 + 选题」→ 输出一份拿手机就能照拍的**分镜脚本**；人拍完、人挑号发。

**输入**
- `businessLine`：摄影 / 服饰（同一 Project 内双业务线，位置与客群共享，**不拆两个 Project**）；
- `topic`：手填，或从热点雷达「带去……」结构化 payload 带入（复用六字段：标题/来源/建议角度等）；
- `platform`：小红书 / 抖音（复用一期平台规则模板）。

**输出（结构化契约）**
```text
{
  title, cover,                         // 标题建议 + 封面拍法
  shots: [                              // 分镜清单（顺序即拍摄顺序）
    { index, shot, durationSec,         // 画面内容 + 时长
      voiceover, subtitle,              // 口播文案 + 字幕
      cameraTip }                       // 拍法提示（景别/运镜/光线）
  ],
  hashtags[], hook,                     // 话题标签 + 开头 3 秒钩子
  cta                                   // 结尾引导（到店/评论/私信），不含自动发布动作
}
```

**复用一期资产（不新起炉灶）**
- 走 Context Engine：Business + Knowledge + Watchlist + 平台规则打包；摄影/服饰差异通过 system 段的业务线说明注入；
- 走 Gateway Client / SSE / AbortController：规格同 Content（停止生成、组件卸载必中止）；
- 会话隔离沿用 `conv:<projectId>:`。

**明确不做（本期边界）**
- 不自动发布、不接账号/矩阵字段（contents 仍只到 platform 粒度）；
- 不先做素材库——**先有拍摄模板，拍回素材后再做 Assets**（素材库价值是告诉 AI「手里有什么」，空库无意义）；
- 不做视频成片（不做剪辑/合成），抖音一期同样只到文案/脚本层。

**数据模型改动（最小）**：脚本是生成物，一期可先作为 content 的一种形态或独立轻表（开工时定，倾向复用 contents + `content_type='shooting_script'`，避免新表）；`businessLine` 作为生成参数不一定要落 schema。

**顺序**：2.0 发布 → 拍摄脚本生成（给卜一实拍）→ 回收 2-3 批实拍反馈 → 再做素材库（Assets）。行业层/同行层（本节前段）排在其后。

## 八、Commit 01 精确落点（已核对代码，v1.4 修订）

- 路由实际入口 `src/renderer/main.ts`（hash 模式，10 条路由平铺）；**首启 Setup 守卫当前不存在，属新增**。
- 守卫设计：模块级缓存 `env.check()` 只调一次；未完成判定 = `nodeInstalled && openClawInstalled`（**不含 channelsInstalled**，其定义是 `downloadManager.ts:230` 的 `existsSync(weixinPluginPath)`，与可运行性无关）；目标已是 `/setup` 放行；env.check 异常放行；用 `router.replace`。
- **v1.4 新增验收**：「Setup 完成 → 进 dashboard 不被守卫弹回」。方案：Setup 完成回调里直接 `location.reload()`（hash 应用代价最低），不引入缓存重置机制。因此 01 对 Setup.vue 有一处最小改动（完成后的 reload），其余逻辑不动。
- `src/App.vue` navItems 平铺改分组：工作台 / 营销(**5**：商家大脑、知识库、AI Advisor、Content Center、热点中心) / OpenClaw(6，含 Obsidian + 环境初始化) / 系统(日志、关于)；**to 值不变，只动 label 与分组**。
- `src/views/Dashboard.vue` 改三卡：OpenClaw 状态卡整块保留 + 「当前商家」占位卡 + 「AI 营销」占位卡。
- 新增 `src/views/marketing/Placeholder.vue`，**5 条 marketing 路由共用**：`/marketing/business`（商家大脑）、`/marketing/knowledge`（知识库）、`/marketing/advisor`（AI Advisor）、`/marketing/content`（Content Center）、`/marketing/hot`（UI 名「🔥 热点雷达」，内部路由/表名/文件名一律维持 hot* 不变）；01 全占位，后续提交逐页替换。
- **零改动**：Config.vue、Skills.vue、ChannelsPage.vue、Logs.vue、TerminalPage.vue、About.vue、ObsidianPage.vue、stores/*、electron/**（Setup.vue 仅 reload 一处例外）。
- 验证：`tsc --noEmit`；`npm run dev` 三链手测（清空 data → 进 Setup 且完成后不弹回；已装 → 直达工作台；手动进 Setup 仍可）；10 条旧路由全通 + 5 条 marketing 占位路由可达。

### ✅ 实施结果（2026-09-15，v1.15 补记）

- 落点与计划一致：`src/App.vue`（4 组导航 + 待办 #2 改名）、`src/renderer/main.ts`（+5 路由 + 守卫接入）、`src/views/marketing/Placeholder.vue`（新增）、`src/views/Dashboard.vue`（+2 卡）、`src/views/Setup.vue`（reload + 放宽 channels）；**额外新增 `src/renderer/setupGuard.ts`**（守卫独立模块，`createSetupGuard({ check })`，便于无 GUI 自动化验收）。
- 守卫口径实测：`nodeInstalled && openClawInstalled`（不含 channels）✓、探测只调一次（缓存）✓、目标 `/setup` 放行不产生重定向环 ✓、探测异常放行 ✓、`replace` 重定向 ✓。
- 验收方式调整：**可执行测试替代 GUI 手测** —— `node test/commit01-guard.test.mjs`（esbuild 打真模块 + 真 vue-router，12/12 PASS）；GUI 三链手测未做（本机无桌面通道），但打包态冒烟时实测到守卫在真安装包里把首启拦到 `#/setup`。
- 类型检查：`tsc --noEmit`（根）0 错；`vue-tsc -p tsconfig.web.json` 仅 1 条**预存在**告警 `TerminalPage.vue:153`（本次未改该文件）。⚠️ 根 `tsc --noEmit` 为空转，见 v1.15 第①条。

## 九、待确认事项

| # | 事项 | 状态 |
|---|------|------|
| 1 | 「环境初始化」入口分组 | ✅ 已落地：随 01 进 OpenClaw 组 |
| 2 | label 改名（控制台→工作台、技能管理→能力中心、渠道接入→渠道） | ✅ 已落地（2026-09-17 核实）：`src/App.vue:105/122/123` 已是「工作台 / 能力中心 / 渠道」；剩 `Setup.vue` 的「前往控制台」按钮文案未同步（一行文案，见 #24） |
| 3 | 分支策略 | ✅ 已落地：当前 `release/2.0`，master / release/1.0 并存 |
| 4 | PLAN-2.0.md 入库 | ✅ 2026-09-15 随 Commit 01 提交入库（含 `spikes/`） |
| 5 | 放宽 Setup.vue 完成按钮的 channels 要求 | ✅ 已落地（2026-09-17 核实）：`Setup.vue:193-194` 的「环境已就绪 / 前往控制台」只要求 `nodeInstalled && openClawInstalled`，不含 channels；`channelsInstalled` 仅用于按钮文案（「重新安装环境 / 开始完整初始化」） |
| 6 | SQLite 选型 | ✅ v1.4 定稿：方案 B |
| 7 | DB 滚动快照 | ✅ v1.4 定稿：VACUUM INTO，保留 5 份，02 落地 |
| 8 | Commit 负责人 | ⬜ 多人协作时在第七节表中填名 |
| 9 | v1.8 第三方评审 12 项 | ✅ 2026-09-15 全部并入基线（见 v1.8 修订记录） |
| 10 | v1.9 第四轮评审 16 项 | ✅ 2026-09-15 全部并入，基线封版，进入 Commit 00；开工后新发现一律走新版本修订，不口头改基线 |
| 11 | v1.10 第五轮评审 9 项 | ✅ 2026-09-15 全部并入；#1-4、#6-7 为 user_version=1 建表前必须项（Commit 02 前有效），#5 立即生效，#8-9 已进 09/11/12 验收 |
| 12 | v1.12 产品智能 + 数据源定稿 | ✅ 2026-09-15 全部并入（见 v1.12 修订记录）；数据源三线与小红书降级口径由 Commit 11 SPIKE 实测确认 |
| 13 | v1.13 依赖/字段/上下文补齐 5 项 | ✅ 2026-09-15 全部并入：①AI 扩词 04→08（依赖倒置）②contents 补 `published_at`/`effect_note` ③Context Pack 加 `watchlist[]` ④`origin=watch` 标 2.1 预留 ⑤完整度卡片 Knowledge 维度随 05 接入 |
| 14 | 客户端 abort 后**服务端是否停止生成** | 🟡 半验（2026-09-16）：07 已证客户端 `cancel()` 会让上游连接真断（假服务端观测到 close、只发出 2/80 帧），因此**不会再继续收 token**；服务端是否随即停止模型生成需真 Gateway + 真调用才验得了 |
| 22 | Commit 07 开了 `marketing:gateway:{status,ensureReady}` 两条通道（§五 未列举） | ✅ 2026-09-17 已拍板（路径 A）：**接受并写进 §五** 的 `window.api.marketing` 契约（见本节 `gateway:` 一行）；理由：§五 错误码 `OPENCLAW_NOT_READY` 的前端处理就是「显示启动引导」，无只读面则该分支无路可走；两条通道均幂等、零 token、不泄 token |
| 23 | Commit 07 复审里**判定为可接受/不修**的 4 条 | 🟡 记录在案（2026-09-17）：①429 → `OPENCLAW_NOT_READY`（已带 `reason='rate-limited'`；加专用码需先改 §五）；②非流式响应体读取不在超时内（主路径 SSE）；③SSE 不拼多行 `data:`（OpenClaw 单行 JSON，无影响）；④`accept:gateway` 用例跳号 G15（仅观感）。若 08/09 真碰到 ①/② 再加码 |
| 16 | **根 `npm run typecheck` 空转**（tsconfig 为 `files:[] + references`，什么都没检查） | ✅ v1.15 已补 `typecheck:node` / `typecheck:web`（逐项目检查暴露 6 个被掩盖的真错并修复）；后续提交一律走逐项目检查 |
| 17 | Commit 03 三条未覆盖项（删行失败分支 / store 降级语义无单测 / UI 点击流） | ⬜ 见「Commit 03 落点与验收」；均已在代码层说明，未做执行证据 |
| 18 | Commit 04 三条未覆盖项（UI 点击流 / 完整度常量双份 / Watchlist 无批量导入） | ⬜ 见「Commit 04 落点与验收」 |
| 19 | Commit 05a 三条未覆盖项（K8 需真样本 / UI 点击流 / **lock 与 node_modules 漂移**） | ⬜ 见「Commit 05a 落点与验收」；漂移修复建议独立做 |
| 15 | 应用写 `meta.lastTouchedAt` / `lastTouchedVersion:'latest'` 被 schema 拒绝 | ✅ 已修（2026-09-16/17）：**两处都改了** —— `configManager._syncOpenClawConfig()`（删 `lastTouchedAt`；`lastTouchedVersion` 读真实安装版本，读不到则省略；G19 固定）与 `downloadManager._ensureOpenClawConfig()` 的安装期保底配置（**不写 `meta`**，留给 configManager 单点写；G28 真跑固定） |
| 20 | Commit 06 是否要给 Context Pack 加渲染端通道（「AI 看见什么」预览） | ✅ 2026-09-16 已拍板：**本期不加**（§五 只列 `marketing.context`=切换，Context Pack 消费方是主进程 07/08/09）；将来要预览页需先改 §五 再动 IPC |
| 21 | 本地 token 估算器与真实分词器的偏差 | 🟡 已定动作（2026-09-16）：07 落地后用真实 usage 标定一次估算器（Gateway 的 `usage` 恒 0，需 provider 侧或本地分词器） |
| 24 | 提交策略：06/07（含两轮复审修复）目前全在工作区未提交 | ⬜ 待拍板：是否提交、拆几个提交（建议：06 一个、07 一个，07 带上复审修复）、是否 push |
| 25 | 打包态端到端（`build:win` + 安装包冒烟）在 06/07 未做 | ✅ 2026-09-17 已补（**7/7**）：`npm run build:win` 产物 + `node test/packaged-gateway.smoke.mjs`（真渲染进程调真 IPC、便携数据目录），结果落 `test/packaged-smoke-07.json`；真界面点击流留给 08 |
| 26 | 下一步顺序：05b（扫描件 AI 识别）与 08（AI Advisor）依赖都已满足 | ⬜ 待拍板：建议先 08（一期主线第一屏、也是 06/07 的首个真实消费者），05b 随后 |
| 27 | `Setup.vue` 按钮文案仍为「前往控制台」，与 #2 的「工作台」口径不一致 | ⬜ 待拍板：一行文案，改不一致？ |

## 十、概念备忘

- Skill ≠ 商家数据：Skill 是能力/行业知识；商家资料属于 Project。
- OpenClaw Memory ≠ Umi Claw Knowledge Base：Memory 是 Agent 工作记忆；Knowledge 是商家事实知识。
- 知识库是一级能力，不是 BusinessBrain 的子功能；素材库与知识库分离（「你是谁」 vs 「你手里有什么」）。
- 热点是全局数据（hot_topics 抓一次共享），相关性是 Project × 发布平台数据（project_hot_topics 懒评分缓存，24h TTL）；采集不依赖 Gateway，AI 才依赖。
- **External Intelligence ≠ Merchant Knowledge**：热点榜单是外部情报，永不自动写入 Knowledge Base；只有老板人工采纳的事实才进入商家资料。
- 去重只在同源内做；跨平台同事件保留多行（能回答「哪个平台最火」），聚合是二期的事。
- 数据源三条供给线（v1.12）：榜单（公开聚合 API，base URL 可配）/ 节点日历（自建，零抓取零鉴权）/ Watchlist（老板填的词，只喂 AI 不采集）。
- Watchlist ≠ 采集任务：一期只作为 AI 上下文与关注点记录；2.1 若做关键词采集，按全局词池去重、一个词只采一次多商家共享。
- 小红书**没有**公开稳定的免鉴权热点出口（平台策略，非技术难度）：抖音侧雷达信号更厚、小红书侧靠通用热点 + AI 语义判断，**UI 不得假装小红书有专属榜单**。
- 更智能 = 更少让老板解释自己：他填过的必须用上，没填的主动问，改过的要学到。
- 纯目录不做结构化存储；大文件走文件系统 + 库存路径。
- 营销数据按 Project 隔离：`data/projects/<id>/` 原始文件 + 结构化数据 project_id 外键。
- 删除 Project（v1.10 修订）：弹确认窗 → **先删 `data/projects/<id>/` 目录（占用失败做重试并记日志）→ 再删 DB 行（级联清结构化数据）**。删行失败时**不声称删除成功**：保留 DB 行、向用户报错并提供「重试删除」（操作幂等：目录已不存在则直接删行）；目录可能已被删故不存在「凭目录重建」，仅依赖 VACUUM INTO 快照兜底。物理删除无软删。
