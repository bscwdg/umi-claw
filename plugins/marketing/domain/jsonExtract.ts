// electron/main/marketing/jsonExtract.ts —— 模型输出里的 JSON 块提取（09 抽出来共用）
//
// 模型经常不老实：夹 ``` 围栏、前后加解释文字，甚至解释文字里还带花括号/方括号
// （「如需调整可回复 {加镜头}」）。因此**不能**用「第一个 { 到最后一个 }」这种朴素取法——
// 末位定界符会落在解释文字上，切出来的片段不是合法 JSON。
//
// 这里用「字符串/转义感知的平衡扫描」：从第一个开括号起数深度，深度归零处即块尾。
// 括号在 JSON 字符串字面量里不参与计数（否则 `{"a":"}"}` 会提前收口）。

/** 剥掉 markdown 围栏标记（```json / ``` 都算），保留内部文本 */
function stripFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '')
}

/**
 * 取第一段平衡的 JSON 对象/数组文本（裸块 / markdown 围栏 / 解释文字里夹块均可）。
 * 抽不到（无开括号、括号不闭合）返回 null。
 */
export function extractJsonBlock(text: string, open: '{' | '[', close: '}' | ']'): string | null {
  const cleaned = stripFences(String(text ?? ''))
  const start = cleaned.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

/** 取第一段平衡的 JSON 对象文本 */
export function extractJsonObject(text: string): string | null {
  return extractJsonBlock(text, '{', '}')
}

/** 取第一段平衡的 JSON 数组文本 */
export function extractJsonArray(text: string): string | null {
  return extractJsonBlock(text, '[', ']')
}
