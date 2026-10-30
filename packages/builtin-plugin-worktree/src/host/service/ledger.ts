import type { Binding } from '../types'
import { readdirSync, readFileSync } from 'node:fs'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { isPlainObject } from 'lodash-es'
import { join } from 'pathe'
import { storage } from '../storage'

const LEDGER_DIR = 'ledger'

export const ledger = defineService({
  load(sessionId: string): Binding | null {
    return readBinding(join(DSH_HOME, keyOf(sessionId)))
  },

  async save(sessionId: string, binding: Binding): Promise<void> {
    await storage.setItem(keyOf(sessionId), `${JSON.stringify(binding, null, 2)}\n`)
  },

  async remove(sessionId: string): Promise<void> {
    await storage.removeItem(keyOf(sessionId))
  },

  list(): Binding[] {
    const dir = join(DSH_HOME, LEDGER_DIR)
    return readJsonNames(dir).map(name => readBinding(join(dir, name))).filter(binding => binding !== null)
  },
})

function keyOf(sessionId: string): string {
  return `${LEDGER_DIR}/${sessionId}.json`
}

function readJsonNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => name.endsWith('.json'))
  }
  catch {
    return []
  }
}

function readBinding(path: string): Binding | null {
  try {
    return parseBinding(readFileSync(path, 'utf8'))
  }
  catch {
    return null
  }
}

function parseBinding(raw: string): Binding | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed as Binding : null
  }
  catch {
    return null
  }
}
