// 音色复刻语种表（纯数据 + 纯函数，禁止 import Node 内置模块——
// 渲染层 VoicePage 要直接引用，打进去不能带 crypto/fs）。
// 取值口径来自官方《声音复刻API-V3》：cn=0 en=1 ja=2 es=3 id=4 pt=5 de=6 fr=7
// ko=8 it=9 th=10 vi=11 ru=12 fil=13 ms=14 ar=15 mx=16 pt-br=17 pl=19 tr=20 sv=21
// （18 在官方枚举中未定义，因此不提供。）

export interface VoiceCloneLanguageOption {
  value: number
  label: string
}

export const VOICE_CLONE_LANGUAGES: VoiceCloneLanguageOption[] = [
  { value: 0, label: '中文' },
  { value: 1, label: '英文' },
  { value: 2, label: '日语' },
  { value: 3, label: '西班牙语' },
  { value: 4, label: '印尼语' },
  { value: 5, label: '葡萄牙语' },
  { value: 6, label: '德语' },
  { value: 7, label: '法语' },
  { value: 8, label: '韩语' },
  { value: 9, label: '意大利语' },
  { value: 10, label: '泰语' },
  { value: 11, label: '越南语' },
  { value: 12, label: '俄语' },
  { value: 13, label: '菲律宾语' },
  { value: 14, label: '马来语' },
  { value: 15, label: '阿拉伯语' },
  { value: 16, label: '墨西哥西班牙语' },
  { value: 17, label: '巴西葡萄牙语' },
  { value: 19, label: '波兰语' },
  { value: 20, label: '土耳其语' },
  { value: 21, label: '瑞典语' }
]

const SUPPORTED = new Set(VOICE_CLONE_LANGUAGES.map((item) => item.value))

/** 合法语种归一化；非法值回落到中文 0（与放开前的旧行为一致）。 */
export function normalizeCloneLanguage(value: unknown): number {
  const n = Math.floor(Number(value) || 0)
  return SUPPORTED.has(n) ? n : 0
}

export function cloneLanguageLabel(language: number): string {
  return VOICE_CLONE_LANGUAGES.find((item) => item.value === language)?.label || '中文'
}

/**
 * demo_text 必须与 language 同语种，否则官方侧合成失败。
 * 长度 4–300 字；用固定短句避免把注册耗时拉长。
 */
const DEMO_TEXT: Record<number, string> = {
  0: '你好，我是你的语音助手。',
  1: 'Hello, I am your voice assistant.',
  2: 'こんにちは、私はあなたの音声アシスタントです。',
  3: 'Hola, soy tu asistente de voz.',
  4: 'Halo, saya adalah asisten suara Anda.',
  5: 'Olá, eu sou o seu assistente de voz.',
  6: 'Hallo, ich bin Ihr Sprachassistent.',
  7: 'Bonjour, je suis votre assistant vocal.',
  8: '안녕하세요, 저는 당신의 음성 비서입니다.',
  9: 'Ciao, sono il tuo assistente vocale.',
  10: 'สวัสดีครับ ผมคือผู้ช่วยเสียงของคุณ',
  11: 'Xin chào, tôi là trợ lý giọng nói của bạn.',
  12: 'Здравствуйте, я ваш голосовой помощник.',
  13: 'Kumusta, ako ang iyong voice assistant.',
  14: 'Helo, saya pembantu suara anda.',
  15: 'مرحبا، أنا مساعدك الصوتي.',
  16: 'Hola, soy tu asistente de voz.',
  17: 'Olá, eu sou o seu assistente de voz.',
  19: 'Cześć, jestem twoim asystentem głosowym.',
  20: 'Merhaba, ben senin ses asistanınım.',
  21: 'Hej, jag är din röstassistent.'
}

export function defaultDemoText(language: number): string {
  return DEMO_TEXT[normalizeCloneLanguage(language)] || DEMO_TEXT[0]
}
