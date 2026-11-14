import { describe, expect, it } from 'vitest'
import { installPercent } from './install-percent'

describe('installPercent', () => {
  it.each([
    [0, 0],
    [21.4, 21],
    [21.5, 22],
    [49.5, 50],
    [50, 50],
    [99.6, 100],
    [100, 100],
  ])('把 %s 取整为 %s', (input, expected) => {
    expect(installPercent(input)).toBe(expected)
  })

  it.each([100.4, 250])('把越界值 %s 钳制到 100', (input) => {
    expect(installPercent(input)).toBe(100)
  })

  it('负数与 NaN 回落到上一个已知值，避免进度倒退或 NaN', () => {
    expect(installPercent(-1, 42)).toBe(42)
    expect(installPercent(Number.NaN, 42)).toBe(42)
    expect(installPercent(Number.POSITIVE_INFINITY, 42)).toBe(42)
    expect(installPercent(-1)).toBe(0)
  })

  it('阶段推进是单调的：download 0-50 后 extract 50-100 不会回退', () => {
    const stages = [0, 12.5, 25, 50, 62.5, 75, 100]
    const rendered = stages.reduce<number[]>((acc, value) => {
      acc.push(installPercent(value, acc.at(-1) ?? 0))
      return acc
    }, [])
    expect(rendered).toEqual([0, 13, 25, 50, 63, 75, 100])
    expect(rendered).toEqual([...rendered].sort((a, b) => a - b))
  })
})
