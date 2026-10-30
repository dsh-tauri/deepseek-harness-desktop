import type { ClientContext } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountSignInFeature } from './account'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined),
}))

vi.mock('../service/tauri', () => ({ invoke: mocks.invoke }))

const AUTHORIZE_A = 'https://platform.deepseek.com/dsh/authorize?state=a'
const AUTHORIZE_B = 'https://platform.deepseek.com/dsh/authorize?state=b'

interface AttemptView {
  status?: string
  attempt?: { phase?: string, authorizeUrl?: string } | null
}

function makeRemote(views: AttemptView[], session?: { initializeDefaultModel?: () => Promise<unknown> }) {
  const account = {
    watch: () => (async function* () {
      for (const view of views)
        yield view
    })(),
  }
  return {
    account,
    ...session === undefined ? {} : { session },
    $stream: (options: { open: (signal: AbortSignal) => AsyncIterable<AttemptView> }) => ({
      async* [Symbol.asyncIterator]() {
        for await (const value of options.open(new AbortController().signal))
          yield { value, accept: () => {} }
      },
      dispose: async () => {},
    }),
  }
}

function ctxWithRemote(remote: () => unknown): ClientContext {
  const outer = {
    get remote(): never {
      throw new Error('cannot get property "remote.account" without inject')
    },
    inject: (_deps: string[], callback: (scoped: unknown) => void) => {
      callback({ remote: remote() })
      return () => {}
    },
  }
  return outer as unknown as ClientContext
}

beforeEach(() => {
  vi.stubGlobal('dshDesktop', null)
})

afterEach(() => {
  mocks.invoke.mockClear()
  mocks.invoke.mockImplementation(async () => undefined)
  vi.unstubAllGlobals()
})

describe('accountSignInFeature', () => {
  it('opens each authorize url once through the injected account scope', async () => {
    const ctx = ctxWithRemote(() => makeRemote([
      { attempt: { phase: 'initializing' } },
      { attempt: { phase: 'waiting-browser', authorizeUrl: AUTHORIZE_A } },
      { attempt: { phase: 'waiting-browser', authorizeUrl: AUTHORIZE_A } },
      { attempt: { phase: 'waiting-browser', authorizeUrl: AUTHORIZE_B } },
      { attempt: { phase: 'exchanging', authorizeUrl: AUTHORIZE_B } },
    ]))

    const dispose = accountSignInFeature.call(ctx)

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2))
    expect(mocks.invoke.mock.calls.map(call => call[1])).toEqual([
      { url: AUTHORIZE_A },
      { url: AUTHORIZE_B },
    ])
    expect(mocks.invoke.mock.calls.every(call => call[0] === 'open_external_url')).toBe(true)
    dispose()
  })

  it('reports a failed shell open without throwing', async () => {
    mocks.invoke.mockRejectedValue(new Error('NODE_NOT_ANSWERED: timeout'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = ctxWithRemote(() => makeRemote([
      { attempt: { phase: 'waiting-browser', authorizeUrl: AUTHORIZE_A } },
    ]))

    const dispose = accountSignInFeature.call(ctx)

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(warn.mock.calls[0]?.[0]).toContain('opening the account authorize url failed')
    warn.mockRestore()
    dispose()
  })

  it('ignores authorize urls the host could not open', async () => {
    const ctx = ctxWithRemote(() => makeRemote([
      { attempt: { phase: 'waiting-browser', authorizeUrl: 'javascript:alert(1)' } },
      { attempt: { phase: 'waiting-browser' } },
    ]))

    const dispose = accountSignInFeature.call(ctx)
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.invoke).not.toHaveBeenCalled()
    dispose()
  })

  it('stays inert without the desktop marker', async () => {
    vi.unstubAllGlobals()
    const ctx = ctxWithRemote(() => makeRemote([
      { attempt: { phase: 'waiting-browser', authorizeUrl: AUTHORIZE_A } },
    ]))

    const dispose = accountSignInFeature.call(ctx)
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.invoke).not.toHaveBeenCalled()
    dispose()
  })
})

describe('accountSignInFeature — post sign-in default model', () => {
  const signedIn: AttemptView = { status: 'credential-stored', attempt: { phase: 'succeeded' } }

  it('initializes the default model once on the sign-in edge', async () => {
    const initializeDefaultModel = vi.fn(async () => undefined)
    const ctx = ctxWithRemote(() => makeRemote([
      { status: 'signed-out' },
      { status: 'waiting', attempt: { phase: 'waiting-browser', authorizeUrl: AUTHORIZE_A } },
      signedIn,
      signedIn,
    ], { initializeDefaultModel }))

    const dispose = accountSignInFeature.call(ctx)

    await vi.waitFor(() => expect(initializeDefaultModel).toHaveBeenCalledTimes(1))
    dispose()
  })

  it('re-arms after the account leaves the succeeded state', async () => {
    const initializeDefaultModel = vi.fn(async () => undefined)
    const ctx = ctxWithRemote(() => makeRemote([
      signedIn,
      { status: 'signed-out' },
      signedIn,
    ], { initializeDefaultModel }))

    const dispose = accountSignInFeature.call(ctx)

    await vi.waitFor(() => expect(initializeDefaultModel).toHaveBeenCalledTimes(2))
    dispose()
  })

  it('survives a core whose session remote has no initializeDefaultModel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = ctxWithRemote(() => makeRemote([signedIn], {}))

    const dispose = accountSignInFeature.call(ctx)
    await Promise.resolve()
    await Promise.resolve()

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    dispose()
  })

  it('reports a failed initialization without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = ctxWithRemote(() => makeRemote([signedIn], {
      initializeDefaultModel: async () => {
        throw new Error('session/provider-models-unavailable')
      },
    }))

    const dispose = accountSignInFeature.call(ctx)

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(warn.mock.calls[0]?.[0]).toContain('initializing the account default model failed')
    warn.mockRestore()
    dispose()
  })
})
