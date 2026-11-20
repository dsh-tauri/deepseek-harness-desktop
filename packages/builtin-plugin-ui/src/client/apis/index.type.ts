export type PostApiTauriUiPathOpenResponse = { ok: true } | { ok: false, error: 'invalid-path' | 'not-a-directory' }

export interface PostApiTauriUiPathOpenBody {
  path?: undefined | string
}
