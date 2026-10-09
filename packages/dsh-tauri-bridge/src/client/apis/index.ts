/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getBackends(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriBridgeBackendsResponse>("/api/tauri/bridge/backends", { method: "get", ...options });
}

/** @method get */
export function getModels(params: Types.GetApiTauriBridgeModelsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriBridgeModelsResponse>("/api/tauri/bridge/models", { method: "get", params, ...options });
}

/** @method post */
export function postModels(body: Types.PostApiTauriBridgeModelsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriBridgeModelsResponse>("/api/tauri/bridge/models", { method: "post", body, ...options });
}

/** @method post */
export function postSessions(body: Types.PostApiTauriBridgeSessionsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriBridgeSessionsResponse>("/api/tauri/bridge/sessions", { method: "post", body, ...options });
}
