// @vitest-environment jsdom
import type { SegmentedControlProps } from '../../../../builtin-plugin-ui/src/client/components/segmented-control'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPanel } from './extension-panel'

vi.mock('dsh-tauri-ui/client', () => ({
  SegmentedControl: ({ options, value, onChange }: SegmentedControlProps) => (
    <nav data-active={value}>
      {options.map(option => <button key={option.value} type="button" onClick={() => onChange(option.value)}>{option.value}</button>)}
    </nav>
  ),
}))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key } }))
vi.mock('./skills-tab', () => ({
  SkillsTab: () => (
    <section>
      skills-content
      <input aria-label="skill draft" defaultValue="" />
    </section>
  ),
}))
vi.mock('./mcp-tab', () => ({ McpTab: () => <section>mcp-content</section> }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('extension panel composition', () => {
  it('renders the official plugins element as the first selected tab', () => {
    const markup = renderToStaticMarkup(<ExtensionPanel plugins={<section>official-plugins-content</section>} createSkill={async () => {}} />)
    expect(markup).toContain('data-active="plugins"')
    expect(markup).toContain('<button type="button">plugins</button><button type="button">skills</button><button type="button">mcp</button>')
    expect(markup).toContain('official-plugins-content')
    expect(markup).not.toContain('skills-content')
    expect(markup).not.toContain('mcp-content')
  })

  it('renders skills when the official plugins page is unavailable', () => {
    const markup = renderToStaticMarkup(<ExtensionPanel createSkill={async () => {}} />)
    expect(markup).toContain('data-active="skills"')
    expect(markup).toContain('<button type="button">skills</button><button type="button">mcp</button>')
    expect(markup).toContain('skills-content')
    expect(markup).not.toContain('mcp-content')
  })

  it('unmounts official plugins on tab switches while preserving the skill draft', () => {
    const view = render(<ExtensionPanel plugins={<section>official-plugins-content</section>} createSkill={async () => {}} />)
    const plugins = view.getByText('official-plugins-content')
    fireEvent.click(view.getByRole('button', { name: 'skills' }))
    expect(plugins.isConnected).toBe(false)
    const draft = view.getByRole('textbox', { name: 'skill draft' })
    fireEvent.change(draft, { target: { value: 'unsaved skill' } })
    fireEvent.click(view.getByRole('button', { name: 'plugins' }))
    expect(view.getByText('official-plugins-content')).not.toBe(plugins)
    expect(draft.isConnected).toBe(true)
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'skills' }))
    expect(view.getByRole('textbox', { name: 'skill draft' })).toBe(draft)
    expect((draft as HTMLInputElement).value).toBe('unsaved skill')
  })

  it('keeps a fallback skill draft when official plugins disappear and return', () => {
    const createSkill = async () => {}
    const plugins = <section>official-plugins-content</section>
    const view = render(<ExtensionPanel plugins={plugins} createSkill={createSkill} />)
    view.rerender(<ExtensionPanel createSkill={createSkill} />)
    const draft = view.getByRole('textbox', { name: 'skill draft' })
    fireEvent.change(draft, { target: { value: 'unsaved skill' } })
    view.rerender(<ExtensionPanel plugins={plugins} createSkill={createSkill} />)
    expect(view.getByText('official-plugins-content').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    expect(draft.isConnected).toBe(true)
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    view.rerender(<ExtensionPanel createSkill={createSkill} />)
    expect(view.getByRole('textbox', { name: 'skill draft' })).toBe(draft)
    expect((draft as HTMLInputElement).value).toBe('unsaved skill')
  })
})
