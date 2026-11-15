/**
 * 渠道运行状态（只读展示用）。
 *
 * 判定依据是网关真实配置（openclaw.json 的 channels）与插件登录态，
 * 不是 UI 表单里填了什么 —— 例如企业微信扫码接入后只写入
 * channels.wecom 的 botId + secret，UI 表单卡要的 corpId/agentId 始终为空。
 */

/** 渠道标识。'weixin' 为官方插件渠道，不在表单 CHANNELS 集合内。 */
export type ChannelStatusKey =
  | 'feishu'
  | 'wechat_mp'
  | 'wecom'
  | 'dingtalk'
  | 'weixin'
  | 'qqbot'

export interface ChannelStatus {
  key: ChannelStatusKey
  configured: boolean
  /** 简短说明，如「机器人 aibD7-b0c7」；未配置时省略 */
  detail?: string
}

/**
 * 渠道插件标识：这些渠道在 OpenClaw 里是「原生插件」，需要按需安装
 * （`openclaw plugins install <pkg>`），与 ChannelStatusKey 不是同一命名空间：
 * 缺少 slack / weixin 之外的展示差异，且 wecom 插件 id 与 UI key 也不同。
 */
export type ChannelPluginKey = 'weixin' | 'qqbot' | 'feishu' | 'wecom' | 'slack'

/** 渠道插件安装态（只读展示 + 一键安装/重装的返回形状） */
export interface ChannelPluginPresence {
  key: ChannelPluginKey
  /** 展示名（与渠道卡片文案保持一致） */
  label: string
  installed: boolean
  /** 已安装时读到的包版本；读不到时省略 */
  version?: string
}
