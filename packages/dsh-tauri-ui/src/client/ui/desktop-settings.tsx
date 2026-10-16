import type { ReactElement } from 'react'
import { invokeParent } from 'dsh-tauri/client'
import { useState } from 'react'
import { Button } from '../components/button'
import { locale } from '../locales'

export function DesktopSettings(): ReactElement {
  locale.useLocale()
  const [failed, setFailed] = useState(false)

  function openSettings(): void {
    try {
      setFailed(!invokeParent({ type: 'dsh://desktop-settings:open' }).ok)
    }
    catch {
      setFailed(true)
    }
  }

  return (
    <div className="flex items-center justify-between gap-[24px] py-[16px] border-b-[0.5px] border-border-l2">
      <div className="flex min-w-0 flex-col">
        <span className="text-[14px] leading-[20px] text-primary">{locale.text('desktopSettings')}</span>
        <span className="mt-[4px] text-[12px] leading-[18px] text-secondary">{locale.text('desktopSettingsHint')}</span>
        {failed ? <span className="mt-[4px] text-[12px] leading-[18px] text-error" role="alert">{locale.text('openDesktopSettingsFailed')}</span> : null}
      </div>
      <div className="flex flex-none items-center gap-[8px]">
        <Button type="button" variant="outline" size="sm" onClick={openSettings}>
          {locale.text('openDesktopSettings')}
        </Button>
      </div>
    </div>
  )
}
