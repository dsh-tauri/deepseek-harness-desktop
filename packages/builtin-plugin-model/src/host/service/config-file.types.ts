export type ConfigOpenResult
  = | { ok: true, path: string, opened: 'file' | 'directory' }
    | { ok: false, path: string, error: string }
