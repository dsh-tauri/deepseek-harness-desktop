import { fsAtomicDriver } from 'dsh-tauri'
import { createStorage } from 'unstorage'

export const storage = createStorage({ driver: fsAtomicDriver({ base: 'notify-webhook' }) })
