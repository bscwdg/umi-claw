# PROVENANCE · blue-whale-agent

- 上游：https://github.com/whiteball-shiro/blue-whale-agent
- 固定版本：`3a85cba8795efa52739f4b893b23bb578ef87d8a`（2026-09-04，提交信息 `feat: hermes cloud route runs in trusted skill workspace and preloads configured skill (-s)`）
- 拉取时间：2026-11-01（`git clone --depth 1`），本机完整备份：`D:\work2026\files\upstream-refs\blue-whale-agent`（1.3MB，含 `resources/main.js` 桌宠实现）
- 许可：**MIT**（见本目录 `LICENSE`）。分发时保留版权声明与许可全文。
- 内容性质：Electron 桌面宠物挂件 + 本地 qwen 模型委派（降低云端额度消耗）。

## 本目录收录（仅文本）

| 路径 | 用途 |
| --- | --- |
| `chat-workspace/AGENTS.md` | 桌宠人格 + 「本地委派优先」规则 + 委派前安全判别（C03、成本控制参考） |
| `chat-workspace/config.local.json.example`、`config.example.json` | 配置样例（本地模型/代理/工作区） |
| `docs/配置教程.md`、`docs/USAGE.md` | 安装与使用说明 |
| `README.md`、`LICENSE` | 说明与许可 |

## 未收录

- `resources/main.js`（153KB 桌宠主进程实现）、`resources/preload.js`、`resources/mcp.js`、`resources/renderer/**`、`assets/demo.gif`：留在本机备份；**桌宠透明窗口/拖拽/点击穿透可对照实现**，因 MIT 可直接借鉴（保留声明）。
- `chat-workspace/*.mjs|*.ps1`（本地 qwen 委派、GPU 启停脚本）：留在本机备份。

## 使用边界

- 「本地小模型分流」是**成本控制**的可借鉴范式（C07/§九 成本风险）：日常闲聊/摘要走本地或便宜模型，重要时刻才用贵模型——但这需要用户自备本地推理环境，**不作为 M1 默认依赖**，只作可选加速项。
- 桌宠实现参考：其窗口透明/置顶/拖拽/点击穿透与 Electron 版本相关，移植时以我们 4.0 的 `app://` 协议与 preload 边界为准。
