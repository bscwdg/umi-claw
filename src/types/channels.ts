/**
 * 渠道运行状态（只读展示用）。
 *
 * 判定依据是网关真实配置（openclaw.json 的 channels）与插件登录态，
 * 不是 UI 表单里填了什么 —— 例如企业微信扫码接入后只写入
 * channels.wecom 的 botId + secret，UI 表单卡要的 corpId/agentId 始终为空。
 */

/** 渠道标识。'weixin' 为官方插件渠道，不在表单 CHANNELS 集合内。 */
export type ChannelStatusKey = 'feishu' | 'wechat_mp' | 'wecom' | 'dingtalk' | 'weixin'

export interface ChannelStatus {
  key: ChannelStatusKey
  configured: boolean
  /** 简短说明，如「机器人 aibD7-b0c7」；未配置时省略 */
  detail?: string
}
