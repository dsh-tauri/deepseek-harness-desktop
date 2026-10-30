import type { MobileSettingsPresentation } from '../types/settings'
import { ArrowLeft, Button, Icon } from 'dsh-tauri-ui/client'
import { useSyncExternalStore } from 'react'
import { locale } from '../locales'

export function MobileSettingsControls({ presentation }: { presentation: MobileSettingsPresentation }) {
  locale.useLocale()
  const snapshot = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot, presentation.getSnapshot)
  return (
    <div data-dsh-mobile-settings-controls hidden>
      <Button
        data-dsh-mobile-settings-back
        aria-label={locale.text('settings.back')}
        icon={<Icon as={ArrowLeft} size={20} aria-hidden="true" />}
        onClick={presentation.back}
      />
      <span data-dsh-mobile-settings-section-title role="heading" aria-level={2} title={snapshot.title}>
        {snapshot.title}
      </span>
    </div>
  )
}
