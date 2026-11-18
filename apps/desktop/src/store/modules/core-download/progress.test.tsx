// @vitest-environment jsdom
import type { CoreDownloadTask } from './types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { coreDownloadDescription } from './progress'

vi.mock('i18next', () => ({
  default: { t: (key: string, options?: Record<string, unknown>) => `${key}:${options?.version}` },
}))

const task: CoreDownloadTask = {
  tag: 'dsh-0.2.3',
  version: '0.2.3',
  coreId: '',
  status: 'running',
  percentage: 42,
  detail: '已下载 16.0 MB / 38.0 MB',
  error: '',
}

afterEach(() => {
  cleanup()
})

it('把后端的状态行和百分比一起渲染进气泡描述位', () => {
  render(coreDownloadDescription(task))

  expect(screen.getByText('已下载 16.0 MB / 38.0 MB')).toBeTruthy()
  const bar = screen.getByRole('progressbar')
  expect(bar.getAttribute('aria-valuenow')).toBe('42')
  expect(bar.getAttribute('aria-label')).toBe('core.downloading:0.2.3')
})

it('状态行还没到达时只渲染进度条', () => {
  render(coreDownloadDescription({ ...task, detail: '' }))

  expect(screen.queryByText(/已下载/)).toBeNull()
  expect(screen.getByRole('progressbar')).toBeTruthy()
})
