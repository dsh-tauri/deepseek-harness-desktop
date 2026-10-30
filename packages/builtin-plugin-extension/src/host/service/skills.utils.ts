import type { SkillInput, SkillSourceEntry, SkillSourceView } from './skills.types'
import { lstatSync } from 'node:fs'
import { isEmpty } from 'lodash-es'
import { dirname, resolve } from 'pathe'
import { SKILL_NAME_RE, SKILLS_DATA_DIR } from '../config/constants'
import { directoryExists } from '../utils/filesystem.utils'
import { materialDirFor } from '../utils/paths.utils'

const SKILL_DESCRIPTION_MAX_LENGTH = 1024

const SKILL_WHEN_TO_USE_MAX_LENGTH = 2048

const SKILL_CONTENT_MAX_BYTES = 256 * 1024

export function rootView(entry: SkillSourceEntry): SkillSourceView {
  return { ...entry, live: entry.roots.every(root => directoryExists(root)) }
}

export function isSkillSourceEntry(entry: unknown): entry is SkillSourceEntry {
  if (typeof entry !== 'object' || entry === null)
    return false
  const candidate = entry as Record<string, unknown>
  return typeof candidate.id === 'string' && Array.isArray(candidate.roots)
}

export function isOwnedMaterialDir(entryId: string, materialDir: string): boolean {
  if (typeof entryId !== 'string' || typeof materialDir !== 'string')
    return false
  const expected = materialDirFor(entryId)
  if (dirname(resolve(expected)) !== resolve(SKILLS_DATA_DIR, 'repos'))
    return false
  if (resolve(materialDir) !== resolve(expected))
    return false
  return [SKILLS_DATA_DIR, dirname(expected), expected].every(dir => !isLinkLike(dir))
}

function isLinkLike(path: string): boolean {
  const stats = lstatSync(path, { throwIfNoEntry: false })
  return stats !== undefined && stats.isSymbolicLink()
}

export function serializeSkill(input: SkillInput): string {
  const lines = [
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
  ]
  if (!isEmpty(input.whenToUse))
    lines.push(`whenToUse: ${JSON.stringify(input.whenToUse)}`)
  if (!input.modelInvocable)
    lines.push('disable-model-invocation: true')
  if (!input.userInvocable)
    lines.push('user-invocable: false')
  const body = input.content.replace(/\r\n/g, '\n').trim()
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}

export function validateSkillInput(input: SkillInput): string | null {
  if (!SKILL_NAME_RE.test(input.name))
    return 'name must be kebab-case (a-z, 0-9, dashes)'
  if (input.description.trim() === '')
    return 'description is required'
  if (input.description.length > SKILL_DESCRIPTION_MAX_LENGTH)
    return `description too long (max ${SKILL_DESCRIPTION_MAX_LENGTH})`
  if ((input.whenToUse?.length ?? 0) > SKILL_WHEN_TO_USE_MAX_LENGTH)
    return `whenToUse too long (max ${SKILL_WHEN_TO_USE_MAX_LENGTH})`
  if (input.content.length > SKILL_CONTENT_MAX_BYTES)
    return 'content too large (max 256 KiB)'
  return null
}

export function rewriteSkillContent(text: string, input: SkillInput): string {
  const { newline, lines } = frontmatterOf(text)
  const kept = lines.filter(line => !/^(?:name|description|whenToUse|disable-model-invocation|user-invocable):/.test(line))
  const head = [`name: ${input.name}`, `description: ${JSON.stringify(input.description)}`]
  if (!isEmpty(input.whenToUse))
    head.push(`whenToUse: ${JSON.stringify(input.whenToUse)}`)
  if (!input.modelInvocable)
    kept.push('disable-model-invocation: true')
  if (!input.userInvocable)
    kept.push('user-invocable: false')
  const body = input.content.replace(/\r\n/g, '\n').trim()
  return `---${newline}${[...head, ...kept].join(newline)}${newline}---${newline}${newline}${body}${newline}`
}

export function rewriteSkillPolicy(text: string, enabled: boolean): string {
  const { newline, lines, body } = frontmatterOf(text)
  const kept = lines.filter(line => !/^(?:disable-model-invocation|user-invocable):/.test(line))
  if (!enabled)
    kept.push('disable-model-invocation: true', 'user-invocable: false')
  return `---${newline}${kept.join(newline)}${newline}---${body}`
}

function frontmatterOf(text: string): { newline: string, lines: string[], body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null)
    throw new Error('skill file has no frontmatter block')
  return {
    newline: text.includes('\r\n---') ? '\r\n' : '\n',
    lines: match[1].split(/\r?\n/),
    body: text.slice(match[0].length),
  }
}
