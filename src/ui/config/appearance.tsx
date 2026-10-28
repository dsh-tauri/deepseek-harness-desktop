import type { AppSettingUpdate } from '@/store/modules/setting/types'
import { Alert, Button, Description, Label, ListBox, Select, Slider, Switch, Typography } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Panel } from '@/components/panel'
import { store } from '@/store'
import { ZOOM_FACTOR_DEFAULT, ZOOM_FACTOR_OPTIONS } from '@/store/modules/setting'
import { toast } from '@/utils/toast'
import { APPEARANCE_DEFAULTS, APPEARANCE_PALETTES, normalizeAppearance } from '../../../packages/dsh-tauri/src/shared/appearance'

/** 打开「原生透明」时一并给出的初始组合：内容区保持不透明、背景 80%、开启模糊。 */
const TRANSPARENCY_DEFAULTS = { opacity: 80, blur: true, sidebarOnly: true }

export function ConfigAppearance() {
  const { t } = useTranslation()
  const { appearance: saved, zoom_factor: zoomFactor } = useStore(store.setting)
  const appearance = normalizeAppearance(saved)
  const [opacity, setOpacity] = useState<number>()
  const transparent = (window as Window & { __DSH_TRANSPARENT__?: boolean }).__DSH_TRANSPARENT__ === true
  // Linux 自绘圆角边框的窗口恒为透明窗（透明度是前端渲染参数），无需重启；
  // 其余平台透明窗在启动时建立，改动 transparency 需要退出重开。
  const framed = (window as Window & { __DSH_FRAME__?: boolean }).__DSH_FRAME__ === true
  const restartPending = (framed ? true : appearance.transparency) !== transparent
  const { mutate: save, isPending } = useMutation({
    mutationFn: (update: AppSettingUpdate) => store.setting.update(update),
    onError: () => toast(t('appearance.save_failed'), { variant: 'danger' }),
  })

  return (
    <div className="space-y-3" data-testid="dsh-appearance-settings">
      <Panel.Header title={t('config.appearance')} description={t('appearance.description')} testId="dsh-config-panel-title" />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Typography type="body-sm" weight="medium">{t('appearance.palette')}</Typography>
          <Select
            variant="secondary"
            aria-label={t('appearance.palette')}
            selectedKey={appearance.palette}
            onSelectionChange={key => save({ appearance: normalizeAppearance({ ...appearance, palette: key }) })}
            isDisabled={isPending}
            className="w-[180px]"
          >
            <Select.Trigger data-testid="dsh-appearance-palette" className="min-h-8! h-8 py-0 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {APPEARANCE_PALETTES.map(palette => (
                  <ListBox.Item className="min-h-8!" key={palette} id={palette} textValue={t(`appearance.palette.${palette}`)} data-testid={`dsh-appearance-palette-${palette}`}>
                    {t(`appearance.palette.${palette}`)}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div>
            <Typography type="body-sm" weight="medium">{t('appearance.zoom')}</Typography>
            <Description>{t('appearance.zoom_description')}</Description>
          </div>
          <Select
            variant="secondary"
            aria-label={t('appearance.zoom')}
            selectedKey={String(zoomFactor)}
            onSelectionChange={key => save({ zoomFactor: Number(key) })}
            isDisabled={isPending}
            className="w-[80px]"
          >
            <Select.Trigger data-testid="dsh-appearance-zoom" className="min-h-8! h-8 py-0 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {ZOOM_FACTOR_OPTIONS.map(factor => (
                  <ListBox.Item className="min-h-8!" id={String(factor)} key={factor} textValue={`${Math.round(factor * 100)}%`} data-testid={`dsh-appearance-zoom-${factor}`}>
                    {`${Math.round(factor * 100)}%`}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div>
            <Typography type="body-sm" weight="medium">{t('appearance.terminal')}</Typography>
            <Description>{t('appearance.terminal_description')}</Description>
          </div>
          <Switch
            aria-label={t('appearance.terminal')}
            isSelected={appearance.terminal}
            isDisabled={isPending}
            onChange={terminal => save({ appearance: { ...appearance, terminal } })}
          >
            <Switch.Content data-testid="dsh-appearance-terminal">
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      </div>

      <div className="border-t border-line/30" />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Typography type="body-sm" weight="medium">{t('appearance.transparency')}</Typography>
            <Description>{t('appearance.transparency_description')}</Description>
          </div>
          <Switch
            aria-label={t('appearance.transparency')}
            isSelected={appearance.transparency}
            isDisabled={isPending}
            onChange={transparency => save({ appearance: { ...appearance, transparency, ...(transparency ? TRANSPARENCY_DEFAULTS : {}) } })}
          >
            <Switch.Content data-testid="dsh-appearance-transparency">
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      </div>

      <div className="border-t border-line/30" />

      <If cond={appearance.transparency}>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Typography type="body-sm" weight="medium">{t('appearance.sidebar_only')}</Typography>
            <Switch
              aria-label={t('appearance.sidebar_only')}
              isSelected={appearance.sidebarOnly}
              isDisabled={isPending}
              onChange={sidebarOnly => save({ appearance: { ...appearance, sidebarOnly } })}
            >
              <Switch.Content data-testid="dsh-appearance-sidebar-only">
                <Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
          <div>
            <Slider
              aria-label={t('appearance.opacity')}
              value={opacity ?? appearance.opacity}
              minValue={20}
              maxValue={100}
              step={1}
              isDisabled={isPending}
              onChange={value => setOpacity(Number(value))}
              onChangeEnd={value => save({ appearance: { ...appearance, opacity: Number(value) } }, { onSettled: () => setOpacity(undefined) })}
              data-testid="dsh-appearance-opacity"
            >
              <Label>{t('appearance.opacity')}</Label>
              <Slider.Output>{({ state }) => `${state.values[0]}%`}</Slider.Output>
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <Typography type="body-sm" weight="medium">{t('appearance.blur')}</Typography>
              <Description>{t('appearance.blur_description')}</Description>
            </div>
            <Switch
              aria-label={t('appearance.blur')}
              isSelected={appearance.blur}
              isDisabled={isPending}
              onChange={blur => save({ appearance: { ...appearance, blur } })}
            >
              <Switch.Content data-testid="dsh-appearance-blur">
                <Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </div>
        <div className="border-t border-line/30" />
      </If>

      <If cond={restartPending}>
        <Alert status="warning" className="gap-2">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description data-testid="dsh-appearance-restart">{t('appearance.restart')}</Alert.Description>
          </Alert.Content>
        </Alert>
      </If>

      <Button variant="secondary" isDisabled={isPending} onPress={() => save({ appearance: normalizeAppearance(APPEARANCE_DEFAULTS), zoomFactor: ZOOM_FACTOR_DEFAULT })} data-testid="dsh-appearance-reset">
        {t('appearance.reset')}
      </Button>
    </div>
  )
}
