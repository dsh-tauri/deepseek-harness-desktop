/**
 * Shared client constants of the SSH-machines settings page: the settings
 * slot protocol identifiers, the locale namespace, and the same-origin API
 * route the host half (`dsh-tauri-ssh`) mounts.
 * @module dsh-tauri-ssh-ui/client/constants
 */

/** Dictionary namespace owned by this plugin. */
export const SSH_LOCALE_NS = 'ssh'

/** The settings section slot this plugin registers into. */
export const SETTINGS_SECTION_SLOT = 'settings.section'

/** Registration id of this plugin's single settings section (the host plugin's id). */
export const SETTINGS_SECTION_ID = 'dsh-tauri-ssh'

/** Order of this plugin's settings section among the other sections. */
export const SETTINGS_SECTION_ORDER = 50

/** The machines tab of the SSH section (shared with the shell deep link). */
export const SSH_TAB_MACHINES = 'machines'

/** The sync-to-remote tab of the SSH section (shared with the shell deep link). */
export const SSH_TAB_SYNC = 'sync'

/** DOM id base of the tab strip; each panel is `${SSH_TABS_ID}-${tab}-panel`. */
export const SSH_TABS_ID = 'dsh-tauri-ssh-tabs'

/** The shell → iframe settings deep link (the `tab` field picks the SSH tab). */
export const SETTINGS_OPEN_MESSAGE = 'dsh://settings:open'

/** The /api-ssh route the host plugin mounts (same-origin POST envelope). */
export const SSH_API_PATH = '/api-ssh'

/**
 * C-BRIDGE (S5-owned): the desktop iframe invoke commands the panel talks to
 * through `invokeBridgedTauri`. A timeout or rejection on the ping means the
 * page runs outside the desktop shell (pure web) and the popup affordance
 * hides itself.
 */
export const REMOTE_BRIDGE_PING_COMMAND = 'remote_bridge_ping'

/** Open (or focus) the `remote-<machineId>` window for a tunnel URL. */
export const REMOTE_OPEN_WINDOW_COMMAND = 'remote_open_window'
