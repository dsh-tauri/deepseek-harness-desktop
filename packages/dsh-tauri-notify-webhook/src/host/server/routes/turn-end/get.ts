import type { EventHandlerRequest } from 'h3'
import type { GetTurnEndQuery, GetTurnEndResult } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { turnEndFacts } from '../../../config/runtime'

/**
 * `GET /turn-end?sessionId=…`：回答「这个会话的回合为什么结束」。
 *
 * 查不到就返回空对象（200）而不是 404：调用方只关心「是不是异常停止」，
 * 未知一律按「不是」处理，没必要区分「没记录」与「会话不存在」。
 */
export default defineEventHandler<EventHandlerRequest, Promise<GetTurnEndResult>>(async (event) => {
  const query = getQuery<GetTurnEndQuery>(event)
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  if (sessionId.length === 0)
    return {}
  const fact = turnEndFacts.get(sessionId)
  return fact === undefined ? {} : { reason: fact.reason, turn: fact.turn }
})
