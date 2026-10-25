import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, PhysicalSize } from '@tauri-apps/api/window'
import { PET_BUBBLE_MIN_WIDTH, PET_WINDOW_PAD_X, PET_WINDOW_PAD_Y } from '../constants'

/**
 * 让桌宠窗口跟随宠物真实画布尺寸缩放（设置页大小滑条实时生效）。
 *
 * Rust 只按「预设 16:9 / 图集 208:192」的近似比例创建窗口；真实比例由渲染层决定
 * （Codex 图集的实际格子比例、清单里的 size 都可能不同），所以尺寸的统一出口在这里，
 * 避免两处 set_size 互相打架（issue #308）。加宽窗口只向左扩展透明区，宠物锚定
 * 右下角，屏幕位置保持不变。
 *
 * 尺寸按 **CSS 像素 × `devicePixelRatio`** 换成物理像素下发，而不是交给 `LogicalSize`：
 * `LogicalSize` 用的是 Tauri 的窗口缩放系数，它和页面的 `devicePixelRatio` 并不总是一致。
 * KDE 分数缩放 + XWayland 下 GDK 报 1，WebKitGTK 却按 `Xft.dpi`（144）给出 1.5，
 * 420×280 的窗口里页面只有 280×186 CSS 像素，宠物顶部和头顶气泡被裁掉一截。
 * 两者一致的平台（Windows / macOS / 原生 Wayland）上，换算结果与 `LogicalSize` 相同。
 * 拖拽、穿透命中区、飞行同样按 `devicePixelRatio` 换算，这里与它们保持同一口径。
 *
 * 尺寸/可见性变化即重算（`useWatch` + `immediate` 覆盖挂载首帧），无需卸载清理。
 *
 * @param width 宠物渲染宽度（px）
 * @param aspect 画布比例（高 / 宽）
 * @param visible 窗口当前是否可见；不可见时不折腾几何
 */
export function usePetWindowSize(width: number, aspect: number, visible: boolean): void {
  useWatch([width, aspect, visible], ([nextWidth, nextAspect, nextVisible]) => {
    if (!nextVisible)
      return
    const scale = globalThis.devicePixelRatio || 1
    const windowWidth = Math.max(nextWidth + PET_WINDOW_PAD_X, PET_BUBBLE_MIN_WIDTH)
    const windowHeight = nextWidth * nextAspect + PET_WINDOW_PAD_Y
    void getCurrentWindow()
      .setSize(new PhysicalSize(Math.round(windowWidth * scale), Math.round(windowHeight * scale)))
      .then(() => {
        // 放大后把窗口夹回可见显示器，避免右侧/底部被推出屏幕。
        void invoke<void>('move_pet_window', { deltaX: 0, deltaY: 0 }).catch(() => {})
      })
      .catch((error) => {
        console.warn('[pet] PET_WINDOW_RESIZE_FAILED:', error)
      })
  }, { immediate: true })
}
