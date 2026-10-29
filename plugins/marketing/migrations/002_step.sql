-- contents: add content_type (post/shooting_script)
ALTER TABLE contents ADD COLUMN content_type TEXT NOT NULL DEFAULT 'post';
