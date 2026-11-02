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
  type HostOpsApi,
  type LegacyDbApi,
  type NotificationsApi,
  type OpenClawApi,
  type PluginStatus,
  type ServiceFactories
} from '../kernel'
import { PLUGIN_MAIN_ENTRIES } from '../kernel/plugins.main.generated'
import { createPluginDbService, type PluginDbService } from './pluginDb'
import { createPluginKvService } from './pluginKv'
import { PluginSecretStore } from './pluginSecrets'

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
  encryption: SecretEncryptionLike
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

import { join } from 'node:path'

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
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  let host: PluginHost | null = null
  let registry: PluginRegistry | null = null
  let configStore: ReturnType<typeof createPluginConfigStore> | null = null
  let dbService: PluginDbService | null = null

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
      hostOps: () => deps.hostOps(),
      // 插件密钥（PLAN-4.0 §8.2）：safeStorage 按 plugin:<id>:<key> 隔离
      secrets: (info) =>
        new PluginSecretStore(join(dataDir, 'plugins', info.id, 'secrets.bin'), deps.encryption),
      // 插件偏好：宿主持久化，按插件命名空间隔离
      kv: (info) => createPluginKvService(dataDir, info.id),
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

  const registerHostIpc = (stateStore: ReturnType<typeof createJsonStateStore>): void => {
    deps.ipc.removeHandler('plugin:list')
    deps.ipc.handle('plugin:list', () => ({ ok: true, data: statuses() }))

    deps.ipc.removeHandler('plugin:setEnabled')
    deps.ipc.handle('plugin:setEnabled', async (_e, payload: { id?: string; enabled?: boolean }) => {
      const id = String(payload?.id ?? '')
      const enabled = Boolean(payload?.enabled)
      try {
        if (!host || !registry) throw new Error('插件宿主未初始化')
        await host.setEnabled(id, enabled)
        await stateStore.save(registry.enabledSnapshot())
        broadcastStatus()
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

        // ── 服务层（Phase 1 WP1）：插件只能经 ctx.services 拿到这些窄接口 ──────────
        configStore = createPluginConfigStore(join(dataDir, 'plugin-config.json'))
        dbService = createPluginDbService({
          dataDir,
          nodePath: deps.nodePath(),
          workerScriptPath: join(deps.resourcesRoot(), 'database', 'db-worker.mjs'),
          logger: deps.logger
        })

        const serviceFactories = buildServiceFactories(dataDir)
        const reg = new PluginRegistry({
          persistedEnabled: await stateStore.load(),
          hostServices: availableServices(serviceFactories)
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
      await host?.disposeAll()
    },

    async flushConfig() {
      await configStore?.flush()
    },

    async disposeDb() {
      await dbService?.disposeAll()
    }
  }
}

