import { ListBox, Select } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { changeLanguage } from '@/i18n'
import { toast } from '@/utils/toast'
import { ConfigAutoUpdate } from './auto-update'
import { ConfigCloseAction } from './close-action'
import { ConfigLaunchOnLogin } from './launch-on-login'

/**
 * 桌面应用自身的偏好设置：语言、更新、开机自启、关闭行为。
 *
 * 这几项属于发起端这台机器上的桌面应用，与「当前窗口挂在哪台核心上」无关，
 * 因此本机面板与远端窗口共用同一份实现。
 */
export function ApplicationPreferences() {
  const { t, i18n } = useTranslation()

  const { mutate: onChangeLanguage } = useMutation({
    mutationFn: (language: string) => changeLanguage(language),
    onError: (err: unknown) => {
      console.error('[ApplicationPreferences] save language failed:', err)
      toast(t('messages.language_save_failed'), { variant: 'danger' })
    },
  })

  return (
    <div className="space-y-1.5">
      <ConfigAutoUpdate />
      <ConfigLaunchOnLogin />
      <ConfigCloseAction />

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink">{t('ui.language')}</span>
        <Select
          variant="secondary"
          selectedKey={i18n.language}
          onSelectionChange={key => onChangeLanguage(String(key))}
          className="w-[80px]"
          aria-label={t('ui.language')}
        >
          <Select.Trigger data-testid="dsh-config-language-select" className="min-h-8! h-8 py-0 items-center">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item data-testid="dsh-config-language-option-zh" className="min-h-8!" id="zh-CN" textValue={t('ui.languages.zh')}>{t('ui.languages.zh')}</ListBox.Item>
              <ListBox.Item data-testid="dsh-config-language-option-en" className="min-h-8!" id="en-US" textValue={t('ui.languages.en')}>{t('ui.languages.en')}</ListBox.Item>
              <ListBox.Item data-testid="dsh-config-language-option-ko" className="min-h-8!" id="ko-KR" textValue={t('ui.languages.ko')}>{t('ui.languages.ko')}</ListBox.Item>
              <ListBox.Item data-testid="dsh-config-language-option-ru" className="min-h-8!" id="ru-RU" textValue={t('ui.languages.ru')}>{t('ui.languages.ru')}</ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
    </div>
  )
}
