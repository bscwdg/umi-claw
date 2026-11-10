// resources/openclaw-plugins/feiyu-guard/guard.mjs —— OpenClaw hook 注册与执行（依赖可注入）
//
// 为什么单独一层：registerGuard 用 fake api 就能在 accept 里跑完所有分支（不需要真
// Gateway）；时钟与状态文件读写都经 deps 注入，测试可以模拟「状态损坏 / 读失败 / 写失败 /
// 跨天 / 并发」。index.mjs 只负责 SDK 入口，任何策略逻辑都不进那一层。
//
// **fail-open 是硬要求**：
// - 判定不了群/私聊（to/sessionKey/channelId 都缺失）→ 放行；
// - 私聊（qqbot:direct 或 sessionKey 无 :group:）→ 放行；
// - 配置版本不认识、状态文件读/写失败、JSON 损坏、statePath 为空 → 只记日志，继续放行；
// - handler 内部任何异常都自己吞掉：before_tool_call 的失败策略是「block」，抛错等于
//   误伤工具调用；message_sending/reply_payload_sending 抛错虽被宿主吞掉，也统一走同一层兜底。
// 只有明确命中「QQ 群 + 策略开关」时才返回 cancel/block/剥离后的 payload。
//
// 三个 hook 覆盖两条出站路径：
// 1) agent 调 qqbot_platform_api 上传群语音 → before_tool_call 拦；
// 2) agent 普通回复自带 audioAsVoice 媒体 → reply_payload_sending 剥离（否则「关群语音」
//    只关掉了平台上传，普通回复仍能发出语音条）；
// 3) 群回复文本/亲密词 → message_sending 改写或取消。

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  GROUP_MEMORY_TOOLS,
  GUARD_CONFIG_VERSION,
  GUARD_REASONS,
  GUARD_TOOL_MATCHERS,
  dayKey,
  filterWords,
  groupKeyFromSessionKey,
  isGroupTarget,
  normalizeState,
  parseGuardConfig,
  payloadHasVisibleContent,
  payloadVoiceInfo,
  voiceCounter,
  voiceUploadGroupId
} from './policy.mjs'

const LOG_PREFIX = '[feiyu-guard]'

/** 默认状态读：ENOENT 视为「还没有状态」，其它错误抛给调用方（调用方只记日志并放行） */
async function defaultReadState(statePath) {
  try {
    const text = await readFile(statePath, 'utf8')
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** 默认状态写：同目录临时文件 + rename，避免半截 JSON；失败时尽力清掉临时文件 */
async function defaultWriteState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true })
  // 并发写会落在同一毫秒，临时名必须带随机段，否则两次写共用 tmp 再 rename 会互相踩
  const suffix = Math.random().toString(36).slice(2, 10)
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.${suffix}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(state), 'utf8')
    await rename(tmpPath, statePath)
  } catch (error) {
    try {
      await unlink(tmpPath)
    } catch {
      /* 临时文件可能压根没创建：忽略 */
    }
    throw error
  }
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function resolveDeps(deps) {
  const src = deps && typeof deps === 'object' ? deps : {}
  const warn =
    typeof src.warn === 'function'
      ? src.warn
      : (message) => {
          try {
            console.warn(LOG_PREFIX, message)
          } catch {
            /* 日志不能再抛 */
          }
        }
  return {
    now: typeof src.now === 'function' ? src.now : () => Date.now(),
    readState: typeof src.readState === 'function' ? src.readState : defaultReadState,
    writeState: typeof src.writeState === 'function' ? src.writeState : defaultWriteState,
    warn
  }
}

/**
 * 语音计数状态容器：进程内缓存是权威（单 Gateway 进程），状态文件只做重启后的恢复。
 * 「先判定、再同步收进缓存、最后异步落盘」的次序保证同进程并发两次上传不会都按旧计数放行；
 * 落盘失败只 warn，返回的放行/拦截结果不变（fail-open：宁可多放一条，也不因 IO 误拦）。
 */
function createStateStore({ statePath, timezone, now, readState, writeState, warn }) {
  let cache = null
  let loading = null
  let warnedNoPath = false

  async function load(day) {
    let raw = null
    try {
      raw = await readState(statePath)
    } catch (error) {
      warn(`state read failed (${statePath || '<empty>'}): ${describeError(error)}`)
    }
    cache = normalizeState(raw, day)
    return cache
  }

  return {
    async snapshot() {
      const day = dayKey(now(), timezone)
      if (cache && cache.day === day) return cache
      if (!statePath) {
        if (!warnedNoPath) {
          warnedNoPath = true
          warn('statePath is empty; voice counters are process-local only')
        }
        cache = normalizeState(null, day)
        return cache
      }
      if (!loading) {
        loading = load(day).finally(() => {
          loading = null
        })
      }
      await loading
      return cache
    },

    async commit(nextState) {
      cache = nextState
      if (!statePath) return
      try {
        await writeState(statePath, nextState)
      } catch (error) {
        warn(`state write failed (${statePath}): ${describeError(error)}`)
      }
    },

    /**
     * 判定 + 占位（同步原子段）：必须紧跟在 `await snapshot()` 之后调用，中间不能再 await，
     * 否则两个并发上传都会拿「加载时的旧计数」放行（实测 cap=2 双发只计到 1）。
     * 返回 { allow, reason } 或 { allow: true, state }（state 已含 +1，供 commit 落盘）。
     */
    reserve({ groupId, enabled, dailyCap } = {}) {
      const day = dayKey(now(), timezone)
      if (!cache || cache.day !== day) cache = normalizeState(null, day)
      const decision = voiceCounter.decide(cache, { groupId, enabled, dailyCap })
      if (!decision.allow) return { allow: false, reason: decision.reason || GUARD_REASONS.VOICE_DAILY_CAP }
      cache = voiceCounter.record(cache, groupId)
      return { allow: true, state: cache }
    }
  }
}

/**
 * 注册 feiyu-guard 的两个 hook。返回 disposer（当前没有需要清理的资源，保留形状给宿主 LIFO）。
 * @param {object} api OpenClaw 插件 API（只用 api.on / api.pluginConfig，fake api 即可测）
 * @param {object} [deps] 可注入依赖：{ now, readState, writeState, warn }
 */
export function registerGuard(api, deps) {
  const noop = () => {}

  // 没有 hook API 的宿主（旧网关/误加载）：不做任何事，也不抛错
  if (!api || typeof api.on !== 'function') return noop

  const resolved = resolveDeps(deps)
  let config
  try {
    config = parseGuardConfig(api.pluginConfig)
  } catch (error) {
    resolved.warn(`config parse failed, guard disabled: ${describeError(error)}`)
    return noop
  }

  // 只认 v1：不认识的版本不猜语义，一刀不拦（fail-open），留日志给排查
  if (config.version !== GUARD_CONFIG_VERSION) {
    resolved.warn(
      `unsupported config version ${String(config.version)} (expected ${GUARD_CONFIG_VERSION}); guard disabled`
    )
    return noop
  }

  const policy = config.policy
  const store = createStateStore({
    statePath: config.statePath,
    timezone: config.timezone,
    now: resolved.now,
    readState: resolved.readState,
    writeState: resolved.writeState,
    warn: resolved.warn
  })
  /** 已计入语音额度的 payload 对象（防同一 payload 重试/重复派发重复占额度） */
  const countedVoicePayloads = new WeakSet()

  /**
   * 语音额度：判定 + 占位 + 落盘（两条出站路径共用同一 group/day 计数）。
   * 返回 { allow, reason }；调用方按路径翻译成 block / 剥离 / cancel。
   */
  async function reserveVoice(groupKey) {
    if (!policy.voice.enabled) {
      return { allow: false, reason: GUARD_REASONS.VOICE_DISABLED }
    }
    await store.snapshot()
    const decision = store.reserve({
      groupId: groupKey,
      enabled: policy.voice.enabled,
      dailyCap: policy.voice.dailyCap
    })
    if (!decision.allow) {
      return { allow: false, reason: decision.reason || GUARD_REASONS.VOICE_DAILY_CAP }
    }
    await store.commit(decision.state)
    return { allow: true, reason: null }
  }

  /**
   * 群语音上传（before_tool_call）：关闭/超上限 → 拦；否则计数 +1 并放行。
   * 返回值是 gate 结果：{ block, blockReason } 或 undefined。
   */
  async function guardVoiceUpload(groupId) {
    const decision = await reserveVoice(groupId)
    if (!decision.allow) {
      return { block: true, blockReason: decision.reason || GUARD_REASONS.VOICE_DAILY_CAP }
    }
    return undefined
  }

  /**
   * 群语音条渠道出站（reply_payload_sending）：关群语音/超上限时**剥离语音部分**，
   * 保留 text 与非音频 media；剥离后无可投递内容才整条 cancel。
   * 允许时不改 payload，只计一次额度（与 platform_api 上传共用计数）；同一个 payload
   * 对象被重复派发（retry / 预览→final）不重复占额度。
   */
  async function guardReplyPayloadVoice(event, ctx) {
    const channelId =
      typeof event?.channel === 'string' && event.channel.trim()
        ? event.channel.trim()
        : ctx?.channelId
    const sessionKey =
      typeof event?.sessionKey === 'string' && event.sessionKey
        ? event.sessionKey
        : ctx?.sessionKey
    const group = isGroupTarget({ channelId, sessionKey })
    if (!group) return undefined

    const payload = event?.payload
    const voice = payloadVoiceInfo(payload)
    if (!voice.isVoice) return undefined

    if (!policy.voice.enabled) {
      return replyForVoicePolicy(voice.payload, GUARD_REASONS.VOICE_DISABLED)
    }

    // 幂等：同一个 payload 对象已经计过额度（重试/同一 payload 再次派发）→ 不再占额度
    if (payload && typeof payload === 'object' && countedVoicePayloads.has(payload)) {
      return undefined
    }

    const groupKey = groupKeyFromSessionKey(sessionKey) || String(sessionKey || 'unknown')
    const decision = await reserveVoice(groupKey)
    if (!decision.allow) {
      return replyForVoicePolicy(
        voice.payload,
        decision.reason || GUARD_REASONS.VOICE_DAILY_CAP
      )
    }
    if (payload && typeof payload === 'object') countedVoicePayloads.add(payload)
    return undefined
  }

  /** 剥离后仍有可见内容 → 交付剥离版；否则整条取消 */
  function replyForVoicePolicy(strippedPayload, reason) {
    if (payloadHasVisibleContent(strippedPayload)) {
      return { payload: strippedPayload, reason }
    }
    return { cancel: true, reason }
  }

  /** message_sending：只处理 QQ 群出站文本；私聊/未知一律 undefined（放行） */
  function handleMessageSending(event, ctx) {
    try {
      const group = isGroupTarget({
        to: event?.to,
        sessionKey: ctx?.sessionKey,
        channelId: ctx?.channelId
      })
      if (!group) return undefined

      if (!policy.replyEnabled) {
        return { cancel: true, cancelReason: GUARD_REASONS.REPLY_DISABLED }
      }

      const filtered = filterWords(event?.content, policy.words)
      if (filtered.cancel) {
        return { cancel: true, cancelReason: GUARD_REASONS.WORD_BLOCKED }
      }
      if (filtered.changed) return { content: filtered.content }
      return undefined
    } catch (error) {
      resolved.warn(`message_sending handler failed, allow: ${describeError(error)}`)
      return undefined
    }
  }

  /**
   * reply_payload_sending：qqbot 群出站 payload 里的语音条（audioAsVoice / audio attachment）。
   * 这是「qqbot 渠道自己发语音」的兜底——只拦 platform_api 上传会漏掉这条路。
   * 任何异常一律 fail-open（返回 undefined 让原 payload 照发）。
   */
  async function handleReplyPayloadSending(event, ctx) {
    try {
      return await guardReplyPayloadVoice(event, ctx)
    } catch (error) {
      resolved.warn(`reply_payload_sending handler failed, allow: ${describeError(error)}`)
      return undefined
    }
  }

  /** before_tool_call：群语音上传闸 + 群记忆隔离；群会话以外一律 undefined（放行） */
  async function handleBeforeToolCall(event, ctx) {
    try {
      const group = isGroupTarget({
        sessionKey: ctx?.sessionKey,
        channelId: ctx?.channelId
      })
      if (!group) return undefined

      const toolName = typeof event?.toolName === 'string' ? event.toolName : ''
      if (toolName === 'qqbot_platform_api') {
        const groupId = voiceUploadGroupId(event?.params)
        if (!groupId) return undefined
        return await guardVoiceUpload(groupId)
      }
      if (policy.memoryIsolated && GROUP_MEMORY_TOOLS.includes(toolName)) {
        return { block: true, blockReason: GUARD_REASONS.MEMORY_ISOLATED }
      }
      return undefined
    } catch (error) {
      // before_tool_call 的宿主失败策略是 block，这里必须吞掉异常改为放行
      resolved.warn(`before_tool_call handler failed, allow: ${describeError(error)}`)
      return undefined
    }
  }

  api.on('message_sending', handleMessageSending)
  api.on('reply_payload_sending', handleReplyPayloadSending)
  api.on('before_tool_call', handleBeforeToolCall, { matcher: [...GUARD_TOOL_MATCHERS] })

  return () => {
    // 目前没有需要显式释放的资源；状态只留在进程内存中，随插件实例退役
  }
}
