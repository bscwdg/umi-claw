import { VOICE_ERROR_CODES, VoiceError } from './errors'

export const VOICE_MAX_TEXT_CHARS = 8000
export const VOICE_MAX_SEGMENT_CHARS = 400

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu
const SENTENCE_RE = /[^。！？!?；;\n]+[。！？!?；;\n]?/gu

export interface SplitVoiceText {
  text: string
  chars: number
  segments: string[]
}

function hardSplit(text: string, maxChars: number): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += maxChars) {
    out.push(chars.slice(i, i + maxChars).join(''))
  }
  return out
}

export function splitVoiceText(input: unknown): SplitVoiceText {
  if (typeof input !== 'string') {
    throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '朗读文本必须是字符串')
  }
  const cleaned = input
    .replace(EMOJI_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(cleaned).length
  if (!chars) {
    throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '朗读文本不能为空')
  }
  if (chars > VOICE_MAX_TEXT_CHARS) {
    throw new VoiceError(
      VOICE_ERROR_CODES.INVALID_INPUT,
      `单次朗读不能超过 ${VOICE_MAX_TEXT_CHARS} 字`
    )
  }

  const sentences = cleaned.match(SENTENCE_RE) ?? [cleaned]
  const segments: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const normalized = sentence.trim()
    if (!normalized) continue
    const sentenceChars = Array.from(normalized).length
    if (sentenceChars > VOICE_MAX_SEGMENT_CHARS) {
      if (current) {
        segments.push(current)
        current = ''
      }
      segments.push(...hardSplit(normalized, VOICE_MAX_SEGMENT_CHARS))
      continue
    }
    const next = current ? `${current} ${normalized}` : normalized
    if (Array.from(next).length > VOICE_MAX_SEGMENT_CHARS) {
      if (current) segments.push(current)
      current = normalized
    } else {
      current = next
    }
  }
  if (current) segments.push(current)
  if (!segments.length) {
    throw new VoiceError(VOICE_ERROR_CODES.INVALID_INPUT, '朗读文本不能为空')
  }
  return { text: cleaned, chars, segments }
}
