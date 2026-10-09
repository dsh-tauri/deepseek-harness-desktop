export type GetApiDesktopDshTauriSchedulerTasksResponse = {
  tasks: {
    id: string;
    name: string;
    schedule: { kind: "once"; at: string; timeZone: string } | { kind: "hourly"; minute: number; timeZone: string } | { kind: "daily"; time: string; timeZone: string } | { kind: "interval"; everyMinutes: number; anchor?: undefined | string; timeZone: string } | { kind: "workdays"; time: string; timeZone: string } | { kind: "weekly"; weekdays: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[]; time: string; timeZone: string } | { kind: "monthly"; day: number; time: string; timeZone: string } | { kind: "custom"; everyDays: number; anchor: string; time: string; timeZone: string };
    prompt: string;
    recommendationId?: undefined | string;
    workspaceId?: undefined | string;
    permission?: undefined | string;
    provider?: undefined | string;
    model?: undefined | string;
    reasoningEffort?: undefined | string;
    module?: undefined | string;
    agentPreset?: undefined | string;
    enabled: false | true;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: undefined | string;
    nextRunAt?: undefined | string;
    waiting?: undefined | false | true;
  }[];
};
export type GetApiDesktopDshTauriSchedulerTasksQuerySearch = undefined | string;
export type PostApiDesktopDshTauriSchedulerTasksResponse = {
  ok?: undefined | false | true;
  task?:
    | undefined
    | {
        id: string;
        name: string;
        schedule: { kind: "once"; at: string; timeZone: string } | { kind: "hourly"; minute: number; timeZone: string } | { kind: "daily"; time: string; timeZone: string } | { kind: "interval"; everyMinutes: number; anchor?: undefined | string; timeZone: string } | { kind: "workdays"; time: string; timeZone: string } | { kind: "weekly"; weekdays: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[]; time: string; timeZone: string } | { kind: "monthly"; day: number; time: string; timeZone: string } | { kind: "custom"; everyDays: number; anchor: string; time: string; timeZone: string };
        prompt: string;
        recommendationId?: undefined | string;
        workspaceId?: undefined | string;
        permission?: undefined | string;
        provider?: undefined | string;
        model?: undefined | string;
        reasoningEffort?: undefined | string;
        module?: undefined | string;
        agentPreset?: undefined | string;
        enabled: false | true;
        createdAt: string;
        updatedAt: string;
        lastRunAt?: undefined | string;
        nextRunAt?: undefined | string;
        waiting?: undefined | false | true;
      };
  error?: undefined | string;
};
export type PutApiDesktopDshTauriSchedulerTasksResponse = {
  ok?: undefined | false | true;
  task?:
    | undefined
    | {
        id: string;
        name: string;
        schedule: { kind: "once"; at: string; timeZone: string } | { kind: "hourly"; minute: number; timeZone: string } | { kind: "daily"; time: string; timeZone: string } | { kind: "interval"; everyMinutes: number; anchor?: undefined | string; timeZone: string } | { kind: "workdays"; time: string; timeZone: string } | { kind: "weekly"; weekdays: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[]; time: string; timeZone: string } | { kind: "monthly"; day: number; time: string; timeZone: string } | { kind: "custom"; everyDays: number; anchor: string; time: string; timeZone: string };
        prompt: string;
        recommendationId?: undefined | string;
        workspaceId?: undefined | string;
        permission?: undefined | string;
        provider?: undefined | string;
        model?: undefined | string;
        reasoningEffort?: undefined | string;
        module?: undefined | string;
        agentPreset?: undefined | string;
        enabled: false | true;
        createdAt: string;
        updatedAt: string;
        lastRunAt?: undefined | string;
        nextRunAt?: undefined | string;
        waiting?: undefined | false | true;
      };
  error?: undefined | string;
};
export type DeleteApiDesktopDshTauriSchedulerTasksResponse = { ok?: undefined | false | true; error?: undefined | string };
export type PostApiDesktopDshTauriSchedulerTasksToggleResponse = {
  ok?: undefined | false | true;
  task?:
    | undefined
    | {
        id: string;
        name: string;
        schedule: { kind: "once"; at: string; timeZone: string } | { kind: "hourly"; minute: number; timeZone: string } | { kind: "daily"; time: string; timeZone: string } | { kind: "interval"; everyMinutes: number; anchor?: undefined | string; timeZone: string } | { kind: "workdays"; time: string; timeZone: string } | { kind: "weekly"; weekdays: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[]; time: string; timeZone: string } | { kind: "monthly"; day: number; time: string; timeZone: string } | { kind: "custom"; everyDays: number; anchor: string; time: string; timeZone: string };
        prompt: string;
        recommendationId?: undefined | string;
        workspaceId?: undefined | string;
        permission?: undefined | string;
        provider?: undefined | string;
        model?: undefined | string;
        reasoningEffort?: undefined | string;
        module?: undefined | string;
        agentPreset?: undefined | string;
        enabled: false | true;
        createdAt: string;
        updatedAt: string;
        lastRunAt?: undefined | string;
        nextRunAt?: undefined | string;
        waiting?: undefined | false | true;
      };
  error?: undefined | string;
};
export type PostApiDesktopDshTauriSchedulerTasksRunResponse = { ok?: undefined | false | true; error?: undefined | string };
export type GetApiDesktopDshTauriSchedulerHistoryResponse = { runs: { id: string; taskId: string; taskName: string; trigger: "schedule" | "manual"; status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "skipped" | "cancelled"; scheduledFor: string; startedAt: string; finishedAt?: undefined | string; sessionId?: undefined | string; error?: undefined | string }[] };
export type GetApiDesktopDshTauriSchedulerHistoryQueryTaskId = undefined | string;
export type DeleteApiDesktopDshTauriSchedulerHistoryResponse = { ok?: undefined | false | true; error?: undefined | string };
export type GetApiDesktopDshTauriSchedulerOptionsResponse = {
  workspaces: { id: string; path: string; title: string }[];
  permissions: { value: string; name: string; description?: undefined | string }[];
  defaultPermission: string;
  models: { provider: string; providerLabel: string; model: string; label: string; description?: undefined | string; reasoning?: undefined | { efforts: { id: string; name: string; description?: undefined | string }[]; defaultEffort?: undefined | string } }[];
  failures: { provider: string; providerLabel: string; message: string }[];
  defaultModel: null | { provider: string; providerLabel: string; model: string; label: string; description?: undefined | string; reasoning?: undefined | { efforts: { id: string; name: string; description?: undefined | string }[]; defaultEffort?: undefined | string } };
};
export type PostApiDesktopDshTauriSchedulerRunsRecoverResponse = { ok?: undefined | false | true; error?: undefined | string };

export interface PostApiDesktopDshTauriSchedulerTasksBody {
  name: string;
  schedule: { kind: "once"; at: string; timeZone?: undefined | string } | { kind: "hourly"; minute: number; timeZone?: undefined | string } | { kind: "daily"; time: string; timeZone?: undefined | string } | { kind: "interval"; everyMinutes: number; anchor?: undefined | string; timeZone?: undefined | string } | { kind: "workdays"; time: string; timeZone?: undefined | string } | { kind: "weekly"; weekdays: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[]; time: string; timeZone?: undefined | string } | { kind: "monthly"; day: number; time: string; timeZone?: undefined | string } | { kind: "custom"; everyDays: number; anchor?: undefined | string; time: string; timeZone?: undefined | string };
  prompt: string;
  recommendationId?: undefined | string;
  workspaceId?: undefined | string;
  permission?: undefined | string;
  provider?: undefined | string;
  model?: undefined | string;
  reasoningEffort?: undefined | string;
  enabled?: undefined | false | true;
}
export interface PutApiDesktopDshTauriSchedulerTasksBody {
  id: string;
  name?: undefined | string;
  schedule?: undefined | { kind: "once"; at: string; timeZone?: undefined | string } | { kind: "hourly"; minute: number; timeZone?: undefined | string } | { kind: "daily"; time: string; timeZone?: undefined | string } | { kind: "interval"; everyMinutes: number; anchor?: undefined | string; timeZone?: undefined | string } | { kind: "workdays"; time: string; timeZone?: undefined | string } | { kind: "weekly"; weekdays: ("MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU")[]; time: string; timeZone?: undefined | string } | { kind: "monthly"; day: number; time: string; timeZone?: undefined | string } | { kind: "custom"; everyDays: number; anchor?: undefined | string; time: string; timeZone?: undefined | string };
  prompt?: undefined | string;
  recommendationId?: undefined | string;
  workspaceId?: undefined | string;
  permission?: undefined | string;
  provider?: undefined | string;
  model?: undefined | string;
  reasoningEffort?: undefined | string;
  enabled?: undefined | false | true;
}
export interface DeleteApiDesktopDshTauriSchedulerTasksBody {
  id: string;
}
export interface PostApiDesktopDshTauriSchedulerTasksToggleBody {
  id: string;
  enabled: false | true;
}
export interface PostApiDesktopDshTauriSchedulerTasksRunBody {
  id: string;
}
export interface DeleteApiDesktopDshTauriSchedulerHistoryBody {
  id: string;
}
export interface GetApiDesktopDshTauriSchedulerTasksQuery {
  search?: GetApiDesktopDshTauriSchedulerTasksQuerySearch;
}
export interface GetApiDesktopDshTauriSchedulerHistoryQuery {
  taskId?: GetApiDesktopDshTauriSchedulerHistoryQueryTaskId;
}
