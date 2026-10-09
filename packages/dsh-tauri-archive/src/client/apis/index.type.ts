export type GetApiDesktopDshTauriArchiveSessionArchiveResponse = { archivedSessionIds: string[]; meta: { [key: string]: { createdAt?: undefined | number; cwd?: undefined | string; title?: undefined | string } } };
export type PostApiDesktopDshTauriArchiveSessionArchiveResponse = { archivedSessionIds: string[]; meta: { [key: string]: { createdAt?: undefined | number; cwd?: undefined | string; title?: undefined | string } } } | { ok: false; error: string };
export type DeleteApiDesktopDshTauriArchiveSessionArchiveResponse = { ok: true } | { ok: false; error: string };
export type PostApiDesktopDshTauriArchiveSessionArchiveClearResponse = { ok: true };
export type DeleteApiDesktopDshTauriArchiveSessionArchiveClearResponse = { ok: true };
export type PostApiDesktopDshTauriArchiveSessionWorkspaceArchiveResponse = { archivedSessionIds: string[]; meta: { [key: string]: { createdAt?: undefined | number; cwd?: undefined | string; title?: undefined | string } } } | { ok: false; error: string };
export type DeleteApiDesktopDshTauriArchiveSessionWorkspaceArchiveResponse = { ok: true } | { ok: false; error: string };
export type PostApiDesktopDshTauriArchiveSessionArchiveRestoreResponse = { ok: true } | { ok: false; error: string };
export type PostApiDesktopDshTauriArchiveSessionOpenPathResponse = { ok: false | true; error?: undefined | string };

export interface PostApiDesktopDshTauriArchiveSessionArchiveBody {
  sessionId: string;
}
export interface DeleteApiDesktopDshTauriArchiveSessionArchiveBody {
  sessionId: string;
}
export interface PostApiDesktopDshTauriArchiveSessionWorkspaceArchiveBody {
  workspaceId?: undefined | string;
  sessionIds: string[];
}
export interface DeleteApiDesktopDshTauriArchiveSessionWorkspaceArchiveBody {
  sessionIds: string[];
}
export interface PostApiDesktopDshTauriArchiveSessionArchiveRestoreBody {
  sessionId: string;
}
export interface PostApiDesktopDshTauriArchiveSessionOpenPathBody {
  sessionId: string;
}
