export type PostApiTauriUiPathOpenResponse = { ok: true } | { ok: false, error: 'invalid-path' | 'not-a-directory' }
export interface PostApiTauriUiSessionResumeResponse { ok?: undefined | false | true, error?: undefined | string }

export interface PostApiTauriUiPathOpenBody {
  path?: undefined | string
}
export interface PostApiTauriUiSessionResumeBody {
  sessionId?: undefined | string
}
