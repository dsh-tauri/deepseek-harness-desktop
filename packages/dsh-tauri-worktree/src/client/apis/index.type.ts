export type PostApiDesktopDshTauriWorktreeResponse = { ok?: undefined | false | true; error?: undefined | string; hash?: undefined | string; dirname?: undefined | string; worktreeKey?: undefined | string; worktreePath?: undefined | string; projectPath?: undefined | string; sourceSessionId?: undefined | string; log?: undefined | string[]; existed?: undefined | false | true; inherited?: undefined | false | true };
export type DeleteApiDesktopDshTauriWorktreeResponse = { ok?: undefined | false | true; jobId?: undefined | string; error?: undefined | string };
export type GetApiDesktopDshTauriWorktreeBindingsResponse = { bindings: { sessionId: string; sourceSessionId: string; hash: string; dirname: string; worktreeKey: string; worktreePath: string; projectPath: string; log: string[] }[]; jobs: { sessionId: string; jobId: string; state: string; error?: undefined | string; worktreeKey: string; worktreePath?: undefined | string }[] };
export type GetApiDesktopDshTauriWorktreeStatusResponse = { mode?: undefined | string; jobId?: undefined | string; error?: undefined | string; hash?: undefined | string; dirname?: undefined | string; worktreeKey?: undefined | string; worktreePath?: undefined | string; projectPath?: undefined | string; sourceSessionId?: undefined | string; log?: undefined | string[]; isGit?: undefined | null | false | true };
export type GetApiDesktopDshTauriWorktreeStatusQuerySessionId = undefined | string;
export type GetApiDesktopDshTauriWorktreeStatusQueryJobId = undefined | string;
export type PostApiDesktopDshTauriWorktreeBindingsResponse = { ok?: undefined | false | true; workspaceId?: undefined | string; error?: undefined | string };
export type PostApiDesktopDshTauriWorktreeCheckoutsResponse = { ok?: undefined | false | true; branch?: undefined | string; projectPath?: undefined | string; targetSessionId?: undefined | string; error?: undefined | string };
export type OptionsApiDesktopDshTauriWorktreeResponse = void;
export type OptionsApiDesktopDshTauriWorktreeBindingsResponse = void;
export type OptionsApiDesktopDshTauriWorktreeStatusResponse = void;
export type OptionsApiDesktopDshTauriWorktreeCheckoutsResponse = void;

export interface PostApiDesktopDshTauriWorktreeBody {
  sessionId?: undefined | string;
  sourceSessionId?: undefined | string;
  carryStaged?: undefined | false | true;
  inherit?: undefined | false | true;
}
export interface DeleteApiDesktopDshTauriWorktreeBody {
  sessionId?: undefined | string;
  worktreeHashDirname?: undefined | string;
}
export interface PostApiDesktopDshTauriWorktreeBindingsBody {
  sessionId?: undefined | string;
}
export interface PostApiDesktopDshTauriWorktreeCheckoutsBody {
  sessionId?: undefined | string;
  worktreeHashDirname?: undefined | string;
  branchName?: undefined | string;
  carryStaged?: undefined | false | true;
}
export interface GetApiDesktopDshTauriWorktreeStatusQuery {
  sessionId?: GetApiDesktopDshTauriWorktreeStatusQuerySessionId;
  jobId?: GetApiDesktopDshTauriWorktreeStatusQueryJobId;
}
