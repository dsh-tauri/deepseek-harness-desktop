import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NativeSink } from './types'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'

export type Frame = Record<string, unknown>

export function createSink() {
  return {
    text: vi.fn<NativeSink['text']>(),
    thinking: vi.fn<NativeSink['thinking']>(),
    assistant: vi.fn<NativeSink['assistant']>(),
    toolStart: vi.fn<NativeSink['toolStart']>(),
    toolEnd: vi.fn<NativeSink['toolEnd']>(),
    approval: vi.fn<NativeSink['approval']>().mockResolvedValue(false),
    questions: vi.fn<NativeSink['questions']>().mockResolvedValue({}),
  }
}

export class ProcessFixture extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly frames: Frame[] = []
  private readonly waiters: { matches: (frame: Frame) => boolean, resolve: (frame: Frame) => void }[] = []
  private exited = false
  private readonly input = new EventEmitter()
  readonly stdin = Object.assign(this.input, {
    writable: true,
    write: vi.fn((line: string) => {
      const frame = JSON.parse(line) as Frame
      this.frames.push(frame)
      this.onWrite?.(frame)
      for (const waiter of [...this.waiters]) {
        if (waiter.matches(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(frame)
        }
      }
      return true
    }),
    end: vi.fn(() => this.exit(0)),
    destroy: vi.fn(() => {
      this.stdin.writable = false
    }),
  })

  readonly kill = vi.fn((_signal?: string) => {
    this.exit(0)
    return true
  })

  constructor(private readonly onWrite?: (frame: Frame) => void) {
    super()
  }

  get child(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }

  send(frame: Frame): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  writeChunk(chunk: string): void {
    this.stdout.write(chunk)
  }

  next(matches: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise(resolve => this.waiters.push({ matches, resolve }))
  }

  exit(code: number): void {
    if (this.exited)
      return
    this.exited = true
    this.stdin.writable = false
    this.emit('close', code, null)
  }
}
