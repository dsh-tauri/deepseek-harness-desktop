import type { HelpAction } from '@/hooks/use-help-menu'
import { Button, Description, Dropdown, Label, Separator } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { shortcutHint } from '@/hooks/use-dsh-shortcuts'
import { ShortcutLabel } from './shortcut-label'

export interface HelpMenuProps {
  onAction: (key: HelpAction) => void
  onOpenShortcuts?: () => void
  shortcutRows: Parameters<typeof shortcutHint>[0]
  showUpdateAvailable: boolean
}

export function HelpMenu({ onAction, onOpenShortcuts, shortcutRows, showUpdateAvailable }: HelpMenuProps) {
  const { t } = useTranslation()

  return (
    <Dropdown>
      <Button
        className="h-6 text-[12.5px] px-1.5"
        size="sm"
        variant="ghost"
        aria-label={t('app.help')}
        data-testid="dsh-navbar-menu-help"
      >
        {t('app.help')}
      </Button>
      <Dropdown.Popover className="min-w-55" data-testid="dsh-navbar-menu-popover">
        <Dropdown.Menu>
          <Dropdown.Item
            id="documentation"
            data-testid="dsh-navbar-item-documentation"
            textValue={t('menu.documentation')}
            onAction={() => onAction('documentation')}
          >
            <Label>{t('menu.documentation')}</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="keyboard-shortcuts"
            data-testid="dsh-navbar-item-keyboard-shortcuts"
            isDisabled={onOpenShortcuts == null}
            textValue={t('menu.keyboard_shortcuts')}
            onAction={() => onAction('keyboard-shortcuts')}
          >
            <ShortcutLabel label={t('menu.keyboard_shortcuts')} hint={shortcutHint(shortcutRows, 'shortcuts.open')} />
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item
            id="desktop-feedback"
            data-testid="dsh-navbar-item-desktop-feedback"
            textValue={t('menu.desktop_feedback')}
            onAction={() => onAction('desktop-feedback')}
          >
            <Label>{t('menu.desktop_feedback')}</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="harness-feedback"
            data-testid="dsh-navbar-item-harness-feedback"
            textValue={t('menu.harness_feedback')}
            onAction={() => onAction('harness-feedback')}
          >
            <Label>{t('menu.harness_feedback')}</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item
            id="toggle-devtools"
            data-testid="dsh-navbar-item-toggle-devtools"
            textValue={t('menu.toggle_devtools')}
            onAction={() => onAction('toggle-devtools')}
          >
            <Label>{t('menu.toggle_devtools')}</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="task-manager"
            data-testid="dsh-navbar-item-task-manager"
            textValue={t('menu.task_manager')}
            onAction={() => onAction('task-manager')}
          >
            <Label>{t('menu.task_manager')}</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="copy-run-logs"
            data-testid="dsh-navbar-item-copy-run-logs"
            textValue={t('menu.run_logs')}
            onAction={() => onAction('copy-run-logs')}
          >
            <Label>{t('menu.run_logs')}</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item
            id="check-update"
            data-testid="dsh-navbar-item-check-update"
            textValue={t('menu.check_update')}
            onAction={() => onAction('check-update')}
          >
            <span className="flex w-full items-center justify-between gap-3">
              <Label>{t('menu.check_update')}</Label>
              <If cond={showUpdateAvailable}>
                <Description>{t('menu.new_version')}</Description>
              </If>
            </span>
          </Dropdown.Item>
          <Dropdown.Item
            id="about"
            data-testid="dsh-navbar-item-about"
            textValue={t('menu.about')}
            onAction={() => onAction('about')}
          >
            <Label>{t('menu.about')}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
