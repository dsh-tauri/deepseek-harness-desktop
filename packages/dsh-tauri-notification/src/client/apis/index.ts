/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getTurnEnd(params?: Types.GetApiTauriNotificationTurnEndQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriNotificationTurnEndResponse>("/api/tauri/notification/turn-end", { method: "get", params, ...options });
}
