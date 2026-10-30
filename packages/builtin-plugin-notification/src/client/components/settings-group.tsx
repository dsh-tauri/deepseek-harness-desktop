import type { ChangeEvent, ReactElement, ReactNode } from 'react'
import type { SoundPlayer } from '../service/sound'
import type { NotificationSound, TurnCompleteMode } from '../types'
import { Button, Select, Switch } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import { locale } from '../locales'
import { createSoundPlayer } from '../service/sound'
import { readSoundFile } from '../service/sound-file'
import { notificationSettings } from '../store'

/**
 * 一行设置：左侧标题 + 说明，右侧控件。
 *
 * 尺寸与留白照抄官方通用页自己的行（`font-size:14px/line-height:20px` 的标题、
 * `margin-top:4px` + `label-secondary` 的说明、`padding:16px 0`、
 * `border-bottom:.5px solid border-l2`），免得插件条目在官方页面里显得格格不入。
 */
function Row(props: { title: string, hint: string, children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-[24px] py-[16px] border-b-[0.5px] border-border-l2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-[14px] leading-[20px] text-primary">{props.title}</span>
        <span className="mt-[4px] text-[12px] leading-[18px] text-secondary">{props.hint}</span>
      </div>
      <div className="flex flex-none items-center gap-[8px]">{props.children}</div>
    </div>
  )
}

/**
 * 通知设置分组：轮次完成通知 / 启用权限通知 / 启用问题通知 / 通知提示音。
 *
 * 挂在官方「通用」设置页的 `settings.general.item` 槽位里（官方 `GeneralSection` 负责页面骨架，
 * 条目只贡献内容）：不套卡片、也不加分组标题——四行的标题本身已经说明这是通知设置，
 * 样式直接对齐官方通用页自己的行。开关用官方 `Switch`，与页面里其它开关保持一致。
 * 状态读写都走 `notificationSettings` 单例，与通知运行时共用同一份配置。
 */
export function NotificationSettingsGroup(): ReactElement {
  locale.useLocale()
  const { turnComplete, approval, question, sound, customSound } = useStore(notificationSettings)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const playerRef = useRef<SoundPlayer | null>(null)

  useEffect(() => {
    const player = createSoundPlayer()
    playerRef.current = player
    return () => {
      playerRef.current = null
      player.dispose()
    }
  }, [])

  /** 试听一次当前选择；`none` 与「还没选文件的自定义」不发声。 */
  function preview(next: NotificationSound, custom: string | null): void {
    if (next === 'none' || (next === 'custom' && !custom))
      return
    playerRef.current?.play(next, custom)
  }

  function pickSoundOption(next: NotificationSound): void {
    notificationSettings.setSound(next)
    preview(next, notificationSettings.$state.customSound)
  }

  async function pickSound(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file)
      return
    const result = await readSoundFile(file)
    if (result.ok) {
      notificationSettings.setCustomSound(result.dataUrl)
      setNotice(null)
      // 选完文件直接试听，用户不用等下一次通知才知道选对了没有。
      preview('custom', result.dataUrl)
      return
    }
    setNotice(locale.text(result.error === 'too-large' ? 'soundCustomLarge' : 'soundCustomUnreadable'))
  }

  const turnOptions = [
    { value: 'never', label: locale.text('modeNever') },
    { value: 'background', label: locale.text('modeBackground') },
    { value: 'always', label: locale.text('modeAlways') },
  ]
  const soundOptions = [
    { value: 'default', label: locale.text('soundDefault') },
    { value: 'classic', label: locale.text('soundClassic') },
    { value: 'none', label: locale.text('soundNone') },
    { value: 'custom', label: locale.text('soundCustom') },
  ]

  return (
    // 行尾分隔线画在条目根元素上：官方只负责去掉最后一个条目那一条
    // （`[data-slot="settings.general.item"] > :last-child { border-bottom: none }`），
    // 中间那些条目得自己带，否则本组最后一行会跟下一条官方设置黏在一起。
    <div className="flex flex-col border-b-[0.5px] border-border-l2">
      {/* 行包一层：`last:border-b-0` 要落在最后一行上，而不能被下面的提示行顶掉。 */}
      <div className="flex flex-col">
        <Row title={locale.text('turnComplete')} hint={locale.text('turnCompleteHint')}>
          <Select
            options={turnOptions}
            value={turnComplete}
            onChange={next => notificationSettings.setTurnComplete(next as TurnCompleteMode)}
          />
        </Row>
        <Row title={locale.text('approval')} hint={locale.text('approvalHint')}>
          <Switch
            checked={approval}
            label={locale.text('approval')}
            onChange={next => notificationSettings.setApproval(next)}
          />
        </Row>
        <Row title={locale.text('question')} hint={locale.text('questionHint')}>
          <Switch
            checked={question}
            label={locale.text('question')}
            onChange={next => notificationSettings.setQuestion(next)}
          />
        </Row>
        <Row title={locale.text('sound')} hint={locale.text('soundHint')}>
          <Select
            options={soundOptions}
            value={sound}
            onChange={next => pickSoundOption(next as NotificationSound)}
          />
          {sound === 'custom'
            ? (
                <>
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                    {locale.text('soundCustomChoose')}
                  </Button>
                  {customSound
                    ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => notificationSettings.setCustomSound(null)}>
                          {locale.text('soundCustomClear')}
                        </Button>
                      )
                    : null}
                </>
              )
            : null}
        </Row>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={(event) => { void pickSound(event) }}
      />
      {notice ? <div className="py-[16px] text-[12px] leading-[18px] text-error" role="alert">{notice}</div> : null}
    </div>
  )
}
