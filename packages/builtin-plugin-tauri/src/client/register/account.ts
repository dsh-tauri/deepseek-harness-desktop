import { invoke } from '../service/tauri'
import { defineRegister } from './index'

interface AccountAttemptView {
  phase?: string
  authorizeUrl?: string
}

interface AccountViewLike {
  status?: string
  attempt?: AccountAttemptView | null
}

interface AccountStreamFrame {
  value?: AccountViewLike
  accept?: () => void
}

interface AccountStreamLike extends AsyncIterable<AccountStreamFrame> {
  dispose?: () => Promise<void> | void
}

interface AccountSessionLike {
  initializeDefaultModel?: () => Promise<unknown>
}

interface AccountRemoteLike {
  account?: {
    watch?: (signal: AbortSignal) => AsyncIterable<AccountViewLike>
  }
  session?: AccountSessionLike
  $stream?: (options: {
    name: string
    open: (signal: AbortSignal) => AsyncIterable<AccountViewLike>
    ended: (accepted: boolean) => Error
  }) => AccountStreamLike
}

interface InjectedScope {
  remote?: AccountRemoteLike
}

export const accountSignInFeature = defineRegister((controller, ctx) => {
  if (!('dshDesktop' in globalThis))
    return

  let opened: string | undefined
  let wasSignedIn = false

  ctx.inject(['remote', 'remote.account', 'remote.session'], (scoped) => {
    const remote = (scoped as unknown as InjectedScope).remote
    const account = remote?.account
    const watch = account?.watch
    if (typeof watch !== 'function' || typeof remote?.$stream !== 'function') {
      console.warn('[dsh-tauri] account stream unavailable — the authorize url cannot be opened automatically')
      return
    }

    const stream = remote.$stream({
      name: 'account',
      open: signal => watch.call(account, signal),
      ended: () => new Error('account stream ended'),
    })
    controller.add(() => {
      void stream.dispose?.()
    })

    void (async () => {
      for await (const frame of stream) {
        const attempt = frame.value?.attempt
        frame.accept?.()
        const url = attempt?.authorizeUrl
        if (attempt?.phase === 'waiting-browser' && isBrowserUrl(url) && url !== opened) {
          opened = url
          await invoke('open_external_url', { url }).catch((error: unknown) => {
            console.warn('[dsh-tauri] opening the account authorize url failed:', error)
          })
        }
        const signedIn = frame.value?.status === 'credential-stored' && attempt?.phase === 'succeeded'
        if (signedIn && !wasSignedIn)
          void initializeDefaultModel(remote)
        wasSignedIn = signedIn
      }
    })().catch(() => undefined)
  })
})

async function initializeDefaultModel(remote: AccountRemoteLike | undefined): Promise<void> {
  let call: AccountSessionLike['initializeDefaultModel']
  try {
    call = remote?.session?.initializeDefaultModel
  }
  catch (error) {
    console.warn('[dsh-tauri] reading the session remote failed:', error)
    return
  }
  if (typeof call !== 'function')
    return
  try {
    await call.call(remote?.session)
  }
  catch (error) {
    console.warn('[dsh-tauri] initializing the account default model failed:', error)
  }
}

function isBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string')
    return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  }
  catch {
    return false
  }
}
