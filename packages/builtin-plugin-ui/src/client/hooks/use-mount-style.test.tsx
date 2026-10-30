// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cssr } from '../utils/cssr'
import { useMountStyle } from './use-mount-style'

afterEach(cleanup)

describe('useMountStyle', () => {
  it('replaces the previous style when node, id or owner changes', () => {
    const first = cssr.c('.first', { color: 'red' })
    const second = cssr.c('.second', { color: 'blue' })
    const view = renderHook(({ node, id, owner }) => useMountStyle(node, id, owner), {
      initialProps: { node: first, id: 'first-style', owner: 'first-plugin' },
    })
    expect(document.querySelector('style[cssr-id="first-style"]')?.getAttribute('data-plugin')).toBe('first-plugin')
    view.rerender({ node: second, id: 'second-style', owner: 'second-plugin' })
    expect(document.querySelector('style[cssr-id="first-style"]')).toBeNull()
    expect(document.querySelector('style[cssr-id="second-style"]')?.textContent).toContain('blue')
    view.rerender({ node: second, id: 'second-style', owner: 'updated-plugin' })
    expect(document.querySelector('style[cssr-id="second-style"]')?.getAttribute('data-plugin')).toBe('updated-plugin')
    view.unmount()
    expect(document.querySelector('style[cssr-id="second-style"]')).toBeNull()
  })

  it('keeps a shared style until the final consumer unmounts', () => {
    const node = cssr.c('.shared', { color: 'green' })
    const first = renderHook(() => useMountStyle(node, 'shared-style', 'test-plugin'))
    const second = renderHook(() => useMountStyle(node, 'shared-style', 'test-plugin'))
    expect(document.querySelectorAll('style[cssr-id="shared-style"]')).toHaveLength(1)
    first.unmount()
    expect(document.querySelectorAll('style[cssr-id="shared-style"]')).toHaveLength(1)
    second.unmount()
    expect(document.querySelector('style[cssr-id="shared-style"]')).toBeNull()
  })

  it('balances StrictMode setup and cleanup without leaving a style behind', () => {
    const node = cssr.c('.strict', { color: 'black' })
    const view = renderHook(() => useMountStyle(node, 'strict-style'), { wrapper: StrictMode })
    expect(document.querySelectorAll('style[cssr-id="strict-style"]')).toHaveLength(1)
    view.unmount()
    expect(document.querySelector('style[cssr-id="strict-style"]')).toBeNull()
  })
})
