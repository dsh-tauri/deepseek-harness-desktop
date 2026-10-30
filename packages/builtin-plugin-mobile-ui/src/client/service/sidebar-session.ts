import type { SessionSummary } from 'dsh-tauri/client'

type MobileSessionSummary = Partial<Pick<SessionSummary, 'title' | 'displayTitle' | 'blank' | 'retainedBy'>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function getMobileSessionId(snapshot: unknown): string | undefined {
  if (!isRecord(snapshot) || !isRecord(snapshot.byId))
    return undefined
  const { current, byId } = snapshot
  if (typeof current === 'string' && current.trim() !== '' && Object.hasOwn(byId, current) && isRecord(byId[current]))
    return current
  return Object.keys(byId).find((id) => {
    const summary = byId[id]
    if (id.trim() === '' || !isRecord(summary) || !isRecord(summary.retainedBy))
      return false
    const count = summary.retainedBy.mainView
    return typeof count === 'number' && count > 0
  })
}

export function getMobileSessionTitle(snapshot: unknown): string | undefined {
  const id = getMobileSessionId(snapshot)
  if (id === undefined || !isRecord(snapshot) || !isRecord(snapshot.byId))
    return undefined
  const summary = snapshot.byId[id] as MobileSessionSummary
  if (summary.blank === true)
    return undefined
  const title = typeof summary.title === 'string' ? summary.title.trim() : ''
  if (title !== '')
    return title
  const displayTitle = typeof summary.displayTitle === 'string' ? summary.displayTitle.trim() : ''
  return displayTitle || undefined
}
