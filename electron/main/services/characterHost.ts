// electron/main/services/characterHost.ts —— 大肥鱼宿主侧的依赖装配
//
// 为什么单独一个文件（WP4 C4.3）：角色是**宿主模块**（不是插件，因为它需要桌宠窗口 /
// 全局快捷键 / 屏幕定位，而这些插件契约刻意不给）。但它要的十几个能力原先直接写在
// index.ts 里，导致入口文件被撑到 2500+ 行，且每加一个角色能力就往入口塞一段。
//
// 这里只做「把宿主现成的东西装配成 CharacterWiringDeps」这一件事：
// 入参是宿主的既有对象，出参是 registerCharacter 需要的依赖。无副作用、可单测。

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ConfigManager } from '../configManager'
import type { GatewayClient } from '../gatewayClient'
import { buildOpenClawEnv, openClawPaths } from '../openClawPaths'
import type { ObsidianManager } from '../obsidian/obsidianManager'
import type { VoiceManager } from '../fish/voice'
import type { CharacterWiringDeps } from '../character/wiring'
import { filterCharacterHits } from '../character/searchContext'
import { buildKnowledgeHealth, countCharacterNotes } from '../character/knowledgeHealth'
import { scrubForLog } from '../character/safety'

/** 宿主侧能提供的一切（都是现成对象，不是新造） */
export interface CharacterHostSources {
  /** 角色的 KV（宿主 app_meta，fish:v2:*） */
  kv: CharacterWiringDeps['kv']
  dataDir: string
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  configManager: Pick<ConfigManager, 'getConfig' | 'getOpenClawChannels'>
  obsidianManager: ObsidianManager | null
  voiceManager: Pick<VoiceManager, 'speak' | 'readAudio'> | null
  /** 全应用唯一的网关客户端（缺省则聊天/日记不可用） */
  gateway: GatewayClient | null
  gatewayReady: () => boolean
  /** 角色事件推给渲染端 */
  onEvent: (event: unknown) => void
  logger: (message: string) => void
}

/** 角色 KV 的批量读写（单文件备份/导入用）：只有 CharacterKvStore 提供，缺省则备份功能降级 */
interface BulkCharacterKv {
  readAll(): Promise<Record<string, string>>
  writeMany(entries: Record<string, string | null>): Promise<{ changes: number }>
}

/** 鸭子类型探测：CharacterHostSources.kv 的契约只有 get/set，批量能力是 CharacterKvStore 的扩展 */
function asBulkKv(kv: CharacterWiringDeps['kv']): BulkCharacterKv | null {
  const candidate = kv as Partial<BulkCharacterKv>
  return typeof candidate.readAll === 'function' && typeof candidate.writeMany === 'function'
    ? (candidate as BulkCharacterKv)
    : null
}

/** 装配 registerCharacter 需要的依赖；不做任何 I/O。 */
export function buildCharacterDeps(src: CharacterHostSources): CharacterWiringDeps {
  const dataDir = src.dataDir
  const nodePath = openClawPaths.nodeBinary(dataDir)
  const bulkKv = asBulkKv(src.kv)

  return {
    kv: src.kv,
    ...(bulkKv
      ? {
          kvBulk: {
            readAll: () => bulkKv.readAll(),
            writeMany: (entries: Record<string, string | null>) => bulkKv.writeMany(entries)
          }
        }
      : {}),
    dataDir,
    personaSourceDir: src.isPackaged
      ? join(src.resourcesPath, 'resources', 'character', 'persona')
      : join(src.appPath, 'resources', 'character', 'persona'),
    configPath: openClawPaths.openClawConfig(dataDir),
    cli: {
      nodePath,
      cliPath: join(dataDir, 'openclaw', 'node_modules', 'openclaw', 'openclaw.mjs'),
      env: buildOpenClawEnv(dataDir, nodePath, {
        NODE_CONFIG_DIR: openClawPaths.portableHome(dataDir)
      }),
      cwd: openClawPaths.installDir(dataDir)
    },
    chat: (input) => {
      if (!src.gateway) throw new Error('gateway 客户端尚未初始化')
      return src.gateway.createChatStream(input as never)
    },
    generateDiary: async (prompt, meta) => {
      if (!src.gateway) throw new Error('gateway 客户端尚未初始化')
      // 必须给会话键：gateway 的 resolver 对空 project/conversation 会直接抛错
      const result = await src.gateway.chat({
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        model: 'openclaw/feiyu',
        conversationKey: `conv:fish:daily-memory:${meta.date}`
      })
      return result.text
    },
    // 预检索：复用「知识库」页同一条 search.mjs 链路（实测 200–500ms）
    // 隔离红线（PLAN-FISH-CHARACTER §13.2-9）：角色只能看 vault 里的「大肥鱼/」，
    // 工作/隐私笔记不得进入角色上下文；命中正文统一脱敏。
    searchKnowledge: async (query) => {
      try {
        const obs = src.configManager.getConfig().obsidian
        if (!obs?.enabled || !src.obsidianManager) return []
        const result = await src.obsidianManager.testSearch({ query, limit: 8 })
        return filterCharacterHits(
          (result.hits ?? []).map((hit) => ({
            path: hit.filePath,
            content: hit.content,
            score: hit.score
          }))
        ).map((hit) => ({ ...hit, content: scrubForLog(hit.content) }))
      } catch {
        return []
      }
    },
    // 知识体检（4.3）：vault/MCP/索引/大肥鱼笔记数 → UI 显示「导入的知识她到底能不能检索」
    knowledgeStatus: () => {
      const cfg = src.configManager.getConfig().obsidian
      const vaultPath = String(cfg?.vaultPath ?? '').trim()
      const vaultExists = Boolean(vaultPath) && existsSync(vaultPath)
      const index = src.obsidianManager?.getIndexStatus() ?? null
      const characterNotes = vaultExists ? countCharacterNotes(vaultPath) : 0
      return buildKnowledgeHealth({
        vaultPath,
        vaultExists,
        obsidianEnabled: Boolean(cfg?.enabled && vaultPath),
        index,
        characterNotes
      })
    },
    voice: {
      speakPcm: async (text) => {
        if (!src.voiceManager) throw new Error('语音模块未初始化')
        const result = await src.voiceManager.speak({
          text,
          options: { format: 'pcm', sampleRate: 16000 }
        })
        const payload = await src.voiceManager.readAudio(result.audioId)
        return payload.bytes
      },
      // 凭据只读：openclaw.json 才是 qqbot 的真源（app.json 只是 UI 副本）
      creds: () => {
        const channels = src.configManager.getOpenClawChannels()
        const qq = (channels?.qqbot ?? {}) as Record<string, unknown>
        const accounts = (qq.accounts ?? {}) as Record<string, Record<string, unknown>>
        const candidates: Record<string, unknown>[] = [qq, ...Object.values(accounts ?? {})]
        const pickString = (obj: Record<string, unknown>, keys: string[]): string => {
          for (const key of keys) {
            const value = obj[key]
            if (typeof value === 'string' && value.trim()) return value.trim()
          }
          return ''
        }
        for (const candidate of candidates) {
          const appId = pickString(candidate, ['appId', 'appid', 'app_id'])
          const secret = pickString(candidate, ['clientSecret', 'secret', 'appSecret'])
          const openid = pickString(candidate, ['openid', 'userOpenid', 'c2cOpenid', 'ownerOpenid'])
          // 计划 §13.2-10：只接受 32 位 clientSecret，避免 16 位 AppSecret 写坏通道
          if (appId && secret.length === 32 && openid) return { appId, clientSecret: secret, openid }
        }
        const envApp = process.env.UMI_QQBOT_APP_ID
        const envSecret = process.env.UMI_QQBOT_CLIENT_SECRET
        const envOpenid = process.env.UMI_QQBOT_OPENID
        if (envApp && envSecret && envSecret.length === 32 && envOpenid) {
          return { appId: envApp, clientSecret: envSecret, openid: envOpenid }
        }
        return null
      }
    },
    obsidianVaultPath: () => src.configManager.getConfig().obsidian?.vaultPath,
    gatewayReady: src.gatewayReady,
    // 「外部渠道」就绪：QQ/飞书/微信任一配置即可（不强制 QQ）
    qqReady: () => {
      try {
        const channels = src.configManager.getOpenClawChannels() as Record<
          string,
          Record<string, unknown>
        >
        const nonEmpty = (value: unknown): boolean =>
          typeof value === 'string' && value.trim().length > 0
        // 只认「有真实凭据且未被禁用」的渠道：首启骨架里的空凭据/disabled 不算
        const configured = (name: string, fields: string[]): boolean => {
          const channel = channels?.[name] as Record<string, unknown> | undefined
          if (!channel || channel.enabled === false) return false
          const scopes: Record<string, unknown>[] = [channel]
          const accounts = channel.accounts
          if (accounts && typeof accounts === 'object') {
            for (const account of Object.values(accounts as Record<string, unknown>)) {
              if (account && typeof account === 'object') {
                scopes.push(account as Record<string, unknown>)
              }
            }
          }
          return scopes.some((scope) => fields.some((field) => nonEmpty(scope?.[field])))
        }
        return (
          configured('qqbot', ['appId', 'appid', 'app_id', 'clientSecret', 'secret']) ||
          configured('feishu', ['appId', 'appSecret']) ||
          configured('wecom', ['corpId', 'corpSecret', 'secret', 'token']) ||
          configured('openclaw-weixin', ['appId', 'appSecret', 'token'])
        )
      } catch {
        return false
      }
    },
    ttsReady: () => src.voiceManager !== null,
    // 记忆检索就绪 = Obsidian 集成开启 + MCP 已注入 + 索引有数据 + vault 存在
    memorySearchReady: () => {
      try {
        const obs = src.configManager.getConfig().obsidian
        if (!obs?.enabled || !obs.vaultPath || !existsSync(obs.vaultPath)) return false
        const mcp = src.obsidianManager?.buildMcpServerConfig?.()
        const status = src.obsidianManager?.getIndexStatus?.()
        const chunkCount = Number((status as { chunkCount?: number } | undefined)?.chunkCount ?? 0)
        return Boolean(mcp && chunkCount > 0)
      } catch {
        return false
      }
    },
    logger: src.logger,
    onEvent: src.onEvent
  }
}
