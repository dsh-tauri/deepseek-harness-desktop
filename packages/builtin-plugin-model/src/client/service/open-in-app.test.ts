import type { ServiceLookup } from '../models/remote.ts'
import { ofetch } from 'dsh-tauri/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { postConfigOpen } from '../apis'
import { configureOpenInApp, listConfigApplications, openConfigInApp } from './open-in-app'

vi.mock('../apis', () => ({
  postConfigOpen: vi.fn(),
  getEndpointModels: vi.fn(),
  getPresets: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({
  ofetch: vi.fn(),
}))

interface SessionStub {
  modelCatalog?: () => Promise<unknown>
  canOpenWorkspacePath?: () => Promise<unknown>
  openWorkspacePath?: (request: unknown) => Promise<unknown>
  workspacePathApplications?: (request: unknown) => Promise<unknown>
}

function withSession(session: SessionStub): void {
  const lookup: ServiceLookup = { get: name => name === 'remote' ? { session } : undefined }
  configureOpenInApp(lookup)
}

function desktopSession(overrides: SessionStub = {}): SessionStub {
  return {
    openWorkspacePath: async () => ({ ok: true, value: {} }),
    ...overrides,
  }
}

const postConfigOpenMock = vi.mocked(postConfigOpen)
const ofetchMock = vi.mocked(ofetch)

beforeEach(() => {
  vi.clearAllMocks()
  postConfigOpenMock.mockResolvedValue({ ok: true, path: '/home/u/.dsh/settings.yaml' } as never)
})

describe('官方 open-in-app 接入', () => {
  it('低版本核心缺打开方法时不列表，也不发起任何请求', async () => {
    withSession({ modelCatalog: async () => ({ ok: true, value: {} }) })

    await expect(listConfigApplications()).resolves.toEqual([])
    expect(postConfigOpenMock).not.toHaveBeenCalled()
    expect(ofetchMock).not.toHaveBeenCalled()
  })

  it('目录返回已安装应用的 id 时，补齐显示名与官方图标地址', async () => {
    ofetchMock.mockResolvedValue({ apps: ['vscode', 'cursor'] })
    withSession(desktopSession())

    await expect(listConfigApplications()).resolves.toEqual([
      { id: 'vscode', name: 'Visual Studio Code', default: false, icon: '/open-in-app/icon/vscode' },
      { id: 'cursor', name: 'Cursor', default: false, icon: '/open-in-app/icon/cursor' },
    ])
    expect(postConfigOpenMock).toHaveBeenCalledWith({ dry: '1' }, { ignoreResponseError: true })
  })

  it('目录响应异常或没有应用时不列表', async () => {
    ofetchMock.mockResolvedValue({})
    withSession(desktopSession())
    await expect(listConfigApplications()).resolves.toEqual([])

    ofetchMock.mockResolvedValue({ apps: [] })
    withSession(desktopSession())
    await expect(listConfigApplications()).resolves.toEqual([])
  })

  it('目录请求失败（低版本缺路由）时不列表', async () => {
    ofetchMock.mockRejectedValue(new Error('404'))
    withSession(desktopSession())

    await expect(listConfigApplications()).resolves.toEqual([])
  })

  it('按应用 id 打开配置文件', async () => {
    const openWorkspacePath = vi.fn(async () => ({ ok: true, value: {} }))
    withSession(desktopSession({ openWorkspacePath }))

    await expect(openConfigInApp('vscode')).resolves.toBe(true)
    expect(openWorkspacePath).toHaveBeenCalledWith({ path: '/home/u/.dsh/settings.yaml', application: 'vscode' })
  })
})
