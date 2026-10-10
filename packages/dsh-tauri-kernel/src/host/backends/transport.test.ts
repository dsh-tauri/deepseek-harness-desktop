import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessFixture } from './process.fixture'
import { JsonLinesProcess, NativeBridgeError, PendingRequests } from './transport'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const command = { file: 'C:/fixture/native.exe', args: ['fixed-prefix'], env: { PATH: 'C:/fixture/bin' } }
const transports: JsonLinesProcess[] = []

function open(fixture = new ProcessFixture()) {
  vi.mocked(spawn).mockReturnValue(fixture.child)
  const transport = new JsonLinesProcess(command, ['--protocol'], 'C:/fixture/workspace')
  transports.push(transport)
  return { fixture, transport }
}

beforeEach(() => vi.mocked(spawn).mockReset())
afterEach(async () => {
  for (const transport of transports.splice(0))
    await transport.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('native JSONL process transport', () => {
  it('uses direct executable argv with a replacement environment and no shell', () => {
    open()
    expect(spawn).toHaveBeenCalledWith('C:/fixture/native.exe', ['fixed-prefix', '--protocol'], {
      cwd: 'C:/fixture/workspace',
      env: { PATH: 'C:/fixture/bin' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  })

  it('rejects Windows batch shims before creating a process', () => {
    expect(() => new JsonLinesProcess({ ...command, file: 'C:/fixture/native.cmd' }, [], 'C:/fixture')).toThrowError(expect.objectContaining({ code: 'BRIDGE_UNSAFE_EXECUTABLE' }))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('parses split CRLF frames and preserves their order across handler registration', () => {
    const { fixture, transport } = open()
    fixture.writeChunk('{"id":1,"result":')
    fixture.writeChunk('{} }\r\n\n{"method":"ready"}\n')
    const received = vi.fn()
    transport.onMessage(received)
    expect(received.mock.calls).toEqual([[{ id: 1, result: {} }], [{ method: 'ready' }]])
  })

  it('dispatches response frames while an unrelated approval handler is still parked', async () => {
    const { fixture, transport } = open()
    const parked = Promise.withResolvers<void>()
    const received: string[] = []
    transport.onMessage((frame) => {
      received.push(String(frame.method))
      return frame.method === 'approval' ? parked.promise : undefined
    })
    fixture.send({ method: 'approval' })
    fixture.send({ method: 'rpc-response' })
    expect(received).toEqual(['approval', 'rpc-response'])
    parked.resolve()
    await parked.promise
  })

  it('preserves adapter semantic error codes instead of relabelling them invalid JSON', () => {
    const { fixture, transport } = open()
    const failed = vi.fn()
    transport.onFailure(failed)
    transport.onMessage(() => {
      throw new NativeBridgeError('BRIDGE_RESUME_MISMATCH', 'different thread')
    })
    fixture.send({ method: 'event' })
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRIDGE_RESUME_MISMATCH', message: 'different thread' }))
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('contains a buffered frame handler failure and stops before later buffered frames', () => {
    const { fixture, transport } = open()
    fixture.send({ method: 'failure' })
    fixture.send({ method: 'must-not-run' })
    const failed = vi.fn()
    const handler = vi.fn(() => {
      throw new NativeBridgeError('BRIDGE_UNSUPPORTED_EVENT', 'unknown native item')
    })
    transport.onFailure(failed)
    expect(() => transport.onMessage(handler)).not.toThrow()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRIDGE_UNSUPPORTED_EVENT' }))
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops batched dispatch after a handler explicitly fails the transport', () => {
    const { fixture, transport } = open()
    const handler = vi.fn(() => transport.fail(new NativeBridgeError('BRIDGE_NATIVE_TURN', 'native execution failed')))
    transport.onMessage(handler)
    fixture.writeChunk('{"method":"failure"}\n{"method":"must-not-run"}\n')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('fails closed on malformed JSON instead of dropping the frame', () => {
    const { fixture, transport } = open()
    const failed = vi.fn()
    transport.onFailure(failed)
    fixture.writeChunk('{not JSON}\n')
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRIDGE_PROTOCOL' }))
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('bounds native frame input before an unterminated line can grow indefinitely', () => {
    const { fixture, transport } = open()
    const failed = vi.fn()
    transport.onFailure(failed)
    fixture.writeChunk('x'.repeat(8 * 1024 * 1024 + 1))
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'BRIDGE_FRAME_LIMIT' }))
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('waits for graceful stdin EOF before issuing a termination signal', async () => {
    const { fixture, transport } = open()
    await transport.close(true)
    expect(fixture.stdin.end).toHaveBeenCalledTimes(1)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('escalates a non-exiting process without reporting false quiescence', async () => {
    vi.useFakeTimers()
    const fixture = new ProcessFixture()
    fixture.kill.mockImplementation(() => true)
    const { transport } = open(fixture)
    const closed = transport.close()
    const rejected = expect(closed).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_STOP_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(3000)
    await rejected
    expect(fixture.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    transports.splice(transports.indexOf(transport), 1)
    fixture.exit(0)
  })
})

describe('native pending control requests', () => {
  it('settles exactly the matching id without blocking other outstanding requests', async () => {
    const write = vi.fn()
    const requests = new PendingRequests(write)
    const first = requests.request(1, { id: 1, method: 'first' })
    const second = requests.request(2, { id: 2, method: 'second' })
    requests.settle(2, { ok: 'second' })
    requests.settle(1, { ok: 'first' })
    await expect(first).resolves.toEqual({ ok: 'first' })
    await expect(second).resolves.toEqual({ ok: 'second' })
    expect(write.mock.calls).toEqual([[{ id: 1, method: 'first' }], [{ id: 2, method: 'second' }]])
  })

  it('removes cancelled request state so a late native response cannot resettle it', async () => {
    const requests = new PendingRequests(vi.fn())
    const signal = new AbortController()
    const waiting = requests.request('id', { method: 'request' }, signal.signal)
    const rejected = expect(waiting).rejects.toThrow('cancel wait')
    signal.abort(new Error('cancel wait'))
    requests.settle('id', { success: true })
    await rejected
  })

  it('rejects timed-out requests using bounded control waits', async () => {
    vi.useFakeTimers()
    const requests = new PendingRequests(vi.fn())
    const waiting = requests.request('id', { method: 'request' }, undefined, 100)
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'BRIDGE_REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await rejected
  })

  it('propagates every pending failure when the native process crashes', async () => {
    const requests = new PendingRequests(vi.fn())
    const first = requests.request(1, { method: 'first' })
    const second = requests.request(2, { method: 'second' })
    requests.failAll(new NativeBridgeError('BRIDGE_PROCESS_EXIT', 'native exit'))
    await expect(first).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_EXIT' })
    await expect(second).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_EXIT' })
  })
})
