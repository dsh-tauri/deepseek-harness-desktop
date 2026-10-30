// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_CREATOR_DRAFT } from '../constants'
import { store } from '../store'
import { SkillCreatorPrefill } from './skill-creator-prefill'

// `dsh-tauri/client` 的产物是部署期 ModuleLoader 外壳，脱离宿主加载器在 node 下无法求值：
// 换成真实源实现（valtio-define / lodash-es），store 与组件仍共享同一份 `$state`。
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
  store.prefill.clear()
})

describe('skill creator prefill', () => {
  it('挂载时已登记：立即注入草稿并注销登记', () => {
    const setDraft = vi.fn()
    store.prefill.add('s1')

    render(<SkillCreatorPrefill sessionId="s1" inputActions={{ setDraft }} />)

    expect(setDraft).toHaveBeenCalledWith(SKILL_CREATOR_DRAFT)
    expect(store.prefill.pendingSessionIds).toEqual([])
  })

  /**
   * 回归：会话被复用（`connectWorkspace` 复用已打开的空白会话）时槽位组件不重挂载，
   * `sessionId` 与 `inputActions` 均不变。只依赖这两个值的 effect 永不重跑，
   * 晚到的登记会滞留——表现为「新建技能有时候草稿不出现」。
   */
  it('登记晚到（组件不重挂载）：订阅到变更后仍注入', async () => {
    const setDraft = vi.fn()
    render(<SkillCreatorPrefill sessionId="s1" inputActions={{ setDraft }} />)
    expect(setDraft).not.toHaveBeenCalled()

    await mutate(() => {
      store.prefill.add('s1')
    })

    expect(setDraft).toHaveBeenCalledWith(SKILL_CREATOR_DRAFT)
    expect(store.prefill.pendingSessionIds).toEqual([])
  })

  it('只消费本会话的登记', async () => {
    const setDraft = vi.fn()
    render(<SkillCreatorPrefill sessionId="s1" inputActions={{ setDraft }} />)

    await mutate(() => {
      store.prefill.add('s2')
    })

    expect(setDraft).not.toHaveBeenCalled()
    expect(store.prefill.pendingSessionIds).toEqual(['s2'])
  })
})
