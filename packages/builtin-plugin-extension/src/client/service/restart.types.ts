export interface DesktopBridge {
  restartSidecar?: () => void
}

declare global {
  interface Window {
    dshDesktop?: DesktopBridge
  }
}
