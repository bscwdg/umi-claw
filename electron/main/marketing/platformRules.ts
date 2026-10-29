// platformRules.ts —— 双平台规则模板（PLAN-2.0.md Commit 10）
//
// 契约（§七 Commit 10 / §一 产品智能四个输入之「平台规则」/ §六 Context Pack）：
//   - 交付物：**小红书 + 抖音两套平台规则模板**，由 06 引擎挂到 Context Pack 的
//     `platformRule` 字段，08/09 在拼请求时作为独立区块注入（模板 = 成稿规格）。
//   - **小红书**：图文笔记文案层（标题 + 正文 + 话题标签），不产图、不产视频。
//   - **抖音**：一期**只做文案层**（口播脚本 + 标题 + 话题标签），**不做视频**；
//     两个平台都**人工复制发布**（硬规则 10：永不自动发布）。
//   - **预算口径（§六）**：模板在 business+knowledge 的 60% 预算**之外**（其余 40% 留给
//     对话历史/生成/平台规则）——因此模板不进 `renderContextPackText` 的账本文本，
//     由消费方在 Pack 之后另起区块注入。
//   - 纯数据 + 纯函数：不 import electron、不发 HTTP、不落库（与硬规则 12/13 同精神），
//     esbuild bundle 后可直接在纯 Node 验收（test/platform.accept.mjs）。

import { AppError, ERROR_CODES } from '../database/errors'
import type { Platform } from './contextEngine'

// ── 平台展示名（主进程侧单一真相；渲染端 ContentCenter 另有同形小常量，不上 IPC） ──

export const PLATFORM_LABELS: Record<Platform, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音'
}

// ── 规则模板正文（α 面向摄影店/女装店这类本地小老板：具体、可执行、守合规） ──────

interface PlatformRuleSpec {
  /** 平台形态与一期边界（一句话，UI/日志可用） */
  scope: string
  /** 本平台成稿的组成件（生成结果应包含的板块，提示词里强制成稿结构） */
  deliverables: string
  /** 模板正文（注入请求的成稿规格） */
  body: string
}

const XIAOHONGSHU_RULE: PlatformRuleSpec = {
  scope: '图文笔记文案（标题 + 正文 + 话题标签），不产图、不产视频',
  deliverables: '标题 + 正文 + 话题标签',
  body: [
    '平台形态：小红书是「图文笔记」社区，一期只产出文案——封面与配图由老板自己拍摄，你不要描述或编造图片。',
    '',
    '成稿必须包含三个部分：',
    '1）标题：不超过 20 个字。用具体数字、真实反差、客户痛点或明确利益点开头（如「杭州拍婚纱照，5999 拿到了什么」），',
    '   不许标题党、不许悬念骗点；不得使用「最、第一、顶级、绝对、100%、必看」等绝对化用语。',
    '2）正文：300-600 字。前两行必须给出钩子或结论（用户不点「展开」也看得懂重点）；',
    '   按 2-4 行一小段分段，可少量使用 emoji 点缀但不得堆砌；用真实体验/分享口吻，软广不硬销；',
    '   只写商家资料里出现过的价格、套餐、承诺与案例，资料没有的就不写或写「具体到店咨询」。',
    '3）话题标签：3-6 个，组合 = 1 个行业大词 + 1-2 个本地/场景词 + 1-2 个长尾需求词，用 #标签 形式列在文末。',
    '',
    '合规红线：不写绝对化用语；不写医疗功效或保证性承诺；不编造客户评价、销量与资质；不贬低同行。',
    '如确有必要可在正文最后另起一行写「配图建议」，仅给老板自拍的文字建议（场景/角度），不得假装图片已存在。',
    '',
    '发布方式：成稿只供复制，老板自行配图、自行人工复制发布；你不代表账号做任何发布动作。'
  ].join('\n')
}

const DOUYIN_RULE: PlatformRuleSpec = {
  scope: '短视频口播的文案层（口播脚本 + 标题 + 话题标签），一期不做视频',
  deliverables: '口播脚本 + 标题 + 话题标签',
  body: [
    '平台形态：抖音是短视频平台，但一期只做文案层——产出可以直接照着念的口播脚本，',
    '不做视频、不产出分镜画面（最多给一句口播节奏提示），也不描述成片画面。',
    '',
    '成稿必须包含三个部分：',
    '1）口播脚本：时长按 30-60 秒设计，约 120-220 字。前 3 秒必须是钩子（一个问题/一个反差/一个直接利益点）；',
    '   全程短句口语化，一句只讲一件事，念起来不绕口；中段给事实与细节（只允许引用商家资料里有的信息）；',
    '   结尾给一个明确的行动引导（私信关键词 / 到店咨询 / 评论区提问，三选一，按商家资料选择）。',
    '2）标题/封面文字：不超过 15 个字，口语化钩子，和口播开头呼应；不得使用「最、第一、绝对、100%」等绝对化用语。',
    '3）话题标签：3-5 个，组合 = 1 个行业大词 + 1-2 个本地/场景词 + 1 个长尾需求词，用 #标签 形式列在脚本最后。',
    '',
    '合规红线：不写绝对化用语；不承诺疗效/效果保证；不编造客户反馈、销量与资质；不贬低同行。',
    '',
    '发布方式：成稿只供复制到提词器或发布框，老板自行拍摄、自行人工复制发布；你不代表账号做任何发布动作。'
  ].join('\n')
}

const RULES: Record<Platform, PlatformRuleSpec> = {
  xiaohongshu: XIAOHONGSHU_RULE,
  douyin: DOUYIN_RULE
}

/** 平台规则是否存在（不抛错的形态，供 UI/过滤场景） */
export function isPlatform(value: string): value is Platform {
  return Object.prototype.hasOwnProperty.call(RULES, value)
}

/** 校验并收窄平台；非法 → VALIDATION_ERROR（不静默归一，防拼错 key 后悄悄裸奔） */
function requirePlatform(platform: string): Platform {
  if (!isPlatform(platform)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `不支持的发布平台: ${platform}`, {
      field: 'platform',
      value: platform,
      allowed: Object.keys(RULES)
    })
  }
  return platform
}

/** 取规则正文；非法平台 → VALIDATION_ERROR */
export function getPlatformRule(platform: string): string {
  return RULES[requirePlatform(platform)].body
}

/** 平台一句话边界（scope + deliverables；UI 提示/日志用） */
export function getPlatformScope(platform: string): string {
  const spec = RULES[requirePlatform(platform)]
  return `${spec.scope}；成稿组成：${spec.deliverables}`
}

/**
 * 注入区块（紧跟 Context Pack 文本之后）：
 *
 * ```
 * 【发布平台规则：小红书（xiaohongshu）】
 * <模板正文>
 * ```
 *
 * 格式单一真相（formatRuleSection），两个入口按规则正文的来源分：
 *   - renderPlatformRuleSection(platform)：直接查全局模板（探针/无 pack 场景/验收）；
 *   - renderPackRuleSection(platform, rule)：用 pack.platformRule（08/09 生产路径）——
 *     规则随 Pack 同源携带，pack 没带 = 构造路径漏挂或拿旧 pack 换平台，报错不裸奔，
 *     堵「pack 语境与注入规则两套派生链各自漂移」的口子（§四 v1.10 快照复盘依赖这个同源）。
 */
function formatRuleSection(platform: Platform, body: string): string {
  return [`【发布平台规则：${PLATFORM_LABELS[platform]}（${platform}）】`, body].join('\n')
}

export function renderPlatformRuleSection(platform: string): string {
  const p = requirePlatform(platform)
  return formatRuleSection(p, RULES[p].body)
}

/** 生产消费入口：规则正文必须来自 pack.platformRule（与 pack 同源），缺失即 VALIDATION_ERROR */
export function renderPackRuleSection(platform: string, rule: string | null): string {
  const p = requirePlatform(platform)
  if (!rule) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'ContextPack 缺少平台规则正文（platformRule 为空）', {
      field: 'platformRule',
      value: platform
    })
  }
  return formatRuleSection(p, rule)
}
