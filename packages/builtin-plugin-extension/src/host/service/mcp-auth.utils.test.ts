import { describe, expect, it, vi } from 'vitest'
import { onceAsync } from './mcp-auth.utils'

describe('onceAsync', () => {
  it('shares one pending call between concurrent callers', async () => {
    const create = vi.fn(async () => ({ id: 1 }))
    const resolve = onceAsync(create)
    const [first, second] = await Promise.all([resolve(), resolve()])
    expect(create).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('reuses the resolved value for later callers', async () => {
    const create = vi.fn(async () => 'value')
    const resolve = onceAsync(create)
    await expect(resolve()).resolves.toBe('value')
    await expect(resolve()).resolves.toBe('value')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed creation', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered')
    const resolve = onceAsync(create)
    await expect(resolve()).rejects.toThrow('boom')
    await expect(resolve()).resolves.toBe('recovered')
    expect(create).toHaveBeenCalledTimes(2)
  })
})
