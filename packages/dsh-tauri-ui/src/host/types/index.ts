import type { HostPluginLoader } from 'dsh-tauri'

export type HostContext = any

export type SessionResumeOutcome
  = | { ok: true }
    | { ok: false, code: 409, error: string, refusal: { message: string, code: string, status: number } }
    | { ok: false, code: number, error: string }

export interface PlatformModuleLoader extends HostPluginLoader {}

export interface SessionResumeResponse {
  ok?: boolean
  error?: string
}
