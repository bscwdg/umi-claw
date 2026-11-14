// electron/main/services/pluginRuntime.ts —— 插件宿主装配（4.1 WP5-b：从 index.ts 抽出）
//
// 为什么抽出来：这段装配原在 `main/index.ts` 的 initPlugins 里（约 200 行），
// 直接闭包摸 configManager / app / ipcMain / powerMonitor / 窗口。抽成服务后：
//   - index.ts 只负责「把宿主能力注入进去 + 调用 init()」（早初始化语义不变）；
//   - 插件状态（host/registry/configStore/dbService）收在一个 runtime 对象里，
//     退出清理、legacy 读库、会话键解析都走它的窄接口，而不是共享模块级变量。
//
// 行为约束（与抽取前逐条一致）：
//   - 插件子系统整体失败 → 只打日志，宿主继续以零插件模式运行；
//   - work 激活要 spawn 便携 node + 建库/迁移，activationTimeoutMs=20000；
//   - plugin:list / plugin:setEnabled 由宿主注册（插件停用也不摘）；
//   - 状态变化广播 `plugin:changed` 给所有窗口。

import {
  availableServices,
  createJsonStateStore,
  createPluginConfigStore,
  discoverPlugins,
  PluginHost,
  PluginRegistry,
  isPluginIsolationEnabled,
  resolveDevMode,
  createUtilityProcessFork,
  type UtilityProcessForkApi,
  type DevModeState,
  type HostOpsApi,
  type LegacyDbApi,
  type NotificationsApi,
  type OpenClawApi,
  type PluginAbortApi,
  type PluginConsentApi,
  type PluginStatus,
  type ServiceFactories
} from '../kernel'
import { PLUGIN_MAIN_ENTRIES } from '../kernel/plugins.main.generated'
import { createPluginDbService, type PluginDbService } from './pluginDb'
import { createPluginKvService } from './pluginKv'
import { PluginSecretStore } from './pluginSecrets'
import { registerConversationKeyResolver } from './conversationKeyRegistry'
import {
  createPermissionAudit,
  createPermissionBroker,
  createPermissionStore,
  applyPermissionUpdate,
  type PermissionAction,
  type PermissionDecision,
  type PluginPermissionStore
} from './pluginPermissions'
import { createPluginServiceBridge, type PluginServiceBridge } from './pluginServiceBridge'
import {
  createPluginIsolationManager,
  type IsolatedPluginSpec,
  type IsolatedPluginStatus,
  type PluginIsolationManager
} from './pluginIsolationManager'
import { buildPluginPermissionEnv } from './pluginPermissions'

type PluginDbApi = ReturnType<PluginDbService['forPlugin']>

/** 旧库只读客户端（与 index.ts 的 openLegacyDatabase 同形） */
export interface LegacyClientLike {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** safeStorage 的最小子集（只读加密能力，不把 electron 引进服务层接口） */
export interface SecretEncryptionLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface PluginRuntimeDeps {
  dataDir: () => string
  nodePath: () => string
  resourcesRoot: () => string
  workDatabase: () => unknown
  openLegacyDatabase: (fileName: string, domain: string) => LegacyClientLike | null
  hostOps: () => HostOpsApi
  notifications: () => NotificationsApi
  openclaw: () => OpenClawApi
  /**
   * 用户协议服务（4.1.1 宿主单源）。
   * 插件（work 的 wizardManager）通过 ctx.services.consent 读写，
   * **不再碰自己的 app_meta.wizard_consent**——那是撤销失效的根因。
   */
  consent: () => PluginConsentApi
  /**
   * 后台任务中止登记（4.2 B3）。
   * 插件自注册后，宿主退出时不再直接调插件内部函数（消除反向依赖）。
   */
  abort: () => PluginAbortApi
  /**
   * 插件被启用后的回调（P2）。
   *
   * 为什么要它：宿主协议状态可能还需要从插件库补一次迁移，但启动时 work 若处于停用态
   * 就读不到插件库（为避免「为了读一个开关建库」）。等用户手动启用时再补。
   */
  afterEnable?: (pluginId: string) => Promise<void>
  encryption: SecretEncryptionLike
  /** Phase 2 P1：Electron utilityProcess；flag off 时可不传 */
  utilityProcess?: UtilityProcessForkApi
  ipc: {
    handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
    removeHandler(channel: string): void
  }
  appInfo: () => {
    version: string
    appPath: string
    resourcesPath: string
    isPackaged: boolean
  }
  subscribeResume: (callback: () => void) => () => void
  broadcast: (channel: string, payload: unknown) => void
  logger: (line: string) => void
}

import { dirname, join } from 'node:path'

export interface PluginRuntime {
  init(): Promise<void>
  statuses(): PluginStatus[]
  /** 营销域会话键解析用：未启用 → false */
  isEnabled(id: string): boolean
  /** 插件库（未初始化 / 未启用由调用方决定是否读） */
  pluginDbFor(id: string): PluginDbApi | null
  /** 退出清理：先停插件，再落配置、关库 */
  disposeHost(): Promise<void>
  flushConfig(): Promise<void>
  disposeDb(): Promise<void>
  /** Phase 1 B1：第三方进程隔离开关（默认 off；4.3 行为不变） */
  isolationEnabled(): boolean
  /** Phase 1 B2：权限 broker（B3 服务桥/子进程调用前 check） */
  checkPermission(pluginId: string, action: PermissionAction): PermissionDecision
  /** 权限汇总（管理页展示；不含 secrets） */
  permissionGrants(): Array<{ id: string; granted: boolean; grantedAt: number | null; requested: unknown }>
  /** Phase 1 B3：子进程服务调用（supervisor onService 用）；过权限 broker */
  callPluginService(pluginId: string, service: string, method: string, args: unknown[]): Promise<unknown>
  /** Phase 2 P1：生产 runtime 管理的隔离插件生命周期（flag off 时拒绝） */
  startIsolatedPlugin(spec: IsolatedPluginSpec): Promise<void>
  stopIsolatedPlugin(pluginId: string): Promise<void>
  isolatedStatuses(): IsolatedPluginStatus[]
  invokeIsolated(pluginId: string, method: string, payload?: unknown): Promise<unknown>
  /** Phase 1 B5：开发者模式闸门（打包版永远拒绝） */
  devMode(): DevModeState
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  let host: PluginHost | null = null
  let registry: PluginRegistry | null = null
  let configStore: ReturnType<typeof createPluginConfigStore> | null = null
  let dbService: PluginDbService | null = null
  let permissionStore: PluginPermissionStore | null = null
  let permissionBroker: ReturnType<typeof createPermissionBroker> | null = null
  let serviceBridge: PluginServiceBridge | null = null
  let isolationManager: PluginIsolationManager | null = null

  const statuses = (): PluginStatus[] => host?.statuses() ?? []

  const broadcastStatus = (): void => {
    deps.broadcast('plugin:changed', statuses())
  }

  const buildServiceFactories = (dataDir: string): ServiceFactories => {
    return {
      config: (info) => {
        if (!configStore) throw new Error('插件配置服务尚未初始化')
        return configStore.serviceFor(info.id)
      },
      // 每个插件一个库：work 的数据落 plugins/work/data.db；
      // 宿主 work.db 只剩 voice 的 app_meta。
      db: (info) => {
        if (!dbService) throw new Error('插件库服务尚未初始化')
        return dbService.forPlugin(info)
      },
      hostOps: (info) => ({
        ...deps.hostOps(),
        registerConversationKeyResolver: (fn) => registerConversationKeyResolver(info.id, fn)
      }),
      // 插件密钥（PLAN-4.0 §8.2）：safeStorage 按 plugin:<id>:<key> 隔离
      secrets: (info) =>
        new PluginSecretStore(join(dataDir, 'plugins', info.id, 'secrets.bin'), deps.encryption),
      // 插件偏好：宿主持久化，按插件命名空间隔离
      kv: (info) => createPluginKvService(dataDir, info.id),
      // 用户协议（宿主单源）：插件不写自己的库，避免两边状态分裂
      consent: () => deps.consent(),
      // 后台任务中止登记（4.2 B3）：插件自注册，宿主不认插件内部实现
      abort: () => deps.abort(),
      // 旧库只读：work → work.db，marketing → umi-claw.db（插件自己决定怎么搬）
      legacyDb: (info) => {
        const client =
          info.id === 'marketing'
            ? deps.openLegacyDatabase('umi-claw.db', 'marketing')
            : info.id === 'work'
              ? (deps.workDatabase() as LegacyClientLike | null)
              : null
        // 旧库不存在（全新安装 / 没装过 2.0）不是错误：返回空 reader，
        // 插件照常激活、导入逻辑自然跳过（审查 P1#3：否则营销域在新装用户上永久激活失败）
        if (!client) return { list: (async () => []) as unknown as LegacyDbApi['list'] }
        return {
          list: (table, params) =>
            client.request(`${table}.list`, (params ?? {}) as Record<string, unknown>)
        }
      },
      notifications: () => deps.notifications(),
      openclaw: () => deps.openclaw()
    }
  }

  const permissionGrants = (): Array<{
    id: string
    granted: boolean
    grantedAt: number | null
    requested: unknown
  }> => {
    const records = registry?.list() ?? []
    return records.map((record) => {
      const grant = permissionStore?.get(record.manifest.id)
      return {
        id: record.manifest.id,
        granted: Boolean(grant),
        grantedAt: grant?.grantedAt ?? null,
        requested: record.manifest.permissions ?? null
      }
    })
  }

  const registerHostIpc = (stateStore: ReturnType<typeof createJsonStateStore>): void => {    deps.ipc.removeHandler('plugin:list')
    deps.ipc.handle('plugin:list', () => ({ ok: true, data: statuses() }))

    deps.ipc.removeHandler('plugin:permissions:list')
    deps.ipc.handle('plugin:permissions:list', () => ({ ok: true, data: permissionGrants() }))

    deps.ipc.removeHandler('plugin:dev-mode')
    deps.ipc.handle('plugin:dev-mode', () => ({
      ok: true,
      data: resolveDevMode({ isPackaged: deps.appInfo().isPackaged, env: process.env })
    }))

    deps.ipc.removeHandler('plugin:isolated:list')
    deps.ipc.handle('plugin:isolated:list', () => ({
      ok: true,
      data: isolationManager?.statuses() ?? []
    }))

    deps.ipc.removeHandler('plugin:permissions:grant')
    deps.ipc.handle('plugin:permissions:grant', (_e, payload: { id?: string }) => {
      const id = String(payload?.id ?? '')
      const record = registry?.get(id)
      if (!record) return { ok: false, error: { code: 'NOT_FOUND', message: `插件不存在：${id}` } }
      // 只允许授予 manifest 里申请过的权限，UI 不能凭空扩权
      const grant = permissionStore!.grant(id, record.manifest.permissions ?? {})
      return { ok: true, data: { id, grantedAt: grant.grantedAt, permissions: grant.permissions } }
    })

    deps.ipc.removeHandler('plugin:permissions:revoke')
    deps.ipc.handle('plugin:permissions:revoke', async (_e, payload: { id?: string }) => {
      const id = String(payload?.id ?? '')
      permissionStore!.revoke(id)
      // 撤销授权后运行中进程仍持有旧 NODE_OPTIONS；C2 语义要求停/重启，
      // P2 先把隔离进程停掉，避免撤销后继续用旧 allowlist。
      await isolationManager?.stop(id)
      return { ok: true, data: permissionGrants() }
    })

    deps.ipc.removeHandler('plugin:setEnabled')
    deps.ipc.handle('plugin:setEnabled', async (_e, payload: { id?: string; enabled?: boolean }) => {      const id = String(payload?.id ?? '')
      const enabled = Boolean(payload?.enabled)
      try {
        if (!host || !registry) throw new Error('插件宿主未初始化')
        await host.setEnabled(id, enabled)
        await stateStore.save(registry.enabledSnapshot())
        broadcastStatus()
        // P2：启用后补一次宿主侧迁移（work 启用时才能读到它的库）
        if (enabled && deps.afterEnable) {
          try {
            await deps.afterEnable(id)
          } catch (e) {
            deps.logger(`[plugin:${id}] afterEnable 失败（不影响启用）: ${(e as Error)?.message ?? e}`)
          }
        }
        return { ok: true, data: statuses() }
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'PLUGIN_OPERATION_FAILED',
            message: e instanceof Error ? e.message : String(e)
          }
        }
      }
    })
  }

  return {
    async init() {
      try {
        const dataDir = deps.dataDir()
        const stateStore = createJsonStateStore(join(dataDir, 'plugins-state.json'))
        permissionStore = createPermissionStore(join(dataDir, 'plugin-permissions.json'))
        const permissionAudit = createPermissionAudit(join(dataDir, 'plugin-audit.log'))
        permissionBroker = createPermissionBroker({
          store: permissionStore,
          audit: permissionAudit,
          rootsFor: (pluginId) => ({
            pluginDir: join(deps.resourcesRoot(), 'plugins', pluginId),
            dataDir: join(dataDir, 'plugins', pluginId)
          })
        })

        // ── 服务层（Phase 1 WP1）：插件只能经 ctx.services 拿到这些窄接口 ──────────
        configStore = createPluginConfigStore(join(dataDir, 'plugin-config.json'))
        dbService = createPluginDbService({
          dataDir,
          nodePath: deps.nodePath(),
          workerScriptPath: join(deps.resourcesRoot(), 'database', 'db-worker.mjs'),
          logger: deps.logger
        })

        const serviceFactories = buildServiceFactories(dataDir)
        serviceBridge = createPluginServiceBridge({
          broker: permissionBroker!,
          resolveService: (pluginId, name) => {
            if (!Object.prototype.hasOwnProperty.call(serviceFactories, name)) return undefined
            const factory = serviceFactories[name as keyof typeof serviceFactories]
            if (typeof factory !== 'function') return undefined
            return factory({ id: pluginId, dir: join(deps.resourcesRoot(), 'plugins', pluginId) })
          },
          logger: deps.logger
        })

        // P1：生产 runtime 管理隔离插件；flag off 或未注入 utilityProcess 时保持 4.3 行为
        if (isPluginIsolationEnabled() && deps.utilityProcess) {
          isolationManager = createPluginIsolationManager({
            fork: createUtilityProcessFork(deps.utilityProcess),
            hostVersion: deps.appInfo().version,
            serviceCall: (pluginId, service, method, args) =>
              serviceBridge!.call(pluginId, service, method, args),
            buildEnv: (spec) => {
              const info = deps.appInfo()
              // dev 才把仓库根/app path 作为读根（本地开发显式 opt-in）；打包版只给
              // child 入口目录与 Electron bootstrap 目录，避免第三方读安装根。
              const dev = resolveDevMode({ isPackaged: info.isPackaged, env: process.env })
              const extraReadDirs = [dirname(spec.entry), info.resourcesPath, dirname(info.resourcesPath)]
              if (dev.plugins && !info.isPackaged) extraReadDirs.push(info.appPath)
              return buildPluginPermissionEnv({
                pluginDir: spec.packageDir,
                dataDir: spec.dataDir,
                cwd: dirname(spec.mainPath),
                permissions: spec.permissions ?? {},
                extraReadDirs
              })
            },
            logger: deps.logger
          })
        }
        const reg = new PluginRegistry({
          persistedEnabled: await stateStore.load(),
          hostServices: availableServices(serviceFactories),
          hostVersion: deps.appInfo().version
        })

        const discovered = discoverPlugins({
          root: join(deps.resourcesRoot(), 'plugins'),
          entries: PLUGIN_MAIN_ENTRIES,
          logger: deps.logger
        })

        let registered = 0
        for (const item of discovered) {
          if (!item.manifest) {
            // 清单缺失/坏 JSON 也要在 plugin:list 里可见，否则用户看到的是「装了但什么也没发生」
            reg.addFailed(
              item.id,
              {
                code:
                  item.loadError === 'MANIFEST_MISSING'
                    ? 'PLUGIN_MANIFEST_MISSING'
                    : 'PLUGIN_MANIFEST_INVALID',
                stage: 'manifest',
                message:
                  item.loadError === 'MANIFEST_MISSING'
                    ? '缺少 plugin.json'
                    : `plugin.json 解析失败：${item.loadError}`
              },
              { dir: item.dir, source: item.source }
            )
            continue
          }
          try {
            reg.register({
              dir: item.dir,
              entryId: item.id,
              source: item.source,
              manifest: item.manifest,
              loadMain: item.loadMain
            })
            registered += 1
          } catch (e) {
            const err = e as { code?: string; field?: string; message?: string }
            reg.addFailed(
              item.id,
              {
                code: typeof err.code === 'string' ? err.code : 'PLUGIN_REGISTER_FAILED',
                stage: 'manifest',
                field: err.field,
                message: err.message ?? String(e)
              },
              { dir: item.dir, source: item.source }
            )
            deps.logger(`[plugin:${item.id}] 注册失败：${err.message ?? String(e)}`)
          }
        }

        // 授权必须随 manifest 收窄：新 grant = 旧 grant ∩ 新 manifest；
        // 插件升级新增的权限不会继承，必须重新授权。交集为空则撤销，
        // 避免留下「已授权但权限为空」的静默空 grant（UI 误显示已授权）。
        for (const record of reg.list()) {
          const existing = permissionStore.get(record.manifest.id)
          if (existing) {
            applyPermissionUpdate(
              permissionStore,
              record.manifest.id,
              existing.permissions,
              record.manifest.permissions ?? {}
            )
          }
        }

        const info = deps.appInfo()
        const pluginHost = new PluginHost({
          registry: reg,
          ipc: deps.ipc as never,
          hostVersion: info.version,
          dataDir,
          // 宿主路径必须显式传：插件据此解析 collector / pdfjs / 便携 node
          paths: {
            appPath: info.appPath,
            resourcesPath: info.resourcesPath,
            isPackaged: info.isPackaged,
            nodePath: deps.nodePath()
          },
          // 系统从睡眠恢复：广播给插件（热点采集立即补一轮等）
          hostEvents: { onResume: deps.subscribeResume },
          services: serviceFactories,
          // work 激活要 spawn 便携 node + 建库/迁移，5s 在慢机上会误判超时（审查 P1-4）
          activationTimeoutMs: 20000,
          logger: deps.logger,
          onStatusChange: () => broadcastStatus()
        })

        registry = reg
        host = pluginHost
        registerHostIpc(stateStore)

        await pluginHost.activateAll()
        broadcastStatus()

        const activated = statuses().filter((s) => s.state === 'activated').length
        deps.logger(
          `[plugin] 就绪：登记 ${registered}/${Object.keys(PLUGIN_MAIN_ENTRIES).length}，激活 ${activated}`
        )
      } catch (e) {
        // 插件子系统整体失败 → 宿主以「零插件模式」继续运行（PLAN-4.0 验收标准 1）
        // 用 console.error 保留 stack/details（index 传入的 logger 只是 console.log）
        console.error('[plugin] 初始化失败（宿主继续运行，零插件模式）：', e)
      }
    },

    statuses,

    isEnabled(id) {
      return registry?.isEnabled(id) ?? false
    },

    pluginDbFor(id) {
      if (!dbService) return null
      return dbService.forPlugin({ id, dir: join(deps.resourcesRoot(), 'plugins', id) })
    },

    async disposeHost() {
      await isolationManager?.stopAll()
      await host?.disposeAll()
    },

    async flushConfig() {
      await configStore?.flush()
    },

    async disposeDb() {
      await dbService?.disposeAll()
    },

    isolationEnabled() {
      // B1：只暴露开关；真正的第三方 supervisor 在 B2/B3 接入。默认 off 保证 4.3 行为不变。
      return isPluginIsolationEnabled()
    },

    checkPermission(pluginId: string, action: PermissionAction) {
      if (!permissionBroker) return { allowed: false, reason: '权限服务未初始化' }
      return permissionBroker.check(pluginId, action)
    },

    permissionGrants,

    callPluginService(pluginId, service, method, args) {
      if (!serviceBridge) return Promise.reject(new Error('服务桥未初始化'))
      return serviceBridge.call(pluginId, service, method, args)
    },

    startIsolatedPlugin(spec) {
      if (!isolationManager) {
        return Promise.reject(
          Object.assign(new Error('隔离未启用或未注入 utilityProcess'), { code: 'PLUGIN_OPERATION_FAILED' })
        )
      }
      return isolationManager.start(spec)
    },

    stopIsolatedPlugin(pluginId) {
      return isolationManager?.stop(pluginId) ?? Promise.resolve()
    },

    isolatedStatuses() {
      return isolationManager?.statuses() ?? []
    },

    invokeIsolated(pluginId, method, payload) {
      if (!isolationManager) {
        return Promise.reject(
          Object.assign(new Error('隔离未启用或未注入 utilityProcess'), { code: 'PLUGIN_OPERATION_FAILED' })
        )
      }
      return isolationManager.invoke(pluginId, method, payload)
    },

    devMode() {
      return resolveDevMode({ isPackaged: deps.appInfo().isPackaged, env: process.env })
    }
  }
}

