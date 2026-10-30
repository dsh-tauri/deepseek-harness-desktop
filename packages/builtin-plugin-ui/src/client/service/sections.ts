import type { SlotRegistry } from 'dsh-tauri/client'
import type { SettingsRow } from '../types/sections'
import { isEqual, orderBy } from 'dsh-tauri/client'
import { SETTINGS_ONBOARDING_SLOT, SETTINGS_SECTION_SLOT } from '../constants'
import { sections } from '../store/modules/sections'

export async function loadSections(slots: SlotRegistry): Promise<SettingsRow[]> {
  const rows = projectRows(slots, SETTINGS_SECTION_SLOT)
  if (!isEqual(sections.rows, rows))
    sections.setRows(rows)
  return rows
}

export async function loadOnboardingSteps(slots: SlotRegistry): Promise<SettingsRow[]> {
  const rows = projectRows(slots, SETTINGS_ONBOARDING_SLOT)
  if (!isEqual(sections.onboarding, rows))
    sections.setOnboarding(rows)
  return rows
}

function projectRows(slots: SlotRegistry, slotKey: string): SettingsRow[] {
  const rows = slots
    .entries(slotKey as never)
    .map(entry => ({
      id: entry.options.id ?? '',
      order: entry.options.order ?? 0,
      label: resolveLabel(entry.options.label),
    }))
    .filter(row => row.id !== '')

  return orderBy(rows, 'order')
}

function resolveLabel(label: unknown): string {
  if (typeof label === 'function')
    return String((label as () => unknown)())
  return typeof label === 'string' ? label : ''
}
