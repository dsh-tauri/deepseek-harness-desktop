import type { ApiPipeline } from '@genapi/shared'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { context } from '@genapi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import configuration from '../genapi.config'

const roots: string[] = []
afterEach(() => {
  for (const key of Object.keys(context))
    delete context[key]
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve('.temp') || !root.startsWith(join(resolve('.temp'), 'genapi-test-')))
      throw new Error(`Unexpected fixture root: ${root}`)
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(): ApiPipeline.Config {
  mkdirSync(resolve('.temp'), { recursive: true })
  const root = mkdtempSync(join(resolve('.temp'), 'genapi-test-'))
  roots.push(root)
  writeFileSync(join(root, 'index.ts'), `
import { defineWebServer } from 'dsh-h3'
import { defineEventHandler, getQuery, readBody } from 'h3'
export const server = defineWebServer((app) => {
  app.get('/api/tauri/extension/items', defineEventHandler((event) => {
    const query = getQuery<{ id: string; mode?: 'a' | 'b' }>(event)
    return { id: query.id, count: 1 }
  }))
  app.post('/api/tauri/extension/items', defineEventHandler(async (event) => {
    const body = await readBody<{ name: string; count?: number }>(event)
    if (!body) throw new Error('Missing body')
    return { name: body.name, count: body.count ?? 0 }
  }))
})
`)
  return {
    input: join(root, 'index.ts'),
    output: { main: relative('.', join(root, 'api.ts')), type: relative('.', join(root, 'api.type.ts')) },
    meta: configuration.meta,
    transform: configuration.transform,
    patch: configuration.patch,
  }
}

describe('upstream H3 API generation', () => {
  it('uses actual service registrations, typed contracts and the existing JSON transport', async () => {
    const config = fixture()
    if (typeof configuration.preset !== 'function')
      throw new TypeError('Expected configured API pipeline')
    await configuration.preset(config)
    const output = config.output as { main: string, type: string }
    const code = readFileSync(output.main, 'utf8')
    const types = readFileSync(output.type, 'utf8')
    expect(code).toContain('import { ofetch } from "dsh-tauri/client"')
    expect(code).toContain('import type { FetchOptions } from "dsh-tauri/client"')
    expect(code).not.toContain('from "ofetch"')
    expect(code).toContain('export function getItems(')
    expect(code).toContain('export function postItems(')
    expect(code).toContain('"/api/tauri/extension/items", { method: "get", params, ...options }')
    expect(code).toContain('"/api/tauri/extension/items", { method: "post", body, ...options }')
    expect(types).toContain('name: string')
    expect(types).toContain('count?: undefined | number')
    expect(types).toContain('id: string')
    expect(types).not.toMatch(/response\s*=\s*unknown/i)
  }, 30_000)
})
