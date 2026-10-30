import process from 'node:process'
import { defineService } from 'dsh-tauri'

export const session = defineService({
  role(): { remote: boolean, origin?: string } {
    const origin = process.env.DSH_REMOTE_SESSION_ORIGIN
    return origin === undefined || origin === ''
      ? { remote: false }
      : { remote: true, origin }
  },
})
