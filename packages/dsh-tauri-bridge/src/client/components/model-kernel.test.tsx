// @vitest-environment jsdom
import type { KernelBinding } from '../../shared/types'
import type { ModelKernelProps } from './slot-contract'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelKernel } from './model-kernel'

function fixture(identity: KernelBinding | null | undefined, locked = false) {
  const select = vi.fn()
  const ensureProjection = vi.fn(async () => {})
  function ModelSelect(props: Record<string, unknown>) {
    return createElement('button', { disabled: props.locked === true, onClick: select }, 'Official model')
  }
  const props = {
    Original: ModelSelect,
    sessionId: 'session-a',
    locked,
    available: true,
    directory: { getSnapshot: () => ({}), subscribe: () => () => {} },
    load: () => {},
    select,
    ensureProjection,
    useProjection: () => useRef(identity).current,
  } as unknown as ModelKernelProps
  return { props, select, ensureProjection }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('verified official model kernel lock', () => {
  it.each(['codex', 'claude'] as const)('the %s identity disables the native-bound model seat without touching its session', (backend) => {
    const feature = fixture({ backend, nativeSessionId: 'native-a', sessionId: 'session-a' })
    const view = render(<ModelKernel {...feature.props} />)
    const trigger = view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(feature.select).not.toHaveBeenCalled()
    expect(view.getByText('This session is bound to a native kernel; its model and kernel cannot be changed')).toBeTruthy()
    expect(feature.ensureProjection).not.toHaveBeenCalled()
  })

  it('deepSeek identity preserves an unlocked official seat without a native hint', () => {
    const feature = fixture(null)
    const view = render(<ModelKernel {...feature.props} />)
    const trigger = view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(false)
    fireEvent.click(trigger)
    expect(feature.select).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-bridge-kernel-model]')).toBeNull()
  })

  it('a locked official composer never becomes unlocked for DeepSeek', () => {
    const feature = fixture(null, true)
    const view = render(<ModelKernel {...feature.props} />)
    expect((view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('unknown identity stays locked and requests only the nonactivating projection read', async () => {
    const feature = fixture(undefined)
    const view = render(<ModelKernel {...feature.props} />)
    expect((view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Reading session kernel')).toBeTruthy()
    await vi.waitFor(() => expect(feature.ensureProjection).toHaveBeenCalledExactlyOnceWith('session-a'))
  })

  it('an unsupported runtime face preserves the original value and does not claim a native lock', () => {
    const feature = fixture({ backend: 'codex', nativeSessionId: 'native-a', sessionId: 'session-a' })
    const props = { ...feature.props, directory: undefined }
    const view = render(<ModelKernel {...props} />)
    const trigger = view.getByRole('button', { name: 'Official model' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(false)
    expect(view.container.querySelector('[data-bridge-kernel-model]')).toBeNull()
    fireEvent.click(trigger)
    expect(feature.select).toHaveBeenCalledOnce()
    expect(feature.ensureProjection).not.toHaveBeenCalled()
  })
})
