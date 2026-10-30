import type { CheckoutContext } from '../types'
import { readFileSync } from 'node:fs'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { join } from 'pathe'
import { storage } from '../storage'

const CHECKOUT_CONTEXT_DIR = 'checkout-context'

export const checkoutContext = defineService({
  load(sessionId: string): CheckoutContext | null {
    try {
      return parseContext(readFileSync(join(DSH_HOME, keyOf(sessionId)), 'utf8'))
    }
    catch {
      return null
    }
  },

  async save(sessionId: string, context: CheckoutContext): Promise<void> {
    await storage.setItem(keyOf(sessionId), `${JSON.stringify(context, null, 2)}\n`)
  },

  async remove(sessionId: string): Promise<void> {
    await storage.removeItem(keyOf(sessionId))
  },
})

function keyOf(sessionId: string): string {
  return `${CHECKOUT_CONTEXT_DIR}/${sessionId}.json`
}

function parseContext(raw: string): CheckoutContext | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as CheckoutContext : null
  }
  catch {
    return null
  }
}
