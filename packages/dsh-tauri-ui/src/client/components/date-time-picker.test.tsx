// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatePicker } from './date-picker'
import { TimePicker } from './time-picker'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: () => { throw new Error('Settings store is outside the picker test contract') },
}))

vi.mock('dsh-tauri/client', async () => {
  const [{ tv }, { useEventListener, useWatchImmediate }] = await Promise.all([import('tailwind-variants'), import('@reause/core')])
  return { tv, useEventListener, useWatchImmediate }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const dateLabels = { label: 'Date', locale: 'en-US', previousMonthLabel: 'Previous month', nextMonthLabel: 'Next month' }
const timeLabels = { label: 'Time', hourLabel: 'Hours', minuteLabel: 'Minutes', secondLabel: 'Seconds' }

describe('date and time pickers', () => {
  it('calendar keeps ISO wall dates through leap months and month-end navigation', () => {
    const changed = vi.fn()
    function Field() {
      const [value, setValue] = useState('2024-01-31')
      return (
        <DatePicker
          {...dateLabels}
          value={value}
          onChange={(next) => {
            changed(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Field />)
    const trigger = screen.getByRole('button', { name: 'Date' })
    expect(trigger.textContent).toContain('2024/01/31')
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: '31' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    const day = screen.getByRole('gridcell', { name: '29' })
    expect(screen.getAllByRole('gridcell').filter(cell => cell.getAttribute('aria-hidden') !== 'true')).toHaveLength(29)
    expect(document.activeElement).toBe(day)
    expect(changed).not.toHaveBeenCalled()
    fireEvent.keyDown(day, { key: 'Enter' })
    expect(changed).toHaveBeenLastCalledWith('2024-02-29')
    expect(trigger.textContent).toContain('2024/02/29')
    expect(day.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: '29' }))
  })

  it('calendar keyboard clamps at month boundaries and reopening follows the controlled value', () => {
    const changed = vi.fn()
    const view = render(<DatePicker {...dateLabels} value="2024-02-01" onChange={changed} />)
    const trigger = screen.getByRole('button', { name: 'Date' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('gridcell', { name: '1' }), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: '1' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: '8' }))
    fireEvent.keyDown(document.activeElement!, { key: ' ' })
    expect(changed).toHaveBeenLastCalledWith('2024-02-08')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    view.rerender(<DatePicker {...dateLabels} value="2024-12-31" onChange={changed} />)
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: '31' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(changed).toHaveBeenLastCalledWith('2025-01-31')
  })

  it('clock opens on selected columns and keyboard changes only the picked part', () => {
    const changed = vi.fn()
    function Field() {
      const [value, setValue] = useState('09:58:42.125')
      return (
        <TimePicker
          {...timeLabels}
          value={value}
          onChange={(next) => {
            changed(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Field />)
    fireEvent.click(screen.getByRole('button', { name: 'Time' }))
    const hours = screen.getByRole('listbox', { name: 'Hours' })
    const minutes = screen.getByRole('listbox', { name: 'Minutes' })
    const seconds = screen.getByRole('listbox', { name: 'Seconds' })
    expect(within(hours).getAllByRole('option')).toHaveLength(24)
    expect(within(minutes).getAllByRole('option')).toHaveLength(60)
    expect(within(seconds).getAllByRole('option')).toHaveLength(60)
    expect(document.activeElement).toBe(within(hours).getByRole('option', { name: '09' }))
    expect(within(minutes).getByRole('option', { name: '58' }).tabIndex).toBe(0)
    expect(within(seconds).getByRole('option', { name: '42' }).tabIndex).toBe(0)
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(changed).toHaveBeenLastCalledWith('23:58:42')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(within(minutes).getByRole('option', { name: '23' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    fireEvent.keyDown(document.activeElement!, { key: ' ' })
    expect(changed).toHaveBeenLastCalledWith('23:59:42')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(changed).toHaveBeenLastCalledWith('23:59:00')
    expect(screen.getByRole('button', { name: 'Time' }).textContent).toContain('23:59:00')
  })

  it('minute precision omits seconds and returns the host-compatible HH:mm value', () => {
    const changed = vi.fn()
    const view = render(<TimePicker {...timeLabels} value="09:05" seconds={false} onChange={changed} />)
    const trigger = screen.getByRole('button', { name: 'Time' })
    expect(trigger.textContent).toContain('09:05')
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox', { name: 'Seconds' })).toBeNull()
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Minutes' })).getByRole('option', { name: '06' }))
    expect(changed).toHaveBeenLastCalledWith('09:06')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    view.rerender(<TimePicker {...timeLabels} value="17:40" onChange={changed} />)
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(within(screen.getByRole('listbox', { name: 'Hours' })).getByRole('option', { name: '17' }))
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Minutes' })).getByRole('option', { name: '41' }))
    expect(changed).toHaveBeenLastCalledWith('17:41:00')
  })

  it.each(['date', 'time'] as const)('%s popover is portaled, anchored, outside-dismissed and Escape returns focus', (kind) => {
    const changed = vi.fn()
    const view = render(kind === 'date'
      ? <DatePicker {...dateLabels} value="2024-02-20" onChange={changed} />
      : <TimePicker {...timeLabels} value="10:20:30" onChange={changed} />)
    const trigger = screen.getByRole('button', { name: kind === 'date' ? 'Date' : 'Time' })
    let left = 100
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ left, right: left + 100, top: 50, bottom: 82, width: 100, height: 32, x: left, y: 50, toJSON: () => ({}) }))
    fireEvent.click(trigger)
    const popup = screen.getByRole('dialog')
    expect(popup.parentElement).toBe(document.body)
    expect(view.container.contains(popup)).toBe(false)
    expect(popup.style.left).toBe('100px')
    expect(popup.style.top).toBe('86px')
    expect(document.activeElement?.getAttribute('role')).toBe(kind === 'date' ? 'gridcell' : 'option')
    expect(popup.className).toContain('z-[1100]')
    expect(popup.className).toContain('rounded-[16px]')
    fireEvent.pointerDown(popup)
    expect(screen.getByRole('dialog')).toBe(popup)
    left = 130
    fireEvent.scroll(window)
    expect(popup.style.left).toBe('130px')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    view.unmount()
    fireEvent.scroll(window)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('disabled pickers do not open and becoming disabled closes an existing panel', () => {
    const changed = vi.fn()
    const view = render(
      <>
        <DatePicker {...dateLabels} value="2024-02-20" disabled onChange={changed} />
        <TimePicker {...timeLabels} value="09:00" disabled onChange={changed} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Time' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<TimePicker {...timeLabels} value="09:00" onChange={changed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Time' }))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Time')
    view.rerender(<TimePicker {...timeLabels} value="09:00" disabled onChange={changed} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })
})
