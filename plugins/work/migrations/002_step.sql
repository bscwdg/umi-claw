-- todos: 到点提醒两列 + 索引
ALTER TABLE todos ADD COLUMN remind_at INTEGER;
ALTER TABLE todos ADD COLUMN reminded_at INTEGER;
CREATE INDEX idx_todos_remind ON todos(state, remind_at);
