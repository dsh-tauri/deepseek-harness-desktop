/**
 * Cross-half protocol constants of the SSH remote-machine plugin pair
 * (`dsh-tauri-ssh` host / `dsh-tauri-ssh-ui` client). Both halves and the
 * docs reference these identifiers; centralizing them prevents drift.
 * @module dsh-tauri-ssh/shared/constants
 */

/** Cordis plugin name / loader id of the host half. */
export const SSH_PLUGIN_NAME = 'dsh-tauri-ssh'

/**
 * The same-origin connection-plane route the host half mounts on
 * `ctx.webServer` (and the client half POSTs to). Loopback-only by contract.
 */
export const SSH_API_PREFIX = '/api-ssh'
