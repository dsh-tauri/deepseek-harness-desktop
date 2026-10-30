import type { ClientContext } from 'dsh-tauri/client'
import type { ConversationAttachments, DraftAttachmentDescriptor, DraftUploadState } from './attachments.types'
import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_READY_DELAY_MS, ATTACHMENT_READY_MAX_ATTEMPTS } from '../constants'
import {
  awaitDraftUploads,
  captureDraftAttachments,
  conversationAttachments,
  mergeCapturedAttachments,
  recreateDraftAttachments,
  releaseDraftAttachments,
} from './attachments'

function ctxWith(service: unknown, throws = false): ClientContext {
  return {
    get: () => {
      if (throws)
        throw new Error('service "conversation" is not injected')
      return service
    },
  } as unknown as ClientContext
}

function uploads(states: () => Record<string, DraftUploadState | undefined>): ConversationAttachments {
  return { fileUploads: { getSnapshot: states } }
}

const file = {} as File

describe('conversationAttachments', () => {
  it('取到会话服务即返回，缺席或 inject 守卫抛错都按不可用处理', () => {
    const service: ConversationAttachments = { createDrafts: vi.fn() }
    expect(conversationAttachments(ctxWith(service))).toBe(service)
    expect(conversationAttachments(ctxWith(undefined))).toBeUndefined()
    expect(conversationAttachments(ctxWith(service, true))).toBeUndefined()
  })
})

describe('captureDraftAttachments', () => {
  it('按 id 抓出附件本体（运行期对象，晚了就没了）', () => {
    const descriptor: DraftAttachmentDescriptor = { id: 'a', kind: 'file', file }
    const resolveDraftAttachments = vi.fn(() => [descriptor])

    expect(captureDraftAttachments({ resolveDraftAttachments }, ['a'])).toEqual([descriptor])
    expect(resolveDraftAttachments).toHaveBeenCalledWith(['a'])
  })

  it('过滤掉已经没有本体的死 id，能力缺席/抛错/空列表都返回空', () => {
    const resolveDraftAttachments = vi.fn(() => [{ id: 'a' }])
    expect(captureDraftAttachments({ resolveDraftAttachments }, ['a'])).toEqual([])

    expect(captureDraftAttachments({ resolveDraftAttachments }, [])).toEqual([])
    expect(captureDraftAttachments(undefined, ['a'])).toEqual([])
    expect(captureDraftAttachments({}, ['a'])).toEqual([])
    expect(captureDraftAttachments({ resolveDraftAttachments: () => {
      throw new Error('dead shell')
    } }, ['a'])).toEqual([])
  })
})

describe('recreateDraftAttachments', () => {
  it('用本体在目标会话重建草稿，返回新 id 与描述符', () => {
    const createDrafts = vi.fn(() => [{ id: 'new-a' }, { id: 'new-b' }])
    const captured: DraftAttachmentDescriptor[] = [{ id: 'a', file }, { id: 'b', file }]

    const rebuilt = recreateDraftAttachments({ createDrafts }, 'session-target', captured)

    expect(createDrafts).toHaveBeenCalledWith('session-target', [file, file])
    expect(rebuilt.ids).toEqual(['new-a', 'new-b'])
    expect(rebuilt.drafts).toHaveLength(2)
  })

  it('没有本体、能力缺席或建档失败时返回空，调用方回退搬迁原 id', () => {
    const createDrafts = vi.fn(() => [{ id: 'new-a' }])
    expect(recreateDraftAttachments({ createDrafts }, 'session-target', []).ids).toEqual([])
    expect(recreateDraftAttachments(undefined, 'session-target', [{ id: 'a', file }]).ids).toEqual([])
    expect(recreateDraftAttachments({}, 'session-target', [{ id: 'a', file }]).ids).toEqual([])
    expect(recreateDraftAttachments({ createDrafts: () => {
      throw new Error('unsupported media type')
    } }, 'session-target', [{ id: 'a', file }]).ids).toEqual([])
  })
})

describe('mergeCapturedAttachments', () => {
  it('部分解析时保留早先抓到的本体：对象一旦释放就再也抓不回来', () => {
    const first = { id: 'a', file }
    const second = { id: 'b', file }
    const onlyB = { id: 'b', file }

    expect(mergeCapturedAttachments([onlyB], [first, second], ['a', 'b'])).toEqual([onlyB, first])
  })

  it('只保留仍在草稿里的 id：用户删掉的附件不该被迁走', () => {
    const first = { id: 'a', file }
    const second = { id: 'b', file }

    expect(mergeCapturedAttachments([], [first, second], ['b'])).toEqual([second])
    expect(mergeCapturedAttachments([first], [second], ['a'])).toEqual([first])
  })

  it('重复 id 不会重复出现', () => {
    const first = { id: 'a', file }
    expect(mergeCapturedAttachments([first], [first], ['a'])).toEqual([first])
  })
})

describe('releaseDraftAttachments', () => {
  it('把描述符交给官方回收，失败或能力缺席都不影响迁移', () => {
    const releaseDraftAttachmentsFn = vi.fn()
    releaseDraftAttachments({ releaseDraftAttachments: releaseDraftAttachmentsFn }, [{ id: 'a' }])
    expect(releaseDraftAttachmentsFn).toHaveBeenCalledWith([{ id: 'a' }])

    expect(() => releaseDraftAttachments(undefined, [{ id: 'a' }])).not.toThrow()
    expect(() => releaseDraftAttachments({}, [{ id: 'a' }])).not.toThrow()
    expect(() => releaseDraftAttachments({ releaseDraftAttachments: () => {
      throw new Error('already disposed')
    } }, [{ id: 'a' }])).not.toThrow()
    expect(() => releaseDraftAttachments({ releaseDraftAttachments: releaseDraftAttachmentsFn }, [])).not.toThrow()
  })
})

describe('awaitDraftUploads', () => {
  it('上传未落地时按间隔轮询，就绪后返回', async () => {
    let state: DraftUploadState = { status: 'uploading' }
    const wait = vi.fn(async () => {
      state = { status: 'ready' }
    })

    await expect(awaitDraftUploads({
      conversation: uploads(() => ({ a: state })),
      ids: ['a'],
      wait,
      delayMs: 7,
    })).resolves.toBeUndefined()

    expect(wait).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledWith(7)
  })

  it('上传失败即抛出，不等超时', async () => {
    const wait = vi.fn(async () => {})

    await expect(awaitDraftUploads({
      conversation: uploads(() => ({ a: { status: 'error' } })),
      ids: ['a'],
      wait,
      attempts: 3,
    })).rejects.toThrow('消息附件上传失败，请重新发送')

    expect(wait).not.toHaveBeenCalled()
  })

  it('一直上传中时按 attempts 轮询后以超时抛出', async () => {
    const wait = vi.fn(async () => {})

    await expect(awaitDraftUploads({
      conversation: uploads(() => ({ a: { status: 'uploading' } })),
      ids: ['a'],
      wait,
      attempts: 3,
    })).rejects.toThrow('等待消息附件上传超时，请重新发送')

    expect(wait).toHaveBeenCalledTimes(3)
  })

  it('最后一次等待里落地时按就绪返回，不误报超时', async () => {
    let state: DraftUploadState = { status: 'uploading' }
    const wait = vi.fn(async () => {
      state = { status: 'ready' }
    })

    await expect(awaitDraftUploads({
      conversation: uploads(() => ({ a: state })),
      ids: ['a'],
      wait,
      attempts: 1,
    })).resolves.toBeUndefined()

    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('未显式传 attempts 时按 ATTACHMENT_READY_MAX_ATTEMPTS 与默认间隔轮询', async () => {
    const wait = vi.fn(async () => {})

    await expect(awaitDraftUploads({
      conversation: uploads(() => ({ a: { status: 'uploading' } })),
      ids: ['a'],
      wait,
    })).rejects.toThrow('等待消息附件上传超时，请重新发送')

    expect(wait).toHaveBeenCalledTimes(ATTACHMENT_READY_MAX_ATTEMPTS)
    expect(wait).toHaveBeenCalledWith(ATTACHMENT_READY_DELAY_MS)
  })

  it('快照里没有的附件（图片不上传）与缺能力面时按就绪处理，不等待', async () => {
    const wait = vi.fn(async () => {})

    await expect(awaitDraftUploads({ conversation: uploads(() => ({ b: { status: 'uploading' } })), ids: ['a'], wait }))
      .resolves
      .toBeUndefined()
    await expect(awaitDraftUploads({ ids: ['a'], wait })).resolves.toBeUndefined()
    await expect(awaitDraftUploads({ conversation: {}, ids: ['a'], wait })).resolves.toBeUndefined()
    await expect(awaitDraftUploads({ conversation: uploads(() => ({})), ids: [], wait })).resolves.toBeUndefined()

    expect(wait).not.toHaveBeenCalled()
  })
})
