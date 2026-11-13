-- templates/plugin/migrations/001_init.sql —— 最小迁移示例
-- 只允许 CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN（宿主迁移白名单）
CREATE TABLE IF NOT EXISTS example_notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_example_notes_created ON example_notes(created_at);
