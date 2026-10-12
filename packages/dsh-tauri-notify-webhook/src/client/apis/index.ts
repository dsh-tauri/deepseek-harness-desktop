/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getSettings(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriNotifyWebhookSettingsResponse>("/api/tauri/notify-webhook/settings", { method: "get", ...options });
}

/** @method post */
export function postSettings(body: Types.PostApiTauriNotifyWebhookSettingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriNotifyWebhookSettingsResponse>("/api/tauri/notify-webhook/settings", { method: "post", body, ...options });
}

/** @method post */
export function postTest(options?: FetchOptions) {
  return ofetch<Types.PostApiTauriNotifyWebhookTestResponse>("/api/tauri/notify-webhook/test", { method: "post", ...options });
}

/** @method get */
export function getTurnEnd(params?: Types.GetApiTauriNotifyWebhookTurnEndQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriNotifyWebhookTurnEndResponse>("/api/tauri/notify-webhook/turn-end", { method: "get", params, ...options });
}

/** @method post */
export function postDelivery(body: Types.PostApiTauriNotifyWebhookDeliveryBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriNotifyWebhookDeliveryResponse>("/api/tauri/notify-webhook/delivery", { method: "post", body, ...options });
}
