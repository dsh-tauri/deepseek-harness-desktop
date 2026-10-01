import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { Select } from '../components/select'
import { SETTINGS_REGISTRANT, SETTINGS_SIDEBAR_SLOT, SETTINGS_TRIGGER_PRIORITY } from '../constants'
import { detectMobileDevice } from './settings.utils'

export const registerMobilePreferences = defineRegister<ClientContext>((controller, ctx) => {
  if (!detectMobileDevice())
    return

  const fiber = ctx.inject(['theme'], (scoped) => {
    const subscribeTheme = (listener: () => void) => scoped.on('theme/change', listener)
    const getTheme = () => scoped.theme.getTheme()
    const subscribeLocale = (listener: () => void) => scoped.locale.subscribe(listener)
    const getLocale = () => scoped.locale.getSnapshot()
    const themeText = scoped.locale.bind('settings.theme')
    const languageText = scoped.locale.bind('settings.locale')

    function MobilePreferences() {
      const theme = useSyncExternalStore(subscribeTheme, getTheme)
      const locale = useSyncExternalStore(subscribeLocale, getLocale)

      return (
        <div data-dsh-mobile-preferences style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0' }}>
          <Select
            label={themeText('appearance.title')}
            value={theme.active.colorScheme}
            options={[
              { value: 'light', label: themeText('appearance.light') },
              { value: 'dark', label: themeText('appearance.dark') },
            ]}
            onChange={id => scoped.theme.setTheme(id)}
          />
          <Select
            label={languageText('language.title')}
            value={locale.active}
            options={locale.locales.map(entry => ({ value: entry.id, label: entry.label }))}
            onChange={id => scoped.locale.setLocale(id)}
          />
        </div>
      )
    }

    return scoped.slots.inject(SETTINGS_SIDEBAR_SLOT as never, () => scoped.slots.register(
      { name: SETTINGS_SIDEBAR_SLOT, priority: SETTINGS_TRIGGER_PRIORITY, registrant: SETTINGS_REGISTRANT } as never,
      MobilePreferences,
    ))
  })
  controller.add(() => {
    void fiber.dispose()
  })
})
