import type { Binding } from '../types'
import { get, isString } from 'lodash-es'
import { WORKTREE_SECTION_ORDER } from '../../shared/constants'
import { ledger } from '../service/ledger'
import { worktreeSectionText } from '../utils/worktree-facts'

export function promptProvider(name: string, build: (binding: Binding) => string): {
  name: string
  order: number
  text: (context: any) => string
} {
  return {
    name,
    order: WORKTREE_SECTION_ORDER,
    text(context: any): string {
      const sessionId = get(context, 'scope.session.id')
      const binding = isString(sessionId) ? ledger.load(sessionId) : null
      return binding ? build(binding) : ''
    },
  }
}

export const worktreeSectionProvider = promptProvider('plugin:dsh-tauri-worktree', worktreeSectionText)
