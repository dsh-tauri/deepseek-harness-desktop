import type { PetSessionEvent, PetSessionPeer } from './session-stream.types'
/**
 * src/host/service/session-stream.utils.test.ts — reducer（会话增量 → 桌宠展示态）单测。
 *
 * 输入是真实 `SessionEvent` 形状（{type, seq, time, data}），reducer 的输出
 * 必须与 use-bubble.ts 期望的展示态字段（status/running/liveActivity/message/…）
 * 一致。重点覆盖：running 生命周期翻转、展示态去重、子代理 origin 透传。
 */
import { describe, expect, it } from 'vitest'
import { createPetSessionReducer, PET_REASONING_PUSH_INTERVAL_MS, PET_REASONING_TAIL_WINDOW } from './session-stream.utils'

function ev(
  type: string,
  data: Record<string, unknown>,
  seq: number,
  surfaceOp?: PetSessionEvent['surfaceOp'],
): PetSessionEvent {
  return { type, seq, time: Date.now(), data, surfaceOp }
}

const peer = (over: Partial<PetSessionPeer> = {}): PetSessionPeer => ({ id: 'a', ...over })

/** 收集 reducer 产生的 (action, payload) 序列。 */
function collect(opts?: { now?: () => number }) {
  const pushes: Array<{ action: string, payload: Record<string, unknown> }> = []
  const reducer = createPetSessionReducer((action, payload) => {
    pushes.push({ action, payload: payload as unknown as Record<string, unknown> })
  }, opts)
  return { reducer, pushes }
}

describe('petSessionReducer (host)', () => {
  it('create 时发出 running=false、status 无的 create payload', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    expect(pushes).toHaveLength(1)
    expect(pushes[0].action).toBe('create')
    expect(pushes[0].payload).toMatchObject({ id: 'a', running: false })
    expect(pushes[0].payload.status).toBeUndefined()
  })

  it('preserves the activity alias across running, waiting, error and idle wire payloads', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    expect(pushes.at(-1)!.payload).toHaveProperty('activity', undefined)
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    expect(pushes.at(-1)!.payload).toMatchObject({ status: 'running', activity: 'running' })
    reducer.apply(peer(), ev('approval/asked', { id: 'approval' }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ status: 'waiting', activity: 'waiting' })
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'failed' } } }, 3))
    expect(pushes.at(-1)!.payload).toMatchObject({ status: 'error', activity: 'error' })
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 4))
    reducer.apply(peer(), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 5))
    expect(pushes.at(-1)!.payload).toHaveProperty('activity', undefined)
  })

  it('turn/start 让 running=true、status=running、workStatus=thinking', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const last = pushes.at(-1)!
    expect(last.action).toBe('update')
    expect(last.payload).toMatchObject({ id: 'a', running: true, status: 'running', workStatus: 'thinking' })
  })

  it('assistant/chunk(reasoning-delta) 累积出 liveActivity=reasoning、workStatus=thinking', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '思考' } }, 2))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ running: true, status: 'running', workStatus: 'thinking' })
    expect(last.payload.liveActivity).toMatchObject({ kind: 'reasoning', text: '思考' })
  })

  it('tool/call 时 liveActivity 切换为工具名（携带 args）、workStatus=working，tool/result 后回 result', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '思考' } }, 2))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' }, 3))
    const toolPush = pushes.at(-1)!
    expect(toolPush.payload.liveActivity).toMatchObject({ kind: 'tool', name: 'pwsh', args: '{"command":"ls"}' })
    expect(toolPush.payload).toMatchObject({ workStatus: 'working', toolActivity: 'commanding' })
    // tool/result 结束 c1，openTools 清空；reasoning 仍在 → 回到 thinking 文案，档位切 result。
    reducer.apply(peer(), ev('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }, 4))
    const afterResult = pushes.at(-1)!
    expect(afterResult.payload).toMatchObject({ workStatus: 'result' })
    expect(afterResult.payload.liveActivity).toMatchObject({ kind: 'reasoning', text: '思考' })
  })

  it('tool/call 后仍有其他工具在跑 → workStatus 保持 working', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"x"}' }, 2))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"a.ts"}' }, 3))
    // 结束 c1 后 c2 仍在 openTools → 档位依旧 working（不落回 thinking/result）。
    reducer.apply(peer(), ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' } } }, 4))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ workStatus: 'working', toolActivity: 'searching' })
  })

  it('approval/asked 让展示为 waiting(phase=approval, workStatus=waiting)，approval/decided 后回 thinking', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('approval/asked', { id: 'ap1', toolName: 'plan_final_approval' }, 2))
    const asked = pushes.at(-1)!
    expect(asked.payload).toMatchObject({ running: true, status: 'waiting', phase: 'approval', workStatus: 'waiting' })
    // 相同 id 的 decided 清除等待态；running 仍在 → 回到 running（细分为 thinking，无工具在跑）。
    reducer.apply(peer(), ev('approval/decided', { id: 'ap1' }, 3))
    const decided = pushes.at(-1)!
    expect(decided.payload.status).toBe('running')
    expect(decided.payload.phase).toBeUndefined()
    expect(decided.payload).toMatchObject({ workStatus: 'thinking' })
  })

  it('user-question 工具调用让展示为 waiting(phase=user-question, workStatus=waiting)，user/message 应答后清除', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'uq1', name: 'ask_user_question', arguments: '{}' }, 2))
    const waiting = pushes.at(-1)!
    expect(waiting.payload).toMatchObject({ running: true, status: 'waiting', phase: 'user-question', workStatus: 'waiting' })
    // 用户应答后（user/message）清除等待态，问句工具仍在 openTools → 回 working。
    reducer.apply(peer(), ev('user/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '继续' }] } }, 3))
    const afterAnswer = pushes.at(-1)!
    expect(afterAnswer.payload.status).toBe('running')
    expect(afterAnswer.payload.phase).toBeUndefined()
    expect(afterAnswer.payload).toMatchObject({ workStatus: 'working' })
  })

  it('surfaceOp=replace 的用户消息（rewind 回退标记）不是新回合：空闲会话不得被翻成 running', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 2))

    // rewind 在 cancel + waitForAgentIdle 之后追加替换标记，且回合外不再有 turn/end 收尾：
    // 若照常置 running，会话永久停在「思考中」，桌宠气泡等不到收敛（回退后消不掉的残留气泡）。
    const before = pushes.length
    reducer.apply(peer(), ev('user/message', {
      message: { role: 'user', content: [{ type: 'text', text: '回退' }] },
    }, 3, { op: 'replace', startSeq: 0, endSeq: 2 }))
    expect(pushes, '替换标记不产生任何展示态变化').toHaveLength(before)
    expect(pushes.at(-1)!.payload).toMatchObject({ running: false })

    // 真正的用户消息（append 标记或没有标记）仍视为新回合。
    reducer.apply(peer(), ev('user/message', {
      message: { role: 'user', content: [{ type: 'text', text: '继续' }] },
    }, 4, 'append'))
    expect(pushes.at(-1)!.payload).toMatchObject({ running: true })
  })

  it('turn/end(blocked) 让展示为 waiting(phase=blocked, workStatus=waiting)（等待用户处理非思考中）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 2))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ running: false, status: 'waiting', phase: 'blocked', workStatus: 'waiting' })
  })

  it('turn/end(completed) 把 running 翻回 false、粗 status 清空、workStatus=success（终态庆祝档）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'x' } }, 2))
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ id: 'a', running: false })
    expect(last.payload.status).toBeUndefined()
    expect(last.payload).toMatchObject({ workStatus: 'success' })
    expect(last.payload.liveActivity).toBeUndefined()
  })

  it('turn/end(error) 记录 lastAgentError → 粗 status=error、workStatus=error（终态失败档）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'boom' } },
    }, 2))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ running: false, status: 'error', lastAgentError: 'boom', workStatus: 'error' })
  })

  it('turn/end(max-tokens) 归为 workStatus=error（输出上限）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 2))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ workStatus: 'error', lastAgentError: 'max-tokens' })
  })

  it('turn/end(aborted) 静默取消：workStatus/lastAgentError/status 均清空（手动取消非失败，不得弹「失败：aborted」）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, 2))
    // 核心手动取消会带 reason.error.message（'aborted'）；旧实现把它写进 lastAgentError → use-bubble 判 failed。
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'aborted', error: { message: 'aborted' } } }, 3))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ running: false })
    expect(last.payload.workStatus).toBeUndefined()
    expect(last.payload.lastAgentError).toBeUndefined()
    expect(last.payload.status).toBeUndefined()
  })

  it('goal 续跑轮（source.round>0）未声明收尾时 turn/end(completed) 只到 result，不播雀跃庆祝', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 1))
    reducer.apply(peer(), ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } }, 2))
    reducer.apply(peer(), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3))
    expect(pushes.at(-1)!.payload).toMatchObject({ running: false, workStatus: 'result' })
  })

  it('goal 续跑轮以 update_goal complete 收尾 → workStatus=success', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 1))
    reducer.apply(peer(), ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } }, 2))
    reducer.apply(peer(), ev('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'update_goal', arguments: '{"action":"complete"}' }, 3))
    reducer.apply(peer(), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'success' })
  })

  it('goal 续跑轮以 update_goal blocked 收尾 → workStatus=error，但不写 lastAgentError（阻塞非崩溃）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 1))
    reducer.apply(peer(), ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } }, 2))
    reducer.apply(peer(), ev('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'update_goal', arguments: '{"action":"blocked","blocked_reason":"x"}' }, 3))
    reducer.apply(peer(), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4))
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ workStatus: 'error' })
    expect(last.payload.lastAgentError).toBeUndefined()
    expect(last.payload.status).toBeUndefined()
  })

  it('goal 激活轮（round=0）不是续跑轮 → turn/end(completed) 仍为 success', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 0 } }, 2))
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'success' })
  })

  it('非 goal 轮的 update_goal 不影响终局档位（普通回合仍 success）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'update_goal', arguments: '{"action":"blocked"}' }, 2))
    reducer.apply(peer(), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'success' })
  })

  it('goal 标志随回合失效：续跑轮 result 后，下一普通轮 completed 回到 success', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 1))
    reducer.apply(peer(), ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } }, 2))
    reducer.apply(peer(), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'result' })
    reducer.apply(peer(), ev('turn/start', { turn: 3 }, 4))
    reducer.apply(peer(), ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, 5))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'success' })
  })

  it('update_goal 参数不可解析时不当作收尾（续跑轮仍只到 result）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 1))
    reducer.apply(peer(), ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 1, round: 2 } }, 2))
    reducer.apply(peer(), ev('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'update_goal', arguments: '{oops' }, 3))
    reducer.apply(peer(), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'result' })
  })

  it('tool/result 的工具级错误不写入 lastAgentError（回合仍在跑时不得判 failed 收起气泡）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, 2))
    // 工具执行失败（data.error），但回合未结束：不得污染 lastAgentError / 粗 status。
    reducer.apply(peer(), ev('tool/result', {
      turn: 1,
      step: 1,
      error: { name: 'EPERM', message: 'operation not permitted' },
    }, 3))
    const last = pushes.at(-1)!
    expect(last.payload.lastAgentError).toBeUndefined()
    expect(last.payload.status).toBe('running')
    expect(last.payload).toMatchObject({ workStatus: 'result' })
  })

  it('新回合 turn/start 清除上一回合的 lastAgentError 残留（错误不跨回合）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'boom' } },
    }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ workStatus: 'error', lastAgentError: 'boom' })
    // 用户继续对话 → 新回合：错误清除，档位回 thinking。
    reducer.apply(peer(), ev('turn/start', { turn: 2 }, 3))
    const next = pushes.at(-1)!
    expect(next.payload.lastAgentError).toBeUndefined()
    expect(next.payload).toMatchObject({ workStatus: 'thinking' })
  })

  it('展示态未变化时不重复转发（去重，防 #396 高频转发）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const beforeDup = pushes.length
    // 相同 seq 的 turn/start 再喂一次（复制），展示态不变 → 不产生 update。
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    expect(pushes.length).toBe(beforeDup)
  })

  it('reasoning-delta 滚动尾部窗口：超出窗口丢弃最早内容并继续实时更新', () => {
    // 注入可控时钟：跨越窗口推一条，再推进时间推一条（节流窗口外才推送）。
    let t = 0
    const { reducer, pushes } = collect({ now: () => t })
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    // 喂一个跨越窗口长度的 reasoning 增量：前段被挤掉，只保留尾部。
    const front = 'a'.repeat(PET_REASONING_TAIL_WINDOW + 50)
    const tail = 'bbbb'
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: front } }, 2))
    t += PET_REASONING_PUSH_INTERVAL_MS + 1
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: tail } }, 3))
    const last = pushes.at(-1)!
    expect(last.payload.liveActivity).toMatchObject({ kind: 'reasoning' })
    // 只保留窗口尾部：最新内容在末尾，前段被丢弃，长度被窗口约束。
    const text = String((last.payload.liveActivity as { text?: string }).text)
    expect(text.endsWith(tail)).toBe(true)
    expect(text.length).toBe(PET_REASONING_TAIL_WINDOW)
  })

  it('reasoning 文本按 500ms 节流：窗口内多次增量只推送一次，窗口外才推送', () => {
    let t = 0
    const { reducer, pushes } = collect({ now: () => t })
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'aaa' } }, 2))
    const afterFirst = pushes.length
    // 窗口内的连续增量：状态累积但不再推送。
    t += 200
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'bbb' } }, 3))
    t += 200
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'ccc' } }, 4))
    expect(pushes.length).toBe(afterFirst)
    // 越过窗口后下一增量才推送一次，且内容包含累计尾部。
    t += 200
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'ddd' } }, 5))
    expect(pushes.length).toBe(afterFirst + 1)
    const last = pushes.at(-1)!
    const text = String((last.payload.liveActivity as { text?: string }).text)
    expect(text.endsWith('ddd')).toBe(true)
  })

  it('子代理 origin 透传给展示 payload', () => {
    const { reducer, pushes } = collect()
    reducer.apply(peer({ origin: 'subagent' }), ev('turn/start', { turn: 1 }, 1))
    const last = pushes.at(-1)!
    expect(last.payload.origin).toBe('subagent')
  })

  it('chunk()（agent/assistant-stream 活体帧）与 assistant/chunk 事件同语义：reasoning 累积 + 500ms 节流', () => {
    // 时钟从 0 出发时首帧必被 500ms 窗口吃掉（`lastReasoningPushAt` 缺省 0），从窗口外起测。
    let t = PET_REASONING_PUSH_INTERVAL_MS + 1
    const { reducer, pushes } = collect({ now: () => t })
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.chunk(peer(), { type: 'reasoning-delta', text: '思考' })
    const afterFirst = pushes.length
    const last = pushes.at(-1)!
    expect(last.payload).toMatchObject({ running: true, workStatus: 'thinking' })
    expect(last.payload.liveActivity).toMatchObject({ kind: 'reasoning', text: '思考' })

    // 窗口内的连续帧只累积不推送（与事件路径共用同一份节流时钟）。
    t += 200
    reducer.chunk(peer(), { type: 'reasoning-delta', text: '中' })
    expect(pushes.length).toBe(afterFirst)
    t += PET_REASONING_PUSH_INTERVAL_MS
    reducer.chunk(peer(), { type: 'reasoning-delta', text: '尾巴' })
    expect(pushes.length).toBe(afterFirst + 1)
    const text = String((pushes.at(-1)!.payload.liveActivity as { text?: string }).text)
    expect(text).toBe('思考中尾巴')
  })

  it('chunk() 只吃 assistant/chunk 认识的增量：text-delta 累积正文但不转发，未知 chunk 不报错', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const before = pushes.length
    reducer.chunk(peer(), { type: 'text-delta', text: '正文' })
    reducer.chunk(peer(), { type: 'usage', usage: { totalTokens: 1 } })
    reducer.chunk(peer(), undefined)
    reducer.chunk(peer(), null)
    expect(pushes.length).toBe(before)
    // 正文进 message，随下一个边界事件一起下发。
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, 2))
    expect(pushes.at(-1)!.payload.message).toBe('正文')
  })

  it('todo/write 更新当前任务：task 首次写入才转发（供气泡 taskCopy 文案），重复相同不转发', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const before = pushes.length
    // 无 in_progress/pending 项：task 不变，不转发。
    reducer.apply(peer(), ev('todo/write', { todos: [{ id: 't0', status: 'completed', content: 'x' }] }, 2))
    expect(pushes.length).toBe(before)
    // 出现 in_progress 任务：task 变化 → 转发（气泡显示「正在处理 xxx」）。
    reducer.apply(peer(), ev('todo/write', { todos: [{ id: 't1', status: 'in_progress', content: '整理文档' }] }, 3))
    const withTask = pushes.at(-1)!
    expect(withTask.payload).toMatchObject({ task: '整理文档' })
    // 相同任务再次写入：无变化，不重复转发。
    reducer.apply(peer(), ev('todo/write', { todos: [{ id: 't1', status: 'in_progress', content: '整理文档' }] }, 4))
    expect(pushes.length).toBe(before + 1)
  })

  it('todo/write 取最后一个 in_progress（agent 忘标上一步 completed 时文案不卡在最早那步）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('todo/write', {
      todos: [
        { id: 't1', status: 'in_progress', content: '第一步' },
        { id: 't2', status: 'completed', content: '中间' },
        { id: 't3', status: 'in_progress', content: '第三步' },
      ],
    }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ task: '第三步' })
  })

  it('todo/write 无进行中项时回落第一个 pending', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('todo/write', {
      todos: [
        { id: 't1', status: 'completed', content: '已完成' },
        { id: 't2', status: 'pending', content: '待办一' },
        { id: 't3', status: 'pending', content: '待办二' },
      ],
    }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ task: '待办一' })
  })

  it('todo/write 长文案按码点截断到 40 并加省略号（不劈开 emoji）', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const emoji = '🐟'
    reducer.apply(peer(), ev('todo/write', {
      todos: [{ id: 't1', status: 'in_progress', content: emoji.repeat(50) }],
    }, 2))
    const task = pushes.at(-1)!.payload.task as string
    expect(Array.from(task)).toHaveLength(41)
    expect(task).toBe(`${emoji.repeat(40)}…`)
    expect(task.endsWith('…')).toBe(true)
  })

  it('todo/write 恰好 40 码点不截断', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const content = '字'.repeat(40)
    reducer.apply(peer(), ev('todo/write', { todos: [{ id: 't1', status: 'in_progress', content }] }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ task: content })
  })

  // ---------------------------------------------------------------------------
  // agent/status idle 兜底：核心漏发 turn/end 的中断必须回落空闲，否则 toast + 循环动画一直持续。
  // 真实现场见 session-2a2abd15（用户中止一个刚起流的会话）：日志只有 assistant/attempt +
  // step/end，turn/end 直到 2.5 分钟后会话重载才由崩溃修复以 interrupted 补写。
  // ---------------------------------------------------------------------------
  it('idle 兜底：回合内漏发 turn/end 时清空 workStatus/running/工具等待并把展示态转发下去', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.apply(peer(), ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ running: true, workStatus: 'working' })
    const before = pushes.length
    reducer.idle('a')
    expect(pushes.length).toBe(before + 1)
    const last = pushes.at(-1)!
    expect(last.action).toBe('update')
    expect(last.payload).toMatchObject({ id: 'a', running: false })
    expect(last.payload.workStatus).toBeUndefined()
    expect(last.payload.status).toBeUndefined()
    expect(last.payload.liveActivity).toBeUndefined()
  })

  it('idle 兜底：turn/end 已落定的终态档与等待态不被改写（气泡/一次性动画不被掐断）', () => {
    for (const reason of [{ kind: 'completed' }, { kind: 'error', error: { message: 'boom' } }, { kind: 'blocked' }]) {
      const { reducer, pushes } = collect()
      reducer.create(peer())
      reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
      reducer.apply(peer(), ev('turn/end', { turn: 1, reason }, 2))
      const settled = pushes.at(-1)!.payload
      const count = pushes.length
      reducer.idle('a')
      expect(pushes.length).toBe(count)
      expect(pushes.at(-1)!.payload).toBe(settled)
    }
  })

  it('idle 兜底：无累计态、已空闲或重复通知都不转发', () => {
    const { reducer, pushes } = collect()
    // 未见过这个会话：不凭空建态、不转发。
    reducer.idle('unknown')
    expect(pushes).toHaveLength(0)

    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    const before = pushes.length
    reducer.idle('a')
    expect(pushes.length).toBe(before + 1)
    // 已回空闲：重复 idle 不再转发。
    reducer.idle('a')
    expect(pushes.length).toBe(before + 1)
  })

  it('idle 兜底：新建会话仅凭 summary running=true（无事件）也能回落空闲', () => {
    const { reducer, pushes } = collect()
    // 桌面端订阅流之前会话已在跑：create 直接带 running=true，此后没有新事件。
    reducer.create(peer({ running: true }))
    expect(pushes.at(-1)!.payload).toMatchObject({ running: true, status: 'running' })
    reducer.idle('a')
    expect(pushes.at(-1)!.payload).toMatchObject({ running: false })
    expect(pushes.at(-1)!.payload.status).toBeUndefined()
  })

  it('remove(id) 下发 remove 载荷并丢弃累计态：移除后的 idle 兜底不再命中', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))

    reducer.remove('a')
    expect(pushes.at(-1)).toEqual({ action: 'remove', payload: { id: 'a' } })

    const afterRemove = pushes.length
    reducer.idle('a')
    expect(pushes.length).toBe(afterRemove)
  })

  it('remove(id) 清空去重快照：与移除前同形的 payload 会重新下发', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.remove('a')

    reducer.apply(peer(), ev('session/title', {}, 2))
    expect(pushes).toHaveLength(3)
    expect(pushes.at(-1)!.action).toBe('update')
    expect(pushes.at(-1)!.payload).toMatchObject({ id: 'a', running: false })
    expect(pushes.at(-1)!.payload.status).toBeUndefined()
    expect(pushes.at(-1)!.payload.workStatus).toBeUndefined()
  })

  it('remove(id) 清空推理节流时钟：重建后 100ms 内的推理增量立即下发', () => {
    let t = 1000
    const { reducer, pushes } = collect({ now: () => t })
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    t += 100
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '思考' } }, 2))
    expect(pushes.at(-1)!.payload).toMatchObject({ liveActivity: { kind: 'reasoning', text: '思考' } })
    const afterReasoning = pushes.length

    reducer.remove('a')
    t += 100
    reducer.apply(peer(), ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '续' } }, 3))

    expect(pushes.length).toBe(afterReasoning + 2)
    expect(pushes.at(-1)!.payload).toMatchObject({ id: 'a', liveActivity: { kind: 'reasoning', text: '续' } })
  })

  it('clear() 不产生回调并清空去重快照：与清空前同形的 payload 会重新下发', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.clear()
    expect(pushes).toHaveLength(1)

    reducer.apply(peer(), ev('session/title', {}, 2))
    expect(pushes).toHaveLength(2)
    expect(pushes.at(-1)!.action).toBe('update')
    expect(pushes.at(-1)!.payload).toMatchObject({ id: 'a', running: false })
    expect(pushes.at(-1)!.payload.status).toBeUndefined()
  })

  it('clear() 丢弃累计态：清空后的 idle 兜底不再命中', () => {
    const { reducer, pushes } = collect()
    reducer.create(peer())
    reducer.apply(peer(), ev('turn/start', { turn: 1 }, 1))
    reducer.clear()

    const afterClear = pushes.length
    reducer.idle('a')
    expect(pushes.length).toBe(afterClear)
  })
})
