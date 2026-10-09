export type GetApiTauriSchedulerTasksResponse = {
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
export type GetApiTauriSchedulerTasksQuerySearch = undefined | string;
export type PostApiTauriSchedulerTasksResponse = {
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
export type PutApiTauriSchedulerTasksResponse = {
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
export type DeleteApiTauriSchedulerTasksResponse = { ok?: undefined | false | true; error?: undefined | string };
export type PostApiTauriSchedulerTasksToggleResponse = {
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
export type PostApiTauriSchedulerTasksRunResponse = { ok?: undefined | false | true; error?: undefined | string };
export type GetApiTauriSchedulerHistoryResponse = { runs: { id: string; taskId: string; taskName: string; trigger: "schedule" | "manual"; status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "skipped" | "cancelled"; scheduledFor: string; startedAt: string; finishedAt?: undefined | string; sessionId?: undefined | string; error?: undefined | string }[] };
export type GetApiTauriSchedulerHistoryQueryTaskId = undefined | string;
export type DeleteApiTauriSchedulerHistoryResponse = { ok?: undefined | false | true; error?: undefined | string };
export type GetApiTauriSchedulerOptionsResponse = {
  workspaces: { id: string; path: string; title: string }[];
  permissions: { value: string; name: string; description?: undefined | string }[];
  defaultPermission: string;
  models: { provider: string; providerLabel: string; model: string; label: string; description?: undefined | string; reasoning?: undefined | { efforts: { id: string; name: string; description?: undefined | string }[]; defaultEffort?: undefined | string } }[];
  failures: { provider: string; providerLabel: string; message: string }[];
  defaultModel: null | { provider: string; providerLabel: string; model: string; label: string; description?: undefined | string; reasoning?: undefined | { efforts: { id: string; name: string; description?: undefined | string }[]; defaultEffort?: undefined | string } };
};
export type PostApiTauriSchedulerRunsRecoverResponse = { ok?: undefined | false | true; error?: undefined | string };

export interface PostApiTauriSchedulerTasksBody {
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
export interface PutApiTauriSchedulerTasksBody {
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
export interface DeleteApiTauriSchedulerTasksBody {
  id: string;
}
export interface PostApiTauriSchedulerTasksToggleBody {
  id: string;
  enabled: false | true;
}
export interface PostApiTauriSchedulerTasksRunBody {
  id: string;
}
export interface DeleteApiTauriSchedulerHistoryBody {
  id: string;
}
export interface GetApiTauriSchedulerTasksQuery {
  search?: GetApiTauriSchedulerTasksQuerySearch;
}
export interface GetApiTauriSchedulerHistoryQuery {
  taskId?: GetApiTauriSchedulerHistoryQueryTaskId;
}
