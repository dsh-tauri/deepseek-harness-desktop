import type { Translate } from '../locales/index.types'
import { describe, expect, it } from 'vitest'
import { failText } from './outcome.utils'

const t: Translate = key => key === 'failed' ? '失败' : key

describe('failText', () => {
  it('uses the localized failure label and Error message without its class prefix', () => {
    expect(failText(t, new TypeError('cannot load'))).toBe('失败: cannot load')
  })

  it.each([
    ['offline', '失败: offline'],
    [null, '失败: null'],
    [undefined, '失败: undefined'],
    [0, '失败: 0'],
    [{ message: 'plain object' }, '失败: [object Object]'],
  ])('stringifies the non-Error rejection %j', (error, expected) => {
    expect(failText(t, error)).toBe(expected)
  })
})
