/**
 * SSH-machines settings page, browser half. Registers the `ssh` dictionary
 * and the single `SSH` settings section that fronts the whole feature with an
 * enable switch (off by default) and, once on, hosts the machines and the
 * plugin/skill sync tabs. The page state lives in the injected MachinesStore
 * (feature flag, machine CRUD, the connection plane and the sync surface, all
 * through the host plugin's /api-ssh route). The css-render style tree mounts
 * once here via ctx.effect (unmounts with the plugin). Export discipline: thin
 * apply, everything else in feature modules.
 * @module dsh-tauri-ssh-ui/client
 */

import type { UiContext } from './types'
import { mountStyle } from 'dsh-tauri-ui/client'
import { SshSection } from './components/ssh-section'
import {
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTION_SLOT,
  SSH_LOCALE_NS,
} from './constants'
import { en, zh } from './locales'
import { desktopBridge } from './service/bridge'
import { MachinesStore } from './store'
import { SSH_STYLE_ID, sshStyle } from './styles'

/** Required services: the settings slot seam and the locale seat. */
export const inject = ['slots', 'locale']

/**
 * Register the `ssh` dictionary and the SSH settings section, once the slot
 * declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: UiContext): void {
  ctx.effect(() => ctx.locale.register(SSH_LOCALE_NS, { zh, en }), 'dsh-tauri-ssh-ui: dictionaries')
  ctx.effect(() => mountStyle(sshStyle, SSH_STYLE_ID), 'dsh-tauri-ssh-ui: styles')
  const t = ctx.locale.bind(SSH_LOCALE_NS)
  const store = new MachinesStore((url, init) => fetch(url, init))
  ctx.slots.inject(SETTINGS_SECTION_SLOT, () => ctx.slots.register({
    name: SETTINGS_SECTION_SLOT,
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label: () => t('nav'),
    locale: SSH_LOCALE_NS,
    inject: () => ({ store, bridge: desktopBridge }),
  }, SshSection))
}

/** The dictionary key union, re-exported for the section props. */
export type { SshKey } from './locales'
