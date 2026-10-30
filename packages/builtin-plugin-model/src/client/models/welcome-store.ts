import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  WELCOME_NOTICE_ACK_FIELD,
  WELCOME_NOTICE_VERSION,
} from '../../shared/onboarding-copy.ts'

export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

export type WelcomeSection = Record<string, unknown>

export interface WelcomeSettingsForm {
  getSnapshot: () => {
    status: 'loading' | 'ready' | 'unavailable'
    value?: WelcomeSection
    mode: 'host' | 'memory'
  }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<boolean>
}

export function decodeWelcomeSection(section: unknown): WelcomeSection {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as WelcomeSection
    : {}
}

function assertNever(_value: never): never {
  throw new Error('unexpected welcome settings status')
}

export class WelcomeNoticeStore {
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore<WelcomeNoticeState>({
    status: 'idle',
    acknowledged: false,
    error: null,
  })

  private localAcknowledged = false
  private saving = false
  private following: (() => void) | undefined

  constructor(private readonly scope: WelcomeSettingsForm) {}

  load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => {
      this.derive()
    })
    this.derive()
    return Promise.resolve()
  }

  async acknowledge(): Promise<boolean> {
    if (this.scope.getSnapshot().mode === 'memory') {
      this.localAcknowledged = true
      this.derive()
      return true
    }
    this.saving = true
    this.store.update((state) => {
      state.status = 'saving'
      state.error = null
    })
    try {
      await this.scope.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION)
    }
    finally {
      this.saving = false
    }
    this.derive()
    const { acknowledged } = this.store.getSnapshot()
    if (!acknowledged) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = 'the acknowledgement did not persist'
      })
    }
    return acknowledged
  }

  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.saving)
      return
    const scope = this.scope.getSnapshot()
    if (scope.mode === 'memory') {
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = this.localAcknowledged
        state.error = null
      })
      return
    }
    switch (scope.status) {
      case 'loading':
        this.store.update((state) => {
          state.status = 'loading'
          state.error = null
        })
        return
      case 'unavailable':
        this.store.update((state) => {
          state.status = 'error'
          state.acknowledged = false
          state.error = 'welcome acknowledgement settings are unavailable'
        })
        return
      case 'ready': {
        const acknowledged = scope.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = acknowledged
          state.error = null
        })
        return
      }

      default: return assertNever(scope.status)
    }
  }
}
