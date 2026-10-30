import type { NotificationSound } from '../types'
import { PLUGIN_ID } from '../../shared/constants'
import { builtinSound } from './sound-assets'

export interface SoundPlayer {
  /** 播放提示音；`custom` 且无自定义音频时不发声（由设置层保证退回默认）。 */
  play: (sound: NotificationSound, customSound: string | null) => void
  dispose: () => void
}

/** 内置音取包内 `assets/*.wav`，自定义音用用户选的文件，两者都走 `<audio>`。 */
export function createSoundPlayer(): SoundPlayer {
  let custom: HTMLAudioElement | undefined

  const playFile = (dataUrl: string): void => {
    if (typeof Audio === 'undefined')
      return
    custom ??= new Audio()
    if (custom.src !== dataUrl)
      custom.src = dataUrl
    try {
      custom.currentTime = 0
    }
    catch (error) {
      console.warn(`[${PLUGIN_ID}] failed to rewind notification sound`, error)
    }
    void custom.play().catch((error: unknown) => {
      console.warn(`[${PLUGIN_ID}] failed to play notification sound`, error)
    })
  }

  return {
    play(sound, customSound) {
      if (sound === 'none')
        return
      if (sound === 'custom') {
        if (customSound)
          playFile(customSound)
        return
      }
      playFile(builtinSound(sound))
    },
    dispose() {
      custom?.pause()
      custom = undefined
    },
  }
}
