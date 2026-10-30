import type { Driver } from 'unstorage'
import type { FSStorageOptions } from 'unstorage/drivers/fs'
import { isAbsolute, join } from 'node:path'
import fsDriver from 'unstorage/drivers/fs'
import { DSH_HOME } from '../config/constants'
import { writeAtomic } from './atomic'

export function fsAtomicDriver(options?: FSStorageOptions): Driver<FSStorageOptions, never> {
  const basic = options?.base || '.storage'
  const base = isAbsolute(basic) ? basic : join(DSH_HOME, basic)

  return {
    ...fsDriver({ ...options, base }),
    async setItem(key: string, value: string) {
      const target = join(base, key.replace(/:/g, '/'))
      await writeAtomic(target, value)
    },
  }
}
