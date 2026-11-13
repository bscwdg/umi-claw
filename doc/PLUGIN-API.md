# 插件 API v1（RC）

> 状态：v1.0-RC（2026-11-13）｜适用：4.3.0 起的官方内置插件；5.0 起的受控第三方插件
> 上位计划：[PLAN-5.0-EXTENSIBILITY.md](PLAN-5.0-EXTENSIBILITY.md)
> 说明：本文件在 B0 隔离 ADR 通过前为 **RC**；CJS/ESM、事件传输、进程粒度、网络残余风险以 B0 结论为准后升 v1-final。
> 原则：**第三方可见面 = 显式 allowlist；官方 internal 不等于公开 API。**

> ⚠️ **实现状态（2026-11-13）**：本文件是 **v1-RC 目标契约**，不是“已实现清单”。未标 ✅ 的条目属于 A3a/A4/A5/B1/B2 的施工目标；当前代码仍是 4.x 的 internal 契约。逐项状态见下表。

| 能力 | 当前 | 目标 WP |
| --- | --- | --- |
| SDK 分层（public/official-*/client*/testing） | ✅ 骨架（无 alias/注入） | A2 → A3b |
| manifest `apiVersion` / `engines.host` 校验 | ✅ A4（hostVersion 注入；缺省不限制） | A4 |
| permissions allowlist / 未知键 fail-closed | ❌ | A3a/B2 |
| migrations DDL 白名单 / 禁 ATTACH/VACUUM | ✅ A3a | A3a |
| `ctx.db.request` 收窄（官方 `<table>.<op>`） | ✅ A3a（禁 migrate/maintenance/shutdown） | A3a |
| async 第三方可见面 / 事件流 RPC | ❌ | A3a/A1 |
| configSchema / config.onChange | ❌ | A4/B2 |
| 插件 IPC 统一 `{ok,data}` 信封 | ⚠️ 官方插件手工包 | A3a |
| `test/plugin-contract.accept.mjs` | ✅ A5（templates/plugin） | A5 |
| 状态文件 schema 版本 | ✅ A4（v1 wrapper + 旧 flat 兼容） | A4 |
| `onDemand` 懒激活 | ❌ | A3a |

---

## 〇、范围与版本

- `apiVersion`：整数 major（v1 = `1`）；不兼容变更升 major。
- 宿主兼容：manifest `engines.host` 声明宿主版本范围；宿主拒绝不满足的插件。
- 兼容承诺：N / N-1 两个 API major、至少 6 个月弃用窗口（PLAN-5.0 D8）。
- 官方插件也走同一公开面；官方 internal 能力需通过 `/official` 子路径显式引入，并在 manifest 中标记 `trust: official`（由宿主签名/内置来源判定，插件不得自声明）。

---

## 一、生命周期

```ts
export interface PluginModule {
  activate(ctx: PluginContextV1): void | (() => void) | Promise<void | (() => void)>
  deactivate?(): void | Promise<void>
}
```

| 阶段 | 行为 |
| --- | --- |
| `discovered` | 宿主发现入口；不执行代码 |
| `validated` | manifest / apiVersion / engines / permissions / configSchema 校验通过（A4：apiVersion/engines 已实现；permissions/configSchema 待 A3a/B2） |
| `activated` | 注册物生效；状态可查询 |
| `deactivated` / `disabled` / `failed` | 不服务；保留数据；错误带 code/stage |
| `activating` / `deactivating` | **A3a/B1 目标**：当前实现为同步状态迁移 + disposer 栈；进程版增加显式过渡态 |

硬规则：

- 注册物（IPC、定时器、事件订阅）必须返回/登记 disposer；停用由宿主 LIFO 清理。
- `activate` 返回的 cleanup 与 `onDispose` 都只执行一次；超时/停用后的迟到 cleanup 由宿主兜底。
- 插件失败只影响自身；宿主继续运行。
- `onDemand`（可选）：首次路由/IPC 调用时激活；未实现前 manifest 不得声明（A3a 决定实现或删除）。

---

## 二、manifest（v2）

```json
{
  "id": "example",
  "name": "示例插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "host": ">=5.0.0 <6.0.0" },
  "description": "一句话说明",
  "permissions": {
    "data": "own",
    "kv": true,
    "secrets": [],
    "db": true,
    "config": true,
    "openclaw": { "model": true, "channels": [] },
    "notifications": false,
    "http": [],
    "dialog": false
  },
  "configSchema": { "type": "object", "properties": {} },
  "activation": ["onStartup"],
  "contributes": { "navGroup": { "id": "example", "label": "示例" }, "routes": ["/example"], "settings": [], "commands": [] },
  "channels": [],
  "defaultEnabled": false
}
```

校验规则：

- `id`：`^[a-z][a-z0-9-]*$`；保留字 `host`/`plugin`/`system`/`app`/`umi` 及后续登记项禁止。
- `apiVersion` 必须为 >=1 的整数（**缺省 1**）；`engines.host` 若声明必须可解析（缺省不限制）；声明了但宿主不满足 → 注册期拒绝（`MANIFEST_INVALID`，field=apiVersion/engines.host）。
- `permissions` 未知键 **fail-closed**（拒绝），不做静默忽略。
- `configSchema` 仅 JSON Schema 子集（见 §七）；超限拒绝。
- 官方插件可省略 `permissions`（可信默认），第三方必须显式声明。
- `channels` 仅官方可租用；第三方必须为空。
- `trust` 不是 manifest 字段；由包签名/内置来源决定。

---

## 三、公开上下文（allowlist）

```ts
interface PluginContextV1 {
  readonly id: string
  readonly version: string
  readonly host: { version: string; platform: string }
  readonly logger: PluginLogger
  readonly jobs: PluginJobs
  /** 仅 manifest.inject 含 config 时存在；未声明时为 undefined */
  readonly config?: PluginConfigApi
  readonly services: {
    db?: PluginDbApiV1
    kv?: PluginKvApi
    secrets?: PluginSecretsApi
    notifications?: NotificationsApi
    openclaw?: OpenClawProxyApi
    http?: PluginHttpApi
    dialog?: PluginDialogApi
  }
  registerIpc(method: string, handler: PluginIpcHandler): void
  onDispose(fn: () => void | Promise<void>): void
}
```

### 3.1 公开面

| 能力 | 方法 | 约束 |
| --- | --- | --- |
| `logger` | `info/warn/error(message, meta?)` | 不写密钥；日志带插件 id |
| `jobs` | `every(ms, fn, {name?})`、`timeout(ms, fn, {name?})`、`count()` | 返回取消函数；停用清理；回调 async |
| `config` | `get/set/all/onChange`（全 async） | 受 `configSchema` 校验；命名空间隔离 |
| `db` | `list/get/create/update/remove/metaGet/metaSet/migrate` | 参数化；表白名单；无 `path/request/backup`；无裸 SQL |
| `kv` | `get/set/keys`（async） | 本插件命名空间 |
| `secrets` | `get/set/clear/keys/available` | 仅本插件 `plugin:<id>:*`；不可读宿主密钥 |
| `notifications` | `show({title, body, silent?})` | 仅标题/正文 |
| `openclaw` | `status()`、`chat()`、`stream()` | 仅模型调用；会话键强制 `conv:plugin:<id>:*`；不返回 port/baseUrl/token；不可发渠道 |
| `http` | `fetch(request)` | 仅 manifest `permissions.http` 域名；经宿主代理；超时/大小上限 |
| `dialog` | `pickFile(options)` | 仅文件选择；不暴露窗口对象 |
| `registerIpc` | `(method, handler)` | 仅 `plugin:<id>:<method>`；不含冒号/空白；停用卸载 |
| `onDispose` | `(fn)` | LIFO；只执行一次 |

### 3.2 官方 internal（不得出现在第三方运行时）

| 能力 | 说明 |
| --- | --- |
| `consent` | 用户协议宿主单源；第三方不可撤销/读取 |
| `abort` | 宿主退出中止登记；第三方用 `onDispose` |
| `hostOps` | 通知/外发/旧库定位等宿主副作用 |
| `legacyDb` | 旧库只读迁移入口 |
| `ctx.host.dataDir` / `paths` | 宿主路径；第三方不可见 |
| `registerChannelIpc` | 历史命名空间租约；仅官方 |
| `db.path/request/backup` | 逃生门；仅官方 internal，第三方禁止 |

官方通过 `@umi/plugin-sdk/official` 引入 internal；第三方包构建时该子路径不可用（打包器 external + 运行时不存在）。

---

## 四、异步与事件/流式 RPC

- 所有第三方可见方法 **async**；不得依赖同步返回值。
- 事件/流式响应用统一信封：

```ts
type PluginStreamEvent =
  | { type: 'chunk'; id: string; data: unknown }
  | { type: 'done'; id: string; data?: unknown }
  | { type: 'error'; id: string; error: { code: string; message: string; details?: unknown } }

interface PluginIpcHandler {
  // TODO(A3a)：当前第二参是 Electron event；RPC 事件契约落地前第三方不得依赖
  (payload?: unknown, context?: unknown): unknown | Promise<unknown>
}
```

- 第三方不接收 Electron `IpcMainInvokeEvent`；`event.sender` 相关流式由宿主 supervisor 转成事件通道（A1 定稿）。
- 取消：宿主提供 `AbortSignal`；插件应尽快停止并返回 `PLUGIN_ABORTED`。
- 超时：默认 30s（可配置）；超时返回 `PLUGIN_TIMEOUT`。
- 背压：高频 chunk 合并/限流，避免 IPC 淹没；上限在 B1 实测后定。

---

## 五、数据库与迁移

### 5.1 第三方 DB API

```ts
interface PluginDbApiV1 {
  migrate(): Promise<void>
  list<T>(table: string, query?: Record<string, unknown>): Promise<T[]>
  get<T>(table: string, id: unknown): Promise<T | null>
  create<T>(table: string, values: Record<string, unknown>): Promise<T>
  update(table: string, id: unknown, patch: Record<string, unknown>): Promise<{ changes: number }>
  remove(table: string, id: unknown): Promise<{ deleted: boolean }>
  metaGet(key: string): Promise<string | null>
  metaSet(key: string, value: string | null): Promise<{ changes: number }>
}
```

- 表白名单来自插件 `migrations/*.sql` 解析（**A3a 目标**：只允许 `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE ADD COLUMN`；当前解析器会把 INDEX/PRAGMA/INSERT 原样进迁移步骤，尚未拦截）。
- 禁止 `ATTACH` / `PRAGMA` / `VACUUM INTO` / `INSERT` / 任意 SQL；迁移由宿主执行并校验。
- 数据根：第三方 `<dataDir>/plugin-data/<id>/data.db`；官方沿用 `<dataDir>/plugins/<id>/data.db`。
- 迁移前备份；失败回滚；`migrate()` 幂等。
- 无 `path` / `request` / `backup`；备份由宿主在升级/迁移时自动做。

### 5.2 官方 internal

保留 `request('<table>.<op>')` 逃生门（**A3a 目标**：仅白名单方法，含 `<table>.upsert`；当前 `migrate`/`maintenance.vacuumInto` 仍可达）。

---

## 六、权限

### 6.1 manifest → 能力映射

| permission | 授予 |
| --- | --- |
| `data: "own"` | 本插件 DB |
| `kv: true` | 本插件 KV |
| `secrets: [key...]` | 本插件命名空间下的 key |
| `db: true` | 插件 DB API |
| `config: true` | 插件配置 |
| `openclaw.model: true` | 宿主代理的模型调用（配额/模型策略由宿主） |
| `openclaw.channels: []` | v1 必须为空；第三方不可发渠道 |
| `notifications: true` | 系统通知 |
| `http: [domain...]` | 宿主代理 fetch 的域名白名单 |
| `dialog: true` | 文件选择器 |

- 默认拒绝；未声明即不存在（不是 undefined 回落）。（**A3a/B2 目标**；当前 manifest 仍保留 unknown 字段、无权限校验）
- 未知 permission 键 fail-closed。
- 权限变更/撤销：立即生效；进行中的调用可被 abort。
- 首次启用展示授权 UI（人能看懂的语言）；开发者模式仍需展示。

### 6.2 OpenClaw 边界

- 只给模型调用；会话键强制 `conv:plugin:<id>:*`；不得进入 `conv:work:*` / `conv:<projectId>:*`。
- `status()` 不返回 port/baseUrl/token；不可调用渠道发送/网关控制。
- 配额/模型策略由宿主设置；超限 `PLUGIN_QUOTA_EXCEEDED`。

---

## 七、配置与 configSchema

- JSON Schema 子集：`type`（object/string/number/boolean/array）、`properties`、`required`、`default`、`enum`、`minimum/maximum`、`minLength/maxLength`、`items`。
- 限制：深度 ≤ 8、字段数 ≤ 200、字符串长度 ≤ 8KB、正则仅白名单语法（禁回溯风险）；超限拒绝。
- 设置页只渲染 schema，不执行任意 HTML/JS；label/description 经过转义。
- `config.get/set/all/onChange` 全 async；变更先校验后写入，失败不落盘。

---

## 八、UI 贡献

- 官方插件：`renderer.ts` 的 routes/nav/slot/setup 保持现状（构建期装配）。
- 第三方 v1：**只 headless**；无 routes/nav/slot/任意 Vue；设置页由 §七自动生成。
- 第三方 UI 到 Phase 3：sandboxed iframe + postMessage 能力桥；不得同页访问宿主 store/`window.api`。

---

## 九、IPC 与错误

- 第三方通道：`plugin:<id>:<method>`（method 不含 `:`/空白）。
- 返回信封：`{ ok: true, data }` / `{ ok: false, error: { code, message, details? } }`。
- 错误码新增（A3a 落到 `ERROR_CODES`）：

| code | 场景 |
| --- | --- |
| `PLUGIN_NOT_FOUND` | 未注册/已卸载 |
| `PLUGIN_DISABLED` | 已停用/未启用 |
| `PLUGIN_API_INCOMPATIBLE` | 保留（v1 注册期用 MANIFEST_INVALID + field=apiVersion/engines.host；运行时兼容错误走此码） |
| `PLUGIN_PERMISSION_DENIED` | 未授权能力 |
| `PLUGIN_QUOTA_EXCEEDED` | 模型/资源配额 |
| `PLUGIN_TIMEOUT` | 调用超时 |
| `PLUGIN_ABORTED` | 取消 |
| `PLUGIN_CRASHED` | 子进程崩溃 |
| `PLUGIN_OPERATION_FAILED` | 通用操作失败（已有） |
| `PLUGIN_SIGNATURE_INVALID` | 签名/哈希失败（Phase 2） |
| `PLUGIN_INSTALL_FAILED` | 安装/更新失败（Phase 2） |
| `PLUGIN_PERMISSION_CONFIG_INVALID` | 权限/manifest 配置非法（B0 残余项） |

- 渲染端只按 `code` 分支；禁止 `message.includes()`。

---

## 十、SDK 分层

| 子路径 | 内容 | 可用方 |
| --- | --- | --- |
| `@umi/plugin-sdk/public` | 公开类型、`definePlugin`、错误码/manifest 类型（**A3a 加入**） | 官方 + 第三方 |
| `@umi/plugin-sdk/official` | kernel 契约全量（`definePlugin` / `PluginContext` / services 类型） | 仅官方 |
| `@umi/plugin-sdk/official-errors` | `AppError` / `ERROR_CODES` / 信封 | 仅官方 |
| `@umi/plugin-sdk/official-gateway` | gateway 类型 / 流助手 / parts | 仅官方 |
| `@umi/plugin-sdk/official-context` | 上下文预算 / 组装 / 截断 | 仅官方 |
| `@umi/plugin-sdk/official-knowledge` | 知识库解析 / 抓取 / pdfjs 资产（barrel 会链 mammoth/exceljs；只给需要解析的 main/domain） | 仅官方 |
| `@umi/plugin-sdk/official-import` | 旧库一次性导入 | 仅官方 |
| `@umi/plugin-sdk/official-db` | 数据库共享窄类型 | 仅官方 |
| `@umi/plugin-sdk/official-host` | 宿主 electron 适配（仅 main/ipc） | 仅官方 |
| `@umi/plugin-sdk/client` | 官方 UI 的 `PluginUiModule`/`PluginUiHost` 类型 | 仅官方 |
| `@umi/plugin-sdk/client-official` | 官方 UI 运行时共享（useToast / agreementGate / wizardGate / contentPrefill / photographyPresets） | 仅官方 |
| `@umi/plugin-sdk/testing` | 契约测试工具（fake host、断言） | 测试 |

- 第三方包构建时 SDK **不随包**：宿主注入 `definePlugin`（identity）与类型；运行时对象由宿主提供。
- **A2/A3b 当前是相对路径骨架**：`@umi/plugin-sdk/*` 的 alias/宿主注入尚未实现；仓内插件暂用 `../../plugin-sdk/src/*`。B1 前不得依赖全局变量。
- official 拆成多个子路径而不是一个 barrel：避免 knowledge（mammoth/exceljs）、hostUi（electron）链进每个 domain bundle。
- 官方插件迁移期间允许 official-* / client-official；迁移完成后门禁只允许 SDK。当前 ratchet：host import 0，UI host import 4(+2 type；ConfirmDialog 是 .vue，保留直连), hostBridge 13（useWorkStream 移入插件后必须经 hostBridge；官方 UI 内部，Phase 1 前不动）。

---

## 十一、版本与兼容

- `apiVersion` major：v1 插件只能在声明 `engines.host` 匹配的宿主运行。
- 宿主升级：N/N-1 兼容；不兼容明确拒绝，不静默加载。
- 弃用：至少 6 个月/两个 minor；弃用告警写入日志与插件详情。
- 契约测试：`test/plugin-contract.accept.mjs` 用 `templates/plugin` 跑 v1 公开面（A5 已落地；N/N-1 矩阵待 Phase 1）。
- 状态：`plugins-state.json` 带 `schema: 1` wrapper，旧 flat 格式可读（A4 已落地）。

---

## 十二、安全边界（必须写清）

- `utilityProcess` 是**进程隔离**，不是安全沙箱。
- `fs`/`child_process` 由 Node permission model 约束：**只走 `NODE_OPTIONS` 注入**（`execArgv` 实测无效）；`--allow-fs-read` 必须包含插件包入口目录，否则入口加载即 exit 1；子进程 env 显式白名单，不继承 `process.env`。
- 连带拦住 `worker_threads` / native addon / `process.binding`；但 `process._linkedBinding` 仍可用（残余）；`child-process-gone` 不覆盖 utilityProcess，监督必须用 `UtilityProcess.exit` + 心跳。
- **网络不承诺强隔离**：Node permission model 不拦 TCP；插件仍可能直连。v1 定位「受控/可审核第三方」，不是「任意不可信代码」。
- 禁 native module / `postinstall` / 任意子进程；包构建时静态检查 + 签名/审核。
- 签名：keyId/alg；宿主 keyring/吊销列表；自签 TOFU 指纹确认与变更告警。
- 日志脱敏；密钥永不写日志/配置/导出包。

---

## 十三、示例（公开面）

```ts
// 最终形态（第三方）：宿主注入 @umi/plugin-sdk/public，SDK 不随包
// 仓内官方插件 A2 阶段暂用相对路径：
import { definePlugin } from '../../plugin-sdk/src/public'

export default definePlugin({
  async activate(ctx) {
    await ctx.services.db?.migrate()
    ctx.registerIpc('ping', async (payload) => ({ pong: true, echo: payload ?? null }))
    ctx.jobs.every(60_000, async () => ctx.logger.info('tick'), { name: 'tick' })
    return () => ctx.logger.info('cleanup')
  }
})
```

---

## 十四、待 B0/后续定稿

| # | 项 | 依赖 |
| --- | --- | --- |
| 1 | CJS/ESM 入口 | **B0 实测（ADR 草案待评审）**：CJS canonical；`.mjs`/ESM 可用，CJS 可 `import()` ESM |
| 2 | 事件/流式传输细节（MessagePort vs IPC） | **B0 实测（ADR 草案待评审）**：MessagePort RTT 中位 0.19–0.28ms；优先 MessagePort |
| 3 | 进程粒度（单插件/信任组） | **B0 实测（ADR 草案待评审）**：单插件单进程 + 懒激活 + 并发上限 4–6 |
| 4 | 网络残余风险的用户提示文案 | B0/A1：不承诺网络；审核/代理白名单降险 |
| 5 | `onDemand` 实现或删除 | A3a |
| 6 | configSchema 子集最终清单 | A1 评审 |
| 7 | 权限预设（最小/模型/集成） | B2 |

---

*本文件是 API v1-RC，不是最终契约；B0 ADR 通过后升 v1-final 并冻结。*
