// schema.ts —— Umi Claw 3.0「工作版」第一版 Schema（user_version = 1）
//
// 逐字取自 PLAN-3.0.md §三「核心数据模型（一期 8 表）」+ §3.1「索引与约束」。
//
// 硬规则 24（一期 8 表锁定）：profile / matters / todos / activity_log /
// reports / knowledge / conversations / app_meta。**禁止为「架构完整」新增状态表**
// （如 context_snapshots / candidate_queue / report_versions / work_memory / ai_runs）——
// 这些语义已由 activity_log.status / reports.generation_context / conversations / app_meta 承载。
//
// 与 2.0 的差异（跨分支移植，非复制）：
//   2.0 = projects/businesses/knowledge_items/knowledge_chunks/hot_topics/…（营销域）
//   3.0 = 工作域 8 表；knowledge 去 project 维度，conversations 承接 runId→快照（§14.1）。

/** 第一版 Schema 版本号（PRAGMA user_version） */
export const SCHEMA_VERSION = 1

/** 表清单（与 schema.ts 的 DDL、db-worker.mjs 的 TABLES 白名单一一对应） */
export const SCHEMA_TABLES = [
  'profile',
  'matters',
  'todos',
  'activity_log',
  'reports',
  'knowledge',
  'conversations',
  'app_meta'
] as const

/** 建表语句（顺序 = 外键依赖顺序；matters 先于 todos/activity_log） */
export const SCHEMA_STATEMENTS: string[] = [
  // ── 工作画像（单行，id 固定为 'default'）─────────────────────────────────────
  `CREATE TABLE profile (
    id TEXT PRIMARY KEY,                     -- 恒为 'default'（单行表）
    call_name TEXT,                          -- 称呼
    position TEXT,                           -- 岗位
    department TEXT,                         -- 部门
    company TEXT,                            -- 公司
    report_to TEXT,                          -- 汇报对象
    tone TEXT,                               -- 语气偏好
    report_style TEXT,                       -- 日报风格
    industry TEXT,                           -- 行业扩展位（岗位差异压缩原则，§一）
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`,
  // ── 事项（轻量表，禁止膨胀出空间/成员/权限，硬规则 9）──────────────────────
  `CREATE TABLE matters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',   -- active / archived
    color TEXT,                              -- 可选 UI 字段（预设 6 色，默认灰）
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`,
  // ── 待办（state 由 source 决定初始值，见 4.2 规则 5 / 参数约定 7）───────────
  `CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    due_date TEXT,                           -- YYYY-MM-DD，可空
    matter_id TEXT,                          -- 弱关联，可空
    source TEXT NOT NULL,                    -- manual / extracted / routine
    routine_rule TEXT,                       -- daily / weekly（仅 source=routine）
    state TEXT NOT NULL,                     -- candidate / confirmed / done / ignored
    done_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(matter_id) REFERENCES matters(id) ON DELETE SET NULL
)`,
  // ── 工作记录（来源 ≠ 事实的落点；双时间语义见 2.2.1）───────────────────────
  `CREATE TABLE activity_log (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    occurred_date TEXT NOT NULL,             -- 实际发生日（必填）；允许 ≠ created_at 的日期（补记）
    occurred_time TEXT,                      -- 实际发生时刻 HH:MM；NULL = 「时间未记」
    source TEXT NOT NULL,                    -- manual / todo / routine / ai_output
    source_ref TEXT,                         -- 可空：来源细节（conversation/message/todo id）
    status TEXT NOT NULL,                    -- candidate / confirmed / ignored
    matter_id TEXT,
    confirmed_at INTEGER,
    filtered_reason TEXT,                    -- 被候选质量门槛挡下的原因（2.2）
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(matter_id) REFERENCES matters(id) ON DELETE SET NULL
)`,
  // ── 报告（日报/周报）───────────────────────────────────────────────────────
  `CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                      -- daily / weekly
    period TEXT NOT NULL,                    -- daily=YYYY-MM-DD；weekly=YYYY-Www
    status TEXT NOT NULL DEFAULT 'draft',    -- draft / confirmed
    content TEXT,                            -- **当前正文（工作副本）**，可编辑（7.1/7.2）
    generation_context TEXT,                 -- JSON：{ current, generations[] } append-only（7.1）
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(type, period)                     -- 同一周期只一份（重生成=追加 generation，非新增行）
)`,
  // ── 工作知识库（复用 2.0 解析管线；去 project 维度）─────────────────────────
  `CREATE TABLE knowledge (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,                      -- text/markdown/url/faq/docx/xlsx/pdf/image
    source_path TEXT,
    source_name TEXT,
    content TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(source_path)                      -- 手输 text/faq 的 path 为 NULL（NULL 互不冲突）
)`,
  // ── AI 会话（承接 runId → Context 快照，§14.1；不新增 context_snapshots 表）──
  `CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL,          -- conv:work:qa / conv:work:tool:{id} / conv:work:report:{type}:{period}
    run_id TEXT,                             -- 一次执行的唯一 ID（同时是 SSE 流 ID，B2）
    role TEXT NOT NULL,                      -- user / assistant
    content TEXT,
    metadata TEXT,                           -- JSON；assistant 行存 contextSnapshot（§14.1）
    created_at INTEGER NOT NULL
)`,
  // ── 元数据（仅应用级全局状态白名单，禁止塞业务数据）────────────────────────
  `CREATE TABLE app_meta (
    key TEXT PRIMARY KEY, value TEXT
)`
]

/** 索引（§3.1 照抄） */
export const INDEX_STATEMENTS: string[] = [
  `CREATE INDEX idx_activity_date_status ON activity_log(occurred_date, status)`,
  `CREATE INDEX idx_activity_matter      ON activity_log(matter_id)`,
  `CREATE INDEX idx_activity_source_ref  ON activity_log(source_ref)`,
  `CREATE INDEX idx_todos_state_due      ON todos(state, due_date)`,
  `CREATE INDEX idx_todos_matter         ON todos(matter_id)`,
  `CREATE INDEX idx_matters_status       ON matters(status)`,
  `CREATE INDEX idx_knowledge_status     ON knowledge(status)`,
  `CREATE INDEX idx_conversations_key    ON conversations(conversation_key)`,
  `CREATE INDEX idx_conversations_run    ON conversations(run_id)`
]
