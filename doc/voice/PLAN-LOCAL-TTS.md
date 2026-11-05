# 本地 TTS 一键部署设计（MOSS-TTS-Nano / Qwen3-TTS 评估）

> 状态：**设计草案，待评审**（2026-11-04）
> 性质：语音设置页新增「本地 TTS」能力的施工设计。评审通过后按本文件拆 WP，每个 WP 仍走 `AGENTS.md §12` 对抗审查。
> 关联：`PLAN-4.0.md §4.2`（插件不给窗口/进程控制）、`AGENTS.md §1`（四层能力表，语音属宿主）与 §2（目录归属 `electron/main/fish/voice/`）、`doc/voice/OPENCLAW-VOICE-GUIDE.md`
>
> **实施变更（2026-11-05）**：L0 spike 实测 CPU RTF 1.12–1.52、私有内存峰值 5.2 GB，
> 未达到 §11 门槛。因此当前实现**不做受管 MOSS 一键本机部署**，只落地「外部 TTS 实例 +
> `cloud/external/auto` 路由」。实现字段使用 `externalProviderId`，不是下文草案里的
> `localProviderId`；受管安装、权重下载与 supervisor 均为未实施范围。**下文正文保留
> 2026-11-04 原始草案，仅作历史设计参考，不再作为当前代码契约。**

---

## 1. 结论（先给答案）

| 模型 | 一期是否做 | 理由（2026-11-04 实测） |
| --- | --- | --- |
| **MOSS-TTS-Nano（ONNX CPU 版）** | **做** | 0.1B、权重仅 0.76 GB、官方主打 CPU、自带 FastAPI、代码与权重均 Apache-2.0、仓库 2026-09 仍活跃 |
| Qwen3-TTS 0.6B（官方 PyTorch 栈） | **不做** | 官方无 CPU 路径（README 全示例 `device_map="cuda:0"` + 推荐 flash-attn 2），GPU 上都有 RTF≈5 的慢反馈；仓库 2026-03 后停更 8 个月，transformers 5.x 兼容 issue 仍开。CPU 慢于实时的实测数字见下一行社区重写 |
| Qwen3-TTS 社区重写（GGUF/Rust/Vulkan） | **观察，二期再评估** | `HaujetZhao/Qwen3-TTS-GGUF`（MIT，193★）与 `cgisky1980/qwen3-tts-rust`（**无 license**，69★；CPU RTF 约 1.7/Vulkan 约 0.6，另有实测 CPU 约 1.3，均慢于实时）成熟度不足；接口契约设计时预留多 provider 位即可 |

**一期范围两件事**：
1. **受管实例**：语音设置页「本地语音（MOSS-TTS-Nano）」一键部署；应用内朗读（大肥鱼说话、到点提醒、试听）可路由到本地合成；参考音频零样本克隆。
2. **外部实例（可扩展性硬要求）**：用户在别处（本机/局域网/自有服务器）部署的 TTS，只要暴露兼容协议，在设置里填**服务地址 + 模型名 + 音色 + 可选 Key** 即可接入，无需我们安装任何东西。一期通用协议定为 **OpenAI Audio Speech 兼容**（`POST /v1/audio/speech`），依据见 §2.4——vLLM-Omni 已用这一个协议覆盖 MOSS/Qwen3/Kokoro/CosyVoice/Fish-Speech 等（适配器层约 28 个模型；speech_api 文档表列 14 个家族，Kokoro 等只在代码适配器层）。

**一期不做**（见 §4）：OpenClaw 对话内语音（`tts-local-cli`）通道、随安装包分发权重/运行时、Qwen3 受管安装、GPU 管理、为每个私有协议写专用适配器。

---

## 2. 现状事实（均带证据，施工时复核）

### 2.1 上游：MOSS-TTS-Nano

- 仓库 `OpenMOSS/MOSS-TTS-Nano`，4.6k★，Apache-2.0，默认分支 `main`，**无 tag/release**，必须 pin commit SHA。
- 权重（ModelScope 标注 license=apache-2.0，2026-11-04 查）：
  - `openmoss/MOSS-TTS-Nano-100M-ONNX`：13 个文件，**0.67 GB**
  - `openmoss/MOSS-Audio-Tokenizer-Nano-ONNX`：9 个文件，**0.09 GB**
- 输出 **48 kHz / 双声道 WAV**；零样本克隆：参考音频 + 文本；长文本自动分段（`voice_clone_max_text_tokens=75`）。
- 内置音色清单在仓库 `assets/demo.jsonl`（pin `8b7bcc9` 时 **29 行**）：每行只有 `name`/`role`（wav 路径）/`text`，**没有 demo_id**；`demo-1..demo-29` 是服务端 `app.py:98` 按行序加载时生成的。真实 `name` 如「🇨🇳 欢迎关注模思智能」「🇨🇳 深夜温柔晚安」「🇨🇳 台湾腔」「🇨🇳 京味胡同闲聊」「🇨🇳 中国人的时间观念与文化逻辑」。注意多语种行中有 10+ 行复用 `assets/audio/en_4.wav` 占位（不是该语种真录音），UI 不得按国旗宣称语种能力；一期内置音色名在安装后从 pinned 源码的 demo.jsonl 读取并缓存，不在我们代码里硬编码。
- 服务：`python app_onnx.py`（FastAPI，默认端口 **18083**，`--port` 可改）。
  - 健康：`GET /health`；预热：`GET /api/warmup-status`；归一化：`GET /api/text-normalization-status`
  - 合成：`POST /api/generate`，multipart：`text` +（`demo_id` 或 `prompt_audio` 文件）+ `enable_text_normalization` 等；
    返回 JSON `{ audio_base64, sample_rate, text_chunks, normalized_text, ... }`，音频为 WAV bytes。
  - 未 warmup 时 `/api/generate` 返回 500 + warmup 状态文案；首请求承担模型加载。
- 依赖（上游 `requirements.txt`）：`torch==2.7.0`、`torchaudio==2.7.0`、`transformers==4.57.1`、`onnxruntime>=1.20`、`fastapi/uvicorn/python-multipart`、`sentencepiece`、`soundfile`、`WeTextProcessing`（→ `pynini`）、numpy。

### 2.2 已确认的坑（施工必须正面处理）

1. **README 宣称 ONNX 推理「免 PyTorch」与现状不符**：`onnx_tts_runtime.py:12-13` 仍顶层 `import torch/torchaudio`，torch 实际只用于参考音频加载/重采样（`:446-451`）。上游 issue #99 要求 torch-free 的 PR 于 2026-10-31 被关未合并。**一期仍需安装 CPU 版 torch**。
2. **pynini 在 Windows 没有官方 wheel**（上游 issue #6/#14/#22，README 自己也让 Windows 用户找第三方 wheel）。绕行已验证可行：
   - 不装 `WeTextProcessing`，合成请求传 `enable_text_normalization=0`；
   - 保留 `enable_normalize_tts_text=1`，走 `tts_robust_normalizer_single_script.py`——该文件 **408 行只 import `re` 与 `unicodedata`，零三方依赖**。
3. **ONNX 内存有 6 GB 的用户报告**（issue #61）：官方回应与「启动线程数≠请求线程数导致缓存多份 runtime」有关；对策是**命令行固定 `--cpu-threads` 启动、请求 Form 传 `cpu_threads=0`**（复用启动 runtime），安装器不暴露线程设置。
4. torch 必须装 **CPU 版**：CUDA 版 wheel 的体积与磁盘占用是 GB 级，低配机得不偿失。Windows 上 PyPI 及国内镜像的默认 torch wheel 即 CPU 版，安装时锁定这些源，不引入任何 CUDA 下载源。
5. HuggingFace 在本机不可达（2026-11-04 实测 API 超时）；`github.com`/`codeload.github.com` 通（1–2 s）；ModelScope 通。**下载源顺序：ModelScope → HF 镜像（hf-mirror.com）→ HuggingFace**；代码包走 GitHub codeload。

### 2.3 本仓可复用的现成机制

- Provider 形态：`electron/main/fish/voice/providers/volcengineTts.ts`（`synthesize(request)` 返回 `{audio, usage}`，错误翻 `VOICE_ERROR_CODES`）。
- 长驻子进程托管：`electron/main/clawManager.ts`（spawn 归并、端口探活、探活代际防串台、退出码自愈、启动耗时统计、`subprocessRegistry`）。
- 下载器：`electron/main/downloadManager.ts`（便携 Node 双镜像、进度事件、hash 校验、解压）；语音运行时照此模式做独立安装器。
- 语音设置/密钥/缓存/预算：`electron/main/fish/voice/core/`（`settings.ts` 白名单清洗、`manager.ts` 路由、`cache.ts`、`budget.ts`）。
- IPC 信封：`fish:voice:*` 通道已在 `electron/main/fish/voice/ipc.ts` 注册，新增通道沿用同文件同信封。
- 宿主数据目录约定：现有 `join(configManager.getDataDir(), 'voice' | 'fish')`（`electron/main/index.ts:1501` 起）。
- OpenClaw 桥接：`electron/main/fish/voice/core/openclawTts.ts` 已有 `tts-local-cli` 通道设计；**但当前契约 `outputFormat: 'mp3'` 固定**，MOSS 出 WAV，二期要先验证网关侧支持的格式再接入。

### 2.4 通用外部协议事实：OpenAI Audio Speech（2026-11-04 查 vllm-project/vllm-omni）

- vLLM-Omni 用统一的 OpenAI 兼容 `POST /v1/audio/speech` 暴露全部 TTS（文档 `docs/serving/speech_api.md`，启动方式 `vllm serve <model> --omni --port 8091`），明确包含 **MOSS-TTS-Nano**（克隆必带 `ref_audio`）与 **Qwen3-TTS 0.6B/1.7B**。
- 请求 JSON：OpenAI 标准字段 `model` / `input` / `voice` / `response_format`（`wav`/`mp3`/`flac`/`pcm`/`opus`）；vLLM 扩展 `speed`、`language`、`instructions`、`task_type`、`ref_audio`（**HTTP URL / base64 data URL / file URI**）、`ref_text`、`stream`。
- 响应：完整音频二进制 + `Content-Type`（不是 JSON 包裹）；流式是 OpenAI `speech.audio.delta` SSE。
- 音色库：`GET/POST/DELETE /v1/audio/voices`，multipart 上传克隆音色，服务端持久化复用。
- 鉴权：标准 `Authorization: Bearer <key>`；本地裸跑 vLLM 时常以 `api_key="none"` 访问，故外部实例的 Key **可空**。
- 含义：用户自己用 vLLM-Omni 部署的 Qwen3（GPU 机器）、MOSS、Kokoro 等，以及任何其他自称 OpenAI-TTS 兼容的服务（含云端兼容网关），一个适配器全覆盖；这些服务能直接输出 **mp3**，二期 OpenClaw 对话通道也可复用外部实例。

---

## 3. 架构（宿主模块扩展，不碰插件边界）

语音是宿主能力（依据 `AGENTS.md §1` 四层能力表与 §2 目录归属，代码住 `electron/main/fish/voice/`；§5.3 讲的是「大肥鱼为什么不是插件」，不是本特性的依据），本地 TTS 不做插件。新增文件全部在 `electron/main/fish/voice/local/` 下，Manager 层保持纯逻辑、无 electron 依赖，可在纯 Node 验收里打真源码。

```
electron/main/fish/voice/local/
├── types.ts              # 安装状态机/进度/本地音色 类型
├── manifest.ts           # pinned 版本清单（commit SHA、模型文件清单+sha256、依赖版本）
├── installPlan.ts        # 纯逻辑：阶段规划/续装判定/状态迁移/磁盘预估
├── modelDownload.ts      # ModelScope/HF 镜像文件枚举下载（注入 fetch，可本地 server 验收）
├── runtimeBootstrap.ts   # uv.exe 引导下载 + 托管 Python 3.12 + venv + 依赖安装
├── sourceFetcher.ts      # codeload pinned-SHA zip 下载/校验/解压
├── supervisor.ts         # app_onnx.py 进程托管：spawn/探活/代际/退出处理/日志
├── localVoiceStore.ts    # 本地克隆音色（参考音频）登记，纯 JSON + 文件
├── installer.ts          # 串起上面：总状态机 + 进度事件 + 取消/重试/卸载
├── providerTypes.ts      # LocalTtsProvider 接口 / 能力位 / 音色引用（纯逻辑，无 electron）
├── providerRegistry.ts   # 按 kind 构造/校验适配器；未知 kind 拒绝；不支持的能力拒绝
├── availability.ts       # 外部实例可用性/失败冷却纯逻辑（可单测）
├── localSecretStore.ts   # 外部实例 Key 的独立加密存取（safeStorage；secrets.bin）
├── externalServiceStore.ts  # 用户自填外部实例 CRUD（JSON；绝不放 Key）
└── providers/
    ├── mossManaged.ts    # 受管 MOSS：supervisor 探活 + /api/generate 私有协议
    └── openaiSpeech.ts   # 外部实例通用适配器：OpenAI /v1/audio/speech（vLLM-Omni 等）
electron/main/fish/voice/core/
├── types.ts              # 扩 VoiceSettings（见 §7）
├── settings.ts           # 新字段白名单清洗
└── manager.ts            # speak 路由 cloud/local/auto；local 再按 providerId 分发
electron/main/fish/voice/ipc.ts             # 登记 fish:voice:local:* 通道（复用现有信封）
electron/main/index.ts                      # voice 初始化段装配 localTts（目录/store/supervisor/IPC）
electron/preload/index.ts                   # 暴露 local API + progress 订阅
src/views/voice/VoicePage.vue               # 新卡片 + 外部服务对话框 + 进度
resources/voice/local-tts-manifest.json     # 版本清单（数据文件，构建随包；不放第三方源码）
test/local-tts-*.accept.mjs                 # 见 §10（真机 smoke 用 .smoke.mjs 后缀，不注册）
```

### 3.1 数据目录（卸载可整体删除）

```
<dataDir>/voice/local-tts/
├── install-state.json          # 安装状态机快照（断点续装依据）
├── external-services.json      # 用户自填外部实例清单（无 Key；Key 只在 secrets.bin）
├── secrets.bin                 # 外部实例 Key：safeStorage 加密，独立于云端 key.bin
├── runtime/
│   ├── uv.exe                  # 约 20 MB，首阶段下载（GitHub astral-sh/uv release）
│   └── python/                 # uv 管理的 python-build-standalone 3.12（不进系统 PATH）
├── app/                        # 上游源码：pinned SHA zip 解压（约 60 MB）
│   └── MOSS-TTS-Nano-<sha>/
├── venv/                       # uv venv（CPU torch 等；约 1.5 GB）
├── models/                     # 两套 ONNX 权重（0.76 GB）
├── voices/                     # 用户本地克隆参考音频 <id>.wav + meta.json
└── logs/
    ├── server.log              # 服务 stdout/stderr 轮转
    └── install-<attempt>.log   # 各阶段安装日志
```

磁盘预算（一期，实测后回填）：约 **2.3–2.7 GB**；首装下载量约 **1.1–1.3 GB**（权重 0.76 + CPU torch wheel 约 0.2 + uv/python 约 0.1 + 其余）。

### 3.2 为什么用 uv，不用 conda/系统 Python

- 无需管理员权限、不污染用户环境、不要求用户预装任何东西（对标现有「便携 Node」做法）。
- uv 是单 exe（约 20 MB）；Python 走 `UV_PYTHON_INSTALL_MIRROR` 指向国内镜像或 github 直连（实测 github 通）。
- pip 依赖固定 **PEP 503 PyPI 镜像**（默认阿里云 `https://mirrors.aliyun.com/pypi/simple`，回落清华 `https://pypi.tuna.tsinghua.edu.cn/simple`，再回落官方）。**不能用 npmmirror**：那是 npm 镜像，`/simple/torch/` 返回 404（2026-11-04 实测），它只服务本仓 downloadManager 的 npm/node 用途。
- 必须设置 `UV_PYTHON_INSTALL_DIR=<dataDir>/voice/local-tts/runtime/python`：uv 默认把托管 Python 装进它自己的数据目录，不设它卸载时删不干净，违背「整目录可删」。

### 3.3 Provider 扩展模型（受管实例 + 外部实例，一期就做对）

核心约束：`VoiceManager` 只依赖 `LocalTtsProvider` 接口，**不知道后面是受管进程还是用户填的 URL**。以后加新协议（如 IndexTTS 私有 API）= 新增一个适配器文件 + registry 登记，不改路由、不改 UI 主流程。

```ts
// providerTypes.ts —— 纯逻辑，无 electron/fs 依赖（supervisor/文件操作注入）
export type LocalTtsKind = 'moss-managed' | 'openai-speech'

export interface LocalTtsCapabilities {
  cloning: boolean                              // 能否吃参考音频做零样本克隆
  formats: Array<'wav' | 'mp3'>                 // 一期只放开这两种（缓存 ID 正则只收 mp3|wav）
  voicesModel: 'presets' | 'string' | 'uploadable'  // 内置下拉/任意字符串/可上传
}

export interface LocalTtsSynthInput {
  text: string
  voice: LocalVoiceRef
  speedRatio?: number
  signal?: AbortSignal
}

export interface LocalTtsProvider {
  readonly id: string                 // 'managed:moss-nano' 或 'ext:<uuid>'
  readonly kind: LocalTtsKind
  readonly managed: boolean
  label: string
  capabilities(): LocalTtsCapabilities
  /** 设置页「测试连接」：轻量探活；不做合成（详见各适配器） */
  probe(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; detail?: string }>
  synthesize(input: LocalTtsSynthInput): Promise<{
    audio: Buffer
    mime: string
    usage?: Record<string, unknown>
  }>
}

// 音色引用与 provider 解耦：路由层只传引用，适配器决定怎么发
export type LocalVoiceRef =
  | { source: 'preset'; value: string }           // demo-1，或服务端预设名
  | { source: 'inline-ref'; sampleId: string; refText?: string }  // 每次请求带参考音频
  | { source: 'string'; value: string }           // 用户填的任意 voice 字符串
```

**两类实例**

| | 受管实例 `managed:moss-nano` | 外部实例 `ext:<uuid>` |
| --- | --- | --- |
| 来源 | 一键安装器装出来 | 用户在设置页手填 |
| 适配器 | `mossManaged.ts`（私有 `/api/generate`） | `openaiSpeech.ts`（OpenAI 兼容） |
| 生命周期 | supervisor 管进程/端口/预热 | 我们不启动、不守护，只发 HTTP |
| 地址 | 随机本地端口（仅 127.0.0.1） | baseUrl 任意：localhost/内网/公网 https |
| Key | 无 | 可空；有则存独立 `secrets.bin`（`localSecretStore.ts`，key 就是完整实例 id `ext:<uuid>` 本身、不再加前缀，杜绝 `ext:ext:…`），与云端 `voice/key.bin` 物理分文件 |
| 能力位 | cloning=true, formats=[wav] | cloning 按实例配置（vLLM Base 模型才有），formats 默认 [mp3,wav]，用 `response_format` 协商 |
| 音色 | demo-* 内置 + inline-ref（multipart 参考音频） | string 预设 / inline-ref（`ref_audio` base64 data URL）；`/v1/audio/voices` 上传列二期 |

`openaiSpeech.ts` 请求约定（一期）：`POST ${baseUrl}/audio/speech`（baseUrl 填 `http://host:port` 或带 `/v1` 都做归一化），JSON `{ model, input, voice, response_format, speed? }`；克隆时加 `{ ref_audio: 'data:audio/wav;base64,...', ref_text? }`；有 key 加 Bearer；响应按 `Content-Type` 收二进制，不是音频类型报 `VOICE_LOCAL_TTS_BAD_RESPONSE`。`probe` 用 `GET ${baseUrl}/models`（vLLM/OpenAI 通用），**probe 只更新设置页展示态**：404/405 视为「未知（服务可能没有该端点）」，失败不阻止保存，也不进失败冷却池，真实可用性以「试听」短合成（synth）为准。

`externalServiceStore.ts` 配置形状（`external-services.json`）：

```json
{
  "id": "ext:<uuid>",
  "label": "家里 GPU 上的 Qwen3-TTS",
  "kind": "openai-speech",
  "baseUrl": "http://192.168.1.20:8091/v1",
  "model": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  "voice": "Chelsie",
  "responseFormat": "mp3",
  "cloning": false,
  "createdAt": 0
}
```

`localSecretStore.ts` 不复用现有 `secretStore.ts`（后者 `SecretData` 写死 tts/clone 两槽、单文件 key.bin）：新建同形 safeStorage 加密文件，API 为 `get/set/delete(id)`；删除外部实例时同步删其 Key。

**失败冷却（`availability.ts`，纯内存不持久化）**：每个 `ext:<id>` 记 `{ consecutiveSynthFailures, cooldownUntil }`，**只由合成（synth）结果驱动，probe 不计数也不清零**——否则一个 `/audio/speech` 正常但不实现 `/models` 的服务（上文明确允许存在），用户点两次「测试连接」就会被错误冷却、auto 在从未试成的情况下绕开它；反过来 probe 成功也不应掩盖 synth 失败。synth 连续失败 ≥2 进入 30 s 冷却；冷却期 auto 直接回落云端（不发请求、不卡超时），local 直接报 `VOICE_LOCAL_TTS_UNREACHABLE`；下一次 synth 成功清零。进程重启即清空（宁可多试一次，也不持久化可能已恢复的「不可用」）。冷却参数走常量，不进设置页。

安全边界：外部地址是用户主动填写（桌面应用不存在 SSRF 攻击面），但①baseUrl 只接受 `http://`/`https://`，禁其他任何协议；②**火山云 Key 与外部实例物理隔离（不同加密文件）**，外部请求只带该实例自己的 Key，绝不复用任何已存云端密钥；③UI 明示「合成文本/参考音频将发往该地址」。

---

## 4. 一期范围与非目标

**一期做**
1. 语音设置页「本地语音」卡片：一键安装（分阶段进度 + 日志）、启动/停止、重装、卸载。
2. **外部实例接入**：设置页添加/编辑/删除 OpenAI 兼容服务（baseUrl/model/voice/格式/可选 Key/克隆开关），「测试连接」与「试听」，可添加多个。
3. 应用内朗读路由（`autoSpeak` 与手动试听）：`云端（火山）/ 本地（指定实例）/ 自动`；`自动` = 选定实例可用走本地，不可用回落云端并记录原因。
4. 本地音色：受管实例的内置音色（安装后从 pinned demo.jsonl 读取真实 `name`，见 §2.1）+ 参考音频零样本克隆（仅本机，不训练）；外部实例用其预设 voice 字符串，声明支持克隆时可内联带 `ref_audio`。
5. 格式协商：受管实例 WAV（48k 双声道；渲染端 `new Audio(Blob URL)` 原生解码，见 `src/App.vue:378`、`src/views/voice/VoicePage.vue:984`，缓存 ID 正则已收 .wav）；外部实例默认 mp3、可配 wav。一期两种，不放 flac/opus/pcm。
6. 纯逻辑全套 accept 断言 + 一个默认跳过的真机 smoke（检测到 runtime 才跑）。

**一期不做（明确划线）**
- **OpenClaw 对话内语音本地通道**：网关 `tts-local-cli` 契约当前固定 mp3，WAV 转 mp3 需要 ffmpeg（本仓现无 ffmpeg 分发）。二期先验证网关是否吃 wav，再决定引入 ffmpeg-static 还是扩展桥接。
- 受管 MOSS 之外的其他模型的一键安装（外部协议已能覆盖用户自部署场景；Qwen3 受管安装等其 CPU/上游状态成熟）。
- 外部实例的服务端音色上传管理（`/v1/audio/voices` 的 POST/DELETE UI）；一期只用预设 voice 与内联 `ref_audio`。
- 随安装包分发 Python/torch/权重：包体与更新成本不可接受；首装下载，下载源多镜像。
- 本地 TTS 的用量统计与计费（字符/次数/失败展示）一期不做：`budget.ts` 维持只管云端字符；二期再加本地统计页，不在一期偷埋无设计的数据。
- GPU/CUDA、声码器替换、torch-free 补丁、Qwen3 的受管安装（用户用 vLLM-Omni 自部署的 Qwen3 走外部实例即可接入，见 §2.4）。
- 本地音色与火山克隆音色的互导。

---

## 5. 一键安装器设计

### 5.1 状态机

```
not-installed
  → installing(阶段见下, percent, 可取消)
  → ready              # 装完，服务未启动
  → starting → warming → running
running → stopping → ready
任意阶段 → error(阶段, 可修复动作) → installing(从失败阶段续装)
ready/running → uninstalling → not-installed
```

安装阶段（每阶段幂等、可单独重试，成功后落 `install-state.json`）：

1. `preflight`：磁盘剩余 ≥ 3.5 GB、可用内存、架构 x64、非必须管理员。
2. `runtime`：下 `uv.exe`（版本 pin + sha256），`uv python install 3.12`（managed）。
3. `source`：GitHub codeload 下载 `main` 的 **pinned commit** zip → sha256 校验 → 解压到 `app/`。
4. `venv`：`uv venv` + 安装锁定依赖（剔除 `WeTextProcessing`；CPU torch）。
5. `models`：按清单从 ModelScope 逐文件下载两套 ONNX 权重 → sha256 校验；按文件断点续传，一期不做分片。
6. `verify`：`uv run python -c` 导入冒烟（onnxruntime/numpy/sentencepiece/fastapi + 触发一次 `ort_cpu_runtime` import）。
7. `warmup`：拉起服务 → 轮询 `/health` 与 `/api/warmup-status` 直到 ready（服务启动时 WarmupManager 已自动预热，我们不额外发合成请求白烧 CPU）→ 保活或停服务。

进度事件复用语音现有渲染端推送模式（`mainWindow.webContents.send`），通道名 `fish:voice:local:progress`。

### 5.2 版本清单 `resources/voice/local-tts-manifest.json`

```json
{
  "schema": 1,
  "provider": "moss-tts-nano-onnx",
  "upstream": {
    "repo": "OpenMOSS/MOSS-TTS-Nano",
    "commit": "<pinned sha>",
    "zipSha256": "...",
    "entry": "app_onnx.py"
  },
  "uv": { "version": "x.y.z", "windowsX64": { "url": "...", "sha256": "..." } },
  "python": "3.12",
  "pipIndex": ["https://mirrors.aliyun.com/pypi/simple", "https://pypi.tuna.tsinghua.edu.cn/simple", "https://pypi.org/simple"],
  "pip": ["numpy>=1.24", "torch==2.7.0"],
  "pipSkip": ["WeTextProcessing"],
  "models": [
    { "repo": "openmoss/MOSS-TTS-Nano-100M-ONNX", "files": [{ "path": "...", "sha256": "...", "size": 123 }] },
    { "repo": "openmoss/MOSS-Audio-Tokenizer-Nano-ONNX", "files": [] }
  ]
}
```

清单升级 = 换 manifest + 走「更新」流程（按 sha256 差量重下）。

### 5.3 服务托管（supervisor）

- 仿 `clawManager`：start() 可重入归并；动态选空闲端口（先 `listen(0)` 取端口再释放）；命令行固定 `--cpu-threads <物理核四分之一，上限 4>`（上游启动参数是连字符；HTTP Form 字段才是下划线 `cpu_threads`），规避 issue #61 的多 runtime 内存放大。
- 绑定地址：`app_onnx.py` 原生提供 `--host`（默认 localhost）/`--port`/`--cpu-threads`，启动显式传 `--host 127.0.0.1 --port <随机> --cpu-threads <n>` 即可，**不需要 launcher、不改上游源码**。
- 探活：轮询 `GET /health` + `/api/warmup-status`，带代际；进程退出记 exit code，连续 2 次异常退出进入 `error`，不无限重启（TTS 崩了应安静降级到云端，区别于网关自愈）。
- 合成请求侧：未 ready 时排队短等（默认 30 s），超时回落或报 `VOICE_LOCAL_TTS_WARMING`。
- 退出：进程注册进现有 `subprocessRegistry`，宿主退出时杀子进程树（Windows `taskkill /PID <pid> /T /F` 包一层；不挂 `abortRegistry`——那是插件后台任务中止用的，见 `services/abortRegistry.ts`）。
- 日志：`server.log` 按 5 MB 轮转保留 3 份；安装日志每次 attempt 一份，失败时 UI 给「打开日志目录」。

### 5.4 受管适配器（`providers/mossManaged.ts`）

- `synthesize({ text, voice })`（实现 §3.3 的 `LocalTtsProvider`）：
  - `voice = preset:demo-<n>` → 带 `demo_id` 字段；`voice = inline-ref:<sampleId>` → multipart 附 `voices/<id>.wav` 为 `prompt_audio`。
  - 固定传 `enable_text_normalization=0`（无 pynini）、`enable_normalize_tts_text=1`、`cpu_threads=0`（复用启动 runtime）。
  - 长文本一期单请求交给上游内部分段；二期再评估客户端预分段与流式。
  - 解析 `audio_base64` → WAV Buffer；返回对齐现有 provider 形状 `{ audio, mime: 'audio/wav', usage: { chars, chunks } }`。
  - 错误映射：HTTP/JSON 错误 → `VOICE_LOCAL_TTS_*`（见 §8）；500 且 warmup 未就绪 → warming 语义。
- `probe()` = supervisor 状态 + `/health`；不发合成请求。
- 取消：`AbortController` 沿用 manager 现有 jobId 机制；服务端不支持断请求取消时，客户端丢弃结果即可。

---

## 6. 路由与音色

- `VoiceManager.speak` 增加两级路由（纯函数 `resolveSpeakTarget(settings, instanceResolver)`，可单测）：
  - 第一级 cloud/local/auto：`cloud` 现状火山（也是「关闭本地」的开关，不再单设 enabled 字段）；`local` 只走选定实例，实例缺失/被删/冷却中**直接报错不偷偷回落**；`auto` 实例可用 → 本地，否则 → 云端。
  - 第二级 providerId：`localProviderId` 指向 `managed:moss-nano` 或任一 `ext:<uuid>`，由 `providerRegistry` 取适配器；auto 回落云端时结果标注 `route` 与原因，UI 可见。
  - 外部实例无「进程状态」，可用性只看 synth 失败冷却池（§3.3）；probe 仅设置页展示态，不参与路由。
- 本地克隆音色：`localVoiceStore` 记录 `{ id, providerId, displayName, wavPath, durationMs, createdAt, sampleSha }`；
  - 参考音频按 **providerId 归属**：受管音色 multipart 上传本机服务；外部 openai-speech 音色以 base64 data URL 内联发送；在不支持克隆（`capabilities.cloning=false`）的实例上选择克隆音色要被拒绝并提示。
  - 上传本地校验时长（建议 10–30 s）；容器一期限定 **wav**（torchaudio/各服务兼容性，spike 后再放开）。
  - id 与火山 speaker id 命名空间隔离：`local:<uuid>`；删除外部实例时其名下音色一并标记失效（不静默换音色说话）。
- 缓存：`cache.ts` 按「文本+providerId+音色+语速」缓存，mime 区分 wav/mp3；本地结果同样缓存（省 CPU/省请求）。

---

## 7. 设置项、IPC、UI

### 7.1 `VoiceSettings` 新增字段（`core/types.ts` + `settings.ts` 白名单）

| 字段 | 取值 | 默认 |
| --- | --- | --- |
| `speakRoute` | `'cloud' \| 'local' \| 'auto'` | `'cloud'`（保证升级前后行为不变；cloud 即本地关闭，故不单设 enabled 字段） |
| `localProviderId` | string（`managed:moss-nano` / `ext:<uuid>`） | `'managed:moss-nano'` |
| `localVoiceId` | string（`preset:demo-1` / `local:<uuid>` / 裸 voice 名） | `'preset:demo-1'` |

受管安装状态与外部实例清单**不入 VoiceSettings**（机器状态/连接配置不是用户偏好）：走独立 IPC 与 JSON 文件；VoiceSettings 只存「选谁」。

### 7.2 新增 IPC（`fish:voice:local:*`，同信封 `{ok,data|error}`）

`status` / `install` / `installCancel` / `start` / `stop` / `uninstall` / `test`（试听）/
`voices:list` / `voices:add`（选文件→复制进 voices/）/ `voices:remove` /
`external:list` / `external:save` / `external:remove` / `external:probe`（GET /models 轻探活）/
`logPath`（用 shell.openPath 打开目录，不回传日志内容）。
进度不走轮询：`fish:voice:local:progress` 主进程主动推送。

### 7.3 `VoicePage.vue`

在现有「对话内语音」卡片下方加「本地语音（离线）」卡片：
- 未安装：主按钮「一键安装 MOSS-TTS-Nano（约下载 1.3 GB / 占用 2.5 GB）」+ 阶段进度条与当前步骤文案 + 取消；
- 已安装：服务开关、状态灯（运行中/预热中/已停止/异常）、路由三选（云端/本地/自动）、**实例下拉（受管 MOSS + 用户添加的外部服务，带「添加外部服务…」）**、当前实例的音色选择（受管=内置中文名；外部=voice 字符串，按能力开放克隆上传）、试听按钮、RTF 与内存（受管显示最近 5 次均值）、重装/卸载（`ConfirmDialog` 二次确认，禁止 window.confirm）。
- 「添加外部服务」对话框：名称、服务地址（占位 `http://192.168.x.x:8091/v1`）、模型名、音色、响应格式、API Key（可空，密码框）、「该服务支持声音克隆」开关；保存前可「测试连接」，保存后可「试听」；删除实例二次确认并提示其音色将失效。

---

## 8. 错误码（`core/errors.ts` 扩充）

`VOICE_LOCAL_TTS_NOT_INSTALLED`、`VOICE_LOCAL_TTS_INSTALL_FAILED`（details 带阶段）、`VOICE_LOCAL_TTS_WARMING`、
`VOICE_LOCAL_TTS_START_FAILED`、`VOICE_LOCAL_TTS_CRASHED`、`VOICE_LOCAL_TTS_SYNTH_FAILED`、
`VOICE_LOCAL_TTS_DISK_FULL`、`VOICE_LOCAL_TTS_DOWNLOAD_FAILED`（带源，可重试下一源）、
`VOICE_LOCAL_TTS_UNREACHABLE`（外部地址连不上/超时）、`VOICE_LOCAL_TTS_AUTH_ERROR`（外部 401/403）、
`VOICE_LOCAL_TTS_UPSTREAM_ERROR`（外部 4xx/5xx，details 带状态码）、`VOICE_LOCAL_TTS_BAD_RESPONSE`（响应不是声明的音频）、
`VOICE_LOCAL_TTS_CAPABILITY`（该实例不支持克隆/格式等被请求的能力）。
渲染端只按 code 分支（`AGENTS.md §4.2`），不碰 message 文本。
---

## 9. 隐私与安全

- 受管实例：参考音频与合成请求全部在 `127.0.0.1` 完成，**不出网**；只有「安装/更新模型」发网络请求（GitHub、ModelScope、PyPI 镜像），UI 明确列出域名。服务无鉴权但仅监听随机端口的 localhost，不接受局域网连接。
- **外部实例：流量去向由用户填写的地址决定**（本机/内网/公网都允许）。添加对话框必须明示「合成文本与参考音频将发送至 <baseUrl>，请确认该服务可信」；外部实例的 Key 只存独立的 `secrets.bin`（`localSecretStore.ts`，safeStorage 加密），与火山云 `key.bin` 物理分文件，任何外部请求都不带云端 Key。
- 卸载删除整个 `voice/local-tts/`（含参考音频）；不动云端密钥。
- 权重/代码均 Apache-2.0，安装页标注上游出处与许可证；`LICENSE`/`NOTICE` 随解压源码目录保留。

---

## 10. 验收计划（先写断言，再写实现；`AGENTS.md §7`）

新增 `test/local-tts-*.accept.mjs` 并注册进 `scripts/run-all-accept.mjs`（`AGENTS.md §7.1` 硬规则），零 npm 依赖、打真源码：

1. `local-tts-install-plan.accept.mjs`：状态机全迁移、非法迁移拒绝、失败阶段续装判定、磁盘预估、manifest 校验（缺 sha256 拒绝）。
2. `local-tts-download.accept.mjs`：Node 起本地 HTTP server 伪造 ModelScope 文件清单，断言多源回退、校验失败重试、已存在文件跳过。
3. `local-tts-supervisor.accept.mjs`：用 node 脚本伪装 `app_onnx.py`（提供 /health）打真 spawn，断言探活、代际丢弃旧探针、退出码处理、stop 杀进程树、命令行固定 `--cpu-threads`/`--host 127.0.0.1`/`--port`。
4. `local-tts-client.accept.mjs`：本地 server 伪造 `/api/generate`，断言 multipart 字段（demo_id/prompt_audio/归一化开关）、base64 WAV 解析、错误码映射、取消。
5. `local-tts-openai-speech.accept.mjs`：本地 server 伪造 OpenAI 端点，断言 URL 归一化（带/不带 /v1）、请求 JSON（model/input/voice/response_format/speed/ref_audio data URL）、Bearer 头（有/无 Key）、二进制音频响应按 Content-Type 解析、401/429/5xx/非音频体 → 错误码映射、probe 对 `GET /models` 缺失的容忍、取消。
6. `local-tts-registry.accept.mjs`：kind 分发、未知 kind 拒绝、`capabilities.cloning=false` 时 inline-ref 请求被拒、外部实例失败冷却。
7. `local-tts-external-store.accept.mjs`：外部实例增改删、损坏 JSON 回落、**断言 Key 不出现在 JSON 落盘内容里**、删除实例后其音色失效；同套覆盖 `localSecretStore`（注入假 safeStorage：get/set/delete、密文不落明文、删实例连带删 Key、损坏 secrets.bin 回落不崩）。
8. `local-tts-voice-store.accept.mjs`：音色增删、按 providerId 归属、id 命名空间、损坏 meta 回落。
9. `local-tts-route.accept.mjs`：两级路由矩阵（cloud/local/auto × 受管各状态 × 外部可用/失败/缺失）；settings 清洗（非法值回落、老配置无字段时默认 cloud + managed 实例）。
10. 真机 smoke 文件命名 `test/local-tts.smoke.mjs`（**刻意不用 `.accept.mjs` 后缀**：`AGENTS.md §7.1` 规定 `.accept.mjs` 必须注册进 ACCEPT，真机 smoke 不具备零依赖必跑条件，故在命名上避开该 glob），不进 ACCEPT 数组、不进 33 套必过链路；仅检测到完整安装或 `UMI_ACCEPT_LOCAL_TTS=1` 时手动/CI 可选执行：装 → warmup → 一句中文合成 → 断言 WAV 头/时长/RTF 落档；可选对本地 vLLM-Omni 容器验证 openai-speech 适配器。

双 typecheck、`check:boundary` 照常（新文件在宿主侧；要断言插件没有反向依赖本地 TTS 的值导出）。

---

## 11. Go/No-Go：动工前先跑 spike（半天内出结论）

在本机手工完成一次最小安装并记录真实数字，任一硬门槛不过则一期暂缓：

| 门槛 | 目标 |
| --- | --- |
| 纯 CPU RTF（中文 50 字，线程上限 4） | **≤ 1.0**（至少等于实时），目标 ≤ 0.6 |
| 服务内存峰值 | **≤ 4 GB**（issue #61 有 6 GB 报告，必须实测规避效果） |
| warmup 到首次可合成 | ≤ 30 s；之后单句首包 ≤ 3 s |
| 磁盘占用 | ≤ 2.7 GB；首装下载 ≤ 1.4 GB |
| 断网合成 | 通过（安装完成后全程无网） |
| robust normalizer 中文质量 | 数字/日期/符号试听可接受（与 WeTextProcessing 的差距有主观记录） |
| Windows 10/11 干净环境 | uv + 3.12 + CPU torch 全流程无手工补救 |
| OpenAI 适配器（不依赖真机安装） | 本地伪造 server 全套断言通过；真实 vLLM-Omni 验证列为可选 |

spike 产物：实测记录追加到本文件 §12，作为 L2 开工的输入。

## 12. Spike 实测记录

（待填）

---

## 13. 工作包拆解（评审后细化为 PROGRESS 条目）

- **L1（纯逻辑先行）**：providerTypes/providerRegistry/availability（冷却）/installPlan/route 决策 + openaiSpeech 适配器（无进程，只打本地伪造 server）+ §10 之 1、5、6、9 断言，全绿。扩展点这一批定型，后面不改接口。
- **L2（安装器）**：runtimeBootstrap/sourceFetcher/modelDownload + 真安装（手动），§10 之 2；spike 门槛在此回填。
- **L3（服务与合成）**：supervisor + mossManaged 适配器 + externalServiceStore + localSecretStore 接进 VoiceManager，`ipc.ts`/`index.ts`/`preload` 装配 + §10 之 3、4、7、8；设置页试听打通（受管与外部实例都能试），先不接全量朗读路由。
- **L4（UI 与音色）**：安装卡片、外部服务对话框、进度推送、克隆音色、卸载/重装、两级路由全量切换；真机 smoke。
- **L5（二期候选，不在本期承诺）**：OpenClaw 对话内本地通道（格式/ffmpeg 决策）、torch-free 瘦身（跟踪上游 #99 类 PR 或自带音频加载补丁，预计省约 1 GB）、Qwen3-GGUF 预研。

每个 L 包收尾按 `AGENTS.md §12.2` 派两次互不可见的子代理检查（事实核对 + 对抗复核），结论入 `doc/PROGRESS-4.0.md`。

---

## 14. 风险清单

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| CPU RTF > 1，体验不如云端 | 功能白做 | §11 硬门槛先验；auto 路由永远允许回落 |
| ONNX 内存放大（#61） | 低配机卡死 | 固定线程启动 + 安装页展示实测内存 + 一键停用 |
| torch wheel 下载大/镜像漂移 | 安装失败率高 | manifest pin 版本+sha256；3 个 PEP503 pip 源顺序回落；失败可从阶段续装 |
| 上游 main 无 tag、变更漂移 | 行为不可控 | pin commit SHA + zip sha256；升级走 manifest 评审 |
| robust normalizer 中文归一化不够 | 数字/儿化读音瑕疵 | spike 主观评估；二期评估自带 pynini wheel 的高级选项 |
| 杀软误报 python/torch 子进程 | 启动失败 | UI 与日志明确指引；不做签名外承诺 |
| 参考音频格式（torchaudio 后端） | 克隆上传失败 | 一期限 wav，错误信息明确 |
| 模型文件清单变化 | 下载失败 | manifest 锁文件列表+hash；清单与 commit 同批更新 |
| 外部服务协议方言不标准（字段/错误格式各异） | 接不上或误报错 | 只承诺 OpenAI Audio Speech 兼容面；非音频响应与未知 4xx 明确报「服务不兼容」，不做隐式兼容补丁；真实兼容性以「测试连接+试听」为准 |
| 用户把云端 Key 误填进外部服务、或地址不可信 | 密钥外泄 | Key 只进独立 secrets.bin、按实例隔离、绝不复用云 Key；添加对话框明示流量去向；文档提示自担风险 |
| 外部实例不可用拖慢朗读（auto 模式） | 说话卡顿 | 失败冷却 + 短超时 + auto 快速回落云端；`local` 模式不回落、直接报错（行为可预期） |
