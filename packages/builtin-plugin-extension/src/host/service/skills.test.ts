import type { FileSystemSkillProvider as Provider } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillSourceEntry } from './skills.types'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { mockEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import removeSkill from '../server/routes/skill.delete'
import saveSkill from '../server/routes/skill.post'
import { skills } from './skills'

const fixture = vi.hoisted(() => ({ root: '', host: {} as unknown, sources: [] as SkillSourceEntry[] }))
vi.mock('dsh-tauri', () => ({ defineService: <T>(value: T): T => value, DSH_HOME: '/unused-skill-test-home' }))
vi.mock('dsh-h3/utils', () => ({ getServerContext: () => fixture.host }))
vi.mock('../server', () => ({ server: {} }))
vi.mock('../storage', () => ({ storage: { getItem: async () => ({ skillRoots: fixture.sources }) } }))
vi.mock('../config/constants', () => ({
  get SKILLS_DATA_DIR() { return fixture.root },
  SKILL_FILE_NAME: 'SKILL.md',
  SKILL_NAME_RE: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
}))

let scratch: string
let provider: Provider

function write(relative: string, name: string, extra = ''): string {
  const file = join(fixture.root, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `---\nname: ${name}\ndescription: |\n  Original description\nmetadata: {preserve: true}\n---\n\nOriginal body\n${extra}`)
  return file
}

function request(method: 'POST' | 'DELETE', body: object) {
  return mockEvent('http://localhost/api/tauri/extension/skill', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-skills-test-'))
  fixture.root = join(scratch, 'skills')
  fixture.sources = []
  mkdirSync(fixture.root)
  provider = new FileSystemSkillProvider({ get: () => undefined, logger: { warn: vi.fn() } } as unknown as ConstructorParameters<typeof FileSystemSkillProvider>[0], { signal: new AbortController().signal, invalidate: () => {} }, { dshHome: scratch, agentsHome: join(scratch, 'agents'), bundledSkillDir: join(scratch, 'bundled'), customSkillDirs: [join(scratch, 'custom'), join(scratch, 'custom-neighbor')], watch: false })
  const list = async () => {
    const observation = await provider.list({})
    return Array.isArray(observation) ? observation : observation.candidates
  }
  fixture.host = { skills: { list, get: async (name: string) => {
    const candidate = (await list()).find(skill => skill.name === name)
    return candidate ? provider.get(candidate, {}) : undefined
  } } }
})

afterEach(async () => {
  await provider.dispose()
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('skill file mutations', () => {
  it.each(['flat.md', 'different-folder/SKILL.md'])('edits the provider file %s without inferring its path from the skill name', async (relative) => {
    const file = write(relative, 'example')
    const sibling = write('unrelated.md', 'unrelated')
    const originalSibling = readFileSync(sibling, 'utf8')
    const event = request('POST', { name: 'example', description: 'Updated description', content: 'Updated body' })
    expect(await saveSkill(event)).toEqual({ ok: true, name: 'example' })
    expect(event.res.status).not.toBe(500)
    const text = readFileSync(file, 'utf8')
    expect(parse(text.split('---')[1])).toEqual({ name: 'example', description: 'Updated description', metadata: { preserve: true } })
    expect(text).toContain('Updated body')
    expect(readFileSync(sibling, 'utf8')).toBe(originalSibling)
    expect(existsSync(join(fixture.root, 'example'))).toBe(false)
  })

  it('deletes only a flat Markdown file and keeps its parent and sibling skills', async () => {
    const file = write('flat.md', 'example')
    const sibling = write('other/SKILL.md', 'other')
    const event = request('DELETE', { name: 'example' })
    expect(await removeSkill(event)).toEqual({ ok: true, name: 'example' })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(fixture.root)).toBe(true)
    expect(existsSync(sibling)).toBe(true)
  })

  it('deletes a directory bundle using its provider location and keeps unrelated same-name directories', async () => {
    const file = write('actual-folder/SKILL.md', 'example')
    writeFileSync(join(file, '..', 'helper.txt'), 'bundle resource')
    const unrelated = write('example/SKILL.md', 'other')
    expect(await removeSkill(request('DELETE', { name: 'example' }))).toEqual({ ok: true, name: 'example' })
    expect(existsSync(join(fixture.root, 'actual-folder'))).toBe(false)
    expect(readFileSync(unrelated, 'utf8')).toContain('name: other')
  })

  it('treats a root SKILL.md as a flat file and never deletes the skill root', async () => {
    const file = write('SKILL.md', 'root-skill')
    const sibling = write('other.md', 'other')
    expect(await removeSkill(request('DELETE', { name: 'root-skill' }))).toEqual({ ok: true, name: 'root-skill' })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
  })

  it('does not delete a directory guessed from an unknown skill name', async () => {
    const unrelated = join(fixture.root, 'unknown', 'notes.txt')
    mkdirSync(join(unrelated, '..'), { recursive: true })
    writeFileSync(unrelated, 'preserve')
    const event = request('DELETE', { name: 'unknown' })
    expect(await removeSkill(event)).toEqual({ error: 'skill not found' })
    expect(event.res.status).toBe(404)
    expect(readFileSync(unrelated, 'utf8')).toBe('preserve')
  })

  it('refuses directory deletion through a skill link outside the owned root', async () => {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    const file = join(outside, 'SKILL.md')
    writeFileSync(file, '---\nname: linked\ndescription: External skill\n---\nKeep\n')
    symlinkSync(outside, join(fixture.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const event = request('DELETE', { name: 'linked' })
    expect(await removeSkill(event)).toEqual({ error: 'skill not found' })
    expect(event.res.status).toBe(404)
    expect(readFileSync(file, 'utf8')).toContain('Keep')
  })

  it('does not use a missing provider path as permission to guess a filename', async () => {
    const file = write('virtual/SKILL.md', 'different-skill')
    fixture.host = { skills: { list: async () => [{ name: 'virtual', description: 'Virtual', source: 'user-dsh', provider: 'test', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: join(fixture.root, 'virtual') } }], get: async () => ({ name: 'virtual', content: 'Virtual' }) } }
    const before = readFileSync(file, 'utf8')
    expect(await skills.remove('virtual')).toBe(false)
    const event = request('POST', { name: 'virtual', description: 'Updated', content: 'Updated' })
    expect(await saveSkill(event)).toHaveProperty('error')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('edits a registered custom root when its stored path uses different separators', async () => {
    const file = write('../custom/flat.md', 'custom-skill')
    const root = join(scratch, 'custom')
    const stored = process.platform === 'win32' ? root.replaceAll('\\', '/') : root.replaceAll('/', '\\')
    fixture.sources = [{ id: 'custom', kind: 'local', label: 'Custom', roots: [stored], addedAt: 1 }]

    expect(await skills.getCatalog()).toEqual([expect.objectContaining({ name: 'custom-skill', source: 'custom', editable: true, removable: false })])
    expect(await saveSkill(request('POST', { name: 'custom-skill', description: 'Updated', content: 'Custom instructions' }))).toEqual({ ok: true, name: 'custom-skill' })
    expect(readFileSync(file, 'utf8')).toContain('Custom instructions')
  })

  it('edits a registered single-skill directory link through its provider path', async () => {
    const file = write('../single-skill/SKILL.md', 'linked-custom')
    const root = join(scratch, 'custom')
    mkdirSync(root)
    const link = join(root, 'linked')
    symlinkSync(join(scratch, 'single-skill'), link, process.platform === 'win32' ? 'junction' : 'dir')
    fixture.sources = [{ id: 'custom', kind: 'local', label: 'Custom', roots: [root], addedAt: 1 }]

    expect(await skills.getCatalog()).toEqual([expect.objectContaining({ name: 'linked-custom', source: 'custom', editable: true, removable: false })])
    expect(await saveSkill(request('POST', { name: 'linked-custom', description: 'Updated', content: 'Linked instructions' }))).toEqual({ ok: true, name: 'linked-custom' })
    expect(readFileSync(file, 'utf8')).toContain('Linked instructions')
    expect(existsSync(link)).toBe(true)
  })

  it.each([
    { relative: '../agents/skills/flat.md', source: 'user-agents' },
    { relative: '../bundled/flat.md', source: 'bundled' },
    { relative: '../custom/flat.md', source: 'custom' },
  ])('keeps an unregistered $source skill read-only', async ({ relative, source }) => {
    const file = write(relative, 'readonly-skill')
    const original = readFileSync(file, 'utf8')
    expect(await skills.getCatalog()).toEqual([expect.objectContaining({ name: 'readonly-skill', source, editable: false, removable: false })])

    const event = request('POST', { name: 'readonly-skill', description: 'Changed', content: 'Changed' })
    expect(await saveSkill(event)).toEqual({ error: `skills from source '${source}' are read-only` })
    expect(event.res.status).toBe(403)
    expect(await removeSkill(request('DELETE', { name: 'readonly-skill' }))).toEqual({ error: 'skill not found' })
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('does not grant edit access to a sibling directory sharing a registered root prefix', async () => {
    const file = write('../custom-neighbor/flat.md', 'neighbor')
    fixture.sources = [{ id: 'custom', kind: 'local', label: 'Custom', roots: [join(scratch, 'custom')], addedAt: 1 }]
    const original = readFileSync(file, 'utf8')

    expect(await skills.getCatalog()).toEqual([expect.objectContaining({ name: 'neighbor', source: 'custom', editable: false, removable: false })])
    const event = request('POST', { name: 'neighbor', description: 'Changed', content: 'Changed' })
    expect(await saveSkill(event)).toEqual({ error: 'skills from source \'custom\' are read-only' })
    expect(event.res.status).toBe(403)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })
})
