// @vitest-environment jsdom
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopAboutDialog } from './about'

const { desktopUpdater } = vi.hoisted(() => ({
  desktopUpdater: {
    about: {
      version: '0.22.4',
      publishedAt: '2026-10-07T18:09:41Z',
      copyright: 'Copyright test',
      repo: 'https://github.com/dsh-tauri/deepseek-harness-desktop',
      poweredBy: 'DSH Tauri',
    },
    loadAbout: vi.fn(),
  },
}))

vi.mock('@/store', () => ({ store: { desktopUpdater } }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function Launcher() {
  const open = useOverlay(DesktopAboutDialog)
  function handleOpen() {
    void open().catch(() => {})
  }
  return <button onClick={handleOpen}>Open about</button>
}

function openDialog() {
  render(<StrictMode><OverlaysProvider><Launcher /></OverlaysProvider></StrictMode>)
  fireEvent.click(screen.getByText('Open about'))
}

beforeEach(() => {
  desktopUpdater.about.publishedAt = '2026-10-07T18:09:41Z'
  desktopUpdater.loadAbout.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('desktop about native payload', () => {
  it('renders the product name returned by the native command', async () => {
    openDialog()
    expect((await screen.findByText('DSH Tauri')).textContent).toBe('DSH Tauri')
  })

  it('renders the release date returned by the native command', async () => {
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('October 7, 2026')
    openDialog()
    expect((await screen.findByText('October 7, 2026')).textContent).toBe('October 7, 2026')
  })

  it('keeps an unavailable release date as a placeholder', async () => {
    desktopUpdater.about.publishedAt = ''
    openDialog()
    expect((await screen.findByText('-')).textContent).toBe('-')
  })
})
