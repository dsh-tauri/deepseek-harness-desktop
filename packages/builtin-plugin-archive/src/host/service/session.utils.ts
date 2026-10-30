import { readdirSync } from 'node:fs'
import { DSH_HOME } from 'dsh-tauri'
import { join, resolve, sep } from 'pathe'

const SESSIONS_DIRECTORY = 'sessions'

const SESSION_DIRECTORY_PREFIX = 'session-'

const SESSION_ID_ESCAPE = '~'

const DOT_SEGMENT = '.'

const DOT_DOT_SEGMENT = '..'

const DOT_ESCAPE = '~002E'

export function sessionsRoot(): string {
  return join(DSH_HOME, SESSIONS_DIRECTORY)
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target !== base && target.startsWith(`${base}${sep}`)
}

export function encodeSessionId(id: string): string {
  if (id === DOT_SEGMENT)
    return DOT_ESCAPE
  if (id === DOT_DOT_SEGMENT)
    return `${DOT_ESCAPE}${DOT_ESCAPE}`
  let encoded = ''
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index)
    const char = String.fromCharCode(code)
    encoded += char !== SESSION_ID_ESCAPE && /^[\w.-]$/.test(char)
      ? char
      : `${SESSION_ID_ESCAPE}${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

export function readDirectory(path: string): string[] | null {
  try {
    return readdirSync(path)
  }
  catch {
    return null
  }
}

export function findSessionDataDir(root: string, sessionId: string): string | null {
  const markers = [encodeSessionId(sessionId), `${SESSION_DIRECTORY_PREFIX}${sessionId}`, sessionId]
    .filter(marker => marker !== DOT_SEGMENT && marker !== DOT_DOT_SEGMENT && !/[/\\\0]/.test(marker))
  const candidates = [
    ...markers.map(marker => join(root, marker)),
    ...directoryNames(root).flatMap(group => markers.map(marker => join(root, group, marker))),
  ]
  return candidates.find(candidate => isWithinRoot(root, candidate) && readDirectory(candidate) !== null) ?? null
}

function directoryNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  }
  catch {
    return []
  }
}
