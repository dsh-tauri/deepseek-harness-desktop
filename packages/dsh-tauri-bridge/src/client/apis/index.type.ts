export type GetApiTauriBridgeBackendsResponse = { id: "codex" | "claude" | "dsh"; installed: false | true; bridgeReady?: undefined | false | true; auth: "ok" | "missing" | "unknown"; version: null | string; drift: false | true; hint: null | string }[];
export type GetApiTauriBridgeModelsResponse = { backend: "codex" | "claude"; current: { model: null | string; reasoningEffort: null | string }; models: { id: string; name: string; description?: undefined | string; reasoning?: undefined | { efforts: { id: string; name: string; description?: undefined | string }[]; defaultEffort?: undefined | string } }[]; defaultModel?: undefined | string };
export type GetApiTauriBridgeModelsQuerySessionId = string;
export type PostApiTauriBridgeModelsResponse = { model: null | string; reasoningEffort: null | string };
export type PostApiTauriBridgeSessionsResponse = { sessionId: string };

export interface PostApiTauriBridgeModelsBody {
  sessionId: string;
  model: null | string;
  reasoningEffort: null | string;
}
export interface PostApiTauriBridgeSessionsBody {
  backend: "codex" | "claude";
  workspaceId?: undefined | string;
  cwd?: undefined | string;
  agentPreset?: undefined | string;
}
export interface GetApiTauriBridgeModelsQuery {
  sessionId: GetApiTauriBridgeModelsQuerySessionId;
}
