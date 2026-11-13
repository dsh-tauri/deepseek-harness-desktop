export interface PostApiTauriUiPathOpenResponse { ok?: undefined | false | true, error?: undefined | string }
export interface PostApiTauriUiSessionResumeResponse { ok?: undefined | false | true, error?: undefined | string }

export interface PostApiTauriUiPathOpenBody {
  path?: undefined | string
}

export interface PostApiTauriUiSessionResumeBody {
  sessionId?: undefined | string
}
