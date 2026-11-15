export type PathOpenError = 'invalid-path' | 'not-a-directory'

export type OpenPathResult = { ok: true } | { ok: false, error: PathOpenError }

export type SessionDirectoryStatus
  = { status: 'available' | 'unknown' }
    | { status: 'missing' | 'not-directory', cwd: string }
