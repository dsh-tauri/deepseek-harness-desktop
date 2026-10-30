import { describe, expect, it } from 'vitest'
import { createSidebarGesture, finishSidebarGesture, moveSidebarGesture } from './sidebar-gesture'

const point = (x: number, y: number, time: number) => ({ id: 1, x, y, time })

describe('sidebar gesture state machine', () => {
  it('locks horizontally only after enough movement and clamps the reveal width', () => {
    const gesture = createSidebarGesture(point(100, 200, 100), false, 319)
    expect(moveSidebarGesture(gesture, point(105, 202, 120), 319, true)).toEqual({ gesture })
    const move = moveSidebarGesture(gesture, point(280, 202, 300), 319, true)
    expect(move.offset).toBe(180)
    expect(move.gesture?.axis).toBe('x')
    expect(moveSidebarGesture(move.gesture!, point(500, 202, 400), 319, true).offset).toBe(319)
  })

  it.each([
    { open: false, end: point(90, 200, 200) },
    { open: true, end: point(110, 200, 200) },
    { open: false, end: point(105, 250, 200) },
  ])('abandons wrong directions and vertical scrolling from %j', ({ open, end }) => {
    expect(moveSidebarGesture(createSidebarGesture(point(100, 200, 100), open, 319), end, 319, true)).toEqual({ gesture: null })
  })

  it('abandons noncancelable horizontal moves instead of committing release travel', () => {
    const gesture = createSidebarGesture(point(100, 200, 100), false, 319)
    expect(moveSidebarGesture(gesture, point(300, 200, 200), 319, false)).toEqual({ gesture: null })
    expect(finishSidebarGesture(gesture, point(500, 200, 300), 319)).toBeNull()
  })

  it('settles slow swipes by the revealed midpoint', () => {
    const closed = createSidebarGesture(point(100, 200, 100), false, 319)
    const short = moveSidebarGesture(closed, point(180, 200, 400), 319, true).gesture!
    const long = moveSidebarGesture(closed, point(280, 200, 400), 319, true).gesture!
    expect(finishSidebarGesture(short, point(180, 200, 700), 319)).toEqual({ open: false, suppressClick: true })
    expect(finishSidebarGesture(long, point(280, 200, 700), 319)).toEqual({ open: true, suppressClick: true })
  })

  it('uses release velocity for short flings but never for tiny accidental motion', () => {
    const gesture = createSidebarGesture(point(100, 200, 100), false, 319)
    const fling = moveSidebarGesture(gesture, point(140, 200, 140), 319, true).gesture!
    const tiny = moveSidebarGesture(gesture, point(108, 200, 105), 319, true).gesture!
    expect(finishSidebarGesture(fling, point(150, 200, 150), 319)).toEqual({ open: true, suppressClick: true })
    expect(finishSidebarGesture(tiny, point(108, 200, 110), 319)).toEqual({ open: false, suppressClick: true })
  })

  it('suppresses out-and-back claimed drags but leaves genuine taps alone', () => {
    const tap = createSidebarGesture(point(220, 200, 100), true, 319)
    expect(finishSidebarGesture(tap, point(220, 200, 200), 319)).toBeNull()
    const claimed = moveSidebarGesture(tap, point(140, 200, 300), 319, true).gesture!
    const returned = moveSidebarGesture(claimed, point(220, 200, 600), 319, true).gesture!
    expect(finishSidebarGesture(returned, point(220, 200, 900), 319)).toEqual({ open: true, suppressClick: true })
  })

  it('expires older samples for a direction change near release', () => {
    let gesture = createSidebarGesture(point(350, 200, 100), true, 319)
    for (const sample of [point(100, 200, 200), point(150, 200, 400), point(200, 200, 500)])
      gesture = moveSidebarGesture(gesture, sample, 319, true).gesture!
    expect(gesture.samples[0].time).toBe(200)
    gesture = moveSidebarGesture(gesture, point(250, 200, 550), 319, true).gesture!
    expect(gesture.samples[0].time).toBe(400)
    expect(finishSidebarGesture(gesture, point(270, 200, 580), 319)?.open).toBe(true)
  })
})
