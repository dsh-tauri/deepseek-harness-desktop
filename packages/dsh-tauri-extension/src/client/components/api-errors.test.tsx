// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getMcp, getSkills } from '../apis'
import { McpTab } from './mcp-tab'
import { SkillsTab } from './skills-tab'

vi.mock('../apis', () => ({ getMcp: vi.fn(), getSkills: vi.fn() }))
vi.mock('dsh-tauri/client', () => ({ orderBy: () => [], uniq: () => [], compact: () => [] }))
vi.mock('../hooks/use-timers', () => ({ useTimers: () => ({ mounted: { current: true }, later: vi.fn() }) }))
vi.mock('../service/restart', () => ({ restartHost: vi.fn() }))
vi.mock('./markdown', () => ({ MarkdownPreview: () => null }))
vi.mock('./mcp-editor-form', () => ({ McpEditorForm: () => null }))
vi.mock('./mcp-import-dialog', () => ({ McpImportDialog: () => null }))
vi.mock('dsh-tauri-ui/client', () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const Empty = () => null
  return {
    Action: Empty,
    ArrowRotateRight: Empty,
    Button: Content,
    Card: Content,
    Checkbox: Empty,
    Field: Empty,
    GraduationCap: Empty,
    Icon: Empty,
    Input: Empty,
    LogoGithub: Empty,
    Modal: Empty,
    Notice: Content,
    Pill: Empty,
    PlugConnection: Empty,
    SegmentedControl: Empty,
    Select: Empty,
    StateDot: Empty,
    Switch: Empty,
    Tag: Empty,
    Text: Content,
    Textarea: Empty,
    Toast: ({ text }: { text: string }) => <div>{text}</div>,
    TriangleExclamation: Empty,
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows generated skills and MCP error responses instead of treating them as row payloads', async () => {
  vi.mocked(getSkills).mockResolvedValue({ error: 'skills unavailable' })
  vi.mocked(getMcp).mockResolvedValue({ error: 'MCP unavailable' })
  const t = (key: string) => key
  render(
    <>
      <SkillsTab t={t} createSkill={async () => {}} />
      <McpTab t={t} />
    </>,
  )
  expect(await screen.findByText('failed: skills unavailable')).toBeTruthy()
  expect(await screen.findByText('failed: MCP unavailable')).toBeTruthy()
})
