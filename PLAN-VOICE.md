# Umi Claw 语音功能开发规划（PLAN-VOICE v1.0）

> 状态：v1.0 草案（2026-10-28），待拍板后冻结 ｜ 关联：`PLAN-FISH.md` §13（产品意图）、`PLAN-3.0.md`（工作域基线）、`doc/voice/VOICE-REFERENCE-v1.md`（接口核对与音色归档）
> 本文是语音功能的**实现基线**：与 PLAN-FISH §13 冲突时，以本文为准；§13 只保留产品意图与不做项。
> 适用：`release/1.0` / `release/2.0` / `release/3.0` **三版本均为交付范围**（3.0 起手 → 2.0 → 1.0，但一个都不能少）

## 〇、拍板结论（v1）

1. **首发 TTS 用豆包语音合成 2.0**，走方舟 Agent Plan 的 HTTP 接口，复用现有 Agent Plan Key；默认音色 `zh_female_vv_uranus_bigtts`。
2. **音色克隆用火山 ICL 2.0**：克隆管理和克隆音色合成都走语音控制台线路；训练用 `voice_clone`，克隆音色合成固定走 `/api/v3/tts/unidirectional`；**需要一把独立的语音服务 Key**（现有 Agent Plan Key 实测 401，见 §2）。
3. **单独开一个「语音」路由** `/voice`，集中管理 TTS Key、克隆 Key、音色、试听、克隆任务、预算与缓存；不塞进工作设置页。
4. **密钥 BYOK**：应用不内置共享 Key，由用户在 `/voice` 自填；密钥只进 `safeStorage`，不进 `app_meta`、不进日志。
5. **v1 只做“会说话”**：预设音色 + 已授权克隆音色朗读；唱歌（SVS/SVC）不做，UI/IPC/依赖都不预埋。
6. **1.0 / 2.0 / 3.0 三版本全量对齐**，不是“先做 3.0 再说”；v1 的验收以三版本都跑通为准。开发从 3.0 起手，但 2.0/1.0 的移植、接线与回归都计入本版本范围。

## 一、范围与不做

### 1.1 v1 做

- **三版本同享**：1.0 / 2.0 / 3.0 都必须有 `/voice`、TTS、克隆、预算、缓存；差异只在存储与装配层
- 文本 → 语音：气泡朗读、重要提醒、报告完成提示、手动试听
- 预设音色选择与试听（豆包 2.0）
- 音色克隆：样本导入/预检/授权确认/训练/状态轮询/试听/启用/删除
- `/voice` 配置路由：供应商、两把 Key、默认音色、参数、预算、缓存
- 音频缓存与本地播放；飞书原生语音条输出
- 字符预算与调用统计（独立于米粒）

### 1.2 v1 不做

- 唱歌：SVS 重新唱、SVC 人声替换
- 批量声纹采集、隐藏录音、通话音频提取
- 自动朗读业务正文/敏感上下文（只读短提示）
- 共享平台 Key 分发、密钥随安装包内置
- 微信原生语音条（当前插件无发送路径，见 §2.3）

## 二、实测结论（2026-10-28）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| Agent Plan TTS | ✅ HTTP 200，返回 mp3，10.3s/82KB | `POST /api/v3/plan/tts/unidirectional`，`X-Api-Resource-Id: seed-tts-2.0`，现有 ark Key |
| 克隆音色 TTS | ✅ 走语音控制台线路 | `POST /api/v3/tts/unidirectional`，`X-Api-Resource-Id: seed-icl-2.0`，`speaker=<custom_speaker_id>`，语音服务 Key |
| 语音复刻接口鉴权 | ❌ 401 | 同一把 Key 调 `POST /api/v3/tts/get_voice` 返回 `401 Unauthorized` |
| 飞书原生语音条 | ✅ `msg_type=audio` | Ogg/Opus 48k 单声道 + `asVoice`，需 `im:resource:upload` 权限 |
| 微信语音条 | ❌ 只能文件 | `@tencent-weixin/openclaw-weixin` 2.4.10 只分流 image/video/file，无 voice 发送 |

结论：**TTS 和克隆是两条产品线、两套鉴权**。TTS 现在就能用；克隆要先拿语音控制台 Key。

## 三、供应商与能力

| 能力 | v1 供应商 | 资源/接口 | 备注 |
| --- | --- | --- | --- |
| 预设音色 TTS | 火山/豆包 2.0 | `seed-tts-2.0`，`/api/v3/plan/tts/unidirectional` | 复用 Agent Plan Key |
| 克隆音色 TTS | 火山 ICL 2.0 | `seed-icl-2.0`，`/api/v3/tts/unidirectional` | 使用语音服务 Key |
| 音色克隆管理 | 火山 ICL 2.0 | `seed-icl-2.0`，`/api/v3/tts/voice_clone`、`get_voice` | 使用语音服务 Key |
| 本地兜底 | Microsoft Edge / 本地 CLI | 无 Key | 只做降级，不承诺音质 |
| 后续 | MiniMax / Fish Audio / 本地 HTTP | Provider 适配层 | 不在 v1 排期 |

`VoiceProvider` 抽象（核心不写死火山）：

```ts
export interface VoiceProvider {
  id: string
  capabilities: { tts: boolean; clone: boolean }
  synthesize(req: SynthRequest): Promise<SynthResult>
  clone?: {
    train(req: CloneTrainRequest): Promise<CloneTrainResult>
    status(speakerId: string): Promise<CloneStatus>
    remove(speakerId: string): Promise<void>
  }
}
```

## 四、TTS 方案（v1）

### 4.1 决策

- 接口：`POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`
- 鉴权：`X-Api-Key: <Agent Plan Key>`
- 资源：`X-Api-Resource-Id: seed-tts-2.0`
- 计量：`X-Control-Require-Usage-Tokens-Return: *`（返回 usage，记米粒/字符账）
- 输出：`mp3`，`sample_rate: 24000`；需要飞书语音条时本地转 `ogg_opus` 48k 单声道
- 默认音色：`zh_female_vv_uranus_bigtts`（可在 `/voice` 改）

请求体：

```json
{
  "req_params": {
    "text": "要朗读的文本",
    "speaker": "zh_female_vv_uranus_bigtts",
    "audio_params": {
      "format": "mp3",
      "sample_rate": 24000,
      "speed_ratio": 1.0,
      "loudness_ratio": 1.0
    }
  }
}
```

响应是**逐行 JSON 流**（不是 SSE，也不是整段音频）：

```json
{"code":0,"message":"","data":"<base64 mp3 chunk>"}
{"code":0,"message":"","data":"<base64 mp3 chunk>"}
{"code":20000000,"message":"OK","usage":{"text_words":18}}
```

- `code=0`：有数据，继续读
- `code=20000000`：正常结束（**不是错误**）
- 其他 code：抛错，按 §附录 C 映射

### 4.2 文本与音频处理

- 单请求建议 ≤400 字；按 `。！？；\n` 切句，长句硬切；分段合成后拼 mp3（同参数可拼接）
- 文本清洗：去 emoji（TTS 不读）、压缩空白；保留标点
- 重试：5xx/超时重试 2 次（指数退避）；4xx 不重试
- 超时：单段 60s；总任务 180s
- 缓存键：`sha256(provider|speaker|text|emotion|speed|format|sampleRate|resourceId)`；命中直接返回本地文件
- 缓存目录：`<dataDir>/fish/audio/`；上限 500MB，LRU 清理
- 并发：同一缓存键只允许一个在途请求（`FISH_BUSY` 复用同一个 Promise）

### 4.3 预算与计量

- 独立字符预算：每日上限可配，默认关（仅统计）
- 统计：请求数、字符数、usage tokens（若返回）、失败数
- **超预算直接拒绝本次合成**（v1 硬闸门，避免失控计费）：拒绝发生在调用供应商之前，不排队、不部分合成；UI 明示已用/本次/上限，调高上限或次日恢复
- 语音费用不并入米粒；统一费用视图列 P1

## 五、音色克隆方案（v1）

### 5.1 决策

- 供应商：火山 ICL 2.0
- 训练：`POST /api/v3/tts/voice_clone`
- 查询：`POST /api/v3/tts/get_voice`
- 升级：`POST /api/v3/tts/upgrade_voice`（P1，v1 不做统一管理）
- 合成：固定走 `POST /api/v3/tts/unidirectional`，`X-Api-Resource-Id: seed-icl-2.0`，`speaker=<复刻 speaker_id>`
- 计费模式：**v1 用后付费 `custom_speaker_id`**；预付费 `S_xxx` 保留给内部/批量
- 鉴权：训练、查询、克隆音色合成都使用语音控制台 API Key（`X-Api-Key` + `X-Api-Request-Id`，UUID 每请求唯一）；不复用 Agent Plan Key
- 响应头：保留 `X-Tt-Logid` 到脱敏诊断日志，便于定位服务端问题

**调用分流（实现时不得混用）：**

| 场景 | 合成接口 | Key | Resource |
| --- | --- | --- | --- |
| 预设音色 | `/api/v3/plan/tts/unidirectional` | Agent Plan Key | `seed-tts-2.0` |
| 克隆音色 | `/api/v3/tts/unidirectional` | 语音服务 Key | `seed-icl-2.0` |

`speak` 根据 speaker 是否属于内置精选目录，自动选择对应接口和 Key；UI 不暴露 endpoint 选择给普通用户。

### 5.2 训练请求

```json
{
  "speaker_id": "custom_speaker_id",
  "custom_speaker_id": "umi_voice_001",
  "audio": {
    "format": "wav",
    "data": "<base64 样本>"
  },
  "text": "样本对应的文字（强烈建议给）",
  "language": 0,
  "extra_params": {
    "enable_audio_denoise": false,
    "demo_text": "这是试听文本，4 到 300 字。",
    "voice_clone_enable_mss": false,
    "enable_crop_by_asr": true,
    "voice_clone_denoise_model_id": ""
  }
}
```

- V3 训练请求只接受单个 `audio` 对象，不再使用 V1 的 `audios` 数组。
- 请求体不传 `model_type`；`model_type` 只出现在 `get_voice`/训练响应中。
- `audio.format` 对 `pcm`、`m4a` 必传；其余格式可省略。
- `extra_params` 字段名必须是官方 V3 名称，不接受旧版/拼写变体。

### 5.3 样本要求与预检

| 项 | 要求 | 本地预检 |
| --- | --- | --- |
| 格式 | wav/mp3/ogg/m4a/aac/pcm；pcm 仅 24k 单声道 | 检查扩展名/文件头；pcm/m4a 明确格式；不为上传强制转码 |
| 大小 | ≤10MB | 超限直接拒 |
| 时长 | 官方默认按 25s 截断；产品建议 15–30s | <5s 警告；>30s 警告并结合 `enable_crop_by_asr`，不本地自动截断 |
| 人数 | 单人、干声、无背景音乐 | 能量/静音比、双人检测（P1） |
| 文本 | 与音频一致 | 不一致会触发 WER 检测失败 `45001109` |
| 授权 | 本人或已获授权 | 必须勾选，记录 hash 与时间 |

预检失败只警告不阻断（除大小/格式/时长下限），避免误杀。

### 5.4 状态与轮询

- 训练是异步的：提交后返回 `status=1`，轮询 `get_voice`
- 轮询：2s 起，指数退避到 10s，最长 10 分钟；页面可关闭，后台任务继续
- `status`：0 未找到 / 1 训练中 / 2 成功 / 3 失败 / 4 可用
- 只有 `2` 或 `4` 可合成；`3` 展示失败原因与重试
- 响应里的 `speaker_status[]` 可能包含多个模型版本；按 `model_type` 分别保存 `demo_audio`
- `demo_audio` 只有 1 小时有效：拿到就下载到 `<dataDir>/fish/voices/<id>/demo-<modelType>.<真实扩展名>`
- `model_type`：1 ICL V1、2 DiT 标准、3 DiT 还原、4 ICL V2、5 ICL V3；它是响应字段，不是训练入参
- v1 用 `seed-icl-2.0` 合成，优先保留 `model_type=4/5` 的试听音频；不要在 UI 承诺服务端一定返回哪个模型版本
- 每次提交后以响应 `available_training_times` 为准；UI 不在本地推算或承诺失败返还次数

### 5.5 计费与坑（必须写进 UI）

1. **预付费**：先买槽位；槽位费与合成费分开
2. **后付费**：
   - `demo_text` 试听合成**会计合成费**，但不收槽位费
   - **第一次 v3 合成 = 转正，现场收槽位费**
   - 转正后同一 `custom_speaker_id` 不能再次复刻；删除重注册会再收费
   - 复刻后 7 天未合成，自动删除，ID 释放
   - 自定义 ID 只支持在线 v3 合成，不支持异步长文本
3. 训练次数以服务端 `available_training_times` 为准；前端不自行推断返还规则
4. 命名规则：8–256 位、字母开头、仅字母数字 `-_`、不能撞官方音色命名；冲突会拒

**交互要求**：转正前必须二次确认，明示“本次合成将收取音色槽位费”；未确认不调用合成。

### 5.6 删除与合规

- 删除：v1 只删本地样本/缓存/元数据和本地启用状态；本份 V3 文档未给出删除请求路径，不调用猜测的远端接口
- 远端清理：UI 明示“本地删除不等于供应商侧音色立即删除”，保留控制台管理指引；后续确认官方删除接口后再补
- 保留：授权时间、样本 hash、来源（录音/导入）、用户填写的权利说明
- 不提供名人/公众人物模板；命中敏感音色由服务端拦截（`45001104`）
- 样本只用于本次复刻；不做批量采集、隐藏录音、视频抽音轨
- 水印：供应商支持则保留；不支持在 UI 标注“无供应商水印”

## 六、语音设置路由（/voice）

### 6.1 路由与导航（三版本一致）

```ts
// 每个版本的 src/renderer/main.ts 都追加同一条
{ path: '/voice', component: () => import('../views/voice/VoicePage.vue') }
```

| 版本 | 路由文件 | 导航落点 | 备注 |
| --- | --- | --- | --- |
| 1.0 | `src/renderer/main.ts`（平铺路由） | `App.vue` 的 `navItems` | 无 work 域，语音是顶层项 |
| 2.0 | `src/renderer/main.ts`（含 `/marketing/*`） | `App.vue` 管理组 | 与项目切换器无关，全局唯一入口 |
| 3.0 | `src/renderer/main.ts`（含 `/work/*`） | `App.vue` 管理组，紧随「模型配置」 | 工作设置只加入口 |

- 组件：三版本共用 `src/views/voice/VoicePage.vue`
- 深链：工作设置页、鱼设置弹层都放「语音设置」入口 → `/voice`
- 独立路由原因：语音跨业务域，Key/预算/克隆不该埋进工作设置

### 6.2 页面结构（4 个 Tab）

| Tab | 内容 |
| --- | --- |
| 概览 | 服务状态、Key 状态（只显示 `hasKey`）、今日字符/请求、最近错误、快捷试听 |
| 供应商与密钥 | TTS Key、语音服务 Key、固定 endpoint/resource（只读展示）、分别测试连接、清除密钥 |
| 音色 | 预设音色下拉（仅内置 2.0 全量音色（450 条），不拉取全量 325 音色）+ 试听 + 设为默认；克隆音色列表（状态/试听/启用/删除） |
| 预算与缓存 | 每日字符上限、已用、缓存大小/清理、超预算提醒开关 |

克隆向导单独一个抽屉/分步：授权 → 上传 → 预检 → 费用确认 → 训练 → 试听 → 启用。

### 6.3 配置字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `volcengine` | 预留其他供应商 |
| `ttsKey` | 空 | Agent Plan Key，safeStorage |
| `cloneKey` | 空 | 语音控制台 Key，safeStorage |
| `ttsEndpoint` | plan 地址 | 固定值，只读；不支持普通用户修改 |
| `ttsResourceId` | `seed-tts-2.0` | 固定值，只读 |
| `cloneEndpoint` | `/api/v3/tts/unidirectional` | 固定值，只读 |
| `cloneResourceId` | `seed-icl-2.0` | 固定值，只读 |
| `defaultSpeaker` | `zh_female_vv_uranus_bigtts` | 必须是内置精选目录中的预设音色 |
| `speedRatio` | `1.0` | 0.2–3 |
| `emotion` | 空 | 预设音色可用 |
| `format` / `sampleRate` | `mp3` / `24000` | |
| `autoSpeak` | `off` | off / tagged / always |
| `dailyCharLimit` | 0（不限） | 0 = 只统计 |
| `cacheLimitMB` | 500 | |
| `cloneMode` | `postpaid` | postpaid / prepaid |
| `cloneSpeakerId` | 空 | 预付费时填 `S_xxx` |

### 6.4 密钥与安全

- 输入即加密：主进程 `safeStorage.encryptString` → `<dataDir>/voice/key.bin`（或独立键）
- 渲染端只能拿到 `{ hasKey: true, tail: '****abcd' }`，永不回传明文
- 日志/错误对象统一脱敏：不打印 `Authorization`、`X-Api-Key`、base64 音频
- 导出诊断包时剔除密钥与样本
- `safeStorage` 不可用：不持久化，只允许本次会话临时使用，并提示用户

### 6.5 首次配置流程

1. 打开 `/voice` → 概览提示“未配置”
2. 填 TTS Key → 「测试连接」→ 合成 10 字短句 → 播放
3. 选默认音色 → 试听 → 保存
4. 需要克隆时再填语音服务 Key → 「测试鉴权」→ 走向导
5. 预算默认关，用户显式开启才预警

## 七、架构与数据

### 7.1 目录（核心/UI/资源为新增）

```text
electron/main/fish/voice/
├── core/
│   ├── types.ts            # VoiceProvider / SynthRequest / CloneStatus
│   ├── text.ts             # 文本清洗、分段
│   ├── cache.ts             # sha256 键、LRU、原子写
│   ├── budget.ts            # 字符预算与统计
│   └── manager.ts           # VoiceManager：编排、队列、事件
├── providers/
│   ├── contract.ts
│   ├── volcengineCatalog.ts  # 内置 2.0 全量音色（450 条）子集（对应 resources/voice/curated-voices.v1.json）
│   ├── volcengineTts.ts     # 预设音色 plan 接口 + 流式解析
│   ├── volcengineClone.ts   # 克隆管理 + 克隆音色合成
│   └── localCli.ts          # 兜底（现有 tools/volc-tts.mjs 可包装）
├── secretStore.ts           # safeStorage 注入
├── audioConvert.ts          # mp3 → ogg/opus（ffmpeg）
└── ipc.ts                   # fish:voice:*

src/views/voice/
├── VoicePage.vue
├── VoiceOverview.vue
├── VoiceKeys.vue
├── VoiceLibrary.vue        # 预设 + 克隆音色
├── VoiceBudget.vue
└── CloneWizard.vue
```

### 7.2 IPC 契约（`fish:voice:*`，信封 `{ok,data}|{ok,error}`）

| 频道 | 入参 | 返回 |
| --- | --- | --- |
| `settings:get` | — | 非密设置 + `hasTtsKey/hasCloneKey` |
| `settings:set` | patch（白名单） | 更新后的设置 |
| `key:set` | `tts|clone`, value | `{hasKey}` |
| `key:clear` | `tts|clone` | `{hasKey:false}` |
| `catalog:get` | — | 内置 2.0 全量音色（450 条）子集（id/名称/语言/能力） |
| `test` | `tts|clone` | `tts` 合成 10 字并返回 audioId；`clone` 只测语音服务鉴权 |
| `speak` | text/options | `{audioId, chars, cached, usage?}` |
| `audio` | audioId | 安全读取本地音频（只读 `fish/audio`） |
| `cancel` | jobId | — |
| `clone:validate` | samplePath | 预检结果 |
| `clone:train` | samplePath, consent, displayName | `{speakerId, status}` |
| `clone:status` | speakerId | 状态 + demoAudioPath? |
| `clone:list` | — | 本地克隆列表 |
| `clone:remove` | speakerId | 删除本地样本/缓存/启用状态；远端清理不承诺 |
| `budget:get` | date? | 当日字符/请求/失败 |
| `budget:set` | limit | — |
| `cache:clear` | — | 释放字节数 |
| `event` | main→render | 训练状态/播放事件 |

### 7.3 数据键

- 3.0/2.0：`app_meta`，前缀 `voice:v1:`：`settings` / `usage:YYYY-MM-DD` / `voices` / `lastError`
- 1.0：`userData/fish/voice.json`（原子写、坏文件备份后重建）
- 密钥：`safeStorage` 加密文件，不进 `app_meta`/JSON
- 音频/样本：`<dataDir>/fish/audio`、`<dataDir>/fish/voices/<id>/`

### 7.4 跨版本（三版本必须全量）

核心 `fish/voice/core` 只 import Node 内置与本目录类型；禁止 `electron`/`vue`/`work/**`。差异只允许出现在平台适配与装配层：

| 维度 | 1.0 | 2.0 | 3.0 |
| --- | --- | --- | --- |
| 存储 | `userData/fish/voice.json`（原子写、坏文件重建） | `app_meta` `voice:v1:*` | 同 2.0 |
| 密钥 | safeStorage | safeStorage | safeStorage |
| IPC 注册 | 平铺在 `electron/main/index.ts` | `registerIpcHandlers` + `ipc/voice.ts` | work 域旁新增 `ipc/voice.ts` |
| preload | 单 `api` 对象追加 `api.fish.voice` | 追加 `api.fish.voice` | 同 2.0 |
| 路由/导航 | `src/renderer/main.ts` + `navItems` | 同左 | 同左 |
| 音频目录 | `<dataDir>/fish/audio` | 同 | 同 |
| 打包 | `extraResources` 已含 resources | 同 | 同 |

移植规则：核心/UI/组件文件跨分支字节一致；每个分支只允许改 §3.3 的 4 个接线文件 + `package.json` / `run-all-accept` 验收注册。

## 八、验收

1. `/voice` 可保存/清除两把 Key；重启后 `hasKey` 正确，密文不可读
2. 10 字试听成功；预设音色下拉只展示内置精选子集，切换生效；缓存命中不重复计费
3. 长文本 800 字分段合成，拼接可播放，无断句爆音
4. 预算开启后超额只提示一次，不阻断主流程
5. 克隆：坏格式/超 10MB/超时长被拒；好样本训练成功；`demo_audio` 落盘可播
6. 克隆转正前出现费用二次确认；取消则不调用合成
7. 7 天未用的克隆音色在 UI 标注“即将过期”；本地删除可靠，远端删除按官方接口另行确认
8. Key 错误/401/额度不足/网络失败均有可读错误，不泄露密钥
9. 飞书语音条 `msg_type=audio`；微信仍为文件（文档标注）
10. 双 typecheck 通过；打包态 `fish/audio` 可写；`resources` 无密钥

**三版本矩阵（每条都要各跑一遍）**

| 项 | 1.0 | 2.0 | 3.0 |
| --- | --- | --- | --- |
| `/voice` 路由 + 导航 | ✅ | ✅ | ✅ |
| TTS 试听/播放 | ✅ | ✅ | ✅ |
| 克隆训练/试听/删除 | ✅ | ✅ | ✅ |
| 预算与缓存 | ✅ | ✅ | ✅ |
| 存储 | JSON 原子写/坏文件重建 | `app_meta` 前缀正确 | 同 2.0 |
| 打包冒烟 | 便携目录 + 安装目录 | 安装目录 | 安装目录 |

## 九、Commit 计划（3.0 首发）

| Commit | 内容 | 估时 |
| --- | --- | --- |
| V00 | 本文 + `/voice` 空路由 + 导航 | 0.5d |
| V01 | 核心 types/text/cache/budget + Provider 契约 + safeStorage + IPC 骨架 | 2d |
| V02 | 豆包 TTS：流式解析、分段、缓存、播放、预算统计 | 2.5d |
| V03 | `/voice` UI：概览/密钥/音色库/预算 + 试听 | 2d |
| V04 | 克隆：预检/授权/训练/轮询/试听/删除 + 费用确认 | 3d |
| V05 | 飞书语音条转换、打包冒烟、回归、文档 | 1.5d |
| V06 | **移植 2.0**：store 适配 + IPC/preload/路由/导航 + 分支验收 | 1.5d |
| V07 | **移植 1.0**：JSON store + 平铺 IPC + 单 api + 路由/导航 + 分支验收 | 2d |
| V08 | 三分支回归 + 三份安装包冒烟 + 文档收口 | 1.5d |

合计约 **16.5 人天**（V00–V08，三版本全量）。移植不是可选项，V06/V07 未验收则本版本不算完成。

## 十、风险与待定

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 克隆 Key 采购/开通延迟 | 高 | TTS 先上线；克隆开关默认关，Key 到位再开 |
| 后付费“首次合成即收槽位费”引发投诉 | 高 | 转正前二次确认 + 明示费用；默认不自动转正 |
| 7 天未用自动删音色 | 中 | UI 过期提醒；本地保留 demo 与元数据 |
| 样本质量差导致 WER/训练失败 | 中 | 本地预检 + 明确错误 + 重试消耗提示 |
| Agent Plan TTS 配额/限流 | 中 | 并发队列 + 429 退避 + 缓存 |
| 密钥被用户截图/日志泄露 | 高 | 只显示尾号；错误脱敏；导出剔除 |
| 供应商接口变更 | 中 | Provider 适配层 + 端点可配 |
| 微信无语音条 | 低 | 文档明示；飞书/其他通道走原生 |
| 1.0 无数据库 / 平铺 IPC 导致分支分叉 | 中 | JSON store SPI + 4 文件接线红线 + 每分支验收 |

待定：

1. 后付费 vs 预付费最终选型（v1 默认后付费）
2. 克隆是否对所有用户开放，还是先白名单/Dogfood
3. 三版本克隆的开放节奏：功能必须都有；先 3.0 白名单/Dogfood 还是三版本同时全量，待定
4. 是否接 `voice_id` 市场/音色广场（P2）

## 附录 A：TTS 接口速查（Plan）

**请求**

```http
POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional
X-Api-Key: <Agent Plan Key>
X-Api-Resource-Id: seed-tts-2.0
X-Control-Require-Usage-Tokens-Return: *
Content-Type: application/json
```

```json
{"req_params":{"text":"你好","speaker":"zh_female_vv_uranus_bigtts","audio_params":{"format":"mp3","sample_rate":24000}}}
```

**响应**：逐行 JSON；`code=0` 带 base64 `data`；`code=20000000` 结束；`usage` 可选。

**参数**：`format` mp3/ogg_opus/pcm；`sample_rate` 8000/16000/24000；`speed_ratio` 0.2–3；`emotion` 预设音色可用；`loudness_ratio` 0.1–2。

**官方口径**：2.0 官方列表 450 个音色（2026-10-29 解析）；单向流首包约 600ms、双向约 300ms（需实测复核，不作为验收硬指标）。

## 附录 B：克隆接口速查

| 动作 | 接口 | 关键参数 |
| --- | --- | --- |
| 训练 | `POST /api/v3/tts/voice_clone` | `speaker_id` / `custom_speaker_id`、`audio`、`text`、`language`、`extra_params` |
| 查询 | `POST /api/v3/tts/get_voice` | `speaker_id` |
| 升级 | `POST /api/v3/tts/upgrade_voice` | `speaker_id`（P1） |
| 合成 | `POST /api/v3/tts/unidirectional` | `X-Api-Resource-Id: seed-icl-2.0`，`speaker=<id>` |

**鉴权**：`X-Api-Key` + `X-Api-Request-Id`（UUID，每请求唯一）；旧版为 `X-Api-App-Key` + `X-Api-Access-Key`。

**状态**：0 未找到 / 1 训练中 / 2 成功 / 3 失败 / 4 可用。

**返回要点**：`model_type`、`available_training_times`、`demo_audio`（1 小时有效）、`speaker_status[]`。

## 附录 C：常见错误

| code | 含义 | 处理 |
| --- | --- | --- |
| 0 | 成功/数据帧 | 继续读 |
| 20000000 | 流结束 | 正常返回 |
| 401 | 鉴权失败 | 提示检查 Key / 是否用错产品线 |
| 45001101 | 音频上传失败 | 检查网络、大小和格式后重试 |
| 45001102 | ASR 转写失败 | 检查人声是否清晰；重试或更换样本 |
| 45001104 | 声纹检测未通过 | 拒绝该音色；检查授权和素材 |
| 45001105 | 获取音频数据失败 | 检查 base64、文件是否为空或损坏 |
| 45001109 | 文本与音频 WER 不匹配 | 提示 `text` 与样本不一致 |
| 45001110 | 音色删除失败 | 仅在确认官方删除接口后处理；v1 不调用猜测接口 |
| 45001112–45001114 | SNR/降噪/音频质量错误 | 提示更换清晰干声或调整降噪参数 |
| 45001122–45001128 | 无人声、次数上限、ASR/demo/prompt 审核 | 按 message 映射到具体处理项 |
| 45001123 | 达到上传次数上限 | 提示更换有训练次数的 SpeakerID |
| 550013xx | 供应商 DB/TOS/克隆下游异常 | 指数退避；保留 `X-Tt-Logid` |
| 429 | 限流 | 指数退避，不重试用户可见错误 |

完整错误码以官方文档为准；UI 只展示“人能看懂的一句话 + 原始 code”。

## 附录 D：与 PLAN-FISH §13 的关系

- PLAN-FISH §13 定义“要不要做、做到什么程度”（产品意图、合规闸门、不做项）
- 本文定义“怎么接、怎么存、怎么配、怎么验收”（实现基线）
- PLAN-FISH 的 F10–F13 估时作废，以本文 V00–V08 为准
- 三版本同享是硬要求（§0-6）；任何“只做 3.0”的裁剪都需要重新拍板
- 冲突处理：功能范围看 PLAN-FISH，接口/路由/存储看本文

## 十一、实施进度（2026-10-29）

- 3.0 已落地：`/voice` 路由与导航、两把 Key、safeStorage、精选音色下拉、预算、缓存、预设 TTS、克隆训练/轮询/试听/转正/本地删除。
- 受信任短提醒已接本地自动朗读；默认关闭，音频由主进程生成后交渲染端播放。
- `accept:voice` 覆盖 8 组契约：目录、双路由、缓存、长文本 PCM→WAV、预算、Key 闸门、克隆重试/转正/删除。
- 待办：飞书原生语音条的音频转码/上传、2.0 与 1.0 分支移植、真实 Key 手工联调和三份安装包冒烟。
