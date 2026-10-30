import type { MachineProfile, MachineTransport } from '../types/index'
import type { RemoteTransport } from './transport.types'
import { defineService } from 'dsh-tauri'
import { DEFAULT_MACHINE_TRANSPORT } from '../config/constants'
import { sshTransport } from './transport.ssh'

const IMPLEMENTATIONS: Readonly<Record<MachineTransport, RemoteTransport>> = { ssh: sshTransport }

export const transport = defineService({
  resolve(profile: MachineProfile): RemoteTransport {
    return IMPLEMENTATIONS[profile.transport ?? DEFAULT_MACHINE_TRANSPORT]
  },
})
