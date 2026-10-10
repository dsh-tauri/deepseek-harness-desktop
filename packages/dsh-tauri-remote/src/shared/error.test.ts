import { describe, expect, it } from 'vitest'
import { messageOf } from './error'

describe('messageOf', () => {
  it.each([
    [new Error('window refused'), 'window refused'],
    ['plain failure', 'plain failure'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, '42'],
    [{ message: 'not an Error' }, '[object Object]'],
  ])('preserves the operator-facing text for %j', (error, expected) => {
    expect(messageOf(error)).toBe(expected)
  })
})
