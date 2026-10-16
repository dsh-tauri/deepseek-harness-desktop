// @vitest-environment jsdom
import type { PropsWithOverlays } from '@overlastic/react'
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockIPC } from '@tauri-apps/api/mocks'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileMigrateDialog } from './profile-migrate'

const { install, toast } = vi.hoisted(() => ({
  install: vi.fn(async (refs: string[]) => refs.map(spec => ({ ok: true, spec }))),
  toast: vi.fn(),
}))

vi.mock('@/hooks/use-plugins-manager', () => ({
  useDshPluginsManager: () => ({
    installed: [{ id: '@scope/installed', version: '0.1.0' }],
    install,
  }),
}))
vi.mock('@/utils/toast', () => ({ toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

if (typeof CSS === 'undefined')
  vi.stubGlobal('CSS', { escape: (value: string) => value })

Element.prototype.getAnimations = function () {
  return []
}

function fixtures() {
  return {
    plugins: [
      { id: '@scope/installed', version: '0.1.0', spec: '@scope/installed@0.1.0', verdict: 'compatible' },
      { id: '@scope/fresh', version: '2.1.0', spec: '@scope/fresh@2.0.0', verdict: 'downgrade', targetVersion: '2.0.0' },
    ],
    data: [
      { kind: 'patch', count: 2, covered: false },
      { kind: 'policy', count: 1, covered: false },
      { kind: 'credentials', covered: false },
    ],
  }
}

let analysis: ReturnType<typeof fixtures>
let client: QueryClient
let calls: Record<string, unknown[]>

function TrackedDialog(props: PropsWithOverlays) {
  return <div data-testid="migration-overlay"><ProfileMigrateDialog {...props} /></div>
}

function Launcher() {
  const open = useOverlay(TrackedDialog)
  function handleOpen() {
    void open().catch(() => {})
  }
  return <button onClick={handleOpen}>Open migrate</button>
}

async function openDialog() {
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <OverlaysProvider>
          <Launcher />
        </OverlaysProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
  fireEvent.click(screen.getByText('Open migrate'))
  fireEvent.click(await screen.findByRole('button', { name: /profiles\.migrate_source/ }))
  fireEvent.click(await screen.findByRole('option', { name: 'core-021' }))
  await screen.findByRole('checkbox', { name: '@scope/installed' })
}

async function submit() {
  fireEvent.click(screen.getByText('profiles.migrate_confirm'))
  await waitFor(() => expect(calls.migrate).toBeDefined())
  await waitFor(() => expect(screen.queryByTestId('migration-overlay')).toBeNull())
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  analysis = fixtures()
  calls = {}
  install.mockClear()
  install.mockImplementation(async (refs: string[]) => {
    calls.install = refs
    return refs.map(spec => ({ ok: true, spec }))
  })
  toast.mockReset()
  mockIPC((command, args) => {
    if (command === 'get_cores')
      return [{ id: 'app', source: 'app', version: '0.1.7', tag: 'dsh-0.1.7', active: true }]
    if (command === 'get_profiles') {
      return [
        { id: 'core-021', name: 'core-021' },
        { id: 'core-020', name: 'core-020' },
        { id: 'web', name: 'web', active: true },
      ]
    }
    if (command === 'get_dsh_plugins')
      return []
    if (command === 'analyze_profile_migration') {
      calls.analyze = [args]
      return analysis
    }
    if (command === 'migrate_profile_data') {
      calls.migrate = [args]
      return { applied: (args as { items: string[] }).items, skipped: [], failures: [] }
    }
    throw new Error(`Unexpected command: ${command}`)
  })
})

afterEach(() => {
  cleanup()
  client.clear()
})

describe('profileMigrateDialog', () => {
  it('已装的插件默认不勾选，未装的默认勾选', async () => {
    await openDialog()
    expect((screen.getByRole('checkbox', { name: '@scope/installed' }) as HTMLInputElement).disabled).toBe(true)

    await submit()

    expect(calls.migrate).toEqual([{ sourceId: 'core-021', items: ['patch', 'policy'] }])
    expect(calls.install).toEqual(['@scope/fresh@2.0.0'])
  })

  it('取消勾选未装插件后只迁移档案数据', async () => {
    await openDialog()
    fireEvent.click(screen.getByRole('checkbox', { name: '@scope/fresh' }))
    await submit()

    expect(calls.install).toBeUndefined()
  })

  it('当前档案已完全包含的数据项不可勾选也不参与迁移', async () => {
    analysis.data = [
      { kind: 'patch', count: 2, covered: true },
      { kind: 'policy', count: 1, covered: false },
      { kind: 'credentials', covered: false },
    ]
    await openDialog()
    fireEvent.click(screen.getByText('profiles.migrate_tab_data'))

    expect((await screen.findByRole('checkbox', { name: 'patch' }) as HTMLInputElement).disabled).toBe(true)
    await submit()

    expect(calls.migrate).toEqual([{ sourceId: 'core-021', items: ['policy'] }])
  })

  it('换来源档案后上一个来源的勾选作废', async () => {
    await openDialog()
    fireEvent.click(screen.getByText('profiles.migrate_tab_data'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'credentials' }))

    fireEvent.click(screen.getByRole('button', { name: /core-021/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'core-020' }))
    await screen.findByRole('checkbox', { name: '@scope/installed' })

    await submit()

    // 换源后凭据必须为新来源重新显式勾选，不能被上一个来源的选择带过去
    expect(calls.migrate).toEqual([{ sourceId: 'core-020', items: ['patch', 'policy'] }])
  })

  it('凭据必须显式勾选才会迁移', async () => {
    await openDialog()
    fireEvent.click(screen.getByText('profiles.migrate_tab_data'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'credentials' }))
    await submit()

    expect(calls.migrate).toEqual([{ sourceId: 'core-021', items: ['patch', 'policy', 'credentials'] }])
  })
})
