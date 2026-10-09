/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method post */
export function postConfigOpen(params?: Types.PostApiDesktopDshTauriModelConfigOpenQuery, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriModelConfigOpenResponse>("/api/desktop/dsh-tauri-model/config/open", { method: "post", params, ...options });
}

/** @method get */
export function getEndpointModels(params?: Types.GetApiDesktopDshTauriModelEndpointModelsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriModelEndpointModelsResponse>("/api/desktop/dsh-tauri-model/endpoint/models", { method: "get", params, ...options });
}

/** @method get */
export function getPresets(params?: Types.GetApiDesktopDshTauriModelPresetsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriModelPresetsResponse>("/api/desktop/dsh-tauri-model/presets", { method: "get", params, ...options });
}
