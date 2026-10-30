import type { PermissionOption } from '../types'

export interface PermissionPresetService {
  readonly names: readonly string[]
  readonly defaultPreset: string
  optionOf: (name: string) => PermissionOption
  set: (session: unknown, name: string) => void
}

export type ApprovalPolicy = (session: unknown, policy: 'ask' | 'never') => void
