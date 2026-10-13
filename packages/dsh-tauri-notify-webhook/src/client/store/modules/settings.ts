import type { NotifyWebhookSettings } from '../../../shared/settings'
import { defineStore } from 'dsh-tauri/client'
import { normalizeNotifyWebhook, NOTIFY_WEBHOOK_DEFAULTS } from '../../../shared/settings'

export type SettingsBusy = 'idle' | 'saving' | 'testing'

export interface SettingsForm extends Omit<NotifyWebhookSettings, 'email'> {
  email: Omit<NotifyWebhookSettings['email'], 'port'> & { port: string }
}

export interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  error: string | null
  busy: SettingsBusy
  values: SettingsForm
  saved: SettingsForm
}

function formOf(value: NotifyWebhookSettings): SettingsForm {
  return { ...value, email: { ...value.email, port: String(value.email.port) } }
}

function initialState(): SettingsState {
  return {
    status: 'idle',
    error: null,
    busy: 'idle',
    values: formOf(NOTIFY_WEBHOOK_DEFAULTS),
    saved: formOf(NOTIFY_WEBHOOK_DEFAULTS),
  }
}

export const settings = defineStore({
  state: (): SettingsState => initialState(),
  actions: {
    beginLoad() {
      this.status = 'loading'
      this.error = null
    },
    commit(value: NotifyWebhookSettings) {
      const next = normalizeNotifyWebhook(value)
      this.values = formOf(next)
      this.saved = formOf(next)
      this.status = 'ready'
      this.error = null
    },
    fail(error: string) {
      this.status = 'failed'
      this.error = error
    },
    beginSave() {
      this.busy = 'saving'
    },
    beginTest() {
      this.busy = 'testing'
    },
    endBusy() {
      this.busy = 'idle'
    },
    patch(values: Partial<Omit<SettingsForm, 'email' | 'pushplus'>>) {
      this.values = { ...this.values, ...values }
    },
    patchEmail(values: Partial<SettingsForm['email']>) {
      this.values.email = { ...this.values.email, ...values }
    },
    patchPushplus(values: Partial<SettingsForm['pushplus']>) {
      this.values.pushplus = { ...this.values.pushplus, ...values }
    },
  },
})
