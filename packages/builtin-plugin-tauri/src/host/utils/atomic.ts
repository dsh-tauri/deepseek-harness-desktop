import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const RENAME_MAX_RETRIES = 8
const RENAME_RETRY_DELAY_MS = 25

export async function writeAtomic(target: string, value: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`

  try {
    await writeFile(temporary, value, 'utf8')
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, target)
        return
      }
      catch (error) {
        if (attempt >= RENAME_MAX_RETRIES || (error as NodeJS.ErrnoException)?.code !== 'EPERM') {
          throw error
        }
        await sleep(RENAME_RETRY_DELAY_MS)
      }
    }
  }
  catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
