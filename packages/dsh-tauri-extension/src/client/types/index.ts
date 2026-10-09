import type { GetApiDesktopDshTauriExtensionImportScanResponse, GetApiDesktopDshTauriExtensionMcpResponse, GetApiDesktopDshTauriExtensionSkillsResponse } from '../apis/index.type'

export type ImportedServerView = Extract<GetApiDesktopDshTauriExtensionImportScanResponse, { servers: unknown }>['servers'][number]
export type McpRow = Extract<GetApiDesktopDshTauriExtensionMcpResponse, { servers: unknown }>['servers'][number]
export type SkillRowView = Extract<GetApiDesktopDshTauriExtensionSkillsResponse, { skills: unknown }>['skills'][number]
