import { postSessionResume } from '../apis'

export async function resumeComposer(input: { sessionId: string }): Promise<{ ok: boolean, error?: string }> {
  try {
    await postSessionResume({ sessionId: input.sessionId })
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
