export type GetApiTauriExperimentalSummaryResponse = { sessionId: string; isGit: false | true; workspaceRoot: null | string; unavailableReason: null | string; turns: { turn: number; fileCount: number; insertions: number; deletions: number; unavailable: null | string; hasBaseline: false | true; truncated: false | true; files: { path: string; status: "A" | "M" | "D"; insertions: null | number; deletions: null | number; binary: false | true }[]; skippedOversized: string[]; skippedNestedRepos: string[] }[] } | { error: string };
export type GetApiTauriExperimentalSummaryQuerySessionId = undefined | string;
export type GetApiTauriExperimentalLiveResponse = { active: false | true; turn: null | number; fileCount: number; insertions: number; deletions: number } | { error: string };
export type GetApiTauriExperimentalLiveQuerySessionId = undefined | string;

export interface GetApiTauriExperimentalSummaryQuery {
  sessionId?: GetApiTauriExperimentalSummaryQuerySessionId;
}
export interface GetApiTauriExperimentalLiveQuery {
  sessionId?: GetApiTauriExperimentalLiveQuerySessionId;
}
