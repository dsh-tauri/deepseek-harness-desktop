import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NativeCommand } from './types'
import { spawn } from 'node:child_process'
import { nativeEnvironment } from '../utils/detection'

const MAX_FRAME_CHARS = 8 * 1024 * 1024
const MAX_STDERR_CHARS = 16 * 1024
const MAX_QUEUED_FRAMES = 8192
const CLOSE_TIMEOUT_MS = 1500
export const REQUEST_TIMEOUT_MS = 60_000
export const INTERRUPT_TIMEOUT_MS = 5000

export class NativeBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NativeBridgeError'
  }
}

export function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new NativeBridgeError('BRIDGE_ABORTED', 'Native turn was cancelled')
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Expected a native protocol object')
  return value as Record<string, unknown>
}

export function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || value[key] === '')
    throw new NativeBridgeError('BRIDGE_PROTOCOL', `Missing native protocol field: ${key}`)
  return value[key]
}

export function textMessages(messages: readonly UserMessage[]): string[] {
  return messages.map(message => message.content.map((block) => {
    if (block.type !== 'text')
      throw new NativeBridgeError('BRIDGE_UNSUPPORTED_CONTENT', `Native bridge does not yet support user content: ${block.type}`)
    return block.text
  }).join(''))
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // State can fail between allocation and the caller's first await.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export class JsonLinesProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly closed = deferred<void>()
  private input = ''
  private stderr = ''
  private failure?: Error
  private closing?: Promise<void>
  private stopped = false
  private exited = false
  private queue: Record<string, unknown>[] = []
  private draining = false
  private handler?: (message: Record<string, unknown>) => void | Promise<void>
  private failureHandler?: (error: Error) => void

  constructor(command: NativeCommand, args: string[], cwd: string) {
    if (/\.(?:cmd|bat)$/i.test(command.file))
      throw new NativeBridgeError('BRIDGE_UNSAFE_EXECUTABLE', 'Resolve Windows batch shims to the native executable or node + official entrypoint')
    this.child = spawn(command.file, [...command.args, ...args], {
      cwd,
      env: command.env ?? nativeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.readChunk(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS)
    })
    this.child.stdout.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => this.fail(error))
    this.child.once('close', (code, signal) => {
      if (!this.stopped)
        this.fail(new NativeBridgeError('BRIDGE_PROCESS_EXIT', `Native process exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`))
      this.stopped = true
      this.exited = true
      this.closed.resolve()
    })
  }

  onMessage(handler: (message: Record<string, unknown>) => void | Promise<void>): void {
    this.handler = handler
    this.drain()
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler
    if (this.failure)
      handler(this.failure)
  }

  write(value: unknown): void {
    if (this.failure)
      throw this.failure
    if (this.stopped || !this.child.stdin.writable)
      throw new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Native process is not writable')
    const line = `${JSON.stringify(value)}\n`
    if (line.length > MAX_FRAME_CHARS)
      throw new NativeBridgeError('BRIDGE_FRAME_LIMIT', 'Native protocol frame exceeds the bounded transport limit')
    this.child.stdin.write(line)
  }

  fail(error: Error): void {
    if (this.failure)
      return
    this.failure = error
    this.queue = []
    this.failureHandler?.(error)
    void this.close().catch(() => {})
  }

  close(graceful = false): Promise<void> {
    this.closing ??= this.stop(graceful)
    return this.closing
  }

  private async stop(graceful: boolean): Promise<void> {
    if (this.exited)
      return
    this.stopped = true
    this.queue = []
    if (graceful) {
      this.child.stdin.end()
      if (await this.waitForExit())
        return
    }
    this.child.stdin.destroy()
    this.child.kill('SIGTERM')
    if (await this.waitForExit())
      return
    this.child.kill('SIGKILL')
    if (!await this.waitForExit())
      throw new NativeBridgeError('BRIDGE_PROCESS_STOP_TIMEOUT', 'Native process did not exit after termination')
  }

  private async waitForExit(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      this.closed.promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS, false)
      }),
    ])
    clearTimeout(timer)
    return exited
  }

  private readChunk(chunk: string): void {
    if (this.stopped)
      return
    this.input += chunk
    let end = this.input.indexOf('\n')
    while (end >= 0) {
      const line = this.input.slice(0, end).trim()
      this.input = this.input.slice(end + 1)
      if (line.length > MAX_FRAME_CHARS) {
        this.fail(new NativeBridgeError('BRIDGE_FRAME_LIMIT', 'Native protocol frame exceeds the bounded transport limit'))
        return
      }
      if (line) {
        try {
          const message = record(JSON.parse(line))
          // Calling an async handler starts request/response dispatch synchronously.
          // Only notification mutation is serialized by the adapters.
          const result = this.handler?.(message)
          if (result)
            void Promise.resolve(result).catch(error => this.fail(errorFrom(error)))
          else if (!this.handler)
            this.queue.push(message)
        }
        catch (error) {
          this.fail(error instanceof NativeBridgeError ? error : new NativeBridgeError('BRIDGE_PROTOCOL', `Invalid native JSONL: ${errorFrom(error).message}`))
          return
        }
      }
      if (this.queue.length > MAX_QUEUED_FRAMES) {
        this.fail(new NativeBridgeError('BRIDGE_QUEUE_LIMIT', 'Native notification queue exceeded its bounded limit'))
        return
      }
      if (this.stopped || this.failure)
        return
      end = this.input.indexOf('\n')
    }
    if (this.input.length > MAX_FRAME_CHARS)
      this.fail(new NativeBridgeError('BRIDGE_FRAME_LIMIT', 'Native protocol frame exceeds the bounded transport limit'))
  }

  private drain(): void {
    if (this.draining || !this.handler || this.stopped || this.failure)
      return
    this.draining = true
    try {
      for (const message of this.queue.splice(0)) {
        if (this.stopped || this.failure)
          break
        const result = this.handler(message)
        if (result)
          void Promise.resolve(result).catch(error => this.fail(errorFrom(error)))
      }
    }
    catch (error) {
      this.fail(errorFrom(error))
    }
    finally {
      this.draining = false
    }
  }
}

export class PendingRequests {
  private requests = new Map<string | number, { result: Deferred<unknown>, timer: ReturnType<typeof setTimeout>, removeAbort: () => void }>()

  constructor(private readonly write: (value: unknown) => void) {}

  request(id: string | number, frame: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(abortError(signal))
    const result = deferred<unknown>()
    const finish = (error: Error): void => {
      const pending = this.requests.get(id)
      if (!pending)
        return
      this.requests.delete(id)
      clearTimeout(pending.timer)
      pending.removeAbort()
      result.reject(error)
    }
    const aborted = (): void => finish(abortError(signal!))
    const timer = setTimeout(() => finish(new NativeBridgeError('BRIDGE_REQUEST_TIMEOUT', 'Native control request timed out')), timeoutMs)
    const removeAbort = (): void => signal?.removeEventListener('abort', aborted)
    this.requests.set(id, { result, timer, removeAbort })
    signal?.addEventListener('abort', aborted, { once: true })
    try {
      this.write(frame)
    }
    catch (error) {
      finish(errorFrom(error))
    }
    return result.promise
  }

  settle(id: string | number, value: unknown, error?: Error): void {
    const pending = this.requests.get(id)
    if (!pending)
      return
    this.requests.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbort()
    if (error)
      pending.result.reject(error)
    else
      pending.result.resolve(value)
  }

  failAll(error: Error): void {
    for (const id of this.requests.keys())
      this.settle(id, undefined, error)
  }
}
