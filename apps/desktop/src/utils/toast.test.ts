// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from './toast'

vi.mock('@/config/hooks', () => ({ hooks: { 'toast.updated': { trigger: vi.fn() } } }))

const reveal = () => document.body.getAttribute('data-dsh-toast-reveal')

afterEach(() => {
  toast.clear()
  document.body.replaceChildren()
})

it('flags the document only while a reveal toast is alive', () => {
  expect(reveal()).toBeNull()
  const plain = toast('plain')
  expect(reveal()).toBeNull()
  const key = toast('update available', { reveal: true })
  expect(reveal()).toBe('true')
  toast.close(key)
  expect(reveal()).toBeNull()
  toast.close(plain)
})

it('keeps the flag while another reveal toast remains', () => {
  const first = toast('first', { reveal: true })
  const second = toast('second', { reveal: true })
  toast.close(first)
  expect(reveal()).toBe('true')
  toast.close(second)
  expect(reveal()).toBeNull()
})

it('drops the flag on clear', () => {
  toast('update available', { reveal: true })
  expect(reveal()).toBe('true')
  toast.clear()
  expect(reveal()).toBeNull()
})
