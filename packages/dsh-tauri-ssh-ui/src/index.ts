/**
 * The DSH remote-machine client plugin: the SSH-machines settings page. The
 * browser half lives in `./client` (locale dictionary + one
 * `settings.section` slot); this entry is the host-side loader stub — no
 * host-side behavior, the SSH kernel is the `dsh-tauri-ssh` host plugin.
 * @module dsh-tauri-ssh-ui
 */

/** Host plugin body — no host-side behavior; the SSH kernel is the ssh-remote host plugin. */
export function apply(): void {}
