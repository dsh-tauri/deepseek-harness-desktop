// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PET_HATCH_PROMPT } from '../constants'
import { store } from '../store'
import { PetPrefill } from './prefill'

// `dsh-tauri/client` 的产物是部署期 ModuleLoader 外壳，脱离宿主加载器在 node 下无法求值：
// 换成真实源实现（valtio-define / lodash-es），store 与组件仍共享同一份 `$state`，
// 订阅与快照语义与线上一致。
vi.mock('dsh-tauri/client', async () => {
  const valtio = await import('../../../../builtin-plugin-tauri/src/client/modules/valtio-define.ts')
  const lodash = await import('../../../../builtin-plugin-tauri/src/client/modules/lodash-es.ts')
  return {
    defineStore: valtio.defineStore,
    useStore: valtio.useStore,
    remove: lodash.remove,
    uniq: lodash.uniq,
  }
})

/**
 * valtio 2 的订阅通知是异步派发的（`valtio-define` 只在 `$subscribeKey` 里显式传
 * `notifyInSync`），同步的 `act()` 刷不到通知，必须 `await act(async () => …)`。
 */
async function mutate(fn: () => void): Promise<void> {
  await act(async () => {
    fn()
  })
}

afterEach(() => {
  cleanup()
  store.pet.clearPrefills()
})

describe('pet prefill', () => {
  it('挂载时草稿已就绪：立即注入并消费', () => {
    const setDraft = vi.fn()
    store.pet.setPrefill('s1', PET_HATCH_PROMPT)

    render(<PetPrefill sessionId="s1" inputActions={{ setDraft }} />)

    expect(setDraft).toHaveBeenCalledWith(PET_HATCH_PROMPT)
    expect(store.pet.prefills.s1).toBeUndefined()
  })

  /**
   * 回归（issue #756 收尾）：`createPetSession` 走官方 `connectWorkspace`，后者会复用
   * 已打开的空白会话并原样返回其 id，因此槽位组件早已挂载、`sessionId` 不变。
   * 若组件只在挂载时读一次 store，这次注入会永久丢失（表现为「切走再切回来才出现」）。
   */
  it('草稿晚到（会话被复用、组件不重挂载）：订阅到变更后仍注入并消费', async () => {
    const setDraft = vi.fn()
    render(<PetPrefill sessionId="s1" inputActions={{ setDraft }} />)
    expect(setDraft).not.toHaveBeenCalled()

    await mutate(() => {
      store.pet.setPrefill('s1', PET_HATCH_PROMPT)
    })

    expect(setDraft).toHaveBeenCalledWith(PET_HATCH_PROMPT)
    expect(store.pet.prefills.s1).toBeUndefined()
  })

  it('只注入本会话的草稿', async () => {
    const setDraft = vi.fn()
    render(<PetPrefill sessionId="s1" inputActions={{ setDraft }} />)

    await mutate(() => {
      store.pet.setPrefill('s2', '/other')
    })

    expect(setDraft).not.toHaveBeenCalled()
  })

  it('同会话再次登记草稿会再次注入（消费后不残留）', async () => {
    const setDraft = vi.fn()
    render(<PetPrefill sessionId="s1" inputActions={{ setDraft }} />)

    await mutate(() => {
      store.pet.setPrefill('s1', PET_HATCH_PROMPT)
    })
    await mutate(() => {
      store.pet.setPrefill('s1', PET_HATCH_PROMPT)
    })

    expect(setDraft).toHaveBeenCalledTimes(2)
    expect(store.pet.prefills).toEqual({})
  })
})
