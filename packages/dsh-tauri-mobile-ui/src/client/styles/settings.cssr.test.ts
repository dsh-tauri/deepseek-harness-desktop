import type { Rule } from 'postcss'
import postcss from 'postcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cssr } from '../../../../dsh-tauri-ui/src/client/utils/cssr'
import { MOBILE_MEDIA_QUERIES } from '../../../../dsh-tauri/src/client/utils/device'
import settingsStyle from './settings.cssr'

vi.mock('dsh-tauri/client', () => ({ MOBILE_MEDIA_QUERIES }))
vi.mock('dsh-tauri-ui/client', () => ({ cssr }))

afterEach(() => vi.restoreAllMocks())

describe('mobile settings layout contract', () => {
  const root = postcss.parse(settingsStyle.render())
  const panel = '[data-dsh-mobile-settings][data-dsh-mobile-settings-view]'
  const overlay = `[data-dsh-mobile-settings-overlay]:has(> ${panel})`
  const inlineSidebar = `html[data-dsh-mobile-sidebar] [data-slot="root"] > * > :has(> [data-slot="sidebar"] ${panel})`
  const menu = `${panel}[data-dsh-mobile-settings-view="menu"]`
  const detail = `${panel}[data-dsh-mobile-settings-view="detail"]`
  const rules: Rule[] = []
  root.walkRules((rule) => {
    rules.push(rule)
  })

  function declarations(selector: string): Record<string, string> {
    const matching = rules.filter(rule => rule.selector === selector)
    expect(matching, `Expected one rule for ${selector}`).toHaveLength(1)
    const values: Record<string, string> = {}
    matching[0].walkDecls((decl) => {
      values[decl.prop] = `${decl.value}${decl.important ? ' !important' : ''}`
    })
    return values
  }

  it('activates every override only for owned settings on touch viewports at most 767px', () => {
    expect(root.nodes).toHaveLength(1)
    const media = root.nodes[0]
    expect(media.type).toBe('atrule')
    if (media.type !== 'atrule')
      throw new Error('Missing mobile settings media query')
    expect(media.name).toBe('media')
    expect(media.params).toBe('(hover: none) and (any-pointer: coarse) and (any-hover: none) and (max-width: 767px)')
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.parent).toBe(media)
      for (const selector of rule.selector.split(', ')) {
        if (selector === overlay || selector === inlineSidebar)
          continue
        expect(selector, 'Every selector needs both owned panel and view anchors').toMatch(/^(?:body\[data-ds-dark-theme\] )?\[data-dsh-mobile-settings\]\[data-dsh-mobile-settings-view\]/)
      }
    }
  })

  it('releases only an owned inline settings ancestor from the drawer stacking context', () => {
    expect(declarations(inlineSidebar)).toEqual({ 'z-index': 'auto' })
    expect(declarations(overlay)).not.toHaveProperty('z-index')
  })

  it('fills the viewport with safe-area padding and an opaque theme-aware canvas', () => {
    expect(declarations(overlay)).toMatchObject({
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100dvh',
      padding: '0',
    })
    expect(declarations(panel)).toMatchObject({
      'display': 'flex',
      'flex-direction': 'column',
      'width': '100vw',
      'max-width': 'none',
      'height': '100dvh',
      'max-height': '100dvh',
      'min-width': '0',
      'min-height': '0',
      'border-radius': '0',
      'box-shadow': 'none',
      'padding': 'var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px)) var(--dsh-mobile-safe-area-inset-right, env(safe-area-inset-right, 0px)) var(--dsh-mobile-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) var(--dsh-mobile-safe-area-inset-left, env(safe-area-inset-left, 0px))',
      'color-scheme': 'light',
      'background-color': 'Canvas',
      'background-image': 'linear-gradient(var(--dsw-alias-bg-layer-2, Canvas), var(--dsw-alias-bg-layer-2, Canvas))',
      'overflow': 'hidden',
    })
    expect(declarations(`body[data-ds-dark-theme] ${panel}`)).toEqual({ 'color-scheme': 'dark' })
  })

  it('honors native padded edges while retaining browser safe-area fallbacks', () => {
    expect(declarations(panel).padding).toBe('var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px)) var(--dsh-mobile-safe-area-inset-right, env(safe-area-inset-right, 0px)) var(--dsh-mobile-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) var(--dsh-mobile-safe-area-inset-left, env(safe-area-inset-left, 0px))')
    expect(declarations(`${panel} [data-dsh-mobile-settings-close]`).top).toBe('calc(6px + var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px)))')
    expect(declarations(`${panel} [data-dsh-mobile-settings-controls]`).top).toBe('var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px))')
  })

  it('gives the menu a full-height list with wrapping 52px touch targets', () => {
    expect(declarations(`${panel} [data-dsh-mobile-settings-nav]`)).toMatchObject({
      'display': 'flex',
      'flex-direction': 'column',
      'flex': '1 1 0',
      'width': '100%',
      'min-height': '0',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-title]`)).toMatchObject({
      'display': 'flex',
      'min-height': '52px',
      'padding': '0 52px 0 12px',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-list] > button`)).toMatchObject({
      'width': '100%',
      'min-height': '52px',
      'height': 'auto',
      'font-size': '15px',
      'touch-action': 'manipulation',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-list] > button > span`)).toMatchObject({
      'white-space': 'normal',
      'overflow-wrap': 'anywhere',
    })
    expect(declarations(`${menu} [data-dsh-mobile-settings-content]`)).toEqual({ flex: '0 0 auto' })
    expect(declarations(`${menu} [data-dsh-mobile-settings-header]`)).toMatchObject({
      'min-height': '0',
      'padding': '0 12px 12px',
    })
  })

  it('clips only the native title visually in detail while reserving the back toolbar', () => {
    expect(declarations(`${detail} [data-dsh-mobile-settings-nav]`)).toMatchObject({
      position: 'absolute',
      width: '0',
      height: '0',
      padding: '0',
    })
    const title = declarations(`${detail} [data-dsh-mobile-settings-title]`)
    expect(title).toMatchObject({
      'position': 'absolute',
      'width': '1px',
      'height': '1px',
      'overflow': 'hidden',
      'clip-path': 'inset(50%)',
    })
    expect(title).not.toHaveProperty('display')
    expect(title).not.toHaveProperty('visibility')
    expect(declarations(`${panel} [data-dsh-mobile-settings-content]`)).toMatchObject({
      'flex': '1 1 0',
      'position': 'static',
      'min-height': '0',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-header]`)).toMatchObject({
      'position': 'static',
      'height': 'auto',
      'min-height': '52px',
      'padding': '52px 12px 0',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-actions]`)).toMatchObject({
      'display': 'flex',
      'flex-wrap': 'wrap',
      'position': 'static',
      'width': '100%',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-controls]`)).toMatchObject({
      'position': 'absolute',
      'height': '52px',
      'grid-template-columns': '40px minmax(0, 1fr)',
      'left': 'calc(12px + var(--dsh-mobile-safe-area-inset-left, env(safe-area-inset-left, 0px)))',
      'right': 'calc(64px + var(--dsh-mobile-safe-area-inset-right, env(safe-area-inset-right, 0px)))',
    })
  })

  it('keeps the native close button reachable above both views with visible keyboard focus', () => {
    expect(declarations(`${panel} [data-dsh-mobile-settings-close]`)).toMatchObject({
      'position': 'absolute',
      'top': 'calc(6px + var(--dsh-mobile-safe-area-inset-top, env(safe-area-inset-top, 0px)))',
      'right': 'calc(12px + var(--dsh-mobile-safe-area-inset-right, env(safe-area-inset-right, 0px)))',
      'display': 'flex',
      'width': '40px',
      'height': '40px',
      'min-width': '40px',
      'min-height': '40px',
      'z-index': '2',
      'touch-action': 'manipulation',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-back]`)).toMatchObject({
      'width': '40px',
      'height': '40px',
      'touch-action': 'manipulation',
    })
    expect(declarations(`${panel} [data-dsh-mobile-settings-back]:focus-visible, ${panel} [data-dsh-mobile-settings-close]:focus-visible`)).toEqual({
      'outline': 'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
      'outline-offset': '2px',
    })
    for (const rule of rules.filter(rule => rule.selector.includes('[data-dsh-mobile-settings-view='))) {
      rule.walkDecls((decl) => {
        expect(decl.prop === 'display' && decl.value === 'none', `${rule.selector} must not hide unmanaged nodes`).toBe(false)
      })
    }
  })

  it('lets owned scroll areas fill their flex space despite a bridge inline height pin', () => {
    for (const name of ['list', 'options']) {
      expect(declarations(`${panel} [data-dsh-mobile-settings-${name}]`)).toMatchObject({
        'flex': '1 1 0',
        'height': '0 !important',
        'min-height': '0',
        'min-width': '0',
        'overflow-y': 'auto',
        'overscroll-behavior': 'contain',
      })
    }
    expect(declarations(`${panel} [data-dsh-mobile-settings-options]`)).toMatchObject({
      'overflow-x': 'auto',
      'width': '100%',
    })
    const css = root.toString()
    expect(css).not.toMatch(/\[class|VOzbGW|data-dshbr|visualViewport|\b(?:input|textarea|tabpanel)\b/)
    expect(rules.filter(rule => rule.selector.includes(':has(')).map(rule => rule.selector)).toEqual([inlineSidebar, overlay])
    expect(rules.filter(rule => rule.selector.includes('[data-dsh-mobile-settings-options]'))).toHaveLength(2)
  })

  it('hides only the controller-managed hidden list, options and controls', () => {
    const hidden = rules.filter(rule => rule.nodes.some(node => node.type === 'decl' && node.prop === 'display' && node.value === 'none'))
    expect(hidden).toHaveLength(1)
    expect(hidden[0].selector).toBe(`${panel} [data-dsh-mobile-settings-list][hidden], ${panel} [data-dsh-mobile-settings-options][hidden], ${panel} [data-dsh-mobile-settings-controls][hidden]`)
    expect(declarations(hidden[0].selector)).toEqual({ display: 'none !important' })
  })
})
