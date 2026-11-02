// electron/main/services/context/tokens.ts —— 上下文预算的公共原语
//
// 为什么要下沉：work 与 marketing 的 ContextEngine 各写了一份 estimateTokens /
// sliceToTokenBudget，两份函数体逐字相同（marketing 版多一行关于代理对的注释）。
// WP2 要收敛成一个内核，预算计算必须只有一份——否则第三个域进来会写第三份。
//
// **口径按原实现原样保留，不要在搬家时"顺手改好"**：
//   - CJK/假名/谚文/全角：1 token/字
//   - ASCII：0.25 token/字符
//   - 换行（\n 与 \r）：1 token
//   - 其余（emoji、带变音符字母、西里尔等）：1.5 token/字符
//   - 结果向上取整；空值 0
// 这套权重是 docs/token-calibration.md 标定过的「宁可高估」口径；改成"非 ASCII 一律 1"
// 会系统性低估（实测 BMP 内 25248 个码点结果变小，CRLF 文档每行少 0.75 token）。
// 要改口径请单独提交，并同步 docs/token-calibration.md 与相关断言。

/** 中日韩表意文字 / 假名 / 谚文 / 全角符号：按 1 token 一个字计（偏保守） */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x303f) || // CJK 部首、标点、〇
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角 / 半角形式
    (cp >= 0x20000 && cp <= 0x3ffff) // 扩展 B 及以后
  )
}

/** 粗估 token 数（不依赖 Gateway usage，偏保守）。空值返回 0。 */
export function estimateTokens(text: unknown): number {
  if (text === null || text === undefined) return 0
  const s = typeof text === 'string' ? text : String(text)
  if (!s) return 0
  let weight = 0
  for (const ch of s) {
    if (ch === '\n' || ch === '\r') {
      weight += 1
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    if (isWideChar(cp)) weight += 1
    else if (cp < 0x80) weight += 0.25
    else weight += 1.5
  }
  return Math.ceil(weight)
}

/** 按 token 预算截断；预算足够时原样返回。二分查找最大可容纳前缀。 */
export function sliceToTokenBudget(text: string, maxTokens: number): string {
  const s = String(text ?? '')
  if (maxTokens <= 0 || !s) return ''
  if (estimateTokens(s) <= maxTokens) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  // 别把代理对劈成半个字符（半个代理对在 JSON / 模型侧都是坏数据）
  if (lo > 0 && lo < s.length) {
    const code = s.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1
  }
  return s.slice(0, lo)
}
