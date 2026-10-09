/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getTurnEnd(params?: Types.GetApiDesktopDshTauriNotificationTurnEndQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriNotificationTurnEndResponse>("/api/desktop/dsh-tauri-notification/turn-end", { method: "get", params, ...options });
}

/** @method options */
export function optionsTurnEnd(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriNotificationTurnEndResponse>("/api/desktop/dsh-tauri-notification/turn-end", { method: "options", ...options });
}
