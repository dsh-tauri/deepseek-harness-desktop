import type { GetApiTauriExtensionImportScanResponse, GetApiTauriExtensionMcpResponse, GetApiTauriExtensionSkillsResponse } from '../apis/index.type'

export type ImportedServerView = Extract<GetApiTauriExtensionImportScanResponse, { servers: unknown }>['servers'][number]
export type McpRow = Extract<GetApiTauriExtensionMcpResponse, { servers: unknown }>['servers'][number]
export type SkillRowView = Extract<GetApiTauriExtensionSkillsResponse, { skills: unknown }>['skills'][number]
