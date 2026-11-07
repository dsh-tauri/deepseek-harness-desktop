// @vitest-environment jsdom
import type { OfficialSelectOptions } from './context-menu.types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialSelect } from './official-menu'

const pending = new Set<ReturnType<typeof setTimeout>>()

function options(failures: string[]): OfficialSelectOptions {
  return {
    workspace: true,
    schedule: (fn, ms) => {
      const timer = setTimeout(() => {
        pending.delete(timer)
        fn()
      }, ms)
      pending.add(timer)
    },
    onFailure: message => failures.push(message),
  }
}

function workspaceRow(label: string): Element {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  const action = document.createElement('button')
  action.setAttribute('aria-label', label)
  row.append(action)
  return row
}

afterEach(() => {
  for (const timer of pending) clearTimeout(timer)
  pending.clear()
  document.body.replaceChildren()
})

describe('officialSelect', () => {
  it('polls until the official menu mounts its items', async () => {
    const row = workspaceRow('工作区“alpha”的操作')
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    item.textContent = '重命名'
    const clicked = vi.fn()
    item.addEventListener('click', clicked)
    row.querySelector('button')?.addEventListener('click', () => {
      const timer = setTimeout(() => {
        pending.delete(timer)
        document.body.append(item)
      }, 40)
      pending.add(timer)
    })
    const failures: string[] = []
    await officialSelect(row, [/^重命名/], 'unavailable', options(failures))
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(failures).toEqual([])
  })

  it('reports the failure message when no menu item ever appears', async () => {
    const row = workspaceRow('Workspace actions for beta')
    row.querySelector('button')?.addEventListener('click', () => {
      const other = document.createElement('button')
      other.setAttribute('role', 'menuitem')
      other.textContent = 'Delete'
      document.body.append(other)
    })
    const failures: string[] = []
    await officialSelect(row, [/^Rename\b/i], 'could not rename', options(failures))
    expect(failures).toEqual(['could not rename'])
  })

  it('throws when the row has no official action button', async () => {
    const row = document.createElement('div')
    row.setAttribute('role', 'treeitem')
    await expect(officialSelect(row, [/^重命名/], 'unavailable', options([])))
      .rejects
      .toThrow('Official workspace actions could not be found')
  })
})
