import type { FetchOptions } from 'dsh-tauri/client'
import type * as Types from './index.type'
import { ofetch } from 'dsh-tauri/client'

export function postSessionResume(body: Types.PostApiTauriUiSessionResumeBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriUiSessionResumeResponse>('/api/tauri/ui/session/resume', { method: 'post', body, ...options })
}

export function getUngrouped(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriUiUngroupedResponse>('/api/tauri/ui/ungrouped', { method: 'get', ...options })
}
