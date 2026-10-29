// 语音合成情绪（emotion）取值——纯数据，无 Node 内置依赖，供渲染层与验收共用。
//
// 来源：火山官方《音色列表》情感参数（emotion）章节
//   https://www.volcengine.com/docs/6561/1257544
// 官方按语种分两组：中文音色 24 个取值，英文音色 10 个。
//
// ⚠️ 已核对官方文档得到的两个事实（决定了本文件的存在形式）：
//   1. 当前使用的 v3 单向流接口（/api/v3/tts/unidirectional）的 req_params /
//      audio_params **没有 emotion 字段**。emotion 只出现在 v1 非流式接口。
//      所以旧代码把 emotion 塞进 audio_params 是无效的——用户填了也不会生效。
//   2. v3 控制情绪用的是 `req_params.context_texts`：一个自然语言语音指令数组，
//      例如「你可以用特别特别痛心的语气说话吗?」。
//      因此这里把「情绪枚举」映射成一句中文指令，而不是继续塞不存在的字段。
//   3. 官方另有一条限制：给克隆音色指定 `model` 后不再支持 context_texts。

export interface EmotionOption {
  value: string
  label: string
}

export interface EmotionGroup {
  label: string
  options: EmotionOption[]
}

/** 中文音色支持的 24 个取值（官方枚举）。 */
const ZH_OPTIONS: EmotionOption[] = [
  { value: 'happy', label: '开心' },
  { value: 'sad', label: '悲伤' },
  { value: 'angry', label: '生气' },
  { value: 'surprised', label: '惊讶' },
  { value: 'fear', label: '恐惧' },
  { value: 'hate', label: '厌恶' },
  { value: 'excited', label: '激动' },
  { value: 'coldness', label: '冷漠' },
  { value: 'neutral', label: '中性' },
  { value: 'depressed', label: '沉闷' },
  { value: 'lovey-dovey', label: '撒娇' },
  { value: 'shy', label: '害羞' },
  { value: 'comfort', label: '安慰鼓励' },
  { value: 'tension', label: '咆哮/焦急' },
  { value: 'tender', label: '温柔' },
  { value: 'storytelling', label: '讲故事' },
  { value: 'radio', label: '情感电台' },
  { value: 'magnetic', label: '磁性' },
  { value: 'advertising', label: '广告营销' },
  { value: 'vocal-fry', label: '气泡音' },
  { value: 'ASMR', label: '低语' },
  { value: 'news', label: '新闻播报' },
  { value: 'entertainment', label: '娱乐八卦' },
  { value: 'dialect', label: '方言' }
]

/** 英文音色支持的 10 个取值（官方枚举）。 */
const EN_OPTIONS: EmotionOption[] = [
  { value: 'neutral', label: '中性' },
  { value: 'happy', label: '愉悦' },
  { value: 'angry', label: '愤怒' },
  { value: 'sad', label: '悲伤' },
  { value: 'excited', label: '兴奋' },
  { value: 'chat', label: '对话/闲聊' },
  { value: 'ASMR', label: '低语' },
  { value: 'warm', label: '温暖' },
  { value: 'affectionate', label: '深情' },
  { value: 'authoritative', label: '权威' }
]

export const EMOTION_GROUPS: EmotionGroup[] = [
  { label: '中文音色', options: ZH_OPTIONS },
  { label: '英文音色', options: EN_OPTIONS }
]

const ALL = new Set<string>([...ZH_OPTIONS, ...EN_OPTIONS].map((o) => o.value))

export function isKnownEmotion(value: unknown): boolean {
  return typeof value === 'string' && ALL.has(value)
}

/** 归一化：非法值回落为空串（表示「不指定」，用音色默认情绪）。 */
export function normalizeEmotion(value: unknown): string {
  return isKnownEmotion(value) ? (value as string) : ''
}

export function listEmotionValues(): string[] {
  return [...ALL]
}

/**
 * 每个情绪对应的自然语言指令（喂给 v3 的 context_texts）。
 * 用中文指令是因为默认音色是中文；英文音色也能接受中文指令理解意图，
 * 但为稳妥，英文组另给英文指令。
 */
const ZH_INSTRUCTIONS: Record<string, string> = {
  happy: '请用开心愉悦的语气说这句话。',
  sad: '请用悲伤低落的语气说这句话。',
  angry: '请用生气愤怒的语气说这句话。',
  surprised: '请用惊讶的语气说这句话。',
  fear: '请用恐惧不安的语气说这句话。',
  hate: '请用厌恶的语气说这句话。',
  excited: '请用激动兴奋的语气说这句话。',
  coldness: '请用冷漠平淡的语气说这句话。',
  neutral: '请用中性的语气说这句话。',
  depressed: '请用沉闷压抑的语气说这句话。',
  'lovey-dovey': '请用撒娇亲昵的语气说这句话。',
  shy: '请用害羞的语气说这句话。',
  comfort: '请用安慰鼓励的语气说这句话。',
  tension: '请用焦急紧张的语气说这句话。',
  tender: '请用温柔的语气说这句话。',
  storytelling: '请用讲故事的讲述语气说这句话。',
  radio: '请用情感电台播读的语气说这句话。',
  magnetic: '请用磁性沉稳的语气说这句话。',
  advertising: '请用广告营销的语气说这句话。',
  'vocal-fry': '请用带气泡音的语气说这句话。',
  ASMR: '请用低语耳语的语气说这句话。',
  news: '请用新闻播报的语气说这句话。',
  entertainment: '请用娱乐八卦的语气说这句话。',
  dialect: '请用方言口音说这句话。'
}

const EN_INSTRUCTIONS: Record<string, string> = {
  neutral: 'Please read this in a neutral tone.',
  happy: 'Please read this in a happy, cheerful tone.',
  angry: 'Please read this in an angry tone.',
  sad: 'Please read this in a sad tone.',
  excited: 'Please read this in an excited tone.',
  chat: 'Please read this in a casual conversational tone.',
  ASMR: 'Please read this in a soft whispered tone.',
  warm: 'Please read this in a warm tone.',
  affectionate: 'Please read this in an affectionate tone.',
  authoritative: 'Please read this in an authoritative tone.'
}

/**
 * 由情绪枚举值得到喂给 v3 `context_texts` 的指令。
 * 传空串或未知值返回 null（表示不附加任何语音指令）。
 */
export function emotionInstruction(value: unknown, english: boolean): string | null {
  const key = normalizeEmotion(value)
  if (!key) return null
  const table = english ? EN_INSTRUCTIONS : ZH_INSTRUCTIONS
  return table[key] ?? ZH_INSTRUCTIONS[key] ?? null
}
