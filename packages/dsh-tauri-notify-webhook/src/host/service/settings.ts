import type { NotifyWebhookSettings } from '../../shared/settings'
import { defineService } from 'dsh-tauri'
import { normalizeNotifyWebhook } from '../../shared/settings'
import { storage } from '../storage/index'

const DOCUMENT_KEY = 'settings'

export const settings = defineService({
  async load(): Promise<NotifyWebhookSettings> {
    return normalizeNotifyWebhook(await storage.getItem(DOCUMENT_KEY))
  },

  async save(value: NotifyWebhookSettings): Promise<NotifyWebhookSettings> {
    const next = normalizeNotifyWebhook(value)
    await storage.setItem(DOCUMENT_KEY, next)
    return next
  },
})
