import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: vi.fn(),
  launchAndWait: vi.fn(async () => {}),
  listenInstallProgress: vi.fn(async () => () => {}),
  prepareInstall: vi.fn(),
  fail: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
  t: (key: string, options?: { tag?: string }) => options?.tag === undefined ? key : `${key}:${options.tag}`,
}))
vi.mock('@/utils/toast', () => ({ toast: Object.assign(mocks.toast, { clear: vi.fn() }) }))
vi.mock('../harness', () => ({
  harness: {
    $state: {},
    listenInstallProgress: mocks.listenInstallProgress,
    prepareInstall: mocks.prepareInstall,
    launchAndWait: mocks.launchAndWait,
    fail: mocks.fail,
    status: 'ready',
  },
}))

const UPDATE = { tag: 'dsh-0.2.2-rc.3-43434887577', commit: '4343488757' }

let harnessUpdater: (typeof import('./store'))['harnessUpdater']

beforeEach(async () => {
  vi.resetModules()
  mocks.invoke.mockReset()
  mocks.toast.mockReset()
  ;({ harnessUpdater } = await import('./store'))
})

it('keeps the discovered update so the shell can render a prompt', async () => {
  mocks.invoke.mockResolvedValue(UPDATE)
  await harnessUpdater.checkForUpdate()
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('check_dsh_update')
  expect(harnessUpdater.updateInfo).toEqual(UPDATE)
})

it('clears a stale prompt when the backend reports no update', async () => {
  harnessUpdater.updateInfo = UPDATE
  mocks.invoke.mockResolvedValue(null)
  await harnessUpdater.checkForUpdate()
  expect(harnessUpdater.updateInfo).toBeNull()
})

it('keeps the failed check observable instead of throwing into the caller', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.invoke.mockRejectedValue(new Error('DSH_ATOM: connection refused'))
  await expect(harnessUpdater.checkForUpdate()).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalledWith('[Harness] update check skipped:', expect.any(Error))
  warn.mockRestore()
})

it('renders the prompt with the new tag and replays the update action', async () => {
  mocks.invoke.mockResolvedValue(UPDATE)
  await harnessUpdater.checkForUpdate()
  const onUpdate = vi.fn()
  harnessUpdater.showToast(onUpdate)
  expect(mocks.toast).toHaveBeenCalledTimes(1)
  const [message, options] = mocks.toast.mock.calls[0] as [string, { actionProps: { onPress: () => void } }]
  expect(message).toBe(`update.available:${UPDATE.tag}`)
  options.actionProps.onPress()
  expect(onUpdate).toHaveBeenCalledTimes(1)
})

it('keeps the prompt reference stable while the same version keeps coming back', async () => {
  mocks.invoke.mockResolvedValue(UPDATE)
  await harnessUpdater.checkForUpdate()
  const announced = harnessUpdater.updateInfo
  await harnessUpdater.checkForUpdate()
  harnessUpdater.showToast(() => {})
  await harnessUpdater.checkForUpdate()
  // 定时复查每轮都会拿到内容相同的新对象；引用不变，界面层才不会重复弹提示
  expect(harnessUpdater.updateInfo).toBe(announced)
  expect(mocks.toast).toHaveBeenCalledTimes(1)
})

it('surfaces a newer release after the announced one', async () => {
  mocks.invoke.mockResolvedValue(UPDATE)
  await harnessUpdater.checkForUpdate()
  const announced = harnessUpdater.updateInfo
  const newer = { tag: 'dsh-0.2.2-rc.4-43450000000', commit: '4345000000' }
  mocks.invoke.mockResolvedValue(newer)
  await harnessUpdater.checkForUpdate()
  expect(harnessUpdater.updateInfo).not.toBe(announced)
  expect(harnessUpdater.updateInfo).toEqual(newer)
})
