import type { ComposerSessionEventEntry } from './composer-resume.types'
import { describe, expect, it } from 'vitest'
import { isComposerEmpty, isContentRiskTurnEnd, lastTurnEndKind, paintResumeIcon, readIconPath, restoreDisabled, restorePrimaryIcon, shouldOfferResume } from './composer-resume.utils'

const ARROW_PATH = 'M8.3125 0.980183C8.66767 1.0531'
const PLAY_FILL_PATH = 'M14.642 6.285c1.294.777 1.294 2.653 0 3.43l-9.113 5.468c-1.333.8-3.028-.16-3.029-1.715V2.532C2.5.978 4.196.018 5.53.818z'

interface ButtonStub {
  button: HTMLButtonElement
  attributes: Map<string, string>
  iconPath: () => string | null
  pathWrites: () => number
  disabledWrites: () => number
}

function stubButton(options: { path?: string, ariaLabel?: string, noPath?: boolean, disabled?: boolean } = {}): ButtonStub {
  const attributes = new Map<string, string>()
  if (options.path !== undefined)
    attributes.set('d', options.path)
  if (options.ariaLabel !== undefined)
    attributes.set('aria-label', options.ariaLabel)

  let pathWrites = 0
  let disabledWrites = 0
  let disabled = options.disabled ?? true

  const pathElement = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      pathWrites += 1
      attributes.set(name, value)
    },
  }
  const button = {
    get disabled() {
      return disabled
    },
    set disabled(value: boolean) {
      disabledWrites += 1
      disabled = value
    },
    querySelector: (selector: string) => selector === 'svg path' && options.noPath !== true ? pathElement : null,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  }
  return {
    button: button as unknown as HTMLButtonElement,
    attributes,
    iconPath: () => attributes.get('d') ?? null,
    pathWrites: () => pathWrites,
    disabledWrites: () => disabledWrites,
  }
}

function stubCard(placeholder: boolean): Element {
  return { querySelector: () => (placeholder ? {} : null) } as unknown as Element
}

describe('isComposerEmpty', () => {
  it('reads the kernel placeholder as the empty-draft signal', () => {
    expect(isComposerEmpty(stubCard(true))).toBe(true)
    expect(isComposerEmpty(stubCard(false))).toBe(false)
  })
})

describe('lastTurnEndKind', () => {
  function entry(type: string, kind?: string): ComposerSessionEventEntry {
    return { type: 'event', event: { type, data: kind === undefined ? {} : { reason: { kind } } } }
  }

  it('returns the newest turn/end reason kind', () => {
    expect(lastTurnEndKind([
      entry('turn/start'),
      entry('turn/end', 'completed'),
      entry('turn/start'),
      entry('turn/end', 'aborted'),
    ])).toBe('aborted')
  })

  it('reads the interrupted kind synthesized by crash-tail recovery', () => {
    expect(lastTurnEndKind([entry('turn/end', 'interrupted')])).toBe('interrupted')
  })

  it('ignores an open turn, transient entries and missing windows', () => {
    expect(lastTurnEndKind([entry('turn/end', 'error'), entry('turn/start')])).toBe('error')
    expect(lastTurnEndKind([{ type: 'transient', event: { type: 'assistant/live-chunk' } }])).toBeUndefined()
    expect(lastTurnEndKind([])).toBeUndefined()
    expect(lastTurnEndKind(undefined)).toBeUndefined()
  })

  it('returns the raw kind without narrowing it', () => {
    expect(lastTurnEndKind([entry('turn/end', 'max-tokens')])).toBe('max-tokens')
  })
})

describe('paintResumeIcon / restorePrimaryIcon', () => {
  it('paints the play icon, enables the button and restores the original state', () => {
    const stub = stubButton({ ariaLabel: 'Send message', path: ARROW_PATH })
    expect(readIconPath(stub.button)).toBe(ARROW_PATH)

    paintResumeIcon(stub.button, 'Resume task')
    expect(stub.iconPath()).toBe(PLAY_FILL_PATH)
    expect(stub.button.disabled).toBe(false)
    expect(stub.attributes.get('aria-label')).toBe('Resume task')

    restorePrimaryIcon(stub.button, { path: ARROW_PATH, ariaLabel: 'Send message' }, { label: 'Resume task', disabled: true })
    expect(stub.iconPath()).toBe(ARROW_PATH)
    expect(stub.attributes.get('aria-label')).toBe('Send message')
    expect(stub.button.disabled).toBe(true)
  })

  it('leaves a kernel re-rendered icon and label alone', () => {
    const stub = stubButton({ ariaLabel: 'Steer the running turn', path: 'M8 0.75 0 0 1', disabled: false })
    restorePrimaryIcon(stub.button, { path: ARROW_PATH, ariaLabel: 'Send message' }, { label: 'Resume task', disabled: false })
    expect(stub.iconPath()).toBe('M8 0.75 0 0 1')
    expect(stub.attributes.get('aria-label')).toBe('Steer the running turn')
    expect(stub.button.disabled).toBe(false)
  })

  it('keeps the button enabled when the draft is no longer empty', () => {
    const stub = stubButton({ ariaLabel: 'Send message', path: ARROW_PATH, disabled: false })
    paintResumeIcon(stub.button, 'Resume task')
    restorePrimaryIcon(stub.button, { path: ARROW_PATH, ariaLabel: 'Send message' }, { label: 'Resume task', disabled: false })
    expect(stub.button.disabled).toBe(false)
  })

  it('drops an aria-label the kernel never set', () => {
    const stub = stubButton({ path: ARROW_PATH })
    paintResumeIcon(stub.button, 'Resume task')
    restorePrimaryIcon(stub.button, { path: ARROW_PATH, ariaLabel: null }, { label: 'Resume task', disabled: false })
    expect(stub.attributes.has('aria-label')).toBe(false)
  })

  it('re-applies the play icon without writing the same value twice', () => {
    const stub = stubButton({ ariaLabel: 'Send message', path: ARROW_PATH, disabled: false })
    paintResumeIcon(stub.button, 'Resume task')
    const firstWrites = stub.pathWrites()
    const firstDisabled = stub.disabledWrites()

    paintResumeIcon(stub.button, 'Resume task')
    paintResumeIcon(stub.button, 'Resume task')

    expect(firstWrites).toBe(1)
    expect(stub.pathWrites()).toBe(firstWrites)
    expect(stub.disabledWrites()).toBe(firstDisabled)
    expect(stub.iconPath()).toBe(PLAY_FILL_PATH)
  })

  it('tolerates a button whose icon node is not mounted yet', () => {
    const stub = stubButton({ ariaLabel: 'Send message', noPath: true, disabled: true })
    paintResumeIcon(stub.button, 'Resume task')
    expect(stub.iconPath()).toBe(null)
    expect(stub.button.disabled).toBe(false)
    expect(stub.attributes.get('aria-label')).toBe('Resume task')
  })

  it('settles the resume offer from the live snapshot, never from a cached flag', () => {
    const entries: ComposerSessionEventEntry[] = [{ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } } }]
    expect(shouldOfferResume({ session: { running: false, removed: false }, entries })).toBe(true)
    expect(shouldOfferResume({ session: { running: true, removed: false }, entries })).toBe(false)
    expect(shouldOfferResume({ session: { running: false, removed: true }, entries })).toBe(false)
    expect(shouldOfferResume({ session: undefined, entries })).toBe(false)
    expect(shouldOfferResume({ session: { running: false }, entries: [] })).toBe(false)
  })

  it('leaves the kernel stop button enabled while the turn runs', () => {
    expect(restoreDisabled(true, false, false)).toBe(true)
    expect(restoreDisabled(true, true, false)).toBe(false)
    expect(restoreDisabled(true, true, true)).toBe(true)
    expect(restoreDisabled(false, false, false)).toBe(false)
  })
})

describe('isContentRiskTurnEnd', () => {
  function entry(reason: { kind?: string, error?: unknown, reason?: unknown }): ComposerSessionEventEntry {
    return { type: 'event', event: { type: 'turn/end', data: { reason } } }
  }

  it('offers recovery only for the content-review refusal', () => {
    expect(isContentRiskTurnEnd([entry({ kind: 'error', error: { message: 'Content Exists Risk', code: 'INVALID_REQUEST', status: 400 } })])).toBe(true)
    expect(isContentRiskTurnEnd([entry({ kind: 'error', error: { message: 'Content Exists Risk', code: 'CONTENT_REJECTED' } })])).toBe(true)
    expect(isContentRiskTurnEnd([entry({ kind: 'error', error: { message: 'Invalid request: prompt too long', code: 'INVALID_REQUEST', status: 400 } })])).toBe(false)
    expect(isContentRiskTurnEnd([entry({ kind: 'aborted', reason: { kind: 'user' } })])).toBe(false)
    expect(isContentRiskTurnEnd([])).toBe(false)
    expect(isContentRiskTurnEnd(undefined)).toBe(false)
  })

  it('offers the plain resume for every other interrupted kind', () => {
    const entries: ComposerSessionEventEntry[] = [{ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } } }]
    expect(shouldOfferResume({ session: { running: false, removed: false }, entries })).toBe(true)
    expect(isContentRiskTurnEnd(entries)).toBe(false)
  })
})
