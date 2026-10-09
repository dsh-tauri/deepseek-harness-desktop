export type GetApiTauriArchiveSessionArchiveResponse = { archivedSessionIds: string[]; meta: { [key: string]: { createdAt?: undefined | number; cwd?: undefined | string; title?: undefined | string } } };
export type PostApiTauriArchiveSessionArchiveResponse = { archivedSessionIds: string[]; meta: { [key: string]: { createdAt?: undefined | number; cwd?: undefined | string; title?: undefined | string } } } | { ok: false; error: string };
export type DeleteApiTauriArchiveSessionArchiveResponse = { ok: true } | { ok: false; error: string };
export type PostApiTauriArchiveSessionArchiveClearResponse = { ok: true };
export type DeleteApiTauriArchiveSessionArchiveClearResponse = { ok: true };
export type PostApiTauriArchiveSessionWorkspaceArchiveResponse = { archivedSessionIds: string[]; meta: { [key: string]: { createdAt?: undefined | number; cwd?: undefined | string; title?: undefined | string } } } | { ok: false; error: string };
export type DeleteApiTauriArchiveSessionWorkspaceArchiveResponse = { ok: true } | { ok: false; error: string };
export type PostApiTauriArchiveSessionArchiveRestoreResponse = { ok: true } | { ok: false; error: string };
export type PostApiTauriArchiveSessionOpenPathResponse = { ok: false | true; error?: undefined | string };

export interface PostApiTauriArchiveSessionArchiveBody {
  sessionId: string;
}
export interface DeleteApiTauriArchiveSessionArchiveBody {
  sessionId: string;
}
export interface PostApiTauriArchiveSessionWorkspaceArchiveBody {
  workspaceId?: undefined | string;
  sessionIds: string[];
}
export interface DeleteApiTauriArchiveSessionWorkspaceArchiveBody {
  sessionIds: string[];
}
export interface PostApiTauriArchiveSessionArchiveRestoreBody {
  sessionId: string;
}
export interface PostApiTauriArchiveSessionOpenPathBody {
  sessionId: string;
}
