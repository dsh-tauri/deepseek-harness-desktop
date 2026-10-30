import type { MobileSettingsSnapshot, MobileSettingsView } from '../types/settings'

interface SettingsPresentationFacts {
  entering: boolean
  changing: boolean
  launcher: boolean
  navigation: boolean
  selectionChanged: boolean
  title: string | null
  focused: { list: boolean, options: boolean, controls: boolean }
}

export function resolveSettingsPresentation(previous: MobileSettingsSnapshot, intent: MobileSettingsView, facts: SettingsPresentationFacts): {
  snapshot: MobileSettingsSnapshot
  focus: 'back' | 'category' | null
} {
  let view = intent
  if (facts.entering || facts.changing)
    view = facts.entering && facts.launcher ? 'menu' : 'detail'
  if (facts.title === null)
    view = 'menu'
  else if (facts.navigation || facts.selectionChanged)
    view = 'detail'
  const title = facts.title ?? ''
  const snapshot = previous.ready && previous.view === view && previous.title === title
    ? previous
    : { ready: true, view, title }
  const focus = view === 'detail' && (facts.focused.list || facts.entering || facts.changing || facts.navigation || previous.view !== view)
    ? 'back'
    : view === 'menu' && (facts.focused.options || facts.focused.controls || previous.view !== view)
      ? 'category'
      : null
  return { snapshot, focus }
}
