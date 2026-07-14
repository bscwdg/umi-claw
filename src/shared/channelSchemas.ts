export interface FieldSchema {
  key: string
  label: string
  type: 'text' | 'password'
  placeholder?: string
}

export const CHANNEL_SCHEMAS = {
  telegram: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      placeholder: '123456:ABC...'
    }
  ],

  discord: [
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password'
    }
  ],

  slack: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password'
    },

    {
      key: 'appToken',
      label: 'App Token',
      type: 'password'
    }
  ],

  feishu: [
    {
      key: 'appId',
      label: 'App ID',
      type: 'text',
      placeholder: 'cli_xxxxxxxxxxxxxxxx'
    },

    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password'
    },

    {
      key: 'encryptKey',
      label: 'Encrypt Key',
      type: 'password'
    },

    {
      key: 'verificationToken',
      label: 'Verification Token',
      type: 'password'
    }
  ],

  wechat: [
    {
      key: 'appId',
      label: 'App ID',
      type: 'text'
    },

    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password'
    }
  ]
}