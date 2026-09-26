/**
 * Structural types of the DSH client services this plugin consumes. The
 * @deepseek-ai packages are private to the harness and never published; the
 * plugin declares local mirrors of the exact surfaces it touches (shapes
 * copied from the harness's own registrants) and never imports the private
 * packages at runtime — the loader calls `apply` with the real context and
 * duck-typing does the rest.
 * @module dsh-tauri-ssh-ui/client/types
 */

/** One settings-section registration option set. */
export interface SlotRegisterOptions {
  name: string
  id: string
  order: number
  label: () => string
  locale?: string
  inject?: () => Record<string, unknown>
}

/** The slots ledger face (a subset of the runtime SlotsService). */
export interface SlotsService {
  inject: (name: string, contribution: () => unknown) => void
  register: (options: SlotRegisterOptions, component: unknown) => unknown
}

/** The locale face (a subset of the locale service). */
export interface LocaleService {
  register: (ns: string, dictionaries: { zh: Record<string, string>, en: Record<string, string> }) => void
  bind: (ns: string) => (key: string) => string
}

/** The client root context this plugin's apply receives. */
export interface UiContext {
  effect: (execute: () => (() => void) | void, label?: string) => unknown
  get: <T = unknown>(name: string) => T
  on: (name: string, listener: (...args: unknown[]) => void) => () => boolean
  slots: SlotsService
  locale: LocaleService
}

export type {
  MachineLifecycleState,
  RemoteBridge,
  SshMachineEvent,
  SyncApplyResult,
  SyncItemResult,
  SyncPluginItem,
  SyncPreview,
  SyncSkillItem,
} from './sync'
export { isLifecycleState } from './sync'
