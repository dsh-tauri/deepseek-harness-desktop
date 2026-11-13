/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type { FetchOptions } from 'dsh-tauri/client'
import type * as Types from './index.type'
import { ofetch } from 'dsh-tauri/client'

/** @method post */
export function postPathOpen(body: Types.PostApiTauriUiPathOpenBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriUiPathOpenResponse>('/api/tauri/ui/path/open', { method: 'post', body, ...options })
}

/** @method post */
export function postSessionResume(body: Types.PostApiTauriUiSessionResumeBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriUiSessionResumeResponse>('/api/tauri/ui/session/resume', { method: 'post', body, ...options })
}
