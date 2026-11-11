/**
 * 主题系统：根据主色（背景色 + 强调色）派生出一整套 CSS 变量，
 * 并根据背景明度自动选择可读的字体颜色，避免深色字配深色底等问题。
 */

/** 语义色键名：基础色 + 三个衍生（hover / 半透明底 / 描边） */
type SemanticKey = 'success' | 'danger' | 'warning' | 'info'
type SemanticThemeKeys =
  | `--${SemanticKey}`
  | `--${SemanticKey}-hover`
  | `--${SemanticKey}-muted`
  | `--${SemanticKey}-border`

export interface ThemeVars {
  '--bg-base': string
  '--bg-surface': string
  '--bg-elevated': string
  '--bg-overlay': string
  '--border': string
  '--border-muted': string
  '--text-primary': string
  '--text-secondary': string
  '--text-muted': string
  '--accent': string
  '--accent-hover': string
  '--accent-muted': string
  '--shadow': string
  '--shadow-sm': string
  /** 语义色：浅/深主题各一套基础色，与品牌 accent 解耦（红恒为危险、绿恒为成功） */
  '--success': string
  '--success-hover': string
  '--success-muted': string
  '--success-border': string
  '--danger': string
  '--danger-hover': string
  '--danger-muted': string
  '--danger-border': string
  '--warning': string
  '--warning-hover': string
  '--warning-muted': string
  '--warning-border': string
  '--info': string
  '--info-hover': string
  '--info-muted': string
  '--info-border': string
}

export interface ThemePreset {
  id: string
  name: string
  /** 主背景色 */
  base: string
  /** 强调色 */
  accent: string
}

/** 内置主题预设 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'dark', name: '经典深色', base: '#0f1117', accent: '#f0883e' },
  { id: 'midnight', name: '午夜蓝', base: '#0d1b2a', accent: '#4ea8de' },
  { id: 'forest', name: '深林绿', base: '#0e1a14', accent: '#3fb950' },
  { id: 'plum', name: '暗夜紫', base: '#161022', accent: '#bc8cff' },
  { id: 'carbon', name: '纯碳黑', base: '#000000', accent: '#e6edf3' },
  { id: 'light', name: '明亮白', base: '#ffffff', accent: '#f0883e' },
  { id: 'paper', name: '米纸色', base: '#f5f1e8', accent: '#c2703d' }
]

export const DEFAULT_THEME_ID = 'dark'

/* ── 颜色工具 ─────────────────────────────────────────────── */

function clamp(value: number, min = 0, max = 255): number {
  return Math.min(max, Math.max(min, value))
}

interface Rgb {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): Rgb {
  let value = hex.replace('#', '').trim()
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const num = parseInt(value, 16)
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  }
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (n: number): string => clamp(Math.round(n)).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** 相对亮度 (0 暗 - 1 亮)，用于判断浅色/深色主题 */
function luminance({ r, g, b }: Rgb): number {
  const srgb = [r, g, b].map((v) => {
    const channel = v / 255
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2]
}

/** 朝白色（amount>0）或黑色（amount<0）混合，amount 范围 -1~1 */
function mix(rgb: Rgb, amount: number): Rgb {
  const target = amount >= 0 ? 255 : 0
  const ratio = Math.abs(amount)
  return {
    r: rgb.r + (target - rgb.r) * ratio,
    g: rgb.g + (target - rgb.g) * ratio,
    b: rgb.b + (target - rgb.b) * ratio
  }
}

function withAlpha(rgb: Rgb, alpha: number): string {
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`
}

/**
 * 语义色基础值：深/浅主题两套。浅色主题下压暗以保证白底对比度；
 * 不随 accent 色相变化——语义颜色承担固定含义（危险/成功/警告/信息）。
 */
const SEMANTIC_BASES: Record<SemanticKey, { dark: string; light: string }> = {
  success: { dark: '#3fb950', light: '#1a7f37' },
  danger: { dark: '#f85149', light: '#cf222e' },
  warning: { dark: '#d29922', light: '#9a6700' },
  info: { dark: '#58a6ff', light: '#0969da' }
}

/**
 * 派生一组语义色变量（每组 4 个）。
 * muted/border 的 alpha 浅深两套：浅底上同透明度视觉偏淡，整体上调。
 */
function buildSemanticVars(isLight: boolean): Pick<ThemeVars, SemanticThemeKeys> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(SEMANTIC_BASES) as SemanticKey[]) {
    const baseRgb = hexToRgb(isLight ? SEMANTIC_BASES[key].light : SEMANTIC_BASES[key].dark)
    const hoverRgb = mix(baseRgb, isLight ? -0.15 : 0.18)
    out[`--${key}`] = rgbToHex(baseRgb)
    out[`--${key}-hover`] = rgbToHex(hoverRgb)
    out[`--${key}-muted`] = withAlpha(baseRgb, isLight ? 0.12 : 0.15)
    out[`--${key}-border`] = withAlpha(baseRgb, isLight ? 0.35 : 0.4)
  }
  return out as Pick<ThemeVars, SemanticThemeKeys>
}

/**
 * 根据背景色与强调色派生整套主题变量。
 * 关键点：字体颜色依据背景明度自适应（深底用浅字，浅底用深字）。
 */
export function buildThemeVars(base: string, accent: string): ThemeVars {
  const baseRgb = hexToRgb(base)
  const accentRgb = hexToRgb(accent)
  const isLight = luminance(baseRgb) > 0.5

  // 表层颜色：深色主题往亮处叠加，浅色主题往暗处叠加
  const step = isLight ? -1 : 1
  const surface = mix(baseRgb, step * 0.05)
  const elevated = mix(baseRgb, step * 0.1)
  const overlay = mix(baseRgb, step * 0.14)
  const border = mix(baseRgb, step * 0.24)
  const borderMuted = mix(baseRgb, step * 0.12)

  // 字体颜色：浅色底用近黑字，深色底用近白字
  const textPrimary = isLight ? mix(baseRgb, -0.86) : mix(baseRgb, 0.9)
  const textSecondary = isLight ? mix(baseRgb, -0.55) : mix(baseRgb, 0.55)
  const textMuted = isLight ? mix(baseRgb, -0.35) : mix(baseRgb, 0.32)

  const accentHover = mix(accentRgb, isLight ? -0.15 : 0.18)

  const shadowStrength = isLight ? 0.12 : 0.4
  const shadowStrengthSm = isLight ? 0.08 : 0.25

  return {
    '--bg-base': rgbToHex(baseRgb),
    '--bg-surface': rgbToHex(surface),
    '--bg-elevated': rgbToHex(elevated),
    '--bg-overlay': rgbToHex(overlay),
    '--border': rgbToHex(border),
    '--border-muted': rgbToHex(borderMuted),
    '--text-primary': rgbToHex(textPrimary),
    '--text-secondary': rgbToHex(textSecondary),
    '--text-muted': rgbToHex(textMuted),
    '--accent': rgbToHex(accentRgb),
    '--accent-hover': rgbToHex(accentHover),
    '--accent-muted': withAlpha(accentRgb, 0.15),
    '--shadow': `0 4px 24px rgba(0,0,0,${shadowStrength})`,
    '--shadow-sm': `0 2px 8px rgba(0,0,0,${shadowStrengthSm})`,
    ...buildSemanticVars(isLight)
  }
}

export interface ResolvedTheme {
  id: string
  base: string
  accent: string
  vars: ThemeVars
}

/**
 * 解析主题配置：支持内置预设 id，或 base/accent 自定义颜色。
 */
export function resolveTheme(input?: {
  themeId?: string
  themeBase?: string
  themeAccent?: string
}): ResolvedTheme {
  const themeId = input?.themeId || DEFAULT_THEME_ID

  if (themeId === 'custom' && input?.themeBase && input?.themeAccent) {
    return {
      id: 'custom',
      base: input.themeBase,
      accent: input.themeAccent,
      vars: buildThemeVars(input.themeBase, input.themeAccent)
    }
  }

  const preset =
    THEME_PRESETS.find((t) => t.id === themeId) ??
    THEME_PRESETS.find((t) => t.id === DEFAULT_THEME_ID)!

  return {
    id: preset.id,
    base: preset.base,
    accent: preset.accent,
    vars: buildThemeVars(preset.base, preset.accent)
  }
}
