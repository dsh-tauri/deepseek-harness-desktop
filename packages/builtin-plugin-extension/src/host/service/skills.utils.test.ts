import type { SkillInput } from './skills.types'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { rewriteSkillContent, rewriteSkillPolicy } from './skills.utils'

vi.mock('dsh-tauri', () => ({ DSH_HOME: '/unused-skill-test-home' }))

const input: SkillInput = {
  name: 'example',
  description: 'Updated description\nSecond line',
  modelInvocable: true,
  userInvocable: true,
  content: 'Updated instructions',
}

function metadata(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(text)
  expect(match).not.toBeNull()
  return parse(match![1]) as Record<string, unknown>
}

describe('skill frontmatter editing', () => {
  it.each(['|', '>'])('replaces a %s description without leaving its old continuation lines', (style) => {
    const text = `---\nname: example\ndescription: ${style}\n  Original description\n  Original continuation\nwhenToUse: |\n  Obsolete condition\nmetadata:\n  nested:\n    - keep\n    - true\n# preserved annotation\nlicense: MIT\n---\n\nOriginal instructions\n`
    const result = rewriteSkillContent(text, input)
    expect(metadata(result)).toEqual({ name: 'example', description: input.description, metadata: { nested: ['keep', true] }, license: 'MIT' })
    expect(result).toContain('# preserved annotation')
    expect(result).not.toContain('Original continuation')
    expect(result).not.toContain('Obsolete condition')
    expect(result.endsWith('\n\nUpdated instructions\n')).toBe(true)
  })

  it('preserves unknown anchored metadata and CRLF when editing quoted keys', () => {
    const text = '---\r\n"name": example\r\n"description": old\r\nmetadata: &details\r\n  author: tester\r\n  flags: [a, b]\r\ncustom: *details\r\n---\r\n\r\nOld body\r\n'
    const result = rewriteSkillContent(text, { ...input, whenToUse: 'New condition', modelInvocable: false, userInvocable: false })
    expect(metadata(result)).toEqual({ 'name': 'example', 'description': input.description, 'whenToUse': 'New condition', 'metadata': { author: 'tester', flags: ['a', 'b'] }, 'custom': { author: 'tester', flags: ['a', 'b'] }, 'disable-model-invocation': true, 'user-invocable': false })
    expect(result).not.toMatch(/(?<!\r)\n/)
  })

  it('updates quoted invocation keys without duplicate policy fields or body changes', () => {
    const text = '---\nname: example\ndescription: |\n  A description\n"disable-model-invocation": true\n"user-invocable": false\nmetadata: {preserved: true}\n---\n\nBody with trailing spaces  \n'
    const enabled = rewriteSkillPolicy(text, true)
    expect(metadata(enabled)).toEqual({ name: 'example', description: 'A description\n', metadata: { preserved: true } })
    const disabled = rewriteSkillPolicy(enabled, false)
    expect(metadata(disabled)).toEqual({ 'name': 'example', 'description': 'A description\n', 'metadata': { preserved: true }, 'disable-model-invocation': true, 'user-invocable': false })
    expect(disabled.endsWith('\n\nBody with trailing spaces  \n')).toBe(true)
  })

  it.each([
    '---\nname: example\ndescription: [invalid\n---\nBody',
    '---\n- name\n- example\n---\nBody',
    '---\nname: example\nname: duplicate\ndescription: old\n---\nBody',
  ])('rejects malformed or non-mapping frontmatter before producing a replacement', (text) => {
    expect(() => rewriteSkillContent(text, input)).toThrow()
    expect(() => rewriteSkillPolicy(text, false)).toThrow()
  })
})
