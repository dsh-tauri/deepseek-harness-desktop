export function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && typeof window.dshDesktop?.restartSidecar === 'function'
}
