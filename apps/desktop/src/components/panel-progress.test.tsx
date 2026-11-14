// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Panel } from './panel'

afterEach(cleanup)

function fillWidthPercent(bar: HTMLElement): string {
  return (bar.firstElementChild as HTMLElement).style.width
}

describe('panel.Progress 宽度与数字一致', () => {
  it.each([0, 3, 21, 49.5, 50, 87.6, 100])('%s%% 的宽度、无障碍值与数字取同一整数', (percentage) => {
    render(<Panel.Progress percentage={percentage} />)

    const expected = `${Math.round(percentage)}%`
    const bar = screen.getByRole('progressbar')
    expect(fillWidthPercent(bar)).toBe(expected)
    expect(bar.getAttribute('aria-valuenow')).toBe(String(Math.round(percentage)))
    expect(screen.getByText(`${Math.round(percentage)}%`)).toBeDefined()
  })

  it('宽度不带过渡动画，连续进度事件间不会落后于数字', () => {
    render(<Panel.Progress percentage={21} />)
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement

    expect(fill.className).not.toContain('transition')
  })

  it.each([[-1, '0%'], [-0.5, '0%'], [100.4, '100%'], [250, '100%'], [Number.NaN, '0%']])('%s 收敛为 %s', (percentage, expected) => {
    render(<Panel.Progress percentage={percentage} />)

    const bar = screen.getByRole('progressbar')
    expect(fillWidthPercent(bar)).toBe(expected)
    expect(bar.getAttribute('aria-valuenow')).toBe(expected.slice(0, -1))
    expect(screen.getByText(expected)).toBeDefined()
  })

  it('没有百分比时不渲染进度条，只保留日志', () => {
    render(<Panel.Progress logs={['a log line']} />)

    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('a log line')).toBeDefined()
  })

  it('百分比与日志都缺省时不渲染任何内容', () => {
    const { container } = render(<Panel.Progress />)
    expect(container.firstElementChild).toBeNull()
  })
})
