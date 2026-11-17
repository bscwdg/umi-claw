# 大肥鱼导入格式示例

这些文件是**示例/模板**，不是内置内容；导入前请按自己的真实设定修改。

| 文件 | 用在哪 | 导入后落到哪 |
| --- | --- | --- |
| `persona.example.json` | 角色页「人格」→ 导入人格包 | workspace 的 SOUL / IDENTITY / AGENTS / USER（覆盖前自动备份） |
| `knowledge-世界书.example.md` | 角色页「知识」→ 类别选「世界书」 | Obsidian `大肥鱼/世界书/` |
| `knowledge-角色卡.example.md` | 角色页「知识」→ 类别选「角色卡」 | Obsidian `大肥鱼/角色卡/` |
| `knowledge-关系约定.example.md` | 角色页「知识」→ 类别选「关系/约定」 | Obsidian `大肥鱼/关系/约定/` |
| `topics.example.json` | 角色页「主动消息语料」→ 导入话题 | 用户话题语料（同 id 覆盖内置） |
| `lines.example.json` | 角色页「主动消息语料」→ 导入台词 | 用户台词语料（按组追加去重） |
| `life-cards.example.json` | 「主动消息语料」→ 生活卡 Tab →「新增」逐张录入，或放进归档包 `proactive/life-cards.json` 导入 | 用户生活卡（同 id 覆盖内置） |
| `archive-knowledge-only/` | 角色页「大肥鱼归档」→ 导入归档（文件夹） | 只写 Obsidian 知识，不碰人格/语料/记忆 |

## 注意

- 知识类 `.md` 不要写 frontmatter；应用导入时会自动生成 `title/tags/source/created`。
- 人格包的 `AGENTS.md` 会被宿主规范化并追加边界硬段。
- 归档包 `archive-knowledge-only/` 是安全的「只导知识」试验包；`samples` 里的完整示例不会覆盖你的人格。
- 这些示例随安装包只读；不要直接改这里当自己的数据，复制出去改。
