import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const TEST_STORE_FILE = '.store.test.dat'
const SCRATCH_PREFIX = 'dsh-e2e-desktop-'

export async function resetTestStore(home: string): Promise<void> {
  const scratch = await assertScratchHome(home)
  await rm(join(scratch, 'app-data', TEST_STORE_FILE), { force: true })
}

async function assertScratchHome(home: string): Promise<string> {
  const path = await realpath(home)
  if (dirname(path) !== await realpath(tmpdir()) || !basename(path).startsWith(SCRATCH_PREFIX))
    throw new Error(`桌面 E2E 仅可使用系统临时目录下的 ${SCRATCH_PREFIX} 独占根：${home}`)
  return path
}
