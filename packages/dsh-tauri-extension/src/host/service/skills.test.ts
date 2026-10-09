import type { SkillSourceEntry } from './skills.types'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtureRoot = resolve(process.cwd(), '.temp')

const fixture = vi.hoisted(() => ({ home: '' }))

vi.mock('dsh-tauri', async () => {
  const [service, driver] = await Promise.all([
    import('../../../../dsh-tauri/src/host/service'),
    import('../../../../dsh-tauri/src/host/utils/driver'),
  ])
  return {
    get DSH_HOME() {
      return fixture.home
    },
    defineService: service.defineService,
    guard: () => undefined,
    fsAtomicDriver: driver.fsAtomicDriver,
  }
})

let scratch: string
let home: string
let stateFile: string
let skills: typeof import('./skills')['skills']

beforeEach(async () => {
  vi.resetModules()
  mkdirSync(fixtureRoot, { recursive: true })
  scratch = mkdtempSync(join(fixtureRoot, 'skills-848-'))
  home = join(scratch, 'home')
  fixture.home = home
  stateFile = join(home, 'skills', 'state.json')
  mkdirSync(dirname(stateFile), { recursive: true })
  ;({ skills } = await import('./skills'))
})

afterEach(() => {
  vi.restoreAllMocks()
  if (dirname(scratch) !== fixtureRoot || !scratch.startsWith(join(fixtureRoot, 'skills-848-')))
    throw new Error(`Unexpected scratch path: ${scratch}`)
  rmSync(scratch, { recursive: true, force: true })
})

function sourceEntry(overrides: Partial<SkillSourceEntry>): SkillSourceEntry {
  return { id: 'git-1234abcd', kind: 'git', label: 'demo', roots: [], addedAt: 1, ...overrides }
}

function writeSource(entry: SkillSourceEntry): string {
  const text = `${JSON.stringify({ skillRoots: [entry] }, null, 2)}\n`
  writeFileSync(stateFile, text, 'utf8')
  return text
}

describe('skills.removeSource material ownership', () => {
  it('rejects a persisted home deletion target without changing source state', async () => {
    const sentinel = join(home, 'keep.txt')
    writeFileSync(sentinel, 'home must survive', 'utf8')
    const written = writeSource(sourceEntry({ roots: [home], materialDir: home }))

    await expect(skills.removeSource('git-1234abcd')).rejects.toThrow('unsafe skill material directory')
    expect(readFileSync(sentinel, 'utf8')).toBe('home must survive')
    expect(readFileSync(stateFile, 'utf8')).toBe(written)
  })

  it('rejects a material directory that is a link to another location', async () => {
    const material = join(home, 'skills', 'repos', 'git-1234abcd')
    const target = join(scratch, 'external')
    mkdirSync(target, { recursive: true })
    mkdirSync(dirname(material), { recursive: true })
    writeFileSync(join(target, 'keep.txt'), 'external must survive', 'utf8')
    symlinkSync(target, material, process.platform === 'win32' ? 'junction' : 'dir')
    const written = writeSource(sourceEntry({ roots: [material], materialDir: material }))

    await expect(skills.removeSource('git-1234abcd')).rejects.toThrow('unsafe skill material directory')
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('external must survive')
    expect(readFileSync(stateFile, 'utf8')).toBe(written)
  })

  it('deletes the owned material directory before dropping the state entry', async () => {
    const material = join(home, 'skills', 'repos', 'git-1234abcd')
    mkdirSync(material, { recursive: true })
    writeFileSync(join(material, 'SKILL.md'), '---\nname: demo\n---\n', 'utf8')
    writeSource(sourceEntry({ roots: [material], materialDir: material }))

    const removed = await skills.removeSource('git-1234abcd')

    expect(removed?.id).toBe('git-1234abcd')
    expect(existsSync(material)).toBe(false)
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ skillRoots: [] })
  })
})
