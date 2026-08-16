# Obsidian 知识库集成（RAG + MCP）实现方案

## 背景与目标

使用者建议：接入 Obsidian 笔记库 + 对接省 token 的模型。核心诉求是**低成本的个人知识库问答**。

判断：纯 skill（`SKILL.md` 指令型）撑不起完整功能——没有检索能力，要么全量灌笔记（巨费 token），要么瞎猜。完整功能需要一个**常驻检索引擎 + 向量索引**。

已确认前提：**OpenClaw 原生支持 MCP**（stdio + http、自动发现工具、`mcp__<server>__<tool>` 命名空间、凭据走 env）。因此主方案 = 写一个 Obsidian MCP server，挂到 `openclaw.json` 的 `mcp.servers.obsidian`，模型即可调用 `mcp__obsidian__search_notes` 等工具。

省 token 的真正杠杆 = **检索（只喂相关片段）+ prompt caching（项目已埋好字段，未启用）**，本方案聚焦"检索"这一半。

## 架构

```
claw-desktop (Electron 主进程)
├── ObsidianManager          配置 / 触发索引 / 状态查询
├── spawn 绿色 node → indexer.mjs   扫 vault、切块、调 embedding、写向量库
└── _syncOpenClawConfig 写入 mcp.servers.obsidian（command/args/env）

Obsidian MCP server (mcp-server.mjs，零依赖，OpenClaw 拉起的 stdio 子进程)
├── 自实现 MCP JSON-RPC over stdio
├── 读 sqlite 向量库做 cosine 检索（零网络）
├── 读写 vault markdown
└── 工具：search_notes / read_note / list_notes / create_note / update_note / get_backlinks / get_tags

向量库 (data/config/.openclaw/obsidian/index.db，sqlite)
├── files(path, mtime, hash)
└── chunks(id, file_path, heading_path, content, tags, embedding BLOB)
```

### 核心设计原则

1. **零原生依赖、纯 node 内置模块**：`mcp-server.mjs` 和 `indexer.mjs` 只用 `node:sqlite`/`fs`/`http`(fetch)，不引入 `@modelcontextprotocol/sdk`，避免 node_modules 解析与原生编译，保证便携。
2. **复用 dataDir 绿色 node**：跑 `node:sqlite`，避开 Electron 30 自带 Node 20 的版本限制——这是项目既定模式（见 `clawManager._markStartupMigrationsComplete` 已用此法操作 state 库）。
3. **职责分离**：主进程负责索引（含 embedding 调用，用户主动触发）；MCP server 只检索 + 读写笔记（零网络、快且稳）。
4. **api key 走 env**：不明文写进 `openclaw.json`，从已配置 provider 取。

## 模块清单与改动点

### 新增文件
| 文件 | 职责 |
|------|------|
| `electron/main/obsidian/obsidianManager.ts` | 配置读写、触发索引子进程、状态查询、testEmbedding |
| `electron/main/obsidian/indexer.mjs` | 子进程脚本：扫描/切块/解析 front matter+wikilink、调 embedding、增量写 sqlite、进度上报 stdout |
| `electron/main/obsidian/mcp-server.mjs` | stdio MCP server：JSON-RPC 自实现、cosine 检索、读写笔记 |
| `electron/main/obsidian/embeddings.ts` | embedding 调用封装 + 预设模型表 |
| `electron/main/obsidian/types.ts` | `ObsidianConfig` 接口、索引状态类型 |
| `src/views/ObsidianPage.vue` | 配置页：vault 路径 / embedding 源 / 索引状态 / 重建 |

### 修改文件
| 文件 | 改动 |
|------|------|
| `electron/main/openClawPaths.ts` | 加 `obsidianDir` / `obsidianMcpScript` / `obsidianIndexerScript` / `obsidianDb` 路径常量 |
| `electron/main/modelConfig.ts` | 加 embedding 模型预设（百炼 text-embedding-v3、智谱 embedding-3、硅基流动 bge-m3、OpenAI text-embedding-3-small） |
| `electron/main/configManager.ts` | `AppConfig` 加 `obsidian?: ObsidianConfig`；`_syncOpenClawConfig` 写 `mcp.servers.obsidian`（enabled 时） |
| `electron/main/index.ts` | 实例化 `ObsidianManager`；`registerIpcHandlers` 加 `obsidian:*` |
| `electron/preload/index.ts` | api 加 `obsidian: { getConfig, saveConfig, selectVault, getIndexStatus, rebuildIndex, testEmbedding }` |
| `src/renderer/main.ts` | 路由加 `/obsidian` |
| `src/App.vue` | `navItems` 加 `{ to:'/obsidian', icon:'📝', label:'知识库' }` |
| `electron-builder.json5` | 确保 `obsidian/*.mjs` 进包（extraResources 或 files） |

## IPC 设计

```ts
window.api.obsidian.getConfig()                 // 读 obsidian 配置
window.api.obsidian.saveConfig(cfg)              // 存（vaultPath/embeddingProviderId/embeddingModel/enabled）
window.api.obsidian.selectVault()                // 弹文件夹选择框，返回路径
window.api.obsidian.getIndexStatus()             // {noteCount, chunkCount, lastIndexedAt, dbSize, indexing}
window.api.obsidian.rebuildIndex()               // 触发 indexer 子进程
window.api.obsidian.onIndexProgress(cb)         // 进度（note 数/百分比）
window.api.obsidian.testEmbedding(cfg)          // 测 embedding 连通（调 /v1/embeddings）
```

## openclaw.json 写入形态

```jsonc
{
  "mcp": {
    "servers": {
      "obsidian": {
        "command": "<dataDir>/openclaw/node_modules/.bin/node 或 getNodePath()",
        "args": ["<app资源>/obsidian/mcp-server.mjs",
                 "--vault", "<vaultPath>",
                 "--db", "<obsidianDb>"],
        "env": {
          "EMBEDDING_API_KEY": "<从 provider 取>",
          "EMBEDDING_BASE_URL": "<provider.baseUrl>",
          "EMBEDDING_MODEL": "<model id>"
        }
      }
    }
  }
}
```
（MCP server 启动时即可用 env 里的 embedding 凭据——虽然主路径是检索预算好的向量，但保留以便 `rebuild_index` 工具按需重算。）

## MCP 工具定义

- `search_notes(query, limit=5)`：embedding query → cosine 检索 → 返回 `{file_path, heading_path, content, score}[]`
- `read_note(path)`：读单篇笔记全文
- `list_notes(folder?, tag?)`：列笔记（路径/标签过滤）
- `create_note(path, content, tags?)`：建笔记，自动加 front matter
- `update_note(path, content)`：更新
- `get_backlinks(path)`：解析 vault 内指向该笔记的 wikilink
- `get_tags()`：全库标签云

## 实现阶段

### 阶段 0：技术验证（先跑通，降风险）
- 写最小 `mcp-server.mjs`（只一个 `echo`/`read_note` 工具），手动写进 `openclaw.json` 的 `mcp.servers.obsidian`，启动 OpenClaw，确认工具出现在列表、模型能调用。
- 确认绿色 node 的 `node:sqlite` 可用（跑一段建表脚本）。
- 确认 `openclaw.json` 里 `mcp` 字段名/层级与 OpenClaw 实际 schema 一致（对照用户给的 yaml 示例推断为 `mcp.servers`）。

### 阶段 1：MVP 闭环
- `indexer.mjs`：全量扫描 + 切块 + embedding + 写库（先不做增量）。
- `mcp-server.mjs`：`search_notes` + `read_note` + `list_notes` + `create_note`。
- `ObsidianManager` + IPC + 配置页 + 路由 + 侧边栏。
- `_syncOpenClawConfig` 写 mcp 配置。
- 验收：配 vault → 填 embedding → 重建索引 → 在 OpenClaw 里问笔记内容，`mcp__obsidian__search_notes` 命中相关片段。

### 阶段 2：增量与状态
- 增量索引（按 mtime/内容 hash 只重算变动文件）。
- 索引状态可视化（条数/最后时间/库大小/进行中）。
- `testEmbedding` + 多 embedding 预设下拉。
- 重建进度事件。

### 阶段 3：增强与打磨
- `get_backlinks` / `get_tags` / `update_note`。
- 重建并发安全（WAL 或临时库 rename）。
- 切块策略优化（按标题层级、保留 front matter 元数据）。
- UI 打磨、错误提示、空态引导。

## 关键风险与对策

| 风险 | 对策 |
|------|------|
| 绿色 node 不支持 `node:sqlite` | 阶段0验证；若不行降级为二进制文件存 Float32Array + 内存暴力检索（几万条 cosine 仍毫秒级） |
| MCP JSON-RPC 自实现错（握手/schema） | 阶段0先用最小 server 验证 initialize/tools-list/tools-call 流程 |
| `openclaw.json` 的 mcp 字段格式不符 | 阶段0对照实际 schema；configManager 写入时只增不删，保留其他 mcp servers |
| embedding 维度不匹配（换模型后旧库失效） | 向量库记录 embedding 模型+维度，换模型时提示重建 |
| api key 安全 | 全程走 env，不落 openclaw.json 明文 |
| 切块太粗导致检索不准 | 阶段3按标题层级切，单块控制在 ~500 token |

## 不在本期范围
- prompt caching 的 UI 显性化（另立小任务，改动小，可单独做）
- Obsidian Local REST API 插件对接（进阶选项，本期用纯文件读写即可覆盖绝大多数需求）
