export type GetApiDesktopDshTauriExtensionSkillsResponse = { skills: { name: string; description: string; whenToUse?: undefined | string; invocation: { modelInvocable: false | true; userInvocable: false | true }; source: string; provider: string; editable: false | true; removable: false | true; dir?: undefined | string; policyEditable: false | true; repository?: undefined | { id: string; label: string; kind: "local" | "git"; githubUrl?: undefined | string } }[] } | { error: string };
export type PostApiDesktopDshTauriExtensionSkillsRefreshResponse = { skills: { name: string; description: string; whenToUse?: undefined | string; invocation: { modelInvocable: false | true; userInvocable: false | true }; source: string; provider: string; editable: false | true; removable: false | true; dir?: undefined | string; policyEditable: false | true; repository?: undefined | { id: string; label: string; kind: "local" | "git"; githubUrl?: undefined | string } }[] } | { error: string };
export type GetApiDesktopDshTauriExtensionSkillResponse = { name: string; content: string } | { error: string };
export type GetApiDesktopDshTauriExtensionSkillQueryName = unknown;
export type PostApiDesktopDshTauriExtensionSkillResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type DeleteApiDesktopDshTauriExtensionSkillResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type PostApiDesktopDshTauriExtensionSkillPolicyResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type PostApiDesktopDshTauriExtensionOpenDirResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type GetApiDesktopDshTauriExtensionMcpResponse = { servers: { id: string; layer?: undefined | "global" | "profile"; shadowed?: undefined | false | true; scope?: undefined | "global" | "profile"; serverName: string; transport: "stdio" | "streamable-http"; disabled: false | true; command?: undefined | string; args?: undefined | string[]; env?: undefined | { [key: string]: string }; cwd?: undefined | string; url?: undefined | string; headers?: undefined | { [key: string]: string } }[]; globalError?: undefined | string; restartNeeded: false | true } | { error: string };
export type PostApiDesktopDshTauriExtensionMcpResponse = { ok: false | true; id: string; restartNeeded: false | true } | { error: string };
export type DeleteApiDesktopDshTauriExtensionMcpResponse = { ok: false | true; restartNeeded: false | true } | { error: string };
export type PostApiDesktopDshTauriExtensionMcpToggleResponse = { ok: false | true; restartNeeded: false | true } | { error: string };
export type PostApiDesktopDshTauriExtensionMcpCheckResponse = { ok: false | true; detail?: undefined | string } | { error: string };
export type PostApiDesktopDshTauriExtensionMcpCopyResponse = { error: string; ok?: undefined; id?: undefined; scope?: undefined; restartNeeded?: undefined } | { ok: false | true; id: string; scope: "global" | "profile"; restartNeeded: false | true; error?: undefined };
export type GetApiDesktopDshTauriExtensionImportScanResponse = { servers: { agent: "claude-code" | "codex" | "cursor" | "gemini"; name: string; transport: "stdio" | "streamable-http"; command?: undefined | string; args?: undefined | string[]; env?: undefined | { [key: string]: string }; url?: undefined | string; headers?: undefined | { [key: string]: string } }[]; existing: string[] } | { error: string };
export type PostApiDesktopDshTauriExtensionImportApplyResponse = { ok: false | true; results: { name: string; ok: false | true; error?: undefined | string }[]; restartNeeded: false | true } | { error: string };
export type GetApiDesktopDshTauriExtensionRootsResponse = { roots: ({ id: string; kind: "local" | "git"; label: string; url?: undefined | string; ref?: undefined | string; path?: undefined | string; roots: string[]; materialDir?: undefined | string; addedAt: number } & { live: false | true })[] };
export type PostApiDesktopDshTauriExtensionRootsResponse = { ok: false | true; root: { id: string; kind: "local" | "git"; label: string; url?: undefined | string; ref?: undefined | string; path?: undefined | string; roots: string[]; materialDir?: undefined | string; addedAt: number; live: false | true } } | { error: string };
export type DeleteApiDesktopDshTauriExtensionRootsResponse = { ok: false | true; error?: undefined | string } | { error: string };
export type PostApiDesktopDshTauriExtensionHostRestartResponse = { error: string; ok?: undefined; pid?: undefined; replacementPid?: undefined; logOut?: undefined } | { ok: false | true; pid: number; replacementPid: undefined | number; logOut: string; error?: undefined };
export type OptionsApiDesktopDshTauriExtensionSkillsResponse = void;
export type OptionsApiDesktopDshTauriExtensionSkillsRefreshResponse = void;
export type OptionsApiDesktopDshTauriExtensionSkillResponse = void;
export type OptionsApiDesktopDshTauriExtensionSkillPolicyResponse = void;
export type OptionsApiDesktopDshTauriExtensionOpenDirResponse = void;
export type OptionsApiDesktopDshTauriExtensionMcpResponse = void;
export type OptionsApiDesktopDshTauriExtensionMcpToggleResponse = void;
export type OptionsApiDesktopDshTauriExtensionMcpCheckResponse = void;
export type OptionsApiDesktopDshTauriExtensionMcpCopyResponse = void;
export type OptionsApiDesktopDshTauriExtensionImportScanResponse = void;
export type OptionsApiDesktopDshTauriExtensionImportApplyResponse = void;
export type OptionsApiDesktopDshTauriExtensionRootsResponse = void;
export type OptionsApiDesktopDshTauriExtensionHostRestartResponse = void;

export interface PostApiDesktopDshTauriExtensionSkillBody {
  name: string;
  description: string;
  whenToUse?: undefined | string;
  modelInvocable?: undefined | false | true;
  userInvocable?: undefined | false | true;
  content: string;
}
export interface DeleteApiDesktopDshTauriExtensionSkillBody {
  name: string;
}
export interface PostApiDesktopDshTauriExtensionSkillPolicyBody {
  name: string;
  enabled: false | true;
}
export interface PostApiDesktopDshTauriExtensionOpenDirBody {
  target: "user-skills" | "plugin-state" | "skill" | "root";
  name?: undefined | string;
  id?: undefined | string;
}
export interface PostApiDesktopDshTauriExtensionMcpBody {
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
export interface DeleteApiDesktopDshTauriExtensionMcpBody {
  id: string;
  scope?: undefined | "global" | "profile";
}
export interface PostApiDesktopDshTauriExtensionMcpToggleBody {
  id: string;
  disabled: false | true;
  scope?: undefined | "global" | "profile";
}
export interface PostApiDesktopDshTauriExtensionMcpCheckBody {
  id: string;
  scope?: undefined | "global" | "profile";
}
export interface PostApiDesktopDshTauriExtensionMcpCopyBody {
  id?: unknown;
  scope?: unknown;
  toScope?: unknown;
}
export interface PostApiDesktopDshTauriExtensionImportApplyBody {
  items: { agent: string; name: string }[];
  scope?: undefined | "global" | "profile";
}
export interface PostApiDesktopDshTauriExtensionRootsBody {
  kind: "local" | "git";
  path?: undefined | string;
  url?: undefined | string;
}
export interface DeleteApiDesktopDshTauriExtensionRootsBody {
  id: string;
}
export interface GetApiDesktopDshTauriExtensionSkillQuery {
  name?: GetApiDesktopDshTauriExtensionSkillQueryName;
}
