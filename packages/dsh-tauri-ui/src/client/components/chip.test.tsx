import { cleanup, render } from '@testing-library/react'
// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chip } from './chip'

vi.mock('dsh-tauri/client', async () => {
  const mod = await import('tailwind-variants')
  return { tv: mod.tv }
})

afterEach(cleanup)

describe('chip', () => {
  it('applies caller class overrides only to the base slot', () => {
    const view = render(<Chip variant="seat" className="min-h-[32px] rounded-[18px] text-[14px] font-normal">task value</Chip>)
    const button = view.getByRole('button')
    expect(button.classList.contains('min-h-[32px]')).toBe(true)
    expect(button.classList.contains('rounded-[18px]')).toBe(true)
    expect(button.classList.contains('text-[14px]')).toBe(true)
    expect(button.querySelector('span')!.classList.contains('text-[14px]')).toBe(false)
  })

  it('把调用方 ref 交给真实 button，供 portal 菜单测量锚点', () => {
    const ref = createRef<HTMLButtonElement>()
    const view = render(<Chip ref={ref} variant="seat" aria-label="选择工作区">选择工作区</Chip>)

    expect(ref.current, 'Chip 必须转发 ref，否则 getAnchorRect 永远拿不到锚点').toBeInstanceOf(HTMLButtonElement)
    expect(ref.current).toBe(view.container.querySelector('button'))
  })

  // React 19 把 ref 当普通 prop，渲染断言区分不了「转发」与「当 prop 收下」；部署端 React 18 会丢弃 ref。
  it('对外声明为可转发 ref 的组件', () => {
    expect((Chip as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.forward_ref'))
  })
})
