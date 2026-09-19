import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

type PageState = 'empty' | 'splash' | 'chat' | 'normal'

interface BootHarness {
  messages: string[]
  setState: (state: PageState) => void
}

const script = readFileSync(
  new URL('../src-tauri/src/desktop/plugin_boot.js.inc', import.meta.url),
  'utf8',
)

function createHarness(initialState: PageState): BootHarness {
  let state = initialState
  let mutationCallback = () => {}
  const messages: string[] = []

  function textNodes() {
    if (state === 'splash') {
      return [{ textContent: 'HARNESS' }, { textContent: 'Loading plugins…' }]
    }
    if (state === 'chat') {
      return [
        { textContent: 'HARNESS' },
        { textContent: 'Loading plugins…' },
        { textContent: 'A chat message mentioning Loading plugins…' },
      ]
    }
    return []
  }

  const boot = {
    parentElement: null as typeof root | null,
    get textContent() {
      return state === 'splash' ? 'HARNESS Loading plugins…' : ''
    },
    querySelectorAll(selector: string) {
      return selector === 'div, span, p' ? textNodes() : []
    },
  }

  const root = {
    get childElementCount() {
      return state === 'empty' ? 0 : 1
    },
    get textContent() {
      if (state === 'splash')
        return 'HARNESS Loading plugins…'
      if (state === 'chat')
        return 'HARNESS Loading plugins… A chat message mentioning Loading plugins…'
      if (state === 'normal')
        return 'Harness application'
      return ''
    },
    querySelector(selector: string) {
      if (selector === '[data-dsh-boot]' && state === 'splash')
        return boot
      if (state === 'normal' && selector.includes('main'))
        return { textContent: 'Harness application' }
      return null
    },
  }
  boot.parentElement = root

  class FakeMutationObserver {
    constructor(callback: () => void) {
      mutationCallback = callback
    }

    observe() {}

    disconnect() {}
  }

  const top = {}
  const window = {
    top,
    parent: {
      postMessage(message: { type: string }) {
        messages.push(message.type)
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  runInNewContext(script, {
    window,
    document: {
      documentElement: {},
      getElementById: () => root,
    },
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })

  return {
    messages,
    setState(nextState) {
      state = nextState
      mutationCallback()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('plugin boot bridge', () => {
  it('starts the stall deadline when the splash appears late', () => {
    vi.useFakeTimers()
    const harness = createHarness('empty')

    vi.advanceTimersByTime(20_000)
    expect(harness.messages).toEqual([])

    harness.setState('splash')
    vi.advanceTimersByTime(7_999)
    expect(harness.messages).toEqual([])
    vi.advanceTimersByTime(1)
    expect(harness.messages).toEqual(['dsh://plugin-boot:stalled'])
  })

  it('resets the deadline when the splash disappears and rearms on reappearance', () => {
    vi.useFakeTimers()
    const harness = createHarness('splash')

    vi.advanceTimersByTime(4_000)
    harness.setState('empty')
    vi.advanceTimersByTime(10_000)
    expect(harness.messages).toEqual([])

    harness.setState('splash')
    vi.advanceTimersByTime(8_000)
    expect(harness.messages).toEqual(['dsh://plugin-boot:stalled'])
  })

  it('ignores matching page text and permanently disarms after the app shell mounts', () => {
    vi.useFakeTimers()
    const chat = createHarness('chat')
    vi.advanceTimersByTime(20_000)
    expect(chat.messages).toEqual([])

    const harness = createHarness('splash')
    vi.advanceTimersByTime(2_000)
    harness.setState('normal')
    expect(harness.messages).toEqual(['dsh://plugin-boot:ready'])

    harness.setState('splash')
    vi.advanceTimersByTime(20_000)
    expect(harness.messages).toEqual(['dsh://plugin-boot:ready'])
  })
})
