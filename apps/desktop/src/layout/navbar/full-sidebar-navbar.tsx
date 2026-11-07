/**
 * 全屏右栏窗口的壳层导航栏。
 *
 * 「右侧栏 → 在新窗口全屏打开」建出的窗口用它（`presentation=full-sidebar`）：没有
 * sidebar-toggle、文件/视图/运行/帮助菜单，也没有远程与本地/远端切换——纯全屏阅读形态下
 * 这些都是噪音。左侧那枚 `LayoutHeader` 只是形态标记，不可聚焦、不可点击。
 * 窗口控制保留：非 macOS 的壳层窗口没有原生标题栏，去掉就关不掉。
 */
import { LayoutHeader } from '@gravity-ui/icons'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useDshStyle } from '@/hooks/use-dsh-style'
import { onDragRegionPointerDown, useMacOSFullscreen } from '@/hooks/use-window-chrome'
import { IS_MACOS } from '@/utils/window-frame'
import { WindowControls } from './window-controls'

export function FullSidebarNavbar() {
  const isFullscreen = useMacOSFullscreen()
  const [dshStyle] = useDshStyle()

  return (
    <div
      className={cn(
        'relative flex h-11 w-full flex-none select-none items-center gap-0.5 bg-panel pointer-events-auto app-region-none',
        {
          'hidden': IS_MACOS && isFullscreen,
          'pl-24 pr-1.5': IS_MACOS && !isFullscreen,
          'px-1.5': !IS_MACOS || isFullscreen,
        },
      )}
      style={{ background: dshStyle.sidebar?.background }}
      data-testid="dsh-full-sidebar-navbar-root"
    >
      <span
        className="pointer-events-none flex size-7 flex-none items-center justify-center text-foreground/40"
        aria-hidden="true"
        data-testid="dsh-full-sidebar-navbar-mark"
      >
        <LayoutHeader />
      </span>

      {/* 拖拽区：与常规导航栏同语义（仅此元素带 data-tauri-drag-region，双击最大化交给 Tauri）。 */}
      <div
        className="min-w-0 flex-1 self-stretch touch-none"
        data-testid="dsh-full-sidebar-navbar-drag-region"
        data-tauri-drag-region
        onPointerDown={onDragRegionPointerDown}
      />

      <If cond={!IS_MACOS}>
        <WindowControls />
      </If>
    </div>
  )
}
