# PROVENANCE · dafeiyu-bot

- 上游：https://github.com/SAKURAfan1023/dafeiyu-bot
- 固定版本：`ff2bb2f0baf99e449b529f897e7db0d6561321de`（2026-10-28，提交信息 `Add shared social platforms and bounded automatic defaults`）
- 拉取时间：2026-11-01（`git clone --depth 1`），本机完整备份：`D:\work2026\files\upstream-refs\dafeiyu-bot`（约 78MB，含全部贴纸图片）
- 许可：**MIT**（代码/文档，见本目录 `LICENSE`）；**贴纸图片逐张不同**，以 manifest 的 `license` 字段为准（CC0-1.0 / CC-BY-NC-SA-4.0 / 大肥鱼项目署名许可 1.0）。
- 内容性质：Swift 实现的 QQ 机器人，含贴纸库、照片画廊、社交平台浏览代理与 QQ 容器部署。

## 本目录收录

| 路径 | 原路径 | 用途 |
| --- | --- | --- |
| `Resources/QQStickers/manifest.json` | 同 | **贴纸知识库母本**：`id/title/emotion/context/author/license/publicSharing` 逐条（4 张原创 + 33 张社区素材） |
| `Resources/QQStickers/WHALE-LICENSE.txt` | 同 | 贴纸素材的署名许可全文 |
| `Resources/PhotoStickers/manifest.json` | 同 | 88 张照片贴纸的 emotion/context/tags/许可/来源 |
| `Resources/PhotoStickers/licenses/SOURCES.txt` | 同 | 逐批来源与作者（ZipZipPipe / 1cyberlangke1 / MX1951；角色原作上善无形） |
| `Resources/PhotoStickers/licenses/CC-BY-NC-SA-4.0.txt`、`CC0-1.0.txt` | 同 | 许可全文 |
| `docs/SOCIAL_AGENT_TECHNICAL_PLAN.md`、`SOCIAL_PLATFORMS.md` | 同 | 社交浏览代理方案（只读、审批、限额）——M3 合规参考 |
| `docs/PHOTO_GALLERY.md`、`CASES.md`、`USER_GUIDE.md`、`COMMANDS.md` | 同 | 贴纸/画廊/指令的产品设计 |
| `docs/ARCHITECTURE.md`、`WINDOWS.md`、`UPGRADING.md`、`STORAGE.md`、`QUICKSTART.md`、`VALIDATION.md` | 同 | QQ 机器人架构与运维（C08 参考） |
| `README.md`、`AGENTS.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE` | 同 | 说明与许可 |

## 未收录

- `Resources/QQStickers/*.png|webp`、`Resources/PhotoStickers/*.png|webp|jpg`、`Resources/QQControl/logo.png`、`docs/assets/**`：**图片素材一律不复制进仓库**。
- `Sources/`、`Tests/`、`scripts/`、`deploy/`：Swift 代码与部署脚本，留在本机备份（MIT，可借鉴但需保留声明）。

## 使用边界

- `PhotoStickers/` 为 **CC BY-NC-SA 4.0 非商业**素材：**只能用户自己导入，不得进安装包或公开构建**。
- `QQStickers/` 中的 `context` 字段是「何时可用/何时禁用」的语义标注，**非常适合直接移植进我们的 `resources/character/emotions.v1.json`** 作为情绪→场景映射（文本可用，图片不用）。
- 产品内不出现第三方贴纸原图；若要支持用户导入，按 M2「用户素材包导入」流程做（本地目录 + 许可自证）。
