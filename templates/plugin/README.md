# 插件模板

复制本目录到 `plugins/<id>/`，把 `plugin.json` 的 `id` 改成目录名（必须一致），再按 `doc/PLUGIN-API.md` 写 `main.ts` / `renderer.ts`。

- 只 import `plugin-sdk/src/public`（第三方可见面）；官方插件需要 internal 时用 `plugin-sdk/src/official-*`。
- `plugin.json` 必须带 `apiVersion`；需要兼容检查时加 `engines.host`（模板写的是 `>=4.3.0`，**4.3.0 发版后才生效**；当前宿主 4.2.0 复制过去会被注册期拒绝，可临时改成 `>=4.2.0`）。
- `migrations/*.sql` 只允许 `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE ADD COLUMN`。
- 不要直接 import `electron`、`electron/main/**`、`src/**`；不要手改 `*.generated.ts`。
- 新插件加入后跑 `npm run plugin:gen`，并在 `test/` 补契约断言。
