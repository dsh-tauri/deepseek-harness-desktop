import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ClientContext } from 'dsh-tauri/client'
import { Button, Gear, Select } from 'dsh-tauri-ui/client'
import { defineRegister, detectMobileDevice } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { PLUGIN_ID } from '../../shared/constants'

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
    const settingsText = scoped.locale.bind('settings')

    function MobilePreferences({ openSettings, settingsOpen }: SettingsLauncherOwnerProps) {
      const theme = useSyncExternalStore(subscribeTheme, getTheme)
      const locale = useSyncExternalStore(subscribeLocale, getLocale)

      return (
        <div data-dsh-mobile-preferences>
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
          <Button
            aria-label={settingsText('trigger')}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            icon={<Gear width={16} height={16} />}
            onClick={openSettings}
          />
        </div>
      )
    }

    return scoped.slots.inject('settings.launcher', () => scoped.slots.register(
      { name: 'settings.launcher', priority: -1, registrant: PLUGIN_ID },
      MobilePreferences,
    ))
  })
  controller.add(() => {
    void fiber.dispose()
  })
})
