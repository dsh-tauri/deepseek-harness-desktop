import type { EventHandlerRequest } from 'h3'
import type { GetTurnEndQuery, TurnEndResult } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { turnEndFact } from '../../../service/turn-end'

/**
 * `GET /turn-end?sessionId=…`：回答「这个会话的回合为什么结束」。
 *
 * 查不到就返回空对象（200）而不是 404：调用方（客户端通知）只关心「是不是用户中断」，
 * 未知一律按「不是」处理，没必要区分「没记录」与「会话不存在」。
 */
export default defineEventHandler<EventHandlerRequest, Promise<TurnEndResult>>(async (event) => {
  const query = getQuery<GetTurnEndQuery>(event)
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  if (sessionId.length === 0)
    return {}
  const fact = turnEndFact(sessionId)
  return fact === undefined ? {} : { reason: fact.reason, turn: fact.turn }
})
