import { describe, expect, it } from 'vitest'
import { DEFAULT_MACHINE_TRANSPORT, DEFAULT_REMOTE_PROFILE } from '../host/config/constants'
import { machineProfileOf } from '../host/service/state.utils'
import { DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT, DEFAULT_REMOTE_PORT as hostRemotePort, DEFAULT_SSH_PORT as hostSshPort } from './constants'

describe('shared SSH defaults', () => {
  it('preserves numeric defaults and host exports', () => {
    expect(DEFAULT_SSH_PORT).toBe(22)
    expect(DEFAULT_REMOTE_PORT).toBe(3080)
    expect(hostSshPort).toBe(22)
    expect(hostRemotePort).toBe(3080)
    expect(DEFAULT_REMOTE_PROFILE).toBe('remote')
  })

  it.each([{}, { port: 'bad', remotePort: null }])('keeps stored wire fallback values for %j', (ports) => {
    const wire = { id: 'a', name: 'alpha', host: 'localhost', user: 'ops', ...ports }
    expect(machineProfileOf(wire)).toMatchObject({ port: 22, remotePort: 3080 })
  })

  it('preserves explicitly supplied numeric ports', () => {
    const wire = { id: 'a', name: 'alpha', host: 'localhost', user: 'ops', port: 2222, remotePort: 4000 }
    expect(machineProfileOf(wire)).toMatchObject({ port: 2222, remotePort: 4000 })
  })

  it('defaults the machine transport to ssh', () => {
    expect(DEFAULT_MACHINE_TRANSPORT).toBe('ssh')
  })

  it('accepts a stored ssh transport without keeping the field on the profile', () => {
    const profile = machineProfileOf({ id: 'a', name: 'alpha', host: 'localhost', user: 'ops', transport: 'ssh' })
    expect(profile).toMatchObject({ id: 'a', name: 'alpha', host: 'localhost', user: 'ops' })
    expect(profile).not.toHaveProperty('transport')
  })

  it('rejects a stored machine whose transport is unknown', () => {
    expect(machineProfileOf({ id: 'a', name: 'alpha', host: 'localhost', user: 'ops', transport: 'telnet' })).toBeUndefined()
  })
})
