import type { DetectedRoots, GitHubSource } from './repos.types'
import type { SkillSourceEntry } from './skills.types'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'pathe'
import { SKILL_FILE_NAME } from '../config/constants'

const GITHUB_URL_RE = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|archive)\/([^/#?]+?)(?:\.tar\.gz)?)?(?:#([^/?#]+))?(?:[/?#].*)?$/

const GITHUB_SHORT_RE = /^([\w.-]+)\/([\w.-]+)$/

export function parseGitHubSource(input: string): GitHubSource | null {
  const trimmed = input.trim()
  if (trimmed === '')
    return null
  let owner = ''
  let repo = ''
  let ref: string | undefined
  let match = GITHUB_URL_RE.exec(trimmed)
  if (match !== null) {
    owner = match[1]
    repo = match[2]
    ref = match[3] ?? match[4]
  }
  else {
    match = GITHUB_SHORT_RE.exec(trimmed)
    if (match === null) {
      return null
    }
    ;[, owner, repo] = match
    ref = undefined
  }
  const decodedRef = ref !== undefined ? decodeURIComponent(ref) : undefined
  const label = `${owner}/${repo}`
  const encodedRef = decodedRef?.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const githubUrl = `https://github.com/${owner}/${repo}${encodedRef === undefined ? '' : `/tree/${encodedRef}`}`
  const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${decodedRef ?? 'HEAD'}`
  return { owner, repo, ref: decodedRef, label, githubUrl, tarballUrl }
}

export function detectSkillRoots(checkout: string): DetectedRoots {
  if (existsSync(join(checkout, SKILL_FILE_NAME)))
    return { roots: [], single: true }
  const roots: string[] = []
  if (holdsSkills(checkout))
    roots.push(checkout)
  let entries: string[]
  try {
    entries = readdirSync(checkout)
  }
  catch {
    return { roots, single: false }
  }
  for (const name of entries) {
    if (name.startsWith('.'))
      continue
    const child = join(checkout, name)
    try {
      if (!statSync(child).isDirectory())
        continue
    }
    catch {
      continue
    }
    if (existsSync(join(child, SKILL_FILE_NAME)))
      continue
    if (holdsSkills(child))
      roots.push(child)
  }
  return { roots, single: false }
}

export function newEntryId(kind: SkillSourceEntry['kind']): string {
  return `${kind}-${randomBytes(4).toString('hex')}`
}

function looksLikeSkillFile(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').startsWith('---')
  }
  catch {
    return false
  }
}

function holdsSkills(dir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return false
  }
  if (existsSync(join(dir, SKILL_FILE_NAME)))
    return true
  for (const name of entries) {
    if (name.endsWith('.md') && looksLikeSkillFile(join(dir, name)))
      return true
  }
  for (const name of entries) {
    const child = join(dir, name)
    try {
      if (statSync(child).isDirectory() && existsSync(join(child, SKILL_FILE_NAME)))
        return true
    }
    catch {
      continue
    }
  }
  return false
}
