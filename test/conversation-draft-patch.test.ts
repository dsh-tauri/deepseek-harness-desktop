import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src-tauri/src/service/patch/conversation_draft.rs', import.meta.url), 'utf8')
const body = source.match(/const SET_DRAFT_PATCHED: &str = r#"([\s\S]*?)"#;/)?.[1]
if (!body)
  throw new Error('Missing production setDraft patch')

function restore(input: unknown) {
  const calls: unknown[][] = []
  const shell = runInNewContext(`({ draftEditor, ${body} })`, {
    draftEditor: {
      setDraft(text: string) {
        calls.push(['text', text.replace(/\uFFFC/g, '')])
      },
      restoreDraft(text: string, references: unknown[]) {
        calls.push(['references', text, references])
      },
    },
  })
  shell.setDraft(input)
  return calls
}

const reference = {
  source: 'file',
  ref: '/workspace/readme.md',
  label: 'readme.md',
  offset: 3,
  length: 10,
  clipboardText: '@readme.md',
}

const draft = { text: '读一下@readme.md\n再解释', references: [reference] }

describe('legacy conversation draft patch', () => {
  it('restores an alpha structured draft through the legacy reference editor', () => {
    expect(restore(draft)).toEqual([['references', draft.text, [reference]]])
  })

  it('preserves legacy string and chip-free structured drafts', () => {
    expect(restore('旧草稿\n第二行')).toEqual([['text', '旧草稿\n第二行']])
    expect(restore({ text: '新版草稿\n第二行', references: [] })).toEqual([['text', '新版草稿\n第二行']])
    expect(restore({ text: '', references: [] })).toEqual([['text', '']])
  })

  it('falls back to the original text for malformed reference spans without mutating storage', () => {
    const malformed = { ...draft, references: [{ ...reference, offset: -1 }] }
    const before = structuredClone(malformed)
    expect(restore(malformed)).toEqual([['text', draft.text]])
    expect(malformed).toEqual(before)
  })

  it.each([
    null,
    undefined,
    1,
    [],
    { text: 1, references: [] },
  ].map(input => ({ input })))('does not pass invalid persisted data $input to the string editor', ({ input }) => {
    expect(restore(input)).toEqual([['text', '']])
  })

  it.each([
    null,
    [null],
    [{ ...reference, source: 1 }],
    [{ ...reference, offset: 0.5 }],
    [{ ...reference, length: 1 }],
    [{ ...reference, offset: 100 }],
    [{ ...reference, clipboardText: 'wrong text', length: 10 }],
    [reference, reference],
  ].map(references => ({ references })))('keeps draft text when reference data $references is invalid', ({ references }) => {
    expect(restore({ text: draft.text, references })).toEqual([['text', draft.text]])
  })
})
