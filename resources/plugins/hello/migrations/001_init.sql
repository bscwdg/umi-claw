-- 001_init.sql —— Hello 插件的库结构与第一版迁移
-- 说明：插件库里**只有**这里定义的表。宿主把 SQL 解析成 worker 白名单，
-- 因此这个文件是「插件能用哪些表/列」的唯一真相。

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
