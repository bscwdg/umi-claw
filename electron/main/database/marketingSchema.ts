// schema.ts —— Umi Claw 2.0 第一版 Schema（user_version = 1）
//
// 逐字取自 PLAN-2.0.md §四「第一版 Schema（10 张业务表 + 1 张元数据表）」。
// 唯一偏离：**建表语句顺序**按外键依赖重排（contents 引用 hot_topics，故 hot_* 三表
// 先于 contents 建；DDL 文本本身未改动），避免依赖 SQLite 的延迟外键解析。
//
// v1.14 结论 A：`project_messages` 已作废（对话历史由 OpenClaw sticky user 会话承载），
// 本 Schema **不建**该表，业务表就是 10 张。

/** Schema 版本号（PRAGMA user_version） */
// v2：contents 增 content_type（post/shooting_script）；DDL 见 migration.ts（CREATE TABLE 保持 v1 形状）
export const SCHEMA_VERSION = 2

/** 表清单（与 schema.ts 的 DDL、db-worker.mjs 的 TABLES 白名单一一对应） */
export const SCHEMA_TABLES = [
  'projects',
  'businesses',
  'knowledge_items',
  'knowledge_chunks',
  'hot_topics',
  'hot_topic_samples',
  'project_hot_topics',
  'project_watchlist',
  'contents',
  'content_versions',
  'app_meta'
] as const

/** 建表语句（顺序 = 外键依赖顺序） */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT,
    description TEXT, status TEXT DEFAULT 'active',
    conversation_key TEXT NOT NULL,          -- 创建时生成的 uuid；OpenClaw 会话隔离 user=conv:<projectId>:<此值>
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE businesses (                    -- 与 project 1:1；多门店/多品牌二期再拆
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
    name TEXT, brand TEXT, city TEXT, address TEXT, phone TEXT,
    positioning TEXT, target_customer TEXT, tone TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
)`,
  `CREATE TABLE knowledge_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,                      -- v1.6：text/markdown/url/faq/docx/xlsx/pdf/image；文字层本地解析，扫描件走 AI 兜底
    source_path TEXT, source_name TEXT, content TEXT,
    status TEXT DEFAULT 'ready',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, source_path)         -- v1.10：手输 text/faq 的 path 为 NULL（NULL 互不冲突）；文件/URL 重导入按此键 upsert，天然防同份文件重复
)`,
  `CREATE TABLE knowledge_chunks (   -- 预留 RAG，二期向 resources/obsidian 切块对齐；第一阶段仅 LIKE 检索
    id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL, content TEXT NOT NULL, metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
)`,
  // v1.8 热点中心三表：热点是全局数据（无 project_id），相关性是 Project × 发布平台数据
  `CREATE TABLE hot_topics (                     -- 全局热点，抓一次所有 Project 共享
    id TEXT PRIMARY KEY,
    source_platform TEXT NOT NULL,           -- 来源平台（榜单出处：douyin/weibo/bilibili…），与 contents.platform（发布平台）区分
    source TEXT NOT NULL,                    -- 聚合源标识，仅用于追溯/排障，不参与热点身份与去重
    origin TEXT NOT NULL DEFAULT 'board',    -- v1.12：来源类别 board=榜单 / calendar=节点日历 / watch=关注词（一期只产前两者，watch 为 2.1 预留）
    title TEXT NOT NULL,
    url TEXT,
    fingerprint TEXT NOT NULL,               -- 去重指纹 = source_platform + 标题归一化（仅同源内去重）
    heat REAL,                               -- 最新热度（历史在 samples 表）
    rank INTEGER,                            -- 最新榜单名次
    lifecycle TEXT,                          -- new/rising/breaking/peak/long_tail，由采样序列计算
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    UNIQUE(source_platform, fingerprint)     -- v1.9：跨平台同事件不物理合并（各平台各一行，二期再做 cluster 聚合）
)`,
  `CREATE TABLE hot_topic_samples (             -- 时间序列：趋势/生命周期判定至少需 2-3 次采样
    id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
    sampled_at INTEGER NOT NULL, heat REAL, rank INTEGER,
    FOREIGN KEY(topic_id) REFERENCES hot_topics(id) ON DELETE CASCADE
)`,
  `CREATE TABLE project_hot_topics (            -- 按 Project × 发布平台的 AI 懒评分缓存（同热点两平台各一行，不重复花钱）
    project_id TEXT NOT NULL, topic_id TEXT NOT NULL,
    platform TEXT NOT NULL,                  -- 发布平台：xiaohongshu / douyin
    match_score INTEGER,                     -- 商家相关度 0-100
    platform_fit INTEGER,                    -- 该发布平台的适配度 0-100
    reason TEXT, content_angle TEXT, lifecycle_advice TEXT,
    scored_at INTEGER NOT NULL,              -- v1.9：24h TTL，期内不重评；表结构就此封板，不再加列
    PRIMARY KEY(project_id, topic_id, platform),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(topic_id) REFERENCES hot_topics(id) ON DELETE CASCADE
)`,
  `CREATE TABLE project_watchlist (  -- v1.12：老板关注的行业词；只喂 AI 评分/生成上下文，不触发任何采集
    project_id TEXT NOT NULL, keyword TEXT NOT NULL,
    type TEXT,                               -- industry / product / audience / region
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, keyword),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
)`,
  `CREATE TABLE contents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    title TEXT, platform TEXT,               -- platform = 发布平台：xiaohongshu / douyin
    topic TEXT,                              -- 选题/主题文案（人工填写或 AI 生成，与热点溯源分开）
    source_topic_id TEXT,                    -- v1.10：来源于热点雷达时溯源 hot_topics.id；热点清理时 SET NULL，不带走内容
    content TEXT,
    status TEXT DEFAULT 'draft',             -- draft/review/approved/published/archived
    published_at INTEGER,                    -- v1.13：发布标记；复用 status='published'，不另设布尔列（避免两个真相来源）
    effect_note TEXT,                        -- v1.13：老板手填效果备注（不错/一般/没动静），三期 Learning 的结果标签
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(source_topic_id) REFERENCES hot_topics(id) ON DELETE SET NULL
)`,
  `CREATE TABLE content_versions (   -- Learning 地基：source=ai 必须带 prompt 快照；source=user 的 prompt 为 NULL
    id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
    version INTEGER NOT NULL, content TEXT NOT NULL, source TEXT,
    prompt TEXT,                             -- source=ai：本次 Context Pack 快照；source=user：NULL
    created_at INTEGER NOT NULL,
    FOREIGN KEY(content_id) REFERENCES contents(id) ON DELETE CASCADE
)`,
  `CREATE TABLE app_meta (           -- 仅存应用级全局状态（白名单），禁止塞业务数据
    key TEXT PRIMARY KEY, value TEXT          -- 允许：current_project_id / last_open_page / db_* / hot_last_fetch_at / hot_source_status / hot_source_error
)`
]

/** 索引（§四 照抄） */
export const INDEX_STATEMENTS: string[] = [
  `CREATE INDEX idx_businesses_project   ON businesses(project_id)`,
  `CREATE INDEX idx_knowledge_project    ON knowledge_items(project_id)`,
  `CREATE INDEX idx_chunks_knowledge     ON knowledge_chunks(knowledge_id)`,
  `CREATE INDEX idx_contents_project     ON contents(project_id)`,
  `CREATE INDEX idx_contents_topic       ON contents(source_topic_id)`,
  `CREATE INDEX idx_versions_content     ON content_versions(content_id)`,
  `CREATE INDEX idx_samples_topic_time    ON hot_topic_samples(topic_id, sampled_at)`,
  `CREATE INDEX idx_hot_topics_seen       ON hot_topics(source_platform, last_seen_at)`,
  `CREATE INDEX idx_project_hot_score     ON project_hot_topics(project_id, platform, match_score)`,
  `CREATE INDEX idx_watchlist_project     ON project_watchlist(project_id, enabled)`
]
