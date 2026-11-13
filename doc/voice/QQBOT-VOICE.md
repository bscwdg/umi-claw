# QQ 语音条（QQBot C2C）发送说明

> **2026-11-13 起的通道口径**：对话内语音的标准路径是网关 `tts` 工具
> （`dispatch_action id="tts"`），合成通道由宿主语音设置统一配置（本地 TTS 实例 +
> 火山候选保底），QQBot 插件自动完成 SILK 转码与 `msg_type=7` 语音气泡投递。
> 本文下面的脚本是**宿主人工排障/回归专用**，agent 不得在会话里执行——
> 自建 edge-tts/silk/API 链路会绕过用户配置的通道；该硬规则同时钉在
> `resources/character/persona/voice-rules.md` 下发的 SOUL.md 里。
>
> 适用：Umi Claw 的 OpenClaw QQBot 渠道，给 C2C 用户发**语音条**（不是文件）。
> 2026-11-07 用脚本真机验证两次（带 `msg_id` + `msg_seq=1`）。
> 脚本：`scripts/qqbot-voice-send.cjs`；音频转换：`scripts/qqbot-voice-make-silk.mjs`。
>
> 位置提醒：AI 工作区里的 `workspace-feiyu/docs/qqbot-voice-note.md` 只是草稿；
> **换电脑/重装以本文件为准**（仓库 tracked，工作区不会带过去）。

## 0. 最短路径（PowerShell，仓库根目录）

```powershell
# 1) 没有现成音频时先生成 1 秒 16k 单声道样音
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -ac 1 -ar 16000 media/voice.wav

# 2) wav/mp3 -> SILK（16kHz 单声道，0x02 + #!SILK_V3 头）
node scripts/qqbot-voice-make-silk.mjs media/voice.wav media/voice.silk

# 3) 自检（只校验文件/凭据，不发请求）
node scripts/qqbot-voice-send.cjs media/voice.silk --openid <openid> --dry-run

# 4) 发送（被动回复：带 msg_id，msg_seq 从 1 开始，每次 +1）
node scripts/qqbot-voice-send.cjs media/voice.silk --openid <openid> --msg-id <msg_id> --seq 1
```

也兼容位置参数（注意 PowerShell 5.1 会把 `""` 丢掉，空 msg_id 请用 `--dry-run`
或省略位置参数）：

```powershell
node scripts/qqbot-voice-send.cjs media/voice.silk <openid> <msg_id> 1
```

没有 `msg_id` 的主动消息需要机器人有主动推送权限；普通回复场景带上收到的
`msg_id`。

## 1. 前置条件

- Node.js 20+（仓库依赖已含 `silk-wasm`；若 `npm install --omit=optional` 跳过，
  脚本会提示重装）
- ffmpeg 在 PATH 中，或 `$env:FFMPEG='C:\Tools\ffmpeg\bin\ffmpeg.exe'`
- 已在 App 里完成 QQBot 扫码登录，`<dataDir>/config/.openclaw/qqbot/` 存在

### dataDir 在哪

App 的解析顺序（`electron/main/configManager.ts`）：

1. `CLAW_DATA_DIR` 环境变量
2. 便携版 `<exe 目录>/data`（存在即用）
3. 安装版 `%APPDATA%\UmiClaw\data`
4. 开发版 `<repo>/data`

脚本能自动找 1/3/4；**便携版或自定义安装请设置 `CLAW_DATA_DIR`**：

```powershell
$env:CLAW_DATA_DIR = 'D:\work2026\files\claw-desktop\data'
```

## 2. 凭据：不要看错 clientSecret

优先级（脚本逐字段合并）：

1. `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET` 环境变量（缺哪个补哪个）
2. `<dataDir>/config/.openclaw/qqbot/data/credential-backup/current.json`
   - `appId`：10 位
   - `clientSecret`：**32 位**
3. `<dataDir>/config/.openclaw/openclaw.json` 的 `channels.qqbot`
   - 当前安装扫码后会回写 32 位并与 backup 一致；
   - **旧版本可能留下 16 位占位值**，脚本会提示并优先用 backup。

> 不要把任何 secret 写进仓库、文档、截图或聊天记录。

## 3. 已验证协议（C2C 语音条）

### 3.1 上传文件

`POST https://api.sgroup.qq.com/v2/users/{openid}/files`

```json
{
  "file_type": 3,
  "file_data": "<SILK 文件的 base64>",
  "srv_send_msg": false
}
```

- 本次脚本实测：`file_data` 传 base64 可行。
- `url: "base64://..."` 实测返回 `400 40093010 上传URL错误`；`data:` URI、裸 base64
  同样失败。
- 成功返回 `file_info`（部分版本可能给 `file_uuid`，脚本两者都兼容）。

### 3.2 发送语音条

`POST https://api.sgroup.qq.com/v2/users/{openid}/messages`

```json
{
  "msg_type": 7,
  "media": { "file_info": "<上一步的值>" },
  "msg_seq": 1,
  "msg_id": "<可选：被动回复的消息 id>"
}
```

- **只认 `msg_type=7` + `media.file_info`**。
- 不带 `content`、不带 `message_reference` / `replyTo`。
- 请求头：`Authorization: QQBot <access_token>`（不是 `Bearer`）。
- token 用 `POST https://bots.qq.com/app/getAppAccessToken` 换，body
  `{ appId, clientSecret }`。
- `msg_id`：被动回复的消息 id；本次实测带 `msg_id` + `msg_seq=1`。

### 3.3 音频格式

- SILK v3，16kHz，单声道。
- 文件头必须是 `0x02` + `#!SILK_V3`（10 字节 magic 的一部分）。
- 用 `scripts/qqbot-voice-make-silk.mjs` 生成，不要手工拼头。
- 大小/时长受 QQ 侧限制；OpenClaw 配置里 `channels.qqbot.mediaMaxMb` 也会限制
  上传，长音频失败时先看这个值。

## 4. 已踩过的坑

1. **`message(attachments/asVoice)` 会变成文件**：OpenClaw/插件在 `mediaKind`
   缺失时默认按 image 处理，走 `attachments` 不会出语音条。（外部插件行为，版本相关。）
2. **`deliveryStatus: "sent"` 不等于语音条**：插件 `sendVoice` 失败会静默
   fallback 成 `sendFile`；必须看发送接口是否 `msg_type=7` 返回 200。
3. **带 `replyTo` / `message_reference` 会变文件**：语音条不要带引用。
4. **clientSecret 长度**：旧配置里可能有 16 位占位值；以
   `credential-backup/current.json` 的 32 位为准（脚本已优先读它）。
5. **`msg_seq` 必须递增**：同一个 `msg_id` 的多条回复从 1 开始逐条加 1；
   重复/过小会被 QQ 拒绝或去重。
6. **上传 40093010**：见 §3.1，`file_data` 是本次实测可用的路。

## 5. 脚本参数、环境变量与退出码

```text
node scripts/qqbot-voice-send.cjs <silkFile> [openid] [msg_id] [msg_seq]
  或命名参数：--openid <id> --msg-id <id> --seq <n> [--dry-run]
```

| 变量 | 作用 |
|---|---|
| `CLAW_DATA_DIR` | 覆盖 dataDir |
| `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET` | 覆盖凭据（逐字段） |
| `QQBOT_OPENID` | 默认 openid（命令行显式参数优先） |
| `QQBOT_CREDENTIAL_FILE` | 指定 credential-backup/current.json |
| `QQBOT_API_BASE` | 默认 `https://api.sgroup.qq.com`（沙箱时可改）；新主机族 `https://api.bot.qq.com` 同协议，feiyu-guard 对两个主机族同口径拦截 |
| `QQBOT_VOICE_DRY_RUN=1` | 只校验，不发网络请求（等价 `--dry-run`） |
| `FFMPEG` | make-silk 用的 ffmpeg 路径 |

退出码：0 成功；1 参数/凭据/网络/API 失败（终端会打印原因，不含 secret）。

## 6. 成功判定

实际输出示例：

```text
[info] upload ok: file_info=<...>...
[ok] send: {"id":"...","timestamp":"..."}
[ok] 请求体为 msg_type=7 + media.file_info；对方应看到语音条
```

- 上传必须拿到 `file_info`/`file_uuid`
- 发送必须 HTTP 200，且请求体是 `msg_type: 7`
- 对方收到的是语音条（波形/秒数），不是文件卡片

## 7. 故障速查

| 现象 | 优先检查 |
|---|---|
| `40093010 上传URL错误` | 是否误用 `url`/data URI；本次实测要用 `file_data` |
| 发送 401/403 | token 是否 `QQBot <token>`；appId/secret 是否 32 位那份 |
| 发出去是文件 | 是否走了 `attachments`/`replyTo`；看插件 `mediaKind` |
| `msg_seq` 报错 | 同一 `msg_id` 是否从 1 递增、是否重复 |
| 上传成功但发送失败 | `openid` 是否正确、是否在 allowFrom、主动消息权限 |
| 新电脑脚本找不到 data | 设置 `CLAW_DATA_DIR`；确认已扫码登录 |
| 找不到 silk-wasm | `npm install`（不要 `--omit=optional`），或重装依赖 |

## 8. 新电脑自检清单

1. `npm install`（`silk-wasm` 随依赖安装；不要 `--omit=optional`）
2. `ffmpeg -version` 或设置 `$env:FFMPEG`
3. App 扫码登录 QQBot，确认
   `<dataDir>/config/.openclaw/qqbot/data/credential-backup/current.json` 存在
4. 生成样音并转 SILK（§0 第 1–2 步），确认头字节以
   `02 23 21 53 49 4C 4B 5F 56 33` 开头
5. `node scripts/qqbot-voice-send.cjs out.silk --openid <openid> --dry-run`
   确认凭据/文件校验通过（不会发消息）
6. 去掉 `--dry-run`，用测试 openid 发一条，确认对方看到语音条
