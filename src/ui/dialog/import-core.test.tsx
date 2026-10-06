import type { ImportCoreDialogProps } from './import-core'
// @vitest-environment jsdom
import type { CoreImportPlan } from '@/types'
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportCoreDialog } from './import-core'

const PLAN: CoreImportPlan = {
  tag: 'dsh-0.2.0-rc.2-36556493178',
  version: '0.2.0-rc.2',
  commit: '36556493178',
  digest: 'sha256:4c4e78ed01d5280a73d0ba793d7cf86cbb3d73dabc24947a997a81362f20b160',
  size: 139030897,
  verified: true,
}

const PATH = 'D:\\downloads\\deepseek-harness-pkg-windows.zip'

/** 打开对话框，并把 overlastic 的 resolve/reject 结果写进 DOM 供断言 */
function Launcher({ runImport }: { runImport: (path: string) => Promise<CoreImportPlan> }) {
  const [result, setResult] = useState('pending')
  const open = useOverlay<ImportCoreDialogProps, CoreImportPlan>(ImportCoreDialog)
  function handleOpen() {
    open({ path: PATH, runImport })
      .then(plan => setResult(`resolved:${plan.version}`))
      .catch(() => setResult('rejected'))
  }
  return (
    <>
      <button onClick={handleOpen}>Open import</button>
      <span data-testid="result">{result}</span>
    </>
  )
}

function mount(runImport: (path: string) => Promise<CoreImportPlan>) {
  render(<StrictMode><OverlaysProvider><Launcher runImport={runImport} /></OverlaysProvider></StrictMode>)
  fireEvent.click(screen.getByText('Open import'))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('import core dialog (issue #138)', () => {
  it('runs the injected import for the picked path and resolves with the plan', async () => {
    const runImport = vi.fn().mockResolvedValue(PLAN)
    mount(runImport)

    await screen.findByText('core.importing')
    expect(runImport).toHaveBeenCalledExactlyOnceWith(PATH)
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('resolved:0.2.0-rc.2'))
    // 成功即关闭：错误分支的关闭按钮不应出现
    expect(screen.queryByText('core.import_failed')).toBeNull()
  })

  it('shows the raw backend error and keeps a close action when the import fails', async () => {
    const runImport = vi.fn().mockRejectedValue(new Error('CORE_IMPORT_DIGEST_MISMATCH: package does not match'))
    mount(runImport)

    await screen.findByText('core.import_failed')
    expect(screen.getByText('Error: CORE_IMPORT_DIGEST_MISMATCH: package does not match')).toBeTruthy()
    expect(screen.getByText('deepseek-harness-pkg-windows.zip')).toBeTruthy()
    // 失败态必须能关闭，否则用户只能强杀窗口
    const close = screen.getByRole('button', { name: 'core.import_close' })
    fireEvent.click(close)
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('rejected'))
  })
})
