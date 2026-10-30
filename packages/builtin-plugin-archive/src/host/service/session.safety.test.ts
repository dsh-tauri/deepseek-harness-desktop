import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return {
    ...actual,
    get DSH_HOME() {
      return home.value
    },
  }
})
let session: typeof import('./session')['session']
let scratch: string
beforeEach(async () => {
  vi.resetModules()
  scratch = mkdtempSync(join(tmpdir(), 'dsh-session-audit-'))
  home.value = join(scratch, 'dsh-home')
  const group = join(home.value, 'sessions/project/session-unrelated')
  mkdirSync(group, { recursive: true })
  writeFileSync(join(group, 'sentinel.txt'), 'preserve unrelated conversation')
  ;({ session } = await import('./session'))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})
it.each(['.', '..', '...', '. ', '.. ', '... ', 'project/..', 'project/../.', 'project/../session-unrelated', 'project\\..\\session-unrelated'])('preserves unrelated sessions for unsafe legacy id %s', (id) => {
  const removed = session.removeDir(id)
  expect(existsSync(join(home.value, 'sessions/project/session-unrelated/sentinel.txt'))).toBe(true)
  expect(removed).toBe(false)
})
it.each([
  ['.', '~002E'],
  ['..', '~002E~002E'],
  ['project/../session-unrelated', 'project~002F..~002Fsession-unrelated'],
])('deletes the encoded session %s while preserving unrelated conversations', (id, marker) => {
  const target = join(home.value, 'sessions/project', marker)
  mkdirSync(target)
  writeFileSync(join(target, 'session.json'), 'the dot session')
  expect(session.removeDir(id)).toBe(true)
  expect(existsSync(target)).toBe(false)
  expect(readFileSync(join(home.value, 'sessions/project/session-unrelated/sentinel.txt'), 'utf8')).toBe('preserve unrelated conversation')
})
