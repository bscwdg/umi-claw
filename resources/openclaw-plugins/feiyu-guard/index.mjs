// resources/openclaw-plugins/feiyu-guard/index.mjs —— OpenClaw 原生插件入口
//
// 为什么入口只做一件事：随 App 打包随包加载（plugins.load.paths），入口越薄越好排查——
// 加载失败时要么是 SDK 入口问题，要么是 guard.mjs 的策略问题，不会混在一起。
// 策略实现与依赖注入在 guard.mjs / policy.mjs（accept 直接打这两个文件，不经过本入口）。

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { registerGuard } from './guard.mjs'

export default definePluginEntry({
  id: 'feiyu-guard',
  name: 'Feiyu Group Guard',
  description: 'QQ 群聊硬策略（群回复开关/亲密词/群语音日上限/记忆隔离，仅群会话生效）+ feiyu 语音通道合规：feiyu 会话的 edge-tts/手工上传等野链路 exec 不分群私聊一律阻断，非 feiyu 会话放行。',
  register(api) {
    registerGuard(api)
  }
})
