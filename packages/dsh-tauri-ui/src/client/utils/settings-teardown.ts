type Frame = (callback: () => void) => unknown

export function scheduleSettingsTeardown(
  unmount: () => void,
  frame: Frame = callback => requestAnimationFrame(callback),
  cancel: (id: never) => void = id => cancelAnimationFrame(id),
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): () => void {
  let cancelled = false
  const ids: unknown[] = []
  ids.push(frame(() => {
    if (cancelled)
      return
    unmount()
    ids.push(frame(() => {
      if (cancelled)
        return
      forceRepaint(doc, frame, ids)
    }))
  }))
  return () => {
    cancelled = true
    for (const id of ids)
      cancel(id as never)
  }
}

function forceRepaint(doc: Document | undefined, frame: Frame, ids: unknown[]): void {
  const root = doc?.documentElement
  if (!root)
    return
  root.style.transform = 'translateZ(0)'
  void root.offsetHeight
  ids.push(frame(() => {
    root.style.removeProperty('transform')
  }))
}
