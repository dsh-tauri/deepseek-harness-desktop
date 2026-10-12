import type { NotifyWebhookSettings } from '../../shared/settings'
import type { ServiceResult } from '../types/index'
import { getSettings, postSettings, postTest } from '../apis/index'
import { store } from '../store/index'
import { errorMessageOf } from '../utils/error'

export async function loadSettings(): Promise<void> {
  store.settings.beginLoad()
  try {
    const result = await getSettings()
    if (result.settings === undefined) {
      store.settings.fail(result.error ?? '')
      return
    }
    store.settings.commit(result.settings)
  }
  catch (error) {
    store.settings.fail(errorMessageOf(error))
  }
}

export async function saveSettings(values: NotifyWebhookSettings): Promise<ServiceResult> {
  store.settings.beginSave()
  try {
    const result = await postSettings({ settings: values })
    if (result.settings === undefined)
      return { ok: false, error: result.error ?? '' }
    store.settings.commit(result.settings)
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: errorMessageOf(error) }
  }
  finally {
    store.settings.endBusy()
  }
}

export async function sendTest(): Promise<ServiceResult> {
  store.settings.beginTest()
  try {
    const result = await postTest()
    return result.ok === true ? { ok: true } : { ok: false, error: result.error ?? '' }
  }
  catch (error) {
    return { ok: false, error: errorMessageOf(error) }
  }
  finally {
    store.settings.endBusy()
  }
}
