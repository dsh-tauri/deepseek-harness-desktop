import type { ContentRiskRecoveryRange } from './content-risk'
import { describe, expect, it } from 'vitest'
import { contentRiskRecoveryRange, eventOf, isContentRiskFailure, isContentRiskTurnEnd, lastTurnEndReason } from './content-risk'

const REFUSAL = { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 }

function turnStart(seq: number, turn: number) {
  return { seq, type: 'turn/start', data: { turn } }
}

function turnEnd(seq: number, turn: number, reason: unknown) {
  return { seq, type: 'turn/end', data: { turn, reason } }
}

function failed(seq: number, turn: number) {
  return turnEnd(seq, turn, { kind: 'error', error: REFUSAL })
}

function completed(seq: number, turn: number) {
  return turnEnd(seq, turn, { kind: 'completed' })
}

describe('isContentRiskFailure', () => {
  it('accepts the upstream dedicated code regardless of status', () => {
    expect(isContentRiskFailure({ code: 'CONTENT_REJECTED' })).toBe(true)
    expect(isContentRiskFailure({ code: 'CONTENT_REJECTED', status: 422 })).toBe(true)
  })

  it('accepts the DeepSeek 400 with the verbatim refusal message', () => {
    expect(isContentRiskFailure(REFUSAL)).toBe(true)
    expect(isContentRiskFailure({ ...REFUSAL, status: undefined })).toBe(true)
    expect(isContentRiskFailure({ message: '  Content Exists Risk  ', code: 'INVALID_REQUEST', status: 400 })).toBe(true)
  })

  it('never classifies an unrelated 400 as a content refusal', () => {
    expect(isContentRiskFailure({ message: 'Invalid request: prompt too long', code: 'INVALID_REQUEST', status: 400 })).toBe(false)
    expect(isContentRiskFailure({ message: 'Content Exists Risk', code: 'SERVER', status: 400 })).toBe(false)
    expect(isContentRiskFailure({ message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 500 })).toBe(false)
    expect(isContentRiskFailure({ code: 'INVALID_REQUEST', status: 400 })).toBe(false)
    expect(isContentRiskFailure(undefined)).toBe(false)
    expect(isContentRiskFailure('Content Exists Risk')).toBe(false)
  })
})

describe('eventOf / lastTurnEndReason / isContentRiskTurnEnd', () => {
  it('reads both bare events and the client { event } wrapper', () => {
    expect(eventOf({ type: 'turn/end' })?.type).toBe('turn/end')
    expect(eventOf({ type: 'event', event: { type: 'turn/end' } })?.type).toBe('turn/end')
    expect(eventOf(undefined)).toBeUndefined()
  })

  it('returns the newest turn/end reason and ignores an open turn', () => {
    expect(lastTurnEndReason([turnStart(0, 1), completed(1, 1)])?.kind).toBe('completed')
    expect(lastTurnEndReason([completed(1, 1), turnStart(2, 2)])?.kind).toBe('completed')
    expect(lastTurnEndReason([])).toBeUndefined()
    expect(lastTurnEndReason(undefined)).toBeUndefined()
  })

  it('offers recovery only for the refusal failure', () => {
    expect(isContentRiskTurnEnd([turnStart(0, 1), failed(1, 1)])).toBe(true)
    expect(isContentRiskTurnEnd([turnStart(0, 1), turnEnd(1, 1, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })])).toBe(false)
    expect(isContentRiskTurnEnd([turnStart(0, 1), completed(1, 1)])).toBe(false)
  })
})

describe('contentRiskRecoveryRange', () => {
  it('shadows the whole failed turn but keeps the system prompt and earlier nodes', () => {
    const range = contentRiskRecoveryRange({
      events: [turnStart(0, 1), completed(4, 1), turnStart(5, 2), failed(9, 2)],
      nodes: [1, 2, 6, 8],
    })
    expect(range).toEqual<ContentRiskRecoveryRange>({ startSeq: 6, endSeq: 8, shadowedSeqs: [6, 8], watermarkSeq: 9 })
  })

  it('walks back through a trailing run of refused turns', () => {
    const range = contentRiskRecoveryRange({
      events: [turnStart(0, 1), completed(4, 1), turnStart(5, 2), failed(9, 2), turnStart(10, 3), failed(14, 3)],
      nodes: [1, 2, 6, 8, 11, 13],
    })
    expect(range).toEqual<ContentRiskRecoveryRange>({ startSeq: 6, endSeq: 13, shadowedSeqs: [6, 8, 11, 13], watermarkSeq: 14 })
  })

  it('points the upload watermark at the newest refused turn end', () => {
    const range = contentRiskRecoveryRange({
      events: [turnStart(0, 1), completed(4, 1), turnStart(5, 2), failed(9, 2), turnStart(10, 3), failed(14, 3)],
      nodes: [1, 2, 6, 8, 11, 13],
    })
    expect(range?.watermarkSeq).toBe(14)
  })

  it('drops the first surface node when the very first turn was refused', () => {
    const range = contentRiskRecoveryRange({
      events: [turnStart(0, 1), failed(4, 1)],
      nodes: [1, 2, 3],
    })
    expect(range).toEqual<ContentRiskRecoveryRange>({ startSeq: 2, endSeq: 3, shadowedSeqs: [2, 3], watermarkSeq: 4 })
  })

  it('refuses a boundary when nothing safe would remain', () => {
    expect(contentRiskRecoveryRange({ events: [turnStart(0, 1), failed(2, 1)], nodes: [1] })).toBeUndefined()
    expect(contentRiskRecoveryRange({ events: [turnStart(0, 1), failed(2, 1)], nodes: [] })).toBeUndefined()
  })

  it('refuses a boundary when the newest turn did not fail on content review', () => {
    expect(contentRiskRecoveryRange({ events: [turnStart(0, 1), completed(2, 1)], nodes: [1] })).toBeUndefined()
    expect(contentRiskRecoveryRange({
      events: [turnStart(0, 1), failed(2, 1), turnStart(3, 2), turnEnd(5, 2, { kind: 'aborted', reason: { kind: 'user' } })],
      nodes: [1, 2, 4],
    })).toBeUndefined()
  })

  it('refuses a boundary when the log carries no turn boundary at all', () => {
    expect(contentRiskRecoveryRange({ events: [], nodes: [1, 2] })).toBeUndefined()
  })
})
