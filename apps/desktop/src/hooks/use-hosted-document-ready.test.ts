// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useHostedDocumentReady } from './use-hosted-document-ready'

function bootCard(lines: readonly string[]): HTMLElement {
  const boot = document.createElement('div')
  boot.setAttribute('data-dsh-boot', '')
  const card = document.createElement('div')
  card.className = 'boot_card'
  for (const line of ['HARNESS', ...lines]) {
    const leaf = document.createElement('div')
    leaf.textContent = line
    card.append(leaf)
  }
  boot.append(card)
  return boot
}

function dshFrame(): HTMLElement {
  const frame = document.createElement('div')
  frame.className = 'layout_frame'
  frame.append(document.createElement('section'))
  return frame
}

beforeEach(() => {
  vi.stubGlobal('__DSH_HOSTED__', true)
  vi.stubGlobal('__DSH_BOOT__', { entries: [] })
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('reports the boot failure card verbatim and keeps the hosted page unready', async () => {
  document.body.append(bootCard(['Failed to load plugins', 'dsh-office-kit', 'web boot: 1 entry did not activate']))
  const onBootFailure = vi.fn()
  const hook = renderHook(() => useHostedDocumentReady(onBootFailure))

  await waitFor(() => expect(onBootFailure).toHaveBeenCalledOnce())
  expect(onBootFailure).toHaveBeenCalledWith('Failed to load plugins\ndsh-office-kit\nweb boot: 1 entry did not activate')
  expect(hook.result.current).toBe(false)
})

it('keeps a mounted DSH frame from marking the document ready while the failure card is shown', async () => {
  document.body.append(dshFrame(), bootCard(['Failed to load plugins', 'dsh-office-kit']))
  const onBootFailure = vi.fn()
  const hook = renderHook(() => useHostedDocumentReady(onBootFailure))

  await waitFor(() => expect(onBootFailure).toHaveBeenCalledOnce())
  expect(hook.result.current).toBe(false)
})

it('reports the failure card once while it stays on screen', async () => {
  const boot = bootCard(['Failed to load plugins', 'dsh-office-kit'])
  document.body.append(boot)
  const onBootFailure = vi.fn()
  renderHook(() => useHostedDocumentReady(onBootFailure))

  await waitFor(() => expect(onBootFailure).toHaveBeenCalledOnce())
  await act(async () => {
    boot.append(document.createElement('div'))
  })
  await act(async () => {
    boot.setAttribute('data-dsh-boot', '')
  })
  expect(onBootFailure).toHaveBeenCalledOnce()
})

it('still reports a failure card whose title and entries were flattened onto one line', async () => {
  document.body.append(bootCard(['Failed to load plugins dsh-office-kit web boot: 1 entry did not activate dsh-office-kit: failed']))
  const onBootFailure = vi.fn()
  const hook = renderHook(() => useHostedDocumentReady(onBootFailure))

  await waitFor(() => expect(onBootFailure).toHaveBeenCalledOnce())
  expect(onBootFailure).toHaveBeenCalledWith('Failed to load plugins dsh-office-kit web boot: 1 entry did not activate dsh-office-kit: failed')
  expect(hook.result.current).toBe(false)
})

it('does not treat the loading card as a failure', async () => {
  document.body.append(bootCard(['Loading plugins…']))
  const onBootFailure = vi.fn()
  const hook = renderHook(() => useHostedDocumentReady(onBootFailure))

  await act(async () => {})
  expect(onBootFailure).not.toHaveBeenCalled()
  expect(hook.result.current).toBe(false)
})

it('becomes ready once a visible populated DSH frame mounts', async () => {
  const hook = renderHook(() => useHostedDocumentReady(vi.fn()))
  expect(hook.result.current).toBe(false)

  await act(async () => {
    document.body.append(dshFrame())
  })
  await waitFor(() => expect(hook.result.current).toBe(true))
})
