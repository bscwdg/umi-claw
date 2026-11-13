# 4.0 运维手册（升级 / 回滚 / 卸载 / 故障处置）

> 适用版本：Umi Claw 4.0（插件化内核）。读者是「要帮用户处置现场问题」的维护者。
> 相关背景见 `PLAN-4.0.md`（架构）与 `doc/PROGRESS-4.0.md`（施工记录）。

---

## 1. 4.0 的数据布局

| 位置 | 内容 | 谁在读写 |
|---|---|---|
| `<dataDir>/work.db` | **3.0 旧库**。4.0 起只承载 voice 的 `app_meta`；工作域数据已搬走 | 宿主（voice） |
| `<dataDir>/umi-claw.db` | **2.0 旧库**。4.0 起只读，仅作为营销数据导入源 | 宿主（只读打开，不存在则不创建） |
| `<dataDir>/plugins/work/data.db` | 工作域插件库（8 表） | work 插件 |
| `<dataDir>/plugins/work/.imported` | 一次性导入完成标记（含每表行数） | work 插件 |
| `<dataDir>/plugins/marketing/data.db` | 营销域插件库（11 表） | marketing 插件 |
| `<dataDir>/plugins/marketing/.imported` | 同上 | marketing 插件 |
| `<dataDir>/plugin-config.json` | 插件配置（按插件分桶，防抖落盘） | 宿主 ConfigStore |
| `<dataDir>/plugins-state.json` | 插件启停状态（原子写） | 宿主 Registry |

> 原则：**插件数据只在 `plugins/<id>/` 下**；宿主旧库永不删除、永不改写。
> 例外（已知，Phase 4 待办）：知识库原文仍写 `<dataDir>/projects/<id>/`（兼容旧 `source_path`）。

---

## 2. 升级：3.0 → 4.0 首次启动

1. 首次启动时宿主管线：`workDatabase` → `initPlugins()` → 各插件 `activate()`。
2. work 插件激活时：`db.migrate()` 建表 → 后台 `importWorkDataIfNeeded` 从 `work.db` 搬数据。
3. marketing 插件同理，从 `umi-claw.db` 搬。
4. 导入成功写 `.imported`（记录每表行数与页数）。

**验收口令**：启动日志出现 `[import] <table>: N 行`，且 `<dataDir>/plugins/work/.imported` 存在。
若日志只有 `跳过 <table>（旧库没有这张表）`，说明旧库确实没这张表，属正常。

### 导入失败怎么办

- 现象：日志 `[work] 数据导入失败（下次启动重试）`，且 `.imported` 不存在。
- 行为：**不写标记、下次启动自动重试**；已导入的行用 upsert 收敛，不会主键冲突。
- 处置：先看原因（旧库被占用 / 磁盘满 / 旧库损坏），修好后再启动一次即可。
- 若想强制重来：删 `<dataDir>/plugins/<id>/data.db` 与 `.imported`，重启（旧库仍在，可重导）。

---

## 3. 回滚：4.0 → 3.0

**关键事实**：4.0 期间产生的数据**只写在插件库里**，3.0 的 `work.db` 不会同步更新。

回滚步骤：

1. 退出 4.0（正常退出会走 `before-quit` 清理：停插件 → 配置落盘 → 关库）。
2. 备份 `<dataDir>/plugins/`（整目录）。
3. 装回 3.0，启动。
4. 3.0 看到的是**升级那一刻**的 `work.db`；4.0 期间的新数据只在备份里。

**要保留 4.0 新数据**：把 `plugins/work/data.db` 里的 8 表导出成 SQL，再按 3.0 schema 导入
`work.db`（表结构一致，`sqlite3 .dump` 后按需重放即可）。

**不做自动反向同步**——两边同时写会制造「谁是真的」问题，PLAN 明确选择单向。

---

## 4. 卸载

安装器卸载会删程序目录，**不会删 `<dataDir>`**（Electron userData 在用户的 AppData 下）。

如果确认要彻底清理：

1. 先备份 `<dataDir>/plugins/`（插件数据）与 `voice/`（音色密钥）。
2. 删除 `<dataDir>` 下：`plugins/`、`work.db*`、`umi-claw.db*`、`plugin-config.json`、`plugins-state.json`。
3. `backup/` 里是各库的迁移前快照，可一并保留一段时间。

---

## 5. 故障处置速查

| 现象 | 最可能原因 | 处置 |
|---|---|---|
| 工作/营销页面空白、控制台 `No handler registered for work:*` | 对应插件没激活（清单坏 / 激活超时 / 被停用） | 打开「能力中心」看该插件状态与错误；点重试 |
| 启动慢、首屏很久才出来 | 首次导入大库（分页 5000/批）；或激活插件 spawn worker 慢 | 看日志 `[import]`；第二次启动不会重复导入 |
| 数据「没了」 | 导入失败未写标记，插件以空库运行 | 看日志错误；修好后重启重试（见 §2） |
| 停用插件后功能还在 | 通道归属错误（如 gateway 面） | 4.0.0 起 gateway 按域拆分；确认版本 |
| 停用后提醒还在响 | 提醒循环属 work 插件，随停用停止 | 确认是 work 插件停用而非仅隐藏菜单 |
| 热点雷达不更新 | 没配置多模态/网关未就绪 / collector 路径错 | 看 `[hot]` 日志；确认 `<resources>/collector/index.mjs` 存在 |
| 扫描件识别慢才报「未配置多模态」 | 预检未生效（旧版本） | 升级到 4.0.0+；新版本在栅格化前直接返回 |
| 升级后要求重新同意协议 | consent 存在插件库；插件库被删/未导入 | 重新同意一次即可 |
| 营销插件激活失败、错误里提到旧库 | 旧版本会在缺 `umi-claw.db` 时抛错 | 4.0.0+ 已改为返回空 reader（全新安装可正常激活） |

---

## 6. Windows 安装冒烟清单（打包后人工执行）

> 自动化只能覆盖「构建产物静态核对」（`npm run smoke`）与全量验收（`npm run accept`），
> 真实安装行为必须人工过一遍。

1. `npm run build:win` 产出 `release/Umi Claw Setup <ver>.exe`。
2. 干净机器（或全新用户目录）安装 → 启动，确认：窗口出现、无白屏、控制台无 `No handler`。
3. 能力中心：work / marketing 显示「已启用」「已激活」，通道数 > 0。
4. 工作页新建一条记录 → 重启 → 记录还在（插件库落盘）。
5. 停用 marketing → 营销菜单与顶栏「当前商家」消失 → 重新启用 → 恢复。
6. 升级安装（覆盖旧版本）→ 旧数据仍在；日志出现 `[import]` 或 `.imported` 已存在。
7. 卸载 → 确认 `%APPDATA%/Umi Claw` 保留（数据不随卸载删除）。

---

## 7. 开发侧常用命令

```powershell
npm run plugin:gen          # 生成插件入口 + 复制清单/migrations 到 resources
npm run build               # 生成 + 构建（含插件代码）
npm run typecheck:node      # 主进程
npm run typecheck:web       # 渲染端（tsc 只管 .ts；.vue 由构建期 vite/vue 编译检查）
node test/plugin.accept.mjs # 插件内核 + 两个域装箱 + 加固（71 项）
npm run accept               # 全量验收（2026-11-13 干净基线：51 套 = ACCEPT 47 + e2e×3 + smoke；888 项检查（887 通过 + 1 显式跳过） + config-writer node:test 21 条另计）
node test/packaged.smoke.mjs# 打包态静态冒烟
node test/one-day.e2e.mjs   # 「一天」端到端
```

## 8. 便携 Node / DB 写入排查（4.0.1 P5）

**症状**：保存工作记录/插件数据报 `DB_ERROR`，日志出现 `readonly database` / `unable to open database file`；
或启动后 `<dataDir>/logs/runtime-probe.log` 出现「便携 Node 写入探针失败」。

**常见原因**：
1. `data/runtime/node-win32-x64/node.exe` 被 Windows/安全软件标成低完整性（Low IL），能启动但写不了普通目录；
2. `data` 目录只读 / 被同步工具锁定；
3. 安全软件拦截 Node 子进程写文件。

**处理**：
- 看 `<dataDir>/logs/runtime-probe.log` 的 reason：`probe-failed`（EPERM/只读）或 `timeout`（慢盘/安全软件）；
- 确认 `data` 目录可写：手动建一个文件再删掉即可（不需要命令行工具）；
- 重装运行环境（应用内「环境初始化/更新」或删除 `data/runtime` 后重新初始化），并检查安全软件白名单；
- 测试机若 `npm run accept` 报 SQLite 14/EPERM：验收脚本会自动把便携 Node 复制到系统临时目录规避（`test/_lib.mjs:resolveNodePath`），与产品问题无关，但要在用户终端复跑一次确认。

## 9. QQ 语音条发送（QQBot）

C2C 语音条**不是文件**：音频必须是 SILK（`0x02` + `#!SILK_V3`，16kHz 单声道），
上传用 `file_data`，发送用 `msg_type=7` + `media.file_info`；走 `attachments` 会退化成文件。
完整配方、坑位与新电脑自检清单见 **[QQBOT-VOICE.md](voice/QQBOT-VOICE.md)**。

最短路径（在仓库根目录）：

```powershell
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 media/voice.wav
node scripts/qqbot-voice-make-silk.mjs media/voice.wav media/voice.silk
node scripts/qqbot-voice-send.cjs media/voice.silk --openid <openid> --msg-id <msg_id> --seq 1
```

- 凭据：`<dataDir>/config/.openclaw/qqbot/data/credential-backup/current.json`（32 位 secret）；
  换机器用 `CLAW_DATA_DIR` 指定 data 目录。
- 新电脑先跑 `node scripts/qqbot-voice-send.cjs <silk> --openid <openid> --dry-run` 自检，
  不会发消息。

> 注意：下面两个脚本只用于**宿主侧人工排障**（main/人工进程）。feiyu agent 会话的 `exec`
> 调用它们会被 feiyu-guard 按野链路硬拦（原因码 `wild-voice-path-blocked`）；agent 发语音
> 的唯一合规入口是网关 `tts` 工具，见 §10。

## 10. QQ 群聊策略与 feiyu-guard 排障

群聊走**单 agent**：qqbot 私聊/群聊都路由到 `feiyu`；群策略由宿主写入
`channels.qqbot.groups["*"]` + 随包插件 `resources/openclaw-plugins/feiyu-guard`
（`plugins.load.paths` 加载、`plugins.entries["feiyu-guard"].config` 配置）。

**症状与排查**：

- 群里不回复：先看设置页「允许她在 QQ 群里回复」；关= `channels.qqbot.groupPolicy: "disabled"`。
  需 @ 才回复？看「群里必须 @ 她才回复」→ `groups["*"].requireMention`。**宿主保存设置后即时重写
  openclaw.json，但 qqbot 群配置生效仍需重启网关**。开启群回复会保留既有 `allowlist`（不会静默放开
  所有群；只有原本非白名单才写 `open`）。
- 语音发不出去/超限：群语音限额（日上限/开关）只对群硬控，看
  `<dataDir>/character/group-guard-state.json` 的当日计数（按群 openid）。语音开关/上限在角色设置
  「群聊」组；改设置会即时重写配置（生效仍需重启网关）。另有一条与群无关的 **feiyu 语音通道合规**：
  feiyu 会话（不分群/私聊）的 `exec` 命中以下任一类特征会被 block（原因码
  `wild-voice-path-blocked`），这是预期行为不是故障——语音应走网关 `tts` 工具；非 feiyu
  会话（如 main）不受此限：
  - 脚本名：`say.py`/`edge-tts`/`edge_tts`/`qqbot-voice-send`/`qqbot-voice-make-silk`/`probe-upload`；
  - 平台端点：`api.sgroup.qq.com`（含 `sandbox.` 沙箱子域）、`bots.qq.com/app/getappaccesstoken`、
    `api.bot.qq.com`（现 wiki 新主机族，与 sgroup 等价的 OpenAPI 基座；大小写不敏感）；
  - 媒体路径：命令文本出现 `/v2/users/<id>/files` 或 `/v2/groups/<id>/files`（host 拆进变量也认）。
  改名野脚本（如 `probe2.cjs`）只能绕过脚本名特征，端点/路径特征仍会命中。这是「特征摩擦层」
  而非绝对阻断，变量拼接/编码等混淆仍可能绕过，减面根治靠归档工作区野工具。
  另有一条 **C2C 平台 API 通道合规**（不经 exec，独立分支）：feiyu 会话调用
  `qqbot_platform_api` 工具直传私聊语音（`POST /v2/users/<id>/files` 且 `file_type=3`）
  同样按野链路 block（原因码不变）。它在群判定之前执行，先于群策略，且只认 feiyu 会话——
  非 feiyu 会话、图片/文件（file_type 1/4）、`/messages` 发送端点、群路径参数在私聊会话里
  一律放行；群语音上传仍走原群策略（回复开关 + 日上限），两条分支互不影响。
- 亲密词没过滤：确认「启用」+ 词表；filter 只对群 `message_sending` 文本生效（含 agent 回复），
  私聊不生效；命中「整条拦截」时群里看不到回复，投递记录里会有 `group-word-blocked` 抑制原因。
- 群聊写了记忆：记忆隔离只拦 `write`/`edit`/`apply_patch` 三个写工具；`exec` 不做记忆隔离判定
  （但 feiyu 会话的 `exec` 会另走上面的语音通道合规检查，两回事），cron 投影工具名也不在 hook matcher
  内（已知边界）。确认设置里「群聊不写入私聊日记/长期记忆」为开。
- 插件是否加载（**必须补网关同款环境变量**，否则 CLI 读 `~/.openclaw` 会报 Plugin not found）：
  ```powershell
  $dataDir = 'D:\work2026\files\claw-desktop\data'
  $env:HOME = "$dataDir\config"; $env:USERPROFILE = $env:HOME
  $env:OPENCLAW_CONFIG_DIR = "$dataDir\config\.openclaw"
  $env:OPENCLAW_DATA_DIR = "$dataDir\data"
  & "$dataDir\runtime\node-win32-x64\node.exe" `
    "$dataDir\openclaw\node_modules\openclaw\dist\index.js" `
    plugins inspect feiyu-guard --json
  ```
  应用内网关运行时可加 `--runtime` 看 hookNames（应为 `message_sending, reply_payload_sending,
  before_tool_call`）；注意本机沙箱下 `--runtime` 可能卡在 OpenClaw loader 的 `plugin-captures` EPERM
  （环境问题，不是插件代码），卡住时用 metadata `--json` + 应用日志判断。插件自身异常一律 fail-open；
  但注意「fail-open」指群策略与判不出的形状，feiyu 会话命中明确野链路特征的 `exec` 是**有意 block**，
  私聊同样生效，排障时不要把 `wild-voice-path-blocked` 误判成插件异常。
- 旧双 agent 残留：配置可读且 bindings 可读时，升级后启动会删 `agents.entries["feiyu-group"]` 与对应
  绑定；读不到 bindings 会保留旧条目等下次同步。旧 `workspace-feiyu-group/`、`agents/feiyu-group/`
  与 guard 计数状态只会在「删除全部数据」时清理；**openclaw.json 里的 guard 条目/groups 配置不会随
  「删除全部数据」回滚**（配置不属于用户数据）。

## 11. 语音条变成文件（QQ 平台 500「系统繁忙」）

症状：feiyu 回复的语音在 QQ 里显示为文件而不是语音条。网关日志出现
`sendVoice failed (API Error [/v2/users/<openid>/files]: 系统繁忙，请稍后重试),
falling back to sendFile`，随后同一份音频以 `file_type=4` 文件形式投递成功。

成因与判据：

- 失败点固定在 QQ 平台媒体接口 `POST /v2/users|groups/<id>/files`（`file_type=3` 语音），
  qqbot 插件按 `UPLOAD_RETRY_POLICY` 重试 3 次（1s/2s 指数退避）耗尽后**静默降级为文件**，
  上层 `handleVoiceIntent` 只看 `result.error`，不感知 `fallback: true`。
- 这是**平台侧瞬时繁忙/频控**，不是本地配置问题：同一秒内其它 qqbot 接口仍回 200
  （200/500 交错），同进程同 token，可排除 token、网络、base URL、TTS 实例。
- 2026-11-13 实测两个故障窗（09:37、12:39–12:40，共 12 个 500）均在几分钟内自行恢复；
  feiyu 事后用手工脚本打同一接口回 200，是因为窗口已过，不代表 SDK 封装有 bug。

排障步骤：

1. 截断日志看本轮进程：`<dataDir>/logs/openclaw-gateway.err.log` 搜 `falling back to sendFile`
   与 `<<< Status: 500`；该文件每次拉起网关截断重写，跨重启的历史在结构化按天日志
   `<dataDir>/tmp/openclaw/openclaw-YYYY-MM-DD.log`（JSONL，按天保留）。
2. 提 500 的 TraceId（QQ 工单材料）：
   ```powershell
   node -e "const fs=require('fs');const f='data/tmp/openclaw/openclaw-2026-11-13.log';for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/)){if(l.includes('Internal Server Error')){const r=JSON.parse(l);console.log(r.time,(r.message.match(/TraceId:\s*([0-9a-f]+)/i)||[])[1])}}"
   ```
   文件名日期按本地时区，替换成故障当天；JSONL 按天滚动且跨重启保留。
3. 处置：平台繁忙通常自行恢复，先观察复现频率；复发时带 TraceId 提 QQ 工单查频控/配额。
   不要为此绕过 `gw.sendVoice` 手搓 `/files`+`/messages`——同一端点仍会撞限流，还会丢掉
   SDK 的 token 缓存与重试。
4. 若日志是 `wild voice path blocked`：那是 feiyu-guard 在拦野链路（见 §10），与平台 500
   无关，说明 agent 没走网关 `tts` 工具，按通道合规问题处理。
