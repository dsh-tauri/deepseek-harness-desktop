export interface PostApiTauriUiPathOpenResponse { ok?: undefined | false | true, error?: undefined | string }
export interface PostApiTauriUiSessionResumeResponse { ok?: undefined | false | true, error?: undefined | string }
export type PostApiTauriUiSessionWorkspaceStatusResponse = { status: 'available' | 'unknown' } | { status: 'missing' | 'not-directory', cwd: string }

export interface PostApiTauriUiPathOpenBody {
  path?: undefined | string
}

export interface PostApiTauriUiSessionResumeBody {
  sessionId?: undefined | string
}

export interface PostApiTauriUiSessionWorkspaceStatusBody {
  sessionId?: undefined | string
}
