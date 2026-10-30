import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFrameStyle, getOverlayMarkedStyle, getSidebarStyle } from './style.utils'

interface LayerSpec {
  backgroundColor: string
  background?: string
  backdropFilter?: string
  animationDuration?: string
  animationTimingFunction?: string
  inset?: string
  position?: string
}

interface ElementSpec {
  own: LayerSpec
  after?: LayerSpec
  detached?: boolean
  inSlot?: boolean
}

function computed(spec: LayerSpec): CSSStyleDeclaration {
  return {
    backgroundColor: spec.backgroundColor,
    background: spec.background ?? spec.backgroundColor,
    backdropFilter: spec.backdropFilter ?? 'none',
    animationDuration: spec.animationDuration ?? '0s',
    animationTimingFunction: spec.animationTimingFunction ?? 'ease',
    inset: spec.inset ?? '0px',
    position: spec.position ?? 'absolute',
  } as unknown as CSSStyleDeclaration
}

function element(spec: ElementSpec): Record<string, unknown> {
  return {
    __spec: spec,
    parentElement: spec.detached === true ? null : { __position: 'fixed' },
    closest: (selector: string) => (selector === '[data-slot]' && spec.inSlot === true ? {} : null),
  }
}

function install(overlays: Record<string, unknown>[], frames: Record<string, unknown>[] = []): void {
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => (selector.includes('_frame') ? frames : overlays),
    querySelector: () => null,
  })
  vi.stubGlobal('getComputedStyle', (target: Record<string, unknown>, pseudo?: string) => {
    if (target.__position !== undefined)
      return computed({ backgroundColor: 'rgba(0, 0, 0, 0)', position: String(target.__position) })
    const spec = target.__spec as ElementSpec
    if (pseudo === '::after')
      return computed(spec.after ?? { backgroundColor: 'rgba(0, 0, 0, 0)', background: 'none' })
    return computed(spec.own)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getOverlayMarkedStyle', () => {
  it('preserves an opaque background painted on the overlay itself', () => {
    install([element({
      own: {
        backgroundColor: 'rgba(0, 0, 0, 0.24)',
        background: 'rgba(0, 0, 0, 0.24) none repeat scroll 0% 0% / auto padding-box border-box',
        backdropFilter: 'blur(2px)',
      },
    })])

    const style = getOverlayMarkedStyle()

    expect(style?.background).toContain('rgba(0, 0, 0, 0.24)')
    expect(style?.backdropFilter).toBe('blur(2px)')
    expect(style?.bottom).toBe('-1px')
    expect(style?.inset).toBe('0px')
    expect(style?.transitionDuration).toBe('0s')
  })

  it('≥0.1.7-rc.2：底色在 ::after，入场动效镜像成同参数过渡', () => {
    install([element({
      own: {
        backgroundColor: 'rgba(0, 0, 0, 0)',
        background: 'rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box',
        backdropFilter: 'blur(2px)',
      },
      after: {
        backgroundColor: 'rgba(0, 0, 0, 0.24)',
        background: 'rgba(0, 0, 0, 0.24) none repeat scroll 0% 0% / auto padding-box border-box',
        animationDuration: '0.2s',
        animationTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    })])

    const style = getOverlayMarkedStyle()

    expect(style?.background).toContain('rgba(0, 0, 0, 0.24)')
    expect(style?.backdropFilter).toBe('blur(2px)')
    expect(style?.transitionProperty).toBe('background, backdrop-filter')
    expect(style?.transitionDuration).toBe('0.2s')
    expect(style?.transitionTimingFunction).toBe('cubic-bezier(0.4, 0, 0.2, 1)')
  })

  it('同时存在多个蒙版时选弹层那个（父级 fixed 且底色可见）', () => {
    install([
      element({ own: { backgroundColor: 'rgba(0, 0, 0, 0)', background: 'none' }, detached: true }),
      element({
        own: { backgroundColor: 'rgba(0, 0, 0, 0)', background: 'none' },
        after: { backgroundColor: 'rgba(0, 0, 0, 0.5)', background: 'rgba(0, 0, 0, 0.5)', animationDuration: '120ms' },
      }),
    ])

    const style = getOverlayMarkedStyle()

    expect(style?.background).toContain('rgba(0, 0, 0, 0.5)')
    expect(style?.transitionDuration).toBe('120ms')
  })

  it('减弱动效（animation: none）时不镜像过渡时长', () => {
    install([element({
      own: { backgroundColor: 'rgba(0, 0, 0, 0)', background: 'none' },
      after: { backgroundColor: 'rgba(0, 0, 0, 0.5)', background: 'rgba(0, 0, 0, 0.5)', animationDuration: '0s' },
    })])

    expect(getOverlayMarkedStyle()?.transitionDuration).toBe('0s')
  })

  it('无蒙版时不产出镜像样式', () => {
    install([])
    expect(getOverlayMarkedStyle()).toBeNull()
  })
})

describe('getFrameStyle', () => {
  it('只认布局帧，跳过组件区域内的同名 frame', () => {
    install([], [
      element({ own: { backgroundColor: '', background: 'rgb(1, 1, 1)' }, inSlot: true }),
      element({ own: { backgroundColor: '', background: 'rgb(9, 9, 9)' } }),
    ])

    expect(getFrameStyle()?.background).toBe('rgb(9, 9, 9)')
  })

  it('只有组件区域内的 frame 时不产出镜像样式', () => {
    install([], [element({ own: { backgroundColor: '', background: 'rgb(1, 1, 1)' }, inSlot: true })])
    expect(getFrameStyle()).toBeNull()
  })
})

describe('getSidebarStyle', () => {
  it('侧栏缺席时返回 null', () => {
    install([])
    expect(getSidebarStyle()).toBeNull()
  })
})
