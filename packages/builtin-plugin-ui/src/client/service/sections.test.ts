import type { SlotRegistry } from 'dsh-tauri/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sections } from '../store/modules/sections'
import { loadOnboardingSteps, loadSections } from './sections'

const mocks = vi.hoisted(() => ({
  isEqual: (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right),
  orderBy: (
    collection: readonly Record<string, unknown>[],
    iteratee: string | ((item: Record<string, unknown>) => number),
  ): Record<string, unknown>[] => {
    const keyOf = (item: Record<string, unknown>): number =>
      Number(typeof iteratee === 'function' ? iteratee(item) : item[iteratee])
    return [...collection].sort((left, right) => keyOf(left) - keyOf(right))
  },
}))

vi.mock('dsh-tauri/client', () => ({
  defineStore: (definition: { state: () => Record<string, unknown>, actions?: Record<string, unknown> }) =>
    Object.assign(definition.state(), definition.actions ?? {}),
  isEqual: mocks.isEqual,
  orderBy: mocks.orderBy,
}))

interface SlotEntry {
  options: { id?: string, order?: number, label?: unknown }
}

function registry(sectionEntries: SlotEntry[], onboardingEntries: SlotEntry[] = []): SlotRegistry {
  return {
    entries: (slotKey: string) => (slotKey === 'settings.section' ? sectionEntries : onboardingEntries),
  } as unknown as SlotRegistry
}

afterEach(() => {
  sections.setRows([])
  sections.setOnboarding([])
})

describe('loadSections', () => {
  it('projects the sidebar sections by the order each holder reports', async () => {
    const rows = await loadSections(registry([
      { options: { id: 'dsh-tauri-archive', order: 220 } },
      { options: { id: 'account', order: -10 } },
      { options: { id: 'general', order: 0 } },
      { options: { id: 'models', order: 10 } },
      { options: { id: 'dsh-bridge', order: 10 } },
      { options: { id: 'plugins', order: 15 } },
    ]))

    expect(rows.map(row => row.id)).toEqual([
      'account',
      'general',
      'models',
      'dsh-bridge',
      'plugins',
      'dsh-tauri-archive',
    ])
    expect(sections.rows).toEqual(rows)
  })

  it('drops entries without a section id', async () => {
    const rows = await loadSections(registry([
      { options: { order: 1 } },
      { options: { id: '', order: 2 } },
      { options: { id: 'general', order: 0 } },
    ]))

    expect(rows.map(row => row.id)).toEqual(['general'])
  })

  it('resolves lazy section labels', async () => {
    const rows = await loadSections(registry([
      { options: { id: 'account', order: -10, label: () => '账号与余额' } },
      { options: { id: 'general', order: 0, label: '通用设置' } },
    ]))

    expect(rows.map(row => row.label)).toEqual(['账号与余额', '通用设置'])
  })
})

describe('loadOnboardingSteps', () => {
  it('projects the onboarding steps by their own order', async () => {
    const rows = await loadOnboardingSteps(registry([], [
      { options: { id: 'deepseek-official', order: 0, label: '登录' } },
      { options: { id: 'account', order: -5, label: '账号' } },
    ]))

    expect(rows.map(row => row.id)).toEqual(['account', 'deepseek-official'])
    expect(sections.onboarding).toEqual(rows)
  })
})
