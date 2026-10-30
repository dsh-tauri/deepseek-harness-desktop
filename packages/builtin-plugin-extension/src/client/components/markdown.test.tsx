// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './markdown'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('skips parsing and sanitizing when Markdown text is unchanged', () => {
  const parse = vi.spyOn(marked, 'parse')
  const sanitize = vi.spyOn(DOMPurify, 'sanitize')
  const { container, rerender } = render(<MarkdownPreview text="# Skill" />)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(sanitize).toHaveBeenCalledTimes(1)
  rerender(<MarkdownPreview text="# Skill" />)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(sanitize).toHaveBeenCalledTimes(1)
  rerender(<MarkdownPreview text="**Updated**" />)
  expect(parse).toHaveBeenCalledTimes(2)
  expect(sanitize).toHaveBeenCalledTimes(2)
  expect(container.querySelector('strong')?.textContent).toBe('Updated')
})

it('preserves headings, links, fenced code, tables and task lists', () => {
  const errors = vi.spyOn(console, 'error')
  const { container, getByRole } = render(<MarkdownPreview text={'# Skills\n\n[docs](https://example.com "Documentation")\n\n```ts\nconst x = "<safe>"\n```\n\n| Name | Value |\n| --- | --- |\n| test | 1 |\n\n- [x] Ready\n- [ ] Waiting'} />)
  expect(getByRole('heading', { name: 'Skills' })).toBeTruthy()
  expect(getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com')
  expect(container.querySelector('pre code')?.textContent).toBe('const x = "<safe>"\n')
  expect(container.querySelector('code')?.className).toBe('language-ts')
  expect(container.querySelector('td')?.textContent).toBe('test')
  const boxes = getByRole('list').querySelectorAll('input')
  expect([...boxes].map(box => [box.checked, box.disabled])).toEqual([[true, true], [false, true]])
  expect(errors).not.toHaveBeenCalled()
})

it('removes executable HTML and unsafe links before updating the preview', () => {
  const { container } = render(<MarkdownPreview text={'<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">unsafe</a><svg onload="alert(1)"></svg>'} />)
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img')?.hasAttribute('onerror')).toBe(false)
  expect(container.querySelector('a')?.hasAttribute('href')).toBe(false)
  expect(container.querySelector('svg')?.hasAttribute('onload')).toBe(false)
  expect(container.textContent?.trim()).toBe('unsafe')
})

it('updates repeated content and retains sanitized raw HTML attributes', () => {
  const { container, rerender } = render(<MarkdownPreview text={'<p class="intro" style="text-align: center">First</p>\n\nSame\n\nSame'} />)
  expect(container.querySelector<HTMLElement>('.intro')?.style.textAlign).toBe('center')
  expect(container.querySelectorAll('p')).toHaveLength(3)
  rerender(<MarkdownPreview text="**Updated**" />)
  expect(container.querySelector('strong')?.textContent).toBe('Updated')
  expect(container.textContent?.trim()).toBe('Updated')
})

it('preserves safe inline SVG content allowed by the original Markdown sanitizer', () => {
  const { container } = render(<MarkdownPreview text={'<svg viewBox="0 0 10 10"><path d="M0 0 L10 10"></path></svg>'} />)
  expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 10 10')
  expect(container.querySelector('svg path')?.getAttribute('d')).toBe('M0 0 L10 10')
})

it.each([
  ['details', 'open', '<details open><summary>More</summary>Visible</details>'],
  ['span', 'hidden', '<span hidden>Hidden content</span>'],
  ['select', 'multiple', '<select multiple><option>One</option><option>Two</option></select>'],
  ['textarea', 'readonly', '<textarea readonly>Read only</textarea>'],
  ['video', 'controls', '<video controls></video>'],
  ['video', 'muted', '<video muted></video>'],
  ['video', 'autoplay', '<video autoplay></video>'],
])('preserves the native %s %s attribute in sanitized Markdown', (tag, attribute, text) => {
  const errors = vi.spyOn(console, 'error')
  const { container } = render(<MarkdownPreview text={text} />)
  expect(container.querySelector(tag)?.getAttribute(attribute)).toBe('')
  expect(errors).not.toHaveBeenCalled()
})
