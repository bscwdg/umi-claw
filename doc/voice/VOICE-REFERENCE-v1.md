# Umi Claw 语音接口与音色归档 v1

> 归档日期：2026-10-28
> 用途：作为 `PLAN-VOICE.md` 的接口核对记录和首批下拉音色来源
> 官方来源：
> - 声音复刻 V3 API：https://docs.volcengine.com/docs/DoubaoVoice/SoundReplicaAPI-V3?lang=zh
> - 在线音色列表：https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh
> - 声音复刻计费说明：https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh

## 一、声音复刻接口核对结论

### 1.1 接口与鉴权

| 用途 | 接口 | 关键请求头 |
| --- | --- | --- |
| 训练音色 | `POST https://openspeech.bytedance.com/api/v3/tts/voice_clone` | `Content-Type: application/json`、`X-Api-Key`、`X-Api-Request-Id` |
| 查询状态 | `POST https://openspeech.bytedance.com/api/v3/tts/get_voice` | 同上 |
| 升级音色 | `POST https://openspeech.bytedance.com/api/v3/tts/upgrade_voice` | 同上，P1 暂不做 |
| 克隆音色合成 | `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional` | 同上，另加 `X-Api-Resource-Id: seed-icl-2.0` |

- 新版控制台只使用 `X-Api-Key`；旧版控制台的 App Key/Access Key 方式仅作兼容说明。
- `X-Api-Request-Id` 必须是每请求唯一的 UUID。
- 成功响应可能带 `X-Tt-Logid`，应保存到脱敏诊断日志。
- V3 训练出的音色可用于声音复刻 1.0、2.0、豆包端到端实时语音模型等多个产品；V1 训练接口已停止迭代。

### 1.2 训练请求字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `speaker_id` | 是 | 预付费音色填控制台获得的 `S_xxx`；后付费固定填 `custom_speaker_id` |
| `custom_speaker_id` | 后付费必填 | 8–256 位，英文字母开头，仅字母数字、`-`、`_`，不能撞官方音色命名 |
| `audio` | 是 | 单个对象，不是 V1 的 `audios` 数组 |
| `audio.data` | 是 | 音频二进制字节的 base64 |
| `audio.format` | pcm/m4a 必填 | 支持 `wav`、`mp3`、`ogg`、`m4a`、`aac`、`pcm`；pcm 仅 24k 单通道；文件上限 10MB |
| `text` | 否 | 用于比对音频和文字；差异过大会返回 WER 错误 |
| `language` | 建议 | 0 中文、1 英文、2 日语、3 西班牙语、4 印尼语、5 葡萄牙语、6 德语、7 法语、8 韩语、9 意大利语、10 泰语、11 越南语、12 俄语、13 菲律宾语、14 马来语、15 阿拉伯语、16 墨西哥西班牙语、17 巴西葡萄牙语、19 波兰语、20 土耳其语、21 瑞典语（18 未定义，不提供） |
| `extra_params` | 否 | 必须使用 V3 字段名，见下表 |

常用 `extra_params`：

| 字段 | 说明 |
| --- | --- |
| `demo_text` | 试听文本，4–300 字；会计合成费，但不收槽位费 |
| `enable_audio_denoise` | 是否降噪；2.0 默认 `false` |
| `voice_clone_enable_mss` | 是否做音源分离，默认 `false` |
| `enable_crop_by_asr` | 按 ASR 定位截断，避免默认 25s 截断把单字切开 |
| `reject_min_snr_thresh` | 低于该信噪比拒绝复刻，默认 5 |
| `voice_clone_denoise_model_id` | 人声美化模型，默认空串即 `SpeechInpaintingV2` |

注意：V3 训练请求不传 `model_type`，也不能使用旧字段 `enable_mss`、`audio_asr_crop`、`audio_denoise_snr_thres`、`audio_check_snr_thres`。

### 1.3 状态、试听和计费

- `status`：0 NotFound、1 Training、2 Success、3 Failed、4 Active；2 或 4 可用于合成。
- 响应中的 `speaker_status[]` 可能包含多个模型版本；`model_type` 1/2/3 为声音复刻 1.0（ICL V1/DiT 标准/DiT 还原），4 为 ICL V2，5 为 ICL V3。试听下载不得按 `model_type` 白名单过滤。
- `demo_audio` 处于 Success 状态时返回，只有 1 小时有效；必须立即下载，并按真实响应格式保存，不能假定扩展名为 `.ogg`。
- 后付费音色在首次 V3 合成时转正并收取音色槽位费；试听 `demo_text` 本身只收合成费。
- 同一个 `custom_speaker_id` 转正后不能再复刻；删除并重新注册会再次计费。
- 复刻后 7 天未正式合成，供应商会自动删除音色并释放 ID。
- 自定义后付费 ID 仅支持在线 V3 合成，不支持异步长文本。

### 1.4 删除接口缺口

本份 V3 文档包含训练、状态查询、升级和合成接口，但没有给出删除音色的 HTTP 请求路径。因此 v1 不应调用猜测的远端删除接口：

- 应用内删除只保证本地样本、缓存和启用状态被清理；
- UI 必须提示“远端音色可能仍保留，需在火山控制台管理”；
- 等确认官方删除接口和计费/权限规则后，再补远端删除。

### 1.5 开通前置与资源校验（2026-10-30 实测）

- **控制台开通页**：<https://console.volcengine.com/speech/new/setting/activate?projectName=default>
- **必须开通**：「声音复刻2.0」（复刻字数额度）＋「音色槽位」（音色资源，转正计费项）。只开声音复刻2.0、没开音色槽位时，复刻类接口一律不可用。
- **未开通的表现**：`POST /api/v3/tts/voice_clone` 与 `POST /api/v3/tts/get_voice` 均返回 **HTTP 403**：
  `{"code":45000030,"message":"[resource_id=volc.megatts.timbre] requested resource not granted"}`。
  这是账号/项目级资源校验（不是 401，也和样本、参数、格式无关）。
- **实测记录**：2026-10-30 用有效 API Key 调 `get_voice`（随机 custom_speaker_id）拿到上述 403，
  `X-Tt-Logid=20261030163434A5C8566CEBDBA1EF8553`；同日控制台截图显示「声音复刻2.0 已开通（剩余 19,983/20000 字）、音色槽位 未开通」。
- **计费要点**：训练扣「声音复刻2.0」复刻字数；**首次正式合成即视为转正并收取「音色槽位」费**（官方文档原文）。
  因此不存在「免费把克隆音色接到 API 朗读」的路径；只在控制台试听可以不计槽位费。
- **查询能力边界**：`get_voice` 只能按已知 `speaker_id` 单查状态/试听：
  - 预付费/控制台音色：`{"speaker_id":"S_xxx"}`；
  - 后付费自建音色：`{"speaker_id":"custom_speaker_id","custom_speaker_id":"<自建ID>"}`。
  官方**没有**「列出本账号全部复刻音色」的接口，所以控制台体验页复刻的音色不会自动出现在应用列表里——
  要在应用里用，必须拿到该音色的 `S_xxx` ID 手动登记（应用目前只登记自己训练的 `umi_voice_*` 后付费音色）。

> 想让 OpenClaw 对话回复变成语音（精选音色 / 克隆音色两条通道、`/tts` 命令、各渠道形态、排查表）见
> [OPENCLAW-VOICE-GUIDE.md](./OPENCLAW-VOICE-GUIDE.md)。

## 二、首批下拉音色

机器可读清单位于 `resources/voice/curated-voices.v1.json`。筛选原则：优先通用/客服场景、中文自然、角色属性弱、适合桌面助手短提示；首批不放入 IP 角色、儿童音色和强角色扮演音色。

| 顺序 | 音色 | voice_type | 场景 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | Vivi 2.0 | `zh_female_vv_uranus_bigtts` | 通用场景 | 默认音色；多语种/多方言 |
| 2 | 小何 2.0 | `zh_female_xiaohe_uranus_bigtts` | 通用场景 | 中文女声 |
| 3 | 云舟 2.0 | `zh_male_m191_uranus_bigtts` | 通用场景 | 中文男声 |
| 4 | 小天 2.0 | `zh_male_taocheng_uranus_bigtts` | 通用场景 | 中文男声 |
| 5 | 刘飞 2.0 | `zh_male_liufei_uranus_bigtts` | 通用场景 | 中文男声 |
| 6 | 清新女声 2.0 | `zh_female_qingxinnvsheng_uranus_bigtts` | 通用场景 | 清晰女声 |
| 7 | 爽快思思 2.0 | `zh_female_shuangkuaisisi_uranus_bigtts` | 通用场景 | 明快女声 |
| 8 | 邻家女孩 2.0 | `zh_female_linjianvhai_uranus_bigtts` | 通用场景 | 亲和生活化 |
| 9 | 少年梓辛 2.0 | `zh_male_shaonianzixin_uranus_bigtts` | 通用场景 | 年轻男声 |
| 10 | 暖阳女声 2.0 | `zh_female_kefunvsheng_uranus_bigtts` | 客服场景 | 客服/提示音 |

## 三、仍需实测确认

1. 上述 10 个音色 ID 是否都能用当前 Agent Plan Key 和 `seed-tts-2.0` 返回音频。
2. 试听短句、默认音色与设置持久化是否一致。
3. 克隆训练响应是否确实返回试听音频，以及该音频的实际容器格式（不区分 `model_type`，凡返回 `demo_audio` 即落盘）。
4. 远端删除是否存在控制面接口；未确认前不进入 v1 代码。

