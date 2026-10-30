import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { recoverScheduler } from '../service/scheduler'

export const hydrateFeature = defineRegister<ClientContext>(() => {
  void recoverScheduler()
})
