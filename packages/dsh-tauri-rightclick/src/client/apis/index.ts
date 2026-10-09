/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method post */
export function postOpenUrl(body: Types.PostApiDesktopDshTauriRightclickOpenUrlBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriRightclickOpenUrlResponse>("/api/desktop/dsh-tauri-rightclick/open/url", { method: "post", body, ...options });
}

/** @method options */
export function optionsOpenUrl(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriRightclickOpenUrlResponse>("/api/desktop/dsh-tauri-rightclick/open/url", { method: "options", ...options });
}

/** @method post */
export function postOpenPath(body: Types.PostApiDesktopDshTauriRightclickOpenPathBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriRightclickOpenPathResponse>("/api/desktop/dsh-tauri-rightclick/open/path", { method: "post", body, ...options });
}

/** @method options */
export function optionsOpenPath(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriRightclickOpenPathResponse>("/api/desktop/dsh-tauri-rightclick/open/path", { method: "options", ...options });
}
