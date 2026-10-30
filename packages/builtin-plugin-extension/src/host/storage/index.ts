import { fsAtomicDriver } from 'dsh-tauri'
import { createStorage } from 'unstorage'
import { SKILLS_DATA_DIR } from '../config/constants'

export const storage = createStorage({ driver: fsAtomicDriver({ base: SKILLS_DATA_DIR }) })
