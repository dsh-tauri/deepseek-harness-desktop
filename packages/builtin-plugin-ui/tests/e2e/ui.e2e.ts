import { describe, expect, inject, it } from 'vitest'

const RESUME_PATH = '/api/tauri/ui/session/resume'
const UNGROUPED_PATH = '/api/tauri/ui/ungrouped'

function headers(): Record<string, string> {
  return { 'cookie': inject('dshCookie'), 'content-type': 'application/json' }
}

function resume(body: string): Promise<Response> {
  return fetch(`${inject('dshBaseUrl')}${RESUME_PATH}`, { method: 'POST', headers: headers(), body })
}

describe('ui host routes', () => {
  it('rejects resume without sessionId with 400', async () => {
    const response = await resume('{}')
    expect(response.status).toBe(400)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('缺少 sessionId')
    expect(JSON.stringify(body)).not.toContain('"ok":true')
  })

  it('rejects resume of an unknown session with 404', async () => {
    const response = await resume(JSON.stringify({ sessionId: 'does-not-exist' }))
    expect(response.status).toBe(404)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('会话不存在或尚未运行')
    expect(JSON.stringify(body)).not.toContain('"ok":true')
  })

  it('resolves the ungrouped directory under DSH_HOME instead of the core install dir', async () => {
    const home = inject('dshHome')
    const response = await fetch(`${inject('dshBaseUrl')}${UNGROUPED_PATH}`, { headers: headers() })
    expect(response.status).toBe(200)
    const body = await response.json() as { cwd?: string, error?: string }
    expect(Object.keys(body)).toEqual(['cwd'])
    expect(String(body.cwd).startsWith(home)).toBe(true)
    expect(String(body.cwd).split(/\//).at(-1)).toBe('ungrouped')
    expect(body.cwd).not.toMatch(/dependencies\/dsh$/)
  })
})
