import { worktreeContextText } from '../utils/worktree-facts'
import { promptProvider } from './worktree-section'

export const worktreeContextProvider = promptProvider('plugin:dsh-tauri-worktree:worktree', worktreeContextText)
