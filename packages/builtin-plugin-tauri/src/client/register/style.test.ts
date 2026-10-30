// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearEmitted, emittedOf, resetTauriMock } from '../test-utils/tauri-mock'
import { registerStyle } from './style'

vi.mock('../service/tauri', async () => (await import('../test-utils/tauri-mock')).tauriMock)

const disposers: Array<() => void> = []

afterEach(() => {
  resetTauriMock()
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  document.body.removeAttribute('class')
  document.head.querySelectorAll('style, link').forEach(element => element.remove())
  document.documentElement.removeAttribute('style')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  document.body.innerHTML = '<aside data-slot="sidebar"><div style="background:rgb(20, 30, 40)"></div></aside><main></main>'
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const post = () => emittedOf('dsh://style') as Array<Record<string, any>>
  const reads = vi.spyOn(window, 'getComputedStyle')
  const dispose = registerStyle.call({})
  disposers.push(dispose)
  function paint() {
    const batch = [...frames.values()]
    frames.clear()
    batch.forEach(callback => callback(16))
  }
  return { frames, post, reads, paint, dispose }
}

describe('desktop style reporting', () => {
  it('sends the existing sidebar style on the first paint without requiring a DOM mutation', () => {
    const { paint, post } = setup()
    paint()
    expect(post()).toHaveLength(1)
    expect(post()[0]).toMatchObject({ sidebar: { background: 'rgb(20, 30, 40)' }, marked: null, frame: null })
  })

  it('ignores streamed chat mutations before querying or reading styles', async () => {
    const { frames, paint, post, reads } = setup()
    paint()
    clearEmitted()
    reads.mockClear()
    const chat = document.querySelector('main')!
    const queries = vi.spyOn(document, 'querySelectorAll')
    const query = vi.spyOn(document, 'querySelector')
    for (let i = 0; i < 20; i++) {
      chat.innerHTML = `<div class="chunk-${i}">Stream chunk ${i}</div>`
      chat.firstElementChild!.setAttribute('style', 'color:red')
      await Promise.resolve()
    }
    expect(frames.size).toBe(0)
    paint()
    expect(reads).not.toHaveBeenCalled()
    expect(queries).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(post()).toEqual([])
  })

  it('reports a changed sidebar background once on the next paint', async () => {
    const { paint, post } = setup()
    paint()
    clearEmitted()
    document.querySelector<HTMLElement>('[data-slot="sidebar"] > div')!.style.background = 'rgb(50, 60, 70)'
    await Promise.resolve()
    paint()
    expect(post()).toHaveLength(1)
    expect(post()[0].sidebar).toEqual({ background: 'rgb(50, 60, 70)' })
  })

  it('coalesces relevant mutations and suppresses unchanged messages', async () => {
    const { paint, frames, reads, post } = setup()
    paint()
    reads.mockClear()
    clearEmitted()
    for (let i = 0; i < 20; i++) {
      document.body.className = `theme-${i}`
      await Promise.resolve()
    }
    expect(frames.size).toBe(1)
    expect(reads).not.toHaveBeenCalled()
    paint()
    expect(reads).toHaveBeenCalledOnce()
    expect(post()).toEqual([])
  })

  it.each(['insert', 'remove', 'replace', 'ancestor', 'class', 'slot'] as const)('refreshes sidebar inputs after %s mutations', async (change) => {
    const { paint, post } = setup()
    const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"]')!
    const wrapper = document.createElement('section')
    sidebar.replaceWith(wrapper)
    wrapper.append(sidebar)
    await Promise.resolve()
    paint()
    clearEmitted()
    if (change === 'insert') {
      sidebar.remove()
      await Promise.resolve()
      paint()
      clearEmitted()
      wrapper.append(sidebar)
    }
    else if (change === 'remove') {
      wrapper.remove()
    }
    else if (change === 'replace') {
      sidebar.innerHTML = '<div style="background:rgb(50, 60, 70)"></div>'
    }
    else if (change === 'ancestor') {
      wrapper.style.background = 'rgb(50, 60, 70)'
    }
    else if (change === 'class') {
      wrapper.className = 'dark'
    }
    else {
      sidebar.removeAttribute('data-slot')
    }
    const reads = vi.spyOn(window, 'getComputedStyle').mockClear()
    await Promise.resolve()
    paint()
    if (change === 'remove' || change === 'slot')
      expect(post()[0].sidebar).toBeNull()
    else
      expect(reads).toHaveBeenCalled()
    if (change === 'insert')
      expect(post()[0].sidebar).toEqual({ background: 'rgb(20, 30, 40)' })
    if (change === 'replace')
      expect(post()[0].sidebar).toEqual({ background: 'rgb(50, 60, 70)' })
  })

  it('detects frame class entry and exit without relying on current selector matches', async () => {
    const { paint, post } = setup()
    paint()
    const frame = document.createElement('div')
    frame.style.background = 'rgb(50, 60, 70)'
    document.querySelector('main')!.append(frame)
    await Promise.resolve()
    paint()
    clearEmitted()
    frame.className = 'layout_frame'
    await Promise.resolve()
    paint()
    expect(post()[0].frame).toEqual({ background: 'rgb(50, 60, 70)' })
    clearEmitted()
    frame.className = ''
    await Promise.resolve()
    paint()
    expect(post()[0].frame).toBeNull()
  })

  it('reports nested overlay insertion, parent changes and removal', async () => {
    const computedStyle = window.getComputedStyle.bind(window)
    const { paint, post, reads } = setup()
    reads.mockImplementation(element => computedStyle(element))
    paint()
    clearEmitted()
    const portal = document.createElement('div')
    portal.style.position = 'fixed'
    portal.innerHTML = '<div class="_mask_modal" style="background:rgba(0, 0, 0, 0.5)"></div>'
    document.body.append(portal)
    await Promise.resolve()
    paint()
    expect(post()[0].marked.background).toContain('rgba(0, 0, 0, 0.5)')
    reads.mockClear()
    portal.style.position = 'absolute'
    await Promise.resolve()
    paint()
    expect(reads).toHaveBeenCalled()
    clearEmitted()
    portal.remove()
    await Promise.resolve()
    paint()
    expect(post()[0].marked).toBeNull()
  })

  it('refreshes styles for stylesheet changes and window resizing', async () => {
    const { paint, frames, reads } = setup()
    paint()
    reads.mockClear()
    const stylesheet = document.createElement('style')
    stylesheet.textContent = 'body { color:red }'
    document.head.append(stylesheet)
    await Promise.resolve()
    expect(frames.size).toBe(1)
    paint()
    expect(reads).toHaveBeenCalledOnce()
    reads.mockClear()
    stylesheet.firstChild!.nodeValue = 'body { color:blue }'
    await Promise.resolve()
    paint()
    expect(reads).toHaveBeenCalledOnce()
    reads.mockClear()
    window.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)
    paint()
    expect(reads).toHaveBeenCalledOnce()
    stylesheet.remove()
  })

  it('refreshes tokenized stylesheet links on href changes and load completion', async () => {
    const { paint, frames, reads, dispose } = setup()
    paint()
    const link = document.createElement('link')
    link.rel = 'next StyleSheet'
    document.head.append(link)
    await Promise.resolve()
    paint()
    reads.mockClear()
    link.href = '/theme.css'
    await Promise.resolve()
    expect(frames.size).toBe(1)
    paint()
    expect(reads).toHaveBeenCalledOnce()
    reads.mockClear()
    link.dispatchEvent(new Event('load'))
    expect(frames.size).toBe(1)
    paint()
    expect(reads).toHaveBeenCalledOnce()
    dispose()
    link.dispatchEvent(new Event('load'))
    expect(frames.size).toBe(0)
  })

  it('reports a root color-scheme change even when the chat body stays unchanged', async () => {
    const { paint, post } = setup()
    paint()
    clearEmitted()
    document.documentElement.style.colorScheme = 'dark'
    await Promise.resolve()
    paint()
    expect(post()).toHaveLength(1)
    expect(post()[0].colorScheme).toBe('dark')
  })

  it('cancels queued reads and stops observing after the plugin unloads', async () => {
    const { frames, paint, post, reads, dispose } = setup()
    document.querySelector('main')!.textContent = 'Pending stream update'
    await Promise.resolve()
    dispose()
    expect(frames.size).toBe(0)
    paint()
    document.querySelector('main')!.textContent = 'Update after unload'
    window.dispatchEvent(new Event('resize'))
    await Promise.resolve()
    paint()
    expect(reads).not.toHaveBeenCalled()
    expect(post()).toEqual([])
  })
})
