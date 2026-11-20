// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { PreinstallPlugin } from '@/store/modules/preinstall'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreinstallSetup } from './preinstall'

const { preinstall, manager } = vi.hoisted(() => ({
  preinstall: {
    plugins: [] as PreinstallPlugin[],
    logs: [] as string[],
    loadError: '',
    isFirstTime: true,
    load: vi.fn(),
    skip: vi.fn(),
    finish: vi.fn(),
    pushLog: vi.fn(),
  },
  manager: {
    processes: [] as unknown[],
    pendingApprovals: [] as unknown[],
    install: vi.fn(),
    uninstall: vi.fn(),
  },
}))

vi.mock('@/store', () => ({ store: { preinstall } }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@reause/core', () => ({ useMount: () => {} }))
vi.mock('@/hooks/use-listen', () => ({ useListen: () => {} }))
vi.mock('@/hooks/use-plugins-manager', () => ({ useDshPluginsManager: () => manager }))
vi.mock('@/utils/clipboard', () => ({ writeClipboardText: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/ellipsis', () => ({ Ellipsis: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('@/components/empty', () => ({ Empty: ({ children, className }: { children: ReactNode, className?: string }) => <div className={className}>{children}</div> }))
vi.mock('@/components/logs', () => ({ Logs: () => null }))
vi.mock('@heroui/react', () => ({
  Button: ({ children, 'aria-label': ariaLabel }: { 'children': ReactNode, 'aria-label'?: string }) => <button type="button" aria-label={ariaLabel}>{children}</button>,
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Checkbox: Object.assign(
    ({ children }: { children: ReactNode }) => <span>{children}</span>,
    { Content: ({ children }: { children: ReactNode }) => <>{children}</>, Control: ({ children }: { children: ReactNode }) => <>{children}</>, Indicator: () => null },
  ),
  Chip: ({ children, color }: { children: ReactNode, color?: string }) => <span data-color={color}>{children}</span>,
  ScrollShadow: ({ children, className, 'data-testid': testId }: { 'children': ReactNode, 'className'?: string, 'data-testid'?: string }) => <div className={className} data-testid={testId}>{children}</div>,
  Spinner: () => null,
  Switch: Object.assign(
    ({ children, isSelected, 'aria-label': ariaLabel }: { 'children'?: ReactNode, 'isSelected'?: boolean, 'aria-label'?: string }) => (
      <button type="button" role="switch" aria-label={ariaLabel} aria-checked={isSelected}>{children}</button>
    ),
    { Content: ({ children }: { children: ReactNode }) => <>{children}</>, Control: ({ children }: { children: ReactNode }) => <>{children}</>, Thumb: () => null },
  ),
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

function plugin(overrides: Partial<PreinstallPlugin> = {}): PreinstallPlugin {
  return {
    id: 'dsh-better-sidebar',
    name: 'DSH Better Sidebar',
    description: '',
    repo_url: '',
    recommended: true,
    fix: false,
    defaultChecked: false,
    defaultUnchecked: false,
    installed: false,
    unsupported: false,
    ...overrides,
  }
}

function chipOf(name: string): Element | null {
  return screen.getByText(name).closest('[data-color]')
}

function classTokensOf(element: Element, keyword: string): string[] {
  return element.className.split(' ').filter(name => name.includes(keyword)).sort()
}

beforeEach(() => {
  preinstall.plugins = []
  preinstall.logs = []
  preinstall.loadError = ''
  preinstall.isFirstTime = true
  manager.processes = []
  manager.pendingApprovals = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('preinstall 推荐卡片的中转标记', () => {
  it('未安装的 dsh-neartoken 并排显示橙色「中转」与绿色「推荐」', () => {
    preinstall.plugins = [plugin({ id: 'dsh-neartoken', name: 'DSH NearToken' })]
    render(<PreinstallSetup />)
    const transfer = chipOf('preinstall.transfer')
    const recommend = chipOf('preinstall.recommend')
    expect(transfer?.getAttribute('data-color'), '中转标记必须用橙色警示色').toBe('warning')
    expect(recommend?.getAttribute('data-color')).toBe('success')
    expect(transfer?.compareDocumentPosition(recommend as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('其余推荐插件只显示绿色「推荐」', () => {
    preinstall.plugins = [plugin()]
    render(<PreinstallSetup />)
    expect(chipOf('preinstall.recommend')?.getAttribute('data-color')).toBe('success')
    expect(screen.queryByText('preinstall.transfer')).toBeNull()
  })

  it('「中转」项默认勾选，与同屏其他推荐项一致', () => {
    preinstall.plugins = [
      plugin({ id: 'dsh-neartoken', name: 'DSH NearToken' }),
      plugin(),
    ]
    render(<PreinstallSetup />)
    expect(screen.getByRole('switch', { name: 'DSH NearToken' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'DSH Better Sidebar' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('preinstall 卡片网格的响应式尺寸', () => {
  it('列数阶梯停在四列：640/1024 逐级加列，1440 起切四列', () => {
    preinstall.plugins = [plugin()]
    render(<PreinstallSetup />)
    const columns = classTokensOf(screen.getByTestId('dsh-setup-preinstall-grid'), 'grid-cols-')
    expect(columns, '网格最多四列，且四列断点为 1440px').toEqual([
      'grid-cols-1',
      'min-[1024px]:grid-cols-3',
      'min-[1440px]:grid-cols-4',
      'min-[640px]:grid-cols-2',
    ])
  })

  it('滚动区高度上限 480px，矮屏按 70vh 收缩', () => {
    preinstall.plugins = [plugin()]
    render(<PreinstallSetup />)
    expect(screen.getByTestId('dsh-setup-preinstall-scroll').className).toContain('max-h-[min(70vh,480px)]')
  })

  it('空态跨列与网格列数同步到四列', () => {
    preinstall.plugins = []
    render(<PreinstallSetup />)
    const spans = classTokensOf(screen.getByText('preinstall.empty'), 'col-span-')
    expect(spans).toEqual([
      'min-[1024px]:col-span-3',
      'min-[1440px]:col-span-4',
      'min-[640px]:col-span-2',
    ])
  })
})
