import type { Translate } from './types'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ModelCompatFields } from './model-compat-fields'

vi.mock('dsh-tauri/client', () => ({
  defineLocale: (_namespace: string, dicts: unknown) => ({
    NS: _namespace,
    text: (key: string) => key,
    dicts,
    activeLocale: () => 'en',
    isEnglishLocale: () => true,
    useLocale: () => 'en',
    registerLocale: () => () => {},
  }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Switch: ({ checked, disabled, label, title }: {
    checked: boolean
    disabled?: boolean
    label: string
    title?: string
  }) => <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title} disabled={disabled} />,
}))

const t: Translate = (key, params) => {
  const dict: Record<string, string> = {
    thinkingMode: 'Thinking mode',
    thinkingLevels: 'Thinking levels',
    thinkingModeHint: 'Declare whether this model thinks',
    developerRole: 'Disable developer role',
    developerRoleHint: 'Turn this on for an endpoint that rejects the developer role',
  }
  const template = dict[key] ?? key
  if (params === undefined)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function markup(model: Record<string, unknown>, templateCompat: boolean, disabled?: boolean): string {
  return renderToStaticMarkup(
    <ModelCompatFields
      t={t}
      model={model}
      index={0}
      templateCompat={templateCompat}
      disabled={disabled}
      onPatch={() => {}}
    />,
  )
}

interface SwitchState {
  checked: boolean
  disabled: boolean
  label: string
  title: string
}

function switches(html: string): SwitchState[] {
  return [...html.matchAll(/<button type="button" role="switch"([^>]*)>/g)].map((match) => {
    const attrs = match[1] ?? ''
    return {
      checked: attrs.includes('aria-checked="true"'),
      disabled: attrs.includes('disabled=""'),
      label: /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? '',
      title: /title="([^"]*)"/.exec(attrs)?.[1] ?? '',
    }
  })
}

function fieldLabels(html: string): string[] {
  return [...html.matchAll(/<span data-slot="model-compat-label"[^>]*>([^<]*)<\/span>/g)].map(match => match[1] ?? '')
}

function chips(html: string): { checked: boolean, disabled: boolean, level: string }[] {
  return [...html.matchAll(/<label data-slot="model-compat-chip"[^>]*><input type="checkbox"([^>]*)>([a-z]+)<\/label>/g)]
    .map(match => ({
      checked: (match[1] ?? '').includes('checked'),
      disabled: (match[1] ?? '').includes('disabled'),
      level: match[2] ?? '',
    }))
}

describe('modelCompatFields', () => {
  it('labels the thinking switch while thinking stays off', () => {
    const html = markup({}, false)
    expect(fieldLabels(html)).toEqual(['Thinking mode'])
    expect(switches(html)).toHaveLength(1)
    expect(switches(html)[0]).toMatchObject({
      label: 'Thinking mode 1',
      title: 'Declare whether this model thinks',
      checked: false,
    })
    expect(html).not.toContain('Thinking levels')
  })

  it('renders the seven level chips once a graded level is declared', () => {
    const html = markup({ reasoningEfforts: { off: null, low: 'low' } }, false)
    expect(switches(html)[0]?.checked).toBe(true)
    expect(fieldLabels(html)).toEqual(['Thinking mode', 'Thinking levels'])
    expect(chips(html).map(chip => chip.level)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(chips(html).filter(chip => chip.checked).map(chip => chip.level)).toEqual(['off', 'low'])
    expect(html).toContain('aria-label="Thinking levels 1"')
  })

  it('gates the developer-role switch on the caller protocol decision', () => {
    const model = { compat: { thinkingFormat: 'chat-template', supportsDeveloperRole: false } }
    expect(switches(markup(model, true)).map(item => item.label)).toEqual(['Thinking mode 1', 'Disable developer role 1'])
    expect(switches(markup(model, true))[1]).toMatchObject({
      title: 'Turn this on for an endpoint that rejects the developer role',
      checked: true,
    })
    expect(markup(model, false)).not.toContain('Disable developer role')
  })

  it('disables every control while the editor is read-only', () => {
    const html = markup({ reasoningEfforts: { low: 'low' } }, true, true)
    expect(switches(html).every(item => item.disabled)).toBe(true)
    expect(chips(html).every(chip => chip.disabled)).toBe(true)
  })
})
