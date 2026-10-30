// @vitest-environment jsdom
import type { ClientContext, LocaleService } from 'dsh-tauri/client'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPanel } from '../components/extension-panel'
import { PANEL_ID } from '../constants'
import { locale } from '../locales'
import { extensionPanelFeature } from './extension-panel'

vi.mock('dsh-tauri-ui/client', async () => {
  const { cssr } = await import('../../../../builtin-plugin-ui/src/client/utils/cssr')
  const { mountStyle } = await import('../../../../builtin-plugin-ui/src/client/utils/style')
  const { SegmentedControl } = await import('../../../../builtin-plugin-ui/src/client/components/segmented-control')
  return { cssr, mountStyle, SegmentedControl, SlotOutlet: () => null }
})
vi.mock('../components/skills-tab', () => ({ SkillsTab: () => <section>Skills</section> }))
vi.mock('../components/mcp-tab', () => ({ McpTab: () => <section>MCP</section> }))

const disposers: Array<() => void> = []
const styleSelector = `style[cssr-id="${PANEL_ID}-plugins"]`

function runtime(active = 'zh') {
  const dictionaries = new Map<string, Record<string, string>>()
  const listeners = new Set<() => void>()
  const service = {
    register(namespace: string, language: string, dictionary: Record<string, string>) {
      const key = `${namespace}:${language}`
      dictionaries.set(key, dictionary)
      return () => {
        dictionaries.delete(key)
      }
    },
    bind: (namespace: string) => (key: string) => dictionaries.get(`${namespace}:${active}`)?.[key] ?? key,
    getLocale: () => ({ active }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as unknown as LocaleService
  return {
    service,
    listeners,
    change(language: string) {
      active = language
      for (const listener of listeners)
        listener()
    },
  }
}

function install(active = 'zh') {
  const host = runtime(active)
  const slots = {
    entriesOfSlot: () => [],
    subscribe: () => () => {},
    inject: (_slot: string, register: () => () => void) => register(),
    register: () => () => {},
  }
  const ctx = { locale: host.service, slots, inject: () => {} } as unknown as ClientContext
  const unregister = locale.registerLocale({ locale: host.service })
  const release = extensionPanelFeature.call(ctx)
  const dispose = (): void => {
    release()
    unregister()
  }
  disposers.push(dispose)
  return { dispose, host }
}

function element<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null)
    throw new Error(`Missing fixture element: ${selector}`)
  return found
}

function Plugins({ floor = false, initial = 'list', backLabel = '返回插件', title = '实验性插件' }: { floor?: boolean, initial?: 'list' | 'more', backLabel?: string, title?: string }) {
  const [view, setView] = useState<'list' | 'more' | 'detail'>(initial)
  return (
    <div data-dsh-extension-plugins>
      <span data-dsh-plugins-icon aria-hidden="true"><svg width="16" height="16" /></span>
      <section data-plugin-panel>
        {view === 'list' && (
          <header className="upstream-main" {...floor ? {} : { 'data-window-drag': '' }}>
            <div>
              <h1 className="upstream-title">官方插件</h1>
              {floor
                ? <p className="upstream-intro">插件简介</p>
                : (
                    <div className="upstream-intro">
                      <span>插件简介</span>
                      <button type="button" aria-label="插件信息" />
                    </div>
                  )}
            </div>
            <div><button type="button">刷新插件</button></div>
          </header>
        )}
        {view === 'more' && (
          <header className="upstream-more" data-window-drag>
            <button type="button" className="upstream-back" aria-label={backLabel} onClick={() => setView('list')}><svg width="20" height="20" aria-hidden="true" /></button>
            <h1 className="upstream-title">{title}</h1>
          </header>
        )}
        {view === 'list' && (
          <div className="upstream-tabs">
            <div role="tablist" aria-label="插件分组" />
          </div>
        )}
        {view === 'list' && (
          <section data-plugin-group={floor ? 'official' : 'extensions'}>
            <h3>实验性插件</h3>
            {!floor && <button type="button" onClick={() => setView('more')}>更多</button>}
            <button type="button" onClick={() => setView('detail')}>打开配置</button>
          </section>
        )}
        {view === 'more' && <div><section data-plugin-group="more"><ul><li>插件</li></ul></section></div>}
        {view === 'detail' && (
          <div data-plugin-item-detail="shell">
            {floor
              ? (
                  <>
                    <button type="button" aria-label="返回插件" onClick={() => setView('list')}>插件</button>
                    <div>配置图标与操作</div>
                  </>
                )
              : (
                  <div data-window-drag>
                    <button type="button" aria-label="返回插件" onClick={() => setView('list')}>插件</button>
                    <div>配置图标与操作</div>
                  </div>
                )}
            <section data-plugin-config><div data-window-drag>插件自己的内容</div></section>
          </div>
        )}
      </section>
    </div>
  )
}

function renderPanel(plugins = <Plugins />) {
  return render(<ExtensionPanel plugins={plugins} createSkill={async () => {}} />)
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

let upstreamStyle: HTMLStyleElement
beforeEach(() => {
  upstreamStyle = document.createElement('style')
  upstreamStyle.textContent = '.upstream-main { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:16px; padding-top:28px } .upstream-title { margin:0; font-size:20px; line-height:28px; font-weight:500 } .upstream-intro { margin:4px 0 0; font-size:13px; line-height:20px } .upstream-more { align-items:center; gap:8px } .upstream-back { width:28px; padding:0 } .upstream-tabs { display:flex; margin-top:-16px }'
  document.head.append(upstreamStyle)
})

afterEach(() => {
  for (const dispose of disposers.splice(0))
    dispose()
  cleanup()
  upstreamStyle.remove()
  vi.restoreAllMocks()
})

describe('embedded official plugin headers', () => {
  it('keeps one native back action and the selected extension tabs through More and back', async () => {
    install()
    const view = renderPanel()
    const tabs = view.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['插件', '技能', 'MCP'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    const mainTitle = view.getByRole('heading', { name: '官方插件', level: 1 })
    expect(getComputedStyle(mainTitle).paddingLeft).toBe('32px')
    expect(getComputedStyle(element(view.container, '[data-dsh-plugins-icon]')).display).toBe('inline-flex')

    fireEvent.click(view.getByRole('button', { name: '更多' }))
    await waitFor(() => expect(view.getAllByRole('button', { name: '回退' })).toHaveLength(1))
    const back = view.getByRole('button', { name: '回退' })
    const moreTitle = view.getByRole('heading', { name: '实验性插件', level: 1 })
    expect(back.hasAttribute('data-dsh-plugins-back')).toBe(true)
    expect(back.textContent).toBe('回退')
    expect(back.querySelectorAll('svg')).toHaveLength(1)
    expect(getComputedStyle(back).width).toBe('auto')
    expect(getComputedStyle(moreTitle).paddingLeft).toBe('0px')
    expect(getComputedStyle(element(view.container, '[data-plugin-panel] > header')).display).toBe('flex')
    expect(getComputedStyle(element(view.container, '[data-plugin-panel] > header')).gap).toBe('10px')
    expect(getComputedStyle(element(view.container, '[data-dsh-plugins-icon]')).display).toBe('none')
    expect(view.getAllByRole('tab')).toEqual(tabs)

    fireEvent.click(back)
    await waitFor(() => expect(back.hasAttribute('data-dsh-plugins-back')).toBe(false))
    expect(back.getAttribute('aria-label')).toBe('返回插件')
    expect(back.querySelector('span')).toBeNull()
    expect(view.getByRole('heading', { name: '官方插件', level: 1 })).toBeTruthy()
    expect(view.queryByRole('button', { name: '回退' })).toBeNull()
    expect(view.getAllByRole('tab')).toEqual(tabs)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('drops the official tab strip negative margin so the header keeps its spacing', async () => {
    install()
    const view = renderPanel()
    const strip = element<HTMLElement>(view.container, '[data-plugin-panel] > div:has(> [role="tablist"])')
    expect(getComputedStyle(strip).marginTop).toBe('0px')
  })

  it('preserves the floor header without drag attributes, its paragraph intro and native configuration navigation', async () => {
    install()
    const view = renderPanel(<Plugins floor />)
    const header = element<HTMLElement>(view.container, '[data-plugin-panel] > header')
    const intro = element<HTMLElement>(header, 'p')
    expect(header.hasAttribute('data-window-drag')).toBe(false)
    expect(getComputedStyle(header).paddingTop).toBe('0px')
    expect(getComputedStyle(header).gap).toBe('14px 10px')
    expect(getComputedStyle(intro).fontSize).toBe('12px')
    expect(getComputedStyle(intro).lineHeight).toBe('18px')
    expect(getComputedStyle(intro).order).toBe('2')
    expect(view.queryByRole('button', { name: '更多' })).toBeNull()
    expect(view.container.querySelector('[data-dsh-plugins-back]')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: '打开配置' }))
    await settle()
    const crumb = view.getByRole('button', { name: '返回插件' })
    expect(crumb.textContent).toBe('插件')
    expect(crumb.hasAttribute('data-dsh-plugins-back')).toBe(false)
    expect(getComputedStyle(element(view.container, '[data-dsh-plugins-icon]')).display).toBe('none')
    expect(getComputedStyle(crumb).marginTop).toBe('12px')
    expect(getComputedStyle(element(view.container, '[data-plugin-config] > div')).paddingTop).not.toBe('12px')
    fireEvent.click(crumb)
    expect(view.getByRole('heading', { name: '官方插件', level: 1 })).toBeTruthy()
  })

  it('keeps the rc.1 detail navigation and limits its spacing to the official drag header', async () => {
    install()
    const view = renderPanel()
    fireEvent.click(view.getByRole('button', { name: '打开配置' }))
    await settle()
    const crumb = view.getByRole('button', { name: '返回插件' })
    expect(crumb.hasAttribute('data-dsh-plugins-back')).toBe(false)
    expect(getComputedStyle(element(view.container, '[data-plugin-item-detail] > div[data-window-drag]')).paddingTop).toBe('12px')
    expect(getComputedStyle(element(view.container, '[data-plugin-config] > div')).paddingTop).not.toBe('12px')
    expect(getComputedStyle(element(view.container, '[data-dsh-plugins-icon]')).display).toBe('none')
    fireEvent.click(crumb)
    expect(view.getByRole('heading', { name: '官方插件', level: 1 })).toBeTruthy()
    expect(view.getByRole('tab', { name: '插件' }).getAttribute('aria-selected')).toBe('true')
  })

  it('restores an absent native aria label and the exact original child nodes on dispose', async () => {
    const view = render(<Plugins initial="more" />)
    const back = element<HTMLButtonElement>(view.container, '[data-plugin-panel] > header > button')
    back.removeAttribute('aria-label')
    const children = [...back.childNodes]
    const { dispose } = install()
    await waitFor(() => expect(view.getByRole('button', { name: '回退' })).toBe(back))
    expect(back.firstChild).toBe(children[0])
    expect(back.querySelectorAll('span')).toHaveLength(1)
    dispose()
    await settle()
    expect(back.hasAttribute('aria-label')).toBe(false)
    expect([...back.childNodes]).toEqual(children)
    expect(back.firstChild).toBe(children[0])
    expect(back.hasAttribute('data-dsh-plugins-back')).toBe(false)
    expect(document.querySelector(styleSelector)).toBeNull()
    fireEvent.click(back)
    expect(view.getByRole('heading', { name: '官方插件', level: 1 })).toBeTruthy()
  })

  it('localizes the visible native button, repairs an upstream rerender and restores the newest upstream label', async () => {
    const { dispose, host } = install()
    const view = render(<Plugins initial="more" title="Unrelated title" />)
    await waitFor(() => expect(view.getByRole('button', { name: '回退' })).toBeTruthy())
    const back = view.getByRole('button', { name: '回退' })
    view.rerender(<Plugins initial="more" title="Unrelated title" backLabel="Back to plugins" />)
    host.change('en')
    await waitFor(() => expect(view.getAllByRole('button', { name: 'Back' })).toHaveLength(1))
    expect(view.getByRole('button', { name: 'Back' })).toBe(back)
    expect(back.textContent).toBe('Back')
    element(back, 'span').remove()
    await waitFor(() => expect(back.querySelectorAll('span')).toHaveLength(1))
    expect(host.listeners.size).toBe(2)

    dispose()
    dispose()
    expect(back.getAttribute('aria-label')).toBe('Back to plugins')
    expect(back.textContent).toBe('')
    expect(back.hasAttribute('data-dsh-plugins-back')).toBe(false)
    expect(back.querySelector('svg')).not.toBeNull()
    expect(host.listeners.size).toBe(0)
    expect(document.querySelector(styleSelector)).toBeNull()
    fireEvent.click(back)
    expect(view.getByRole('heading', { name: '官方插件', level: 1 })).toBeTruthy()
  })

  it('cleans detached buttons on tab switches and patches the next mount once', async () => {
    install()
    const view = renderPanel()
    fireEvent.click(view.getByRole('button', { name: '更多' }))
    await waitFor(() => expect(view.getByRole('button', { name: '回退' })).toBeTruthy())
    const back = view.getByRole('button', { name: '回退' })
    fireEvent.click(view.getByRole('tab', { name: '技能' }))
    await waitFor(() => expect(back.querySelector('span')).toBeNull())
    expect(back.isConnected).toBe(false)
    expect(back.getAttribute('aria-label')).toBe('返回插件')
    expect(back.hasAttribute('data-dsh-plugins-back')).toBe(false)
    fireEvent.click(view.getByRole('tab', { name: '插件' }))
    fireEvent.click(view.getByRole('button', { name: '更多' }))
    await waitFor(() => expect(view.getAllByRole('button', { name: '回退' })).toHaveLength(1))
    expect(view.getByRole('button', { name: '回退' })).not.toBe(back)
    expect(view.getByRole('button', { name: '回退' }).querySelectorAll('span')).toHaveLength(1)
  })

  it('does not infer a subpage from text or touch plugin content and other panels', async () => {
    install()
    const view = render(
      <>
        <section data-plugin-panel>
          <header>
            <button type="button" aria-label="Outside">回退</button>
            <h1>实验性插件</h1>
          </header>
        </section>
        <div data-dsh-extension-plugins>
          <section data-plugin-panel>
            <header>
              <div>
                <h1>实验性插件</h1>
                <p>更多</p>
              </div>
              <div><button type="button" aria-label="Toolbar">回退</button></div>
            </header>
            <section data-plugin-config>
              <header>
                <button type="button" aria-label="Plugin content">回退</button>
                <h1>实验性插件</h1>
              </header>
            </section>
          </section>
        </div>
      </>,
    )
    await settle()
    expect(view.container.querySelector('[data-dsh-plugins-back]')).toBeNull()
    expect(view.getByRole('button', { name: 'Outside' }).textContent).toBe('回退')
    expect(view.getByRole('button', { name: 'Toolbar' }).textContent).toBe('回退')
    expect(view.getByRole('button', { name: 'Plugin content' }).textContent).toBe('回退')
  })

  it('survives five dispose and HMR-style remount cycles without duplicate labels, styles or residual observers', async () => {
    const view = render(<Plugins initial="more" />)
    const back = element<HTMLButtonElement>(view.container, '[data-plugin-panel] > header > button')
    for (let pass = 0; pass < 5; pass++) {
      const { dispose, host } = install()
      await waitFor(() => expect(view.getAllByRole('button', { name: '回退' })).toHaveLength(1))
      view.container.append(document.createElement('div'))
      await settle()
      expect(back.querySelectorAll('span')).toHaveLength(1)
      expect(document.querySelectorAll(styleSelector)).toHaveLength(1)
      expect(document.querySelector(styleSelector)?.getAttribute('data-plugin')).toBe(PANEL_ID)
      dispose()
      expect(back.getAttribute('aria-label')).toBe('返回插件')
      expect(back.hasAttribute('data-dsh-plugins-back')).toBe(false)
      expect(back.querySelector('span')).toBeNull()
      expect(document.querySelector(styleSelector)).toBeNull()
      expect(host.listeners.size).toBe(0)
      view.container.append(document.createElement('div'))
      await settle()
      expect(back.textContent).toBe('')
      expect(back.hasAttribute('data-dsh-plugins-back')).toBe(false)
    }
  })
})
