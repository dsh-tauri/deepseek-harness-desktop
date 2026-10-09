export type GetApiTauriBridgeBackendsResponse = { id: "dsh" | "codex" | "claude"; installed: false | true; auth: "ok" | "missing" | "unknown"; version: null | string; drift: false | true; hint: null | string }[];
export type PostApiTauriBridgeSessionsResponse = { sessionId: string };

export interface PostApiTauriBridgeSessionsBody {
  backend: "codex" | "claude";
  workspaceId?: undefined | string;
  cwd?: undefined | string;
  agentPreset?: undefined | string;
}
