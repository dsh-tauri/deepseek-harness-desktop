// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Checkbox } from './checkbox'

vi.mock('dsh-tauri/client', async () => ({ tv: (await import('tailwind-variants')).tv }))
afterEach(cleanup)

it('keeps the default size and provides a compact xs checkbox without changing its accessible interaction', () => {
  const onChange = vi.fn()
  const view = render(
    <>
      <Checkbox checked={false} onChange={onChange}>Default</Checkbox>
      <Checkbox size="xs" checked={false} onChange={onChange}>Monday</Checkbox>
    </>,
  )
  const normal = view.getByRole('checkbox', { name: 'Default' })
  const small = view.getByRole('checkbox', { name: 'Monday' })
  expect(normal.classList.contains('w-[16px]')).toBe(true)
  expect(small.classList.contains('w-[12px]')).toBe(true)
  expect(small.closest('label')!.classList.contains('text-[12px]')).toBe(true)
  fireEvent.click(small)
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
})
