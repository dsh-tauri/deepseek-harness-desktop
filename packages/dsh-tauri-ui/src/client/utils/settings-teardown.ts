type Frame = (callback: () => void) => unknown

export function scheduleSettingsTeardown(
  unmount: () => void,
  frame: Frame = callback => requestAnimationFrame(callback),
  cancel: (id: never) => void = id => cancelAnimationFrame(id),
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): () => void {
  let cancelled = false
  let restore: (() => void) | undefined
  const ids: unknown[] = []
  ids.push(frame(() => {
    if (cancelled)
      return
    unmount()
    ids.push(frame(() => {
      if (cancelled)
        return
      restore = forceRepaint(doc, frame, ids)
    }))
  }))
  return () => {
    cancelled = true
    restore?.()
    for (const id of ids)
      cancel(id as never)
  }
}

function forceRepaint(doc: Document | undefined, frame: Frame, ids: unknown[]): (() => void) | undefined {
  const root = doc?.documentElement
  if (!root)
    return undefined
  const previous = root.style.transform
  const restore = (): void => {
    root.style.transform = previous
  }
  root.style.transform = 'translateZ(0)'
  void root.offsetHeight
  ids.push(frame(restore))
  return restore
}
