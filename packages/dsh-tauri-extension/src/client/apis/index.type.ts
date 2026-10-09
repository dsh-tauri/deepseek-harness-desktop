export type GetApiTauriExtensionSkillsResponse = { skills: { name: string; description: string; whenToUse?: undefined | string; invocation: { modelInvocable: false | true; userInvocable: false | true }; source: string; provider: string; editable: false | true; removable: false | true; dir?: undefined | string; policyEditable: false | true; repository?: undefined | { id: string; label: string; kind: "local" | "git"; githubUrl?: undefined | string } }[] } | { error: string };
export type PostApiTauriExtensionSkillsRefreshResponse = { skills: { name: string; description: string; whenToUse?: undefined | string; invocation: { modelInvocable: false | true; userInvocable: false | true }; source: string; provider: string; editable: false | true; removable: false | true; dir?: undefined | string; policyEditable: false | true; repository?: undefined | { id: string; label: string; kind: "local" | "git"; githubUrl?: undefined | string } }[] } | { error: string };
export type GetApiTauriExtensionSkillResponse = { name: string; content: string } | { error: string };
export type GetApiTauriExtensionSkillQueryName = unknown;
export type PostApiTauriExtensionSkillResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type DeleteApiTauriExtensionSkillResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type PostApiTauriExtensionSkillPolicyResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type PostApiTauriExtensionOpenDirResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type GetApiTauriExtensionMcpResponse = { servers: { id: string; layer?: undefined | "global" | "profile"; shadowed?: undefined | false | true; scope?: undefined | "global" | "profile"; serverName: string; transport: "stdio" | "streamable-http"; disabled: false | true; command?: undefined | string; args?: undefined | string[]; env?: undefined | { [key: string]: string }; cwd?: undefined | string; url?: undefined | string; headers?: undefined | { [key: string]: string } }[]; globalError?: undefined | string; restartNeeded: false | true } | { error: string };
export type PostApiTauriExtensionMcpResponse = { ok: false | true; id: string; restartNeeded: false | true } | { error: string };
export type DeleteApiTauriExtensionMcpResponse = { ok: false | true; restartNeeded: false | true } | { error: string };
export type PostApiTauriExtensionMcpToggleResponse = { ok: false | true; restartNeeded: false | true } | { error: string };
export type PostApiTauriExtensionMcpCheckResponse = { ok: false | true; detail?: undefined | string } | { error: string };
export type PostApiTauriExtensionMcpCopyResponse = { error: string; ok?: undefined; id?: undefined; scope?: undefined; restartNeeded?: undefined } | { ok: false | true; id: string; scope: "global" | "profile"; restartNeeded: false | true; error?: undefined };
export type GetApiTauriExtensionImportScanResponse = { servers: { agent: "claude-code" | "codex" | "cursor" | "gemini"; name: string; transport: "stdio" | "streamable-http"; command?: undefined | string; args?: undefined | string[]; env?: undefined | { [key: string]: string }; url?: undefined | string; headers?: undefined | { [key: string]: string } }[]; existing: string[] } | { error: string };
export type PostApiTauriExtensionImportApplyResponse = { ok: false | true; results: { name: string; ok: false | true; error?: undefined | string }[]; restartNeeded: false | true } | { error: string };
export type GetApiTauriExtensionRootsResponse = { roots: ({ id: string; kind: "local" | "git"; label: string; url?: undefined | string; ref?: undefined | string; path?: undefined | string; roots: string[]; materialDir?: undefined | string; addedAt: number } & { live: false | true })[] };
export type PostApiTauriExtensionRootsResponse = { ok: false | true; root: { id: string; kind: "local" | "git"; label: string; url?: undefined | string; ref?: undefined | string; path?: undefined | string; roots: string[]; materialDir?: undefined | string; addedAt: number; live: false | true } } | { error: string };
export type DeleteApiTauriExtensionRootsResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type PostApiTauriExtensionHostRestartResponse = { error: string; ok?: undefined; pid?: undefined; replacementPid?: undefined; logOut?: undefined } | { ok: false | true; pid: number; replacementPid: undefined | number; logOut: string; error?: undefined };

export interface PostApiTauriExtensionSkillBody {
  name: string;
  description: string;
  whenToUse?: undefined | string;
  modelInvocable?: undefined | false | true;
  userInvocable?: undefined | false | true;
  content: string;
}
export interface DeleteApiTauriExtensionSkillBody {
  name: string;
}
export interface PostApiTauriExtensionSkillPolicyBody {
  name: string;
  enabled: false | true;
}
export interface PostApiTauriExtensionOpenDirBody {
  target: "user-skills" | "plugin-state" | "skill" | "root";
  name?: undefined | string;
  id?: undefined | string;
}
export interface PostApiTauriExtensionMcpBody {
  id: string;
  serverName: string;
  transport: "stdio" | "streamable-http";
  command?: undefined | string;
  args?: undefined | string[];
  env?: undefined | { [key: string]: string };
  cwd?: undefined | string;
  url?: undefined | string;
  headers?: undefined | { [key: string]: string };
  scope?: undefined | "global" | "profile";
}
export interface DeleteApiTauriExtensionMcpBody {
  id: string;
  scope?: undefined | "global" | "profile";
}
export interface PostApiTauriExtensionMcpToggleBody {
  id: string;
  disabled: false | true;
  scope?: undefined | "global" | "profile";
}
export interface PostApiTauriExtensionMcpCheckBody {
  id: string;
  scope?: undefined | "global" | "profile";
}
export interface PostApiTauriExtensionMcpCopyBody {
  id?: unknown;
  scope?: unknown;
  toScope?: unknown;
}
export interface PostApiTauriExtensionImportApplyBody {
  items: { agent: string; name: string }[];
  scope?: undefined | "global" | "profile";
}
export interface PostApiTauriExtensionRootsBody {
  kind: "local" | "git";
  path?: undefined | string;
  url?: undefined | string;
}
export interface DeleteApiTauriExtensionRootsBody {
  id: string;
}
export interface GetApiTauriExtensionSkillQuery {
  name?: GetApiTauriExtensionSkillQueryName;
}
