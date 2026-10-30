# 让 OpenClaw 回复语音：配置与排查手册

> 适用版本：3.0 / 4.0（语音页 `/voice` 与 OpenClaw `tts` 块为同一套宿主能力）
> 关联：[PLAN-VOICE.md](../../PLAN-VOICE.md) §4 对话内语音、[VOICE-REFERENCE-v1.md](./VOICE-REFERENCE-v1.md) §1.5 开通前置
> 结论先行：**精选音色用「本地桥接（Agent Plan Key）」；克隆音色只能用「标准接口（语音控制台 Key + seed-icl-2.0）」**。
> 语音回复是 OpenClaw 的能力，应用只负责把 `tts` 块写进 `openclaw.json`、网关启动时注入密钥环境变量。

## 1. 两把 Key、两条通道

| 通道 | 用哪把 Key | 走哪个接口 | 能合成哪些音色 |
| --- | --- | --- | --- |
| **本地桥接**（`tts-local-cli` + `resources/voice/volc-tts.mjs`） | **Agent Plan TTS Key**（语音页「Agent Plan TTS Key」） | 火山 Plan 接口 `/api/v3/plan/tts/unidirectional`，`X-Api-Resource-Id: seed-tts-2.0` | 仅**精选（预设）音色** |
| **标准接口**（OpenClaw 自带 `volcengine` provider） | **语音控制台 Key**（语音页「语音服务 Key」） | 火山标准接口 `/api/v3/tts/unidirectional`，预设音色 `seed-tts-2.0` / 克隆音色 `seed-icl-2.0` | 预设音色 + 克隆音色 |

要点：

- 克隆音色**不能**走本地桥接（Plan 接口不提供复刻音色）。
- 标准接口能否用取决于语音控制台是否开通对应资源（精选音色需要「语音合成大模型」；克隆音色需要「声音复刻2.0」+ 音色槽位，见 [VOICE-REFERENCE-v1.md §1.5](./VOICE-REFERENCE-v1.md)）。
- 密钥**不进 `openclaw.json`**：只存在 `safeStorage`，网关启动时以环境变量注入（`UMI_VOICE_PLAN_KEY` 或 `VOLCENGINE_TTS_API_KEY`）。

## 2. 操作步骤（精选音色）

1. 语音页 → **概览**：确认「Agent Plan TTS Key」已保存（精选音色合成用它）。
2. 语音页 → **精选音色**：选好音色（如 `zh_female_vv_uranus_bigtts`）、语速/情绪按需。
3. **对话内语音** 选 `always`（每条回复都发语音）或 `inbound`（你发语音时才回语音）。
   - `tagged` 档只会在模型主动输出 `[[tts:…]]` 指令时合成语音，普通聊天仍是文字；
   - `off` = 整体关闭。
4. **对话内语音通道** 选 **「本地桥接（Agent Plan Key）」**。
   - `auto` 的判定：只要有语音控制台 Key 就优先「标准接口」，精选音色用标准接口需要「语音合成大模型」资源，否则会资源未授权失败；
   - 所以精选音色建议手动锁定桥接，别依赖 `auto`。
5. 点 **「保存语音设置」**：`tts` 块立即写入 `openclaw.json`。
6. 点 **「重启网关」**：密钥是网关启动时注入的环境变量，**不重启不生效**。
7. 点 **「测试通道」**：桥接成功会返回「Plan 接口合成成功」并直接播放；失败会给出具体原因。

## 3. 通道判定规则（`resolveConversationChannel`）

| 设置 | 生效通道 | 失败原因（状态栏会显示） |
| --- | --- | --- |
| `off` | 无 | 「对话内语音已关闭」 |
| `bridge` + 克隆音色 | 无 | 「克隆音色只能走标准接口，不能走本地桥接」 |
| `bridge` + 无 Agent Plan Key | 无 | 「未配置 Agent Plan TTS Key」 |
| `bridge` + 桥接脚本缺失 | 无 | 「内置桥接脚本路径缺失」 |
| `volcengine` + 无语音控制台 Key | 无 | 「未配置语音控制台 Key」 |
| `auto` + 有语音控制台 Key | 标准接口 | 「自动选择：标准接口（已配置语音控制台 Key）」 |
| `auto` + 无语音控制台 Key、预设音色 + 有 Agent Plan Key | 本地桥接 | 「自动选择：本地桥接」 |

## 4. OpenClaw 聊天里的命令（验收/临时控制）

```text
/tts status               查看当前 auto / provider / voice
/tts audio 你好，测试一下   立刻发一条一次性语音（不改开关，最快验证）
/tts on                   = auto always
/tts off                  = auto off
/tts chat on|off|default  只对当前会话生效
/tts limit 500            长回复摘要/截断阈值（100–4096）
/tts summary off          关闭「先摘要再合成」
```

- 命令要求发送者在 allowlist/owner 内，且文本命令或原生命令注册已开启。
- 模型也可以在单条回复里用 `[[tts:speakerVoiceId=... speed=1.1]]`、`[[tts:text]]...[[/tts:text]]` 覆盖单次语音。

## 5. 各渠道的输出形态

| 渠道 | 形态 | 额外依赖 |
| --- | --- | --- |
| 飞书 / Telegram / WhatsApp / Matrix | 原生语音条 | 飞书需要网关主机有 **ffmpeg** 转 Ogg/Opus；转换失败则退化发音频文件附件 |
| 其它渠道（微信等） | 音频文件附件 | 无 |

## 6. 自查：`openclaw.json` 里的 `tts` 块

桥接（精选音色，推荐）：

```json5
{
  "tts": {
    "auto": "always",
    "provider": "tts-local-cli",
    "providers": {
      "tts-local-cli": {
        "command": "node",
        "args": ["<resources>/voice/volc-tts.mjs", "{{Text}}", "{{OutputPath}}"],
        "outputFormat": "mp3",
        "timeoutMs": 120000
      }
    }
  }
}
```

`<resources>`：开发环境是项目根的 `resources/`；安装包是 `安装目录/resources/resources/`（即 `process.resourcesPath/resources`）。

标准接口：

```json5
{
  "tts": {
    "auto": "always",
    "provider": "volcengine",
    "providers": {
      "volcengine": { "resourceId": "seed-tts-2.0", "speakerVoice": "zh_female_vv_uranus_bigtts" }
    }
  }
}
```

- 两种写法都**不含密钥**；密钥在网关进程环境变量里。
- 改完设置未重启网关时，`openclaw.json` 已是新值但网关仍用旧环境变量 → 表现为「设置对了但没声音」。

## 7. 常见问题排查

| 现象 | 先查什么 |
| --- | --- |
| 普通聊天只有文字 | 「对话内语音」是不是 `tagged`/`off`；`/tts status` 的 auto 值 |
| 设置是 `always` 仍无语音 | 是否点了「重启网关」；「测试通道」的返回；网关进程是否有 `UMI_VOICE_PLAN_KEY`/`VOLCENGINE_TTS_API_KEY` |
| 测试通道报资源未授权（`requested resource not granted`） | 通道选错（精选音色用标准接口但没开通语音合成资源）；改桥接或去控制台开通 |
| 桥接报「未配置 Agent Plan TTS Key」 | 概览页保存 Agent Plan Key |
| 飞书没收到语音条 | 网关主机是否安装 `ffmpeg`；失败时会退化为音频附件 |
| 语音被截短/改写成摘要 | `/tts limit`、`/tts summary off`；`summaryModel` 是否可用 |
| 应用内提醒不朗读 | 那是「自动朗读」（应用自己的提醒朗读），与对话内语音是两套开关 |

## 8. 与「应用内自动朗读」的区别

- **对话内语音（OpenClaw）**：`tts` 块 + OpenClaw 网关 → 聊天回复变成语音；
- **自动朗读（应用内）**：应用自己把到点提醒等短提示交给 TTS 朗读，`off/tagged/always` 三档，不经过 OpenClaw 对话。
