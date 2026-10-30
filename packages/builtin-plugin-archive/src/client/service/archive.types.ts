export type Resync = () => Promise<void>

export interface ActionOutcome {
  ok: boolean
  error?: string
}
