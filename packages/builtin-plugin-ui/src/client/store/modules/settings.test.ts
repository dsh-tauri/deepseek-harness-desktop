// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from './settings'

vi.mock('dsh-tauri/client', async () => await import('../../../../../builtin-plugin-tauri/src/client/modules/valtio-define'))

function mountDock(width?: string): void {
  document.body.innerHTML = '<div data-slot="conversation.input.dock"></div>'
  const dock = document.querySelector('[data-slot="conversation.input.dock"]')
  if (width !== undefined && dock instanceof HTMLElement)
    dock.style.setProperty('--dsh-chat-content-width', width)
}

describe('settings 记录会话内容宽度', () => {
  beforeEach(() => {
    settings.close()
    document.body.innerHTML = ''
  })

  it('打开设置前记录会话 dock 上的 --dsh-chat-content-width', () => {
    mountDock('912px')

    settings.openAt('general')

    expect(settings.open).toBe(true)
    expect(settings.chatContentWidth).toBe('912px')
  })

  it('会话 dock 不在时留空，由设置页回退默认宽度', () => {
    settings.openAt()

    expect(settings.chatContentWidth).toBeUndefined()
  })

  it('已打开时再次 openAt 沿用先记录的宽度，不读取塌缩后的值', () => {
    mountDock('860px')
    settings.openAt()
    mountDock('640px')

    settings.openAt('models')

    expect(settings.chatContentWidth).toBe('860px')
  })
})
