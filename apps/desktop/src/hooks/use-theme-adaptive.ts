import { usePreferredDark, useWatch } from '@reause/core'
import { useDshStyle } from './use-dsh-style'
import { useInvoke } from './use-invoke'

export function resolveTheme(
  preference: 'dark' | 'light' | 'system' | null | undefined,
  systemDark: boolean,
): 'dark' | 'light' {
  return preference === 'light' || preference === 'dark'
    ? preference
    : (systemDark ? 'dark' : 'light')
}

export function getInitialTheme(): 'dark' | 'light' {
  const initialTheme = (globalThis as { __DSH_SHELL_THEME__?: 'dark' | 'light' }).__DSH_SHELL_THEME__
  return resolveTheme(initialTheme, window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function useThemeAdaptive() {
  const themePreference = useInvoke<'dark' | 'light' | 'system'>('get_dsh_theme')
  const [dshStyle] = useDshStyle()
  const systemDark = usePreferredDark()
  const theme = themePreference === null ? getInitialTheme() : resolveTheme(themePreference, systemDark)
  useWatch(
    dshStyle.colorScheme || theme,
    value => document.documentElement.dataset.theme = value,
    { immediate: true },
  )
}
