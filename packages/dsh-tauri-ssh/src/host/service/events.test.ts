import { describe, expect, it } from 'vitest'
import { MachineId } from '../types/index'
import { EVENT_RING_CAPACITY, SshMachineEvents } from './events'

const m1 = MachineId('m1')
const m2 = MachineId('m2')

describe('sshMachineEvents', () => {
  it('assigns per-machine monotonic seqs starting at 1', () => {
    const log = new SshMachineEvents()
    log.append(m1, 'probe', 'one')
    log.append(m1, 'download', 'two')
    log.append(m2, 'probe', 'other machine')
    const page = log.since(m1)
    expect(page.events.map(event => event.seq)).toEqual([1, 2])
    expect(page.nextSeq).toBe(3)
    expect(log.since(m2).events).toHaveLength(1)
  })

  it('stamps ts and machineId on every event and carries terminal/reason only when present', () => {
    const log = new SshMachineEvents()
    const first = log.append(m1, 'probe', 'probing')
    expect(first.machineId).toBe(m1)
    expect(first.ts).toBeTruthy()
    expect('terminal' in first).toBe(false)
    const last = log.append(m1, 'failed', 'bootstrap 失败', { terminal: 'failed', reason: 'checksum mismatch' })
    expect(last.terminal).toBe('failed')
    expect(last.reason).toBe('checksum mismatch')
    const ready = log.append(m1, 'ready', '已就绪', { terminal: 'success' })
    expect(ready.terminal).toBe('success')
    expect('reason' in ready).toBe(false)
  })

  it('drains incrementally by sinceSeq', () => {
    const log = new SshMachineEvents()
    for (let i = 0; i < 5; i++)
      log.append(m1, 'install', `line ${i}`)
    const first = log.since(m1)
    expect(first.events).toHaveLength(5)
    const second = log.since(m1, first.events[2]?.seq)
    expect(second.events.map(event => event.line)).toEqual(['line 3', 'line 4'])
    expect(second.nextSeq).toBe(6)
    const caughtUp = log.since(m1, 4)
    expect(caughtUp.events).toHaveLength(1)
  })

  it('anchors unknown machines at an empty page', () => {
    const log = new SshMachineEvents()
    expect(log.since(MachineId('nope'))).toEqual({ events: [], nextSeq: 1 })
  })

  it('keeps only the newest events per machine (ring buffer)', () => {
    const log = new SshMachineEvents(3)
    for (let i = 0; i < 6; i++)
      log.append(m1, 'download', `url ${i}`)
    const page = log.since(m1)
    expect(page.events.map(event => event.line)).toEqual(['url 3', 'url 4', 'url 5'])
    expect(page.nextSeq).toBe(7)
    // A lagged consumer skipping past the dropped window sees only what survives.
    expect(log.since(m1, 1).events).toHaveLength(3)
  })

  it('uses the documented default capacity', () => {
    const log = new SshMachineEvents()
    for (let i = 0; i < EVENT_RING_CAPACITY + 25; i++)
      log.append(m1, 'install', `line ${i}`)
    expect(log.since(m1).events).toHaveLength(EVENT_RING_CAPACITY)
  })

  it('forgets a removed machine independently of its neighbors', () => {
    const log = new SshMachineEvents()
    log.append(m1, 'probe', 'one')
    log.append(m2, 'probe', 'two')
    log.forget(m1)
    expect(log.since(m1).events).toHaveLength(0)
    expect(log.since(m2).events).toHaveLength(1)
    // A re-created machine starts a fresh seq domain.
    expect(log.append(m1, 'probe', 'again').seq).toBe(1)
  })
})
