export type GetApiTauriRemoteSettingsResponse = { enabled?: false | true; error?: string };
export type PostApiTauriRemoteSettingsResponse = { enabled?: false | true; error?: string };
export type GetApiTauriRemoteSessionRoleResponse = { role?: string; remote?: false | true; origin?: string; error?: string };
export type GetApiTauriRemoteMachinesResponse = {
  enabled?: false | true;
  items?: { id?: string; name?: string; host?: string; port?: number; user?: string; hasPassword?: false | true; hasPassphrase?: false | true; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true; state?: "disconnected" | "testing" | "connecting" | "connected" | "reconnecting" | "given-up"; tunnelBaseUrl?: string; lastError?: string; dshMissing?: false | true; progress?: { phase: "handshake" | "starting" | "probing" | "installing" | "syncing"; attempt?: number; total?: number; item?: string; log?: string }; nextRetryAt?: number; authMethod?: "agent" | "key" | "password" }[];
  discovered?: { id?: string; name?: string; host?: string; port?: number; user?: string; hasPassword?: false | true; hasPassphrase?: false | true; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true; state?: "disconnected" | "testing" | "connecting" | "connected" | "reconnecting" | "given-up"; tunnelBaseUrl?: string; lastError?: string; dshMissing?: false | true; progress?: { phase: "handshake" | "starting" | "probing" | "installing" | "syncing"; attempt?: number; total?: number; item?: string; log?: string }; nextRetryAt?: number; authMethod?: "agent" | "key" | "password" }[];
  error?: string;
};
export type PostApiTauriRemoteMachinesResponse = { error?: string };
export type DeleteApiTauriRemoteMachinesResponse = { error?: string };
export type PostApiTauriRemoteMachinesTestResponse = { ok?: false | true; banner?: string; message?: string; error?: string };
export type PostApiTauriRemoteMachinesConnectResponse = { tunnelBaseUrl?: string; error?: string };
export type PostApiTauriRemoteMachinesDisconnectResponse = { error?: string };
export type PostApiTauriRemoteMachinesInstallResponse = { installed?: string[]; dshRef?: string; dshVersion?: string; dshPath?: string; credentialsCopied?: false | true; credentialsError?: string; error?: string };
export type GetApiTauriRemoteMachinesEventsResponse = { items?: { seq?: number; ts?: string; machineId?: string; stage?: string; line?: string; terminal?: string; reason?: string }[]; nextSeq?: number; error?: string };
export type GetApiTauriRemoteMachinesEventsQueryMachineId = string;
export type GetApiTauriRemoteMachinesEventsQuerySinceSeq = number;
export type GetApiTauriRemoteSyncPreviewResponse = { plugins?: { name?: string; spec?: string; syncable?: false | true; reason?: string }[]; skills?: { name?: string; root?: string }[]; error?: string };
export type PostApiTauriRemoteSyncApplyResponse = { items?: { kind?: string; name?: string; root?: string; ok?: false | true; error?: string; log?: string }[]; error?: string };

export interface PostApiTauriRemoteSettingsBody {
  enabled?: false | true;
}
export interface PostApiTauriRemoteMachinesBody {
  machineId?: string;
  row?: { name?: string; host?: string; port?: number; user?: string; remotePort?: number; profileName?: string; startCommand?: string; color?: string; tintBorder?: false | true };
  secrets?: { password?: string; passphrase?: string };
}
export interface DeleteApiTauriRemoteMachinesBody {
  machineId?: string;
}
export interface PostApiTauriRemoteMachinesTestBody {
  machineId?: string;
}
export interface PostApiTauriRemoteMachinesConnectBody {
  machineId?: string;
}
export interface PostApiTauriRemoteMachinesDisconnectBody {
  machineId?: string;
}
export interface PostApiTauriRemoteMachinesInstallBody {
  machineId?: string;
}
export interface PostApiTauriRemoteSyncApplyBody {
  machineId?: string;
  plugins?: { name?: string; spec?: string }[];
  skills?: { name?: string; root?: string }[];
}
export interface GetApiTauriRemoteMachinesEventsQuery {
  machineId?: GetApiTauriRemoteMachinesEventsQueryMachineId;
  sinceSeq?: GetApiTauriRemoteMachinesEventsQuerySinceSeq;
}
