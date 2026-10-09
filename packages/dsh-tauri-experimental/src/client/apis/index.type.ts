export type GetApiDesktopDshTauriExperimentalSummaryResponse = { sessionId: string; isGit: false | true; workspaceRoot: null | string; unavailableReason: null | string; turns: { turn: number; fileCount: number; insertions: number; deletions: number; unavailable: null | string; hasBaseline: false | true; truncated: false | true; files: { path: string; status: "A" | "M" | "D"; insertions: null | number; deletions: null | number; binary: false | true }[]; skippedOversized: string[]; skippedNestedRepos: string[] }[] } | { error: string };
export type GetApiDesktopDshTauriExperimentalSummaryQuerySessionId = undefined | string;
export type GetApiDesktopDshTauriExperimentalLiveResponse = { active: false | true; turn: null | number; fileCount: number; insertions: number; deletions: number } | { error: string };
export type GetApiDesktopDshTauriExperimentalLiveQuerySessionId = undefined | string;

export interface GetApiDesktopDshTauriExperimentalSummaryQuery {
  sessionId?: GetApiDesktopDshTauriExperimentalSummaryQuerySessionId;
}
export interface GetApiDesktopDshTauriExperimentalLiveQuery {
  sessionId?: GetApiDesktopDshTauriExperimentalLiveQuerySessionId;
}
