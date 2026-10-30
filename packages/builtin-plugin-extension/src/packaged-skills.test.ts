import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { SKILL_NAME_RE } from './host/config/constants'

const PACKAGED_SKILLS = ['find-skills', 'skill-creator'] as const

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(packageRoot, 'skills')

function readFrontmatter(path: string): { name?: unknown, description?: unknown } {
  const raw = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  expect(match, `${path} has YAML frontmatter`).toBeDefined()
  return parse(match![1]!) as { name?: unknown, description?: unknown }
}

describe('packaged skills', () => {
  it('ships the vendored skills with their licenses', () => {
    const directories = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(directories).toEqual([...PACKAGED_SKILLS].sort())
    expect(existsSync(join(skillsDir, 'skill-creator', 'LICENSE.txt'))).toBe(true)
    expect(existsSync(join(skillsDir, 'find-skills', 'LICENSE'))).toBe(true)
  })

  it('keeps every packaged skill loadable by the scanner', () => {
    for (const name of PACKAGED_SKILLS) {
      const frontmatter = readFrontmatter(join(skillsDir, name, 'SKILL.md'))
      expect(frontmatter.name, `${name} frontmatter name`).toBe(name)
      expect(SKILL_NAME_RE.test(String(frontmatter.name)), `${name} name grammar`).toBe(true)
      expect(typeof frontmatter.description).toBe('string')
      expect(String(frontmatter.description).length).toBeGreaterThan(0)
    }
  })

  it('resolves the skills directory from the shipped entry point', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      main?: unknown
      exports?: Record<string, unknown>
    }
    const entries = [manifest.main, manifest.exports?.['.']]
      .filter((entry): entry is string => typeof entry === 'string')
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      const fromdist = join(packageRoot, dirname(entry), '..', 'skills')
      expect(fromdist).toBe(skillsDir)
      expect(existsSync(fromdist), `${entry} resolves its packaged skills`).toBe(true)
    }
  })
})
