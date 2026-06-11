export interface ChannelInfo {
  id: string
  name: string
  icon: string
  installed: boolean
}

export const CHANNEL_CATALOG: ChannelInfo[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    icon: '📨',
    installed: true
  },
  {
    id: 'discord',
    name: 'Discord',
    icon: '🎮',
    installed: true
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    installed: true
  },
  {
    id: 'wechat',
    name: '微信',
    icon: '🟢',
    installed: true
  },
  {
    id: 'feishu',
    name: '飞书',
    icon: '🚀',
    installed: true
  },
  {
    id: 'lark',
    name: 'Lark',
    icon: '🦜',
    installed: true
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: '📱',
    installed: true
  },
  {
    id: 'signal',
    name: 'Signal',
    icon: '🔒',
    installed: true
  },
  {
    id: 'matrix',
    name: 'Matrix',
    icon: '🔷',
    installed: true
  },
  {
    id: 'line',
    name: 'LINE',
    icon: '🟩',
    installed: true
  }
]