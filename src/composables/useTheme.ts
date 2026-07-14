import { resolveTheme, THEME_PRESETS, DEFAULT_THEME_ID } from '@/theme/themes'
import type { ResolvedTheme } from '@/theme/themes'

export interface ThemeConfig {
  theme?: string
  themeBase?: string
  themeAccent?: string
}

/**
 * 将解析后的主题变量写入 <html> 根节点，从而覆盖 style.css 中的 :root 默认值。
 */
function applyThemeVars(theme: ResolvedTheme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value)
  }
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.id === 'light' || theme.id === 'paper' ? 'light' : 'dark'
}

/**
 * 应用主题：根据配置解析主题并写入 CSS 变量。
 */
export function applyTheme(config?: ThemeConfig): ResolvedTheme {
  const theme = resolveTheme({
    themeId: config?.theme,
    themeBase: config?.themeBase,
    themeAccent: config?.themeAccent
  })
  applyThemeVars(theme)
  return theme
}

export function useTheme() {
  return { applyTheme, presets: THEME_PRESETS, defaultThemeId: DEFAULT_THEME_ID }
}
