// src/composables/useContentPrefill.ts —— 热点雷达 → Content Center 的结构化 payload 接收（Commit 09）
//
// §五/§七（v1.9）：11 的「带去 Content Center」按钮携带
//   `{ topic_id, title, source_platform, platform, content_angle, lifecycle_advice }`
// 预填充 09 的生成表单；11 的按钮在 09 上线前只是占位禁用，**接收端由 09 先备好**。
//
// 机制刻意做小：模块级单例 + `set`（11 跳转前写入）/`consume`（ContentCenter 挂载时取一次即清），
// 不引 router query 序列化（payload 字段多且含中文长文本，hash 路由下 URL 会很难看）；
// 跳转动作本身（router.push('/marketing/content')）由 11 完成后调用 set。
//
// 溯源口径（§四）：`source_topic_id` = payload.topic_id，只有经这里带来的草稿才有值；
// 手工新建/编辑都不碰它（manager 的 update 白名单也不含它——身份与溯源不可改）。

/** 11 携带的结构化 payload（字段形状写死于 §五 v1.9；11 实现时必须逐字段对齐） */
export interface HotTopicPayload {
  /** hot_topics.id —— 落 contents.source_topic_id（11/12 未上线前不会有真值） */
  topicId: string
  /** 热点标题（预填「选题」） */
  title: string
  /** 来源平台（douyin/weibo/…，仅展示用，不进 contents.platform） */
  sourcePlatform: string | null
  /** 发布平台（xiaohongshu/douyin → 预填平台选择） */
  platform: string | null
  /** AI 建议的内容角度（拼进选题补充说明） */
  contentAngle: string | null
  /** 生命周期建议（只展示，不进正文） */
  lifecycleAdvice: string | null
}

let pending: HotTopicPayload | null = null

export function setContentPrefill(payload: HotTopicPayload): void {
  pending = payload
}

/** 取一次即清（防刷新/重进页面重复弹面板） */
export function consumeContentPrefill(): HotTopicPayload | null {
  const value = pending
  pending = null
  return value
}

/** 只读窥视（单测/调试用；不清空） */
export function peekContentPrefill(): HotTopicPayload | null {
  return pending
}

export function useContentPrefill() {
  return { setContentPrefill, consumeContentPrefill, peekContentPrefill }
}
