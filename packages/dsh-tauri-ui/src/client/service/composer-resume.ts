import type { ComposerRefusal } from '../register/composer-resume.types'
import { postSessionResume } from '../apis'

export type ResumeComposerOutcome
  = | { ok: true }
    | { ok: false, error: string, refusal?: ComposerRefusal }

export async function resumeComposer(input: { sessionId: string }): Promise<ResumeComposerOutcome> {
  try {
    await postSessionResume({ sessionId: input.sessionId })
    return { ok: true }
  }
  catch (error) {
    const refusal = readRefusal(error)
    if (refusal !== undefined)
      return { ok: false, refusal, error: refusal.message }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function readRefusal(error: unknown): ComposerRefusal | undefined {
  const data = (error as { data?: unknown } | null)?.data
  const refusal = (data as { refusal?: unknown } | null)?.refusal as Partial<ComposerRefusal> | undefined
  if (typeof refusal?.message !== 'string' || typeof refusal.code !== 'string' || typeof refusal.status !== 'number')
    return undefined
  return { message: refusal.message, code: refusal.code, status: refusal.status }
}
