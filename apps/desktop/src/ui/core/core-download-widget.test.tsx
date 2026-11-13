// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enUS from '@/i18n/locales/en-US.json'

const mocks = vi.hoisted(() => {
  const listeners: Array<(event: { payload: Record<string, unknown> }) => void> = []
  return {
    listeners,
    invoke: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
    activate: vi.fn(),
    task: null as null | Record<string, unknown>,
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    mocks.listeners.push(handler)
    return () => {}
  }),
}))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('valtio-define', async importOriginal => ({ ...await importOriginal<typeof import('valtio-define')>(), useStore: (value: unknown) => value }))
vi.mock('@/store/modules/harness', () => ({ harness: { restart: vi.fn() } }))
vi.mock('@/store', () => ({
  store: {
    get coreDownload() {
      return {
        task: mocks.task,
        dismiss: mocks.dismiss,
        retry: mocks.retry,
        activate: mocks.activate,
      }
    },
  },
}))

const { CoreDownloadWidget } = await import('./core-download-widget')

let translations = createInstance()

function renderWidget() {
  return render(
    <I18nextProvider i18n={translations}>
      <CoreDownloadWidget />
    </I18nextProvider>,
  )
}

/** 模拟一次 install-progress 推送 */
function emitProgress(percentage: number, log: string) {
  for (const handler of mocks.listeners)
    handler({ payload: { percentage, log, title: '', detail: '', type: 'download', progress: percentage } })
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.listeners.length = 0
  mocks.task = null
  translations = createInstance()
  await translations.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS } },
    interpolation: { escapeValue: false },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('核心下载浮窗', () => {
  it('没有下载任务时不渲染浮窗', () => {
    renderWidget()
    expect(screen.queryByTestId('dsh-core-download-widget')).toBeNull()
  })

  it('下载中展示标题与进度条百分比', () => {
    mocks.task = { tag: 'dsh-0.2.3', version: '0.2.3', coreId: '', status: 'running', percentage: 42, logs: [], error: '' }
    renderWidget()

    const progress = screen.getByRole('progressbar')
    expect(progress.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByText(enUS['core.downloading'].replace('{{version}}', '0.2.3'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: enUS['core.download_switch'] })).toBeNull()
    expect(screen.queryByRole('button', { name: enUS['app.retry'] })).toBeNull()
  })

  it('展示最近日志行', () => {
    mocks.task = { tag: 'dsh-0.2.3', version: '0.2.3', coreId: '', status: 'running', percentage: 10, logs: ['Download core.asar'], error: '' }
    renderWidget()
    expect(screen.getByText('Download core.asar')).toBeTruthy()
  })

  it('下载成功后出现「切换到此版本」动作', () => {
    mocks.task = { tag: 'dsh-0.2.3', version: '0.2.3', coreId: 'app-dsh-0.2.3', status: 'success', percentage: 100, logs: [], error: '' }
    renderWidget()

    const switchButton = screen.getByRole('button', { name: enUS['core.download_switch'] })
    fireEvent.click(switchButton)
    expect(mocks.activate).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: enUS['app.retry'] })).toBeNull()
  })

  it('失败时展示错误并允许重试', () => {
    mocks.task = { tag: 'dsh-0.2.3', version: '0.2.3', coreId: '', status: 'failed', percentage: 12, logs: [], error: 'CORE_DOWNLOAD_FAILED: network unreachable' }
    renderWidget()

    expect(screen.getByText(enUS['core.download_failed'])).toBeTruthy()
    expect(screen.getByText('CORE_DOWNLOAD_FAILED: network unreachable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: enUS['app.retry'] }))
    expect(mocks.retry).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: enUS['core.download_switch'] })).toBeNull()
  })

  it('成功后关闭浮窗', async () => {
    mocks.task = { tag: 'dsh-0.2.3', version: '0.2.3', coreId: 'app-dsh-0.2.3', status: 'success', percentage: 100, logs: [], error: '' }
    renderWidget()

    fireEvent.click(screen.getByRole('button', { name: enUS['core.download_close'] }))
    expect(mocks.dismiss).toHaveBeenCalledOnce()
  })

  it('下载中不提供关闭入口', () => {
    mocks.task = { tag: 'dsh-0.2.3', version: '0.2.3', coreId: '', status: 'running', percentage: 55, logs: [], error: '' }
    renderWidget()
    expect(screen.queryByRole('button', { name: enUS['core.download_close'] })).toBeNull()
  })
})

describe('核心下载 store 的进度累积', () => {
  it('进度事件只前进不后退，并累积日志', async () => {
    const { coreDownload } = await import('@/store/modules/core-download')
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    void coreDownload.start('dsh-0.2.3', '0.2.3')
    await waitFor(() => expect(mocks.listeners.length).toBe(1))

    emitProgress(40, 'Download core.asar')
    emitProgress(20, 'stale')
    emitProgress(60, 'Extract core')

    expect(coreDownload.task?.percentage).toBe(60)
    expect(coreDownload.task?.logs).toEqual(['Download core.asar', 'Extract core'])
  })
})
