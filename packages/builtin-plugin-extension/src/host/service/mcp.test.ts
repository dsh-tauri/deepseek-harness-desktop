import type { McpRow } from './mcp.types'
import { afterEach, expect, it, vi } from 'vitest'
import { mcp } from './mcp'
import { mcpAuth } from './mcp-auth'

const row: McpRow = { id: 'figma', serverName: 'figma', transport: 'streamable-http', disabled: false, url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer configured' } }

afterEach(() => vi.restoreAllMocks())

it('delegates HTTP checks with the complete row and timeout to the shared OAuth backend', async () => {
  const result = { ok: false, requiresAuth: true, detail: 'authorization required' }
  const check = vi.spyOn(mcpAuth, 'check').mockResolvedValue(result)
  expect(await mcp.check(row, { timeoutMs: 1234 })).toEqual(result)
  expect(check).toHaveBeenCalledWith(row, 1234)
})

it('rejects invalid URLs without starting OAuth and keeps stdio checks local', async () => {
  const check = vi.spyOn(mcpAuth, 'check')
  expect(await mcp.check({ ...row, url: 'file:///local' })).toEqual({ ok: false, detail: 'row has no http url' })
  expect(await mcp.check({ ...row, transport: 'stdio', command: '' })).toEqual({ ok: false, detail: 'row has no command' })
  expect(check).not.toHaveBeenCalled()
})
