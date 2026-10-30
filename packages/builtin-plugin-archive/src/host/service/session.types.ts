export type SessionDirectoryError = 'session-directory-not-found' | 'not-a-directory'

export type OpenSessionDirectoryResult = { ok: true } | { ok: false, error: SessionDirectoryError }
