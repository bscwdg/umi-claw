// contentManager.ts —— Content Center（PLAN-2.0.md Commit 09）
//
// 契约（§七 09 行 / §六 Context Pack / §二 硬规则 9、10、13 / §四 schema / §五 IPC 与错误码）：
//   - 链路：AI 生成（SSE 流式 + **AbortController「停止生成」**，规格同 08）→ 编辑 → 版本
//     （prompt 快照）→ **人工审核** → 极简发布标记（status='published' + published_at +
//     effect_note，v1.13 复用状态列不设布尔列）。**不自动发布**（硬规则 10）：
//     「发布」只是人工点下的一次标记，复制发布由老板自己完成。
//   - **一次生成 3 个版本供选**（§一 产品智能原则 / §七 v1.12）：三个固定角度
//     （直给卖点 / 场景故事 / 异议处理）各起一条独立流式请求——不搞「一次请求要三段」
//     的脆弱拆分（模型分节不可靠、截断互相拖累），三条并行、各自流式、各自成版本；
//     选中与改稿都是 Learning 的偏好样本（选版 = update content；改稿 = saveVersion(source=user)）。
//   - 版本落库时机（**先落库、后 done**）：每条流包一层聚合 handle，`result` resolve 前
//     完成 `content_versions` 落行（source=ai、prompt=本次 Context Pack 快照，v1.10 硬要求）——
//     渲染端收到 done 立刻刷新列表必然读得到，没有竞态。**中止/失败的版本不落行**：
//     半截稿子不是「供选版本」，重生成一次的成本远低于留一具残稿。
//   - 生成会话键 `content-<genTaskId>-a<角度>`：三路并行若共用商家 sticky 会话，
//     同一 user 并发写会话历史会互相穿插（05b 同课）；生成任务也不该污染 Advisor 记忆。
//   - 生成**走 07 纯文本默认模型**（content 无图请求）；Context Pack 由 06 引擎组装
//     （business + knowledge + watchlist + platform + task）；
//     Commit 10 起 pack.platformRule 带平台规则模板，生成指令与 prompt 快照都注入该区块。
//   - 热点 payload（§七 v1.9/v1.10）：`source_topic_id` 溯源 hot_topics.id——
//     落库前**显式验行存在**（FK 由 DB 保证，但预检能把错误翻成
//     `VALIDATION_ERROR + reason='source-topic-not-found'` 而不是 FK 天书）；
//     11/12 上线前该路径只有测试与「带 payload 跳转」会触达。
//   - 每个业务方法**显式 projectId**（硬规则 9）；跨 Project 的 id 视同 NOT_FOUND（与 05a 同口径）。
//   - **不 import electron、不发 HTTP**：ContextEngine / GatewayClient / DatabaseClient 全注入，
//     可被 esbuild bundle 后在纯 Node 直接测（test/content.accept.mjs 打这份真源码）。
//
// §五 扩面（09 新增，汇报注明）：`content:` 的枚举里补 `delete` 与 `generate:abort`
// （先例：05a import/pickFile、05b recognize/abort/commitRecognized）。

import { randomUUID } from 'node:crypto'
import { AppError, ERROR_CODES } from '../database/errors'
import type { DatabaseClient } from '../database/database'
import { PLATFORMS, renderContextPackText, type ContextEngine, type ContextPack, type Platform } from './contextEngine'
import { renderPackRuleSection } from './platformRules'
import {
  textPart,
  type GatewayClient,
  type GatewayChatMessage,
  type GatewayStreamHandle,
  type GatewayStreamResult
} from '../gatewayClient'

// ── 常量（§四 列值与产品口径） ───────────────────────────────────────────────

/** §四 `contents.status`：状态机全集（人工推进，无自动跳转） */
export const CONTENT_STATUSES = ['draft', 'review', 'approved', 'published', 'archived'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/** `content_versions.source`（§四：ai 必须带 prompt 快照；user 的 prompt 为 NULL） */
export const CONTENT_VERSION_SOURCES = ['ai', 'user'] as const
export type ContentVersionSource = (typeof CONTENT_VERSION_SOURCES)[number]

/** 发布平台 = 06 的 PLATFORMS（单一真相来源，10 的模板注入也认这两值） */
export const CONTENT_PLATFORMS = PLATFORMS

/** 标题上限（`contents.title` 可空——无标题的草稿靠列表行序识别） */
export const CONTENT_TITLE_MAX_LENGTH = 120
/** 选题/主题文案上限 */
export const CONTENT_TOPIC_MAX_LENGTH = 500
/** 正文/版本内容上限（营销文案不该到十万字；超限截断带标记，与 05a 同口径） */
export const CONTENT_BODY_MAX_LENGTH = 100_000
export const CONTENT_TRUNCATE_MARKER = '\n\n（内容过长已截断）'
/** prompt 快照上限（Context Pack 文本可达数万 token，快照只为复盘，不为复刻请求） */
export const CONTENT_PROMPT_MAX_LENGTH = 200_000
/** 效果备注上限 */
export const CONTENT_EFFECT_NOTE_MAX_LENGTH = 500
/** 列表默认条数（worker 上限 5000） */
export const DEFAULT_LIST_LIMIT = 500

/** 一次生成固定 3 个角度（§七 v1.12「3 个版本供选」；改数量要连 UI 文案一起动，故不设参数） */
export const CONTENT_GENERATION_VERSIONS = 3 as const
export interface GenerationAngle {
  /** 稳定标识（preload/accept 断言用） */
  key: 'direct' | 'story' | 'objection'
  label: string
  /** 写给模型的指令（进 user 消息，也进 prompt 快照） */
  instruction: string
}
/** 三个固定角度（§一「3 个角度/语气供选」；写死、确定性，不让模型自己决定怎么分版本） */
export const CONTENT_GENERATION_ANGLES: GenerationAngle[] = [
  {
    key: 'direct',
    label: '直给卖点',
    instruction:
      '风格：直给。开头即卖点与优惠/价值主张，信息密度高，读者三秒内知道「这是什么、为什么值得」。'
  },
  {
    key: 'story',
    label: '场景故事',
    instruction:
      '风格：场景叙事。从目标客户的真实使用场景切入，讲一个具体的小故事/画面，卖点藏在故事里。'
  },
  {
    key: 'objection',
    label: '异议处理',
    instruction:
      '风格：问答拆解。围绕客户最常见的顾虑（价格、效果、对比同行），逐条正面回应，化解疑虑后收口。'
  }
]

/** 内容生成护栏（§一「不硬编」+ 硬规则 10；与 08 同源但面向「成稿」） */
export const CONTENT_GUARDRAILS = [
  '你是这位老板的文案撰稿人。任务：为指定平台写一篇可直接使用的营销内容。',
  '',
  '硬性规则：',
  '1) 价格、套餐、优惠、承诺、卖点、案例——**只能引用下面商家资料里出现过的信息**；',
  '   资料里没有的，宁可写「具体价格到店咨询」这类诚实表述，也不许编一个数字或承诺。',
  '2) 不虚构客户、不虚构效果、不虚构资质；不确定就模糊处理并留一行「（此处资料缺失，建议补充）」。',
  '3) 成稿即成品：严格按「发布平台规则」规定的结构产出（小红书图文 / 抖音口播三件套），拿掉指令性文字，不要输出「以下是文案」这类前言。',
  '4) 只输出文案成品本身，不要解释、不要代码块围栏、不要多个版本混排。'
].join('\n')

// ── 类型 ──────────────────────────────────────────────────────────────────────

/** `contents` 表一行 */
export interface ContentRow {
  id: string
  project_id: string
  title: string | null
  platform: string | null
  topic: string | null
  source_topic_id: string | null
  content: string | null
  status: string
  published_at: number | null
  effect_note: string | null
  created_at: number
  updated_at: number
}

/** `content_versions` 表一行 */
export interface ContentVersionRow {
  id: string
  content_id: string
  version: number
  content: string
  source: string | null
  prompt: string | null
  created_at: number
}

/** 检索/列表命中（UI 展示列） */
export interface ContentListOptions {
  status?: string | null
  platform?: string | null
  limit?: number
}

export interface CreateContentInput {
  title?: string | null
  platform?: string | null
  topic?: string | null
  content?: string | null
  /** 热点雷达 payload 溯源（§七 v1.10）；null/缺省 = 与热点无关 */
  sourceTopicId?: string | null
}

/** §五 update 白名单（id/project_id/created_at/source_topic_id 是身份与溯源，不可改） */
export interface UpdateContentInput {
  title?: string | null
  platform?: string | null
  topic?: string | null
  content?: string | null
  status?: string
  /** 发布时刻（epoch ms）；status 改到 published 且未给 → 自动补 now（v1.13 唯一真相来源） */
  published_at?: number | null
  /** 效果备注（三期 Learning 的真实标签来源；人工手填） */
  effect_note?: string | null
}

export interface SaveVersionInput {
  /** 版本正文（老板手改后保存 source='user'，或采纳某 AI 版时随附） */
  content: string
  source?: string
  /** source='ai' 时的 prompt 快照；source='user' 忽略（§四：NULL） */
  prompt?: string | null
}

export interface GenerateContentSpec {
  /** 为既有草稿再生成（不给 = 自动新建一条 draft） */
  contentId?: string | null
  /** 发布平台（必填：内容总得是给某个平台的） */
  platform: string
  /** 选题/主题（老板输入或热点 payload 带入） */
  topic?: string | null
  title?: string | null
  /** 本次针对的具体客户/场景（可空） */
  customer?: string | null
  /** 新建草稿时的热点溯源（payload.topic_id） */
  sourceTopicId?: string | null
  /** 超预算 LIKE 裁剪关键词；缺省用 topic */
  query?: string | null
  /** 外部中止信号（面板卸载/切商家，08 同款） */
  signal?: AbortSignal
}

export interface GenerationStreamInfo {
  /** 转发给渲染端的 streamId（`<genTaskId>-<角度key>`） */
  streamId: string
  angle: GenerationAngle
}

/** 一轮生成（IPC 层拿 angles[].streamId 去 forwardGatewayStream；cancel 中止全部三路） */
export interface ContentGenerationRun {
  genTaskId: string
  projectId: string
  /** 三路共写这一条草稿 */
  contentId: string
  platform: Platform
  topic: string | null
  pack: ContextPack
  /** 本次 prompt 快照（三路共享同一 Context Pack；角度差异在各自流里体现） */
  promptSnapshot: string
  angles: GenerationStreamInfo[]
  /** 每条流的聚合句柄（iterator + result[resolve 前已落版本行] + cancel） */
  streams: Array<GatewayStreamHandle>
  cancel(): void
}

export interface ContentManagerOptions {
  database: DatabaseClient
  /** 06 引擎（唯一上下文来源） */
  contextEngine: ContextEngine
  /** 07 客户端（唯一出站通道；硬规则 13） */
  gateway: GatewayClient
  logger?: (message: string) => void
  listLimit?: number
}

// ── ContentManager ────────────────────────────────────────────────────────────

let genTaskSeq = 0

export class ContentManager {
  private readonly database: DatabaseClient
  private readonly contextEngine: ContextEngine
  private readonly gateway: GatewayClient
  private readonly logger?: (message: string) => void
  private readonly listLimit: number
  /** 在途生成任务（genTaskId → cancel）；abort 两路定位与 before-quit 都查这张表 */
  private readonly activeGenerations = new Map<string, { cancel: () => boolean; projectId: string }>()

  constructor(options: ContentManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContentManager 需要注入式依赖配置')
    }
    if (!options.database || typeof options.database.request !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContentManager 缺少依赖: database')
    }
    if (!options.contextEngine || typeof options.contextEngine.buildContextPack !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContentManager 缺少依赖: contextEngine（06）')
    }
    if (!options.gateway || typeof options.gateway.createChatStream !== 'function') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContentManager 缺少依赖: gateway（07）')
    }
    this.database = options.database
    this.contextEngine = options.contextEngine
    this.gateway = options.gateway
    this.logger = options.logger
    this.listLimit = clamp(options.listLimit, DEFAULT_LIST_LIMIT, 1, 5000)
  }

  private log(message: string): void {
    this.logger?.(message)
  }

  // ── 列表 / 单条 ────────────────────────────────────────────────────────────

  async listContents(projectId: string, options: ContentListOptions = {}): Promise<ContentRow[]> {
    const pid = requireId(projectId, 'listContents')
    const where: Record<string, unknown> = { project_id: pid }
    if (options.status) where.status = requireStatus(options.status)
    if (options.platform) where.platform = requirePlatform(options.platform)
    const rows = await this.database.request<ContentRow[]>('contents.list', {
      where,
      order: ['created_at', 'id'],
      limit: clamp(options.limit, this.listLimit, 1, 5000)
    })
    const list = Array.isArray(rows) ? rows : []
    // 新草稿排前面（05a 同口径：服务端 ASC，展示序在 manager 收敛）
    return list.slice().sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /** 单条；不存在或跨 Project → NOT_FOUND */
  async getContent(projectId: string, id: string): Promise<ContentRow> {
    const pid = requireId(projectId, 'getContent')
    const cid = requireText(id, 'getContent', 'id')
    const row = await this.database.request<ContentRow | null>('contents.get', { keys: { id: cid } })
    if (!row || row.project_id !== pid) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `内容不存在: ${cid}`, { projectId: pid, id: cid })
    }
    return row
  }

  // ── 创建 / 更新 / 删除 ─────────────────────────────────────────────────────

  /** 手工新建（多数时候是空草稿/只填选题；带热点 payload 时校验 source_topic_id 真实存在） */
  async createContent(projectId: string, input: CreateContentInput): Promise<ContentRow> {
    const pid = requireId(projectId, 'createContent')
    await assertProjectExists(this.database, pid)
    const platform = optionalPlatform(input?.platform)
    const sourceTopicId = await assertSourceTopic(this.database, input?.sourceTopicId)
    const now = Date.now()
    const row: ContentRow = {
      id: randomUUID(),
      project_id: pid,
      title: normalizeTitle(input?.title),
      platform,
      topic: normalizeTopic(input?.topic),
      source_topic_id: sourceTopicId,
      content: normalizeBody(input?.content),
      status: 'draft',
      published_at: null,
      effect_note: null,
      created_at: now,
      updated_at: now
    }
    const res = await this.database.request<{ row: ContentRow }>('contents.create', { data: row })
    const saved = res?.row ?? (await this.getContent(pid, row.id))
    this.log(`[content] 新建草稿 ${saved.id}（project=${pid} platform=${platform ?? '-'} topic=${String(saved.topic ?? '').slice(0, 30)}）`)
    return saved
  }

  /**
   * 白名单更新（title/platform/topic/content/status/published_at/effect_note）。
   * 空 patch → 原样返回不刷 updated_at（05a 口径）。
   * 发布语义（v1.13）：status 改到 published → published_at 自动补 now（除非显式给了合法值）；
   * 发布要求正文非空（「标记已发布」的前提是有一篇成稿）。
   */
  async updateContent(projectId: string, id: string, patch: UpdateContentInput): Promise<ContentRow> {
    const pid = requireId(projectId, 'updateContent')
    const existing = await this.getContent(pid, id)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'updateContent 需要一个 patch 对象', { field: 'patch' })
    }
    const allowed = ['title', 'platform', 'topic', 'content', 'status', 'published_at', 'effect_note']
    const unknown = Object.keys(patch).filter((k) => !allowed.includes(k))
    if (unknown.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不允许更新的字段: ${unknown.join(', ')}`, {
        fields: unknown,
        allowed
      })
    }
    const data: Partial<Record<keyof ContentRow, unknown>> = {}
    if (has(patch, 'title')) data.title = normalizeTitle(patch.title)
    if (has(patch, 'platform')) data.platform = optionalPlatform(patch.platform)
    if (has(patch, 'topic')) data.topic = normalizeTopic(patch.topic)
    if (has(patch, 'content')) data.content = normalizeBody(patch.content)
    if (has(patch, 'status')) data.status = requireStatus(patch.status as string)
    if (has(patch, 'effect_note')) data.effect_note = normalizeEffectNote(patch.effect_note)
    if (has(patch, 'published_at')) data.published_at = normalizePublishedAt(patch.published_at)

    // 发布校验 + published_at 自动补：以「本次落库后的最终状态」为准（patch 或沿用旧值）
    const finalStatus = (data.status as string | undefined) ?? existing.status
    if (finalStatus === 'published') {
      const finalBody = has(data, 'content') ? String(data.content ?? '').trim() : String(existing.content ?? '').trim()
      if (!finalBody) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          '还没有正文，不能标记为已发布（发布 = 人工对成稿的确认动作）',
          { field: 'content', reason: 'publish-without-content' }
        )
      }
      if (!has(data, 'published_at') && !existing.published_at) data.published_at = Date.now()
    }
    // 从 published 改回其它状态：published_at 保留为「最近一次发布时间」（不制造两个真相）
    const changed = Object.keys(data).length > 0
    if (!changed) return existing
    data.updated_at = Date.now()
    const res = await this.database.request<{ row: ContentRow }>('contents.update', {
      keys: { id: existing.id },
      data: { ...data, id: existing.id, project_id: pid }
    })
    const saved = res?.row ?? (await this.getContent(pid, existing.id))
    this.log(`[content] 已更新 ${existing.id}（status=${saved.status}）`)
    return saved
  }

  /** 删除内容（幂等；versions 随 FK CASCADE） */
  async deleteContent(
    projectId: string,
    id: string
  ): Promise<{ projectId: string; id: string; deleted: boolean }> {
    const pid = requireId(projectId, 'deleteContent')
    const cid = requireText(id, 'deleteContent', 'id')
    const row = await this.database.request<ContentRow | null>('contents.get', { keys: { id: cid } })
    if (!row || row.project_id !== pid) return { projectId: pid, id: cid, deleted: false }
    await this.database.request('contents.delete', { keys: { id: cid } })
    this.log(`[content] 已删除 ${cid}（project_id=${pid}，版本级联清除）`)
    return { projectId: pid, id: cid, deleted: true }
  }

  // ── 版本 ───────────────────────────────────────────────────────────────────

  /** 该内容的版本清单（version 升序；UI 历史面板直接渲染） */
  async listVersions(projectId: string, id: string): Promise<ContentVersionRow[]> {
    const pid = requireId(projectId, 'listVersions')
    const content = await this.getContent(pid, id)
    const rows = await this.database.request<ContentVersionRow[]>('content_versions.list', {
      where: { content_id: content.id },
      order: ['version', 'id'],
      limit: 5000
    })
    const list = Array.isArray(rows) ? rows : []
    return list.slice().sort((a, b) => a.version - b.version)
  }

  /**
   * 保存一个版本（老板改稿 → source='user'，prompt=NULL；§四）。
   * `activate=true` 时同时把正文写回 contents.content（「用这版」语义——
   * 采纳 AI 版本走 updateContent，不需要版本层动作）。
   */
  async saveVersion(
    projectId: string,
    id: string,
    input: SaveVersionInput,
    options: { activate?: boolean } = {}
  ): Promise<{ version: ContentVersionRow; content: ContentRow }> {
    const pid = requireId(projectId, 'saveVersion')
    const content = await this.getContent(pid, id)
    const source = normalizeVersionSource(input?.source)
    const body = truncateContent(requireBody(input?.content, 'saveVersion'))
    const prompt = source === 'ai' ? truncatePrompt(optionalText(input?.prompt) || '（prompt 快照缺失）') : null
    const version = await this.appendVersion(content.id, body, source, prompt)
    let savedContent = content
    if (options.activate && content.content !== body) {
      savedContent = await this.updateContent(pid, content.id, { content: body })
    }
    this.log(`[content] ${content.id} 存版本 v${version.version}（source=${source}${options.activate ? '，并设为正文' : ''}）`)
    return { version, content: savedContent }
  }

  // ── 生成（一次 3 版供选） ──────────────────────────────────────────────────

  /**
   * 发起一轮生成：3 个固定角度 = 3 条并行流。返回三路聚合句柄
   * （`result.resolve` 前该角度的版本行已落库——abort 的流不落）。
   */
  async generate(projectId: string, spec: GenerateContentSpec): Promise<ContentGenerationRun> {
    const pid = requireId(projectId, 'generate')
    const platform = requirePlatform(spec?.platform)
    const topic = normalizeTopic(spec?.topic)
    await assertProjectExists(this.database, pid)

    // 草稿先行：三路共写一条，生成前就有 contentId（中止时老板至少能看到「生成到一半的草稿」载体）
    let contentId = optionalText(spec?.contentId)
    if (contentId) {
      const existing = await this.getContent(pid, contentId)
      contentId = existing.id
    } else {
      const created = await this.createContent(pid, {
        title: spec?.title ?? null,
        platform,
        topic,
        sourceTopicId: spec?.sourceTopicId ?? null
      })
      contentId = created.id
    }

    // Context Pack（06）：task 固定 + query 用选题（超预算 LIKE 裁剪，§六）
    const pack = await this.contextEngine.buildContextPack(pid, {
      platform,
      task: 'content-draft',
      customer: normalizeOptionalText(spec?.customer, 1_000, 'customer'),
      query: normalizeOptionalText(spec?.query ?? topic, 200, 'query')
    })
    const promptSnapshot = buildPromptSnapshot(pack, platform, topic)

    const genTaskId = `content-${++genTaskSeq}-${Date.now().toString(36)}`
    const controller = new AbortController()
    if (spec?.signal) {
      if (spec.signal.aborted) controller.abort()
      else spec.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let cancelled = controller.signal.aborted

    const streams: Array<GatewayStreamHandle> = []
    const handles: GatewayStreamHandle[] = []
    const cancel = (): boolean => {
      if (cancelled) return false
      cancelled = true
      controller.abort()
      for (const h of handles) {
        try {
          h.cancel()
        } catch {
          /* 尽力 */
        }
      }
      return true
    }
    this.activeGenerations.set(genTaskId, { cancel, projectId: pid })

    try {
      for (let i = 0; i < CONTENT_GENERATION_ANGLES.length; i++) {
        const angle = CONTENT_GENERATION_ANGLES[i]
        const raw = this.gateway.createChatStream({
          projectId: pid,
          // 每角度独立会话键：三路并行不共用 sticky user（并发写会互相穿插），
          // 也不进商家 Advisor 的历史（05b 同口径）
          conversationKey: `content-${genTaskId}-a${i}`,
          messages: buildGenerationMessages(pack, platform, topic, angle, promptSnapshot),
          temperature: 0.8, // 创作允许发挥；护栏在 system 里兜底（08 的 0 是给「忠实转录/回答」的）
          signal: controller.signal
        })
        handles.push(raw)
        streams.push(wrapHandleSaveVersion(raw, {
          isCancelled: () => cancelled || controller.signal.aborted,
          persist: (text) => this.persistAiVersion(contentId, text, angle, promptSnapshot)
        }))
      }
    } catch (e) {
      this.activeGenerations.delete(genTaskId)
      cancel()
      throw e
    }

    const run: ContentGenerationRun = {
      genTaskId,
      projectId: pid,
      contentId,
      platform,
      topic,
      pack,
      promptSnapshot,
      angles: CONTENT_GENERATION_ANGLES.map((angle) => ({
        streamId: `${genTaskId}-${angle.key}`,
        angle
      })),
      streams,
      cancel: () => {
        cancel()
      }
    }
    this.log(
      `[content] generate ${genTaskId} → ${contentId}（platform=${platform}，3 路并行，knowledge=${pack.knowledge.length}）`
    )
    // 三路全部落定后注销（版本行在各流 resolve 里已各自落库）
    void Promise.allSettled(streams.map((s) => s.result)).finally(() => {
      this.activeGenerations.delete(genTaskId)
    })
    return run
  }

  /** abort 两路定位（05b 同语义）：taskId 优先，回落 projectId；返回是否命中 */
  cancelGeneration(genTaskId: string): boolean {
    const id = typeof genTaskId === 'string' ? genTaskId.trim() : ''
    const entry = id ? this.activeGenerations.get(id) : undefined
    return entry ? entry.cancel() : false
  }

  cancelGenerationByProject(projectId: string): number {
    const pid = typeof projectId === 'string' ? projectId.trim() : ''
    if (!pid) return 0
    let n = 0
    for (const [, entry] of [...this.activeGenerations]) {
      if (entry.projectId !== pid) continue
      try {
        if (entry.cancel()) n += 1
      } catch {
        /* 尽力中止 */
      }
    }
    return n
  }

  cancelAllGenerations(): number {
    let count = 0
    for (const [, entry] of this.activeGenerations) {
      try {
        if (entry.cancel()) count += 1
      } catch {
        /* 忽略：尽力中止 */
      }
    }
    this.activeGenerations.clear()
    return count
  }

  activeGenerationCount(): number {
    return this.activeGenerations.size
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /** 生成成功文本 → 版本行（版本写入在 appendVersion 里按 contentId 串行化） */
  private async persistAiVersion(
    contentId: string,
    text: string,
    angle: GenerationAngle,
    promptSnapshot: string
  ): Promise<ContentVersionRow> {
    const body = truncateContent(normalizeRecognizedBody(text))
    if (!body) {
      // 模型空输出：不落空版本（UI 该版本位显示「未产出」并给重试入口）
      throw new AppError(ERROR_CODES.FILE_PARSE_ERROR, `「${angle.label}」角度未产出正文`, {
        contentId,
        angle: angle.key,
        reason: 'empty-generation'
      })
    }
    // §四：source='ai' 的 prompt 必带快照（角度差异也在快照里体现）
    const prompt = truncatePrompt(promptSnapshot + `\n【本版角度】${angle.label}：${angle.instruction}`)
    return this.appendVersion(contentId, body, 'ai', prompt)
  }

  /**
   * 存版本（按 contentId 串行化）。
   *
   * 三路流式生成**并行**完成时，两个 persist 可能同时读到同一个 maxVersion → 写出重复 v 号
   * （表上没有 UNIQUE(content_id,version)，DB 不会拦）。这里用 per-key promise 链把
   * 「读最大号 → 写新行」锁成互斥段；同一草稿的并发生成/手存版本全部排队。
   */
  private readonly versionWriteChain = new Map<string, Promise<unknown>>()

  private async appendVersion(
    contentId: string,
    body: string,
    source: ContentVersionSource,
    prompt: string | null
  ): Promise<ContentVersionRow> {
    const run = () => this.appendVersionLocked(contentId, body, source, prompt)
    const prev = this.versionWriteChain.get(contentId) ?? Promise.resolve()
    const next = prev.then(run, run)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.versionWriteChain.set(contentId, tail)
    try {
      return await next
    } finally {
      if (this.versionWriteChain.get(contentId) === tail) this.versionWriteChain.delete(contentId)
    }
  }

  private async appendVersionLocked(
    contentId: string,
    body: string,
    source: ContentVersionSource,
    prompt: string | null
  ): Promise<ContentVersionRow> {
    const rows = await this.database.request<ContentVersionRow[]>('content_versions.list', {
      where: { content_id: contentId },
      order: ['version'],
      limit: 5000
    })
    const list = Array.isArray(rows) ? rows : []
    const maxVersion = list.reduce((m, v) => Math.max(m, Number(v.version) || 0), 0)
    const row: ContentVersionRow = {
      id: randomUUID(),
      content_id: contentId,
      version: maxVersion + 1,
      content: body,
      source,
      prompt,
      created_at: Date.now()
    }
    const res = await this.database.request<{ row: ContentVersionRow }>('content_versions.create', { data: row })
    return res?.row ?? row
  }
}

export function createContentManager(options: ContentManagerOptions): ContentManager {
  return new ContentManager(options)
}

// ── 聚合句柄：done 之前落版本行（渲染端收到 done 必然能读到版本） ─────────────

/**
 * 包一层 07 的 handle：iterator 原样透传；`result` resolve 前把成功文本落成版本行。
 * - 中止（自己 cancel 或 aborted 结果）→ 不落版本，原样回传 `{aborted:true}`；
 * - 上游失败 → 不吞错，原 reject（07 语义：失败按 §五 码透传）；
 * - 落库自身失败 → reject（「done 已到但版本没落」是最坏竞态，宁可变错误）。
 */
export function wrapHandleSaveVersion(
  raw: GatewayStreamHandle,
  hooks: { isCancelled: () => boolean; persist: (text: string) => Promise<unknown> }
): GatewayStreamHandle {
  const result = raw.result.then(
    async (r: GatewayStreamResult): Promise<GatewayStreamResult> => {
      if (hooks.isCancelled() || r.aborted) return r
      if (r.text.trim()) await hooks.persist(r.text)
      return r
    }
  )
  result.catch(() => undefined)
  return {
    iterator: raw.iterator,
    result,
    cancel: () => raw.cancel()
  }
}

// ── 消息组装（纯函数，验收直接断言） ─────────────────────────────────────────

export function buildGenerationMessages(
  pack: ContextPack,
  platform: Platform,
  topic: string | null,
  angle: GenerationAngle,
  promptSnapshot: string
): GatewayChatMessage[] {
  void promptSnapshot // system 里只放护栏；Context Pack 快照随版本落库，不重复塞进每条请求
  const instruction = [
    `发布平台：${platform}。`,
    topic ? `选题/主题：${topic}。` : '选题：由你从商家资料里挑一个最能打的点。',
    `本版风格：${angle.label}。${angle.instruction}`,
    pack.businessCompleteness.missing.length
      ? `资料缺口：${pack.businessCompleteness.missing.join('、')}（涉及缺口时按护栏第 2 条诚实处理）。`
      : '',
    '',
    '——— 商家资料（唯一事实来源） ———',
    renderContextPackText(pack),
    '',
    // 规则正文取 pack.platformRule（06 挂载，与 pack 同源）——不用 platform 现查全局模板，
    // 防 pack 语境与注入规则两条派生链漂移（快照复盘「当时提示词」依赖这个同源）
    renderPackRuleSection(platform, pack.platformRule)
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: CONTENT_GUARDRAILS },
    { role: 'user', content: [textPart(instruction)] }
  ]
}

/** prompt 快照正文（§四：source=ai 必存）：平台 + 选题 + Context Pack 全文 */
export function buildPromptSnapshot(pack: ContextPack, platform: Platform, topic: string | null): string {
  return [
    `【任务】content-draft（平台=${platform}）`,
    `【选题】${topic || '（由模型自选）'}`,
    '',
    renderContextPackText(pack),
    '',
    renderPackRuleSection(platform, pack.platformRule)
  ].join('\n')
}

/** 生成文本整理：剥围栏 + 压多余空行（与 05b normalizeRecognizedText 同思路，成稿导向） */
export function normalizeRecognizedBody(raw: string): string {
  return String(raw ?? '')
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── 校验辅助 ─────────────────────────────────────────────────────────────────

function requireId(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 projectId`, { field: 'projectId' })
  }
  return value.trim()
}

function requireText(value: unknown, method: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要 ${field}`, { field })
  }
  return value.trim()
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requirePlatform(value: unknown): Platform {
  const p = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!(CONTENT_PLATFORMS as readonly string[]).includes(p)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `发布平台只支持 ${CONTENT_PLATFORMS.join(' / ')}（实际 ${p || '（空）'}）`, {
      field: 'platform',
      allowed: [...CONTENT_PLATFORMS]
    })
  }
  return p as Platform
}

function optionalPlatform(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  return requirePlatform(raw)
}

function requireStatus(value: string): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!(CONTENT_STATUSES as readonly string[]).includes(s)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `非法内容状态: ${value}`, {
      field: 'status',
      allowed: [...CONTENT_STATUSES]
    })
  }
  return s
}

function normalizeVersionSource(value: unknown): ContentVersionSource {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!s) return 'user' // 老板手存版本是主路径
  if (!(CONTENT_VERSION_SOURCES as readonly string[]).includes(s)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `版本来源只支持 ai/user（实际 ${s}）`, {
      field: 'source',
      allowed: [...CONTENT_VERSION_SOURCES]
    })
  }
  return s as ContentVersionSource
}

function normalizeTitle(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  const t = raw.replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > CONTENT_TITLE_MAX_LENGTH ? t.slice(0, CONTENT_TITLE_MAX_LENGTH) : t
}

function normalizeTopic(value: unknown): string | null {
  return normalizeOptionalText(value, CONTENT_TOPIC_MAX_LENGTH, 'topic')
}

function normalizeBody(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const t = truncateContent(String(value).replace(/\r\n?/g, '\n'))
  return t || null
}

function normalizeEffectNote(value: unknown): string | null {
  return normalizeOptionalText(value, CONTENT_EFFECT_NOTE_MAX_LENGTH, 'effect_note')
}

function normalizePublishedAt(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'published_at 必须是正数时间戳（epoch ms）或 null', {
      field: 'published_at'
    })
  }
  return Math.floor(n)
}

function normalizeOptionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null
  const raw = String(value).replace(/\r\n?/g, '\n').trim()
  if (!raw) return null
  if (raw.length > max * 3) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} 过长（${raw.length} > ${max * 3}）`, {
      field,
      max: max * 3
    })
  }
  return raw.length > max ? raw.slice(0, max) : raw
}

function requireBody(value: unknown, method: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${method} 需要非空正文`, { field: 'content' })
  }
  return value
}

/** 热点溯源预检：给了就必须是真实存在的 hot_topics 行（FK 错误翻成人话） */
async function assertSourceTopic(database: DatabaseClient, value: unknown): Promise<string | null> {
  const id = optionalText(value)
  if (!id) return null
  const row = await database.request<{ id: string } | null>('hot_topics.get', { keys: { id } })
  if (!row) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `溯源热点不存在: ${id}`, {
      field: 'sourceTopicId',
      reason: 'source-topic-not-found'
    })
  }
  return id
}

function truncateContent(content: string): string {
  const t = content.trim()
  if (t.length <= CONTENT_BODY_MAX_LENGTH) return t
  return t.slice(0, CONTENT_BODY_MAX_LENGTH) + CONTENT_TRUNCATE_MARKER
}

function truncatePrompt(prompt: string): string {
  return prompt.length <= CONTENT_PROMPT_MAX_LENGTH ? prompt : prompt.slice(0, CONTENT_PROMPT_MAX_LENGTH) + CONTENT_TRUNCATE_MARKER
}

function has<T extends object>(obj: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function clamp(value: unknown, def: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.max(Math.floor(n), min), max)
}

async function assertProjectExists(database: DatabaseClient, projectId: string): Promise<void> {
  const row = await database.request<{ id: string } | null>('projects.get', { keys: { id: projectId } })
  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Project 不存在: ${projectId}`, { projectId })
  }
}
