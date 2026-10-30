import type { ApprovalPolicy, PermissionPresetService } from './permission.types'

export function applyUnattendedPermission(
  presets: PermissionPresetService,
  session: unknown,
  permission: string | undefined,
  setApprovalPolicy: ApprovalPolicy,
): void {
  presets.set(session, permission ?? presets.defaultPreset)
  setApprovalPolicy(session, 'never')
}
