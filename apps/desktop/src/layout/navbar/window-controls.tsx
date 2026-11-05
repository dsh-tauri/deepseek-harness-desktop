import { Copy, Minus, Square, Xmark } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useMaximized } from '@/hooks/use-window-chrome'
import { handleWindowAction } from '@/utils/window-actions'

export function WindowControls() {
  const { t } = useTranslation()
  const isMaximized = useMaximized()
  const isMainWindow = getCurrentWindow().label === 'main'

  return (
    <>
      <Button
        className="size-7"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t('nav.minimize')}
        onPress={() => { handleWindowAction('minimize') }}
      >
        <Minus />
      </Button>

      <Button
        className="size-7"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t(isMaximized ? 'nav.restore' : 'nav.maximize')}
        onPress={() => { handleWindowAction('maximize') }}
      >
        <If
          cond={isMaximized}
          then={<Copy style={{ width: 14, height: 14 }} />}
          else={<Square style={{ width: 14, height: 14 }} />}
        />
      </Button>

      <Button
        className="size-7 transition-colors enabled:hover:bg-danger/16 enabled:hover:text-danger"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t(isMainWindow ? 'nav.background' : 'nav.close')}
        onPress={() => { handleWindowAction('close') }}
      >
        <Xmark />
      </Button>
    </>
  )
}
