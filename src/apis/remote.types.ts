export type GetApiTauriSshSettingsResponse = { enabled?: false | true; error?: string };
export type PostApiTauriSshSettingsResponse = { enabled?: false | true; error?: string };
export type GetApiTauriSshSessionRoleResponse = { role?: string; remote?: false | true; origin?: string; error?: string };
export type GetApiTauriSshMachinesResponse = {
  enabled?: false | true;
  items?: { id?: string; name?: string; host?: string; port?: number; user?: string; hasPassword?: false | true; hasPassphrase?: false | true; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true; state?: "disconnected" | "testing" | "connecting" | "connected" | "reconnecting" | "given-up"; tunnelBaseUrl?: string; lastError?: string; dshMissing?: false | true; progress?: { phase: "handshake" | "starting" | "probing" | "installing" | "syncing"; attempt?: number; total?: number; item?: string; log?: string }; nextRetryAt?: number; authMethod?: "agent" | "key" | "password" }[];
  discovered?: { id?: string; name?: string; host?: string; port?: number; user?: string; hasPassword?: false | true; hasPassphrase?: false | true; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true; state?: "disconnected" | "testing" | "connecting" | "connected" | "reconnecting" | "given-up"; tunnelBaseUrl?: string; lastError?: string; dshMissing?: false | true; progress?: { phase: "handshake" | "starting" | "probing" | "installing" | "syncing"; attempt?: number; total?: number; item?: string; log?: string }; nextRetryAt?: number; authMethod?: "agent" | "key" | "password" }[];
  error?: string;
};
export type PostApiTauriSshMachinesResponse = { error?: string };
export type DeleteApiTauriSshMachinesResponse = { error?: string };
export type PostApiTauriSshMachinesTestResponse = { ok?: false | true; banner?: string; message?: string; error?: string };
export type PostApiTauriSshMachinesConnectResponse = { tunnelBaseUrl?: string; error?: string };
export type PostApiTauriSshMachinesDisconnectResponse = { error?: string };
export type PostApiTauriSshMachinesInstallResponse = { installed?: string[]; dshRef?: string; dshVersion?: string; dshPath?: string; credentialsCopied?: false | true; credentialsError?: string; error?: string };
export type GetApiTauriSshMachinesEventsResponse = { items?: { seq?: number; ts?: string; machineId?: string; stage?: string; line?: string; terminal?: string; reason?: string }[]; nextSeq?: number; error?: string };
export type GetApiTauriSshMachinesEventsQueryMachineId = string;
export type GetApiTauriSshMachinesEventsQuerySinceSeq = number;
export type GetApiTauriSshSyncPreviewResponse = { plugins?: { name?: string; spec?: string; syncable?: false | true; reason?: string }[]; skills?: { name?: string; root?: string }[]; error?: string };
export type PostApiTauriSshSyncApplyResponse = { items?: { kind?: string; name?: string; root?: string; ok?: false | true; error?: string; log?: string }[]; error?: string };

export interface PostApiTauriSshSettingsBody {
  enabled?: false | true;
}
export interface PostApiTauriSshMachinesBody {
  machineId?: string;
  row?: { name?: string; host?: string; port?: number; user?: string; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true };
  secrets?: { password?: string; passphrase?: string };
}
export interface DeleteApiTauriSshMachinesBody {
  machineId?: string;
}
export interface PostApiTauriSshMachinesTestBody {
  machineId?: string;
}
export interface PostApiTauriSshMachinesConnectBody {
  machineId?: string;
}
export interface PostApiTauriSshMachinesDisconnectBody {
  machineId?: string;
}
export interface PostApiTauriSshMachinesInstallBody {
  machineId?: string;
}
export interface PostApiTauriSshSyncApplyBody {
  machineId?: string;
  plugins?: { name?: string; spec?: string }[];
  skills?: { name?: string; root?: string }[];
}
export interface GetApiTauriSshMachinesEventsQuery {
  machineId?: GetApiTauriSshMachinesEventsQueryMachineId;
  sinceSeq?: GetApiTauriSshMachinesEventsQuerySinceSeq;
}
