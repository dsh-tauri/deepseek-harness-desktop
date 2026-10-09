export type GetApiDesktopDshTauriSshSettingsResponse = { enabled?: false | true; error?: string };
export type PostApiDesktopDshTauriSshSettingsResponse = { enabled?: false | true; error?: string };
export type GetApiDesktopDshTauriSshSessionRoleResponse = { role?: string; remote?: false | true; origin?: string; error?: string };
export type GetApiDesktopDshTauriSshMachinesResponse = {
  enabled?: false | true;
  items?: { id?: string; name?: string; host?: string; port?: number; user?: string; hasPassword?: false | true; hasPassphrase?: false | true; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true; state?: "disconnected" | "testing" | "connecting" | "connected" | "reconnecting" | "given-up"; tunnelBaseUrl?: string; lastError?: string; dshMissing?: false | true; progress?: { phase: "handshake" | "starting" | "probing" | "installing" | "syncing"; attempt?: number; total?: number; item?: string; log?: string }; nextRetryAt?: number; authMethod?: "agent" | "key" | "password" }[];
  discovered?: { id?: string; name?: string; host?: string; port?: number; user?: string; hasPassword?: false | true; hasPassphrase?: false | true; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true; state?: "disconnected" | "testing" | "connecting" | "connected" | "reconnecting" | "given-up"; tunnelBaseUrl?: string; lastError?: string; dshMissing?: false | true; progress?: { phase: "handshake" | "starting" | "probing" | "installing" | "syncing"; attempt?: number; total?: number; item?: string; log?: string }; nextRetryAt?: number; authMethod?: "agent" | "key" | "password" }[];
  error?: string;
};
export type PostApiDesktopDshTauriSshMachinesResponse = { error?: string };
export type DeleteApiDesktopDshTauriSshMachinesResponse = { error?: string };
export type PostApiDesktopDshTauriSshMachinesTestResponse = { ok?: false | true; banner?: string; message?: string; error?: string };
export type PostApiDesktopDshTauriSshMachinesConnectResponse = { tunnelBaseUrl?: string; error?: string };
export type PostApiDesktopDshTauriSshMachinesDisconnectResponse = { error?: string };
export type PostApiDesktopDshTauriSshMachinesInstallResponse = { installed?: string[]; dshRef?: string; dshVersion?: string; dshPath?: string; credentialsCopied?: false | true; credentialsError?: string; error?: string };
export type GetApiDesktopDshTauriSshMachinesEventsResponse = { items?: { seq?: number; ts?: string; machineId?: string; stage?: string; line?: string; terminal?: string; reason?: string }[]; nextSeq?: number; error?: string };
export type GetApiDesktopDshTauriSshMachinesEventsQueryMachineId = string;
export type GetApiDesktopDshTauriSshMachinesEventsQuerySinceSeq = number;
export type GetApiDesktopDshTauriSshSyncPreviewResponse = { plugins?: { name?: string; spec?: string; syncable?: false | true; reason?: string }[]; skills?: { name?: string; root?: string }[]; error?: string };
export type PostApiDesktopDshTauriSshSyncApplyResponse = { items?: { kind?: string; name?: string; root?: string; ok?: false | true; error?: string; log?: string }[]; error?: string };

export interface PostApiDesktopDshTauriSshSettingsBody {
  enabled?: false | true;
}
export interface PostApiDesktopDshTauriSshMachinesBody {
  machineId?: string;
  row?: { name?: string; host?: string; port?: number; user?: string; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true };
  secrets?: { password?: string; passphrase?: string };
}
export interface DeleteApiDesktopDshTauriSshMachinesBody {
  machineId?: string;
}
export interface PostApiDesktopDshTauriSshMachinesTestBody {
  machineId?: string;
}
export interface PostApiDesktopDshTauriSshMachinesConnectBody {
  machineId?: string;
}
export interface PostApiDesktopDshTauriSshMachinesDisconnectBody {
  machineId?: string;
}
export interface PostApiDesktopDshTauriSshMachinesInstallBody {
  machineId?: string;
}
export interface PostApiDesktopDshTauriSshSyncApplyBody {
  machineId?: string;
  plugins?: { name?: string; spec?: string }[];
  skills?: { name?: string; root?: string }[];
}
export interface GetApiDesktopDshTauriSshMachinesEventsQuery {
  machineId?: GetApiDesktopDshTauriSshMachinesEventsQueryMachineId;
  sinceSeq?: GetApiDesktopDshTauriSshMachinesEventsQuerySinceSeq;
}
