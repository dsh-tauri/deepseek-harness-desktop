/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method post */
export function postOpenUrl(body: Types.PostApiTauriRightclickOpenUrlBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRightclickOpenUrlResponse>("/api/tauri/rightclick/open/url", { method: "post", body, ...options });
}

/** @method post */
export function postOpenPath(body: Types.PostApiTauriRightclickOpenPathBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRightclickOpenPathResponse>("/api/tauri/rightclick/open/path", { method: "post", body, ...options });
}
