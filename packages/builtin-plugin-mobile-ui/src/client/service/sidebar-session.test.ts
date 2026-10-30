import { describe, expect, it } from 'vitest'
import { getMobileSessionId, getMobileSessionTitle } from './sidebar-session'

describe('mobile navbar session projection', () => {
  it('prefers a valid current row over a main-view retained row', () => {
    const snapshot = {
      current: 'selected',
      byId: {
        retained: { title: 'Retained title', retainedBy: { mainView: 1 } },
        selected: { title: '  Selected title  ' },
      },
    }
    expect(getMobileSessionId(snapshot)).toBe('selected')
    expect(getMobileSessionTitle(snapshot)).toBe('Selected title')
  })

  it.each([undefined, null, 7, '', 'missing', 'invalid'])('falls back to the main-view retained row when current is %j', (current) => {
    const snapshot = {
      current,
      ids: ['first', 'selected'],
      byId: {
        first: { title: 'Not selected', retainedBy: { gateway: 1 } },
        invalid: null,
        selected: { title: 'Retained title', retainedBy: { mainView: 2 } },
      },
    }
    expect(getMobileSessionId(snapshot)).toBe('selected')
    expect(getMobileSessionTitle(snapshot)).toBe('Retained title')
  })

  it('leaves the localized New Session label to the caller for a blank selected session', () => {
    const snapshot = {
      current: 'selected',
      byId: {
        selected: { blank: true, title: 'Stored title', displayTitle: 'Fallback title' },
        retained: { title: 'Wrong session', retainedBy: { mainView: 1 } },
      },
    }
    expect(getMobileSessionId(snapshot)).toBe('selected')
    expect(getMobileSessionTitle(snapshot)).toBeUndefined()
  })

  it.each([
    { title: '  Durable title  ', displayTitle: 'Fallback', expected: 'Durable title' },
    { title: '  ', displayTitle: '  Project name  ', expected: 'Project name' },
    { title: undefined, displayTitle: 'Session id', expected: 'Session id' },
    { title: 17, displayTitle: '  Fallback  ', expected: 'Fallback' },
    { title: '', displayTitle: '\t\n', expected: undefined },
    { title: null, displayTitle: 17, expected: undefined },
  ])('projects a trimmed nonempty title from %j', ({ title, displayTitle, expected }) => {
    expect(getMobileSessionTitle({ current: 'selected', byId: { selected: { title, displayTitle } } })).toBe(expected)
  })

  it.each([undefined, null, false, 7, 'snapshot', [], {}, { byId: null }, { byId: [] }, { byId: 'rows' }])('returns absence for an incomplete snapshot %j', (snapshot) => {
    expect(getMobileSessionId(snapshot)).toBeUndefined()
    expect(getMobileSessionTitle(snapshot)).toBeUndefined()
  })

  it.each([null, [], 'row', 17, { retainedBy: null }, { retainedBy: [] }, { retainedBy: { mainView: 0 } }, { retainedBy: { mainView: -1 } }, { retainedBy: { mainView: '1' } }])('ignores a malformed or unselected fallback row %j', (summary) => {
    const snapshot = { ids: ['first'], byId: { first: summary } }
    expect(getMobileSessionId(snapshot)).toBeUndefined()
    expect(getMobileSessionTitle(snapshot)).toBeUndefined()
  })

  it('does not infer selection from the first catalog id', () => {
    const snapshot = { ids: ['first'], byId: { first: { title: 'First title', displayTitle: 'First display title', blank: false } } }
    expect(getMobileSessionId(snapshot)).toBeUndefined()
    expect(getMobileSessionTitle(snapshot)).toBeUndefined()
  })

  it('does not treat inherited catalog properties as a valid current row', () => {
    expect(getMobileSessionId({ current: 'toString', byId: {} })).toBeUndefined()
    expect(getMobileSessionTitle({ current: 'toString', byId: {} })).toBeUndefined()
  })
})
