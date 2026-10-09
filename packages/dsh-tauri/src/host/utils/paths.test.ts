import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveUngroupedSessionPath } from './paths'

describe('resolveUngroupedSessionPath', () => {
  it('uses DSH_HOME instead of the core installation directory', () => {
    expect(resolveUngroupedSessionPath({ DSH_HOME: 'D:\\harness' }))
      .toBe(resolve('D:\\harness', 'ungrouped'))
  })

  it('defaults to ~/.dsh/ungrouped without a configured home', () => {
    expect(resolveUngroupedSessionPath({})).toBe(join(homedir(), '.dsh', 'ungrouped'))
    expect(resolveUngroupedSessionPath({ DSH_HOME: '  ' })).toBe(join(homedir(), '.dsh', 'ungrouped'))
  })

  it('expands both home-relative spellings', () => {
    expect(resolveUngroupedSessionPath({ DSH_HOME: '~/harness' })).toBe(join(homedir(), 'harness', 'ungrouped'))
    expect(resolveUngroupedSessionPath({ DSH_HOME: '~\\harness' })).toBe(join(homedir(), 'harness', 'ungrouped'))
    expect(resolveUngroupedSessionPath({ DSH_HOME: '~' })).toBe(join(homedir(), 'ungrouped'))
  })
})
