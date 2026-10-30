import type { NotificationSettings, NotificationSound, TurnCompleteMode } from '../../types'
import { defineStore } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../../shared/constants'

export const notificationSettings = defineStore({
  state: (): NotificationSettings => ({
    turnComplete: 'background',
    approval: true,
    question: true,
    sound: 'default',
    customSound: null,
  }),
  persist: { key: `${PLUGIN_ID}.settings` },
  actions: {
    setTurnComplete(mode: TurnCompleteMode) {
      this.turnComplete = mode
    },
    setApproval(enabled: boolean) {
      this.approval = enabled
    },
    setQuestion(enabled: boolean) {
      this.question = enabled
    },
    setSound(sound: NotificationSound) {
      this.sound = sound
    },
    setCustomSound(dataUrl: string | null) {
      this.customSound = dataUrl
      if (dataUrl)
        this.sound = 'custom'
      else if (this.sound === 'custom')
        this.sound = 'default'
    },
  },
})
