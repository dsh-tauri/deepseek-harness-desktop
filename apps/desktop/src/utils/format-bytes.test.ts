import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

const kb = 1024

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [kb, '1.0 KB'],
    [kb * 1.5, '1.5 KB'],
    [kb ** 2, '1.0 MB'],
    [kb ** 2 * 1.5, '1.5 MB'],
    [kb ** 3, '1.0 GB'],
    [kb ** 3 * 1.5, '1.5 GB'],
    [kb ** 4, '1.0 TB'],
    [kb ** 4 * 1.5, '1.5 TB'],
    [kb ** 5, '1.0 PB'],
    [kb ** 5 * 2.5, '2.5 PB'],
  ])('把 %s 字节格式化为 %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected)
  })
})
