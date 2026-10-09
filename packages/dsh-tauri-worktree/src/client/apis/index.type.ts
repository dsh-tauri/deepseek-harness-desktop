export type PostApiTauriWorktreeResponse = { ok?: undefined | false | true; error?: undefined | string; hash?: undefined | string; dirname?: undefined | string; worktreeKey?: undefined | string; worktreePath?: undefined | string; projectPath?: undefined | string; sourceSessionId?: undefined | string; log?: undefined | string[]; existed?: undefined | false | true; inherited?: undefined | false | true };
export type DeleteApiTauriWorktreeResponse = { ok?: undefined | false | true; jobId?: undefined | string; error?: undefined | string };
export type GetApiTauriWorktreeBindingsResponse = { bindings: { sessionId: string; sourceSessionId: string; hash: string; dirname: string; worktreeKey: string; worktreePath: string; projectPath: string; log: string[] }[]; jobs: { sessionId: string; jobId: string; state: string; error?: undefined | string; worktreeKey: string; worktreePath?: undefined | string }[] };
export type GetApiTauriWorktreeStatusResponse = { mode?: undefined | string; jobId?: undefined | string; error?: undefined | string; hash?: undefined | string; dirname?: undefined | string; worktreeKey?: undefined | string; worktreePath?: undefined | string; projectPath?: undefined | string; sourceSessionId?: undefined | string; log?: undefined | string[]; isGit?: undefined | null | false | true };
export type GetApiTauriWorktreeStatusQuerySessionId = undefined | string;
export type GetApiTauriWorktreeStatusQueryJobId = undefined | string;
export type PostApiTauriWorktreeBindingsResponse = { ok?: undefined | false | true; workspaceId?: undefined | string; error?: undefined | string };
export type PostApiTauriWorktreeCheckoutsResponse = { ok?: undefined | false | true; branch?: undefined | string; projectPath?: undefined | string; targetSessionId?: undefined | string; error?: undefined | string };

export interface PostApiTauriWorktreeBody {
  sessionId?: undefined | string;
  sourceSessionId?: undefined | string;
  carryStaged?: undefined | false | true;
  inherit?: undefined | false | true;
}
export interface DeleteApiTauriWorktreeBody {
  sessionId?: undefined | string;
  worktreeHashDirname?: undefined | string;
}
export interface PostApiTauriWorktreeBindingsBody {
  sessionId?: undefined | string;
}
export interface PostApiTauriWorktreeCheckoutsBody {
  sessionId?: undefined | string;
  worktreeHashDirname?: undefined | string;
  branchName?: undefined | string;
  carryStaged?: undefined | false | true;
}
export interface GetApiTauriWorktreeStatusQuery {
  sessionId?: GetApiTauriWorktreeStatusQuerySessionId;
  jobId?: GetApiTauriWorktreeStatusQueryJobId;
}
