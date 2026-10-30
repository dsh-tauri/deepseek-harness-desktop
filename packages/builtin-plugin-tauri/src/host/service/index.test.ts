import { describe, expect, it } from 'vitest'
import { defineService } from './index'

describe('defineService', () => {
  it('原样返回传入对象（零包装）', () => {
    const ledger = {
      load: (sessionId: string) => sessionId,
    }
    expect(defineService(ledger)).toBe(ledger)
  })

  it('方法保持原有签名', () => {
    const cleaner = defineService({
      start: (sessionId: string) => `start:${sessionId}`,
      unsettled: () => [],
    })
    expect(cleaner.start('s1')).toBe('start:s1')
    expect(cleaner.unsettled()).toEqual([])
  })
})
