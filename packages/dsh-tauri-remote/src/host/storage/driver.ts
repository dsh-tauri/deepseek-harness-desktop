import type { Driver } from 'unstorage'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'pathe'
import { stateDocumentPath } from '../config/runtime'

const DOCUMENT_KEY = 'state'

export function remoteDocumentDriver(): Driver {
  return {
    name: 'dsh-tauri-remote-document',
    hasItem(key: string): boolean {
      return key === DOCUMENT_KEY && readDocument() !== undefined
    },
    getItem(key: string): string | null {
      if (key !== DOCUMENT_KEY)
        return null
      return readDocument() ?? null
    },
    setItem(key: string, value: string): void {
      if (key === DOCUMENT_KEY)
        writeDocument(value)
    },
    removeItem(key: string): void {
      if (key === DOCUMENT_KEY)
        rmSync(stateDocumentPath(), { force: true })
    },
    getKeys(): string[] {
      return [DOCUMENT_KEY]
    },
  }
}

function readDocument(): string | undefined {
  try {
    return readFileSync(stateDocumentPath(), 'utf8')
  }
  catch {
    return undefined
  }
}

function writeDocument(text: string): void {
  const file = stateDocumentPath()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(JSON.parse(text) as unknown, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
